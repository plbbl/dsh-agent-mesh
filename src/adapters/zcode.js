import { JsonRpcProcess } from '../json-rpc.js';
import { MeshError } from '../errors.js';
import { event, finalText, textFromContent } from './shared.js';

function sessionIdFrom(value) {
  return value?.sessionId ?? value?.session_id ?? value?.session?.id ?? value?.data?.sessionId;
}

function eventText(value) {
  if (!value || typeof value !== 'object') return '';
  return value.delta ?? value.text ?? textFromContent(value.content ?? value.message?.content ?? value.data?.content) ?? '';
}

/**
 * ZCode is JSONL and JSON-RPC-shaped, but deliberately rejects the jsonrpc
 * envelope and uses different method names from ACP/Codex. Keep it isolated
 * instead of pretending it is ACP; this makes protocol drift visible.
 */
export class ZcodeAdapter {
  constructor(options = {}) {
    this.logger = options.logger;
  }

  async open(profile, options = {}) {
    let handle;
    const rpc = new JsonRpcProcess({
      command: profile.command,
      args: profile.args?.length ? profile.args : ['app-server', '--stdio'],
      cwd: options.cwd ?? profile.cwd,
      env: profile.env,
      inheritEnv: profile.inheritEnv,
      maxLineBytes: profile.maxLineBytes,
      timeoutMs: profile.timeoutMs,
      protocol: 'codex',
      logger: this.logger,
      onNotification: (message) => this.#notification(handle, message),
      onProtocolError: (error) => options.onEvent?.(event('protocol_error', { error: error.toJSON?.() ?? { message: error.message } })),
    });
    await rpc.start();
    const response = options.nativeSessionId
      ? await rpc.request(profile.resumeMethod ?? 'session/resume', { sessionId: options.nativeSessionId })
      : await rpc.request(profile.createMethod ?? 'session/create', {
        workspace: profile.workspace ?? { path: options.cwd ?? profile.cwd },
      });
    const nativeSessionId = sessionIdFrom(response) ?? options.nativeSessionId;
    if (!nativeSessionId) {
      await rpc.close();
      throw new MeshError('ZCODE_SESSION_ID_MISSING', 'ZCode app-server did not return a session id.');
    }
    handle = {
      rpc,
      profile,
      nativeSessionId,
      onEvent: options.onEvent,
      text: [],
      active: undefined,
    };
    return {
      nativeSessionId,
      capabilities: { persistent: true, resume: true, streaming: true, modelSwitch: false, experimental: true },
      prompt: (text, metadata) => this.#prompt(handle, text, metadata),
      close: () => rpc.close(),
    };
  }

  async #prompt(handle, text, metadata = {}) {
    handle.text = [];
    const response = await handle.rpc.request(handle.profile.promptMethod ?? 'session/messages', {
      sessionId: handle.nativeSessionId,
      messages: [{ role: 'user', content: text }],
      ...(metadata.model ? { model: metadata.model } : {}),
    }, handle.profile.timeoutMs);
    return {
      text: handle.text.join('') || finalText(response),
      nativeSessionId: handle.nativeSessionId,
      result: response,
    };
  }

  #notification(handle, message) {
    if (!handle) return;
    const payload = message.params ?? message;
    const discovered = sessionIdFrom(payload);
    if (discovered) handle.nativeSessionId = discovered;
    const text = eventText(payload);
    if (text) {
      handle.text.push(String(text));
      handle.onEvent?.(event('assistant_delta', { text: String(text) }));
      return;
    }
    handle.onEvent?.(event('notification', { method: message.method, payload }));
  }
}
