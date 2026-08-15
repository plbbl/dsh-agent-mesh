import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { MeshError, asMeshError } from './errors.js';
import { truncateText } from './redact.js';

function withTimeout(promise, timeoutMs, onTimeout) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* best effort */ }
      reject(new MeshError('PROCESS_TIMEOUT', `Process did not exit within ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class LineProcess {
  constructor(options) {
    this.command = options.command;
    this.args = [...(options.args ?? [])];
    this.cwd = options.cwd;
    this.env = options.env;
    this.inheritEnv = options.inheritEnv ?? true;
    this.maxLineBytes = options.maxLineBytes ?? 8 * 1024 * 1024;
    this.onObject = options.onObject;
    this.onLine = options.onLine;
    this.onStderr = options.onStderr;
    this.onExit = options.onExit;
    this.child = undefined;
    this.readline = undefined;
    this.closed = false;
    this.exitPromise = undefined;
    this.closePromise = undefined;
  }

  get pid() {
    return this.child?.pid;
  }

  get alive() {
    return Boolean(this.child && !this.child.killed && !this.closed);
  }

  async start() {
    if (this.child) return this;
    const environment = this.inheritEnv
      ? { ...process.env, ...(this.env ?? {}) }
      : { ...(this.env ?? {}) };
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exitPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        this.closed = true;
        this.onExit?.(value);
        resolve(value);
      };
      this.child.once('exit', (code, signal) => {
        finish({ code, signal });
      });
      this.child.once('error', (error) => finish({ error: asMeshError(error, 'PROCESS_SPAWN_ERROR') }));
    });
    this.readline = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.readline.on('line', (line) => {
      if (!line.trim()) return;
      if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
        this.onExit?.({ error: new MeshError('PROTOCOL_LINE_TOO_LARGE', `Protocol line exceeded ${this.maxLineBytes} bytes.`) });
        void this.close();
        return;
      }
      this.onLine?.(line);
      try {
        this.onObject?.(JSON.parse(line));
      } catch (error) {
        this.onExit?.({
          error: new MeshError('PROTOCOL_INVALID_JSON', 'The harness emitted a non-JSON line.', {
            line: truncateText(line, 512),
            cause: error?.message,
          }),
        });
      }
    });
    this.child.stderr.on('data', (chunk) => {
      this.onStderr?.(truncateText(chunk.toString('utf8'), 16 * 1024));
    });
    return this;
  }

  writeRaw(value) {
    if (!this.child?.stdin?.writable || this.closed) {
      throw new MeshError('PROCESS_NOT_WRITABLE', 'The harness process is not writable.');
    }
    return new Promise((resolve, reject) => {
      this.child.stdin.write(value, 'utf8', (error) => (error ? reject(asMeshError(error, 'PROCESS_WRITE_ERROR')) : resolve()));
    });
  }

  writeJson(value) {
    return this.writeRaw(`${JSON.stringify(value)}\n`);
  }

  async close(options = {}) {
    if (!this.child) return;
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.#close(options);
    return this.closePromise;
  }

  async #close(options = {}) {
    const graceMs = options.graceMs ?? 1500;
    const child = this.child;
    if (!this.closed) {
      try { this.child.stdin.end(); } catch { /* already closed */ }
      try { this.readline?.close(); } catch { /* already closed */ }
    }
    if (!this.closed) {
      try {
        await withTimeout(this.exitPromise, graceMs, () => child.kill('SIGTERM'));
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
        await this.exitPromise.catch(() => undefined);
      }
    }
    this.closed = true;
  }
}
