// src/runtime.js
import { EventEmitter as EventEmitter2 } from "node:events";
import { randomUUID as randomUUID7 } from "node:crypto";
import { resolve as resolvePath } from "node:path";

// src/event-store.js
import { chmod, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// src/errors.js
var MeshError = class extends Error {
  constructor(code, message, details = void 0) {
    super(message);
    this.name = "MeshError";
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...this.details === void 0 ? {} : { details: this.details }
    };
  }
};
function assertMesh(condition, code, message, details = void 0) {
  if (!condition) throw new MeshError(code, message, details);
}
function asMeshError(error, fallbackCode = "INTERNAL_ERROR") {
  if (error instanceof MeshError) return error;
  return new MeshError(fallbackCode, error?.message || String(error), {
    cause: error?.code || error?.name
  });
}
var CREDENTIAL_FAILURE = /no credential|missing credential|credential.*(?:not|isn't|is not)\s*(?:set|configured|available|found)|(?:api[_ -]?key|token).*(?:not|isn't|is not)\s*(?:set|configured|available|found)|authentication required|not logged in|unauthorized|401/i;
function asHarnessError(error, fallbackCode = "PROMPT_ERROR") {
  const normalized = asMeshError(error, fallbackCode);
  if (normalized.code === "MISSING_CREDENTIAL") return normalized;
  if (!CREDENTIAL_FAILURE.test(String(normalized.message ?? ""))) return normalized;
  return new MeshError(
    "MISSING_CREDENTIAL",
    "\u672C\u673A harness \u6CA1\u6709\u53EF\u7528\u51ED\u636E\uFF1B\u8BF7\u5728\u8BE5 harness \u7684\u539F\u751F\u767B\u5F55\u6216\u51ED\u636E\u8BBE\u7F6E\u4E2D\u5B8C\u6210\u914D\u7F6E\u3002Agent Mesh \u4E0D\u4F1A\u590D\u5236\u6216\u7D22\u8981\u51ED\u636E\u3002",
    { causeCode: normalized.code }
  );
}

// src/serial-queue.js
var SerialQueue = class {
  #tail = Promise.resolve();
  #pending = 0;
  get pending() {
    return this.#pending;
  }
  run(task) {
    this.#pending += 1;
    const result = this.#tail.then(task, task);
    this.#tail = result.catch(() => void 0).finally(() => {
      this.#pending -= 1;
    });
    return result;
  }
  idle() {
    return this.#tail;
  }
};

// src/event-store.js
var STORE_VERSION = 1;
function defaultRoot() {
  return join(homedir(), ".dsh", "agent-mesh");
}
async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return void 0;
    throw error;
  }
}
var EventStore = class {
  constructor(root = defaultRoot(), options = {}) {
    this.root = root;
    this.logPath = join(root, "events.jsonl");
    this.snapshotPath = join(root, "snapshot.json");
    this.snapshotEvery = Math.max(1, options.snapshotEvery ?? 128);
    this.durability = options.durability ?? "batch";
    this.queue = new SerialQueue();
    this.handle = void 0;
    this.state = void 0;
    this.seq = 0;
    this.sinceSnapshot = 0;
    this.opened = false;
  }
  async open(initialState, applyEvent) {
    if (this.opened) return this.state;
    await mkdir(this.root, { recursive: true, mode: 448 });
    await chmod(this.root, 448);
    const snapshot = await readJsonIfPresent(this.snapshotPath);
    this.state = snapshot?.state ?? structuredClone(initialState);
    this.seq = Number(snapshot?.seq ?? 0);
    let log = "";
    try {
      log = await readFile(this.logPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const line of log.split("\n")) {
      if (!line.trim()) continue;
      let event2;
      try {
        event2 = JSON.parse(line);
      } catch {
        continue;
      }
      if (!Number.isSafeInteger(event2?.seq) || event2.seq <= this.seq) continue;
      applyEvent(this.state, event2);
      this.seq = event2.seq;
    }
    this.handle = await open(this.logPath, "a+");
    await chmod(this.logPath, 384);
    this.opened = true;
    return this.state;
  }
  async append(type, data, applyEvent) {
    if (!this.opened) throw new MeshError("STORE_NOT_OPEN", "The event store is not open.");
    return this.queue.run(async () => {
      const event2 = {
        v: STORE_VERSION,
        seq: this.seq + 1,
        ts: Date.now(),
        type,
        data
      };
      const line = `${JSON.stringify(event2)}
`;
      await this.handle.write(line, void 0, "utf8");
      if (this.durability === "sync") await this.handle.sync();
      this.seq = event2.seq;
      applyEvent(this.state, event2);
      this.sinceSnapshot += 1;
      if (this.sinceSnapshot >= this.snapshotEvery) await this.#snapshotLocked();
      return event2;
    });
  }
  async snapshot() {
    if (!this.opened) return;
    return this.queue.run(() => this.#snapshotLocked());
  }
  async #snapshotLocked() {
    const payload = JSON.stringify({
      version: STORE_VERSION,
      seq: this.seq,
      state: this.state
    });
    const temporary = `${this.snapshotPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, payload, { encoding: "utf8", mode: 384 });
    await rename(temporary, this.snapshotPath);
    await this.handle.truncate(0);
    if (this.durability === "sync") await this.handle.sync();
    this.sinceSnapshot = 0;
  }
  async close() {
    if (!this.opened) return;
    await this.queue.idle();
    await this.snapshot();
    await this.queue.idle();
    await this.handle.close();
    this.opened = false;
  }
};

// src/message-bus.js
import { EventEmitter } from "node:events";
import { randomUUID as randomUUID2 } from "node:crypto";

// src/redact.js
var SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|private[-_]?key)/i;
function truncateText(value, maxBytes = 64 * 1024) {
  const text = String(value ?? "");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  let end = Math.max(0, Math.floor(text.length * (maxBytes / bytes)) - 1);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes - 32) end -= 1;
  return `${text.slice(0, end)}\u2026 [truncated ${bytes - Buffer.byteLength(text.slice(0, end), "utf8")} bytes]`;
}
function redact(value, options = {}) {
  const maxDepth = options.maxDepth ?? 6;
  const maxBytes = options.maxBytes ?? 64 * 1024;
  function visit(input, depth) {
    if (depth > maxDepth) return "[depth-limit]";
    if (typeof input === "string") return truncateText(input, maxBytes);
    if (input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1));
    const output = {};
    for (const [key, item] of Object.entries(input)) {
      output[key] = SECRET_KEY.test(key) ? "[redacted]" : visit(item, depth + 1);
    }
    return output;
  }
  return visit(value, 0);
}

// src/message-bus.js
var TERMINAL = /* @__PURE__ */ new Set(["delivered", "completed", "failed", "cancelled"]);
function messagePreview(message) {
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    kind: message.kind,
    status: message.status,
    text: truncateText(message.text, 280),
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    replyTo: message.replyTo,
    parentId: message.parentId,
    traceId: message.traceId,
    expectsReply: message.expectsReply,
    idempotencyKey: message.idempotencyKey,
    artifacts: message.artifacts,
    completion: message.completion,
    error: message.error
  };
}
var MESSAGE_KINDS = /* @__PURE__ */ new Set(["message", "task", "question", "review", "result", "handoff", "status", "error", "cancel", "reply"]);
function boundedString(value, max = 256) {
  if (value === void 0 || value === null) return void 0;
  const text = String(value).trim();
  return text ? truncateText(text, max) : void 0;
}
function boundedArtifacts(value) {
  if (!Array.isArray(value)) return void 0;
  const output = value.slice(0, 32).map((item) => {
    if (typeof item === "string") return { type: "text", value: truncateText(item, 4 * 1024) };
    if (!item || typeof item !== "object") return void 0;
    return redact({
      type: boundedString(item.type, 64) ?? "artifact",
      name: boundedString(item.name, 256),
      path: boundedString(item.path, 1024),
      uri: boundedString(item.uri, 2048),
      value: typeof item.value === "string" ? truncateText(item.value, 4 * 1024) : void 0,
      status: boundedString(item.status, 64)
    }, { maxBytes: 8 * 1024 });
  }).filter(Boolean);
  return output.length ? output : void 0;
}
var MessageBus = class extends EventEmitter {
  constructor(options) {
    super();
    this.state = options.state;
    this.append = options.append;
    this.deliver = options.deliver;
    this.logger = options.logger;
    this.maxBytes = options.maxBytes ?? 256 * 1024;
    this.inFlight = /* @__PURE__ */ new Set();
  }
  async send(input) {
    const from = String(input?.from ?? "").trim();
    const to = String(input?.to ?? "").trim();
    const text = String(input?.text ?? "");
    assertMesh(from, "MESSAGE_FROM_REQUIRED", "Message sender is required.");
    assertMesh(to, "MESSAGE_TO_REQUIRED", "Message target is required.");
    assertMesh(text.trim(), "MESSAGE_TEXT_REQUIRED", "Message text is required.");
    assertMesh(Buffer.byteLength(text, "utf8") <= this.maxBytes, "MESSAGE_TOO_LARGE", `Message exceeds ${this.maxBytes} bytes.`);
    const kind = String(input.kind ?? "message").trim().toLowerCase();
    assertMesh(kind.length <= 32, "MESSAGE_KIND_TOO_LARGE", "Message kind is too long.");
    const idempotencyKey = boundedString(input.idempotencyKey ?? input.metadata?.idempotencyKey, 256);
    if (idempotencyKey) {
      const existing = Object.values(this.state.messages).find((item) => item.idempotencyKey === idempotencyKey && item.from === from && item.to === to);
      if (existing) return messagePreview(existing);
    }
    const now = Date.now();
    const message = {
      id: input.id ?? randomUUID2(),
      from,
      to,
      text,
      kind: MESSAGE_KINDS.has(kind) ? kind : "message",
      replyTo: input.replyTo ? String(input.replyTo) : void 0,
      parentId: boundedString(input.parentId, 128),
      traceId: boundedString(input.traceId, 128) ?? boundedString(input.parentId, 128) ?? randomUUID2(),
      expectsReply: input.expectsReply !== false,
      idempotencyKey,
      artifacts: boundedArtifacts(input.artifacts),
      metadata: input.metadata && typeof input.metadata === "object" ? redact(input.metadata, { maxBytes: 16 * 1024 }) : void 0,
      deadlineAt: Number.isFinite(Number(input.deadlineAt)) ? Number(input.deadlineAt) : void 0,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      attempts: 0
    };
    assertMesh(!this.state.messages[message.id], "MESSAGE_ID_CONFLICT", `Message already exists: ${message.id}.`);
    await this.append("message/created", message);
    this.emit("created", messagePreview(message));
    void this.#deliver(message);
    return messagePreview(message);
  }
  async #deliver(message) {
    if (this.inFlight.has(message.id)) return;
    this.inFlight.add(message.id);
    try {
      const current = this.state.messages[message.id];
      if (!current || TERMINAL.has(current.status)) return;
      if (current.deadlineAt && current.deadlineAt <= Date.now()) {
        await this.append("message/status", { id: message.id, status: "cancelled", completion: { reason: "deadline-exceeded" }, updatedAt: Date.now() });
        this.emit("delivered", messagePreview(this.state.messages[message.id]));
        return;
      }
      await this.append("message/status", {
        id: message.id,
        status: "processing",
        attempts: (current.attempts ?? 0) + 1,
        updatedAt: Date.now()
      });
      await this.deliver({ ...this.state.messages[message.id] });
      if (!TERMINAL.has(this.state.messages[message.id]?.status)) {
        await this.append("message/status", { id: message.id, status: "delivered", updatedAt: Date.now() });
      }
      this.emit("delivered", messagePreview(this.state.messages[message.id]));
    } catch (error) {
      const normalized = asMeshError(error);
      try {
        await this.append("message/status", {
          id: message.id,
          status: "failed",
          error: normalized.toJSON(),
          updatedAt: Date.now()
        });
      } catch (appendError) {
        this.logger?.error?.({ error: appendError, messageId: message.id }, "failed to persist message failure");
      }
      this.emit("failed", { ...messagePreview(this.state.messages[message.id] ?? message), error: normalized.toJSON() });
    } finally {
      this.inFlight.delete(message.id);
    }
  }
  async retryPending() {
    const pending = Object.values(this.state.messages).filter((message) => message.status === "queued" || message.status === "processing").sort((a, b) => a.createdAt - b.createdAt);
    for (const message of pending) void this.#deliver(message);
    return pending.length;
  }
  async markCompleted(id, metadata = void 0) {
    const message = this.#get(id);
    if (TERMINAL.has(message.status)) return messagePreview(message);
    await this.append("message/status", { id, status: "completed", ...metadata ? { completion: redact(metadata, { maxBytes: 16 * 1024 }) } : {}, updatedAt: Date.now() });
    return messagePreview(this.state.messages[id]);
  }
  async markFailed(id, error) {
    const message = this.#get(id);
    const normalized = asMeshError(error);
    await this.append("message/status", { id, status: "failed", error: normalized.toJSON(), updatedAt: Date.now() });
    return messagePreview(this.state.messages[id]);
  }
  async cancel(id, reason = "cancelled") {
    const message = this.#get(id);
    if (TERMINAL.has(message.status)) return messagePreview(message);
    await this.append("message/status", { id, status: "cancelled", completion: { reason: boundedString(reason, 512) ?? "cancelled" }, updatedAt: Date.now() });
    return messagePreview(this.state.messages[id]);
  }
  list(options = {}) {
    const target = options.to ? String(options.to) : void 0;
    const sender = options.from ? String(options.from) : void 0;
    const after = options.after ? Number(options.after) : 0;
    const limit = Math.min(500, Math.max(1, Number(options.limit ?? 100)));
    return Object.values(this.state.messages).filter((message) => (!target || message.to === target) && (!sender || message.from === sender) && message.createdAt > after).sort((a, b) => a.createdAt - b.createdAt).slice(-limit).map(messagePreview);
  }
  #get(id) {
    const message = this.state.messages[id];
    if (!message) throw new MeshError("MESSAGE_NOT_FOUND", `Message not found: ${id}.`, { id });
    return message;
  }
};

// src/profiles.js
var DEFAULT_PROFILES = [
  {
    id: "dsh-native",
    label: "DSH \xB7 host agent",
    harness: "dsh",
    transport: "dsh",
    command: "dsh:host",
    permissionPolicy: "reject",
    persistent: true,
    routeable: false,
    nativeHost: true
  },
  {
    id: "codex-local",
    label: "Codex \xB7 local app-server",
    harness: "codex",
    transport: "codex",
    command: "codex",
    args: ["app-server", "--stdio"],
    permissionPolicy: "reject",
    persistent: true
  },
  {
    id: "claude-local",
    label: "Claude Code \xB7 local stream",
    harness: "claude-code",
    transport: "claude",
    command: "claude",
    args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
    permissionPolicy: "reject",
    persistent: true
  },
  {
    id: "opencode-local",
    label: "OpenCode \xB7 ACP",
    harness: "opencode",
    transport: "acp",
    command: "opencode",
    args: ["acp"],
    permissionPolicy: "reject",
    persistent: true,
    modelConfigMethod: "session/set_config_option",
    modelConfigId: "model"
  },
  {
    id: "kimi-acp",
    label: "Kimi Code \xB7 ACP",
    harness: "kimi",
    transport: "acp",
    command: "kimi",
    args: ["acp"],
    permissionPolicy: "reject",
    persistent: true,
    modelConfigMethod: "session/set_config_option",
    modelConfigId: "model"
  },
  {
    id: "omp-rpc",
    label: "OMP \xB7 ACP",
    harness: "omp",
    transport: "acp",
    command: "omp",
    args: ["acp"],
    permissionPolicy: "reject",
    persistent: true,
    modelConfigMethod: "session/set_config_option",
    modelConfigId: "model",
    promptTimeoutMs: 10 * 6e4
  },
  {
    id: "pi-rpc",
    label: "Pi \xB7 RPC",
    harness: "pi",
    transport: "rpc",
    command: "pi",
    args: ["--mode", "rpc"],
    permissionPolicy: "reject",
    persistent: true,
    readyRequired: true,
    readyTimeoutMs: 3e3,
    negotiateProtocol: true,
    protocolVersion: 2,
    rpcSessionControl: true,
    modelInArgs: false,
    modelMethod: "set_model",
    promptCompletesOnResponse: false
  },
  {
    id: "zcode-local",
    label: "ZCode \xB7 app-server",
    harness: "zcode",
    transport: "zcode",
    command: "zcode",
    args: ["app-server", "--stdio"],
    permissionPolicy: "reject",
    persistent: true,
    experimental: true
  }
];
function cloneProfile(profile) {
  return {
    ...profile,
    args: [...profile.args ?? []],
    env: profile.env ? { ...profile.env } : void 0
  };
}
function normalizeProfile(input) {
  assertMesh(input && typeof input === "object", "INVALID_PROFILE", "Profile must be an object.");
  const id = String(input.id ?? "").trim();
  const command = String(input.command ?? "").trim();
  assertMesh(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id), "INVALID_PROFILE_ID", "Profile id must be a short stable identifier.");
  assertMesh(command, "INVALID_PROFILE_COMMAND", `Profile ${id} has no command.`);
  const transport = input.transport ?? input.harness;
  assertMesh(["dsh", "codex", "claude", "acp", "rpc", "zcode", "jsonl", "mock"].includes(transport), "INVALID_PROFILE_TRANSPORT", `Unsupported transport: ${transport}.`);
  const permissionPolicy = input.permissionPolicy ?? "reject";
  assertMesh(["reject", "approve"].includes(permissionPolicy), "INVALID_PERMISSION_POLICY", `Unsupported permission policy: ${permissionPolicy}.`);
  const parsedPromptTimeoutMs = input.promptTimeoutMs === void 0 ? void 0 : Number(input.promptTimeoutMs);
  const promptTimeoutMs = Number.isFinite(parsedPromptTimeoutMs) ? Math.max(1e3, parsedPromptTimeoutMs) : void 0;
  return {
    id,
    label: String(input.label ?? input.name ?? id),
    harness: String(input.harness ?? transport),
    transport,
    command,
    args: Array.isArray(input.args) ? input.args.map(String) : [],
    model: input.model ? String(input.model) : void 0,
    cwd: input.cwd ? String(input.cwd) : void 0,
    env: input.env && typeof input.env === "object" ? { ...input.env } : void 0,
    inheritEnv: input.inheritEnv ?? true,
    permissionPolicy,
    persistent: input.persistent ?? true,
    routeable: input.routeable ?? transport !== "dsh",
    nativeHost: input.nativeHost ?? transport === "dsh",
    timeoutMs: Math.max(1e3, Number(input.timeoutMs ?? 12e4)),
    ...promptTimeoutMs === void 0 ? {} : { promptTimeoutMs },
    maxLineBytes: Math.max(4096, Number(input.maxLineBytes ?? 8 * 1024 * 1024)),
    resumeMethod: input.resumeMethod,
    promptParam: input.promptParam,
    closeSession: input.closeSession,
    setModel: input.setModel,
    allowModelSwitch: input.allowModelSwitch ?? false,
    strictModel: input.strictModel ?? false,
    ...Object.fromEntries(Object.entries(input).filter(([key]) => ![
      "id",
      "label",
      "name",
      "harness",
      "transport",
      "command",
      "args",
      "model",
      "cwd",
      "env",
      "inheritEnv",
      "permissionPolicy",
      "persistent",
      "timeoutMs",
      "maxLineBytes",
      "resumeMethod",
      "promptParam",
      "closeSession",
      "setModel",
      "allowModelSwitch",
      "strictModel",
      "routeable",
      "nativeHost",
      "promptTimeoutMs"
    ].includes(key)))
  };
}
var ProfileRegistry = class {
  constructor(profiles = [], options = {}) {
    this.map = /* @__PURE__ */ new Map();
    const includeDefaults = options.includeDefaults ?? true;
    if (includeDefaults) {
      for (const profile of DEFAULT_PROFILES) this.set(profile);
    }
    for (const profile of profiles) this.set(profile);
  }
  set(profile) {
    const normalized = normalizeProfile(profile);
    this.map.set(normalized.id, normalized);
    return normalized;
  }
  get(id) {
    const profile = this.map.get(id);
    if (!profile) throw new MeshError("PROFILE_NOT_FOUND", `Profile not found: ${id}.`, { id });
    return cloneProfile(profile);
  }
  has(id) {
    return this.map.has(id);
  }
  list() {
    return [...this.map.values()].map((profile) => ({
      id: profile.id,
      label: profile.label,
      harness: profile.harness,
      transport: profile.transport,
      command: profile.command,
      model: profile.model,
      persistent: profile.persistent,
      permissionPolicy: profile.permissionPolicy,
      routeable: profile.routeable,
      nativeHost: profile.nativeHost,
      available: profile.discovery?.detected ?? true,
      experimental: profile.experimental ?? profile.discovery?.experimental ?? false,
      discovery: profile.discovery
    }));
  }
};

// src/line-process.js
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
function withTimeout(promise, timeoutMs, onTimeout) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
      }
      reject(new MeshError("PROCESS_TIMEOUT", `Process did not exit within ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
var LineProcess = class {
  constructor(options) {
    this.command = options.command;
    this.args = [...options.args ?? []];
    this.cwd = options.cwd;
    this.env = options.env;
    this.inheritEnv = options.inheritEnv ?? true;
    this.maxLineBytes = options.maxLineBytes ?? 8 * 1024 * 1024;
    this.onObject = options.onObject;
    this.onLine = options.onLine;
    this.onStderr = options.onStderr;
    this.onExit = options.onExit;
    this.child = void 0;
    this.readline = void 0;
    this.closed = false;
    this.exitPromise = void 0;
    this.closePromise = void 0;
  }
  get pid() {
    return this.child?.pid;
  }
  get alive() {
    return Boolean(this.child && !this.child.killed && !this.closed);
  }
  async start() {
    if (this.child) return this;
    const environment = this.inheritEnv ? { ...process.env, ...this.env ?? {} } : { ...this.env ?? {} };
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"]
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
      this.child.once("exit", (code, signal) => {
        finish({ code, signal });
      });
      this.child.once("error", (error) => finish({ error: asMeshError(error, "PROCESS_SPAWN_ERROR") }));
    });
    this.readline = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.readline.on("line", (line) => {
      if (!line.trim()) return;
      if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
        this.onExit?.({ error: new MeshError("PROTOCOL_LINE_TOO_LARGE", `Protocol line exceeded ${this.maxLineBytes} bytes.`) });
        void this.close();
        return;
      }
      this.onLine?.(line);
      try {
        this.onObject?.(JSON.parse(line));
      } catch (error) {
        this.onExit?.({
          error: new MeshError("PROTOCOL_INVALID_JSON", "The harness emitted a non-JSON line.", {
            line: truncateText(line, 512),
            cause: error?.message
          })
        });
      }
    });
    this.child.stderr.on("data", (chunk) => {
      this.onStderr?.(truncateText(chunk.toString("utf8"), 16 * 1024));
    });
    return this;
  }
  writeRaw(value) {
    if (!this.child?.stdin?.writable || this.closed) {
      throw new MeshError("PROCESS_NOT_WRITABLE", "The harness process is not writable.");
    }
    return new Promise((resolve, reject) => {
      this.child.stdin.write(value, "utf8", (error) => error ? reject(asMeshError(error, "PROCESS_WRITE_ERROR")) : resolve());
    });
  }
  writeJson(value) {
    return this.writeRaw(`${JSON.stringify(value)}
`);
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
      try {
        this.child.stdin.end();
      } catch {
      }
      try {
        this.readline?.close();
      } catch {
      }
    }
    if (!this.closed) {
      try {
        await withTimeout(this.exitPromise, graceMs, () => child.kill("SIGTERM"));
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
        }
        await this.exitPromise.catch(() => void 0);
      }
    }
    this.closed = true;
  }
};

