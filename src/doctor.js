import { spawnSync } from 'node:child_process';

import { JsonRpcProcess } from './json-rpc.js';
import { redact } from './redact.js';

function commandResult(command, args, timeoutMs = 3_000) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 128 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    timedOut: result.error?.code === 'ETIMEDOUT',
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message,
  };
}

function issue(code, message, details = undefined) {
  return { code, message, ...(details ? { details } : {}) };
}

function staticCheck(harness) {
  const health = harness.health ?? {};
  const checks = [{ name: 'binary', state: harness.detected ? 'ok' : 'missing', path: harness.commandPath }];
  const issues = [];
  if (!harness.detected) issues.push(issue('BINARY_NOT_FOUND', '本机没有找到此 harness 的可执行文件。'));
  for (const file of harness.configFiles ?? []) {
    checks.push({ name: `config:${file.kind}`, state: file.readable === false ? 'invalid' : 'ok', path: file.path });
    if (file.readable === false) issues.push(issue('CONFIG_INVALID', `配置无法读取或解析：${file.path}`, { message: file.message }));
  }
  return { checks, issues, health };
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function probeClaude(harness) {
  if (!harness.detected) return { checks: [], issues: [] };
  const result = commandResult(harness.commandPath, ['auth', 'status', '--json']);
  const value = parseJson(result.stdout);
  const authenticated = typeof value?.loggedIn === 'boolean' ? value.loggedIn : undefined;
  const checks = [{ name: 'auth-status', state: authenticated === false ? 'missing' : authenticated === true ? 'ok' : result.ok ? 'ok' : 'unknown' }];
  const issues = [];
  if (authenticated === false) issues.push(issue('AUTH_MISSING', 'Claude Code 本机没有可用登录状态；Agent Mesh 不会复制或索要凭据。'));
  if (authenticated === undefined && !result.ok && !result.timedOut) issues.push(issue('AUTH_STATUS_UNKNOWN', 'Claude Code auth status 无法确认，首次请求会保留原生错误。'));
  return { checks, issues, authenticated: authenticated === undefined ? 'unknown' : authenticated ? 'ready' : 'missing' };
}

async function probeAcp(harness, options = {}) {
  if (!harness.detected) return { checks: [], issues: [] };
  let rpc;
  const checks = [];
  const issues = [];
  try {
    rpc = new JsonRpcProcess({ command: harness.commandPath, args: harness.args?.length ? harness.args : ['acp'], cwd: options.cwd ?? process.cwd(), timeoutMs: options.timeoutMs ?? 5_000, maxLineBytes: 8 * 1024 * 1024, protocol: 'jsonrpc' });
    const initialized = await rpc.start().then(() => rpc.request('initialize', { protocolVersion: 1, clientInfo: { name: 'dsh-agent-mesh-doctor', version: '0.1.0' }, clientCapabilities: {} }, options.timeoutMs ?? 5_000));
    await rpc.notify('initialized', {});
    checks.push({ name: 'acp-handshake', state: 'ok', protocolVersion: initialized?.protocolVersion });
    // Do not call session/new here. A health check must not create an empty
    // native transcript merely because DSH was opened.
  } catch (error) {
    issues.push(issue('ACP_UNAVAILABLE', 'ACP server 无法完成无模型调用的握手。', { message: error.message }));
  } finally {
    await rpc?.close().catch(() => undefined);
  }
  return { checks, issues };
}

function probeKimi(harness) {
  const config = (harness.configFiles ?? []).find((item) => item.readable && item.path);
  if (!harness.detected || !config) return { checks: [], issues: [] };
  const result = commandResult(harness.commandPath, ['doctor', 'config', config.path]);
  return {
    checks: [{ name: 'native-config-validator', state: result.ok ? 'ok' : 'invalid' }],
    issues: result.ok ? [] : [issue('CONFIG_INVALID', 'Kimi Code 原生 doctor 判定配置无效。', { output: redact(result.stderr || result.stdout, { maxBytes: 2_048 }) })],
  };
}

function probeOpenCode(harness) {
  if (!harness.detected) return { checks: [], issues: [] };
  const result = commandResult(harness.commandPath, ['auth', 'list']);
  return {
    checks: [{ name: 'native-auth-store', state: result.ok ? 'ok' : 'unknown' }],
    issues: result.ok ? [] : [issue('AUTH_STATUS_UNKNOWN', 'OpenCode auth list 无法确认本机 provider 状态；首次 ACP 请求会保留原生错误。')],
  };
}

async function probeCodex(harness, options = {}) {
  if (!harness.detected) return { checks: [], issues: [] };
  let rpc;
  const checks = [];
  const issues = [];
  try {
    rpc = new JsonRpcProcess({
      command: harness.commandPath,
      args: ['app-server', '--stdio'],
      cwd: options.cwd ?? process.cwd(),
      timeoutMs: options.timeoutMs ?? 4_000,
      maxLineBytes: 2 * 1024 * 1024,
      protocol: 'codex',
    });
    await rpc.start();
    await rpc.request('initialize', {
      clientInfo: { name: 'dsh-agent-mesh-doctor', version: '0.1.0' },
      capabilities: {},
    }, options.timeoutMs ?? 4_000);
    await rpc.notify('initialized', {});
    checks.push({ name: 'app-server-handshake', state: 'ok' });
    const account = await rpc.request('account/read', { refreshToken: false }, options.timeoutMs ?? 4_000).catch((error) => ({ error }));
    if (account?.error) {
      checks.push({ name: 'account-read', state: 'unknown' });
    } else {
      const accountValue = account?.account ?? account?.value ?? account;
      const authenticated = accountValue !== null && accountValue !== undefined;
      checks.push({ name: 'account-read', state: authenticated ? 'ok' : 'missing' });
      if (!authenticated) issues.push(issue('AUTH_MISSING', 'Codex app-server 没有报告可用账号。'));
    }
    const models = await rpc.request('model/list', { includeHidden: false }, options.timeoutMs ?? 4_000).catch((error) => ({ error }));
    checks.push({ name: 'model-list', state: models?.error ? 'unknown' : 'ok', count: Array.isArray(models?.data) ? models.data.length : Array.isArray(models?.models) ? models.models.length : undefined });
  } catch (error) {
    issues.push(issue('APP_SERVER_UNAVAILABLE', 'Codex app-server 无法完成无模型调用的握手。', { message: error.message }));
  } finally {
    await rpc?.close().catch(() => undefined);
  }
  return { checks, issues };
}

/**
 * Run bounded, no-turn diagnostics. No probe sends a user prompt or reads a
 * credential value. Results are intentionally safe to show in the DSH UI.
 */
export async function diagnose(report, options = {}) {
  const results = [];
  for (const harness of report?.harnesses ?? []) {
    const base = staticCheck(harness);
    let probe = {};
    if (harness.harness === 'codex') probe = await probeCodex(harness, options);
    else if (harness.harness === 'claude-code') probe = probeClaude(harness);
    else if (harness.harness === 'kimi') {
      probe = probeKimi(harness);
      const acp = await probeAcp(harness, options);
      probe = { checks: [...(probe.checks ?? []), ...(acp.checks ?? [])], issues: [...(probe.issues ?? []), ...(acp.issues ?? [])] };
    }
    else if (harness.harness === 'opencode') {
      const auth = probeOpenCode(harness);
      const acp = await probeAcp(harness, options);
      probe = { checks: [...(auth.checks ?? []), ...(acp.checks ?? [])], issues: [...(auth.issues ?? []), ...(acp.issues ?? [])] };
    }
    else if (harness.transport === 'acp') probe = await probeAcp(harness, options);
    else if (harness.transport === 'rpc') probe = { checks: [{ name: 'rpc-transport', state: harness.detected ? 'deferred' : 'missing' }], issues: [] };
    else if (harness.harness === 'zcode') probe = { checks: [{ name: 'custom-protocol', state: harness.detected ? 'experimental' : 'missing' }], issues: [] };
    results.push({
      id: harness.id,
      harness: harness.harness,
      transport: harness.transport,
      detected: harness.detected,
      checks: [...base.checks, ...(probe.checks ?? [])],
      issues: [...base.issues, ...(probe.issues ?? [])],
      health: {
        ...base.health,
        ...(probe.authenticated ? { authenticated: probe.authenticated } : {}),
      },
    });
  }
  return {
    generatedAt: Date.now(),
    cwd: options.cwd,
    credentialPolicy: 'native-only',
    harnesses: results,
    summary: {
      detected: results.filter((item) => item.detected).length,
      ready: results.filter((item) => item.detected && item.issues.length === 0).length,
      issues: results.reduce((count, item) => count + item.issues.length, 0),
    },
  };
}
