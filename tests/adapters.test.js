import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { AcpAdapter } from '../src/adapters/acp.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { ZcodeAdapter } from '../src/adapters/zcode.js';
import { RpcAgentAdapter } from '../src/adapters/rpc-agent.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rpc-echo.js');
const claudeFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-echo.js');
const rpcReadyFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rpc-ready.js');
const rpcChunkFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rpc-chunk.js');
const rpcHangFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rpc-hang.js');
const acpSlowFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-slow.js');
const acpBrokenResumeFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp-broken-resume.js');

test('ACP adapter keeps session id and normalized text', async () => {
  const events = [];
  const adapter = new AcpAdapter();
  const handle = await adapter.open({ id: 'fixture', command: process.execPath, args: [fixture], transport: 'acp', timeoutMs: 2_000, permissionPolicy: 'reject' }, { cwd: process.cwd(), onEvent: (value) => events.push(value) });
  try {
    const result = await handle.prompt('hello');
    assert.equal(result.nativeSessionId, 'fixture-session');
    assert.equal(result.text, 'fixture answer');
    assert.ok(events.some((item) => item.kind === 'assistant_delta'));
  } finally { await handle.close(); }
});

test('ACP adapter falls back to config options for Kimi-style model selection', async () => {
  const adapter = new AcpAdapter();
  const handle = await adapter.open({
    id: 'fixture-model',
    command: process.execPath,
    args: [fixture],
    transport: 'acp',
    model: 'kimi-code/k3',
    modelConfigMethod: 'session/set_config_option',
    modelConfigId: 'model',
    strictModel: true,
    timeoutMs: 2_000,
    permissionPolicy: 'reject',
  }, { cwd: process.cwd() });
  try {
    assert.equal((await handle.prompt('hello')).text, 'fixture answer');
  } finally { await handle.close(); }
});

test('ACP adapter uses a separate longer timeout for prompt turns', async () => {
  const adapter = new AcpAdapter();
  const handle = await adapter.open({
    id: 'fixture-slow',
    command: process.execPath,
    args: [acpSlowFixture],
    transport: 'acp',
    timeoutMs: 80,
    promptTimeoutMs: 250,
    permissionPolicy: 'reject',
  }, { cwd: process.cwd() });
  try {
    assert.equal((await handle.prompt('slow')).text, 'slow fixture answer');
  } finally { await handle.close(); }
});

test('OMP ACP adapter replaces a native session that fails to load internally', async () => {
  const adapter = new AcpAdapter();
  const handle = await adapter.open({
    id: 'omp-broken-resume',
    harness: 'omp',
    command: process.execPath,
    args: [acpBrokenResumeFixture],
    transport: 'acp',
    timeoutMs: 2_000,
    permissionPolicy: 'reject',
  }, { cwd: process.cwd(), nativeSessionId: 'stale-session' });
  try {
    assert.equal(handle.nativeSessionId, 'fresh-omp-session');
    assert.equal(handle.handoffRequired, true);
  } finally { await handle.close(); }
});

test('Codex adapter uses app-server thread/turn lifecycle', async () => {
  const adapter = new CodexAdapter();
  const handle = await adapter.open({ id: 'fixture', command: process.execPath, args: [fixture], transport: 'codex', timeoutMs: 2_000, permissionPolicy: 'reject' }, { cwd: process.cwd() });
  try {
    const result = await handle.prompt('hello');
    assert.equal(result.nativeSessionId, 'fixture-thread');
    assert.equal(result.text, 'fixture codex answer');
  } finally { await handle.close(); }
});

test('Claude adapter keeps the native stream process alive across prompts', async () => {
  const adapter = new ClaudeAdapter();
  const handle = await adapter.open({ id: 'fixture', command: process.execPath, args: [claudeFixture], transport: 'claude', timeoutMs: 2_000 }, { cwd: process.cwd() });
  try {
    const first = await handle.prompt('one');
    const second = await handle.prompt('two');
    assert.equal(first.text, 'fixture claude answer');
    assert.equal(second.nativeSessionId, 'fixture-claude-session');
  } finally { await handle.close(); }
});

test('ZCode adapter does not add a JSON-RPC 2.0 envelope', async () => {
  const adapter = new ZcodeAdapter();
  const handle = await adapter.open({ id: 'fixture', command: process.execPath, args: [fixture], transport: 'zcode', timeoutMs: 2_000 }, { cwd: process.cwd() });
  try {
    const result = await handle.prompt('hello');
    assert.equal(result.nativeSessionId, 'fixture-zcode-session');
    assert.equal(result.text, 'fixture zcode answer');
  } finally { await handle.close(); }
});

test('RPC adapter waits for ready, separates prompt acknowledgement from agent completion, and selects model natively', async () => {
  const adapter = new RpcAgentAdapter();
  const handle = await adapter.open({
    id: 'rpc-ready',
    command: process.execPath,
    args: [rpcReadyFixture],
    transport: 'rpc',
    readyRequired: true,
    negotiateProtocol: true,
    rpcSessionControl: true,
    model: 'deepseek-v4-pro',
    modelInArgs: false,
    modelMethod: 'set_model',
    promptCompletesOnResponse: false,
    timeoutMs: 2_000,
  }, { cwd: process.cwd() });
  try {
    const result = await handle.prompt('hello');
    assert.equal(result.nativeSessionId, 'rpc-ready-session');
    assert.equal(result.text, 'rpc answer');
  } finally { await handle.close(); }
});

test('RPC adapter reassembles bounded out-of-order rpc_chunk frames', async () => {
  const adapter = new RpcAgentAdapter();
  const handle = await adapter.open({
    id: 'rpc-chunk',
    command: process.execPath,
    args: [rpcChunkFixture],
    transport: 'rpc',
    readyRequired: true,
    rpcSessionControl: true,
    promptCompletesOnResponse: false,
    timeoutMs: 2_000,
  }, { cwd: process.cwd() });
  try {
    const result = await handle.prompt('hello');
    assert.equal(result.nativeSessionId, 'rpc-chunk-session');
    assert.equal(result.text, 'chunk answer');
  } finally { await handle.close(); }
});

test('RPC adapter times out a prompt that never reaches agent_end', async () => {
  const adapter = new RpcAgentAdapter();
  const handle = await adapter.open({
    id: 'rpc-hang',
    command: process.execPath,
    args: [rpcHangFixture],
    transport: 'rpc',
    readyRequired: true,
    rpcSessionControl: true,
    promptCompletesOnResponse: false,
    timeoutMs: 80,
  }, { cwd: process.cwd() });
  try {
    await assert.rejects(() => handle.prompt('hang'), (error) => error?.code === 'RPC_PROMPT_TIMEOUT');
  } finally {
    await handle.close();
  }
});