// src/json-rpc.js
function jsonRpcError(error) {
  return {
    code: error?.code ?? -32e3,
    message: error?.message ?? String(error),
    ...error?.data === void 0 ? {} : { data: error.data }
  };
}
var JsonRpcProcess = class {
  constructor(options) {
    this.protocol = options.protocol ?? "jsonrpc";
    this.timeoutMs = options.timeoutMs ?? 12e4;
    this.logger = options.logger;
    this.pending = /* @__PURE__ */ new Map();
    this.nextId = 1;
    this.onNotification = options.onNotification;
    this.onRequest = options.onRequest;
    this.onProtocolError = options.onProtocolError;
    this.onExit = options.onExit;
    this.process = new LineProcess({
      ...options,
      onObject: (message) => this.#receive(message),
      onStderr: (line) => this.logger?.debug?.({ line }, "harness stderr"),
      onExit: (event2) => this.#exit(event2)
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
      ...this.protocol === "jsonrpc" ? { jsonrpc: "2.0" } : {},
      id,
      method,
      params
    };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new MeshError("RPC_TIMEOUT", `Timed out waiting for ${method}.`, { method, id });
        reject(error);
        void this.close({ graceMs: 500 }).catch(() => void 0);
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
      ...this.protocol === "jsonrpc" ? { jsonrpc: "2.0" } : {},
      method,
      params
    });
  }
  async close(options) {
    await this.process.close(options);
    this.#rejectPending(new MeshError("PROCESS_CLOSED", "The harness process closed."));
  }
  #receive(message) {
    if (!message || typeof message !== "object") return;
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    if (hasId && (Object.prototype.hasOwnProperty.call(message, "result") || Object.prototype.hasOwnProperty.call(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new MeshError("RPC_REMOTE_ERROR", message.error.message || "Remote RPC error.", message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && hasId) {
      void this.#handleRequest(message);
      return;
    }
    if (message.method) {
      try {
        this.onNotification?.(message);
      } catch (error) {
        this.onProtocolError?.(asMeshError(error));
      }
    }
  }
  async #handleRequest(message) {
    let result;
    try {
      result = await this.onRequest?.(message.method, message.params, message);
      await this.process.writeJson({
        ...this.protocol === "jsonrpc" ? { jsonrpc: "2.0" } : {},
        id: message.id,
        result: result ?? {}
      });
    } catch (error) {
      await this.process.writeJson({
        ...this.protocol === "jsonrpc" ? { jsonrpc: "2.0" } : {},
        id: message.id,
        error: jsonRpcError(error)
      }).catch(() => void 0);
    }
  }
  #exit(event2) {
    this.onExit?.(event2);
    if (event2?.error) this.onProtocolError?.(event2.error);
    const error = event2?.error ?? new MeshError("PROCESS_EXITED", "The harness process exited.", event2);
    this.#rejectPending(error);
  }
  #rejectPending(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
};

// src/adapters/shared.js
function textFromContent(content) {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    if (content.type === "text" || content.type === "output_text" || content.type === "text_delta") return String(content.text ?? content.delta ?? content.value ?? "");
    return textFromContent(content.content ?? content.text ?? content.delta);
  }
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.type === "text" || part?.type === "output_text") return String(part.text ?? part.value ?? "");
    if (part?.type === "text_delta") return String(part.text ?? part.delta ?? "");
    return "";
  }).join("");
}
function textFromValue(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return textFromContent(value.content ?? value.text ?? value.message?.content ?? value.output ?? value.result);
}
function event(kind, data = {}) {
  return {
    kind,
    ts: Date.now(),
    ...data
  };
}
function defaultApprovalReply(method, policy = "reject") {
  if (policy === "approve") return { decision: "allow" };
  if (/approval|permission/i.test(method)) return { decision: "decline" };
  return {};
}
function finalText(value) {
  return truncateText(textFromValue(value), 512 * 1024);
}
function withTimeout2(promise, timeoutMs, options = {}) {
  const limit = Number(timeoutMs);
  if (!Number.isFinite(limit) || limit <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      try {
        await Promise.resolve(options.onTimeout?.());
      } catch {
      }
      reject(new MeshError(options.code ?? "HARNESS_TIMEOUT", options.message ?? `Harness turn exceeded ${limit}ms.`));
    }, limit);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// src/adapters/acp.js
function sessionUpdateFrom(message) {
  const update = message?.params?.update ?? message?.params;
  return update && typeof update === "object" ? update : {};
}
function acpText(update) {
  const content = update.content ?? update.message?.content ?? update.delta;
  return textFromContent(content) || (typeof update.text === "string" ? update.text : "");
}
function methodUnavailable(error) {
  const text = String(error?.message ?? "").toLowerCase();
  return /method not found|not implemented|unsupported|unknown method/.test(text) || Number(error?.details?.code) === -32601;
}
function sessionMissing(error) {
  return /resource_not_found|session.*not found|unknown session/i.test(String(error?.message ?? ""));
}
function ompResumeBroken(error, profile) {
  return profile.harness === "omp" && error?.code === "RPC_REMOTE_ERROR" && Number(error?.details?.code) === -32603;
}
var AcpAdapter = class {
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
      protocol: "jsonrpc",
      logger: this.logger,
      onRequest: async (method, params, request) => {
        const custom = await options.onRequest?.(method, params, request);
        return custom ?? defaultApprovalReply(method, profile.permissionPolicy);
      },
      onNotification: (message) => this.#notification(handle, message),
      onExit: (exit) => options.onEvent?.(event("process_exit", { exit })),
      onProtocolError: (error) => options.onEvent?.(event("protocol_error", { error: error.toJSON?.() ?? { message: error.message } }))
    });
    await rpc.start();
    const initialize = await rpc.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "dsh-agent-mesh", version: "0.1.0" },
      clientCapabilities: {}
    });
    await rpc.notify("initialized", {});
    const agentCapabilities = initialize?.agentCapabilities ?? initialize?.capabilities ?? {};
    let result;
    let handoffRequired = false;
    if (options.nativeSessionId) {
      const resumeMethod = profile.resumeMethod ?? "session/load";
      try {
        result = await rpc.request(resumeMethod, {
          sessionId: options.nativeSessionId,
          cwd: options.cwd ?? profile.cwd
        });
      } catch (error) {
        if (methodUnavailable(error)) {
          result = await rpc.request("session/new", {
            cwd: options.cwd ?? profile.cwd,
            mcpServers: profile.mcpServers ?? []
          });
          handoffRequired = true;
        } else if (sessionMissing(error)) {
          throw new MeshError("NATIVE_SESSION_NOT_FOUND", "ACP native session is no longer available.", { cause: error.message });
        } else if (ompResumeBroken(error, profile)) {
          result = await rpc.request("session/new", {
            cwd: options.cwd ?? profile.cwd,
            mcpServers: profile.mcpServers ?? []
          });
          handoffRequired = true;
        } else throw error;
      }
    } else {
      result = await rpc.request("session/new", {
        cwd: options.cwd ?? profile.cwd,
        mcpServers: profile.mcpServers ?? []
      });
    }
    const nativeSessionId = result?.sessionId ?? result?.session_id ?? options.nativeSessionId;
    if (!nativeSessionId) {
      await rpc.close();
      throw new MeshError("ACP_SESSION_ID_MISSING", "ACP server did not return a session id.");
    }
    handle = {
      rpc,
      profile,
      nativeSessionId,
      onEvent: options.onEvent,
      currentText: [],
      completed: /* @__PURE__ */ new Map()
    };
    let modelSwitch = false;
    if (profile.model && profile.setModel !== false) {
      let modelError;
      try {
        await rpc.request(profile.modelMethod ?? "session/set_model", {
          sessionId: nativeSessionId,
          modelId: profile.model,
          model: profile.model
        });
      } catch (error) {
        modelError = error;
        if (profile.modelConfigMethod !== false) {
          try {
            await rpc.request(profile.modelConfigMethod ?? "session/set_config_option", {
              sessionId: nativeSessionId,
              configId: profile.modelConfigId ?? "model",
              value: profile.model
            });
            modelError = void 0;
            modelSwitch = true;
          } catch (configError) {
            modelError = configError;
            this.logger?.debug?.({ error: configError.message, profile: profile.id }, "ACP model config option not supported");
          }
        }
        if (modelError && profile.strictModel) throw modelError;
        if (modelError) this.logger?.debug?.({ error: modelError.message, profile: profile.id }, "ACP model switch not supported");
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
        negotiated: true
      },
      prompt: (text, metadata) => this.#prompt(handle, text, metadata),
      close: () => rpc.close(),
      getNativeSessionId: () => handle.nativeSessionId
    };
  }
  async #prompt(handle, text, metadata = {}) {
    handle.currentText = [];
    const promptKey = metadata.messageId ?? `${Date.now()}`;
    const prompt = [{ type: "text", text }];
    const params = {
      sessionId: handle.nativeSessionId,
      [handle.profile.promptParam ?? "prompt"]: prompt
    };
    const result = await handle.rpc.request(
      "session/prompt",
      params,
      handle.profile.promptTimeoutMs ?? handle.profile.timeoutMs
    );
    const output = handle.currentText.join("") || finalText(result);
    return {
      text: output,
      nativeSessionId: handle.nativeSessionId,
      promptKey,
      stopReason: result?.stopReason
    };
  }
  #notification(handle, message) {
    if (!handle) return;
    const update = sessionUpdateFrom(message);
    const updateType = update.sessionUpdate ?? update.type ?? message.method;
    const text = acpText(update);
    if (text && /agent_message|message_chunk|assistant|text_delta/i.test(String(updateType))) {
      handle.currentText.push(text);
      handle.onEvent?.(event("assistant_delta", { text }));
      return;
    }
    if (/tool_call|tool_call_update|command/i.test(String(updateType))) {
      handle.onEvent?.(event("tool", { update }));
      return;
    }
    if (/plan/i.test(String(updateType))) {
      handle.onEvent?.(event("plan", { update }));
      return;
    }
    handle.onEvent?.(event("notification", { method: message.method, update }));
  }
};

// src/adapters/claude.js
import { randomUUID as randomUUID3 } from "node:crypto";
var DEFAULT_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
function extractClaudeText(message) {
  if (!message || typeof message !== "object") return "";
  if (message.type === "content_block_delta") return message.delta?.text ?? "";
  if (message.type === "stream_event") {
    const eventValue = message.event;
    if (eventValue?.type === "content_block_delta") return eventValue.delta?.text ?? "";
    if (eventValue?.type === "message_delta") return eventValue.delta?.text ?? "";
  }
  if (message.type === "assistant") return textFromContent(message.message?.content ?? message.content);
  if (message.type === "result") return finalText(message.result ?? message);
  return "";
}
function hasFlag(args, flag) {
  return args.some((item) => item === flag || item.startsWith(`${flag}=`));
}
function uuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? ""));
}
var ClaudeAdapter = class {
  constructor(options = {}) {
    this.logger = options.logger;
  }
  async open(profile, options = {}) {
    let handle;
    const args = [...profile.args?.length ? profile.args : DEFAULT_ARGS];
    const launchSessionId = options.nativeSessionId && profile.resume !== false ? void 0 : randomUUID3();
    if (options.nativeSessionId && profile.resume !== false && !hasFlag(args, "--resume")) args.push("--resume", options.nativeSessionId);
    if (!options.nativeSessionId && !hasFlag(args, "--session-id")) args.push("--session-id", launchSessionId);
    if (profile.model && !hasFlag(args, "--model")) args.push("--model", profile.model);
    const streamPrint = (hasFlag(args, "-p") || hasFlag(args, "--print")) && hasFlag(args, "--input-format") && hasFlag(args, "--output-format");
    if (streamPrint && !hasFlag(args, "--include-partial-messages")) args.push("--include-partial-messages");
    if (streamPrint && !hasFlag(args, "--replay-user-messages")) args.push("--replay-user-messages");
    if (!hasFlag(args, "--permission-mode")) args.push("--permission-mode", profile.permissionPolicy === "approve" ? "acceptEdits" : "dontAsk");
    if (profile.maxTurns && !hasFlag(args, "--max-turns")) args.push("--max-turns", String(profile.maxTurns));
    const process2 = new LineProcess({
      command: profile.command,
      args,
      cwd: options.cwd ?? profile.cwd,
      env: profile.env,
      inheritEnv: profile.inheritEnv,
      maxLineBytes: profile.maxLineBytes,
      onObject: (message) => this.#message(handle, message),
      onStderr: (line) => this.logger?.debug?.({ line }, "claude stderr"),
      onExit: (exit) => {
        options.onEvent?.(event("process_exit", { exit }));
        if (handle?.active) handle.active.reject(exit.error ?? new MeshError("CLAUDE_EXITED", "Claude Code exited during a prompt.", exit));
      }
    });
    await process2.start();
    handle = {
      process: process2,
      profile,
      nativeSessionId: options.nativeSessionId ?? launchSessionId,
      onEvent: options.onEvent,
      active: void 0,
      text: []
    };
    return {
      nativeSessionId: handle.nativeSessionId,
      capabilities: { persistent: true, resume: true, streaming: true, partialEvents: true, replayUserMessages: true, permissionMode: true, modelSwitch: false },
      prompt: (text, metadata) => this.#prompt(handle, text, metadata),
      close: () => process2.close(),
      getNativeSessionId: () => handle.nativeSessionId
    };
  }
  async #prompt(handle, text, metadata = {}) {
    if (handle.active) throw new MeshError("CLAUDE_BUSY", "Claude Code is already processing a prompt.");
    handle.text = [];
    const request = {
      type: "user",
      uuid: uuid(metadata.messageId) ? metadata.messageId : randomUUID3(),
      message: { role: "user", content: [{ type: "text", text }] }
    };
    const result = new Promise((resolve, reject) => {
      handle.active = { resolve, reject };
    });
    try {
      await handle.process.writeJson(request);
    } catch (error) {
      handle.active = void 0;
      throw error;
    }
    let output;
    try {
      output = await withTimeout2(result, handle.profile.timeoutMs, {
        code: "CLAUDE_TIMEOUT",
        message: "Claude Code did not finish the turn before the harness timeout.",
        onTimeout: () => handle.process.close({ graceMs: 500 })
      });
    } finally {
      handle.active = void 0;
    }
    if (output?.is_error === true || output?.isError === true) {
      const message = finalText(output) || "Claude Code returned an error.";
      const lower = message.toLowerCase();
      if (/session|conversation/.test(lower) && /not found|unknown|invalid|does not exist/.test(lower)) {
        throw new MeshError("NATIVE_SESSION_NOT_FOUND", message, { result: output?.result ?? output?.subtype });
      }
      throw new MeshError("CLAUDE_RESULT_ERROR", message, { result: output?.result ?? output?.subtype });
    }
    return {
      text: handle.text.join("") || finalText(output),
      nativeSessionId: handle.nativeSessionId ?? output?.session_id ?? output?.sessionId,
      isError: output?.is_error,
      usage: output?.usage
    };
  }
  #message(handle, message) {
    if (!handle) return;
    const sessionId = message.session_id ?? message.sessionId ?? message.event?.session_id;
    if (sessionId) handle.nativeSessionId = sessionId;
    const text = message.type === "result" && handle.text.length > 0 ? "" : extractClaudeText(message);
    if (text) {
      handle.text.push(text);
      handle.onEvent?.(event("assistant_delta", { text }));
    }
    if (message.type === "result") {
      handle.onEvent?.(event("result", { result: { ...message, result: void 0 } }));
      handle.active?.resolve(message);
      return;
    }
    if (message.type === "system") {
      handle.onEvent?.(event("system", { message }));
      return;
    }
    if (message.type === "stream_event") {
      handle.onEvent?.(event("stream_event", { event: message.event }));
      return;
    }
    if (message.type === "tool_use" || message.type === "tool_result") {
      handle.onEvent?.(event("tool", { message }));
      return;
    }
    handle.onEvent?.(event("notification", { message }));
  }
};

