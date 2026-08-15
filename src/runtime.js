import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';

import { EventStore } from './event-store.js';
import { MeshError, assertMesh, asHarnessError, asMeshError } from './errors.js';
import { MessageBus } from './message-bus.js';
import { redact, truncateText } from './redact.js';
import { ProfileRegistry } from './profiles.js';
import { SerialQueue } from './serial-queue.js';
import { AcpAdapter } from './adapters/acp.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { MockAdapter } from './adapters/mock.js';
import { RpcAgentAdapter } from './adapters/rpc-agent.js';
import { ZcodeAdapter } from './adapters/zcode.js';
import { discoverLocalHarnesses, publicDiscovery } from './discovery.js';
import { diagnose } from './doctor.js';
import { MeshRouter } from './router.js';

function recoverableSessionError(error) {
  const code = String(error?.code ?? '').toUpperCase();
  const message = String(error?.message ?? '').toLowerCase();
  if (['SESSION_NOT_FOUND', 'THREAD_NOT_FOUND', 'NATIVE_SESSION_NOT_FOUND', 'RESOURCE_NOT_FOUND', 'UNKNOWN_SESSION'].includes(code)) return true;
  return /(session|thread).*(not found|unknown|does not exist|resource_not_found)|resource_not_found/.test(message);
}

function stateTemplate() {
  return {
    version: 1,
    sessions: {},
    messages: {},
    events: [],
  };
}

function validSessionId(id) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id);
}

function statusFor(record, live) {
  if (!record) return 'unknown';
  if (live) return record.status === 'running' ? 'running' : 'connected';
  return record.status;
}

