import assert from 'node:assert/strict';
import test from 'node:test';

import { checkNativeModelRoute } from '../src/model-readiness.js';

function fakeApi(configured) {
  return {
    llm: {
      providers: async () => ({ result: { ok: true, value: { providers: [{ provider: 'gateway-pro', settingsNs: 'native-gateway', settingsPath: ['providers', 'gateway-pro'] }] } } }),
    },
    settings: {
      describe: async () => ({ result: { ok: true, value: { namespaces: [{ ns: 'native-gateway', value: { providers: { 'gateway-pro': { apiKeyEnv: 'GATEWAY_API_KEY' } } } }] } } }),
    },
    credentials: {
      describe: async () => ({ result: { ok: true, value: { credentials: { GATEWAY_API_KEY: { configured, writable: true } } } } }),
    },
  };
}

test('native model readiness blocks a declared but missing credential without reading its value', async () => {
  const result = await checkNativeModelRoute(fakeApi(false), { provider: 'gateway-pro', model: 'model-a' });
  assert.deepEqual(result, { state: 'missing', ref: 'GATEWAY_API_KEY' });
});

test('native model readiness allows a configured credential', async () => {
  const result = await checkNativeModelRoute(fakeApi(true), { provider: 'gateway-pro', model: 'model-a' });
  assert.deepEqual(result, { state: 'ready', ref: 'GATEWAY_API_KEY' });
});

test('provider-native and Mesh routes remain fail-open', async () => {
  const api = fakeApi(false);
  assert.deepEqual(await checkNativeModelRoute(api, { provider: 'mesh:omp', model: 'deepseek-v4-pro' }), { state: 'unknown' });
  assert.deepEqual(await checkNativeModelRoute({ llm: api.llm, settings: api.settings }, { provider: 'gateway-pro', model: 'model-a' }), { state: 'unknown' });
});
