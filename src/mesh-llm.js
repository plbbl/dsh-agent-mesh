import { randomUUID } from 'node:crypto';

import { MeshError } from './errors.js';
import { MeshRouter } from './router.js';

const DEFAULT_MODEL_ID = 'native-default';
const AUTO_PROVIDER = 'mesh:auto';
const AUTO_MODEL_ID = 'auto';
const HISTORY_LIMIT = 24_000;

const HARNESS_NAMES = new Map([
  ['codex', 'Codex'],
  ['claude-code', 'Claude Code'],
  ['opencode', 'OpenCode'],
  ['kimi', 'Kimi Code'],
  ['omp', 'OMP'],
  ['pi', 'Pi'],
  ['zcode', 'ZCode'],
]);

function slug(value, fallback = 'harness') {
  const result = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return result || fallback;
}

function hash(value) {
  let output = 2166136261;
  for (const char of String(value)) {
    output ^= char.codePointAt(0);
    output = Math.imul(output, 16777619);
  }
  return (output >>> 0).toString(16).padStart(8, '0');
}

function routeFor(harness) {
  return `mesh:${slug(harness)}`;
}

function harnessName(harness) {
  return HARNESS_NAMES.get(String(harness)) ?? String(harness || 'Local harness');
}

function modelId(profile) {
  return profile.model || DEFAULT_MODEL_ID;
}

function modelName(profile) {
  if (!profile.model) return '本机默认';
  const discovered = profile.discovery?.models?.find((item) => item.id === profile.model);
  return discovered?.label || profile.model;
}

function modelMetadata(profile) {
  const discovered = profile?.discovery?.models?.find((item) => item.id === profile.model);
  return {
    ...(discovered?.contextWindow ? { context: { contextWindow: discovered.contextWindow } } : {}),
    ...(discovered?.reasoning ? { reasoning: discovered.reasoning } : {}),
  };
}

function modelDescription(profile) {
  const health = profile?.discovery?.health;
  if (!health) return undefined;
  if (health.state === 'invalid-config') return '配置异常 · 将自动恢复';
  if (health.authenticated === 'missing') return '需要登录';
  if (!profile.model) return '使用本机默认模型';
  return health.modelSelectable ? '本机配置 · 可恢复' : '本机默认模型';
}

function modelAvailable(profile) {
  const health = profile?.discovery?.health;
  if (!health) return undefined;
  return health.state !== 'missing-binary' && health.state !== 'invalid-config' && health.authenticated !== 'missing';
}

function blockText(block) {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'text' || block.type === 'reasoning') return String(block.text ?? '');
  return '';
}

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content.map(blockText).filter(Boolean).join('');
}

function promptText(messages) {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user' || message?.source?.kind === 'tool') continue;
    const text = messageText(message).trim();
    if (text) return text;
  }
  throw new MeshError('PROMPT_REQUIRED', 'The DSH turn did not contain a text prompt.');
}

function historyText(messages, current) {
  const rows = [];
  for (const message of messages ?? []) {
    if (message?.role !== 'user' && message?.role !== 'assistant') continue;
    const text = messageText(message).trim();
    if (!text || text === current) continue;
    rows.push(`${message.role === 'assistant' ? '助手' : '用户'}：${text}`);
  }
  const result = rows.join('\n\n');
  return result.length > HISTORY_LIMIT ? `…${result.slice(-HISTORY_LIMIT)}` : result;
}

function sessionKey(sessionId, provider, model) {
  const raw = String(sessionId || randomUUID());
  const readable = raw.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 56) || 'session';
  return `dsh-${readable}-${slug(provider, 'provider').slice(0, 18)}-${hash(`${raw}:${provider}:${model}`)}`;
}