// src/adapters/codex.js
function threadIdFrom(value) {
  return value?.thread?.id ?? value?.threadId ?? value?.thread_id ?? value?.id;
}
function turnIdFrom(value) {
  return value?.turn?.id ?? value?.turnId ?? value?.turn_id ?? value?.id;
}
var CodexAdapter = class {
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
      protocol: "codex",
      logger: this.logger,
      onRequest: async (method, params, request) => {
        const custom = await options.onRequest?.(method, params, request);
        return custom ?? defaultApprovalReply(method, profile.permissionPolicy);
      },
      onNotification: (message) => this.#notification(handle, message),
      onExit: (exit) => options.onEvent?.(event("process_exit", { exit })),
      onProtocolError: (error) => options.onEvent?.(event("protocol_error", { error: error.toJSON?.() ?? { message: error.message } }))
    });
    await rpc.start();
    await rpc.request("initialize", {
      clientInfo: { name: "dsh-agent-mesh", title: "DSH Agent Mesh", version: "0.1.0" },
      capabilities: {}
    });
    await rpc.notify("initialized", {});
    if (profile.preflight) {
      const timeout = Math.min(profile.preflightTimeoutMs ?? 5e3, profile.timeoutMs ?? 12e4);
      const [account, catalog] = await Promise.all([
        rpc.request("account/read", { refreshToken: false }, timeout).catch((error) => ({ __error: error })),
        rpc.request("model/list", { includeHidden: false }, timeout).catch((error) => ({ __error: error }))
      ]);
      if (!account.__error) {
        const accountValue = account?.account ?? account?.value ?? account;
        if (accountValue === null) {
          await rpc.close();
          throw new MeshError("CODEX_AUTH_MISSING", "Codex app-server has no authenticated account.");
        }
      }
      if (profile.model && !catalog.__error) {
        const models = catalog?.data?.items ?? catalog?.data ?? catalog?.models ?? catalog?.items ?? [];
        if (Array.isArray(models) && models.length && !models.some((item) => (item?.id ?? item?.slug ?? item?.model) === profile.model)) {
          await rpc.close();
          throw new MeshError("CODEX_MODEL_NOT_FOUND", `Codex model is not available: ${profile.model}.`, { model: profile.model });
        }
      }
    }
    const startParams = {
      cwd: options.cwd ?? profile.cwd,
      model: profile.model,
      reasoningEffort: options.reasoningEffort ?? profile.reasoningEffort,
      approvalPolicy: profile.approvalPolicy,
      sandbox: profile.sandbox,
      ephemeral: false
    };
    const response = options.nativeSessionId ? await rpc.request("thread/resume", { threadId: options.nativeSessionId, ...startParams }) : await rpc.request("thread/start", startParams);
    const nativeSessionId = threadIdFrom(response) ?? options.nativeSessionId;
    if (!nativeSessionId) {
      await rpc.close();
      throw new MeshError("CODEX_THREAD_ID_MISSING", "Codex app-server did not return a thread id.");
    }
    handle = {
      rpc,
      profile,
      nativeSessionId,
      onEvent: options.onEvent,
      turns: /* @__PURE__ */ new Map(),
      buffered: /* @__PURE__ */ new Map(),
      activeText: /* @__PURE__ */ new Map()
    };
    return {
      nativeSessionId,
      capabilities: { persistent: true, resume: true, streaming: true, modelSwitch: Boolean(profile.allowModelSwitch) },
      prompt: (text, metadata) => this.#prompt(handle, text, metadata),
      close: () => rpc.close()
    };
  }
  async #prompt(handle, text, metadata = {}) {
    const params = {
      threadId: handle.nativeSessionId,
      input: [{ type: "text", text }],
      ...metadata.reasoningEffort ? { effort: metadata.reasoningEffort } : {},
      ...handle.profile.allowModelSwitch && metadata.model ? { model: metadata.model } : {}
    };
    const started = await handle.rpc.request("turn/start", params, handle.profile.timeoutMs);
    const turnId = turnIdFrom(started);
    if (!turnId) return { text: finalText(started), nativeSessionId: handle.nativeSessionId };
    const alreadyCompleted = handle.buffered.get(turnId);
    if (alreadyCompleted) {
      handle.buffered.delete(turnId);
      return this.#turnResult(handle, turnId, alreadyCompleted);
    }
    let result;
    try {
      result = await withTimeout2(new Promise((resolve, reject) => {
        handle.turns.set(turnId, { resolve, reject });
      }), handle.profile.timeoutMs, {
        code: "CODEX_TURN_TIMEOUT",
        message: "Codex did not finish the turn before the harness timeout.",
        onTimeout: () => handle.rpc.close()
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
    if (message.method === "item/agentMessage/delta" || message.method === "item/agent_message/delta") {
      const text = params.delta ?? params.text ?? params.content ?? "";
      if (text) {
        const key = turnId ?? "current";
        handle.activeText.set(key, `${handle.activeText.get(key) ?? ""}${text}`);
        handle.onEvent?.(event("assistant_delta", { text }));
      }
      return;
    }
    if (message.method === "item/completed" || message.method === "item/agentMessage/completed") {
      handle.onEvent?.(event("item_completed", { item: params.item ?? params }));
      return;
    }
    if (message.method === "turn/completed" || message.method === "turn/completion") {
      const key = turnId ?? params.turn?.id;
      const waiter = key ? handle.turns.get(key) : void 0;
      if (waiter) {
        handle.turns.delete(key);
        waiter.resolve(params.turn ?? params);
      } else if (key) {
        handle.buffered.set(key, params.turn ?? params);
      }
      handle.onEvent?.(event("turn_completed", { turn: params.turn ?? params }));
      return;
    }
    if (/approval|permission/i.test(message.method)) {
      handle.onEvent?.(event("permission_request", { method: message.method, params }));
      return;
    }
    handle.onEvent?.(event("notification", { method: message.method, params }));
  }
};

// src/adapters/mock.js
import { randomUUID as randomUUID4 } from "node:crypto";
var MockAdapter = class {
  constructor(options = {}) {
    this.delayMs = options.delayMs ?? 0;
  }
  async open(profile, options = {}) {
    const nativeSessionId = options.nativeSessionId ?? `mock-${randomUUID4()}`;
    const onEvent = options.onEvent;
    return {
      nativeSessionId,
      capabilities: { persistent: true, resume: true, streaming: true, modelSwitch: true },
      prompt: async (text) => {
        if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        onEvent?.(event("assistant_delta", { text: `mock: ${text}` }));
        return { text: `mock: ${text}`, nativeSessionId };
      },
      close: async () => void 0
    };
  }
};

// src/adapters/rpc-agent.js
import { randomUUID as randomUUID5 } from "node:crypto";
var DEFAULT_MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;
var MAX_CHUNK_COUNT = 65536;
function modelArgs(profile, args) {
  if (!profile.model || profile.modelInArgs === false) return args;
  if (profile.modelFlag === false) return args;
  return [...args, profile.modelFlag ?? "--model", profile.model];
}
function modelSelection(profile) {
  const raw = String(profile.model ?? "");
  const configuredProvider = profile.modelProvider ?? profile.provider;
  if (configuredProvider && raw.startsWith(`${configuredProvider}/`)) {
    return { provider: configuredProvider, modelId: raw.slice(configuredProvider.length + 1), model: raw };
  }
  if (!configuredProvider && raw.includes("/")) {
    const separator = raw.indexOf("/");
    return { provider: raw.slice(0, separator), modelId: raw.slice(separator + 1), model: raw };
  }
  return { provider: configuredProvider ?? (raw ? raw.split("/")[0] : void 0), modelId: raw, model: raw };
}
function sessionIdFrom(value) {
  return value?.sessionId ?? value?.session_id ?? value?.session?.id ?? value?.state?.sessionId ?? value?.sessionFile ?? value?.data?.sessionId ?? value?.data?.session_id ?? value?.data?.sessionFile ?? value?.data?.state?.sessionId;
}
function deltaFrom(value) {
  if (!value || typeof value !== "object") return "";
  const type = String(value.type ?? value.event ?? value.message?.type ?? "");
  if (!/delta|text|assistant_message|agent_message|message_update/i.test(type)) return "";
  const direct = value.delta ?? value.text ?? value.assistantMessageEvent?.delta ?? value.assistantMessageEvent?.content;
  if (typeof direct === "string") return direct;
  return textFromContent(direct ?? value.content ?? value.message?.content) ?? "";
}
function readyFrom(message) {
  return message?.type === "ready" || message?.event === "ready" || message?.type === "protocol_ready";
}
function unsupported(error) {
  const text = `${error?.code ?? ""} ${error?.message ?? ""}`.toLowerCase();
  return /method not found|not implemented|unsupported|unknown command/.test(text);
}
function sessionParams(sessionId) {
  return { sessionId, session_id: sessionId, sessionPath: sessionId };
}
var RpcAgentAdapter = class {
  constructor(options = {}) {
    this.logger = options.logger;
  }
  async open(profile, options = {}) {
    let handle;
    let args = [...profile.args?.length ? profile.args : ["--mode", "rpc"]];
    if (options.nativeSessionId && profile.resume !== false && profile.rpcSessionControl !== true) {
      args = [...args, profile.sessionFlag ?? "--session", options.nativeSessionId];
    }
    args = modelArgs(profile, args);
    const process2 = new LineProcess({
      command: profile.command,
      args,
      cwd: options.cwd ?? profile.cwd,
      env: profile.env,
      inheritEnv: profile.inheritEnv,
      maxLineBytes: profile.maxLineBytes,
      onObject: (message) => this.#message(handle, message),
      onStderr: (line) => this.logger?.debug?.({ line }, "rpc harness stderr"),
      onExit: (exit) => {
        options.onEvent?.(event("process_exit", { exit }));
        handle?.readyReject?.(exit.error ?? new MeshError("RPC_AGENT_EXITED", "RPC harness exited before it became ready.", exit));
        if (handle?.active) handle.active.reject(exit.error ?? new MeshError("RPC_AGENT_EXITED", "RPC harness exited during a prompt.", exit));
      }
    });
    handle = {
      process: process2,
      profile,
      nativeSessionId: options.nativeSessionId,
      onEvent: options.onEvent,
      active: void 0,
      text: [],
      chunks: /* @__PURE__ */ new Map(),
      readyResolve: void 0,
      readyReject: void 0,
      ready: void 0,
      promptCompletesOnResponse: profile.promptCompletesOnResponse !== false,
      maxReassembledFrameBytes: Math.min(
        Number.isFinite(Number(profile.maxReassembledFrameBytes)) ? Number(profile.maxReassembledFrameBytes) : DEFAULT_MAX_REASSEMBLED_FRAME_BYTES,
        DEFAULT_MAX_REASSEMBLED_FRAME_BYTES
      )
    };
    handle.ready = new Promise((resolve, reject) => {
      handle.readyResolve = resolve;
      handle.readyReject = reject;
    });
    try {
      await process2.start();
      if (profile.readyRequired) {
        await Promise.race([
          handle.ready,
          new Promise((_, reject) => setTimeout(() => reject(new MeshError("RPC_READY_TIMEOUT", "RPC harness did not announce ready state.", { command: profile.command })), profile.readyTimeoutMs ?? 2e3))
        ]);
      }
      if (profile.negotiateProtocol) {
        await this.#send(handle, { type: "negotiate_protocol", protocolVersion: profile.protocolVersion ?? 2, protocol_version: profile.protocolVersion ?? 2 });
      }
      let handoffRequired = false;
      if (profile.rpcSessionControl) {
        try {
          const session = options.nativeSessionId ? await this.#sendRequest(handle, "switch_session", sessionParams(options.nativeSessionId)) : await this.#sendRequest(handle, "new_session", { cwd: options.cwd ?? profile.cwd });
          handle.nativeSessionId = sessionIdFrom(session) ?? options.nativeSessionId;
        } catch (error) {
          if (options.nativeSessionId && unsupported(error)) {
            const session = await this.#sendRequest(handle, "new_session", { cwd: options.cwd ?? profile.cwd });
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
          this.logger?.debug?.({ error: error.message, profile: profile.id }, "RPC model selection is not supported");
        }
      }
      return {
        nativeSessionId: handle.nativeSessionId,
        handoffRequired,
        capabilities: { persistent: true, resume: profile.rpcSessionControl ? true : profile.resume !== false, streaming: true, protocolReady: Boolean(profile.readyRequired), chunkedFrames: true, modelSwitch: Boolean(profile.modelMethod) },
        prompt: (text, metadata) => this.#prompt(handle, text, metadata),
        close: () => process2.close(),
        getNativeSessionId: () => handle.nativeSessionId
      };
    } catch (error) {
      await process2.close().catch(() => void 0);
      throw error;
    }
  }
  async #send(handle, command) {
    await handle.process.writeJson(command);
  }
  async #sendRequest(handle, type, command) {
    const id = `dsh-${randomUUID5()}`;
    const result = new Promise((resolve, reject) => {
      handle.control = handle.control ?? /* @__PURE__ */ new Map();
      handle.control.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        handle.control.delete(id);
        reject(new MeshError("RPC_CONTROL_TIMEOUT", `Timed out waiting for ${type}.`));
        void handle.process.close({ graceMs: 500 }).catch(() => void 0);
      }, handle.profile.timeoutMs ?? 12e4);
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
    if (handle.active) throw new MeshError("RPC_AGENT_BUSY", "RPC harness is already processing a prompt.");
    handle.text = [];
    const id = metadata.messageId ?? `dsh-${randomUUID5()}`;
    const result = new Promise((resolve, reject) => {
      handle.active = { id, resolve, reject };
    });
    await this.#send(handle, {
      id,
      type: "prompt",
      message: text,
      ...handle.profile.streamingBehavior ? { streamingBehavior: handle.profile.streamingBehavior } : {}
    });
    let response;
    try {
      response = await withTimeout2(result, handle.profile.timeoutMs, {
        code: "RPC_PROMPT_TIMEOUT",
        message: "RPC harness did not finish the prompt before the harness timeout.",
        onTimeout: () => process.close({ graceMs: 500 })
      });
    } finally {
      handle.active = void 0;
    }
    return {
      text: handle.text.join("") || finalText(response?.message ?? response?.result ?? response),
      nativeSessionId: handle.nativeSessionId,
      usage: response?.usage,
      success: response?.success
    };
  }
  #message(handle, message) {
    if (!handle) return;
    if (readyFrom(message)) {
      handle.protocolVersion = Number(message.protocolVersion ?? message.protocol_version) || void 0;
      handle.supportedProtocolVersions = Array.isArray(message.supportedProtocolVersions) ? message.supportedProtocolVersions.map(Number).filter(Number.isInteger) : void 0;
      if (Number.isFinite(Number(message.maxReassembledFrameBytes)) && Number(message.maxReassembledFrameBytes) > 0) {
        handle.maxReassembledFrameBytes = Math.min(handle.maxReassembledFrameBytes, Number(message.maxReassembledFrameBytes));
      }
      handle.readyResolve?.(message);
      handle.readyResolve = void 0;
      return;
    }
    if (message.type === "chunk" || message.type === "frame_chunk" || message.type === "rpc_chunk" || message.chunk_id || message.chunkId) {
      this.#chunk(handle, message);
      return;
    }
    const control = message.id && handle.control?.get(message.id);
    if (control && (message.result !== void 0 || message.error !== void 0 || message.type === "response")) {
      clearTimeout(control.timer);
      handle.control.delete(message.id);
      if (message.error || message.success === false) control.reject(new MeshError("RPC_REMOTE_ERROR", message.error?.message ?? message.message ?? "RPC control request failed.", message.error ?? message));
      else control.resolve(message.result ?? message);
      return;
    }
    const discovered = sessionIdFrom(message);
    if (discovered) handle.nativeSessionId = discovered;
    const text = deltaFrom(message);
    if (text) {
      handle.text.push(String(text));
      handle.onEvent?.(event("assistant_delta", { text: String(text) }));
    }
    if (message.type === "response" && (!handle.active || message.id === handle.active.id)) {
      handle.onEvent?.(event("result", { result: message }));
      const data = message.data ?? message.result;
      if (handle.active && message.success === false) handle.active.reject(new MeshError("RPC_PROMPT_REJECTED", message.message ?? "RPC prompt was rejected.", message));
      else if (handle.active && (handle.promptCompletesOnResponse || data?.agentInvoked === false)) handle.active.resolve(message);
      return;
    }
    if (message.type === "prompt_result") {
      if (handle.active && (message.agentInvoked ?? message.data?.agentInvoked) === false) handle.active.resolve(message);
      return;
    }
    if (message.type === "agent_end" || message.type === "agent_settled" || message.type === "turn_end") {
      if (handle.active && message.isTerminal !== false) handle.active.resolve(message);
      handle.onEvent?.(event("turn_completed", { result: message }));
      return;
    }
    if (message.type === "tool_execution_start" || message.type === "tool_execution_end") {
      handle.onEvent?.(event("tool", { result: message }));
      return;
    }
    handle.onEvent?.(event("notification", { message }));
  }
  #protocolError(handle, code, message, details) {
    const error = new MeshError(code, message, details);
    handle.onEvent?.(event("protocol_error", { error: error.toJSON() }));
    handle.active?.reject(error);
  }
  #chunk(handle, message) {
    const key = String(message.chunk_id ?? message.chunkId ?? message.stream_id ?? message.id ?? "default");
    const total = Number(message.count ?? message.total ?? message.total_chunks);
    const index = Number(message.index ?? message.chunk_index);
    if (!Number.isInteger(total) || total < 1 || total > MAX_CHUNK_COUNT) {
      this.#protocolError(handle, "RPC_CHUNK_INVALID", "RPC chunk count is invalid.", { key, total });
      handle.chunks.delete(key);
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index >= total) {
      this.#protocolError(handle, "RPC_CHUNK_INVALID", "RPC chunk index is invalid.", { key, index, total });
      handle.chunks.delete(key);
      return;
    }
    const isRpcChunk = message.type === "rpc_chunk";
    let bytes;
    try {
      if (isRpcChunk) {
        if (typeof message.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data) || message.data.length % 4 === 1) throw new Error("invalid base64 data");
        bytes = Buffer.from(message.data, "base64");
      } else {
        const value = typeof message.data === "string" ? message.data : JSON.stringify(message.data ?? message.payload ?? "");
        bytes = Buffer.from(value, "utf8");
      }
    } catch (error) {
      this.#protocolError(handle, "RPC_CHUNK_INVALID", "RPC chunk payload is invalid.", { key, cause: error.message });
      handle.chunks.delete(key);
      return;
    }
    const expectedBytes = message.byteLength === void 0 ? void 0 : Number(message.byteLength);
    if (expectedBytes !== void 0 && (!Number.isInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > handle.maxReassembledFrameBytes)) {
      this.#protocolError(handle, "RPC_CHUNK_TOO_LARGE", "RPC chunk declares an unsafe reassembled size.", { key, byteLength: message.byteLength });
      handle.chunks.delete(key);
      return;
    }
    const entry = handle.chunks.get(key) ?? { total, expectedBytes, parts: new Array(total), bytes: 0, received: 0 };
    if (entry.total !== total || expectedBytes !== void 0 && entry.expectedBytes !== void 0 && entry.expectedBytes !== expectedBytes) {
      this.#protocolError(handle, "RPC_CHUNK_INVALID", "RPC chunk metadata changed during reassembly.", { key });
      handle.chunks.delete(key);
      return;
    }
    if (entry.parts[index] !== void 0) {
      if (!entry.parts[index].equals(bytes)) this.#protocolError(handle, "RPC_CHUNK_INVALID", "RPC chunk index was sent with conflicting data.", { key, index });
      return;
    }
    if (bytes.length > handle.maxReassembledFrameBytes || entry.bytes + bytes.length > handle.maxReassembledFrameBytes) {
      this.#protocolError(handle, "RPC_CHUNK_TOO_LARGE", "RPC chunk reassembly exceeds the configured limit.", { key, maxBytes: handle.maxReassembledFrameBytes });
      handle.chunks.delete(key);
      return;
    }
    entry.parts[index] = bytes;
    entry.bytes += bytes.length;
    entry.received += 1;
    handle.chunks.set(key, entry);
    if (entry.received !== entry.total) return;
    handle.chunks.delete(key);
    if (entry.expectedBytes !== void 0 && entry.bytes !== entry.expectedBytes) {
      this.#protocolError(handle, "RPC_CHUNK_INVALID", "RPC chunk reassembly length does not match byteLength.", { key, expected: entry.expectedBytes, actual: entry.bytes });
      return;
    }
    try {
      this.#message(handle, JSON.parse(Buffer.concat(entry.parts).toString("utf8")));
    } catch (error) {
      this.#protocolError(handle, "RPC_CHUNK_INVALID", "RPC chunk reassembled payload is not valid JSON.", { key, cause: error.message });
    }
  }
};

// src/adapters/zcode.js
function sessionIdFrom2(value) {
  return value?.sessionId ?? value?.session_id ?? value?.session?.id ?? value?.data?.sessionId;
}
function eventText(value) {
  if (!value || typeof value !== "object") return "";
  return value.delta ?? value.text ?? textFromContent(value.content ?? value.message?.content ?? value.data?.content) ?? "";
}
var ZcodeAdapter = class {
  constructor(options = {}) {
    this.logger = options.logger;
  }
  async open(profile, options = {}) {
    let handle;
    const rpc = new JsonRpcProcess({
      command: profile.command,
      args: profile.args?.length ? profile.args : ["app-server", "--stdio"],
      cwd: options.cwd ?? profile.cwd,
      env: profile.env,
      inheritEnv: profile.inheritEnv,
      maxLineBytes: profile.maxLineBytes,
      timeoutMs: profile.timeoutMs,
      protocol: "codex",
      logger: this.logger,
      onNotification: (message) => this.#notification(handle, message),
      onProtocolError: (error) => options.onEvent?.(event("protocol_error", { error: error.toJSON?.() ?? { message: error.message } }))
    });
    await rpc.start();
    const response = options.nativeSessionId ? await rpc.request(profile.resumeMethod ?? "session/resume", { sessionId: options.nativeSessionId }) : await rpc.request(profile.createMethod ?? "session/create", {
      workspace: profile.workspace ?? { path: options.cwd ?? profile.cwd }
    });
    const nativeSessionId = sessionIdFrom2(response) ?? options.nativeSessionId;
    if (!nativeSessionId) {
      await rpc.close();
      throw new MeshError("ZCODE_SESSION_ID_MISSING", "ZCode app-server did not return a session id.");
    }
    handle = {
      rpc,
      profile,
      nativeSessionId,
      onEvent: options.onEvent,
      text: [],
      active: void 0
    };
    return {
      nativeSessionId,
      capabilities: { persistent: true, resume: true, streaming: true, modelSwitch: false, experimental: true },
      prompt: (text, metadata) => this.#prompt(handle, text, metadata),
      close: () => rpc.close()
    };
  }
  async #prompt(handle, text, metadata = {}) {
    handle.text = [];
    const response = await handle.rpc.request(handle.profile.promptMethod ?? "session/messages", {
      sessionId: handle.nativeSessionId,
      messages: [{ role: "user", content: text }],
      ...metadata.model ? { model: metadata.model } : {}
    }, handle.profile.timeoutMs);
    return {
      text: handle.text.join("") || finalText(response),
      nativeSessionId: handle.nativeSessionId,
      result: response
    };
  }
  #notification(handle, message) {
    if (!handle) return;
    const payload = message.params ?? message;
    const discovered = sessionIdFrom2(payload);
    if (discovered) handle.nativeSessionId = discovered;
    const text = eventText(payload);
    if (text) {
      handle.text.push(String(text));
      handle.onEvent?.(event("assistant_delta", { text: String(text) }));
      return;
    }
    handle.onEvent?.(event("notification", { method: message.method, payload }));
  }
};

