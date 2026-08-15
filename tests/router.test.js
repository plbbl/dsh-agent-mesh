import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MeshRouter } from '../src/router.js';
import { MeshRuntime } from '../src/runtime.js';

function discoveredProfile(id, harness, model, health = {}) {
  return {
    id,
    harness,
    transport: 'mock',
    command: 'fixture',
    model,
    discovery: {
      detected: true,
      health: { state: 'detected', authenticated: 'unknown', ...health },
      models: [{ id: model, label: model, contextWindow: 32_000 }],
    },
  };
}

test('router keeps routine work single-path and gates fan-out by explicit mode and budget', () => {
  const runtime = {
    listProfiles: () => [
      discoveredProfile('flash', 'omp', 'deepseek-v4-flash'),
      discoveredProfile('specialist', 'claude-code', 'glm-5.2'),
      discoveredProfile('judge', 'codex', 'gpt-5.6-luna'),
      discoveredProfile('missing', 'opencode', 'opencode-go/deepseek-v4-pro', { authenticated: 'missing' }),
    ],
  };
  const router = new MeshRouter(runtime);

  const routine = router.plan({ prompt: '把这句话改写得更自然' });
  assert.equal(routine.branches.length, 1);
  assert.equal(routine.judge, undefined);
  assert.equal(routine.budget.estimatedCalls, 1);
  assert.equal(routine.candidates.some((candidate) => candidate.profileId === 'missing'), false);

  const panel = router.plan({
    prompt: '请对这个复杂代码架构做独立审查，比较两个方案并给出反例',
    mode: 'panel',
    maxCalls: 4,
    maxBranches: 2,
    positionSwap: true,
  });
  assert.equal(panel.branches.length, 2);
  assert.equal(panel.judge.role, 'judge');
  assert.equal(panel.judge.passes, 2);
  assert.equal(panel.budget.estimatedCalls, 4);
});

test('router runs bounded branches and maps swapped blind-judge votes to original candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mesh-router-'));
  let judgeCalls = 0;
  const adapter = {
    async open(profile) {
      return {
        nativeSessionId: `native-${profile.id}`,
        capabilities: { persistent: true, resume: true, streaming: false },
        prompt: async (_text, options = {}) => {
          if (options.source === 'mesh-router-judge') {
            judgeCalls += 1;
            return { text: judgeCalls === 1 ? '{"winner":"B"}' : '{"winner":"A"}' };
          }
          return { text: profile.model === 'deepseek-v4-flash' ? 'flash answer' : 'specialist answer' };
        },
        close: async () => undefined,
      };
    },
  };
  try {
    const runtime = new MeshRuntime({
      homeDir: root,
      autoDiscover: false,
      includeDefaults: false,
      profiles: [
        discoveredProfile('flash', 'omp', 'deepseek-v4-flash'),
        discoveredProfile('specialist', 'claude-code', 'glm-5.2'),
        discoveredProfile('judge', 'codex', 'gpt-5.6-luna'),
      ],
      adapters: { mock: adapter },
    });
    await runtime.ready;
    const result = await runtime.route({
      prompt: '请对这个复杂代码架构做独立审查，比较两个方案并给出反例',
      sessionId: 'bounded-route',
      mode: 'panel',
      maxCalls: 4,
      maxBranches: 2,
      positionSwap: true,
    });

    assert.equal(judgeCalls, 2);
    assert.equal(result.text, 'specialist answer');
    assert.equal(result.route.budgetUsed, 4);
    assert.equal(result.route.aggregation.method, 'blind-pairwise-selection');
    assert.equal(result.route.selected.profileId, 'specialist');
    assert.equal(runtime.listAgents().filter((agent) => agent.id.includes('bounded-route')).length, 3);
    await runtime.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
