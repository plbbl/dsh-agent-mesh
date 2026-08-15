import { MeshError, assertMesh } from './errors.js';

export const DEFAULT_PROFILES = [
  {
    id: 'dsh-native',
    label: 'DSH · host agent',
    harness: 'dsh',
    transport: 'dsh',
    command: 'dsh:host',
    permissionPolicy: 'reject',
    persistent: true,
    routeable: false,
    nativeHost: true,
  },
  {
    id: 'codex-local',
    label: 'Codex · local app-server',
    harness: 'codex',
    transport: 'codex',
    command: 'codex',
    args: ['app-server', '--stdio'],
    permissionPolicy: 'reject',
    persistent: true,
  },
  {
    id: 'claude-local',
    label: 'Claude Code · local stream',
    harness: 'claude-code',
    transport: 'claude',
    command: 'claude',
    args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
    permissionPolicy: 'reject',
    persistent: true,
  },
  {
    id: 'opencode-local',
    label: 'OpenCode · ACP',
    harness: 'opencode',
    transport: 'acp',
    command: 'opencode',
    args: ['acp'],
    permissionPolicy: 'reject',
    persistent: true,
    modelConfigMethod: 'session/set_config_option',
    modelConfigId: 'model',
  },
  {
    id: 'kimi-acp',
    label: 'Kimi Code · ACP',
    harness: 'kimi',
    transport: 'acp',
    command: 'kimi',
    args: ['acp'],
    permissionPolicy: 'reject',
    persistent: true,
    modelConfigMethod: 'session/set_config_option',
    modelConfigId: 'model',
  },
  {
    id: 'omp-rpc',
    label: 'OMP · ACP',
    harness: 'omp',
    transport: 'acp',
    command: 'omp',
    args: ['acp'],
    permissionPolicy: 'reject',
    persistent: true,
    modelConfigMethod: 'session/set_config_option',
    modelConfigId: 'model',
    promptTimeoutMs: 10 * 60_000,
  },
  {
    id: 'pi-rpc',
    label: 'Pi · RPC',
    harness: 'pi',
    transport: 'rpc',
    command: 'pi',
    args: ['--mode', 'rpc'],
    permissionPolicy: 'reject',
    persistent: true,
    readyRequired: true,
    readyTimeoutMs: 3_000,
    negotiateProtocol: true,
    protocolVersion: 2,
    rpcSessionControl: true,
    modelInArgs: false,
    modelMethod: 'set_model',
    promptCompletesOnResponse: false,
  },
  {
    id: 'zcode-local',
    label: 'ZCode · app-server',
    harness: 'zcode',
    transport: 'zcode',
    command: 'zcode',
    args: ['app-server', '--stdio'],
    permissionPolicy: 'reject',
    persistent: true,
    experimental: true,
  },
];

function cloneProfile(profile) {
  return {
    ...profile,
    args: [...(profile.args ?? [])],
    env: profile.env ? { ...profile.env } : undefined,
  };
}

export function normalizeProfile(input) {
  assertMesh(input && typeof input === 'object', 'INVALID_PROFILE', 'Profile must be an object.');
  const id = String(input.id ?? '').trim();
  const command = String(input.command ?? '').trim();
  assertMesh(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id), 'INVALID_PROFILE_ID', 'Profile id must be a short stable identifier.');
  assertMesh(command, 'INVALID_PROFILE_COMMAND', `Profile ${id} has no command.`);
  const transport = input.transport ?? input.harness;
  assertMesh(['dsh', 'codex', 'claude', 'acp', 'rpc', 'zcode', 'jsonl', 'mock'].includes(transport), 'INVALID_PROFILE_TRANSPORT', `Unsupported transport: ${transport}.`);
  const permissionPolicy = input.permissionPolicy ?? 'reject';
  assertMesh(['reject', 'approve'].includes(permissionPolicy), 'INVALID_PERMISSION_POLICY', `Unsupported permission policy: ${permissionPolicy}.`);
  const parsedPromptTimeoutMs = input.promptTimeoutMs === undefined ? undefined : Number(input.promptTimeoutMs);
  const promptTimeoutMs = Number.isFinite(parsedPromptTimeoutMs) ? Math.max(1_000, parsedPromptTimeoutMs) : undefined;
  return {
    id,
    label: String(input.label ?? input.name ?? id),
    harness: String(input.harness ?? transport),
    transport,
    command,
    args: Array.isArray(input.args) ? input.args.map(String) : [],
    model: input.model ? String(input.model) : undefined,
    cwd: input.cwd ? String(input.cwd) : undefined,
    env: input.env && typeof input.env === 'object' ? { ...input.env } : undefined,
    inheritEnv: input.inheritEnv ?? true,
    permissionPolicy,
    persistent: input.persistent ?? true,
    routeable: input.routeable ?? transport !== 'dsh',
    nativeHost: input.nativeHost ?? transport === 'dsh',
    timeoutMs: Math.max(1_000, Number(input.timeoutMs ?? 120_000)),
    ...(promptTimeoutMs === undefined ? {} : { promptTimeoutMs }),
    maxLineBytes: Math.max(4_096, Number(input.maxLineBytes ?? 8 * 1024 * 1024)),
    resumeMethod: input.resumeMethod,
    promptParam: input.promptParam,
    closeSession: input.closeSession,
    setModel: input.setModel,
    allowModelSwitch: input.allowModelSwitch ?? false,
    strictModel: input.strictModel ?? false,
    ...Object.fromEntries(Object.entries(input).filter(([key]) => ![
      'id', 'label', 'name', 'harness', 'transport', 'command', 'args', 'model', 'cwd', 'env',
      'inheritEnv', 'permissionPolicy', 'persistent', 'timeoutMs', 'maxLineBytes', 'resumeMethod',
      'promptParam', 'closeSession', 'setModel', 'allowModelSwitch', 'strictModel', 'routeable', 'nativeHost',
      'promptTimeoutMs',
    ].includes(key))),
  };
}

export class ProfileRegistry {
  constructor(profiles = [], options = {}) {
    this.map = new Map();
    const includeDefaults = options.includeDefaults ?? true;
    if (includeDefaults) {
      for (const profile of DEFAULT_PROFILES) this.set(profile);
    }
    for (const profile of profiles) this.set(profile);
  }

  set(profile) {
    const normalized = normalizeProfile(profile);
    this.map.set(normalized.id, normalized);
    return normalized;
  }

  get(id) {
    const profile = this.map.get(id);
    if (!profile) throw new MeshError('PROFILE_NOT_FOUND', `Profile not found: ${id}.`, { id });
    return cloneProfile(profile);
  }

  has(id) {
    return this.map.has(id);
  }

  list() {
    return [...this.map.values()].map((profile) => ({
      id: profile.id,
      label: profile.label,
      harness: profile.harness,
      transport: profile.transport,
      command: profile.command,
      model: profile.model,
      persistent: profile.persistent,
      permissionPolicy: profile.permissionPolicy,
      routeable: profile.routeable,
      nativeHost: profile.nativeHost,
      available: profile.discovery?.detected ?? true,
      experimental: profile.experimental ?? profile.discovery?.experimental ?? false,
      discovery: profile.discovery,
    }));
  }
}