// src/discovery.js
import { access, readFile as readFile2, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname, join as join2 } from "node:path";
var MAX_CONFIG_BYTES = 2 * 1024 * 1024;
var SECRET_FIELD = /(api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key)/i;
function splitPath(value) {
  const output = [];
  let current = "";
  let quoted = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    else if (char === "." && !quoted) {
      if (current) output.push(current.replace(/^"|"$/g, ""));
      current = "";
    } else current += char;
  }
  if (current) output.push(current.replace(/^"|"$/g, ""));
  return output;
}
function stripTomlComment(line) {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"' && line[index - 1] !== "\\") quoted = !quoted;
    if (line[index] === "#" && !quoted) return line.slice(0, index);
  }
  return line;
}
function parseScalar(value) {
  const trimmed = value.trim();
  if (!trimmed) return void 0;
  if (trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  if (trimmed === "true" || trimmed === "false") return trimmed === "true";
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map((item) => parseScalar(item)).filter((item) => item !== void 0);
  }
  return trimmed;
}
function parseTomlLite(text) {
  const root = {};
  let section = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTomlComment(raw).trim();
    if (!line) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = splitPath(line.slice(1, -1).replace(/^\[|\]$/g, ""));
      continue;
    }
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim().replace(/^"|"$/g, "");
    const path = [...section, key];
    let target = root;
    for (const part of path.slice(0, -1)) target = target[part] ??= {};
    target[path.at(-1)] = parseScalar(line.slice(equals + 1));
  }
  return root;
}
function yamlValue(value) {
  if (!value.trim()) return void 0;
  if (value.trim() === "true" || value.trim() === "false") return value.trim() === "true";
  if (/^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  if (value.trim().startsWith('"') && value.trim().endsWith('"') || value.trim().startsWith("'") && value.trim().endsWith("'")) return value.trim().slice(1, -1);
  if (value.trim().startsWith("[") && value.trim().endsWith("]")) return value.trim().slice(1, -1).split(",").map((item) => yamlValue(item.trim())).filter((item) => item !== void 0);
  return value.trim();
}
function parseYamlLite(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const line = raw.trim();
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).node;
    if (line.startsWith("- ")) {
      if (!Array.isArray(parent)) continue;
      const value = line.slice(2).trim();
      if (value.includes(":")) {
        const item = {};
        parent.push(item);
        const [key2, ...rest] = value.split(":");
        item[key2.trim()] = yamlValue(rest.join(":"));
        stack.push({ indent, node: item });
      } else parent.push(yamlValue(value));
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 1 || Array.isArray(parent)) continue;
    const key = line.slice(0, colon).trim().replace(/^['"]|['"]$/g, "");
    const rawValue = line.slice(colon + 1).trim();
    if (rawValue) {
      parent[key] = yamlValue(rawValue);
      continue;
    }
    const next = lines[index + 1]?.trim() ?? "";
    parent[key] = next.startsWith("- ") ? [] : {};
    stack.push({ indent, node: parent[key] });
  }
  return root;
}
function parseJsonc(text) {
  let withoutComments = "";
  let quote = false;
  let escape = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        withoutComments += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (char === "\n") withoutComments += char;
      continue;
    }
    if (!quote && char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (!quote && char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    withoutComments += char;
    if (char === '"' && !escape) quote = !quote;
    escape = char === "\\" && !escape;
    if (char !== "\\") escape = false;
  }
  return JSON.parse(withoutComments.replace(/,\s*([}\]])/g, "$1"));
}
async function readText(path) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return void 0;
    return await readFile2(path, "utf8");
  } catch {
    return void 0;
  }
}
async function readable(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
function commandPath(command) {
  if (command.includes("/")) return command;
  const probe = spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], {
    encoding: "utf8",
    timeout: 500,
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (probe.status !== 0) return void 0;
  return probe.stdout.trim().split(/\r?\n/)[0] || void 0;
}
function commandJson(command, args, cwd) {
  try {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: 2e3,
      maxBuffer: 512 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
    if (result.status !== 0 || result.error) return void 0;
    return JSON.parse(result.stdout ?? "");
  } catch {
    return void 0;
  }
}
function unique(items) {
  return [...new Set(items.filter(Boolean))];
}
function effortLabel(value) {
  const text = String(value ?? "").trim();
  return text ? `${text.slice(0, 1).toUpperCase()}${text.slice(1)}` : text;
}
function reasoningMetadata(item) {
  const raw = Array.isArray(item?.supported_reasoning_levels) ? item.supported_reasoning_levels : [];
  const efforts = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of raw) {
    const id = typeof entry === "string" ? entry : entry?.id ?? entry?.effort ?? entry?.name;
    if (!id || seen.has(String(id))) continue;
    const normalized = String(id);
    seen.add(normalized);
    efforts.push({ id: normalized, name: effortLabel(entry?.name ?? normalized) });
  }
  if (!efforts.length && Array.isArray(item?.thinking)) {
    for (const entry of item.thinking) {
      const normalized = String(typeof entry === "string" ? entry : entry?.id ?? entry?.level ?? entry?.name ?? "").trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      efforts.push({ id: normalized, name: effortLabel(normalized) });
    }
  }
  if (!efforts.length && item?.reasoning && item?.thinking?.minLevel && item?.thinking?.maxLevel) {
    const order = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    const min = order.indexOf(String(item.thinking.minLevel));
    const max = order.indexOf(String(item.thinking.maxLevel));
    if (min >= 0 && max >= min) {
      for (const id of order.slice(min, max + 1)) efforts.push({ id, name: effortLabel(id) });
    }
  }
  if (!efforts.length && item?.reasoning === true) {
    for (const id of ["low", "medium", "high", "xhigh", "max"]) efforts.push({ id, name: effortLabel(id) });
  }
  if (!efforts.length) return void 0;
  const defaultValue = item.default_reasoning_level ?? item.thinking?.defaultLevel;
  const defaultEffort = defaultValue && (seen.has(String(defaultValue)) || efforts.some((effort) => effort.id === String(defaultValue))) ? String(defaultValue) : item.reasoning === true ? efforts.at(-1)?.id : void 0;
  return { efforts, ...defaultEffort ? { defaultEffort } : {} };
}
function slug(value, fallback = "agent") {
  const output = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42);
  return output || fallback;
}
function safeEnvironment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) continue;
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") continue;
    const stringValue = String(item);
    if (stringValue.length > 4096) continue;
    output[key] = stringValue;
  }
  return Object.keys(output).length ? output : void 0;
}
function configuredTransport(command, args) {
  const text = [command, ...args ?? []].join(" ").toLowerCase();
  const executable = text.split(/\s+/)[0].split("/").at(-1);
  if (executable === "codex") return "codex";
  if (executable === "claude") return "claude";
  if (executable === "zcode") return "zcode";
  if (executable === "omp" || executable === "pi") return (args ?? []).some((arg) => String(arg).toLowerCase() === "acp") ? "acp" : "rpc";
  if (text.includes("zcode")) return "zcode";
  if (text.includes("--mode rpc") || text.includes(" mode rpc")) return "rpc";
  if (text.includes(" acp") || text.endsWith("acp")) return "acp";
  return "acp";
}
function entryPairs(value) {
  if (Array.isArray(value)) return value.map((item, index) => [String(item?.name ?? index), item]);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value);
}
async function discoverConfiguredAgents(userHome) {
  const sources = [
    {
      path: join2(userHome, ".config", "zed", "settings.json"),
      kind: "zed",
      field: "agent_servers",
      prefix: "zed",
      label: "Zed configured ACP"
    },
    {
      path: join2(userHome, ".acpx", "config.json"),
      kind: "acpx",
      field: "agents",
      prefix: "acpx",
      label: "ACPX configured ACP"
    }
  ];
  const definitions = [];
  const warnings = [];
  const used = /* @__PURE__ */ new Set();
  for (const source of sources) {
    const config = await parseConfig(source.path, "json");
    if (!config) continue;
    if (config.error) {
      warnings.push(`Could not parse ${source.path}: ${config.error.message}`);
      continue;
    }
    for (const [name2, raw] of entryPairs(config.parsed?.[source.field])) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const command = typeof raw.command === "string" ? raw.command.trim() : "";
      if (!command) continue;
      const args = Array.isArray(raw.args) ? raw.args.filter((item) => typeof item === "string").map(String) : [];
      const baseId = `${source.prefix}-${slug(name2)}`;
      let id = baseId;
      let suffix = 2;
      while (used.has(id)) id = `${baseId}-${suffix++}`;
      used.add(id);
      const transport = ["codex", "claude", "acp", "rpc", "zcode", "jsonl", "mock"].includes(raw.transport) ? raw.transport : configuredTransport(command, args);
      const harness = String(raw.harness ?? `${source.kind}:${name2}`);
      const models = [];
      collectModelEntries(raw, models, { harness });
      definitions.push({
        id,
        label: `${name2} \xB7 ${source.label}`,
        harness,
        transport,
        command,
        args,
        env: safeEnvironment(raw.env),
        models,
        configPath: source.path,
        configKind: source.kind,
        experimental: transport === "zcode",
        notes: `Read-only adapter generated from ${source.path}; credentials stay in the native configuration.`
      });
    }
  }
  return { definitions, warnings };
}
function addModel(models, item) {
  if (!item) return;
  if (typeof item === "object" && ["hide", "hidden"].includes(String(item.visibility ?? "").toLowerCase())) return;
  const rawId = typeof item === "string" ? item : item.id ?? item.model ?? item.slug ?? item.name;
  if (!rawId || typeof rawId !== "string") return;
  const inferredProvider = item?.provider ?? (rawId.includes("/") ? rawId.slice(0, rawId.indexOf("/")) : void 0);
  const id = inferredProvider && !rawId.startsWith(`${inferredProvider}/`) && !rawId.includes("/") ? `${inferredProvider}/${rawId}` : rawId;
  const key = `${item.harness ?? ""}:${id}`;
  const existing = models.find((model) => `${model.harness ?? ""}:${model.id}` === key);
  const reasoning = typeof item === "object" ? item.reasoning && typeof item.reasoning === "object" ? item.reasoning : reasoningMetadata(item) : void 0;
  const contextWindow = typeof item === "object" && Number.isSafeInteger(item.contextWindow) && item.contextWindow > 0 ? item.contextWindow : typeof item === "object" && Number.isSafeInteger(item.context_window) && item.context_window > 0 ? item.context_window : void 0;
  if (existing) {
    if (typeof item === "object" && (item.display_name || item.name || item.label)) existing.label = item.display_name ?? item.name ?? item.label;
    if (reasoning && !existing.reasoning) existing.reasoning = reasoning;
    if (contextWindow && !existing.contextWindow) existing.contextWindow = contextWindow;
    if (typeof item === "object" && item.default === true) existing.default = true;
    return;
  }
  models.push({
    id,
    label: typeof item === "object" ? item.display_name ?? item.name ?? item.label ?? id : id,
    provider: inferredProvider,
    harness: item.harness,
    role: item.role,
    default: Boolean(item.default),
    source: item.source,
    credential: "native",
    ...reasoning ? { reasoning } : {},
    ...contextWindow ? { contextWindow } : {}
  });
}
function collectModelEntries(value, models, context = {}) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectModelEntries(item, models, context);
    return;
  }
  if (value.id || value.model || value.slug) addModel(models, { ...value, ...context });
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) continue;
    const providerFromMap = context.inProviders && !["models", "modelRoles", "enabledModels"].includes(key) ? key : void 0;
    const nextContext = {
      ...context,
      provider: context.provider ?? providerFromMap ?? (key === "provider" && typeof item === "string" ? item : void 0),
      inProviders: context.inProviders || key === "providers"
    };
    if (key === "models" || key === "modelRoles" || key === "providers" || context.inModels) nextContext.inModels = true;
    if (key === "default" || key === "default_model" || key === "model") {
      if (typeof item === "string") addModel(models, { id: item, ...context, default: true });
    }
    collectModelEntries(item, models, nextContext);
  }
}
function publicModel(model) {
  return {
    id: model.id,
    label: model.label,
    provider: model.provider,
    default: model.default,
    ...model.reasoning ? { reasoning: model.reasoning } : {},
    ...model.contextWindow ? { contextWindow: model.contextWindow } : {}
  };
}
function configModels(parsed, kind, context = {}) {
  const models = [];
  if (kind === "codex-models") {
    for (const item of Array.isArray(parsed?.models) ? parsed.models : []) addModel(models, { ...item, ...context });
  } else if (kind === "omp-config") {
    for (const item of Array.isArray(parsed?.enabledModels) ? parsed.enabledModels : []) addModel(models, { id: item, ...context });
  } else if (kind === "omp-models") {
    for (const [provider, value] of Object.entries(parsed?.providers ?? {})) {
      for (const item of Array.isArray(value?.models) ? value.models : []) addModel(models, { ...item, provider, ...context });
    }
  } else collectModelEntries(parsed, models, context);
  return models;
}
function configSummary(path, kind, parsed) {
  const models = configModels(parsed, kind);
  const defaults = unique([
    parsed?.model,
    parsed?.default_model,
    parsed?.modelRoles?.default,
    parsed?.model_roles?.default
  ]);
  return {
    path,
    kind,
    readable: true,
    defaults,
    modelCount: models.length
  };
}
function discoveryHealth({ found, transport, configFiles, models }) {
  const invalid = configFiles.filter((item) => item.readable === false && item.message);
  const hasConfig = configFiles.some((item) => item.readable !== false);
  const state = !found ? "missing-binary" : invalid.length ? "invalid-config" : "detected";
  const reasons = [];
  if (!found) reasons.push("\u672C\u673A\u672A\u627E\u5230\u53EF\u6267\u884C\u6587\u4EF6");
  if (invalid.length) reasons.push("\u81F3\u5C11\u4E00\u4E2A\u672C\u673A\u914D\u7F6E\u65E0\u6CD5\u89E3\u6790");
  if (!models.length && found) reasons.push("\u672A\u8BFB\u5230\u6A21\u578B\u76EE\u5F55\uFF0C\u5C06\u4F7F\u7528 harness \u539F\u751F\u9ED8\u8BA4\u6A21\u578B");
  return {
    state,
    installed: Boolean(found),
    configured: hasConfig,
    authenticated: "unknown",
    modelSelectable: models.length > 0,
    resumable: transport !== "zcode",
    streaming: true,
    toolEvents: !["zcode"].includes(transport),
    permissionMode: "deny-by-default",
    automaticRecovery: true,
    reasons
  };
}
async function parseConfig(path, kind) {
  const text = await readText(path);
  if (!text) return void 0;
  try {
    const parsed = kind === "json" || kind === "codex-models" ? JSON.parse(text) : kind === "jsonc" ? parseJsonc(text) : kind === "toml" ? parseTomlLite(text) : parseYamlLite(text);
    return { parsed, summary: configSummary(path, kind, parsed) };
  } catch (error) {
    return { error: { path, message: error.message } };
  }
}
function modelProfiles(base, models, options) {
  const output = [{ ...base }];
  const max = Math.max(0, Number(options.maxModelsPerHarness ?? 48));
  for (const model of models.slice(0, max)) {
    const modelSlug = slug(model.id, "model");
    output.push({
      ...base,
      id: `${base.id}--${modelSlug}`,
      label: `${base.label} \xB7 ${model.label ?? model.id}`,
      model: model.id,
      ...model.provider ? { modelProvider: model.provider } : {},
      discovery: { ...base.discovery, modelSource: model.source }
    });
  }
  return output;
}
async function descriptor(options, definition) {
  const command = definition.command ?? definition.id;
  const found = commandPath(command) ?? await (async () => {
    for (const candidate of definition.candidates ?? []) if (await readable(candidate)) return candidate;
    return void 0;
  })();
  const configFiles = [];
  const parsedConfigs = [];
  for (const config of definition.configs ?? []) {
    const parsed = await parseConfig(config.path, config.kind);
    if (!parsed) continue;
    if (parsed.error) configFiles.push({ ...parsed.error, readable: false });
    else {
      configFiles.push(parsed.summary);
      parsedConfigs.push({ kind: config.kind, parsed: parsed.parsed });
    }
  }
  const models = [];
  for (const config of parsedConfigs) {
    for (const model of configModels(config.parsed, config.kind, { harness: definition.harness })) addModel(models, model);
  }
  if (found && definition.catalogArgs?.length) {
    const catalog = commandJson(found, definition.catalogArgs, options.cwd);
    for (const model of Array.isArray(catalog?.models) ? catalog.models : []) {
      addModel(models, {
        ...model,
        id: model.selector ?? model.id,
        label: model.name ?? model.label ?? model.id,
        source: definition.catalogSource ?? `${definition.command} ${definition.catalogArgs.join(" ")}`,
        harness: definition.harness
      });
    }
  }
  const base = {
    id: definition.id,
    label: definition.label,
    harness: definition.harness,
    transport: definition.transport,
    command: found ?? command,
    args: [...definition.args],
    permissionPolicy: "reject",
    persistent: true,
    ...definition.extra ?? {},
    discovery: {
      detected: Boolean(found),
      commandPath: found,
      configFiles: configFiles.map((item) => ({ ...item, readable: item.readable !== false })),
      models: models.map(publicModel),
      configSource: "native-read-only",
      health: discoveryHealth({ found, transport: definition.transport, configFiles, models })
    }
  };
  return {
    harness: {
      id: definition.id,
      label: definition.label,
      harness: definition.harness,
      transport: definition.transport,
      args: [...definition.args],
      detected: Boolean(found),
      command: found ?? command,
      commandPath: found,
      configFiles,
      modelCount: models.length,
      models: models.map((model) => ({ ...publicModel(model), source: model.source ?? configFiles.find((file) => file.readable)?.path })),
      health: discoveryHealth({ found, transport: definition.transport, configFiles, models }),
      notes: definition.notes
    },
    profiles: modelProfiles(base, models, options)
  };
}
function configuredDescriptor(definition, options) {
  const found = commandPath(definition.command);
  const models = definition.models ?? [];
  const configFile = {
    path: definition.configPath,
    kind: "json",
    readable: true
  };
  const base = {
    id: definition.id,
    label: definition.label,
    harness: definition.harness,
    transport: definition.transport,
    command: found ?? definition.command,
    args: [...definition.args],
    env: definition.env,
    permissionPolicy: "reject",
    persistent: true,
    experimental: definition.experimental,
    discovery: {
      detected: Boolean(found),
      commandPath: found,
      configFiles: [configFile],
      models: models.map(publicModel),
      configSource: definition.configKind,
      configured: true,
      health: discoveryHealth({ found, transport: definition.transport, configFiles: [configFile], models })
    }
  };
  return {
    harness: {
      id: definition.id,
      label: definition.label,
      harness: definition.harness,
      transport: definition.transport,
      args: [...definition.args],
      detected: Boolean(found),
      command: found ?? definition.command,
      commandPath: found,
      configFiles: [configFile],
      modelCount: models.length,
      models: models.map((model) => ({ ...publicModel(model), source: model.source ?? definition.configPath })),
      health: discoveryHealth({ found, transport: definition.transport, configFiles: [configFile], models }),
      notes: definition.notes
    },
    profiles: modelProfiles(base, models, options)
  };
}
async function discoverLocalHarnesses(options = {}) {
  const userHome = options.userHome ?? homedir2();
  const codexRoot = options.codexHome ?? process.env.CODEX_HOME ?? join2(userHome, ".codex");
  const ompRoots = unique([
    process.env.PI_CODING_AGENT_DIR,
    join2(userHome, ".omp", "agent"),
    join2(userHome, ".oh-omp", "agent")
  ]);
  const definitions = [
    {
      id: "codex-local",
      label: "Codex \xB7 local app-server",
      harness: "codex",
      transport: "codex",
      command: "codex",
      args: ["app-server", "--stdio"],
      configs: [
        { path: join2(codexRoot, "config.toml"), kind: "toml" },
        { path: join2(codexRoot, "models_cache.json"), kind: "codex-models" }
      ],
      notes: "Uses native CODEX_HOME/config.toml, models_cache.json, and app-server thread persistence; preflights account/model availability without a turn.",
      extra: { preflight: true, preflightTimeoutMs: 5e3 }
    },
    {
      id: "claude-local",
      label: "Claude Code \xB7 local stream",
      harness: "claude-code",
      transport: "claude",
      command: "claude",
      args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
      configs: [
        { path: join2(userHome, ".claude", "settings.json"), kind: "json" },
        { path: join2(userHome, ".claude.json"), kind: "json" }
      ],
      notes: "Uses native Claude settings, OAuth/API environment, and --resume session storage."
    },
    {
      id: "opencode-local",
      label: "OpenCode \xB7 ACP",
      harness: "opencode",
      transport: "acp",
      command: "opencode",
      args: ["acp"],
      configs: [
        { path: join2(userHome, ".config", "opencode", "opencode.json"), kind: "json" },
        { path: join2(userHome, ".config", "opencode", "opencode.jsonc"), kind: "jsonc" }
      ],
      notes: "Uses OpenCode ACP over nd-JSON, native opencode.json model/provider configuration, and native auth storage. Credentials are never projected.",
      extra: { modelConfigMethod: "session/set_config_option", modelConfigId: "model" }
    },
    {
      id: "kimi-acp",
      label: "Kimi Code \xB7 ACP",
      harness: "kimi",
      transport: "acp",
      command: "kimi",
      args: ["acp"],
      configs: [{ path: join2(process.env.KIMI_CODE_HOME ?? join2(userHome, ".kimi-code"), "config.toml"), kind: "toml" }],
      notes: "Uses KIMI_CODE_HOME/config.toml, native providers/models, and ACP session/load.",
      extra: { modelConfigMethod: "session/set_config_option", modelConfigId: "model" }
    },
    {
      id: "omp-rpc",
      label: "OMP \xB7 ACP",
      harness: "omp",
      transport: "acp",
      command: "omp",
      args: ["acp"],
      catalogArgs: ["models", "--json"],
      catalogSource: "omp models --json",
      configs: ompRoots.flatMap((root) => [
        { path: join2(root, "config.yml"), kind: "omp-config" },
        { path: join2(root, "models.yml"), kind: "omp-models" },
        { path: join2(root, "models.json"), kind: "json" }
      ]),
      notes: "Uses OMP ACP over stdio and native config.yml/models.yml; session/new returns a resumable ACP session and model selection uses session/set_config_option.",
      extra: { modelConfigMethod: "session/set_config_option", modelConfigId: "model", promptTimeoutMs: 10 * 6e4 }
    },
    {
      id: "pi-rpc",
      label: "Pi \xB7 RPC",
      harness: "pi",
      transport: "rpc",
      command: "pi",
      args: ["--mode", "rpc"],
      configs: [
        { path: join2(process.env.PI_CODING_AGENT_DIR ?? join2(userHome, ".pi", "agent"), "settings.json"), kind: "json" },
        { path: join2(process.env.PI_CODING_AGENT_DIR ?? join2(userHome, ".pi", "agent"), "models.json"), kind: "json" }
      ],
      notes: "Uses native Pi RPC, PI_CODING_AGENT_DIR, model registry, and session files; waits for protocol readiness and agent_end completion.",
      extra: { readyRequired: true, readyTimeoutMs: 3e3, negotiateProtocol: true, protocolVersion: 2, rpcSessionControl: true, modelInArgs: false, modelMethod: "set_model", promptCompletesOnResponse: false }
    },
    {
      id: "zcode-local",
      label: "ZCode \xB7 app-server",
      harness: "zcode",
      transport: "zcode",
      command: "zcode",
      args: ["app-server", "--stdio"],
      candidates: [
        "/Applications/ZCode.app/Contents/Resources/bin/zcode",
        "/Applications/ZCode.app/Contents/Resources/zcode",
        join2(userHome, "Applications", "ZCode.app", "Contents", "Resources", "bin", "zcode")
      ],
      configs: [{ path: join2(userHome, ".zcode", "settings.json"), kind: "json" }],
      notes: "Uses ZCode\u2019s custom stdio JSON protocol, not ACP; shown as experimental.",
      extra: { experimental: true }
    }
  ];
  const resolved = await Promise.all(definitions.map((definition) => descriptor(options, definition)));
  const configured = await discoverConfiguredAgents(userHome);
  const configuredResolved = configured.definitions.map((definition) => configuredDescriptor(definition, options));
  const allResolved = [...resolved, ...configuredResolved];
  const harnesses = allResolved.map((item) => item.harness);
  const profiles = allResolved.flatMap((item) => item.profiles);
  const models = harnesses.flatMap((harness) => harness.models);
  return {
    generatedAt: Date.now(),
    platform: process.platform,
    cwd: options.cwd,
    credentialPolicy: "native-only",
    harnesses,
    profiles,
    models,
    warnings: [
      "Discovery reads model names and non-secret settings only; credentials remain in native harness stores/environment.",
      ...harnesses.filter((item) => item.harness === "zcode" && item.detected).map(() => "ZCode uses a custom protocol and is marked experimental until its method schema is stable."),
      ...configured.warnings
    ]
  };
}
function publicDiscovery(report) {
  const safe = report && typeof report === "object" ? {
    ...report,
    profiles: report.profiles?.map(({ env: _env, ...profile }) => profile)
  } : report;
  return redact(safe, { maxBytes: 512 * 1024, maxDepth: 12 });
}

