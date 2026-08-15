import { randomUUID } from 'node:crypto';

import { MeshError, asMeshError } from './errors.js';
import { LineProcess } from './line-process.js';

function jsonRpcError(error) {
  return {
    code: error?.code ?? -32000,
    message: error?.message ?? String(error),
    ...(error?.data === undefined ? {} : { data: error.data }),
  };
}

export class JsonRpcProcess {
  constructor(options) {
    this.protocol = options.protocol ?? 'jsonrpc';
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.logger = options.logger;
    this.pending = new Map();
    this.nextId = 1;
    this.onNotification = options.onNotification;
    this.onRequest = options.onRequest;
    this.onProtocolError = options.onProtocolError;
    this.onExit = options.onExit;
    this.process = new LineProcess({
      ...options,
      onObject: (message) => this.#receive(message),
      onStderr: (line) => this.logger?.debug?.({ line }, 'harness stderr'),
      onExit: (event) => this.#exit(event),
    });
  }

  get pid() {
    return this.process.pid;
  }

  get alive() {
    return this.process.alive;
  }

  async start() {
    await this.process.start();
    return this;
  }

  async request(method, params = {}, timeoutMs = this.timeoutMs) {
    const id = this.nextId++;
    const payload = {
      ...(this.protocol === 'jsonrpc' ? { jsonrpc: '2.0' } : {}),
      id,
      method,
      params,
    };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new MeshError('RPC_TIMEOUT', `Timed out waiting for ${method}.`, { method, id });
        reject(error);
        // A timed-out request may leave a native turn in an unknown state.
        // Tear down the process asynchronously so the next Agent Mesh call
        // cannot reuse a poisoned stream or leave a child behind.
        void this.close({ graceMs: 500 }).catch(() => undefined);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
    try {
      await this.process.writeJson(payload);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      }
    }
    return promise;
  }

  notify(method, params = {}) {
    return this.process.writeJson({
      ...(this.protocol === 'jsonrpc' ? { jsonrpc: '2.0' } : {}),
      method,
      params,
    });
  }

  async close(options) {
    await this.process.close(options);
    this.#rejectPending(new MeshError('PROCESS_CLOSED', 'The harness process closed.'));
  }

  #receive(message) {
    if (!message || typeof message !== 'object') return;
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    if (hasId && (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new MeshError('RPC_REMOTE_ERROR', message.error.message || 'Remote RPC error.', message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && hasId) {
      void this.#handleRequest(message);
      return;
    }
    if (message.method) {
      try { this.onNotification?.(message); } catch (error) { this.onProtocolError?.(asMeshError(error)); }
    }
  }

  async #handleRequest(message) {
    let result;
    try {
      result = await this.onRequest?.(message.method, message.params, message);
      await this.process.writeJson({
        ...(this.protocol === 'jsonrpc' ? { jsonrpc: '2.0' } : {}),
        id: message.id,
        result: result ?? {},
      });
    } catch (error) {
      await this.process.writeJson({
        ...(this.protocol === 'jsonrpc' ? { jsonrpc: '2.0' } : {}),
        id: message.id,
        error: jsonRpcError(error),
      }).catch(() => undefined);
    }
  }

  #exit(event) {
    this.onExit?.(event);
    if (event?.error) this.onProtocolError?.(event.error);
    const error = event?.error ?? new MeshError('PROCESS_EXITED', 'The harness process exited.', event);
    this.#rejectPending(error);
  }

  #rejectPending(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export function rpcRequestId() {
  return randomUUID();
}
