import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MeshRuntime } from '../src/runtime.js';
import { MeshError } from '../src/errors.js';

async function eventually(check, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition did not become true');
}

function options(homeDir) {
  return {
    homeDir,
    autoDiscover: false,
    includeDefaults: false,
    profiles: [{ id: 'mock', harness: 'mock', transport: 'mock', command: 'mock' }],
    snapshotEvery: 4,
  };
}

test('runtime resumes sessions and delivers cross-session messages durably', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mesh-runtime-'));
  try {
    const runtime = new MeshRuntime(options(root));
    await runtime.ready;
    const started = await runtime.start('mock', { sessionId: 'worker' });
    assert.equal(started.id, 'worker');
    assert.equal((await runtime.send('worker', 'first')).text, 'mock: first');
    const queued = await runtime.sendMessage({ from: 'dsh', to: 'worker', text: 'review this', kind: 'review' });
    assert.equal(queued.status, 'queued');
    await eventually(() => runtime.inbox({ to: 'worker' })[0]?.status === 'completed');
    await runtime.close();

    const resumed = new MeshRuntime(options(root));
    await resumed.ready;
    assert.equal(resumed.listAgents()[0].nativeSessionId, started.nativeSessionId);
    assert.equal(resumed.inbox({ to: 'worker' })[0].status, 'completed');
    await resumed.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('mesh sessions return one bounded reply hop across harness boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mesh-reply-'));
  try {
    const runtime = new MeshRuntime(options(root));
    await runtime.ready;
    await runtime.start('mock', { sessionId: 'planner' });
    await runtime.start('mock', { sessionId: 'worker' });
    await runtime.sendMessage({ from: 'planner', to: 'worker', text: 'inspect the change', kind: 'task' });
    await eventually(() => runtime.inbox({ to: 'planner' }).some((message) => message.kind === 'reply' && message.status === 'completed'));
    const reply = runtime.inbox({ to: 'planner' }).find((message) => message.kind === 'reply');
    assert.match(reply.text, /mock:/);
    assert.equal(runtime.inbox({ to: 'worker' }).filter((message) => message.kind === 'reply').length, 0);
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DSH-originated messages expose the target reply through a mailbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mesh-mailbox-'));
  try {
    const runtime = new MeshRuntime(options(root));
    await runtime.ready;
    await runtime.start('mock', { sessionId: 'worker' });
    await runtime.sendMessage({
      from: 'dsh-parent',
      to: 'worker',
      text: 'summarize the result',
      kind: 'handoff',
      metadata: { mailbox: true },
    });
    await eventually(() => runtime.inbox({ to: 'dsh-parent' }).some((message) => message.kind === 'reply' && message.status === 'completed'));
    const reply = runtime.inbox({ to: 'dsh-parent' }).find((message) => message.kind === 'reply');
    assert.equal(reply.metadata, undefined);
    assert.match(reply.text, /mock:/);
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime repairs a stale native session without user intervention', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mesh-recovery-'));
  let resumeAttempt = false;
  const adapter = {
    async open(_profile, options = {}) {
      if (options.nativeSessionId && !resumeAttempt) {
        resumeAttempt = true;
        throw new MeshError('SESSION_NOT_FOUND', 'native session no longer exists');
      }
      const nativeSessionId = options.nativeSessionId ?? 'fresh-native-session';
      return {
        nativeSessionId,
        capabilities: { persistent: true, resume: true, streaming: true },
        prompt: async (text) => ({ text: `recovered: ${text}`, nativeSessionId }),
        close: async () => undefined,
      };
    },
  };
  const profile = { id: 'flaky', harness: 'flaky', transport: 'mock', command: 'fixture' };
  try {
    const first = new MeshRuntime({ homeDir: root, autoDiscover: false, includeDefaults: false, profiles: [profile], adapters: { mock: adapter } });
    await first.ready;
    await first.start('flaky', { sessionId: 'recoverable' });
    await first.stop('recoverable');
    await first.close();

    const resumed = new MeshRuntime({ homeDir: root, autoDiscover: false, includeDefaults: false, profiles: [profile], adapters: { mock: adapter } });
    await resumed.ready;
    const result = await resumed.send('recoverable', 'continue', { source: 'test' });
    assert.equal(result.text, 'recovered: continue');
    assert.equal(resumed.listAgents().find((agent) => agent.id === 'recoverable').nativeSessionId, 'fresh-native-session');
    assert.equal(resumed.sessionNeedsHandoff('recoverable'), false);
    await resumed.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime normalizes native credential failures and disables the failed model route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mesh-credential-'));
  const profile = {
    id: 'omp-model',
    harness: 'omp',
    transport: 'mock',
    command: 'fixture',
    model: 'opencode-go/deepseek-v4-pro',
    discovery: {
      detected: true,
      health: { state: 'detected', authenticated: 'unknown', reasons: [] },
    },
  };
  const adapter = {
    async open() {
      return {
        nativeSessionId: 'credential-session',
        capabilities: { persistent: true, resume: true, streaming: true },
        prompt: async () => { throw new MeshError('RPC_REMOTE_ERROR', 'no credential for provider route; OPENCODE_GO_API_KEY is not set'); },
        close: async () => undefined,
      };
    },
  };
  try {
    const runtime = new MeshRuntime({ homeDir: root, autoDiscover: false, includeDefaults: false, profiles: [profile], adapters: { mock: adapter } });
    await runtime.ready;
    await runtime.start('omp-model', { sessionId: 'credential-route' });
    await assert.rejects(() => runtime.send('credential-route', 'hello'), (error) => {
      assert.equal(error.code, 'MISSING_CREDENTIAL');
      assert.doesNotMatch(error.message, /OPENCODE_GO_API_KEY/);
      return true;
    });
    const stored = runtime.listProfiles().find((item) => item.id === 'omp-model');
    assert.equal(stored.discovery.health.authenticated, 'missing');
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DSH host agents are delivered in-process and never spawned as a CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mesh-host-'));
  const received = [];
  const dsh = {
    list: () => [{ id: 'host-agent', status: 'idle' }],
    has: (id) => id === 'host-agent',
    deliver: (id, text) => { received.push({ id, text }); },
  };
  try {
    const runtime = new MeshRuntime({ homeDir: root, autoDiscover: false, includeDefaults: true, dsh });
    await runtime.ready;
    const message = await runtime.sendMessage({ from: 'dsh:current', to: 'host-agent', text: 'review this', kind: 'review' });
    await eventually(() => runtime.inbox({ to: 'host-agent' })[0]?.status === 'completed');
    assert.equal(message.kind, 'review');
    assert.equal(received[0].id, 'host-agent');
    assert.match(received[0].text, /review this/);
    assert.equal(runtime.listAgents().find((agent) => agent.id === 'host-agent').harness, 'dsh');
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
