import { access, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { redact } from './redact.js';

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const SECRET_FIELD = /(api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key)/i;

function homePath(...parts) {
  return join(homedir(), ...parts);
}

function splitPath(value) {
  const output = [];
  let current = '';
  let quoted = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    else if (char === '.' && !quoted) {
      if (current) output.push(current.replace(/^"|"$/g, ''));
      current = '';
    } else current += char;
  }
  if (current) output.push(current.replace(/^"|"$/g, ''));
  return output;
}

function stripTomlComment(line) {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"' && line[index - 1] !== '\\') quoted = !quoted;
    if (line[index] === '#' && !quoted) return line.slice(0, index);
  }
  return line;
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).split(',').map((item) => parseScalar(item)).filter((item) => item !== undefined);
  }
  return trimmed;
}

export function parseTomlLite(text) {
  const root = {};
  let section = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTomlComment(raw).trim();
    if (!line) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = splitPath(line.slice(1, -1).replace(/^\[|\]$/g, ''));
      continue;
    }
    const equals = line.indexOf('=');
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim().replace(/^"|"$/g, '');
    const path = [...section, key];
    let target = root;
    for (const part of path.slice(0, -1)) target = target[part] ??= {};
    target[path.at(-1)] = parseScalar(line.slice(equals + 1));
  }
  return root;
}

function yamlValue(value) {
  if (!value.trim()) return undefined;
  if (value.trim() === 'true' || value.trim() === 'false') return value.trim() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  if ((value.trim().startsWith('"') && value.trim().endsWith('"')) || (value.trim().startsWith("'") && value.trim().endsWith("'"))) return value.trim().slice(1, -1);
  if (value.trim().startsWith('[') && value.trim().endsWith(']')) return value.trim().slice(1, -1).split(',').map((item) => yamlValue(item.trim())).filter((item) => item !== undefined);
  return value.trim();
}

/** Small, intentionally conservative YAML reader for discovery metadata. */
export function parseYamlLite(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const line = raw.trim();
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).node;
    if (line.startsWith('- ')) {
      if (!Array.isArray(parent)) continue;
      const value = line.slice(2).trim();
      if (value.includes(':')) {
        const item = {};
        parent.push(item);
        const [key, ...rest] = value.split(':');
        item[key.trim()] = yamlValue(rest.join(':'));
        stack.push({ indent, node: item });
      } else parent.push(yamlValue(value));
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 1 || Array.isArray(parent)) continue;
    const key = line.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
    const rawValue = line.slice(colon + 1).trim();
    if (rawValue) {
      parent[key] = yamlValue(rawValue);
      continue;
    }
    const next = lines[index + 1]?.trim() ?? '';
    parent[key] = next.startsWith('- ') ? [] : {};
    stack.push({ indent, node: parent[key] });
  }
  return root;
}

export function parseJsonc(text) {
  // Keep comment removal string-aware: a model endpoint such as
  // "https://gateway.example" is data, not a line comment.
  let withoutComments = '';
  let quote = false;
  let escape = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        withoutComments += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      } else if (char === '\n') withoutComments += char;
      continue;
    }
    if (!quote && char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (!quote && char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    withoutComments += char;
    if (char === '"' && !escape) quote = !quote;
    escape = char === '\\' && !escape;
    if (char !== '\\') escape = false;
  }
  return JSON.parse(withoutComments.replace(/,\s*([}\]])/g, '$1'));
}

