import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EventStore } from '../src/event-store.js';
import { MeshError } from '../src/errors.js';
import { MessageBus } from '../src/message-bus.js';
import { redact } from '../src/redact.js';

test('redaction removes credential-shaped fields before projection', () => {
  const value = redact({ token: 'secret', nested: { api_key: 'secret2', safe: 'kept' } });
  assert.equal(value.token, '[redacted]');
  assert.equal(value.nested.api_key, '[redacted]');
  assert.equal(value.nested.safe, 'kept');
});

test('message bus rejects oversized messages before persistence', async () => {
  const state = { messages: {} };
  const bus = new MessageBus({ state, maxBytes: 8, append: async () => undefined, deliver: async () => undefined });
  await assert.rejects(() => bus.send({ from: 'a', to: 'b', text: '123456789' }), (error) => error instanceof MeshError && error.code === 'MESSAGE_TOO_LARGE');
});

test('message bus makes retries idempotent and supports cancellation', async () => {
  const state = { messages: {} };
  const bus = new MessageBus({ state, append: async (type, data) => {
    if (type === 'message/created') state.messages[data.id] = data;
    if (type === 'message/status') state.messages[data.id] = { ...state.messages[data.id], ...data };
  }, deliver: async () => new Promise(() => {}) });
  const first = await bus.send({ from: 'a', to: 'b', text: 'once', idempotencyKey: 'retry-1', expectsReply: false });
  const second = await bus.send({ from: 'a', to: 'b', text: 'once', idempotencyKey: 'retry-1', expectsReply: false });
  assert.equal(second.id, first.id);
  assert.equal(second.traceId, state.messages[first.id].traceId);
  assert.equal((await bus.cancel(first.id, 'user')).status, 'cancelled');
});

test('event snapshots use private file permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mesh-security-'));
  try {
    const store = new EventStore(root, { snapshotEvery: 1 });
    const apply = (state, event) => { state.ok = event.data.ok; };
    await store.open({}, apply);
    await store.append('check', { ok: true }, apply);
    await store.close();
    const info = await stat(join(root, 'snapshot.json'));
    const logInfo = await stat(join(root, 'events.jsonl'));
    const rootInfo = await stat(root);
    assert.equal(info.mode & 0o077, 0);
    assert.equal(logInfo.mode & 0o077, 0);
    assert.equal(rootInfo.mode & 0o077, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