// src/doctor.js
import { spawnSync as spawnSync2 } from "node:child_process";
function commandResult(command, args, timeoutMs = 3e3) {
  const result = spawnSync2(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 128 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    timedOut: result.error?.code === "ETIMEDOUT",
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message
  };
}
function issue(code, message, details = void 0) {
  return { code, message, ...details ? { details } : {} };
}
function staticCheck(harness) {
  const health = harness.health ?? {};
  const checks = [{ name: "binary", state: harness.detected ? "ok" : "missing", path: harness.commandPath }];
  const issues = [];
  if (!harness.detected) issues.push(issue("BINARY_NOT_FOUND", "\u672C\u673A\u6CA1\u6709\u627E\u5230\u6B64 harness \u7684\u53EF\u6267\u884C\u6587\u4EF6\u3002"));
  for (const file of harness.configFiles ?? []) {
    checks.push({ name: `config:${file.kind}`, state: file.readable === false ? "invalid" : "ok", path: file.path });
    if (file.readable === false) issues.push(issue("CONFIG_INVALID", `\u914D\u7F6E\u65E0\u6CD5\u8BFB\u53D6\u6216\u89E3\u6790\uFF1A${file.path}`, { message: file.message }));
  }
  return { checks, issues, health };
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function probeClaude(harness) {
  if (!harness.detected) return { checks: [], issues: [] };
  const result = commandResult(harness.commandPath, ["auth", "status", "--json"]);
  const value = parseJson(result.stdout);
  const authenticated = typeof value?.loggedIn === "boolean" ? value.loggedIn : void 0;
  const checks = [{ name: "auth-status", state: authenticated === false ? "missing" : authenticated === true ? "ok" : result.ok ? "ok" : "unknown" }];
  const issues = [];
  if (authenticated === false) issues.push(issue("AUTH_MISSING", "Claude Code \u672C\u673A\u6CA1\u6709\u53EF\u7528\u767B\u5F55\u72B6\u6001\uFF1BAgent Mesh \u4E0D\u4F1A\u590D\u5236\u6216\u7D22\u8981\u51ED\u636E\u3002"));
  if (authenticated === void 0 && !result.ok && !result.timedOut) issues.push(issue("AUTH_STATUS_UNKNOWN", "Claude Code auth status \u65E0\u6CD5\u786E\u8BA4\uFF0C\u9996\u6B21\u8BF7\u6C42\u4F1A\u4FDD\u7559\u539F\u751F\u9519\u8BEF\u3002"));
  return { checks, issues, authenticated: authenticated === void 0 ? "unknown" : authenticated ? "ready" : "missing" };
}
async function probeAcp(harness, options = {}) {
  if (!harness.detected) return { checks: [], issues: [] };
  let rpc;
  const checks = [];
  const issues = [];
  try {
    rpc = new JsonRpcProcess({ command: harness.commandPath, args: harness.args?.length ? harness.args : ["acp"], cwd: options.cwd ?? process.cwd(), timeoutMs: options.timeoutMs ?? 5e3, maxLineBytes: 8 * 1024 * 1024, protocol: "jsonrpc" });
    const initialized = await rpc.start().then(() => rpc.request("initialize", { protocolVersion: 1, clientInfo: { name: "dsh-agent-mesh-doctor", version: "0.1.0" }, clientCapabilities: {} }, options.timeoutMs ?? 5e3));
    await rpc.notify("initialized", {});
    checks.push({ name: "acp-handshake", state: "ok", protocolVersion: initialized?.protocolVersion });
  } catch (error) {
    issues.push(issue("ACP_UNAVAILABLE", "ACP server \u65E0\u6CD5\u5B8C\u6210\u65E0\u6A21\u578B\u8C03\u7528\u7684\u63E1\u624B\u3002", { message: error.message }));
  } finally {
    await rpc?.close().catch(() => void 0);
  }
  return { checks, issues };
}
function probeKimi(harness) {
  const config = (harness.configFiles ?? []).find((item) => item.readable && item.path);
  if (!harness.detected || !config) return { checks: [], issues: [] };
  const result = commandResult(harness.commandPath, ["doctor", "config", config.path]);
  return {
    checks: [{ name: "native-config-validator", state: result.ok ? "ok" : "invalid" }],
    issues: result.ok ? [] : [issue("CONFIG_INVALID", "Kimi Code \u539F\u751F doctor \u5224\u5B9A\u914D\u7F6E\u65E0\u6548\u3002", { output: redact(result.stderr || result.stdout, { maxBytes: 2048 }) })]
  };
}
function probeOpenCode(harness) {
  if (!harness.detected) return { checks: [], issues: [] };
  const result = commandResult(harness.commandPath, ["auth", "list"]);
  return {
    checks: [{ name: "native-auth-store", state: result.ok ? "ok" : "unknown" }],
    issues: result.ok ? [] : [issue("AUTH_STATUS_UNKNOWN", "OpenCode auth list \u65E0\u6CD5\u786E\u8BA4\u672C\u673A provider \u72B6\u6001\uFF1B\u9996\u6B21 ACP \u8BF7\u6C42\u4F1A\u4FDD\u7559\u539F\u751F\u9519\u8BEF\u3002")]
  };
}
async function probeCodex(harness, options = {}) {
  if (!harness.detected) return { checks: [], issues: [] };
  let rpc;
  const checks = [];
  const issues = [];
  try {
    rpc = new JsonRpcProcess({
      command: harness.commandPath,
      args: ["app-server", "--stdio"],
      cwd: options.cwd ?? process.cwd(),
      timeoutMs: options.timeoutMs ?? 4e3,
      maxLineBytes: 2 * 1024 * 1024,
      protocol: "codex"
    });
    await rpc.start();
    await rpc.request("initialize", {
      clientInfo: { name: "dsh-agent-mesh-doctor", version: "0.1.0" },
      capabilities: {}
    }, options.timeoutMs ?? 4e3);
    await rpc.notify("initialized", {});
    checks.push({ name: "app-server-handshake", state: "ok" });
    const account = await rpc.request("account/read", { refreshToken: false }, options.timeoutMs ?? 4e3).catch((error) => ({ error }));
    if (account?.error) {
      checks.push({ name: "account-read", state: "unknown" });
    } else {
      const accountValue = account?.account ?? account?.value ?? account;
      const authenticated = accountValue !== null && accountValue !== void 0;
      checks.push({ name: "account-read", state: authenticated ? "ok" : "missing" });
      if (!authenticated) issues.push(issue("AUTH_MISSING", "Codex app-server \u6CA1\u6709\u62A5\u544A\u53EF\u7528\u8D26\u53F7\u3002"));
    }
    const models = await rpc.request("model/list", { includeHidden: false }, options.timeoutMs ?? 4e3).catch((error) => ({ error }));
    checks.push({ name: "model-list", state: models?.error ? "unknown" : "ok", count: Array.isArray(models?.data) ? models.data.length : Array.isArray(models?.models) ? models.models.length : void 0 });
  } catch (error) {
    issues.push(issue("APP_SERVER_UNAVAILABLE", "Codex app-server \u65E0\u6CD5\u5B8C\u6210\u65E0\u6A21\u578B\u8C03\u7528\u7684\u63E1\u624B\u3002", { message: error.message }));
  } finally {
    await rpc?.close().catch(() => void 0);
  }
  return { checks, issues };
}
async function diagnose(report, options = {}) {
  const results = [];
  for (const harness of report?.harnesses ?? []) {
    const base = staticCheck(harness);
    let probe = {};
    if (harness.harness === "codex") probe = await probeCodex(harness, options);
    else if (harness.harness === "claude-code") probe = probeClaude(harness);
    else if (harness.harness === "kimi") {
      probe = probeKimi(harness);
      const acp = await probeAcp(harness, options);
      probe = { checks: [...probe.checks ?? [], ...acp.checks ?? []], issues: [...probe.issues ?? [], ...acp.issues ?? []] };
    } else if (harness.harness === "opencode") {
      const auth = probeOpenCode(harness);
      const acp = await probeAcp(harness, options);
      probe = { checks: [...auth.checks ?? [], ...acp.checks ?? []], issues: [...auth.issues ?? [], ...acp.issues ?? []] };
    } else if (harness.transport === "acp") probe = await probeAcp(harness, options);
    else if (harness.transport === "rpc") probe = { checks: [{ name: "rpc-transport", state: harness.detected ? "deferred" : "missing" }], issues: [] };
    else if (harness.harness === "zcode") probe = { checks: [{ name: "custom-protocol", state: harness.detected ? "experimental" : "missing" }], issues: [] };
    results.push({
      id: harness.id,
      harness: harness.harness,
      transport: harness.transport,
      detected: harness.detected,
      checks: [...base.checks, ...probe.checks ?? []],
      issues: [...base.issues, ...probe.issues ?? []],
      health: {
        ...base.health,
        ...probe.authenticated ? { authenticated: probe.authenticated } : {}
      }
    });
  }
  return {
    generatedAt: Date.now(),
    cwd: options.cwd,
    credentialPolicy: "native-only",
    harnesses: results,
    summary: {
      detected: results.filter((item) => item.detected).length,
      ready: results.filter((item) => item.detected && item.issues.length === 0).length,
      issues: results.reduce((count, item) => count + item.issues.length, 0)
    }
  };
}

// src/router.js
import { randomUUID as randomUUID6 } from "node:crypto";
var ROUTER_VERSION = "mesh-auto-v1";
var MAX_CONTEXT_CHARS = 24e3;
var MAX_CANDIDATES = 64;
function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}
function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}
function truncate(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `\u2026${text.slice(-max)}` : text;
}
function slug2(value, fallback = "route") {
  const output = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42);
  return output || fallback;
}
function hash(value) {
  let output = 2166136261;
  for (const char of String(value)) {
    output ^= char.codePointAt(0);
    output = Math.imul(output, 16777619);
  }
  return (output >>> 0).toString(16).padStart(8, "0");
}
function profileModel(profile) {
  return String(profile?.model ?? "native-default");
}
function profileKey(profile) {
  return `${profile?.harness ?? "harness"}:${profileModel(profile)}`;
}
function sessionKey(sessionId, profile, role) {
  const raw = String(sessionId || randomUUID6());
  const readable2 = raw.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 48) || "session";
  return `mesh-${readable2}-${slug2(profile?.harness)}-${slug2(profileModel(profile))}-${role}-${hash(`${raw}:${profileKey(profile)}:${role}`)}`.slice(0, 127);
}
function messageText(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.type === "text" || part?.type === "reasoning") return String(part.text ?? "");
    return "";
  }).join("");
}
function historyFrom(messages, current) {
  const rows = [];
  for (const message of messages ?? []) {
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    const text = messageText(message).trim();
    if (!text || text === current) continue;
    rows.push(`${message.role === "assistant" ? "\u52A9\u624B" : "\u7528\u6237"}\uFF1A${text}`);
  }
  return truncate(rows.join("\n\n"), MAX_CONTEXT_CHARS);
}
function promptOf(input = {}) {
  if (typeof input.prompt === "string" && input.prompt.trim()) return input.prompt.trim();
  if (typeof input.text === "string" && input.text.trim()) return input.text.trim();
  for (let index = (input.messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const text = messageText(input.messages[index]).trim();
    if (input.messages[index]?.role === "user" && text) return text;
  }
  throw new MeshError("PROMPT_REQUIRED", "Routing requires a text prompt.");
}
function modelMeta(profile) {
  return profile?.discovery?.models?.find((item) => item.id === profile.model) ?? {};
}
function usable(profile) {
  const health = profile?.discovery?.health;
  if (profile?.available === false || profile?.routeable === false || profile?.nativeHost === true) return false;
  if (profile?.discovery?.detected === false) return false;
  if (health?.state === "missing-binary" || health?.state === "invalid-config") return false;
  if (health?.authenticated === "missing") return false;
  return true;
}
function classify(prompt, input = {}) {
  const text = prompt.toLowerCase();
  const chars = prompt.length + Number(input.contextLength ?? 0);
  const explicitEnsemble = /多模型|多智能体|聚合|集成|ensemble|panel|debate|second opinion|交叉验证|对比方案|独立审查|独立核查|review from another/i.test(prompt);
  const coding = /代码|编程|bug|报错|重构|实现|函数|接口|api|typescript|javascript|python|go\b|rust\b|test|测试|仓库|repo|代码库/i.test(text);
  const math = /数学|证明|方程|定理|概率|计算|公式|math|equation|theorem|proof/i.test(text);
  const chinese = /[\u4e00-\u9fff]/.test(prompt);
  const highRisk = /生产|上线|安全|权限|密钥|隐私|医疗|法律|金融|合规|production|security|privacy|medical|legal|financial/i.test(text);
  const longContext = chars > 12e3;
  const difficult = /深入|严谨|复杂|架构|根因|批判|比较|为什么|研究|深度|复杂|hard|architecture|root cause|research/i.test(text);
  const domain = coding ? "coding" : math ? "math" : longContext ? "long_context" : chinese ? "chinese" : "general";
  const risk = clamp(
    0.08 + (explicitEnsemble ? 0.34 : 0) + (highRisk ? 0.24 : 0) + (difficult ? 0.16 : 0) + (coding ? 0.08 : 0) + (math ? 0.08 : 0) + (longContext ? 0.18 : 0)
  );
  return {
    domain,
    chinese,
    coding,
    math,
    highRisk,
    longContext,
    explicitEnsemble,
    difficult,
    risk,
    inputChars: chars,
    estimatedInputTokens: Math.ceil(chars / 4)
  };
}
function scoreProfile(profile, classification, role = "producer") {
  const model = `${profile?.harness ?? ""} ${profileModel(profile)}`.toLowerCase();
  const meta = modelMeta(profile);
  let score = 0;
  if (/flash|mini|smol|fast|lite/.test(model)) score += role === "producer" ? 3 : 1;
  if (/deepseek|glm|gpt|claude|codex|kimi|mimo|hy3/.test(model)) score += 1;
  if (/pro|opus|terra|max/.test(model)) score -= role === "producer" ? 0.6 : -0.2;
  if (profile?.experimental) score -= 2;
  if (classification.coding && /codex|claude|mimo|glm|gpt|deepseek|code/.test(model)) score += 2;
  if (classification.math && /hy3|glm|deepseek|gpt|kimi/.test(model)) score += 2;
  if (classification.chinese && /hy3|kimi|deepseek|glm/.test(model)) score += 1.5;
  if (classification.longContext && /glm|deepseek|mimo|gpt|terra|luna/.test(model)) score += 2;
  if (classification.difficult && /glm|gpt|terra|luna|mimo|codex/.test(model)) score += 1.5;
  if (role === "specialist" && /flash|mini|smol/.test(model)) score -= 0.6;
  if (role === "judge" && /luna|terra|glm|gpt|codex/.test(model)) score += 3;
  if (meta.contextWindow && classification.estimatedInputTokens > meta.contextWindow) score -= 100;
  if (!profile?.model) score -= 1;
  return score;
}
function publicCandidate(profile, score, role) {
  const meta = modelMeta(profile);
  return {
    profileId: profile.id,
    harness: profile.harness,
    model: profile.model ?? "native-default",
    label: meta.label ?? profile.label ?? profile.model ?? profile.harness,
    role,
    score: Number(score.toFixed(3)),
    ...meta.contextWindow ? { contextWindow: meta.contextWindow } : {},
    ...meta.reasoning ? { reasoning: meta.reasoning } : {}
  };
}
function normalizeMode(value) {
  const mode = String(value ?? "auto").toLowerCase();
  if (["single", "auto", "panel", "aggregate"].includes(mode)) return mode;
  return "auto";
}
function winnerFrom(text) {
  const value = String(text ?? "").trim();
  const json = value.match(/\{[\s\S]*\}/)?.[0];
  if (json) {
    try {
      const parsed = JSON.parse(json);
      const winner = String(parsed.winner ?? parsed.choice ?? parsed.selected ?? "").toUpperCase();
      if (winner === "A" || winner === "B") return winner;
    } catch {
    }
  }
  const strict = value.match(/(?:winner|choice|selected)\s*[:：=-]?\s*([AB])\b/i);
  return strict ? strict[1].toUpperCase() : void 0;
}
function deterministicWinner(candidates, prompt) {
  if (candidates.length < 2) return 0;
  const wantsJson = /json|\b结构化\b|结构化输出|只返回对象/i.test(prompt);
  if (wantsJson) {
    const valid = candidates.map((candidate) => {
      try {
        JSON.parse(candidate.text);
        return true;
      } catch {
        return false;
      }
    });
    if (valid[0] !== valid[1]) return valid[0] ? 0 : 1;
  }
  const weak = /无法完成|做不到|不知道|作为 ai|as an ai|i can't|i cannot/i;
  const weakFlags = candidates.map((candidate) => weak.test(candidate.text));
  if (weakFlags[0] !== weakFlags[1]) return weakFlags[0] ? 1 : 0;
  return 0;
}
function controls(promise, signal, timeoutMs) {
  let timer;
  let abortHandler;
  const guarded = [promise];
  if (signal) {
    guarded.push(new Promise((_, reject) => {
      abortHandler = () => reject(new MeshError("ABORTED", "The routed DSH request was cancelled."));
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }));
  }
  if (timeoutMs > 0) guarded.push(new Promise((_, reject) => {
    timer = setTimeout(() => reject(new MeshError("ROUTE_TIMEOUT", "The model route exceeded its bounded deadline.")), timeoutMs);
  }));
  return Promise.race(guarded).finally(() => {
    if (timer) clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
  });
}
var MeshRouter = class {
  constructor(runtime, options = {}) {
    this.runtime = runtime;
    this.logger = options.logger;
    this.options = options;
  }
  candidates(input = {}) {
    const classification = input.classification ?? classify(String(input.prompt ?? ""), input);
    const profiles = this.runtime.listProfiles?.() ?? [];
    const usableProfiles = profiles.filter(usable);
    const modeled = usableProfiles.filter((profile) => profile.model);
    const source = modeled.length ? modeled : usableProfiles;
    const seen = /* @__PURE__ */ new Set();
    return source.filter((profile) => {
      const key = profileKey(profile);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, MAX_CANDIDATES).map((profile) => ({ profile, score: scoreProfile(profile, classification) }));
  }
  hasCandidates() {
    return this.candidates({ prompt: "route availability probe" }).length > 0;
  }
  plan(input = {}) {
    const prompt = promptOf(input);
    const mode = normalizeMode(input.mode ?? input.routeMode);
    const classification = classify(prompt, input);
    const available = this.candidates({ ...input, prompt, classification });
    if (!available.length) throw new MeshError("ROUTE_UNAVAILABLE", "No usable local harness/model route is available.");
    const maxCalls = boundedInteger(input.maxCalls ?? input.max_calls ?? (mode === "panel" ? 4 : 3), mode === "panel" ? 4 : 3, 1, 5);
    const maxBranches = Math.min(maxCalls, boundedInteger(input.maxBranches ?? input.max_branches ?? 2, 2, 1, 3));
    const ranked = available.sort((a, b) => b.score - a.score || profileKey(a.profile).localeCompare(profileKey(b.profile)));
    const primary = ranked[0];
    const branches = [{ ...primary, role: "producer" }];
    const shouldFanOut = mode !== "single" && (mode === "panel" || mode === "aggregate" || classification.explicitEnsemble || classification.risk >= 0.65);
    if (shouldFanOut && maxBranches > 1) {
      const specialists = [...ranked].filter((item) => profileKey(item.profile) !== profileKey(primary.profile) && profileModel(item.profile) !== profileModel(primary.profile)).map((item) => ({ ...item, score: scoreProfile(item.profile, classification, "specialist") })).sort((a, b) => b.score - a.score || profileKey(a.profile).localeCompare(profileKey(b.profile)));
      const branchModels2 = /* @__PURE__ */ new Set([profileModel(primary.profile)]);
      for (const specialist of specialists) {
        if (branches.length >= maxBranches || branchModels2.has(profileModel(specialist.profile))) continue;
        branches.push({ ...specialist, role: "specialist" });
        branchModels2.add(profileModel(specialist.profile));
      }
    }
    const branchModels = new Set(branches.map((item) => profileModel(item.profile)));
    const judgeCandidate = branches.length > 1 ? [...ranked].filter((item) => !branchModels.has(profileModel(item.profile))).map((item) => ({ ...item, score: scoreProfile(item.profile, classification, "judge") })).sort((a, b) => b.score - a.score || profileKey(a.profile).localeCompare(profileKey(b.profile)))[0] : void 0;
    const requestedPasses = input.positionSwap === true || mode === "panel" && input.strong === true ? 2 : 1;
    const judgePasses = judgeCandidate ? Math.min(requestedPasses, Math.max(0, maxCalls - branches.length)) : 0;
    const judge = judgePasses > 0 ? { ...judgeCandidate, role: "judge", passes: judgePasses } : void 0;
    return {
      version: ROUTER_VERSION,
      policyId: ROUTER_VERSION,
      mode,
      classification,
      budget: { maxCalls, maxBranches, estimatedCalls: branches.length + (judge?.passes ?? 0) },
      candidates: ranked.slice(0, 12).map((item) => publicCandidate(item.profile, item.score, "candidate")),
      branches: branches.map((item) => publicCandidate(item.profile, item.score, item.role)),
      judge: judge ? { ...publicCandidate(judge.profile, judge.score, judge.role), passes: judge.passes } : void 0,
      aggregation: judge ? { method: "blind-pairwise-selection", passes: judge.passes } : { method: "deterministic-selection", passes: 0 }
    };
  }
  async run(input = {}) {
    const prompt = promptOf(input);
    const plan = this.plan({ ...input, prompt });
    const sessionId = String(input.sessionId ?? `dsh-route-${randomUUID6()}`);
    const context = truncate(input.context ?? historyFrom(input.messages, prompt), MAX_CONTEXT_CHARS);
    const startedAt = Date.now();
    const callRecords = [];
    const profileById = new Map((this.runtime.listProfiles?.() ?? []).map((profile) => [profile.id, profile]));
    const branchPromises = plan.branches.map((branch) => this.#runAgent({ ...branch, profile: profileById.get(branch.profileId) }, sessionId, prompt, context, input, callRecords));
    const routeTimeoutMs = boundedInteger(input.routeTimeoutMs ?? 12e4, 12e4, 1e3, 10 * 6e4);
    const branchTimeoutMs = boundedInteger(input.branchTimeoutMs ?? 12e4, 12e4, 1e3, 10 * 6e4);
    const settled = await controls(Promise.allSettled(branchPromises), input.signal, routeTimeoutMs);
    const successful = settled.filter((item) => item.status === "fulfilled").map((item) => item.value);
    if (!successful.length) {
      const errors = settled.filter((item) => item.status === "rejected").map((item) => item.reason?.code ?? "ROUTE_BRANCH_FAILED");
      throw new MeshError("ROUTE_ALL_FAILED", "All selected local harness routes failed.", { errors });
    }
    let winner = deterministicWinner(successful, prompt);
    const warnings = [];
    if (successful.length > 1 && plan.judge) {
      const votes = [];
      for (let pass = 0; pass < plan.judge.passes; pass += 1) {
        const ordered = pass % 2 === 0 ? successful : [...successful].reverse();
        const judgment = await this.#runJudge({ ...plan.judge, profile: profileById.get(plan.judge.profileId) }, sessionId, prompt, ordered, context, { ...input, branchTimeoutMs }, callRecords).catch((error) => {
          warnings.push(`judge:${error.code ?? "failed"}`);
          return void 0;
        });
        const vote = winnerFrom(judgment?.text);
        if (vote) votes.push({ vote, reversed: pass % 2 === 1 });
      }
      const mappedVotes = votes.map(({ vote, reversed }) => reversed ? vote === "A" ? 1 : 0 : vote === "A" ? 0 : 1);
      if (mappedVotes.length && mappedVotes.every((candidate) => candidate === mappedVotes[0])) winner = mappedVotes[0];
      else if (mappedVotes.length > 1) warnings.push("judge:position-conflict");
    }
    const selected = successful[Math.min(winner, successful.length - 1)];
    const route = {
      ...plan,
      selected: publicCandidate(selected.profile, selected.score, selected.role),
      calls: callRecords,
      warnings,
      latencyMs: Date.now() - startedAt,
      budgetUsed: callRecords.length
    };
    const text = String(selected.result?.text ?? selected.result?.message ?? "").trim();
    if (!text) throw new MeshError("ROUTE_EMPTY_RESPONSE", "The selected local harness returned no assistant text.");
    this.runtime.emit?.("route-event", { kind: "route_completed", route: { ...route, candidates: void 0 } });
    return {
      text,
      usage: selected.result?.usage,
      nativeSessionId: selected.result?.nativeSessionId,
      route
    };
  }
  async #runAgent(branch, sessionId, prompt, context, input, records) {
    const profile = branch.profile;
    if (!profile) throw new MeshError("ROUTE_PROFILE_MISSING", `The selected local route disappeared: ${branch.profileId}.`);
    const id = sessionKey(sessionId, profile, branch.role);
    const startedAt = Date.now();
    try {
      if (this.runtime.hasAgent?.(id)) await this.runtime.ensureAgent?.(id, { reasoningEffort: input.reasoningEffort });
      else await this.runtime.start(profile.id, { sessionId: id, reasoningEffort: input.reasoningEffort });
      const roleInstruction = branch.role === "specialist" ? "\u72EC\u7ACB\u5B8C\u6210\u4EFB\u52A1\uFF0C\u91CD\u70B9\u5BFB\u627E\u4E3B\u7B54\u6848\u53EF\u80FD\u9057\u6F0F\u7684\u4E8B\u5B9E\u3001\u7EA6\u675F\u3001\u53CD\u4F8B\u6216\u5B9E\u73B0\u98CE\u9669\uFF1B\u4E0D\u8981\u5F15\u7528\u201C\u5176\u4ED6 agent\u201D\u3002" : "\u76F4\u63A5\u5B8C\u6210\u7528\u6237\u4EFB\u52A1\uFF0C\u7ED9\u51FA\u53EF\u6267\u884C\u3001\u5177\u4F53\u3001\u5B8C\u6574\u7684\u7B54\u6848\uFF1B\u4E0D\u8981\u8BA8\u8BBA\u8DEF\u7531\u8FC7\u7A0B\u3002";
      const branchPrompt = [
        `[Agent Mesh ${branch.role}]`,
        roleInstruction,
        context ? `[\u5DF2\u6709 DSH \u4E0A\u4E0B\u6587]
${context}` : void 0,
        `[\u5F53\u524D\u4EFB\u52A1]
${prompt}`
      ].filter(Boolean).join("\n\n");
      const result = await controls(
        this.runtime.send(id, branchPrompt, { source: "mesh-router", model: profile.model, reasoningEffort: input.reasoningEffort }),
        input.signal,
        boundedInteger(input.branchTimeoutMs ?? 12e4, 12e4, 1e3, 10 * 6e4)
      );
      records.push({ role: branch.role, profileId: profile.id, harness: profile.harness, model: profile.model, state: "ok", latencyMs: Date.now() - startedAt });
      return { profile, score: branch.score, role: branch.role, result };
    } catch (error) {
      records.push({ role: branch.role, profileId: profile.id, harness: profile.harness, model: profile.model, state: "error", errorCode: error?.code ?? "ROUTE_BRANCH_FAILED", latencyMs: Date.now() - startedAt });
      throw error;
    }
  }
  async #runJudge(judge, sessionId, prompt, candidates, context, input, records) {
    const profile = judge.profile;
    if (!profile) throw new MeshError("ROUTE_PROFILE_MISSING", `The selected evaluator route disappeared: ${judge.profileId}.`);
    const id = sessionKey(sessionId, profile, "judge");
    const options = candidates.map((candidate, index) => `Candidate ${String.fromCharCode(65 + index)}:
${truncate(candidate.result?.text, 32e3)}`).join("\n\n");
    const judgePrompt = [
      "[Agent Mesh blind evaluator]",
      '\u6BD4\u8F83\u4E24\u4E2A\u5019\u9009\u7B54\u6848\uFF0C\u53EA\u5224\u65AD\u662F\u5426\u66F4\u51C6\u786E\u3001\u5B8C\u6574\u3001\u7B26\u5408\u7528\u6237\u7EA6\u675F\u3002\u4E0D\u8981\u56E0\u4E3A\u7B54\u6848\u66F4\u957F\u800C\u504F\u597D\u5B83\uFF0C\u4E5F\u4E0D\u8981\u8F93\u51FA\u6539\u5199\u540E\u7684\u7B54\u6848\u3002\u53EA\u8FD4\u56DE JSON\uFF1A{"winner":"A"\u6216"B","reason":"\u4E00\u53E5\u8BDD"}\u3002',
      context ? `[\u5DF2\u6709\u4E0A\u4E0B\u6587]
${context}` : void 0,
      `[\u7528\u6237\u4EFB\u52A1]
${prompt}`,
      options
    ].filter(Boolean).join("\n\n");
    const startedAt = Date.now();
    try {
      if (this.runtime.hasAgent?.(id)) await this.runtime.ensureAgent?.(id, { reasoningEffort: input.reasoningEffort });
      else await this.runtime.start(profile.id, { sessionId: id, reasoningEffort: input.reasoningEffort });
      const result = await controls(
        this.runtime.send(id, judgePrompt, { source: "mesh-router-judge", model: profile.model, reasoningEffort: input.reasoningEffort }),
        input.signal,
        boundedInteger(input.judgeTimeoutMs ?? 9e4, 9e4, 1e3, 10 * 6e4)
      );
      records.push({ role: "judge", profileId: profile.id, harness: profile.harness, model: profile.model, state: "ok", latencyMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      records.push({ role: "judge", profileId: profile.id, harness: profile.harness, model: profile.model, state: "error", errorCode: error?.code ?? "ROUTE_JUDGE_FAILED", latencyMs: Date.now() - startedAt });
      throw error;
    }
  }
};

// src/runtime.js
function recoverableSessionError(error) {
  const code = String(error?.code ?? "").toUpperCase();
  const message = String(error?.message ?? "").toLowerCase();
  if (["SESSION_NOT_FOUND", "THREAD_NOT_FOUND", "NATIVE_SESSION_NOT_FOUND", "RESOURCE_NOT_FOUND", "UNKNOWN_SESSION"].includes(code)) return true;
  return /(session|thread).*(not found|unknown|does not exist|resource_not_found)|resource_not_found/.test(message);
}
function stateTemplate() {
  return {
    version: 1,
    sessions: {},
    messages: {},
    events: []
  };
}
function validSessionId(id) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id);
}
function statusFor(record, live) {
  if (!record) return "unknown";
  if (live) return record.status === "running" ? "running" : "connected";
  return record.status;
}
var MeshRuntime = class extends EventEmitter2 {
  constructor(options = {}) {
    super();
    this.options = options;
    this.logger = options.logger;
    this.router = new MeshRouter(this, { logger: this.logger });
    this.dsh = options.dsh;
    this.maxStoredEvents = Math.max(100, Number(options.maxStoredEvents ?? 2e3));
    this.store = new EventStore(options.homeDir, {
      snapshotEvery: options.snapshotEvery ?? 128,
      durability: options.durability ?? "batch"
    });
    this.profiles = new ProfileRegistry(options.profiles ?? [], { includeDefaults: options.includeDefaults ?? true });
    this.adapters = new Map([
      ["codex", new CodexAdapter({ logger: this.logger })],
      ["claude", new ClaudeAdapter({ logger: this.logger })],
      ["acp", new AcpAdapter({ logger: this.logger })],
      ["mock", new MockAdapter(options.mock ?? {})],
      ["rpc", new RpcAgentAdapter({ logger: this.logger })],
      ["zcode", new ZcodeAdapter({ logger: this.logger })],
      ...options.adapters ? Object.entries(options.adapters) : []
    ]);
    this.live = /* @__PURE__ */ new Map();
    this.sessionQueues = /* @__PURE__ */ new Map();
    this.state = void 0;
    this.bus = void 0;
    this.discovery = void 0;
    this.diagnostics = void 0;
    this.diagnosticsPromise = void 0;
    this.closed = false;
    this.ready = this.#open();
    this.ready.then(() => {
      if (this.options.autoDoctor === false || this.options.autoDiscover === false) return;
      queueMicrotask(() => this.doctor().catch((error) => this.logger?.debug?.({ error: error.message }, "background harness doctor skipped")));
    }).catch(() => void 0);
  }
  async #open() {
    if (this.options.autoDiscover !== false) {
      try {
        this.discovery = await discoverLocalHarnesses({ cwd: this.options.cwd ?? process.cwd(), ...this.options.discovery });
        for (const profile of this.discovery.profiles) this.profiles.set(profile);
      } catch (error) {
        this.logger?.warn?.({ error }, "local harness discovery failed");
      }
    }
    this.state = await this.store.open(stateTemplate(), (state, event2) => this.#applyEvent(state, event2));
    if (this.closed) {
      await this.store.close();
      return this;
    }
    this.bus = new MessageBus({
      state: this.state,
      append: (type, data) => this.#append(type, data),
      deliver: (message) => this.#deliverMessage(message),
      logger: this.logger,
      maxBytes: this.options.maxMessageBytes ?? 256 * 1024
    });
    this.bus.on("failed", (payload) => this.emit("message-failed", payload));
    this.bus.on("delivered", (payload) => this.emit("message-delivered", payload));
    queueMicrotask(() => this.bus?.retryPending());
    return this;
  }
  #applyEvent(state, event2) {
    const data = event2.data ?? {};
    switch (event2.type) {
      case "session/upsert":
        state.sessions[data.id] = { ...state.sessions[data.id] ?? {}, ...data };
        break;
      case "session/status":
      case "session/native":
        if (state.sessions[data.id]) state.sessions[data.id] = { ...state.sessions[data.id], ...data };
        break;
      case "message/created":
        state.messages[data.id] = data;
        break;
      case "message/status":
        if (state.messages[data.id]) state.messages[data.id] = { ...state.messages[data.id], ...data };
        break;
      case "event/append":
        state.events.push(data);
        if (state.events.length > this.maxStoredEvents) state.events.splice(0, state.events.length - this.maxStoredEvents);
        break;
      default:
        break;
    }
  }
  async #append(type, data) {
    const event2 = await this.store.append(type, data, (state, stored) => this.#applyEvent(state, stored));
    this.emit("event", event2);
    return event2;
  }
  registerAdapter(name2, adapter) {
    assertMesh(name2 && adapter && typeof adapter.open === "function", "INVALID_ADAPTER", "Adapter must expose open(profile, options).");
    this.adapters.set(String(name2), adapter);
    return this;
  }
  listProfiles() {
    return this.profiles.list();
  }
  routePlan(input = {}) {
    return this.router.plan(input);
  }
  async route(input = {}) {
    await this.ready;
    return this.router.run(input);
  }
  async discover(options = {}) {
    await this.ready;
    this.discovery = await discoverLocalHarnesses({ cwd: options.cwd ?? this.options.cwd ?? process.cwd(), ...options });
    for (const profile of this.discovery.profiles) this.profiles.set(profile);
    this.emit("discovery", this.discovery);
    return publicDiscovery(this.discovery);
  }
  async doctor(options = {}) {
    await this.ready;
    if (!this.discovery || options.refresh) await this.discover(options);
    const ttl = Math.max(1e3, Number(options.cacheTtlMs ?? 3e4));
    if (!options.refresh && this.diagnostics && this.diagnostics.expiresAt > Date.now()) return this.diagnostics.value;
    if (this.diagnosticsPromise) return this.diagnosticsPromise;
    this.diagnosticsPromise = diagnose(this.discovery, { cwd: options.cwd ?? this.options.cwd ?? process.cwd(), timeoutMs: options.timeoutMs }).then((value) => {
      this.diagnostics = { value, expiresAt: Date.now() + ttl };
      this.#applyDiagnostics(value);
      this.emit("diagnostics", value);
      return value;
    }).finally(() => {
      this.diagnosticsPromise = void 0;
    });
    return this.diagnosticsPromise;
  }
  #applyDiagnostics(value) {
    for (const result of value?.harnesses ?? []) {
      const harness = this.discovery?.harnesses?.find((item) => item.id === result.id);
      if (harness) harness.health = { ...harness.health ?? {}, ...result.health ?? {} };
      for (const profile of this.discovery?.profiles ?? []) {
        if (profile.id !== result.id && !profile.id.startsWith(`${result.id}--`)) continue;
        profile.discovery = { ...profile.discovery ?? {}, health: { ...profile.discovery?.health ?? {}, ...result.health ?? {} } };
        this.profiles.set(profile);
      }
    }
  }
  async createAgent(profileId, options = {}) {
    return this.start(profileId, options);
  }
  async start(profileId, options = {}) {
    await this.ready;
    if (this.closed) throw new MeshError("RUNTIME_CLOSED", "Agent Mesh is closed.");
    const profile = this.profiles.get(profileId);
    const sessionId = String(options.sessionId ?? randomUUID7());
    assertMesh(validSessionId(sessionId), "INVALID_SESSION_ID", "Session id contains unsupported characters.");
    const queue = this.#sessionQueue(sessionId);
    return queue.run(() => this.#startUnlocked(profile, sessionId, options));
  }
  async #startUnlocked(profile, sessionId, options = {}) {
    const existing = this.state.sessions[sessionId];
    if (this.live.has(sessionId)) return this.#publicSession(this.state.sessions[sessionId]);
    if (existing && existing.profileId !== profile.id) {
      throw new MeshError("SESSION_PROFILE_CONFLICT", `Session ${sessionId} belongs to profile ${existing.profileId}.`);
    }
    if (profile.transport === "dsh") {
      if (!this.dsh?.has?.(sessionId)) {
        throw new MeshError("DSH_AGENT_NOT_FOUND", `DSH host agent is not live: ${sessionId}.`, { sessionId });
      }
      return this.listAgents().find((agent) => agent.id === sessionId);
    }
    const cwd = resolvePath(options.cwd ?? existing?.cwd ?? profile.cwd ?? process.cwd());
    const adapter = this.adapters.get(profile.transport);
    if (!adapter) throw new MeshError("ADAPTER_NOT_FOUND", `No adapter for transport ${profile.transport}.`);
    const now = Date.now();
    await this.#append("session/upsert", {
      id: sessionId,
      profileId: profile.id,
      harness: profile.harness,
      model: profile.model,
      reasoningEffort: options.reasoningEffort ?? existing?.reasoningEffort,
      cwd,
      status: "starting",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      nativeSessionId: options.nativeSessionId !== void 0 ? options.nativeSessionId : existing?.nativeSessionId,
      handoffRequired: existing?.handoffRequired ?? false
    });
    try {
      const handle = await adapter.open(profile, {
        cwd,
        nativeSessionId: options.nativeSessionId !== void 0 ? options.nativeSessionId : existing?.nativeSessionId,
        reasoningEffort: options.reasoningEffort,
        onEvent: (event2) => this.#onAdapterEvent(sessionId, event2)
      });
      this.live.set(sessionId, handle);
      await this.#append("session/upsert", {
        id: sessionId,
        nativeSessionId: handle.nativeSessionId ?? existing?.nativeSessionId,
        capabilities: handle.capabilities,
        handoffRequired: handle.handoffRequired ?? existing?.handoffRequired ?? false,
        status: "idle",
        error: void 0,
        updatedAt: Date.now()
      });
      this.emit("session-started", this.#publicSession(this.state.sessions[sessionId]));
      return this.#publicSession(this.state.sessions[sessionId]);
    } catch (error) {
      const normalized = asHarnessError(error, "ADAPTER_START_ERROR");
      if (normalized.code === "MISSING_CREDENTIAL") this.#markProfileUnavailable(profile.id, normalized);
      await this.#append("session/status", { id: sessionId, status: "error", error: normalized.toJSON(), updatedAt: Date.now() });
      throw normalized;
    }
  }
  async #ensureLive(sessionId, options = {}) {
    const handle = this.live.get(sessionId);
    if (handle) return handle;
    const record = this.state.sessions[sessionId];
    if (!record) throw new MeshError("SESSION_NOT_FOUND", `Session not found: ${sessionId}.`, { sessionId });
    const profile = this.profiles.get(record.profileId);
    try {
      await this.#startUnlocked(profile, sessionId, { sessionId, cwd: record.cwd, nativeSessionId: record.nativeSessionId, reasoningEffort: options.reasoningEffort });
    } catch (error) {
      if (!record.nativeSessionId || !recoverableSessionError(error)) throw error;
      await this.#recoverNativeSession(sessionId, error);
      await this.#startUnlocked(profile, sessionId, { sessionId, cwd: record.cwd, nativeSessionId: null, reasoningEffort: options.reasoningEffort });
    }
    return this.live.get(sessionId);
  }
  async ensureAgent(sessionId, options = {}) {
    await this.ready;
    const id = String(sessionId);
    return this.#sessionQueue(id).run(async () => {
      await this.#ensureLive(id, options);
      return this.#publicSession(this.state.sessions[id]);
    });
  }
  async send(sessionId, text, options = {}) {
    await this.ready;
    assertMesh(typeof text === "string" && text.trim(), "PROMPT_REQUIRED", "Prompt text is required.");
    const id = String(sessionId);
    const queue = this.#sessionQueue(id);
    return queue.run(async () => {
      const handle = await this.#ensureLive(id, options);
      await this.#append("session/status", { id, status: "running", updatedAt: Date.now() });
      try {
        const result = await handle.prompt(text, options);
        const nativeSessionId = result?.nativeSessionId ?? handle.getNativeSessionId?.();
        if (nativeSessionId && nativeSessionId !== this.state.sessions[id]?.nativeSessionId) {
          await this.#append("session/native", { id, nativeSessionId, updatedAt: Date.now() });
        }
        await this.#append("event/append", {
          sessionId: id,
          kind: "assistant_final",
          text: truncateText(result?.text ?? "", 512 * 1024),
          ts: Date.now()
        });
        await this.#append("session/status", { id, status: "idle", handoffRequired: false, updatedAt: Date.now(), error: void 0 });
        this.emit("session-result", { sessionId: id, result });
        return result;
      } catch (error) {
        const normalized = asHarnessError(error, "PROMPT_ERROR");
        if (normalized.code === "MISSING_CREDENTIAL") this.#markProfileUnavailable(this.state.sessions[id]?.profileId, normalized);
        if (recoverableSessionError(normalized) && this.state.sessions[id]?.nativeSessionId && options.__nativeRecovery !== true) {
          try {
            const record = this.state.sessions[id];
            const profile = this.profiles.get(record.profileId);
            await this.#recoverNativeSession(id, normalized);
            await this.#startUnlocked(profile, id, { sessionId: id, cwd: record.cwd, nativeSessionId: null, reasoningEffort: options.reasoningEffort });
            const retryHandle = this.live.get(id);
            const retry = await retryHandle.prompt(options.recoveryPrompt ?? text, { ...options, __nativeRecovery: true });
            const nativeSessionId = retry?.nativeSessionId ?? retryHandle.getNativeSessionId?.();
            if (nativeSessionId && nativeSessionId !== this.state.sessions[id]?.nativeSessionId) {
              await this.#append("session/native", { id, nativeSessionId, updatedAt: Date.now() });
            }
            await this.#append("event/append", {
              sessionId: id,
              kind: "assistant_final",
              text: truncateText(retry?.text ?? "", 512 * 1024),
              ts: Date.now()
            });
            await this.#append("session/status", { id, status: "idle", handoffRequired: false, updatedAt: Date.now(), error: void 0 });
            this.emit("session-result", { sessionId: id, result: retry, recovered: true });
            return retry;
          } catch (recoveryError) {
            const recovery = asMeshError(recoveryError, "PROMPT_RECOVERY_ERROR");
            await this.#append("session/status", { id, status: "error", error: recovery.toJSON(), updatedAt: Date.now() });
            this.emit("session-error", { sessionId: id, error: recovery.toJSON(), recovered: false });
            throw recovery;
          }
        }
        await this.#append("session/status", { id, status: "error", error: normalized.toJSON(), updatedAt: Date.now() });
        this.emit("session-error", { sessionId: id, error: normalized.toJSON() });
        throw normalized;
      }
    });
  }
  async stop(sessionId) {
    await this.ready;
    const id = String(sessionId);
    const queue = this.#sessionQueue(id);
    return queue.run(async () => {
      const handle = this.live.get(id);
      if (handle) {
        await handle.close();
        this.live.delete(id);
      }
      if (this.dsh?.has?.(id)) {
        throw new MeshError("DSH_HOST_AGENT", "DSH host agents are owned by DSH and cannot be stopped by Agent Mesh.", { sessionId: id });
      }
      if (this.state.sessions[id]) await this.#append("session/status", { id, status: "stopped", updatedAt: Date.now() });
      return this.state.sessions[id] ? this.#publicSession(this.state.sessions[id]) : void 0;
    });
  }
  async sendMessage(input) {
    await this.ready;
    const from = String(input?.from ?? "");
    const metadata = input?.metadata && typeof input.metadata === "object" ? redact({ ...input.metadata }, { maxBytes: 16 * 1024 }) : {};
    if (this.dsh?.has?.(from) && metadata.mailbox === true) metadata.mailbox = false;
    if (!this.state.sessions[from] && metadata.mailbox === void 0) metadata.mailbox = true;
    return this.bus.send({
      ...input,
      metadata,
      traceId: input?.traceId,
      parentId: input?.parentId,
      expectsReply: input?.expectsReply,
      idempotencyKey: input?.idempotencyKey,
      deadlineAt: input?.deadlineAt,
      artifacts: input?.artifacts
    });
  }
  async cancelMessage(id, reason) {
    await this.ready;
    return this.bus.cancel(String(id), reason);
  }
  listAgents() {
    if (!this.state) return [];
    const persisted = Object.values(this.state.sessions);
    const native = this.dsh?.list?.() ?? [];
    return [...persisted.map((record) => this.#publicSession(record)), ...native.map((record) => ({
      id: String(record.id),
      profileId: record.profileId ?? "dsh-native",
      harness: "dsh",
      transport: "dsh",
      model: record.model,
      cwd: record.cwd,
      nativeSessionId: record.nativeSessionId ?? record.id,
      capabilities: record.capabilities ?? { inProcess: true, followup: true, streaming: true, resume: true },
      status: record.status ?? "connected",
      live: true,
      hostOwned: true,
      updatedAt: record.updatedAt ?? Date.now()
    }))].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }
  hasAgent(sessionId) {
    const id = String(sessionId);
    return Boolean(this.state?.sessions?.[id]) || Boolean(this.dsh?.has?.(id));
  }
  sessionNeedsHandoff(sessionId) {
    return Boolean(this.state?.sessions?.[String(sessionId)]?.handoffRequired);
  }
  async markHandoffComplete(sessionId) {
    await this.ready;
    const id = String(sessionId);
    if (this.state.sessions[id]?.handoffRequired) {
      await this.#append("session/status", { id, handoffRequired: false, updatedAt: Date.now() });
    }
  }
  inbox(options = {}) {
    return this.bus?.list(options) ?? [];
  }
  snapshot(options = {}) {
    const limit = Math.min(200, Math.max(1, Number(options.limit ?? 50)));
    return {
      version: 1,
      discovery: this.discovery ? publicDiscovery(this.discovery) : void 0,
      profiles: this.listProfiles(),
      agents: this.listAgents(),
      messages: this.inbox({ to: options.to, limit }),
      events: (this.state?.events ?? []).slice(-limit)
    };
  }
  async #deliverMessage(message) {
    if (this.dsh?.has?.(message.to)) {
      const envelope2 = this.#messageEnvelope(message);
      await this.dsh.deliver(message.to, envelope2, message);
      await this.bus.markCompleted(message.id, { hostAgent: true, sessionId: message.to });
      return;
    }
    if (!this.state.sessions[message.to]) {
      if (message.metadata?.mailbox === true) {
        await this.bus.markCompleted(message.id, { mailbox: true });
        return;
      }
      throw new MeshError("SESSION_NOT_FOUND", `Session not found: ${message.to}.`, { sessionId: message.to });
    }
    const envelope = this.#messageEnvelope(message);
    const result = await this.send(message.to, envelope, { messageId: message.id, source: "agent-mesh", metadata: message.metadata });
    if (message.kind !== "reply" && message.expectsReply !== false && message.from !== message.to && (this.state.sessions[message.from] || this.dsh?.has?.(message.from) || message.metadata?.mailbox === true) && result?.text?.trim()) {
      const senderIsSession = Boolean(this.state.sessions[message.from] || this.dsh?.has?.(message.from));
      await this.bus.send({
        from: message.to,
        to: message.from,
        text: result.text,
        kind: "reply",
        replyTo: message.id,
        traceId: message.traceId,
        parentId: message.id,
        metadata: { autoReply: false, mailbox: !senderIsSession, sourceMessageId: message.id }
      }).catch((error) => this.logger?.warn?.({ error, messageId: message.id }, "automatic mesh reply enqueue failed"));
    }
    await this.bus.markCompleted(message.id, { sessionId: message.to });
  }
  #messageEnvelope(message) {
    return [
      "[DSH Agent Mesh message]",
      `message_id: ${message.id}`,
      `from: ${message.from}`,
      `kind: ${message.kind}`,
      message.traceId ? `trace_id: ${message.traceId}` : void 0,
      message.parentId ? `parent_id: ${message.parentId}` : void 0,
      message.replyTo ? `reply_to: ${message.replyTo}` : void 0,
      message.expectsReply === false ? "expects_reply: false" : void 0,
      "",
      message.text,
      "",
      "Reply through the Agent Mesh channel when a response is needed."
    ].filter(Boolean).join("\n");
  }
  async #onAdapterEvent(sessionId, incoming) {
    if (incoming?.kind === "process_exit") {
      this.live.delete(sessionId);
      await this.#append("session/status", { id: sessionId, status: "disconnected", error: incoming.exit?.error, updatedAt: Date.now() }).catch(() => void 0);
    }
    const value = redact({ sessionId, ...incoming ?? {} }, { maxBytes: 256 * 1024 });
    this.emit("agent-event", value);
    if (!["assistant_delta", "notification"].includes(incoming?.kind)) {
      await this.#append("event/append", value).catch((error) => this.logger?.warn?.({ error }, "event projection failed"));
    }
  }
  #sessionQueue(sessionId) {
    let queue = this.sessionQueues.get(sessionId);
    if (!queue) {
      queue = new SerialQueue();
      this.sessionQueues.set(sessionId, queue);
    }
    return queue;
  }
  #publicSession(record) {
    if (!record) return void 0;
    return {
      ...record,
      status: statusFor(record, this.live.has(record.id)),
      live: this.live.has(record.id),
      error: record.error ? redact(record.error) : void 0
    };
  }
  async #recoverNativeSession(id, error) {
    const handle = this.live.get(id);
    if (handle) {
      await handle.close().catch(() => void 0);
      this.live.delete(id);
    }
    await this.#append("session/native", {
      id,
      nativeSessionId: null,
      handoffRequired: true,
      recovery: {
        reason: "stale-native-session",
        previousError: asMeshError(error).toJSON(),
        at: Date.now()
      },
      updatedAt: Date.now()
    });
  }
  #markProfileUnavailable(profileId, error) {
    if (!profileId || !this.profiles.has(profileId)) return;
    const profile = this.profiles.get(profileId);
    profile.discovery = {
      ...profile.discovery ?? {},
      health: {
        ...profile.discovery?.health ?? {},
        authenticated: "missing",
        reasons: [.../* @__PURE__ */ new Set([...profile.discovery?.health?.reasons ?? [], "\u672C\u673A harness \u51ED\u636E\u4E0D\u53EF\u7528"])]
      }
    };
    this.profiles.set(profile);
    this.emit("diagnostics", { kind: "profile-health", profileId, error: error?.toJSON?.() ?? error });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.ready.catch(() => void 0);
    await Promise.all([...this.live.keys()].map((id) => this.stop(id).catch(() => void 0)));
    await this.store.close();
  }
};