async function readText(path) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return undefined;
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function readable(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function commandPath(command) {
  if (command.includes('/')) return command;
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
    encoding: 'utf8',
    timeout: 500,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (probe.status !== 0) return undefined;
  return probe.stdout.trim().split(/\r?\n/)[0] || undefined;
}

function commandJson(command, args, cwd) {
  try {
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 512 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0 || result.error) return undefined;
    return JSON.parse(result.stdout ?? '');
  } catch {
    return undefined;
  }
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function effortLabel(value) {
  const text = String(value ?? '').trim();
  return text ? `${text.slice(0, 1).toUpperCase()}${text.slice(1)}` : text;
}

function reasoningMetadata(item) {
  const raw = Array.isArray(item?.supported_reasoning_levels) ? item.supported_reasoning_levels : [];
  const efforts = [];
  const seen = new Set();
  for (const entry of raw) {
    const id = typeof entry === 'string' ? entry : entry?.id ?? entry?.effort ?? entry?.name;
    if (!id || seen.has(String(id))) continue;
    const normalized = String(id);
    seen.add(normalized);
    efforts.push({ id: normalized, name: effortLabel(entry?.name ?? normalized) });
  }
  if (!efforts.length && Array.isArray(item?.thinking)) {
    for (const entry of item.thinking) {
      const normalized = String(typeof entry === 'string' ? entry : entry?.id ?? entry?.level ?? entry?.name ?? '').trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      efforts.push({ id: normalized, name: effortLabel(normalized) });
    }
  }
  if (!efforts.length && item?.reasoning && item?.thinking?.minLevel && item?.thinking?.maxLevel) {
    const order = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const min = order.indexOf(String(item.thinking.minLevel));
    const max = order.indexOf(String(item.thinking.maxLevel));
    if (min >= 0 && max >= min) {
      for (const id of order.slice(min, max + 1)) efforts.push({ id, name: effortLabel(id) });
    }
  }
  if (!efforts.length && item?.reasoning === true) {
    for (const id of ['low', 'medium', 'high', 'xhigh', 'max']) efforts.push({ id, name: effortLabel(id) });
  }
  if (!efforts.length) return undefined;
  const defaultValue = item.default_reasoning_level ?? (item.thinking?.defaultLevel);
  const defaultEffort = defaultValue && (seen.has(String(defaultValue)) || efforts.some((effort) => effort.id === String(defaultValue)))
    ? String(defaultValue)
    : item.reasoning === true ? efforts.at(-1)?.id : undefined;
  return { efforts, ...(defaultEffort ? { defaultEffort } : {}) };
}

function slug(value, fallback = 'agent') {
  const output = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 42);
  return output || fallback;
}

function safeEnvironment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) continue;
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') continue;
    const stringValue = String(item);
    if (stringValue.length > 4096) continue;
    output[key] = stringValue;
  }
  return Object.keys(output).length ? output : undefined;
}

function configuredTransport(command, args) {
  const text = [command, ...(args ?? [])].join(' ').toLowerCase();
  const executable = text.split(/\s+/)[0].split('/').at(-1);
  if (executable === 'codex') return 'codex';
  if (executable === 'claude') return 'claude';
  if (executable === 'zcode') return 'zcode';
  if (executable === 'omp' || executable === 'pi') return (args ?? []).some((arg) => String(arg).toLowerCase() === 'acp') ? 'acp' : 'rpc';
  if (text.includes('zcode')) return 'zcode';
  if (text.includes('--mode rpc') || text.includes(' mode rpc')) return 'rpc';
  if (text.includes(' acp') || text.endsWith('acp')) return 'acp';
  // Zed and ACPX describe generic agent servers as ACP processes.
  return 'acp';
}

function entryPairs(value) {
  if (Array.isArray(value)) return value.map((item, index) => [String(item?.name ?? index), item]);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value);
}

async function discoverConfiguredAgents(userHome) {
  const sources = [
    {
      path: join(userHome, '.config', 'zed', 'settings.json'),
      kind: 'zed',
      field: 'agent_servers',
      prefix: 'zed',
      label: 'Zed configured ACP',
    },
    {
      path: join(userHome, '.acpx', 'config.json'),
      kind: 'acpx',
      field: 'agents',
      prefix: 'acpx',
      label: 'ACPX configured ACP',
    },
  ];
  const definitions = [];
  const warnings = [];
  const used = new Set();
  for (const source of sources) {
    const config = await parseConfig(source.path, 'json');
    if (!config) continue;
    if (config.error) {
      warnings.push(`Could not parse ${source.path}: ${config.error.message}`);
      continue;
    }
    for (const [name, raw] of entryPairs(config.parsed?.[source.field])) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const command = typeof raw.command === 'string' ? raw.command.trim() : '';
      if (!command) continue;
      const args = Array.isArray(raw.args) ? raw.args.filter((item) => typeof item === 'string').map(String) : [];
      const baseId = `${source.prefix}-${slug(name)}`;
      let id = baseId;
      let suffix = 2;
      while (used.has(id)) id = `${baseId}-${suffix++}`;
      used.add(id);
      const transport = ['codex', 'claude', 'acp', 'rpc', 'zcode', 'jsonl', 'mock'].includes(raw.transport)
        ? raw.transport
        : configuredTransport(command, args);
      const harness = String(raw.harness ?? `${source.kind}:${name}`);
      const models = [];
      collectModelEntries(raw, models, { harness });
      definitions.push({
        id,
        label: `${name} · ${source.label}`,
        harness,
        transport,
        command,
        args,
        env: safeEnvironment(raw.env),
        models,
        configPath: source.path,
        configKind: source.kind,
        experimental: transport === 'zcode',
        notes: `Read-only adapter generated from ${source.path}; credentials stay in the native configuration.`,
      });
    }
  }
  return { definitions, warnings };
}

