import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { MeshError, assertMesh, asMeshError } from './errors.js';
import { redact, truncateText } from './redact.js';

const TERMINAL = new Set(['delivered', 'completed', 'failed', 'cancelled']);

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
    error: message.error,
  };
}

const MESSAGE_KINDS = new Set(['message', 'task', 'question', 'review', 'result', 'handoff', 'status', 'error', 'cancel', 'reply']);

function boundedString(value, max = 256) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text ? truncateText(text, max) : undefined;
}

function boundedArtifacts(value) {
  if (!Array.isArray(value)) return undefined;
  const output = value.slice(0, 32).map((item) => {
    if (typeof item === 'string') return { type: 'text', value: truncateText(item, 4 * 1024) };
    if (!item || typeof item !== 'object') return undefined;
    return redact({
      type: boundedString(item.type, 64) ?? 'artifact',
      name: boundedString(item.name, 256),
      path: boundedString(item.path, 1024),
      uri: boundedString(item.uri, 2048),
      value: typeof item.value === 'string' ? truncateText(item.value, 4 * 1024) : undefined,
      status: boundedString(item.status, 64),
    }, { maxBytes: 8 * 1024 });
  }).filter(Boolean);
  return output.length ? output : undefined;
}

export class MessageBus extends EventEmitter {
  constructor(options) {
    super();
    this.state = options.state;
    this.append = options.append;
    this.deliver = options.deliver;
    this.logger = options.logger;
    this.maxBytes = options.maxBytes ?? 256 * 1024;
    this.inFlight = new Set();
  }

  async send(input) {
    const from = String(input?.from ?? '').trim();
    const to = String(input?.to ?? '').trim();
    const text = String(input?.text ?? '');
    assertMesh(from, 'MESSAGE_FROM_REQUIRED', 'Message sender is required.');
    assertMesh(to, 'MESSAGE_TO_REQUIRED', 'Message target is required.');
    assertMesh(text.trim(), 'MESSAGE_TEXT_REQUIRED', 'Message text is required.');
    assertMesh(Buffer.byteLength(text, 'utf8') <= this.maxBytes, 'MESSAGE_TOO_LARGE', `Message exceeds ${this.maxBytes} bytes.`);
    const kind = String(input.kind ?? 'message').trim().toLowerCase();
    assertMesh(kind.length <= 32, 'MESSAGE_KIND_TOO_LARGE', 'Message kind is too long.');
    const idempotencyKey = boundedString(input.idempotencyKey ?? input.metadata?.idempotencyKey, 256);
    if (idempotencyKey) {
      const existing = Object.values(this.state.messages).find((item) => item.idempotencyKey === idempotencyKey && item.from === from && item.to === to);
      if (existing) return messagePreview(existing);
    }
    const now = Date.now();
    const message = {
      id: input.id ?? randomUUID(),
      from,
      to,
      text,
      kind: MESSAGE_KINDS.has(kind) ? kind : 'message',
      replyTo: input.replyTo ? String(input.replyTo) : undefined,
      parentId: boundedString(input.parentId, 128),
      traceId: boundedString(input.traceId, 128) ?? boundedString(input.parentId, 128) ?? randomUUID(),
      expectsReply: input.expectsReply !== false,
      idempotencyKey,
      artifacts: boundedArtifacts(input.artifacts),
      metadata: input.metadata && typeof input.metadata === 'object' ? redact(input.metadata, { maxBytes: 16 * 1024 }) : undefined,
      deadlineAt: Number.isFinite(Number(input.deadlineAt)) ? Number(input.deadlineAt) : undefined,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      attempts: 0,
    };
    assertMesh(!this.state.messages[message.id], 'MESSAGE_ID_CONFLICT', `Message already exists: ${message.id}.`);
    await this.append('message/created', message);
    this.emit('created', messagePreview(message));
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
        await this.append('message/status', { id: message.id, status: 'cancelled', completion: { reason: 'deadline-exceeded' }, updatedAt: Date.now() });
        this.emit('delivered', messagePreview(this.state.messages[message.id]));
        return;
      }
      await this.append('message/status', {
        id: message.id,
        status: 'processing',
        attempts: (current.attempts ?? 0) + 1,
        updatedAt: Date.now(),
      });
      await this.deliver({ ...this.state.messages[message.id] });
      if (!TERMINAL.has(this.state.messages[message.id]?.status)) {
        await this.append('message/status', { id: message.id, status: 'delivered', updatedAt: Date.now() });
      }
      this.emit('delivered', messagePreview(this.state.messages[message.id]));
    } catch (error) {
      const normalized = asMeshError(error);
      try {
        await this.append('message/status', {
          id: message.id,
          status: 'failed',
          error: normalized.toJSON(),
          updatedAt: Date.now(),
        });
      } catch (appendError) {
        this.logger?.error?.({ error: appendError, messageId: message.id }, 'failed to persist message failure');
      }
      this.emit('failed', { ...messagePreview(this.state.messages[message.id] ?? message), error: normalized.toJSON() });
    } finally {
      this.inFlight.delete(message.id);
    }
  }

  async retryPending() {
    const pending = Object.values(this.state.messages)
      .filter((message) => message.status === 'queued' || message.status === 'processing')
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const message of pending) void this.#deliver(message);
    return pending.length;
  }

  async markCompleted(id, metadata = undefined) {
    const message = this.#get(id);
    if (TERMINAL.has(message.status)) return messagePreview(message);
    await this.append('message/status', { id, status: 'completed', ...(metadata ? { completion: redact(metadata, { maxBytes: 16 * 1024 }) } : {}), updatedAt: Date.now() });
    return messagePreview(this.state.messages[id]);
  }

  async markFailed(id, error) {
    const message = this.#get(id);
    const normalized = asMeshError(error);
    await this.append('message/status', { id, status: 'failed', error: normalized.toJSON(), updatedAt: Date.now() });
    return messagePreview(this.state.messages[id]);
  }

  async cancel(id, reason = 'cancelled') {
    const message = this.#get(id);
    if (TERMINAL.has(message.status)) return messagePreview(message);
    await this.append('message/status', { id, status: 'cancelled', completion: { reason: boundedString(reason, 512) ?? 'cancelled' }, updatedAt: Date.now() });
    return messagePreview(this.state.messages[id]);
  }

  list(options = {}) {
    const target = options.to ? String(options.to) : undefined;
    const sender = options.from ? String(options.from) : undefined;
    const after = options.after ? Number(options.after) : 0;
    const limit = Math.min(500, Math.max(1, Number(options.limit ?? 100)));
    return Object.values(this.state.messages)
      .filter((message) => (!target || message.to === target) && (!sender || message.from === sender) && message.createdAt > after)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-limit)
      .map(messagePreview);
  }

  #get(id) {
    const message = this.state.messages[id];
    if (!message) throw new MeshError('MESSAGE_NOT_FOUND', `Message not found: ${id}.`, { id });
    return message;
  }
}