export class MeshRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.logger = options.logger;
    this.router = new MeshRouter(this, { logger: this.logger });
    // DSH is itself a live, in-process harness. The host plugin supplies a
    // tiny bridge instead of forcing the runtime to spawn `dsh` recursively.
    this.dsh = options.dsh;
    this.maxStoredEvents = Math.max(100, Number(options.maxStoredEvents ?? 2_000));
    this.store = new EventStore(options.homeDir, {
      snapshotEvery: options.snapshotEvery ?? 128,
      durability: options.durability ?? 'batch',
    });
    this.profiles = new ProfileRegistry(options.profiles ?? [], { includeDefaults: options.includeDefaults ?? true });
    this.adapters = new Map([
      ['codex', new CodexAdapter({ logger: this.logger })],
      ['claude', new ClaudeAdapter({ logger: this.logger })],
      ['acp', new AcpAdapter({ logger: this.logger })],
      ['mock', new MockAdapter(options.mock ?? {})],
      ['rpc', new RpcAgentAdapter({ logger: this.logger })],
      ['zcode', new ZcodeAdapter({ logger: this.logger })],
      ...(options.adapters ? Object.entries(options.adapters) : []),
    ]);
    this.live = new Map();
    this.sessionQueues = new Map();
    this.state = undefined;
    this.bus = undefined;
    this.discovery = undefined;
    this.diagnostics = undefined;
    this.diagnosticsPromise = undefined;
    this.closed = false;
    this.ready = this.#open();
    this.ready.then(() => {
      if (this.options.autoDoctor === false || this.options.autoDiscover === false) return;
      queueMicrotask(() => this.doctor().catch((error) => this.logger?.debug?.({ error: error.message }, 'background harness doctor skipped')));
    }).catch(() => undefined);
  }

  async #open() {
    if (this.options.autoDiscover !== false) {
      try {
        this.discovery = await discoverLocalHarnesses({ cwd: this.options.cwd ?? process.cwd(), ...this.options.discovery });
        for (const profile of this.discovery.profiles) this.profiles.set(profile);
      } catch (error) {
        this.logger?.warn?.({ error }, 'local harness discovery failed');
      }
    }
    this.state = await this.store.open(stateTemplate(), (state, event) => this.#applyEvent(state, event));
    if (this.closed) {
      await this.store.close();
      return this;
    }
    this.bus = new MessageBus({
      state: this.state,
      append: (type, data) => this.#append(type, data),
      deliver: (message) => this.#deliverMessage(message),
      logger: this.logger,
      maxBytes: this.options.maxMessageBytes ?? 256 * 1024,
    });
    this.bus.on('failed', (payload) => this.emit('message-failed', payload));
    this.bus.on('delivered', (payload) => this.emit('message-delivered', payload));
    // Do not block startup on old messages. They are retried through the same
    // session queues as new work, preserving per-agent FIFO order.
    queueMicrotask(() => this.bus?.retryPending());
    return this;
  }

  #applyEvent(state, event) {
    const data = event.data ?? {};
    switch (event.type) {
      case 'session/upsert':
        state.sessions[data.id] = { ...(state.sessions[data.id] ?? {}), ...data };
        break;
      case 'session/status':
      case 'session/native':
        if (state.sessions[data.id]) state.sessions[data.id] = { ...state.sessions[data.id], ...data };
        break;
      case 'message/created':
        state.messages[data.id] = data;
        break;
      case 'message/status':
        if (state.messages[data.id]) state.messages[data.id] = { ...state.messages[data.id], ...data };
        break;
      case 'event/append':
        state.events.push(data);
        if (state.events.length > this.maxStoredEvents) state.events.splice(0, state.events.length - this.maxStoredEvents);
        break;
      default:
        break;
    }
  }

  async #append(type, data) {
    const event = await this.store.append(type, data, (state, stored) => this.#applyEvent(state, stored));
    this.emit('event', event);
    return event;
  }

  registerAdapter(name, adapter) {
    assertMesh(name && adapter && typeof adapter.open === 'function', 'INVALID_ADAPTER', 'Adapter must expose open(profile, options).');
    this.adapters.set(String(name), adapter);
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
    this.emit('discovery', this.discovery);
    return publicDiscovery(this.discovery);
  }

  async doctor(options = {}) {
    await this.ready;
    if (!this.discovery || options.refresh) await this.discover(options);
    const ttl = Math.max(1_000, Number(options.cacheTtlMs ?? 30_000));
    if (!options.refresh && this.diagnostics && this.diagnostics.expiresAt > Date.now()) return this.diagnostics.value;
    if (this.diagnosticsPromise) return this.diagnosticsPromise;
    this.diagnosticsPromise = diagnose(this.discovery, { cwd: options.cwd ?? this.options.cwd ?? process.cwd(), timeoutMs: options.timeoutMs })
      .then((value) => {
        this.diagnostics = { value, expiresAt: Date.now() + ttl };
        this.#applyDiagnostics(value);
        this.emit('diagnostics', value);
        return value;
      })
      .finally(() => { this.diagnosticsPromise = undefined; });
    return this.diagnosticsPromise;
  }

  #applyDiagnostics(value) {
    for (const result of value?.harnesses ?? []) {
      const harness = this.discovery?.harnesses?.find((item) => item.id === result.id);
      if (harness) harness.health = { ...(harness.health ?? {}), ...(result.health ?? {}) };
      for (const profile of this.discovery?.profiles ?? []) {
        if (profile.id !== result.id && !profile.id.startsWith(`${result.id}--`)) continue;
        profile.discovery = { ...(profile.discovery ?? {}), health: { ...(profile.discovery?.health ?? {}), ...(result.health ?? {}) } };
        this.profiles.set(profile);
      }
    }
  }

  async createAgent(profileId, options = {}) {
    return this.start(profileId, options);
  }

  async start(profileId, options = {}) {
    await this.ready;
    if (this.closed) throw new MeshError('RUNTIME_CLOSED', 'Agent Mesh is closed.');
    const profile = this.profiles.get(profileId);
    const sessionId = String(options.sessionId ?? randomUUID());
    assertMesh(validSessionId(sessionId), 'INVALID_SESSION_ID', 'Session id contains unsupported characters.');
    const queue = this.#sessionQueue(sessionId);
    return queue.run(() => this.#startUnlocked(profile, sessionId, options));
  }

  async #startUnlocked(profile, sessionId, options = {}) {
    const existing = this.state.sessions[sessionId];
    if (this.live.has(sessionId)) return this.#publicSession(this.state.sessions[sessionId]);
    if (existing && existing.profileId !== profile.id) {
      throw new MeshError('SESSION_PROFILE_CONFLICT', `Session ${sessionId} belongs to profile ${existing.profileId}.`);
    }
    if (profile.transport === 'dsh') {
      if (!this.dsh?.has?.(sessionId)) {
        throw new MeshError('DSH_AGENT_NOT_FOUND', `DSH host agent is not live: ${sessionId}.`, { sessionId });
      }
      return this.listAgents().find((agent) => agent.id === sessionId);
    }
    const cwd = resolvePath(options.cwd ?? existing?.cwd ?? profile.cwd ?? process.cwd());
    const adapter = this.adapters.get(profile.transport);
    if (!adapter) throw new MeshError('ADAPTER_NOT_FOUND', `No adapter for transport ${profile.transport}.`);
    const now = Date.now();
    await this.#append('session/upsert', {
      id: sessionId,
      profileId: profile.id,
      harness: profile.harness,
      model: profile.model,
      reasoningEffort: options.reasoningEffort ?? existing?.reasoningEffort,
      cwd,
      status: 'starting',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      nativeSessionId: options.nativeSessionId !== undefined ? options.nativeSessionId : existing?.nativeSessionId,
      handoffRequired: existing?.handoffRequired ?? false,
    });
    try {
      const handle = await adapter.open(profile, {
        cwd,
        nativeSessionId: options.nativeSessionId !== undefined ? options.nativeSessionId : existing?.nativeSessionId,
        reasoningEffort: options.reasoningEffort,
        onEvent: (event) => this.#onAdapterEvent(sessionId, event),
      });
      this.live.set(sessionId, handle);
      await this.#append('session/upsert', {
        id: sessionId,
        nativeSessionId: handle.nativeSessionId ?? existing?.nativeSessionId,
        capabilities: handle.capabilities,
        handoffRequired: handle.handoffRequired ?? existing?.handoffRequired ?? false,
        status: 'idle',
        error: undefined,
        updatedAt: Date.now(),
      });
      this.emit('session-started', this.#publicSession(this.state.sessions[sessionId]));
      return this.#publicSession(this.state.sessions[sessionId]);
    } catch (error) {
      const normalized = asHarnessError(error, 'ADAPTER_START_ERROR');
      if (normalized.code === 'MISSING_CREDENTIAL') this.#markProfileUnavailable(profile.id, normalized);
      await this.#append('session/status', { id: sessionId, status: 'error', error: normalized.toJSON(), updatedAt: Date.now() });
      throw normalized;
    }
  }

  async #ensureLive(sessionId, options = {}) {
    const handle = this.live.get(sessionId);
    if (handle) return handle;
    const record = this.state.sessions[sessionId];
    if (!record) throw new MeshError('SESSION_NOT_FOUND', `Session not found: ${sessionId}.`, { sessionId });
    const profile = this.profiles.get(record.profileId);
    try {
      await this.#startUnlocked(profile, sessionId, { sessionId, cwd: record.cwd, nativeSessionId: record.nativeSessionId, reasoningEffort: options.reasoningEffort });
    } catch (error) {
      // Native sessions are not equally resumable. A stale Codex thread,
      // evicted ACP session, or deleted Claude session should become a fresh
      // native route automatically. The visible DSH transcript is re-seeded
      // by MeshLlmAdapter after this flag is persisted.
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
    assertMesh(typeof text === 'string' && text.trim(), 'PROMPT_REQUIRED', 'Prompt text is required.');
    const id = String(sessionId);
    const queue = this.#sessionQueue(id);
    return queue.run(async () => {
      const handle = await this.#ensureLive(id, options);
      await this.#append('session/status', { id, status: 'running', updatedAt: Date.now() });
      try {
        const result = await handle.prompt(text, options);
        const nativeSessionId = result?.nativeSessionId ?? handle.getNativeSessionId?.();
        if (nativeSessionId && nativeSessionId !== this.state.sessions[id]?.nativeSessionId) {
          await this.#append('session/native', { id, nativeSessionId, updatedAt: Date.now() });
        }
        await this.#append('event/append', {
          sessionId: id,
          kind: 'assistant_final',
          text: truncateText(result?.text ?? '', 512 * 1024),
          ts: Date.now(),
        });
        await this.#append('session/status', { id, status: 'idle', handoffRequired: false, updatedAt: Date.now(), error: undefined });
        this.emit('session-result', { sessionId: id, result });
        return result;
      } catch (error) {
        const normalized = asHarnessError(error, 'PROMPT_ERROR');
        if (normalized.code === 'MISSING_CREDENTIAL') this.#markProfileUnavailable(this.state.sessions[id]?.profileId, normalized);
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
              await this.#append('session/native', { id, nativeSessionId, updatedAt: Date.now() });
            }
            await this.#append('event/append', {
              sessionId: id,
              kind: 'assistant_final',
              text: truncateText(retry?.text ?? '', 512 * 1024),
              ts: Date.now(),
            });
            await this.#append('session/status', { id, status: 'idle', handoffRequired: false, updatedAt: Date.now(), error: undefined });
            this.emit('session-result', { sessionId: id, result: retry, recovered: true });
            return retry;
          } catch (recoveryError) {
            const recovery = asMeshError(recoveryError, 'PROMPT_RECOVERY_ERROR');
            await this.#append('session/status', { id, status: 'error', error: recovery.toJSON(), updatedAt: Date.now() });
            this.emit('session-error', { sessionId: id, error: recovery.toJSON(), recovered: false });
            throw recovery;
          }
        }
        await this.#append('session/status', { id, status: 'error', error: normalized.toJSON(), updatedAt: Date.now() });
        this.emit('session-error', { sessionId: id, error: normalized.toJSON() });
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
        throw new MeshError('DSH_HOST_AGENT', 'DSH host agents are owned by DSH and cannot be stopped by Agent Mesh.', { sessionId: id });
      }
      if (this.state.sessions[id]) await this.#append('session/status', { id, status: 'stopped', updatedAt: Date.now() });
      return this.state.sessions[id] ? this.#publicSession(this.state.sessions[id]) : undefined;
    });
  }

  async sendMessage(input) {
    await this.ready;
    const from = String(input?.from ?? '');
    const metadata = input?.metadata && typeof input.metadata === 'object'
      ? redact({ ...input.metadata }, { maxBytes: 16 * 1024 })
      : {};
    if (this.dsh?.has?.(from) && metadata.mailbox === true) metadata.mailbox = false;
    if (!this.state.sessions[from] && metadata.mailbox === undefined) metadata.mailbox = true;
    return this.bus.send({
      ...input,
      metadata,
      traceId: input?.traceId,
      parentId: input?.parentId,
      expectsReply: input?.expectsReply,
      idempotencyKey: input?.idempotencyKey,
      deadlineAt: input?.deadlineAt,
      artifacts: input?.artifacts,
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
      profileId: record.profileId ?? 'dsh-native',
      harness: 'dsh',
      transport: 'dsh',
      model: record.model,
      cwd: record.cwd,
      nativeSessionId: record.nativeSessionId ?? record.id,
      capabilities: record.capabilities ?? { inProcess: true, followup: true, streaming: true, resume: true },
      status: record.status ?? 'connected',
      live: true,
      hostOwned: true,
      updatedAt: record.updatedAt ?? Date.now(),
    }))]
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
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
      await this.#append('session/status', { id, handoffRequired: false, updatedAt: Date.now() });
    }
  }

  inbox(options = {}) {
    return this.bus?.list(options) ?? [];
  }

  snapshot(options = {}) {
    const limit = Math.min(200, Math.max(1, Number(options.limit ?? 50)));
    return {
      version: 1,
      discovery: this.discovery ? publicDiscovery(this.discovery) : undefined,
      profiles: this.listProfiles(),
      agents: this.listAgents(),
      messages: this.inbox({ to: options.to, limit }),
      events: (this.state?.events ?? []).slice(-limit),
    };
  }

  async #deliverMessage(message) {
    if (this.dsh?.has?.(message.to)) {
      const envelope = this.#messageEnvelope(message);
      await this.dsh.deliver(message.to, envelope, message);
      await this.bus.markCompleted(message.id, { hostAgent: true, sessionId: message.to });
      return;
    }
    if (!this.state.sessions[message.to]) {
      if (message.metadata?.mailbox === true) {
        await this.bus.markCompleted(message.id, { mailbox: true });
        return;
      }
      throw new MeshError('SESSION_NOT_FOUND', `Session not found: ${message.to}.`, { sessionId: message.to });
    }
    const envelope = this.#messageEnvelope(message);
    const result = await this.send(message.to, envelope, { messageId: message.id, source: 'agent-mesh', metadata: message.metadata });
    // Mesh-to-mesh messages get one bounded automatic return hop. This turns
    // two persistent sessions into a real conversation without asking the
    // external harness to know DSH's tool vocabulary. DSH-originated ids are
    // deliberately excluded: they are readable through the inbox projection
    // but are not guessed as executable Mesh sessions.
    if (message.kind !== 'reply' && message.expectsReply !== false && message.from !== message.to && (this.state.sessions[message.from] || this.dsh?.has?.(message.from) || message.metadata?.mailbox === true) && result?.text?.trim()) {
      const senderIsSession = Boolean(this.state.sessions[message.from] || this.dsh?.has?.(message.from));
      await this.bus.send({
        from: message.to,
        to: message.from,
        text: result.text,
        kind: 'reply',
        replyTo: message.id,
        traceId: message.traceId,
        parentId: message.id,
        metadata: { autoReply: false, mailbox: !senderIsSession, sourceMessageId: message.id },
      }).catch((error) => this.logger?.warn?.({ error, messageId: message.id }, 'automatic mesh reply enqueue failed'));
    }
    await this.bus.markCompleted(message.id, { sessionId: message.to });
  }

  #messageEnvelope(message) {
    return [
      '[DSH Agent Mesh message]',
      `message_id: ${message.id}`,
      `from: ${message.from}`,
      `kind: ${message.kind}`,
      message.traceId ? `trace_id: ${message.traceId}` : undefined,
      message.parentId ? `parent_id: ${message.parentId}` : undefined,
      message.replyTo ? `reply_to: ${message.replyTo}` : undefined,
      message.expectsReply === false ? 'expects_reply: false' : undefined,
      '',
      message.text,
      '',
      'Reply through the Agent Mesh channel when a response is needed.',
    ].filter(Boolean).join('\n');
  }

  async #onAdapterEvent(sessionId, incoming) {
    if (incoming?.kind === 'process_exit') {
      this.live.delete(sessionId);
      await this.#append('session/status', { id: sessionId, status: 'disconnected', error: incoming.exit?.error, updatedAt: Date.now() }).catch(() => undefined);
    }
    const value = redact({ sessionId, ...(incoming ?? {}) }, { maxBytes: 256 * 1024 });
    this.emit('agent-event', value);
    // Token deltas stay in memory/UI only. Persisting every delta turns a
    // streaming UI into a disk benchmark and creates no recovery value.
    if (!['assistant_delta', 'notification'].includes(incoming?.kind)) {
      await this.#append('event/append', value).catch((error) => this.logger?.warn?.({ error }, 'event projection failed'));
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
    if (!record) return undefined;
    return {
      ...record,
      status: statusFor(record, this.live.has(record.id)),
      live: this.live.has(record.id),
      error: record.error ? redact(record.error) : undefined,
    };
  }

  async #recoverNativeSession(id, error) {
    const handle = this.live.get(id);
    if (handle) {
      await handle.close().catch(() => undefined);
      this.live.delete(id);
    }
    await this.#append('session/native', {
      id,
      nativeSessionId: null,
      handoffRequired: true,
      recovery: {
        reason: 'stale-native-session',
        previousError: asMeshError(error).toJSON(),
        at: Date.now(),
      },
      updatedAt: Date.now(),
    });
  }

  #markProfileUnavailable(profileId, error) {
    if (!profileId || !this.profiles.has(profileId)) return;
    const profile = this.profiles.get(profileId);
    profile.discovery = {
      ...(profile.discovery ?? {}),
      health: {
        ...(profile.discovery?.health ?? {}),
        authenticated: 'missing',
        reasons: [...new Set([...(profile.discovery?.health?.reasons ?? []), '本机 harness 凭据不可用'])],
      },
    };
    this.profiles.set(profile);
    this.emit('diagnostics', { kind: 'profile-health', profileId, error: error?.toJSON?.() ?? error });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.ready.catch(() => undefined);
    await Promise.all([...this.live.keys()].map((id) => this.stop(id).catch(() => undefined)));
    await this.store.close();
  }
}