function usageOf(value) {
  if (!value || typeof value !== 'object') return undefined;
  const inputTokens = Number(value.inputTokens ?? value.input_tokens);
  const outputTokens = Number(value.outputTokens ?? value.output_tokens);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return undefined;
  return {
    inputTokens: Math.max(0, Math.trunc(inputTokens)),
    outputTokens: Math.max(0, Math.trunc(outputTokens)),
    ...(value.cacheReadTokens === undefined && value.cache_read_tokens === undefined ? {} : {
      cacheReadTokens: Math.max(0, Math.trunc(Number(value.cacheReadTokens ?? value.cache_read_tokens) || 0)),
    }),
    ...(value.cacheWriteTokens === undefined && value.cache_write_tokens === undefined ? {} : {
      cacheWriteTokens: Math.max(0, Math.trunc(Number(value.cacheWriteTokens ?? value.cache_write_tokens) || 0)),
    }),
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw new MeshError('ABORTED', 'The DSH request was cancelled.');
}

function waitForEvent(signal, wake) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    wake.current = finish;
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Presents local Agent Mesh routes as ordinary DSH LLM providers.
 *
 * The adapter intentionally forwards only the latest user turn to the native
 * harness. The harness owns its own tool loop and durable native transcript;
 * DSH owns the visible transcript and model selection. When a new harness/model
 * is selected in an existing DSH session, a bounded text handoff seeds the new
 * native session so switching remains understandable without copying the full
 * DSH prompt/tool schema into every request.
 */
export class MeshLlmAdapter {
  constructor(runtime, options = {}) {
    this.runtime = runtime;
    this.logger = options.logger;
    this.router = runtime.router ?? new MeshRouter(runtime, { logger: this.logger });
    this.routes = new Map();
  }

  refresh() {
    const next = new Map();
    for (const profile of this.runtime.listProfiles()) {
      if (profile.available === false || profile.routeable === false || profile.nativeHost === true) continue;
      const provider = routeFor(profile.harness);
      const route = next.get(provider) ?? {
        provider,
        harness: profile.harness,
        name: harnessName(profile.harness),
        profiles: [],
      };
      route.profiles.push(profile);
      next.set(provider, route);
    }
    if (this.router.hasCandidates()) {
      next.set(AUTO_PROVIDER, {
        provider: AUTO_PROVIDER,
        harness: 'mesh',
        name: '自动路由',
        profiles: [],
        automatic: true,
      });
    }
    this.routes = next;
    return [...next.keys()];
  }

  providerInfo(provider) {
    const route = this.routes.get(provider);
    return { id: provider, name: route?.name ?? provider };
  }

  providerRetryPolicy() {
    return undefined;
  }

  listModels(provider) {
    const route = this.routes.get(provider);
    if (!route) return Promise.resolve([]);
    if (route.automatic) {
      return Promise.resolve([{
        provider,
        id: AUTO_MODEL_ID,
        name: '自动路由',
        inputModalities: ['text'],
        description: '默认单路；复杂或高风险任务才会并行核查',
      }]);
    }
    const seen = new Set();
    const models = [];
    const candidates = route.profiles.some((profile) => profile.model)
      ? route.profiles.filter((profile) => profile.model)
      : route.profiles;
    for (const profile of candidates) {
      const id = modelId(profile);
      if (seen.has(id)) continue;
      seen.add(id);
      models.push({
        provider,
        id,
        name: modelName(profile),
        inputModalities: ['text'],
        ...(modelDescription(profile) ? { description: modelDescription(profile) } : {}),
        ...(modelAvailable(profile) === undefined ? {} : { available: modelAvailable(profile) }),
      });
    }
    return Promise.resolve(models);
  }

  resolveModel(provider, model) {
    const route = this.routes.get(provider);
    if (route?.automatic && model === AUTO_MODEL_ID) {
      return Promise.resolve({
        provider,
        id: model,
        name: '自动路由',
        inputModalities: ['text'],
        description: '默认单路；复杂或高风险任务才会并行核查',
      });
    }
    const profile = route?.profiles.find((item) => modelId(item) === model);
    return Promise.resolve({
      provider,
      id: model,
      name: profile ? modelName(profile) : model,
      inputModalities: ['text'],
      ...modelMetadata(profile),
    });
  }

  profileFor(provider, model) {
    const route = this.routes.get(provider);
    if (!route) throw new MeshError('PROFILE_NOT_FOUND', `No local harness is registered for ${provider}.`);
    return route.profiles.find((profile) => modelId(profile) === model)
      ?? route.profiles.find((profile) => !profile.model)
      ?? route.profiles[0];
  }

  async *stream(options) {
    throwIfAborted(options.signal);
    if (options.provider === AUTO_PROVIDER) {
      await this.runtime.ready;
      throwIfAborted(options.signal);
      const current = promptText(options.messages);
      const routeInput = {
        prompt: current,
        messages: options.messages,
        sessionId: options.sessionId,
        signal: options.signal,
        reasoningEffort: options.reasoningEffort,
        mode: options.routeMode,
        maxCalls: options.maxCalls,
        maxBranches: options.maxBranches,
        routeTimeoutMs: options.routeTimeoutMs,
        branchTimeoutMs: options.branchTimeoutMs,
        positionSwap: options.positionSwap,
        strong: options.strong,
      };
      const plan = this.router.plan(routeInput);
      if (plan.branches.length === 1 && !plan.judge) {
        const profile = this.runtime.listProfiles().find((item) => item.id === plan.branches[0].profileId);
        if (!profile) throw new MeshError('ROUTE_PROFILE_MISSING', `The selected local route disappeared: ${plan.branches[0].profileId}.`);
        this.runtime.emit?.('route-event', { kind: 'route_selected', route: plan });
        yield* this.#streamProfile(options, profile, routeFor(profile.harness), modelId(profile));
        return;
      }
      const result = await this.router.run(routeInput);
      const text = String(result.text ?? '').trim();
      if (!text) throw new MeshError('EMPTY_RESPONSE', 'The automatic local route returned no assistant text.');
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      const usage = usageOf(result.usage);
      if (usage) yield { type: 'usage', usage };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    const profile = this.profileFor(options.provider, options.model);
    yield* this.#streamProfile(options, profile, options.provider, options.model);
  }

  async *#streamProfile(options, profile, provider, model) {
    const current = promptText(options.messages);
    const meshId = sessionKey(options.sessionId, provider, model);
    await this.runtime.ready;
    throwIfAborted(options.signal);

    const existing = typeof this.runtime.hasAgent === 'function'
      ? this.runtime.hasAgent(meshId)
      : this.runtime.listAgents().some((agent) => agent.id === meshId);
    if (typeof this.runtime.ensureAgent === 'function') await this.runtime.ensureAgent(meshId, { reasoningEffort: options.reasoningEffort }).catch(async (error) => {
      if (!existing) return this.runtime.start(profile.id, { sessionId: meshId, reasoningEffort: options.reasoningEffort });
      throw error;
    });
    else if (!existing) await this.runtime.start(profile.id, { sessionId: meshId, reasoningEffort: options.reasoningEffort });
    const history = historyText(options.messages, current);
    const needsHandoff = typeof this.runtime.sessionNeedsHandoff === 'function' && this.runtime.sessionNeedsHandoff(meshId);
    const handoffPrompt = [
      history ? `[DSH 会话上下文]\n${history}` : undefined,
      `[当前请求]\n${current}`,
    ].filter(Boolean).join('\n\n');
    const prompt = existing && !needsHandoff
      ? current
      : handoffPrompt;

    const queue = [];
    const wake = { current: undefined };
    let settled = false;
    let result;
    let failure;
    let streamedText = '';
    let blockStarted = false;
    const onEvent = (event) => {
      if (event?.sessionId !== meshId || event.kind !== 'assistant_delta' || !event.text) return;
      queue.push(String(event.text));
      wake.current?.();
      wake.current = undefined;
    };
    this.runtime.on('agent-event', onEvent);
    void this.runtime.send(meshId, prompt, {
      source: 'dsh-native-model',
      model: profile.model,
      reasoningEffort: options.reasoningEffort,
      recoveryPrompt: handoffPrompt,
    }).then((value) => {
      result = value;
      settled = true;
      wake.current?.();
      wake.current = undefined;
    }, (error) => {
      failure = error;
      settled = true;
      wake.current?.();
      wake.current = undefined;
    });

    try {
      while (!settled || queue.length > 0) {
        throwIfAborted(options.signal);
        if (queue.length > 0) {
          const text = queue.shift();
          if (!blockStarted) {
            blockStarted = true;
            yield { type: 'block-start', index: 0, blockType: 'text' };
          }
          streamedText += text;
          yield { type: 'text-delta', index: 0, text };
          continue;
        }
        await waitForEvent(options.signal, wake);
      }
      throwIfAborted(options.signal);
      if (failure) throw failure;
      const finalText = String(result?.text ?? '').trim();
      if (!streamedText && finalText) {
        blockStarted = true;
        streamedText = finalText;
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: finalText };
      }
      if (!streamedText) throw new MeshError('EMPTY_RESPONSE', 'The local harness returned no assistant text.');
      if (needsHandoff && typeof this.runtime.markHandoffComplete === 'function') await this.runtime.markHandoffComplete(meshId);
      yield { type: 'block-end', index: 0, block: { type: 'text', text: streamedText } };
      const usage = usageOf(result?.usage);
      if (usage) yield { type: 'usage', usage };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } finally {
      this.runtime.off('agent-event', onEvent);
      // The request has already been handed to the local harness. Its
      // rejection is consumed above, so cancellation can return immediately
      // while the durable native session settles in the background.
    }
  }
}

export { AUTO_MODEL_ID, AUTO_PROVIDER, DEFAULT_MODEL_ID, routeFor };