// src/mesh-llm.js
import { randomUUID as randomUUID8 } from "node:crypto";
var DEFAULT_MODEL_ID = "native-default";
var AUTO_PROVIDER = "mesh:auto";
var AUTO_MODEL_ID = "auto";
var HISTORY_LIMIT = 24e3;
var HARNESS_NAMES = /* @__PURE__ */ new Map([
  ["codex", "Codex"],
  ["claude-code", "Claude Code"],
  ["opencode", "OpenCode"],
  ["kimi", "Kimi Code"],
  ["omp", "OMP"],
  ["pi", "Pi"],
  ["zcode", "ZCode"]
]);
function slug3(value, fallback = "harness") {
  const result = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return result || fallback;
}
function hash2(value) {
  let output = 2166136261;
  for (const char of String(value)) {
    output ^= char.codePointAt(0);
    output = Math.imul(output, 16777619);
  }
  return (output >>> 0).toString(16).padStart(8, "0");
}
function routeFor(harness) {
  return `mesh:${slug3(harness)}`;
}
function harnessName(harness) {
  return HARNESS_NAMES.get(String(harness)) ?? String(harness || "Local harness");
}
function modelId(profile) {
  return profile.model || DEFAULT_MODEL_ID;
}
function modelName(profile) {
  if (!profile.model) return "\u672C\u673A\u9ED8\u8BA4";
  const discovered = profile.discovery?.models?.find((item) => item.id === profile.model);
  return discovered?.label || profile.model;
}
function modelMetadata(profile) {
  const discovered = profile?.discovery?.models?.find((item) => item.id === profile.model);
  return {
    ...discovered?.contextWindow ? { context: { contextWindow: discovered.contextWindow } } : {},
    ...discovered?.reasoning ? { reasoning: discovered.reasoning } : {}
  };
}
function modelDescription(profile) {
  const health = profile?.discovery?.health;
  if (!health) return void 0;
  if (health.state === "invalid-config") return "\u914D\u7F6E\u5F02\u5E38 \xB7 \u5C06\u81EA\u52A8\u6062\u590D";
  if (health.authenticated === "missing") return "\u9700\u8981\u767B\u5F55";
  if (!profile.model) return "\u4F7F\u7528\u672C\u673A\u9ED8\u8BA4\u6A21\u578B";
  return health.modelSelectable ? "\u672C\u673A\u914D\u7F6E \xB7 \u53EF\u6062\u590D" : "\u672C\u673A\u9ED8\u8BA4\u6A21\u578B";
}
function modelAvailable(profile) {
  const health = profile?.discovery?.health;
  if (!health) return void 0;
  return health.state !== "missing-binary" && health.state !== "invalid-config" && health.authenticated !== "missing";
}
function blockText(block) {
  if (!block || typeof block !== "object") return "";
  if (block.type === "text" || block.type === "reasoning") return String(block.text ?? "");
  return "";
}
function messageText2(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content.map(blockText).filter(Boolean).join("");
}
function promptText(messages) {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user" || message?.source?.kind === "tool") continue;
    const text = messageText2(message).trim();
    if (text) return text;
  }
  throw new MeshError("PROMPT_REQUIRED", "The DSH turn did not contain a text prompt.");
}
function historyText(messages, current) {
  const rows = [];
  for (const message of messages ?? []) {
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    const text = messageText2(message).trim();
    if (!text || text === current) continue;
    rows.push(`${message.role === "assistant" ? "\u52A9\u624B" : "\u7528\u6237"}\uFF1A${text}`);
  }
  const result = rows.join("\n\n");
  return result.length > HISTORY_LIMIT ? `\u2026${result.slice(-HISTORY_LIMIT)}` : result;
}
function sessionKey2(sessionId, provider, model) {
  const raw = String(sessionId || randomUUID8());
  const readable2 = raw.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 56) || "session";
  return `dsh-${readable2}-${slug3(provider, "provider").slice(0, 18)}-${hash2(`${raw}:${provider}:${model}`)}`;
}
function usageOf(value) {
  if (!value || typeof value !== "object") return void 0;
  const inputTokens = Number(value.inputTokens ?? value.input_tokens);
  const outputTokens = Number(value.outputTokens ?? value.output_tokens);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return void 0;
  return {
    inputTokens: Math.max(0, Math.trunc(inputTokens)),
    outputTokens: Math.max(0, Math.trunc(outputTokens)),
    ...value.cacheReadTokens === void 0 && value.cache_read_tokens === void 0 ? {} : {
      cacheReadTokens: Math.max(0, Math.trunc(Number(value.cacheReadTokens ?? value.cache_read_tokens) || 0))
    },
    ...value.cacheWriteTokens === void 0 && value.cache_write_tokens === void 0 ? {} : {
      cacheWriteTokens: Math.max(0, Math.trunc(Number(value.cacheWriteTokens ?? value.cache_write_tokens) || 0))
    }
  };
}
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw new MeshError("ABORTED", "The DSH request was cancelled.");
}
function waitForEvent(signal, wake) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    wake.current = finish;
    signal?.addEventListener("abort", finish, { once: true });
  });
}
var MeshLlmAdapter = class {
  constructor(runtime, options = {}) {
    this.runtime = runtime;
    this.logger = options.logger;
    this.router = runtime.router ?? new MeshRouter(runtime, { logger: this.logger });
    this.routes = /* @__PURE__ */ new Map();
  }
  refresh() {
    const next = /* @__PURE__ */ new Map();
    for (const profile of this.runtime.listProfiles()) {
      if (profile.available === false || profile.routeable === false || profile.nativeHost === true) continue;
      const provider = routeFor(profile.harness);
      const route = next.get(provider) ?? {
        provider,
        harness: profile.harness,
        name: harnessName(profile.harness),
        profiles: []
      };
      route.profiles.push(profile);
      next.set(provider, route);
    }
    if (this.router.hasCandidates()) {
      next.set(AUTO_PROVIDER, {
        provider: AUTO_PROVIDER,
        harness: "mesh",
        name: "\u81EA\u52A8\u8DEF\u7531",
        profiles: [],
        automatic: true
      });
    }
    this.routes = next;
    return [...next.keys()];
  }
  providerInfo(provider) {
    const route = this.routes.get(provider);
    return { id: provider, name: route?.name ?? provider };
  }
  providerRetryPolicy() {
    return void 0;
  }
  listModels(provider) {
    const route = this.routes.get(provider);
    if (!route) return Promise.resolve([]);
    if (route.automatic) {
      return Promise.resolve([{
        provider,
        id: AUTO_MODEL_ID,
        name: "\u81EA\u52A8\u8DEF\u7531",
        inputModalities: ["text"],
        description: "\u9ED8\u8BA4\u5355\u8DEF\uFF1B\u590D\u6742\u6216\u9AD8\u98CE\u9669\u4EFB\u52A1\u624D\u4F1A\u5E76\u884C\u6838\u67E5"
      }]);
    }
    const seen = /* @__PURE__ */ new Set();
    const models = [];
    const candidates = route.profiles.some((profile) => profile.model) ? route.profiles.filter((profile) => profile.model) : route.profiles;
    for (const profile of candidates) {
      const id = modelId(profile);
      if (seen.has(id)) continue;
      seen.add(id);
      models.push({
        provider,
        id,
        name: modelName(profile),
        inputModalities: ["text"],
        ...modelDescription(profile) ? { description: modelDescription(profile) } : {},
        ...modelAvailable(profile) === void 0 ? {} : { available: modelAvailable(profile) }
      });
    }
    return Promise.resolve(models);
  }
  resolveModel(provider, model) {
    const route = this.routes.get(provider);
    if (route?.automatic && model === AUTO_MODEL_ID) {
      return Promise.resolve({
        provider,
        id: model,
        name: "\u81EA\u52A8\u8DEF\u7531",
        inputModalities: ["text"],
        description: "\u9ED8\u8BA4\u5355\u8DEF\uFF1B\u590D\u6742\u6216\u9AD8\u98CE\u9669\u4EFB\u52A1\u624D\u4F1A\u5E76\u884C\u6838\u67E5"
      });
    }
    const profile = route?.profiles.find((item) => modelId(item) === model);
    return Promise.resolve({
      provider,
      id: model,
      name: profile ? modelName(profile) : model,
      inputModalities: ["text"],
      ...modelMetadata(profile)
    });
  }
  profileFor(provider, model) {
    const route = this.routes.get(provider);
    if (!route) throw new MeshError("PROFILE_NOT_FOUND", `No local harness is registered for ${provider}.`);
    return route.profiles.find((profile) => modelId(profile) === model) ?? route.profiles.find((profile) => !profile.model) ?? route.profiles[0];
  }
  async *stream(options) {
    throwIfAborted(options.signal);
    if (options.provider === AUTO_PROVIDER) {
      await this.runtime.ready;
      throwIfAborted(options.signal);
      const current = promptText(options.messages);
      const routeInput = {
        prompt: current,
        messages: options.messages,
        sessionId: options.sessionId,
        signal: options.signal,
        reasoningEffort: options.reasoningEffort,
        mode: options.routeMode,
        maxCalls: options.maxCalls,
        maxBranches: options.maxBranches,
        routeTimeoutMs: options.routeTimeoutMs,
        branchTimeoutMs: options.branchTimeoutMs,
        positionSwap: options.positionSwap,
        strong: options.strong
      };
      const plan = this.router.plan(routeInput);
      if (plan.branches.length === 1 && !plan.judge) {
        const profile2 = this.runtime.listProfiles().find((item) => item.id === plan.branches[0].profileId);
        if (!profile2) throw new MeshError("ROUTE_PROFILE_MISSING", `The selected local route disappeared: ${plan.branches[0].profileId}.`);
        this.runtime.emit?.("route-event", { kind: "route_selected", route: plan });
        yield* this.#streamProfile(options, profile2, routeFor(profile2.harness), modelId(profile2));
        return;
      }
      const result = await this.router.run(routeInput);
      const text = String(result.text ?? "").trim();
      if (!text) throw new MeshError("EMPTY_RESPONSE", "The automatic local route returned no assistant text.");
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text };
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      const usage = usageOf(result.usage);
      if (usage) yield { type: "usage", usage };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    const profile = this.profileFor(options.provider, options.model);
    yield* this.#streamProfile(options, profile, options.provider, options.model);
  }
  async *#streamProfile(options, profile, provider, model) {
    const current = promptText(options.messages);
    const meshId = sessionKey2(options.sessionId, provider, model);
    await this.runtime.ready;
    throwIfAborted(options.signal);
    const existing = typeof this.runtime.hasAgent === "function" ? this.runtime.hasAgent(meshId) : this.runtime.listAgents().some((agent) => agent.id === meshId);
    if (typeof this.runtime.ensureAgent === "function") await this.runtime.ensureAgent(meshId, { reasoningEffort: options.reasoningEffort }).catch(async (error) => {
      if (!existing) return this.runtime.start(profile.id, { sessionId: meshId, reasoningEffort: options.reasoningEffort });
      throw error;
    });
    else if (!existing) await this.runtime.start(profile.id, { sessionId: meshId, reasoningEffort: options.reasoningEffort });
    const history = historyText(options.messages, current);
    const needsHandoff = typeof this.runtime.sessionNeedsHandoff === "function" && this.runtime.sessionNeedsHandoff(meshId);
    const handoffPrompt = [
      history ? `[DSH \u4F1A\u8BDD\u4E0A\u4E0B\u6587]
${history}` : void 0,
      `[\u5F53\u524D\u8BF7\u6C42]
${current}`
    ].filter(Boolean).join("\n\n");
    const prompt = existing && !needsHandoff ? current : handoffPrompt;
    const queue = [];
    const wake = { current: void 0 };
    let settled = false;
    let result;
    let failure;
    let streamedText = "";
    let blockStarted = false;
    const onEvent = (event2) => {
      if (event2?.sessionId !== meshId || event2.kind !== "assistant_delta" || !event2.text) return;
      queue.push(String(event2.text));
      wake.current?.();
      wake.current = void 0;
    };
    this.runtime.on("agent-event", onEvent);
    void this.runtime.send(meshId, prompt, {
      source: "dsh-native-model",
      model: profile.model,
      reasoningEffort: options.reasoningEffort,
      recoveryPrompt: handoffPrompt
    }).then((value) => {
      result = value;
      settled = true;
      wake.current?.();
      wake.current = void 0;
    }, (error) => {
      failure = error;
      settled = true;
      wake.current?.();
      wake.current = void 0;
    });
    try {
      while (!settled || queue.length > 0) {
        throwIfAborted(options.signal);
        if (queue.length > 0) {
          const text = queue.shift();
          if (!blockStarted) {
            blockStarted = true;
            yield { type: "block-start", index: 0, blockType: "text" };
          }
          streamedText += text;
          yield { type: "text-delta", index: 0, text };
          continue;
        }
        await waitForEvent(options.signal, wake);
      }
      throwIfAborted(options.signal);
      if (failure) throw failure;
      const finalText2 = String(result?.text ?? "").trim();
      if (!streamedText && finalText2) {
        blockStarted = true;
        streamedText = finalText2;
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: finalText2 };
      }
      if (!streamedText) throw new MeshError("EMPTY_RESPONSE", "The local harness returned no assistant text.");
      if (needsHandoff && typeof this.runtime.markHandoffComplete === "function") await this.runtime.markHandoffComplete(meshId);
      yield { type: "block-end", index: 0, block: { type: "text", text: streamedText } };
      const usage = usageOf(result?.usage);
      if (usage) yield { type: "usage", usage };
      yield { type: "finish", reason: { kind: "stop" } };
    } finally {
      this.runtime.off("agent-event", onEvent);
    }
  }
};

