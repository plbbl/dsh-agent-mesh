import { randomUUID } from 'node:crypto';

import { MeshError } from './errors.js';

const ROUTER_VERSION = 'mesh-auto-v1';
const MAX_CONTEXT_CHARS = 24_000;
const MAX_CANDIDATES = 64;

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function slug(value, fallback = 'route') {
  const output = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 42);
  return output || fallback;
}

function hash(value) {
  let output = 2166136261;
  for (const char of String(value)) {
    output ^= char.codePointAt(0);
    output = Math.imul(output, 16777619);
  }
  return (output >>> 0).toString(16).padStart(8, '0');
}

function profileModel(profile) {
  return String(profile?.model ?? 'native-default');
}

function profileKey(profile) {
  return `${profile?.harness ?? 'harness'}:${profileModel(profile)}`;
}

function sessionKey(sessionId, profile, role) {
  const raw = String(sessionId || randomUUID());
  const readable = raw.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 48) || 'session';
  return `mesh-${readable}-${slug(profile?.harness)}-${slug(profileModel(profile))}-${role}-${hash(`${raw}:${profileKey(profile)}:${role}`)}`.slice(0, 127);
}

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text' || part?.type === 'reasoning') return String(part.text ?? '');
    return '';
  }).join('');
}

function historyFrom(messages, current) {
  const rows = [];
  for (const message of messages ?? []) {
    if (message?.role !== 'user' && message?.role !== 'assistant') continue;
    const text = messageText(message).trim();
    if (!text || text === current) continue;
    rows.push(`${message.role === 'assistant' ? '助手' : '用户'}：${text}`);
  }
  return truncate(rows.join('\n\n'), MAX_CONTEXT_CHARS);
}

