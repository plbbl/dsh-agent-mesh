import { JsonRpcProcess } from '../json-rpc.js';
import { MeshError } from '../errors.js';
import { defaultApprovalReply, event, finalText, withTimeout } from './shared.js';

function threadIdFrom(value) {
  return value?.thread?.id ?? value?.threadId ?? value?.thread_id ?? value?.id;
}

function turnIdFrom(value) {
  return value?.turn?.id ?? value?.turnId ?? value?.turn_id ?? value?.id;
}

export class CodexAdapter {
  constructor(options = {}) {
    this.logger = options.logger;
  }

  async open(profile, options = {}) {
    let handle;
    const rpc = new JsonRpcProcess({
      command: profile.command,
      args: profile.args,
      cwd: options.cwd ?? profile.cwd,
      env: profile.env,
      inheritEnv: profile.inheritEnv,
      maxLineBytes: profile.maxLineBytes,
      timeoutMs: profile.timeoutMs,
      protocol: 'codex',
      logger: this.logger,
      onRequest: async (method, params, request) => {
        const custom = await options.onRequest?.(method, params, request);
        return custom ?? defaultApprovalReply(method, profile.permissionPolicy);
      },
      onNotification: (message) => this.#notification(handle, message),
      onExit: (exit) => options.onEvent?.(event('process_exit', { exit })),
      onProtocolError: (error) => options.onEvent?.(event('protocol_error', { error: error.toJSON?.() ?? { message: error.message } })),
    });
    await rpc.start();
    await rpc.request('initialize', {
      clientInfo: { name: 'dsh-agent-mesh', title: 'DSH Agent Mesh', version: '0.1.0' },
      capabilities: {},
    });
    await rpc.notify('initialized', {});

    if (profile.preflight) {
      const timeout = Math.min(profile.preflightTimeoutMs ?? 5_000, profile.timeoutMs ?? 120_000);
      const [account, catalog] = await Promise.all([
        rpc.request('account/read', { refreshToken: false }, timeout).catch((error) => ({ __error: error })),
        rpc.request('model/list', { includeHidden: false }, timeout).catch((error) => ({ __error: error })),
      ]);
      if (!account.__error) {
        const accountValue = account?.account ?? account?.value ?? account;
        if (accountValue === null) {
          await rpc.close();
          throw new MeshError('CODEX_AUTH_MISSING', 'Codex app-server has no authenticated account.');
        }
      }
      if (profile.model && !catalog.__error) {
        const models = catalog?.data?.items ?? catalog?.data ?? catalog?.models ?? catalog?.items ?? [];
        if (Array.isArray(models) && models.length && !models.some((item) => (item?.id ?? item?.slug ?? item?.model) === profile.model)) {
          await rpc.close();
          throw new MeshError('CODEX_MODEL_NOT_FOUND', `Codex model is not available: ${profile.model}.`, { model: profile.model });
        }
      }
    }

    const startParams = {
      cwd: options.cwd ?? profile.cwd,
      model: profile.model,
      reasoningEffort: options.reasoningEffort ?? profile.reasoningEffort,
      approvalPolicy: profile.approvalPolicy,
      sandbox: profile.sandbox,
      ephemeral: false,
    };
    const response = options.nativeSessionId
      ? await rpc.request('thread/resume', { threadId: options.nativeSessionId, ...startParams })
      : await rpc.request('thread/start', startParams);
    const nativeSessionId = threadIdFrom(response) ?? options.nativeSessionId;
    if (!nativeSessionId) {
      await rpc.close();
      throw new MeshError('CODEX_THREAD_ID_MISSING', 'Codex app-server did not return a thread id.');
    }
    handle = {
      rpc,
      profile,
      nativeSessionId,
      onEvent: options.onEvent,
      turns: new Map(),
      buffered: new Map(),
      activeText: new Map(),
    };
    return {
      nativeSessionId,
      capabilities: { persistent: true, resume: true, streaming: true, modelSwitch: Boolean(profile.allowModelSwitch) },
      prompt: (text, metadata) => this.#prompt(handle, text, metadata),
      close: () => rpc.close(),
    };
  }

  async #prompt(handle, text, metadata = {}) {
    const params = {
      threadId: handle.nativeSessionId,
      input: [{ type: 'text', text }],
      ...(metadata.reasoningEffort ? { effort: metadata.reasoningEffort } : {}),
      ...(handle.profile.allowModelSwitch && metadata.model ? { model: metadata.model } : {}),
    };
    const started = await handle.rpc.request('turn/start', params, handle.profile.timeoutMs);
    const turnId = turnIdFrom(started);
    if (!turnId) return { text: finalText(started), nativeSessionId: handle.nativeSessionId };
    const alreadyCompleted = handle.buffered.get(turnId);
    if (alreadyCompleted) {
      handle.buffered.delete(turnId);
      return this.#turnResult(handle, turnId, alreadyCompleted);
    }
    let result;
    try {
      result = await withTimeout(new Promise((resolve, reject) => {
        handle.turns.set(turnId, { resolve, reject });
      }), handle.profile.timeoutMs, {
        code: 'CODEX_TURN_TIMEOUT',
        message: 'Codex did not finish the turn before the harness timeout.',
        onTimeout: () => handle.rpc.close(),
      });
    } finally {
      handle.turns.delete(turnId);
    }
    return this.#turnResult(handle, turnId, result);
  }

  #turnResult(handle, turnId, result) {
    const text = handle.activeText.get(turnId) || finalText(result);
    handle.activeText.delete(turnId);
    return { text, nativeSessionId: handle.nativeSessionId, turnId, status: result?.status, usage: result?.usage };
  }

  #notification(handle, message) {
    if (!handle) return;
    const params = message.params ?? {};
    const turnId = turnIdFrom(params) ?? params.turn?.id;
    if (message.method === 'item/agentMessage/delta' || message.method === 'item/agent_message/delta') {
      const text = params.delta ?? params.text ?? params.content ?? '';
      if (text) {
        const key = turnId ?? 'current';
        handle.activeText.set(key, `${handle.activeText.get(key) ?? ''}${text}`);
        handle.onEvent?.(event('assistant_delta', { text }));
      }
      return;
    }
    if (message.method === 'item/completed' || message.method === 'item/agentMessage/completed') {
      handle.onEvent?.(event('item_completed', { item: params.item ?? params }));
      return;
    }
    if (message.method === 'turn/completed' || message.method === 'turn/completion') {
      const key = turnId ?? params.turn?.id;
      const waiter = key ? handle.turns.get(key) : undefined;
      if (waiter) {
        handle.turns.delete(key);
        waiter.resolve(params.turn ?? params);
      } else if (key) {
        handle.buffered.set(key, params.turn ?? params);
      }
      handle.onEvent?.(event('turn_completed', { turn: params.turn ?? params }));
      return;
    }
    if (/approval|permission/i.test(message.method)) {
      handle.onEvent?.(event('permission_request', { method: message.method, params }));
      return;
    }
    handle.onEvent?.(event('notification', { method: message.method, params }));
  }
}