// src/dsh-plugin.js
var name = "agent-mesh";
var inject = ["tools", "systemPrompt", "llm", "agents"];
var OBJECT_OUTPUT = {
  type: "object",
  additionalProperties: true
};
function createRelayUserMessage(text) {
  const content = Object.freeze([{ type: "text", text }]);
  const source = Object.freeze({ kind: "plugin", plugin: name, form: "relay" });
  return Object.freeze({
    id: crypto.randomUUID(),
    role: "user",
    content,
    source
  });
}
function parameterSchema(specification = {}) {
  const properties = {};
  const required = [];
  for (const [name2, raw] of Object.entries(specification)) {
    const spec = raw && typeof raw === "object" ? { ...raw } : { type: "string" };
    const isRequired = spec.required === true;
    delete spec.required;
    properties[name2] = spec;
    if (isRequired) required.push(name2);
  }
  return {
    type: "object",
    properties,
    ...required.length ? { required } : {}
  };
}
function validateValue(spec, value, location) {
  if (!spec || typeof spec !== "object") return [];
  if (spec.type === "string" && typeof value !== "string") return [`${location} must be a string`];
  if (spec.type === "integer" && !Number.isInteger(value)) return [`${location} must be an integer`];
  if (spec.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return [`${location} must be a number`];
  if (spec.type === "boolean" && typeof value !== "boolean") return [`${location} must be a boolean`];
  if (spec.type === "array") {
    if (!Array.isArray(value)) return [`${location} must be an array`];
    return value.flatMap((item, index) => validateValue(spec.items, item, `${location}[${index}]`));
  }
  return [];
}
function validateParameters(schema, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return ["arguments must be an object"];
  const errors = [];
  for (const name2 of schema.required ?? []) {
    if (args[name2] === void 0) errors.push(`${name2} is required`);
  }
  for (const [name2, spec] of Object.entries(schema.properties ?? {})) {
    if (args[name2] !== void 0) errors.push(...validateValue(spec, args[name2], name2));
  }
  return errors;
}
function defineMeshTool(options) {
  const parameters = parameterSchema(options.parameters);
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: options.output,
    async execute(args, exec) {
      const errors = validateParameters(parameters, args);
      if (errors.length) throw new Error(`invalid arguments: ${errors.join("; ")}`);
      return options.execute(args, exec);
    }
  };
}
function textRender(value) {
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
}
function currentAgent(exec) {
  return String(exec?.agent?.session?.id ?? exec?.agent?.id ?? "dsh:current");
}
function dshAgentBridge(ctx) {
  const registry = ctx.agents;
  const describe = (agent) => ({
    id: String(agent.id),
    profileId: "dsh-native",
    harness: "dsh",
    transport: "dsh",
    model: agent.options?.model,
    provider: agent.options?.provider,
    cwd: agent.session?.header?.cwd,
    status: agent.status,
    nativeSessionId: String(agent.id),
    capabilities: {
      inProcess: true,
      followup: typeof agent.followup === "function",
      streaming: true,
      resume: true,
      toolEvents: true,
      modelSwitch: false
    },
    updatedAt: Date.now()
  });
  return {
    list() {
      return registry?.list?.().map(describe) ?? [];
    },
    get(id) {
      return registry?.get?.(String(id));
    },
    has(id) {
      return Boolean(registry?.get?.(String(id)));
    },
    deliver(id, text, message) {
      const agent = registry?.get?.(String(id));
      if (!agent || typeof agent.followup !== "function") throw new Error(`DSH agent is not available: ${id}`);
      agent.followup(createRelayUserMessage(text));
      return { accepted: true, messageId: message?.id, nativeSessionId: String(agent.id) };
    }
  };
}
function loggerFor(ctx) {
  return {
    debug(data, message) {
      ctx.logger?.debug?.(`${message ?? "agent-mesh"} ${JSON.stringify(data ?? {})}`);
    },
    info(data, message) {
      ctx.logger?.info?.(`${message ?? "agent-mesh"} ${JSON.stringify(data ?? {})}`);
    },
    warn(data, message) {
      ctx.logger?.warn?.(`${message ?? "agent-mesh"} ${JSON.stringify(data ?? {})}`);
    },
    error(data, message) {
      ctx.logger?.error?.(`${message ?? "agent-mesh"} ${JSON.stringify(data ?? {})}`);
    }
  };
}
function registerTools(ctx, runtime) {
  ctx.tools.register(defineMeshTool({
    name: "agent_mesh_profiles",
    description: "List locally discovered agent harnesses and model profiles. Credentials stay in the native harness stores.",
    parameters: {},
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute() {
      await runtime.ready;
      return { profiles: runtime.listProfiles(), discovery: runtime.snapshot().discovery };
    }
  }));
  ctx.tools.register(defineMeshTool({
    name: "agent_mesh_agents",
    description: "List persistent Agent Mesh sessions, their harness/model, status, workspace, and native session id.",
    parameters: {},
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute() {
      await runtime.ready;
      return { agents: runtime.listAgents() };
    }
  }));
  ctx.tools.register(defineMeshTool({
    name: "agent_mesh_start",
    description: "Start or resume a local harness session using a discovered profile.",
    parameters: {
      profile_id: { type: "string", required: true, description: "Profile id from agent_mesh_profiles." },
      session_id: { type: "string", description: "Optional stable Agent Mesh session id to resume." },
      cwd: { type: "string", description: "Optional absolute workspace path." }
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute(args) {
      return runtime.start(args.profile_id, { sessionId: args.session_id, cwd: args.cwd });
    }
  }));
  ctx.tools.register(defineMeshTool({
    name: "agent_mesh_send",
    description: "Queue a durable message to another Agent Mesh session. The target session is resumed on demand.",
    parameters: {
      to: { type: "string", required: true, description: "Target Agent Mesh session id." },
      text: { type: "string", required: true, description: "Message or task for the target agent." },
      from: { type: "string", description: "Sender id; defaults to the current DSH agent." },
      kind: { type: "string", description: "Message kind, for example task, review, result, or question." },
      reply_to: { type: "string", description: "Message id being answered." },
      trace_id: { type: "string", description: "Optional trace id shared by a multi-agent task." },
      parent_id: { type: "string", description: "Optional parent message id." },
      idempotency_key: { type: "string", description: "Optional stable key; retries do not duplicate delivery." },
      expects_reply: { type: "boolean", description: "Whether the target should return one bounded reply." }
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute(args, exec) {
      const from = args.from ?? currentAgent(exec);
      return runtime.sendMessage({
        to: args.to,
        text: args.text,
        from,
        kind: args.kind,
        replyTo: args.reply_to,
        traceId: args.trace_id,
        parentId: args.parent_id,
        idempotencyKey: args.idempotency_key,
        expectsReply: args.expects_reply,
        metadata: { mailbox: args.from === void 0 }
      });
    }
  }));
  ctx.tools.register(defineMeshTool({
    name: "agent_mesh_inbox",
    description: "Read durable cross-agent messages for a session.",
    parameters: {
      to: { type: "string", description: "Target session id; defaults to the current DSH agent." },
      limit: { type: "integer", description: "Maximum number of messages, default 50." }
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute(args, exec) {
      await runtime.ready;
      return { messages: runtime.inbox({ to: args.to ?? currentAgent(exec), limit: args.limit }) };
    }
  }));
  ctx.tools.register(defineMeshTool({
    name: "agent_mesh_handoff",
    description: "Send a structured handoff between different harness/model sessions.",
    parameters: {
      to: { type: "string", required: true, description: "Target session id." },
      summary: { type: "string", required: true, description: "What was learned or completed." },
      next_steps: { type: "array", items: { type: "string" }, description: "Concrete next actions." },
      files: { type: "array", items: { type: "string" }, description: "Relevant files or paths." },
      tests: { type: "array", items: { type: "string" }, description: "Tests already run and their result." },
      blockers: { type: "array", items: { type: "string" }, description: "Known blockers or risks." },
      from: { type: "string", description: "Sender id; defaults to the current DSH agent." },
      trace_id: { type: "string", description: "Optional trace id shared by the handoff chain." },
      idempotency_key: { type: "string", description: "Optional stable key for safe retries." }
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute(args, exec) {
      const sections = [
        "Structured handoff",
        `Summary:
${args.summary}`,
        args.next_steps?.length ? `Next steps:
${args.next_steps.map((item) => `- ${item}`).join("\n")}` : void 0,
        args.files?.length ? `Files:
${args.files.map((item) => `- ${item}`).join("\n")}` : void 0,
        args.tests?.length ? `Tests:
${args.tests.map((item) => `- ${item}`).join("\n")}` : void 0,
        args.blockers?.length ? `Blockers:
${args.blockers.map((item) => `- ${item}`).join("\n")}` : void 0
      ].filter(Boolean).join("\n\n");
      return runtime.sendMessage({
        to: args.to,
        from: args.from ?? currentAgent(exec),
        text: sections,
        kind: "handoff",
        traceId: args.trace_id,
        idempotencyKey: args.idempotency_key,
        artifacts: [
          ...(args.files ?? []).map((path) => ({ type: "file", path })),
          ...(args.tests ?? []).map((value) => ({ type: "test", value })),
          ...(args.blockers ?? []).map((value) => ({ type: "blocker", value })),
          ...(args.next_steps ?? []).map((value) => ({ type: "next-step", value }))
        ],
        metadata: { mailbox: args.from === void 0 }
      });
    }
  }));
  ctx.tools.register(defineMeshTool({
    name: "agent_mesh_stop",
    description: "Stop a live local harness process while retaining its persistent session mapping for later resume.",
    parameters: { session_id: { type: "string", required: true, description: "Agent Mesh session id." } },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute(args) {
      return runtime.stop(args.session_id);
    }
  }));
  ctx.tools.register(defineMeshTool({
    name: "agent_mesh_cancel",
    description: "Cancel a queued or retrying cross-agent message before delivery. A native turn already dispatched to a harness may finish, but it will not be delivered again.",
    parameters: {
      message_id: { type: "string", required: true, description: "Durable Agent Mesh message id." },
      reason: { type: "string", description: "Optional cancellation reason." }
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute(args) {
      return runtime.cancelMessage(args.message_id, args.reason);
    }
  }));
  ctx.tools.register(defineMeshTool({
    name: "agent_mesh_discover",
    description: "Refresh the read-only local harness and model discovery report.",
    parameters: {},
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute() {
      return runtime.discover();
    }
  }));
  ctx.tools.register(defineMeshTool({
    name: "agent_mesh_doctor",
    description: "Run bounded no-turn health checks for detected harnesses; never reads credential values or sends a model prompt.",
    parameters: {},
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute() {
      return runtime.doctor();
    }
  }));
  ctx.tools.register(defineMeshTool({
    name: "agent_mesh_route_plan",
    description: "Explain which usable local harness/model routes would be selected, without starting a session or sending a prompt.",
    parameters: {
      prompt: { type: "string", required: true, description: "The task to classify and route." },
      mode: { type: "string", description: "single, auto, panel, or aggregate; default auto." },
      max_calls: { type: "integer", description: "Hard cap on producer and evaluator calls, maximum 5." },
      max_branches: { type: "integer", description: "Hard cap on parallel producer branches, maximum 3." },
      position_swap: { type: "boolean", description: "Run a second judge pass with candidate positions swapped." },
      strong: { type: "boolean", description: "Allow the extra blind judge pass for an explicit panel request." }
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute(args) {
      await runtime.ready;
      return runtime.routePlan({
        prompt: args.prompt,
        mode: args.mode,
        maxCalls: args.max_calls,
        maxBranches: args.max_branches,
        positionSwap: args.position_swap,
        strong: args.strong
      });
    }
  }));
  ctx.tools.register(defineMeshTool({
    name: "agent_mesh_route",
    description: "Run a bounded multi-agent route over usable local CLI harnesses. Default auto mode uses one producer and only fans out for complex or high-risk tasks.",
    parameters: {
      prompt: { type: "string", required: true, description: "The task to execute." },
      session_id: { type: "string", description: "Stable route id; reuses the same per-harness sessions across turns." },
      mode: { type: "string", description: "single, auto, panel, or aggregate; default auto." },
      max_calls: { type: "integer", description: "Hard cap on producer and evaluator calls, maximum 5." },
      max_branches: { type: "integer", description: "Hard cap on parallel producer branches, maximum 3." },
      route_timeout_ms: { type: "integer", description: "Overall route deadline." },
      branch_timeout_ms: { type: "integer", description: "Per-harness branch deadline." },
      position_swap: { type: "boolean", description: "Run a second blind judge pass with candidate positions swapped." },
      strong: { type: "boolean", description: "Allow the extra blind judge pass for an explicit panel request." }
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute(args) {
      return runtime.route({
        prompt: args.prompt,
        sessionId: args.session_id,
        mode: args.mode,
        maxCalls: args.max_calls,
        maxBranches: args.max_branches,
        routeTimeoutMs: args.route_timeout_ms,
        branchTimeoutMs: args.branch_timeout_ms,
        positionSwap: args.position_swap,
        strong: args.strong
      });
    }
  }));
}
function registerLlmRoutes(ctx, runtime, config) {
  const adapter = new MeshLlmAdapter(runtime, { logger: ctx.logger });
  let registration;
  let disposed = false;
  const sync = () => {
    if (disposed) return;
    const routes = adapter.refresh();
    try {
      if (registration) registration.replace(routes);
      else if (routes.length) registration = ctx.llm.registerAdapter(routes, adapter);
    } catch (error) {
      ctx.logger?.warn?.(`agent-mesh: keeping the last good LLM route set: ${error.message}`);
    }
  };
  sync();
  runtime.on("discovery", sync);
  runtime.on("diagnostics", sync);
  runtime.ready.then(sync, (error) => {
    ctx.logger?.warn?.(`agent-mesh: native harness discovery failed: ${error.message}`);
  });
  ctx.effect(() => () => {
    disposed = true;
    runtime.off("discovery", sync);
    runtime.off("diagnostics", sync);
    registration?.();
  }, config.llmEffectLabel ?? "agent-mesh: native LLM routes");
}
async function readRequestBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function registerWebRoutes(ctx, runtime) {
  const keys = ["webServer", "httpServer"];
  let registered = false;
  const register = () => {
    if (registered) return;
    const server = keys.map((key) => ctx.get?.(key)).find(Boolean);
    if (!server) return;
    registered = true;
    ctx.effect(() => server.register({
      kind: "exact",
      path: "/plugins/dsh-agent-mesh/state",
      handler: async (_req, res) => {
        await runtime.ready;
        const body = JSON.stringify(runtime.snapshot({ limit: 80 }));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(body);
      }
    }), "agent-mesh: state route");
    ctx.effect(() => server.register({
      kind: "exact",
      path: "/plugins/dsh-agent-mesh/action",
      handler: async (req, res) => {
        try {
          const body = await readRequestBody(req);
          let result;
          if (body.action === "discover") result = await runtime.discover({ cwd: body.cwd });
          else if (body.action === "doctor") result = await runtime.doctor({ cwd: body.cwd, refresh: body.refresh });
          else if (body.action === "start") result = await runtime.start(body.profileId, { sessionId: body.sessionId, cwd: body.cwd });
          else if (body.action === "send") result = await runtime.sendMessage({ from: body.from ?? "dsh-ui", to: body.to, text: body.text, kind: body.kind, metadata: { mailbox: body.from === void 0 } });
          else if (body.action === "stop") result = await runtime.stop(body.sessionId);
          else if (body.action === "routePlan") {
            await runtime.ready;
            result = runtime.routePlan(body);
          } else if (body.action === "route") result = await runtime.route(body);
          else throw new Error("unsupported action");
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (error) {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: false, error: { message: error.message, code: error.code } }));
        }
      }
    }), "agent-mesh: action route");
  };
  register();
  ctx.on("internal/service", (serviceName) => {
    if (keys.includes(serviceName)) register();
  });
}
function apply(ctx, config = {}) {
  const dsh = dshAgentBridge(ctx);
  const runtime = new MeshRuntime({
    ...config,
    dsh,
    logger: loggerFor(ctx),
    cwd: config.cwd ?? process.cwd()
  });
  ctx.provide("agentMesh", runtime);
  registerTools(ctx, runtime);
  registerLlmRoutes(ctx, runtime, config);
  ctx.systemPrompt.section({
    name: "agent-mesh:usage",
    order: config.promptSectionOrder ?? 118,
    text: "Agent Mesh is available for local harness orchestration. Use agent_mesh_profiles before choosing a harness/model, agent_mesh_route_plan to inspect automatic routing without a turn, and agent_mesh_route for a bounded route across usable local CLIs. Automatic routing defaults to one producer and fans out only for complex, high-risk, or explicitly multi-agent tasks; agent_mesh_start/send/handoff remain available for persistent cross-session communication. DSH host agents are first-class in-process Mesh participants: relay messages arrive as ordinary follow-up user messages, and replies should use Agent Mesh tools with the trace/reply id. Credentials remain in each native CLI configuration; never ask the user to paste keys into Agent Mesh."
  });
  ctx.effect(() => () => runtime.close(), "agent-mesh: runtime");
  registerWebRoutes(ctx, runtime);
  return runtime;
}
export {
  apply,
  inject,
  name
};
