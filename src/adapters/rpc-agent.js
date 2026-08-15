import { randomUUID } from 'node:crypto';

import { MeshError } from '../errors.js';
import { LineProcess } from '../line-process.js';
import { event, finalText, textFromContent, withTimeout } from './shared.js';

const DEFAULT_MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_COUNT = 65_536;

function modelArgs(profile, args) {
  if (!profile.model || profile.modelInArgs === false) return args;
  if (profile.modelFlag === false) return args;
  return [...args, profile.modelFlag ?? '--model', profile.model];
}

function modelSelection(profile) {
  const raw = String(profile.model ?? '');
  const configuredProvider = profile.modelProvider ?? profile.provider;
  if (configuredProvider && raw.startsWith(`${configuredProvider}/`)) {
    return { provider: configuredProvider, modelId: raw.slice(configuredProvider.length + 1), model: raw };
  }
  if (!configuredProvider && raw.includes('/')) {
    const separator = raw.indexOf('/');
    return { provider: raw.slice(0, separator), modelId: raw.slice(separator + 1), model: raw };
  }
  return { provider: configuredProvider ?? (raw ? raw.split('/')[0] : undefined), modelId: raw, model: raw };
}

function sessionIdFrom(value) {
  return value?.sessionId ?? value?.session_id ?? value?.session?.id ?? value?.state?.sessionId ?? value?.sessionFile ?? value?.data?.sessionId ?? value?.data?.session_id ?? value?.data?.sessionFile ?? value?.data?.state?.sessionId;
}

function deltaFrom(value) {
  if (!value || typeof value !== 'object') return '';
  const type = String(value.type ?? value.event ?? value.message?.type ?? '');
  if (!/delta|text|assistant_message|agent_message|message_update/i.test(type)) return '';
  const direct = value.delta ?? value.text ?? value.assistantMessageEvent?.delta ?? value.assistantMessageEvent?.content;
  if (typeof direct === 'string') return direct;
  return textFromContent(direct ?? value.content ?? value.message?.content) ?? '';
}

function readyFrom(message) {
  return message?.type === 'ready' || message?.event === 'ready' || message?.type === 'protocol_ready';
}

function unsupported(error) {
  const text = `${error?.code ?? ''} ${error?.message ?? ''}`.toLowerCase();
  return /method not found|not implemented|unsupported|unknown command/.test(text);
}

function sessionParams(sessionId) {
  return { sessionId, session_id: sessionId, sessionPath: sessionId };
}

/** Adapter for Pi/OMP-style `{type:"prompt"}` RPC over JSONL. */
export class RpcAgentAdapter {
  constructor(options = {}) {
    this.logger = options.logger;
  }

