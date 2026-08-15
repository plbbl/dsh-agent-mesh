import { JsonRpcProcess } from '../json-rpc.js';
import { MeshError } from '../errors.js';
import { defaultApprovalReply, event, finalText, textFromContent } from './shared.js';

function sessionUpdateFrom(message) {
  const update = message?.params?.update ?? message?.params;
  return update && typeof update === 'object' ? update : {};
}

function acpText(update) {
  const content = update.content ?? update.message?.content ?? update.delta;
  return textFromContent(content) || (typeof update.text === 'string' ? update.text : '');
}

function methodUnavailable(error) {
  const text = String(error?.message ?? '').toLowerCase();
  return /method not found|not implemented|unsupported|unknown method/.test(text) || Number(error?.details?.code) === -32601;
}

function sessionMissing(error) {
  return /resource_not_found|session.*not found|unknown session/i.test(String(error?.message ?? ''));
}

function ompResumeBroken(error, profile) {
  return profile.harness === 'omp'
    && error?.code === 'RPC_REMOTE_ERROR'
    && Number(error?.details?.code) === -32603;
}

export class AcpAdapter {
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
      protocol: 'jsonrpc',
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
    const initialize = await rpc.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'dsh-agent-mesh', version: '0.1.0' },
      clientCapabilities: {},
    });
    await rpc.notify('initialized', {});

    const agentCapabilities = initialize?.agentCapabilities ?? initialize?.capabilities ?? {};
    let result;
    let handoffRequired = false;
    if (options.nativeSessionId) {
      const resumeMethod = profile.resumeMethod ?? 'session/load';
      try {
        result = await rpc.request(resumeMethod, {
          sessionId: options.nativeSessionId,
          cwd: options.cwd ?? profile.cwd,
        });
      } catch (error) {
        if (methodUnavailable(error)) {
          result = await rpc.request('session/new', {
            cwd: options.cwd ?? profile.cwd,
            mcpServers: profile.mcpServers ?? [],
          });
          handoffRequired = true;
        } else if (sessionMissing(error)) {
          throw new MeshError('NATIVE_SESSION_NOT_FOUND', 'ACP native session is no longer available.', { cause: error.message });
        } else if (ompResumeBroken(error, profile)) {
          // OMP can leave a persisted session unloadable after an interrupted turn.
          // Start a fresh native session and let DSH reseed it with bounded context.
          result = await rpc.request('session/new', {
            cwd: options.cwd ?? profile.cwd,
            mcpServers: profile.mcpServers ?? [],
          });
          handoffRequired = true;
        } else throw error;
      }
    } else {
      result = await rpc.request('session/new', {
        cwd: options.cwd ?? profile.cwd,
        mcpServers: profile.mcpServers ?? [],
      });
    }
    const nativeSessionId = result?.sessionId ?? result?.session_id ?? options.nativeSessionId;
    if (!nativeSessionId) {
      await rpc.close();
      throw new MeshError('ACP_SESSION_ID_MISSING', 'ACP server did not return a session id.');
    }
    handle = {
      rpc,
      profile,
      nativeSessionId,
      onEvent: options.onEvent,
      currentText: [],
      completed: new Map(),
    };
    let modelSwitch = false;
    if (profile.model && profile.setModel !== false) {
      let modelError;
      try {
        await rpc.request(profile.modelMethod ?? 'session/set_model', {
          sessionId: nativeSessionId,
          modelId: profile.model,
          model: profile.model,
        });
      } catch (error) {
        modelError = error;
        if (profile.modelConfigMethod !== false) {
          try {
            await rpc.request(profile.modelConfigMethod ?? 'session/set_config_option', {
              sessionId: nativeSessionId,
              configId: profile.modelConfigId ?? 'model',
              value: profile.model,
            });
            modelError = undefined;
            modelSwitch = true;
          } catch (configError) {
            modelError = configError;
            this.logger?.debug?.({ error: configError.message, profile: profile.id }, 'ACP model config option not supported');
          }
        }
        if (modelError && profile.strictModel) throw modelError;
        if (modelError) this.logger?.debug?.({ error: modelError.message, profile: profile.id }, 'ACP model switch not supported');
      }
      if (!modelError) modelSwitch = true;
    }
    return {
      nativeSessionId,
      handoffRequired,
      capabilities: {
        persistent: true,
        resume: Boolean(agentCapabilities.sessionLoad ?? agentCapabilities.loadSession ?? true),
        streaming: true,
        modelSwitch,
        toolEvents: true,
        negotiated: true,
      },
      prompt: (text, metadata) => this.#prompt(handle, text, metadata),
      close: () => rpc.close(),
      getNativeSessionId: () => handle.nativeSessionId,
    };
  }

  async #prompt(handle, text, metadata = {}) {
    handle.currentText = [];
    const promptKey = metadata.messageId ?? `${Date.now()}`;
    const prompt = [{ type: 'text', text }];
    const params = {
      sessionId: handle.nativeSessionId,
      [handle.profile.promptParam ?? 'prompt']: prompt,
    };
    const result = await handle.rpc.request(
      'session/prompt',
      params,
      handle.profile.promptTimeoutMs ?? handle.profile.timeoutMs,
    );
    const output = handle.currentText.join('') || finalText(result);
    return {
      text: output,
      nativeSessionId: handle.nativeSessionId,
      promptKey,
      stopReason: result?.stopReason,
    };
  }

  #notification(handle, message) {
    if (!handle) return;
    const update = sessionUpdateFrom(message);
    const updateType = update.sessionUpdate ?? update.type ?? message.method;
    const text = acpText(update);
    if (text && /agent_message|message_chunk|assistant|text_delta/i.test(String(updateType))) {
      handle.currentText.push(text);
      handle.onEvent?.(event('assistant_delta', { text }));
      return;
    }
    if (/tool_call|tool_call_update|command/i.test(String(updateType))) {
      handle.onEvent?.(event('tool', { update }));
      return;
    }
    if (/plan/i.test(String(updateType))) {
      handle.onEvent?.(event('plan', { update }));
      return;
    }
    handle.onEvent?.(event('notification', { method: message.method, update }));
  }
}
