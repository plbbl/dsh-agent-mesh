import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { JsonRpcProcess } from '../src/json-rpc.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rpc-echo.js');

test('json-rpc process correlates requests and answers server requests', async () => {
  const notifications = [];
  const rpc = new JsonRpcProcess({
    command: process.execPath,
    args: [fixture],
    protocol: 'jsonrpc',
    onNotification: (message) => notifications.push(message),
    onRequest: async (method) => method === 'permission/request' ? { decision: 'decline' } : {},
  });
  await rpc.start();
  try {
    assert.deepEqual(await rpc.request('initialize'), { ok: true });
    assert.deepEqual(await rpc.request('ping'), { pong: true });
    assert.equal(notifications.length, 0);
  } finally {
    await rpc.close();
  }
});