function addModel(models, item) {
  if (!item) return;
  if (typeof item === 'object' && ['hide', 'hidden'].includes(String(item.visibility ?? '').toLowerCase())) return;
  const rawId = typeof item === 'string' ? item : item.id ?? item.model ?? item.slug ?? item.name;
  if (!rawId || typeof rawId !== 'string') return;
  const inferredProvider = item?.provider ?? (rawId.includes('/') ? rawId.slice(0, rawId.indexOf('/')) : undefined);
  const id = inferredProvider && !rawId.startsWith(`${inferredProvider}/`) && !rawId.includes('/') ? `${inferredProvider}/${rawId}` : rawId;
  const key = `${item.harness ?? ''}:${id}`;
  const existing = models.find((model) => `${model.harness ?? ''}:${model.id}` === key);
  const reasoning = typeof item === 'object'
    ? (item.reasoning && typeof item.reasoning === 'object' ? item.reasoning : reasoningMetadata(item))
    : undefined;
  const contextWindow = typeof item === 'object' && Number.isSafeInteger(item.contextWindow) && item.contextWindow > 0
    ? item.contextWindow
    : typeof item === 'object' && Number.isSafeInteger(item.context_window) && item.context_window > 0
      ? item.context_window
    : undefined;
  if (existing) {
    if (typeof item === 'object' && (item.display_name || item.name || item.label)) existing.label = item.display_name ?? item.name ?? item.label;
    if (reasoning && !existing.reasoning) existing.reasoning = reasoning;
    if (contextWindow && !existing.contextWindow) existing.contextWindow = contextWindow;
    if (typeof item === 'object' && item.default === true) existing.default = true;
    return;
  }
  models.push({
    id,
    label: typeof item === 'object' ? item.display_name ?? item.name ?? item.label ?? id : id,
    provider: inferredProvider,
    harness: item.harness,
    role: item.role,
    default: Boolean(item.default),
    source: item.source,
    credential: 'native',
    ...(reasoning ? { reasoning } : {}),
    ...(contextWindow ? { contextWindow } : {}),
  });
}

function collectModelEntries(value, models, context = {}) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectModelEntries(item, models, context);
    return;
  }
  if (value.id || value.model || value.slug) addModel(models, { ...value, ...context });
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) continue;
    const providerFromMap = context.inProviders && !['models', 'modelRoles', 'enabledModels'].includes(key) ? key : undefined;
    const nextContext = {
      ...context,
      provider: context.provider ?? providerFromMap ?? (key === 'provider' && typeof item === 'string' ? item : undefined),
      inProviders: context.inProviders || key === 'providers',
    };
    if (key === 'models' || key === 'modelRoles' || key === 'providers' || context.inModels) nextContext.inModels = true;
    if (key === 'default' || key === 'default_model' || key === 'model') {
      if (typeof item === 'string') addModel(models, { id: item, ...context, default: true });
    }
    collectModelEntries(item, models, nextContext);
  }
}

function publicModel(model) {
  return {
    id: model.id,
    label: model.label,
    provider: model.provider,
    default: model.default,
    ...(model.reasoning ? { reasoning: model.reasoning } : {}),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
  };
}

function configModels(parsed, kind, context = {}) {
  const models = [];
  if (kind === 'codex-models') {
    for (const item of Array.isArray(parsed?.models) ? parsed.models : []) addModel(models, { ...item, ...context });
  } else if (kind === 'omp-config') {
    for (const item of Array.isArray(parsed?.enabledModels) ? parsed.enabledModels : []) addModel(models, { id: item, ...context });
  } else if (kind === 'omp-models') {
    for (const [provider, value] of Object.entries(parsed?.providers ?? {})) {
      for (const item of Array.isArray(value?.models) ? value.models : []) addModel(models, { ...item, provider, ...context });
    }
  } else collectModelEntries(parsed, models, context);
  return models;
}