  async open(profile, options = {}) {
    let handle;
    let args = [...(profile.args?.length ? profile.args : ['--mode', 'rpc'])];
    if (options.nativeSessionId && profile.resume !== false && profile.rpcSessionControl !== true) {
      args = [...args, profile.sessionFlag ?? '--session', options.nativeSessionId];
    }
    args = modelArgs(profile, args);
    const process = new LineProcess({
      command: profile.command,
      args,
      cwd: options.cwd ?? profile.cwd,
      env: profile.env,
      inheritEnv: profile.inheritEnv,
      maxLineBytes: profile.maxLineBytes,
      onObject: (message) => this.#message(handle, message),
      onStderr: (line) => this.logger?.debug?.({ line }, 'rpc harness stderr'),
      onExit: (exit) => {
        options.onEvent?.(event('process_exit', { exit }));
        handle?.readyReject?.(exit.error ?? new MeshError('RPC_AGENT_EXITED', 'RPC harness exited before it became ready.', exit));
        if (handle?.active) handle.active.reject(exit.error ?? new MeshError('RPC_AGENT_EXITED', 'RPC harness exited during a prompt.', exit));
      },
    });
    handle = {
      process,
      profile,
      nativeSessionId: options.nativeSessionId,
      onEvent: options.onEvent,
      active: undefined,
      text: [],
      chunks: new Map(),
      readyResolve: undefined,
      readyReject: undefined,
      ready: undefined,
      promptCompletesOnResponse: profile.promptCompletesOnResponse !== false,
      maxReassembledFrameBytes: Math.min(
        Number.isFinite(Number(profile.maxReassembledFrameBytes)) ? Number(profile.maxReassembledFrameBytes) : DEFAULT_MAX_REASSEMBLED_FRAME_BYTES,
        DEFAULT_MAX_REASSEMBLED_FRAME_BYTES,
      ),
    };
    handle.ready = new Promise((resolve, reject) => {
      handle.readyResolve = resolve;
      handle.readyReject = reject;
    });
    try {
      await process.start();
      if (profile.readyRequired) {
        await Promise.race([
          handle.ready,
          new Promise((_, reject) => setTimeout(() => reject(new MeshError('RPC_READY_TIMEOUT', 'RPC harness did not announce ready state.', { command: profile.command })), profile.readyTimeoutMs ?? 2_000)),
        ]);
      }
      if (profile.negotiateProtocol) {
        await this.#send(handle, { type: 'negotiate_protocol', protocolVersion: profile.protocolVersion ?? 2, protocol_version: profile.protocolVersion ?? 2 });
      }
      let handoffRequired = false;
      if (profile.rpcSessionControl) {
        try {
          const session = options.nativeSessionId
            ? await this.#sendRequest(handle, 'switch_session', sessionParams(options.nativeSessionId))
            : await this.#sendRequest(handle, 'new_session', { cwd: options.cwd ?? profile.cwd });
          handle.nativeSessionId = sessionIdFrom(session) ?? options.nativeSessionId;
        } catch (error) {
          if (options.nativeSessionId && unsupported(error)) {
            const session = await this.#sendRequest(handle, 'new_session', { cwd: options.cwd ?? profile.cwd });
            handle.nativeSessionId = sessionIdFrom(session);
            handoffRequired = true;
          } else if (options.nativeSessionId) throw error;
        }
      }
      if (profile.model && profile.modelMethod) {
        try {
          const selection = modelSelection(profile);
          await this.#sendRequest(handle, profile.modelMethod, { ...selection, ...sessionParams(handle.nativeSessionId) });
        } catch (error) {
          if (profile.strictModel) throw error;
          this.logger?.debug?.({ error: error.message, profile: profile.id }, 'RPC model selection is not supported');
        }
      }
      return {
        nativeSessionId: handle.nativeSessionId,
        handoffRequired,
        capabilities: { persistent: true, resume: profile.rpcSessionControl ? true : profile.resume !== false, streaming: true, protocolReady: Boolean(profile.readyRequired), chunkedFrames: true, modelSwitch: Boolean(profile.modelMethod) },
        prompt: (text, metadata) => this.#prompt(handle, text, metadata),
        close: () => process.close(),
        getNativeSessionId: () => handle.nativeSessionId,
      };
    } catch (error) {
      await process.close().catch(() => undefined);
      throw error;
    }
  }

