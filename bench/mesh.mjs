import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MeshRuntime } from '../src/index.js';

const root = await mkdtemp(join(tmpdir(), 'dsh-mesh-bench-'));
const runtime = new MeshRuntime({
  homeDir: root,
  autoDiscover: false,
  includeDefaults: false,
  snapshotEvery: 512,
  profiles: [{ id: 'mock', harness: 'mock', transport: 'mock', command: 'mock' }],
});

try {
  await runtime.ready;
  await runtime.start('mock', { sessionId: 'bench-agent' });
  const count = Number(process.env.MESH_BENCH_N ?? 1_000);
  const start = performance.now();
  await Promise.all(Array.from({ length: count }, (_, index) => runtime.sendMessage({
    from: 'bench',
    to: 'bench-agent',
    text: `message-${index}`,
    kind: 'benchmark',
    // Keep this throughput probe one-way. DSH-originated messages intentionally
    // use the mailbox reply path; that behavior is covered by runtime tests.
    metadata: { mailbox: false },
  })));
  const enqueueMs = performance.now() - start;
  const drainStart = performance.now();
  while (runtime.inbox({ to: 'bench-agent', limit: count }).some((message) => message.status === 'processing' || message.status === 'queued')) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const drainMs = performance.now() - drainStart;
  process.stdout.write(`${JSON.stringify({
    messages: count,
    enqueuePerSecond: Math.round(count / (enqueueMs / 1_000)),
    drainPerSecond: Math.round(count / (drainMs / 1_000)),
    enqueueMs: Number(enqueueMs.toFixed(2)),
    drainMs: Number(drainMs.toFixed(2)),
    state: 'append-only + snapshot + per-session FIFO (one-way)',
  }, null, 2)}\n`);
} finally {
  await runtime.close();
  await rm(root, { recursive: true, force: true });
}