function configSummary(path, kind, parsed) {
  const models = configModels(parsed, kind);
  const defaults = unique([
    parsed?.model,
    parsed?.default_model,
    parsed?.modelRoles?.default,
    parsed?.model_roles?.default,
  ]);
  return {
    path,
    kind,
    readable: true,
    defaults,
    modelCount: models.length,
  };
}

function discoveryHealth({ found, transport, configFiles, models }) {
  const invalid = configFiles.filter((item) => item.readable === false && item.message);
  const hasConfig = configFiles.some((item) => item.readable !== false);
  const state = !found ? 'missing-binary' : invalid.length ? 'invalid-config' : 'detected';
  const reasons = [];
  if (!found) reasons.push('本机未找到可执行文件');
  if (invalid.length) reasons.push('至少一个本机配置无法解析');
  if (!models.length && found) reasons.push('未读到模型目录，将使用 harness 原生默认模型');
  return {
    state,
    installed: Boolean(found),
    configured: hasConfig,
    authenticated: 'unknown',
    modelSelectable: models.length > 0,
    resumable: transport !== 'zcode',
    streaming: true,
    toolEvents: !['zcode'].includes(transport),
    permissionMode: 'deny-by-default',
    automaticRecovery: true,
    reasons,
  };
}

async function parseConfig(path, kind) {
  const text = await readText(path);
  if (!text) return undefined;
  try {
    const parsed = kind === 'json' || kind === 'codex-models' ? JSON.parse(text) : kind === 'jsonc' ? parseJsonc(text) : kind === 'toml' ? parseTomlLite(text) : parseYamlLite(text);
    return { parsed, summary: configSummary(path, kind, parsed) };
  } catch (error) {
    return { error: { path, message: error.message } };
  }
}

function modelProfiles(base, models, options) {
  const output = [{ ...base }];
  const max = Math.max(0, Number(options.maxModelsPerHarness ?? 48));
  for (const model of models.slice(0, max)) {
    const modelSlug = slug(model.id, 'model');
    output.push({
      ...base,
      id: `${base.id}--${modelSlug}`,
      label: `${base.label} · ${model.label ?? model.id}`,
      model: model.id,
      ...(model.provider ? { modelProvider: model.provider } : {}),
      discovery: { ...base.discovery, modelSource: model.source },
    });
  }
  return output;
}

async function descriptor(options, definition) {
  const command = definition.command ?? definition.id;
  const found = commandPath(command) ?? (await (async () => {
    for (const candidate of definition.candidates ?? []) if (await readable(candidate)) return candidate;
    return undefined;
  })());
  const configFiles = [];
  const parsedConfigs = [];
  for (const config of definition.configs ?? []) {
    const parsed = await parseConfig(config.path, config.kind);
    if (!parsed) continue;
    if (parsed.error) configFiles.push({ ...parsed.error, readable: false });
    else {
      configFiles.push(parsed.summary);
      parsedConfigs.push({ kind: config.kind, parsed: parsed.parsed });
    }
  }
  const models = [];
  for (const config of parsedConfigs) {
    for (const model of configModels(config.parsed, config.kind, { harness: definition.harness })) addModel(models, model);
  }
  if (found && definition.catalogArgs?.length) {
    const catalog = commandJson(found, definition.catalogArgs, options.cwd);
    for (const model of Array.isArray(catalog?.models) ? catalog.models : []) {
      addModel(models, {
        ...model,
        id: model.selector ?? model.id,
        label: model.name ?? model.label ?? model.id,
        source: definition.catalogSource ?? `${definition.command} ${definition.catalogArgs.join(' ')}`,
        harness: definition.harness,
      });
    }
  }
  const base = {
    id: definition.id,
    label: definition.label,
    harness: definition.harness,
    transport: definition.transport,
    command: found ?? command,
    args: [...definition.args],
    permissionPolicy: 'reject',
    persistent: true,
    ...(definition.extra ?? {}),
    discovery: {
      detected: Boolean(found),
      commandPath: found,
      configFiles: configFiles.map((item) => ({ ...item, readable: item.readable !== false })),
      models: models.map(publicModel),
      configSource: 'native-read-only',
      health: discoveryHealth({ found, transport: definition.transport, configFiles, models }),
    },
  };
  return {
    harness: {
      id: definition.id,
      label: definition.label,
      harness: definition.harness,
      transport: definition.transport,
      args: [...definition.args],
      detected: Boolean(found),
      command: found ?? command,
      commandPath: found,
      configFiles,
      modelCount: models.length,
      models: models.map((model) => ({ ...publicModel(model), source: model.source ?? configFiles.find((file) => file.readable)?.path })),
      health: discoveryHealth({ found, transport: definition.transport, configFiles, models }),
      notes: definition.notes,
    },
    profiles: modelProfiles(base, models, options),
  };
}