  async #send(handle, command) {
    await handle.process.writeJson(command);
  }

  async #sendRequest(handle, type, command) {
    const id = `dsh-${randomUUID()}`;
    const result = new Promise((resolve, reject) => {
      handle.control = handle.control ?? new Map();
      handle.control.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        handle.control.delete(id);
        reject(new MeshError('RPC_CONTROL_TIMEOUT', `Timed out waiting for ${type}.`));
        void handle.process.close({ graceMs: 500 }).catch(() => undefined);
      }, handle.profile.timeoutMs ?? 120_000);
      handle.control.get(id).timer = timer;
    });
    try {
      await this.#send(handle, { id, type, ...command });
    } catch (error) {
      const pending = handle.control.get(id);
      clearTimeout(pending?.timer);
      pending?.reject(error);
      handle.control.delete(id);
    }
    return result;
  }

  async #prompt(handle, text, metadata = {}) {
    if (handle.active) throw new MeshError('RPC_AGENT_BUSY', 'RPC harness is already processing a prompt.');
    handle.text = [];
    const id = metadata.messageId ?? `dsh-${randomUUID()}`;
    const result = new Promise((resolve, reject) => {
      handle.active = { id, resolve, reject };
    });
    await this.#send(handle, {
      id,
      type: 'prompt',
      message: text,
      ...(handle.profile.streamingBehavior ? { streamingBehavior: handle.profile.streamingBehavior } : {}),
    });
    let response;
    try {
      response = await withTimeout(result, handle.profile.timeoutMs, {
        code: 'RPC_PROMPT_TIMEOUT',
        message: 'RPC harness did not finish the prompt before the harness timeout.',
        onTimeout: () => process.close({ graceMs: 500 }),
      });
    } finally {
      handle.active = undefined;
    }
    return {
      text: handle.text.join('') || finalText(response?.message ?? response?.result ?? response),
      nativeSessionId: handle.nativeSessionId,
      usage: response?.usage,
      success: response?.success,
    };
  }

  #message(handle, message) {
    if (!handle) return;
    if (readyFrom(message)) {
      handle.protocolVersion = Number(message.protocolVersion ?? message.protocol_version) || undefined;
      handle.supportedProtocolVersions = Array.isArray(message.supportedProtocolVersions)
        ? message.supportedProtocolVersions.map(Number).filter(Number.isInteger)
        : undefined;
      if (Number.isFinite(Number(message.maxReassembledFrameBytes)) && Number(message.maxReassembledFrameBytes) > 0) {
        handle.maxReassembledFrameBytes = Math.min(handle.maxReassembledFrameBytes, Number(message.maxReassembledFrameBytes));
      }
      handle.readyResolve?.(message);
      handle.readyResolve = undefined;
      return;
    }
    if (message.type === 'chunk' || message.type === 'frame_chunk' || message.type === 'rpc_chunk' || message.chunk_id || message.chunkId) {
      this.#chunk(handle, message);
      return;
    }
    const control = message.id && handle.control?.get(message.id);
    if (control && (message.result !== undefined || message.error !== undefined || message.type === 'response')) {
      clearTimeout(control.timer);
      handle.control.delete(message.id);
      if (message.error || message.success === false) control.reject(new MeshError('RPC_REMOTE_ERROR', message.error?.message ?? message.message ?? 'RPC control request failed.', message.error ?? message));
      else control.resolve(message.result ?? message);
      return;
    }
    const discovered = sessionIdFrom(message);
    if (discovered) handle.nativeSessionId = discovered;
    const text = deltaFrom(message);
    if (text) {
      handle.text.push(String(text));
      handle.onEvent?.(event('assistant_delta', { text: String(text) }));
    }
    if (message.type === 'response' && (!handle.active || message.id === handle.active.id)) {
      handle.onEvent?.(event('result', { result: message }));
      const data = message.data ?? message.result;
      if (handle.active && message.success === false) handle.active.reject(new MeshError('RPC_PROMPT_REJECTED', message.message ?? 'RPC prompt was rejected.', message));
      else if (handle.active && (handle.promptCompletesOnResponse || data?.agentInvoked === false)) handle.active.resolve(message);
      return;
    }
    if (message.type === 'prompt_result') {
      if (handle.active && (message.agentInvoked ?? message.data?.agentInvoked) === false) handle.active.resolve(message);
      return;
    }
    if (message.type === 'agent_end' || message.type === 'agent_settled' || message.type === 'turn_end') {
      if (handle.active && message.isTerminal !== false) handle.active.resolve(message);
      handle.onEvent?.(event('turn_completed', { result: message }));
      return;
    }
    if (message.type === 'tool_execution_start' || message.type === 'tool_execution_end') {
      handle.onEvent?.(event('tool', { result: message }));
      return;
    }
    handle.onEvent?.(event('notification', { message }));
  }

  #protocolError(handle, code, message, details) {
    const error = new MeshError(code, message, details);
    handle.onEvent?.(event('protocol_error', { error: error.toJSON() }));
    handle.active?.reject(error);
  }

  #chunk(handle, message) {
    const key = String(message.chunk_id ?? message.chunkId ?? message.stream_id ?? message.id ?? 'default');
    const total = Number(message.count ?? message.total ?? message.total_chunks);
    const index = Number(message.index ?? message.chunk_index);
    if (!Number.isInteger(total) || total < 1 || total > MAX_CHUNK_COUNT) {
      this.#protocolError(handle, 'RPC_CHUNK_INVALID', 'RPC chunk count is invalid.', { key, total });
      handle.chunks.delete(key);
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index >= total) {
      this.#protocolError(handle, 'RPC_CHUNK_INVALID', 'RPC chunk index is invalid.', { key, index, total });
      handle.chunks.delete(key);
      return;
    }
    const isRpcChunk = message.type === 'rpc_chunk';
    let bytes;
    try {
      if (isRpcChunk) {
        if (typeof message.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data) || message.data.length % 4 === 1) throw new Error('invalid base64 data');
        bytes = Buffer.from(message.data, 'base64');
      } else {
        const value = typeof message.data === 'string' ? message.data : JSON.stringify(message.data ?? message.payload ?? '');
        bytes = Buffer.from(value, 'utf8');
      }
    } catch (error) {
      this.#protocolError(handle, 'RPC_CHUNK_INVALID', 'RPC chunk payload is invalid.', { key, cause: error.message });
      handle.chunks.delete(key);
      return;
    }
    const expectedBytes = message.byteLength === undefined ? undefined : Number(message.byteLength);
    if (expectedBytes !== undefined && (!Number.isInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > handle.maxReassembledFrameBytes)) {
      this.#protocolError(handle, 'RPC_CHUNK_TOO_LARGE', 'RPC chunk declares an unsafe reassembled size.', { key, byteLength: message.byteLength });
      handle.chunks.delete(key);
      return;
    }
    const entry = handle.chunks.get(key) ?? { total, expectedBytes, parts: new Array(total), bytes: 0, received: 0 };
    if (entry.total !== total || (expectedBytes !== undefined && entry.expectedBytes !== undefined && entry.expectedBytes !== expectedBytes)) {
      this.#protocolError(handle, 'RPC_CHUNK_INVALID', 'RPC chunk metadata changed during reassembly.', { key });
      handle.chunks.delete(key);
      return;
    }
    if (entry.parts[index] !== undefined) {
      if (!entry.parts[index].equals(bytes)) this.#protocolError(handle, 'RPC_CHUNK_INVALID', 'RPC chunk index was sent with conflicting data.', { key, index });
      return;
    }
    if (bytes.length > handle.maxReassembledFrameBytes || entry.bytes + bytes.length > handle.maxReassembledFrameBytes) {
      this.#protocolError(handle, 'RPC_CHUNK_TOO_LARGE', 'RPC chunk reassembly exceeds the configured limit.', { key, maxBytes: handle.maxReassembledFrameBytes });
      handle.chunks.delete(key);
      return;
    }
    entry.parts[index] = bytes;
    entry.bytes += bytes.length;
    entry.received += 1;
    handle.chunks.set(key, entry);
    if (entry.received !== entry.total) return;
    handle.chunks.delete(key);
    if (entry.expectedBytes !== undefined && entry.bytes !== entry.expectedBytes) {
      this.#protocolError(handle, 'RPC_CHUNK_INVALID', 'RPC chunk reassembly length does not match byteLength.', { key, expected: entry.expectedBytes, actual: entry.bytes });
      return;
    }
    try { this.#message(handle, JSON.parse(Buffer.concat(entry.parts).toString('utf8'))); } catch (error) {
      this.#protocolError(handle, 'RPC_CHUNK_INVALID', 'RPC chunk reassembled payload is not valid JSON.', { key, cause: error.message });
    }
  }
}