function promptOf(input = {}) {
  if (typeof input.prompt === 'string' && input.prompt.trim()) return input.prompt.trim();
  if (typeof input.text === 'string' && input.text.trim()) return input.text.trim();
  for (let index = (input.messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const text = messageText(input.messages[index]).trim();
    if (input.messages[index]?.role === 'user' && text) return text;
  }
  throw new MeshError('PROMPT_REQUIRED', 'Routing requires a text prompt.');
}

function modelMeta(profile) {
  return profile?.discovery?.models?.find((item) => item.id === profile.model) ?? {};
}

function usable(profile) {
  const health = profile?.discovery?.health;
  if (profile?.available === false || profile?.routeable === false || profile?.nativeHost === true) return false;
  if (profile?.discovery?.detected === false) return false;
  if (health?.state === 'missing-binary' || health?.state === 'invalid-config') return false;
  if (health?.authenticated === 'missing') return false;
  return true;
}

function classify(prompt, input = {}) {
  const text = prompt.toLowerCase();
  const chars = prompt.length + Number(input.contextLength ?? 0);
  const explicitEnsemble = /多模型|多智能体|聚合|集成|ensemble|panel|debate|second opinion|交叉验证|对比方案|独立审查|独立核查|review from another/i.test(prompt);
  const coding = /代码|编程|bug|报错|重构|实现|函数|接口|api|typescript|javascript|python|go\b|rust\b|test|测试|仓库|repo|代码库/i.test(text);
  const math = /数学|证明|方程|定理|概率|计算|公式|math|equation|theorem|proof/i.test(text);
  const chinese = /[\u4e00-\u9fff]/.test(prompt);
  const highRisk = /生产|上线|安全|权限|密钥|隐私|医疗|法律|金融|合规|production|security|privacy|medical|legal|financial/i.test(text);
  const longContext = chars > 12_000;
  const difficult = /深入|严谨|复杂|架构|根因|批判|比较|为什么|研究|深度|复杂|hard|architecture|root cause|research/i.test(text);
  const domain = coding ? 'coding' : math ? 'math' : longContext ? 'long_context' : chinese ? 'chinese' : 'general';
  const risk = clamp(
    0.08
      + (explicitEnsemble ? 0.34 : 0)
      + (highRisk ? 0.24 : 0)
      + (difficult ? 0.16 : 0)
      + (coding ? 0.08 : 0)
      + (math ? 0.08 : 0)
      + (longContext ? 0.18 : 0),
  );
  return {
    domain,
    chinese,
    coding,
    math,
    highRisk,
    longContext,
    explicitEnsemble,
    difficult,
    risk,
    inputChars: chars,
    estimatedInputTokens: Math.ceil(chars / 4),
  };
}

function scoreProfile(profile, classification, role = 'producer') {
  const model = `${profile?.harness ?? ''} ${profileModel(profile)}`.toLowerCase();
  const meta = modelMeta(profile);
  let score = 0;
  if (/flash|mini|smol|fast|lite/.test(model)) score += role === 'producer' ? 3 : 1;
  if (/deepseek|glm|gpt|claude|codex|kimi|mimo|hy3/.test(model)) score += 1;
  if (/pro|opus|terra|max/.test(model)) score -= role === 'producer' ? 0.6 : -0.2;
  if (profile?.experimental) score -= 2;
  if (classification.coding && /codex|claude|mimo|glm|gpt|deepseek|code/.test(model)) score += 2;
  if (classification.math && /hy3|glm|deepseek|gpt|kimi/.test(model)) score += 2;
  if (classification.chinese && /hy3|kimi|deepseek|glm/.test(model)) score += 1.5;
  if (classification.longContext && /glm|deepseek|mimo|gpt|terra|luna/.test(model)) score += 2;
  if (classification.difficult && /glm|gpt|terra|luna|mimo|codex/.test(model)) score += 1.5;
  if (role === 'specialist' && /flash|mini|smol/.test(model)) score -= 0.6;
  if (role === 'judge' && /luna|terra|glm|gpt|codex/.test(model)) score += 3;
  if (meta.contextWindow && classification.estimatedInputTokens > meta.contextWindow) score -= 100;
  if (!profile?.model) score -= 1;
  return score;
}

function publicCandidate(profile, score, role) {
  const meta = modelMeta(profile);
  return {
    profileId: profile.id,
    harness: profile.harness,
    model: profile.model ?? 'native-default',
    label: meta.label ?? profile.label ?? profile.model ?? profile.harness,
    role,
    score: Number(score.toFixed(3)),
    ...(meta.contextWindow ? { contextWindow: meta.contextWindow } : {}),
    ...(meta.reasoning ? { reasoning: meta.reasoning } : {}),
  };
}

function normalizeMode(value) {
  const mode = String(value ?? 'auto').toLowerCase();
  if (['single', 'auto', 'panel', 'aggregate'].includes(mode)) return mode;
  return 'auto';
}

function winnerFrom(text) {
  const value = String(text ?? '').trim();
  const json = value.match(/\{[\s\S]*\}/)?.[0];
  if (json) {
    try {
      const parsed = JSON.parse(json);
      const winner = String(parsed.winner ?? parsed.choice ?? parsed.selected ?? '').toUpperCase();
      if (winner === 'A' || winner === 'B') return winner;
    } catch { /* fall through to the strict text form */ }
  }
  const strict = value.match(/(?:winner|choice|selected)\s*[:：=-]?\s*([AB])\b/i);
  return strict ? strict[1].toUpperCase() : undefined;
}

function deterministicWinner(candidates, prompt) {
  if (candidates.length < 2) return 0;
  const wantsJson = /json|\b结构化\b|结构化输出|只返回对象/i.test(prompt);
  if (wantsJson) {
    const valid = candidates.map((candidate) => {
      try { JSON.parse(candidate.text); return true; } catch { return false; }
    });
    if (valid[0] !== valid[1]) return valid[0] ? 0 : 1;
  }
  const weak = /无法完成|做不到|不知道|作为 ai|as an ai|i can't|i cannot/i;
  const weakFlags = candidates.map((candidate) => weak.test(candidate.text));
  if (weakFlags[0] !== weakFlags[1]) return weakFlags[0] ? 1 : 0;
  return 0;
}

function controls(promise, signal, timeoutMs) {
  let timer;
  let abortHandler;
  const guarded = [promise];
  if (signal) {
    guarded.push(new Promise((_, reject) => {
      abortHandler = () => reject(new MeshError('ABORTED', 'The routed DSH request was cancelled.'));
      if (signal.aborted) abortHandler();
      else signal.addEventListener('abort', abortHandler, { once: true });
    }));
  }
  if (timeoutMs > 0) guarded.push(new Promise((_, reject) => {
    timer = setTimeout(() => reject(new MeshError('ROUTE_TIMEOUT', 'The model route exceeded its bounded deadline.')), timeoutMs);
  }));
  return Promise.race(guarded).finally(() => {
    if (timer) clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  });
}

export class MeshRouter {
  constructor(runtime, options = {}) {
    this.runtime = runtime;
    this.logger = options.logger;
    this.options = options;
  }

  candidates(input = {}) {
    const classification = input.classification ?? classify(String(input.prompt ?? ''), input);
    const profiles = this.runtime.listProfiles?.() ?? [];
    const usableProfiles = profiles.filter(usable);
    const modeled = usableProfiles.filter((profile) => profile.model);
    const source = modeled.length ? modeled : usableProfiles;
    const seen = new Set();
    return source
      .filter((profile) => {
        const key = profileKey(profile);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_CANDIDATES)
      .map((profile) => ({ profile, score: scoreProfile(profile, classification) }));
  }

  hasCandidates() {
    return this.candidates({ prompt: 'route availability probe' }).length > 0;
  }

  plan(input = {}) {
    const prompt = promptOf(input);
    const mode = normalizeMode(input.mode ?? input.routeMode);
    const classification = classify(prompt, input);
    const available = this.candidates({ ...input, prompt, classification });
    if (!available.length) throw new MeshError('ROUTE_UNAVAILABLE', 'No usable local harness/model route is available.');
    const maxCalls = boundedInteger(input.maxCalls ?? input.max_calls ?? (mode === 'panel' ? 4 : 3), mode === 'panel' ? 4 : 3, 1, 5);
    const maxBranches = Math.min(maxCalls, boundedInteger(input.maxBranches ?? input.max_branches ?? 2, 2, 1, 3));
    const ranked = available.sort((a, b) => b.score - a.score || profileKey(a.profile).localeCompare(profileKey(b.profile)));
    const primary = ranked[0];
    const branches = [{ ...primary, role: 'producer' }];
    const shouldFanOut = mode !== 'single' && (mode === 'panel' || mode === 'aggregate' || classification.explicitEnsemble || classification.risk >= 0.65);
    if (shouldFanOut && maxBranches > 1) {
      const specialists = [...ranked]
        .filter((item) => profileKey(item.profile) !== profileKey(primary.profile) && profileModel(item.profile) !== profileModel(primary.profile))
        .map((item) => ({ ...item, score: scoreProfile(item.profile, classification, 'specialist') }))
        .sort((a, b) => b.score - a.score || profileKey(a.profile).localeCompare(profileKey(b.profile)));
      const branchModels = new Set([profileModel(primary.profile)]);
      for (const specialist of specialists) {
        if (branches.length >= maxBranches || branchModels.has(profileModel(specialist.profile))) continue;
        branches.push({ ...specialist, role: 'specialist' });
        branchModels.add(profileModel(specialist.profile));
      }
    }
    const branchModels = new Set(branches.map((item) => profileModel(item.profile)));
    const judgeCandidate = branches.length > 1
      ? [...ranked]
        .filter((item) => !branchModels.has(profileModel(item.profile)))
        .map((item) => ({ ...item, score: scoreProfile(item.profile, classification, 'judge') }))
        .sort((a, b) => b.score - a.score || profileKey(a.profile).localeCompare(profileKey(b.profile)))[0]
      : undefined;
    const requestedPasses = input.positionSwap === true || (mode === 'panel' && input.strong === true) ? 2 : 1;
    const judgePasses = judgeCandidate ? Math.min(requestedPasses, Math.max(0, maxCalls - branches.length)) : 0;
    const judge = judgePasses > 0 ? { ...judgeCandidate, role: 'judge', passes: judgePasses } : undefined;
    return {
      version: ROUTER_VERSION,
      policyId: ROUTER_VERSION,
      mode,
      classification,
      budget: { maxCalls, maxBranches, estimatedCalls: branches.length + (judge?.passes ?? 0) },
      candidates: ranked.slice(0, 12).map((item) => publicCandidate(item.profile, item.score, 'candidate')),
      branches: branches.map((item) => publicCandidate(item.profile, item.score, item.role)),
      judge: judge ? { ...publicCandidate(judge.profile, judge.score, judge.role), passes: judge.passes } : undefined,
      aggregation: judge ? { method: 'blind-pairwise-selection', passes: judge.passes } : { method: 'deterministic-selection', passes: 0 },
    };
  }

  async run(input = {}) {
    const prompt = promptOf(input);
    const plan = this.plan({ ...input, prompt });
    const sessionId = String(input.sessionId ?? `dsh-route-${randomUUID()}`);
    const context = truncate(input.context ?? historyFrom(input.messages, prompt), MAX_CONTEXT_CHARS);
    const startedAt = Date.now();
    const callRecords = [];
    const profileById = new Map((this.runtime.listProfiles?.() ?? []).map((profile) => [profile.id, profile]));
    const branchPromises = plan.branches.map((branch) => this.#runAgent({ ...branch, profile: profileById.get(branch.profileId) }, sessionId, prompt, context, input, callRecords));
    const routeTimeoutMs = boundedInteger(input.routeTimeoutMs ?? 120_000, 120_000, 1_000, 10 * 60_000);
    const branchTimeoutMs = boundedInteger(input.branchTimeoutMs ?? 120_000, 120_000, 1_000, 10 * 60_000);
    const settled = await controls(Promise.allSettled(branchPromises), input.signal, routeTimeoutMs);
    const successful = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);
    if (!successful.length) {
      const errors = settled.filter((item) => item.status === 'rejected').map((item) => item.reason?.code ?? 'ROUTE_BRANCH_FAILED');
      throw new MeshError('ROUTE_ALL_FAILED', 'All selected local harness routes failed.', { errors });
    }
    let winner = deterministicWinner(successful, prompt);
    const warnings = [];
    if (successful.length > 1 && plan.judge) {
      const votes = [];
      for (let pass = 0; pass < plan.judge.passes; pass += 1) {
        const ordered = pass % 2 === 0 ? successful : [...successful].reverse();
        const judgment = await this.#runJudge({ ...plan.judge, profile: profileById.get(plan.judge.profileId) }, sessionId, prompt, ordered, context, { ...input, branchTimeoutMs }, callRecords).catch((error) => {
          warnings.push(`judge:${error.code ?? 'failed'}`);
          return undefined;
        });
        const vote = winnerFrom(judgment?.text);
        if (vote) votes.push({ vote, reversed: pass % 2 === 1 });
      }
      const mappedVotes = votes.map(({ vote, reversed }) => (reversed ? (vote === 'A' ? 1 : 0) : (vote === 'A' ? 0 : 1)));
      if (mappedVotes.length && mappedVotes.every((candidate) => candidate === mappedVotes[0])) winner = mappedVotes[0];
      else if (mappedVotes.length > 1) warnings.push('judge:position-conflict');
    }
    const selected = successful[Math.min(winner, successful.length - 1)];
    const route = {
      ...plan,
      selected: publicCandidate(selected.profile, selected.score, selected.role),
      calls: callRecords,
      warnings,
      latencyMs: Date.now() - startedAt,
      budgetUsed: callRecords.length,
    };
    const text = String(selected.result?.text ?? selected.result?.message ?? '').trim();
    if (!text) throw new MeshError('ROUTE_EMPTY_RESPONSE', 'The selected local harness returned no assistant text.');
    this.runtime.emit?.('route-event', { kind: 'route_completed', route: { ...route, candidates: undefined } });
    return {
      text,
      usage: selected.result?.usage,
      nativeSessionId: selected.result?.nativeSessionId,
      route,
    };
  }

  async #runAgent(branch, sessionId, prompt, context, input, records) {
    const profile = branch.profile;
    if (!profile) throw new MeshError('ROUTE_PROFILE_MISSING', `The selected local route disappeared: ${branch.profileId}.`);
    const id = sessionKey(sessionId, profile, branch.role);
    const startedAt = Date.now();
    try {
      if (this.runtime.hasAgent?.(id)) await this.runtime.ensureAgent?.(id, { reasoningEffort: input.reasoningEffort });
      else await this.runtime.start(profile.id, { sessionId: id, reasoningEffort: input.reasoningEffort });
      const roleInstruction = branch.role === 'specialist'
        ? '独立完成任务，重点寻找主答案可能遗漏的事实、约束、反例或实现风险；不要引用“其他 agent”。'
        : '直接完成用户任务，给出可执行、具体、完整的答案；不要讨论路由过程。';
      const branchPrompt = [
        `[Agent Mesh ${branch.role}]`,
        roleInstruction,
        context ? `[已有 DSH 上下文]\n${context}` : undefined,
        `[当前任务]\n${prompt}`,
      ].filter(Boolean).join('\n\n');
      const result = await controls(
        this.runtime.send(id, branchPrompt, { source: 'mesh-router', model: profile.model, reasoningEffort: input.reasoningEffort }),
        input.signal,
        boundedInteger(input.branchTimeoutMs ?? 120_000, 120_000, 1_000, 10 * 60_000),
      );
      records.push({ role: branch.role, profileId: profile.id, harness: profile.harness, model: profile.model, state: 'ok', latencyMs: Date.now() - startedAt });
      return { profile, score: branch.score, role: branch.role, result };
    } catch (error) {
      records.push({ role: branch.role, profileId: profile.id, harness: profile.harness, model: profile.model, state: 'error', errorCode: error?.code ?? 'ROUTE_BRANCH_FAILED', latencyMs: Date.now() - startedAt });
      throw error;
    }
  }

  async #runJudge(judge, sessionId, prompt, candidates, context, input, records) {
    const profile = judge.profile;
    if (!profile) throw new MeshError('ROUTE_PROFILE_MISSING', `The selected evaluator route disappeared: ${judge.profileId}.`);
    const id = sessionKey(sessionId, profile, 'judge');
    const options = candidates.map((candidate, index) => `Candidate ${String.fromCharCode(65 + index)}:\n${truncate(candidate.result?.text, 32_000)}`).join('\n\n');
    const judgePrompt = [
      '[Agent Mesh blind evaluator]',
      '比较两个候选答案，只判断是否更准确、完整、符合用户约束。不要因为答案更长而偏好它，也不要输出改写后的答案。只返回 JSON：{"winner":"A"或"B","reason":"一句话"}。',
      context ? `[已有上下文]\n${context}` : undefined,
      `[用户任务]\n${prompt}`,
      options,
    ].filter(Boolean).join('\n\n');
    const startedAt = Date.now();
    try {
      if (this.runtime.hasAgent?.(id)) await this.runtime.ensureAgent?.(id, { reasoningEffort: input.reasoningEffort });
      else await this.runtime.start(profile.id, { sessionId: id, reasoningEffort: input.reasoningEffort });
      const result = await controls(
        this.runtime.send(id, judgePrompt, { source: 'mesh-router-judge', model: profile.model, reasoningEffort: input.reasoningEffort }),
        input.signal,
        boundedInteger(input.judgeTimeoutMs ?? 90_000, 90_000, 1_000, 10 * 60_000),
      );
      records.push({ role: 'judge', profileId: profile.id, harness: profile.harness, model: profile.model, state: 'ok', latencyMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      records.push({ role: 'judge', profileId: profile.id, harness: profile.harness, model: profile.model, state: 'error', errorCode: error?.code ?? 'ROUTE_JUDGE_FAILED', latencyMs: Date.now() - startedAt });
      throw error;
    }
  }
}

export { ROUTER_VERSION, classify, profileKey };