function configuredDescriptor(definition, options) {
  const found = commandPath(definition.command);
  const models = definition.models ?? [];
  const configFile = {
    path: definition.configPath,
    kind: 'json',
    readable: true,
  };
  const base = {
    id: definition.id,
    label: definition.label,
    harness: definition.harness,
    transport: definition.transport,
    command: found ?? definition.command,
    args: [...definition.args],
    env: definition.env,
    permissionPolicy: 'reject',
    persistent: true,
    experimental: definition.experimental,
    discovery: {
      detected: Boolean(found),
      commandPath: found,
      configFiles: [configFile],
      models: models.map(publicModel),
      configSource: definition.configKind,
      configured: true,
      health: discoveryHealth({ found, transport: definition.transport, configFiles: [configFile], models }),
    },
  };
  return {
    harness: {
      id: definition.id,
      label: definition.label,
      harness: definition.harness,
      transport: definition.transport,
      args: [...definition.args],
      detected: Boolean(found),
      command: found ?? definition.command,
      commandPath: found,
      configFiles: [configFile],
      modelCount: models.length,
      models: models.map((model) => ({ ...publicModel(model), source: model.source ?? definition.configPath })),
      health: discoveryHealth({ found, transport: definition.transport, configFiles: [configFile], models }),
      notes: definition.notes,
    },
    profiles: modelProfiles(base, models, options),
  };
}

