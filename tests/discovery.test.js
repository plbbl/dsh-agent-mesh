import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { discoverLocalHarnesses, parseJsonc, parseTomlLite, parseYamlLite, publicDiscovery } from '../src/discovery.js';

test('lightweight config readers expose model metadata without a dependency', () => {
  const toml = parseTomlLite('default_model = "kimi-code/k3"\n[models."kimi-code/k3"]\nprovider = "managed:kimi-code"\nmodel = "k3"');
  assert.equal(toml.default_model, 'kimi-code/k3');
  assert.equal(toml.models['kimi-code/k3'].model, 'k3');
  const yaml = parseYamlLite('modelRoles:\n  default: openai/gpt-5\nproviders:\n  local:\n    models:\n      - id: llama\n        name: Llama\n');
  assert.equal(yaml.modelRoles.default, 'openai/gpt-5');
  assert.equal(yaml.providers.local.models[0].id, 'llama');
  const jsonc = parseJsonc('{"endpoint":"https://gateway.example/v1", // comment\n"model":"provider/model",\n}');
  assert.equal(jsonc.endpoint, 'https://gateway.example/v1');
  assert.equal(jsonc.model, 'provider/model');
});

test('discovery reuses configured Zed ACP servers without projecting env secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mesh-discovery-'));
  try {
    const configDir = join(root, '.config', 'zed');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({
      agent_servers: {
        'local reviewer': {
          command: process.execPath,
          args: ['-e', 'process.stdin.resume()'],
          env: { DSH_SAFE_FLAG: '1', API_KEY: 'must-not-leak' },
          model: 'review-model',
        },
      },
    }));

    const report = await discoverLocalHarnesses({ userHome: root, maxModelsPerHarness: 8 });
    const server = report.harnesses.find((item) => item.id === 'zed-local-reviewer');
    assert.ok(server);
    assert.equal(server.transport, 'acp');
    assert.equal(server.detected, true);
    assert.equal(server.modelCount, 1);
    const profile = report.profiles.find((item) => item.id === 'zed-local-reviewer');
    assert.equal(profile.env.DSH_SAFE_FLAG, '1');
    assert.equal(profile.env.API_KEY, undefined);
    const publicReport = publicDiscovery(report);
    const publicProfile = publicReport.profiles.find((item) => item.id === 'zed-local-reviewer');
    assert.equal(publicProfile.env, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex discovery reads visible models from models_cache.json without promoting nested metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-discovery-'));
  try {
    await writeFile(join(root, 'config.toml'), 'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "max"\n');
    await writeFile(join(root, 'models_cache.json'), JSON.stringify({
      models: [
        {
          slug: 'gpt-5.6-luna',
          display_name: 'GPT-5.6-Luna',
          visibility: 'list',
          context_window: 272000,
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'max' }],
          service_tiers: [{ id: 'priority', name: 'Fast' }],
        },
        {
          slug: 'gpt-5.6-sol',
          display_name: 'GPT-5.6-Sol',
          visibility: 'list',
          upgrade: { model: 'gpt-5.6-terra' },
        },
        { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide' },
      ],
    }));

    const report = await discoverLocalHarnesses({ codexHome: root, userHome: root, maxModelsPerHarness: 8 });
    const codex = report.harnesses.find((item) => item.id === 'codex-local');
    assert.deepEqual(codex.models.map((item) => item.id), ['gpt-5.6-luna', 'gpt-5.6-sol']);
    assert.equal(codex.models.find((item) => item.id === 'gpt-5.6-luna').reasoning.defaultEffort, 'medium');
    assert.equal(codex.models.find((item) => item.id === 'gpt-5.6-luna').contextWindow, 272000);
    assert.equal(codex.configFiles.find((item) => item.kind === 'codex-models').modelCount, 2);
    assert.equal(report.profiles.some((item) => item.model === 'priority'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('OMP discovery uses ACP and preserves provider/model identity from native config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-omp-discovery-'));
  try {
    const configDir = join(root, '.omp', 'agent');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'config.yml'), 'enabledModels:\n  - opencode-go/deepseek-v4-pro\n  - OpenAI/gpt-5.6-luna\n');
    await writeFile(join(configDir, 'models.yml'), 'providers:\n  OpenAI:\n    models:\n      - id: gpt-5.6-luna\n        name: Luna\n        reasoning: true\n        thinking:\n          minLevel: low\n          maxLevel: max\n');
    const report = await discoverLocalHarnesses({ userHome: root, maxModelsPerHarness: 16 });
    const omp = report.harnesses.find((item) => item.id === 'omp-rpc');
    assert.equal(omp.transport, 'acp');
    const ompProfile = report.profiles.find((item) => item.id === 'omp-rpc');
    assert.equal(ompProfile.promptTimeoutMs, 10 * 60_000);
    assert.ok(omp.models.some((item) => item.id === 'opencode-go/deepseek-v4-pro'));
    const luna = omp.models.find((item) => item.id === 'OpenAI/gpt-5.6-luna');
    assert.deepEqual(luna.reasoning.efforts.map((item) => item.id), ['low', 'medium', 'high', 'xhigh', 'max']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('OMP discovery merges the native model catalog without exposing provider credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-omp-catalog-'));
  const previousPath = process.env.PATH;
  try {
    const bin = join(root, 'bin');
    await mkdir(bin, { recursive: true });
    const executable = join(bin, 'omp');
    await writeFile(executable, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ models: [{ provider: \'catalog-provider\', id: \'catalog-model\', name: \'Catalog Model\', reasoning: true, thinking: [\'low\', \'high\'], contextWindow: 123456, apiKey: \'must-not-project\' }] }));\n');
    await chmod(executable, 0o755);
    process.env.PATH = `${bin}:${previousPath ?? ''}`;

    const report = await discoverLocalHarnesses({ userHome: root, cwd: root, maxModelsPerHarness: 16 });
    const omp = report.harnesses.find((item) => item.id === 'omp-rpc');
    const model = omp.models.find((item) => item.id === 'catalog-provider/catalog-model');
    assert.ok(model);
    assert.equal(model.label, 'Catalog Model');
    assert.deepEqual(model.reasoning.efforts.map((item) => item.id), ['low', 'high']);
    assert.equal(model.apiKey, undefined);
  } finally {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