export async function discoverLocalHarnesses(options = {}) {
  const userHome = options.userHome ?? homedir();
  const codexRoot = options.codexHome ?? process.env.CODEX_HOME ?? join(userHome, '.codex');
  const ompRoots = unique([
    process.env.PI_CODING_AGENT_DIR,
    join(userHome, '.omp', 'agent'),
    join(userHome, '.oh-omp', 'agent'),
  ]);
  const definitions = [
    {
      id: 'codex-local', label: 'Codex · local app-server', harness: 'codex', transport: 'codex', command: 'codex', args: ['app-server', '--stdio'],
      configs: [
        { path: join(codexRoot, 'config.toml'), kind: 'toml' },
        { path: join(codexRoot, 'models_cache.json'), kind: 'codex-models' },
      ],
      notes: 'Uses native CODEX_HOME/config.toml, models_cache.json, and app-server thread persistence; preflights account/model availability without a turn.',
      extra: { preflight: true, preflightTimeoutMs: 5_000 },
    },
    {
      id: 'claude-local', label: 'Claude Code · local stream', harness: 'claude-code', transport: 'claude', command: 'claude',
      args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      configs: [
        { path: join(userHome, '.claude', 'settings.json'), kind: 'json' },
        { path: join(userHome, '.claude.json'), kind: 'json' },
      ],
      notes: 'Uses native Claude settings, OAuth/API environment, and --resume session storage.',
    },
    {
      id: 'opencode-local', label: 'OpenCode · ACP', harness: 'opencode', transport: 'acp', command: 'opencode', args: ['acp'],
      configs: [
        { path: join(userHome, '.config', 'opencode', 'opencode.json'), kind: 'json' },
        { path: join(userHome, '.config', 'opencode', 'opencode.jsonc'), kind: 'jsonc' },
      ],
      notes: 'Uses OpenCode ACP over nd-JSON, native opencode.json model/provider configuration, and native auth storage. Credentials are never projected.',
      extra: { modelConfigMethod: 'session/set_config_option', modelConfigId: 'model' },
    },
    {
      id: 'kimi-acp', label: 'Kimi Code · ACP', harness: 'kimi', transport: 'acp', command: 'kimi', args: ['acp'],
      configs: [{ path: join(process.env.KIMI_CODE_HOME ?? join(userHome, '.kimi-code'), 'config.toml'), kind: 'toml' }],
      notes: 'Uses KIMI_CODE_HOME/config.toml, native providers/models, and ACP session/load.',
      extra: { modelConfigMethod: 'session/set_config_option', modelConfigId: 'model' },
    },
    {
      id: 'omp-rpc', label: 'OMP · ACP', harness: 'omp', transport: 'acp', command: 'omp', args: ['acp'],
      catalogArgs: ['models', '--json'],
      catalogSource: 'omp models --json',
      configs: ompRoots.flatMap((root) => [
        { path: join(root, 'config.yml'), kind: 'omp-config' },
        { path: join(root, 'models.yml'), kind: 'omp-models' },
        { path: join(root, 'models.json'), kind: 'json' },
      ]),
      notes: 'Uses OMP ACP over stdio and native config.yml/models.yml; session/new returns a resumable ACP session and model selection uses session/set_config_option.',
      extra: { modelConfigMethod: 'session/set_config_option', modelConfigId: 'model', promptTimeoutMs: 10 * 60_000 },
    },
    {
      id: 'pi-rpc', label: 'Pi · RPC', harness: 'pi', transport: 'rpc', command: 'pi', args: ['--mode', 'rpc'],
      configs: [
        { path: join(process.env.PI_CODING_AGENT_DIR ?? join(userHome, '.pi', 'agent'), 'settings.json'), kind: 'json' },
        { path: join(process.env.PI_CODING_AGENT_DIR ?? join(userHome, '.pi', 'agent'), 'models.json'), kind: 'json' },
      ],
      notes: 'Uses native Pi RPC, PI_CODING_AGENT_DIR, model registry, and session files; waits for protocol readiness and agent_end completion.',
      extra: { readyRequired: true, readyTimeoutMs: 3_000, negotiateProtocol: true, protocolVersion: 2, rpcSessionControl: true, modelInArgs: false, modelMethod: 'set_model', promptCompletesOnResponse: false },
    },
    {
      id: 'zcode-local', label: 'ZCode · app-server', harness: 'zcode', transport: 'zcode', command: 'zcode',
      args: ['app-server', '--stdio'],
      candidates: [
        '/Applications/ZCode.app/Contents/Resources/bin/zcode',
        '/Applications/ZCode.app/Contents/Resources/zcode',
        join(userHome, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'bin', 'zcode'),
      ],
      configs: [{ path: join(userHome, '.zcode', 'settings.json'), kind: 'json' }],
      notes: 'Uses ZCode’s custom stdio JSON protocol, not ACP; shown as experimental.',
      extra: { experimental: true },
    },
  ];
  const resolved = await Promise.all(definitions.map((definition) => descriptor(options, definition)));
  const configured = await discoverConfiguredAgents(userHome);
  const configuredResolved = configured.definitions.map((definition) => configuredDescriptor(definition, options));
  const allResolved = [...resolved, ...configuredResolved];
  const harnesses = allResolved.map((item) => item.harness);
  const profiles = allResolved.flatMap((item) => item.profiles);
  const models = harnesses.flatMap((harness) => harness.models);
  return {
    generatedAt: Date.now(),
    platform: process.platform,
    cwd: options.cwd,
    credentialPolicy: 'native-only',
    harnesses,
    profiles,
    models,
    warnings: [
      'Discovery reads model names and non-secret settings only; credentials remain in native harness stores/environment.',
      ...harnesses.filter((item) => item.harness === 'zcode' && item.detected).map(() => 'ZCode uses a custom protocol and is marked experimental until its method schema is stable.'),
      ...configured.warnings,
    ],
  };
}

export function publicDiscovery(report) {
  const safe = report && typeof report === 'object'
    ? {
      ...report,
      profiles: report.profiles?.map(({ env: _env, ...profile }) => profile),
    }
    : report;
  // Model catalogs contain finite nested reasoning metadata. The old default
  // depth (6) turned valid Codex efforts into "[depth-limit]", which made the
  // UI look as if only one model existed even though discovery had found all
  // of them. Keep redaction bounded, but preserve the catalog shape.
  return redact(safe, { maxBytes: 512 * 1024, maxDepth: 12 });
}
