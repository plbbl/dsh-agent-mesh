import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { MeshLlmAdapter } from '../src/mesh-llm.js';

class FakeRuntime extends EventEmitter {
  constructor(profiles) {
    super();
    this.profiles = profiles;
    this.agents = [];
    this.sent = [];
    this.started = [];
    this.ready = Promise.resolve();
  }

  listProfiles() {
    return this.profiles;
  }

  listAgents() {
    return this.agents;
  }

  hasAgent(sessionId) {
    return this.agents.some((agent) => agent.id === sessionId);
  }

  async start(profileId, { sessionId }) {
    this.started.push({ profileId, sessionId });
    if (!this.agents.some((agent) => agent.id === sessionId)) this.agents.push({ id: sessionId });
    return { id: sessionId };
  }

  async send(sessionId, prompt) {
    this.sent.push({ sessionId, prompt });
    if (!this.agents.some((agent) => agent.id === sessionId)) this.agents.push({ id: sessionId });
    queueMicrotask(() => this.emit('agent-event', {
      sessionId,
      kind: 'assistant_delta',
      text: '本机答复',
    }));
    return { text: '本机答复', usage: { inputTokens: 7, outputTokens: 3 } };
  }
}

class HangingRuntime extends FakeRuntime {
  send() {
    return new Promise(() => {});
  }
}

function profiles() {
  return [
    {
      id: 'codex-default',
      harness: 'codex',
      available: true,
      discovery: {
        configSource: 'native-read-only',
        models: [{
          id: 'gpt-5.6-luna',
          label: 'gpt-5.6-luna',
          contextWindow: 272000,
          reasoning: {
            efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
            defaultEffort: 'high',
          },
        }],
      },
    },
    {
      id: 'codex-luna',
      harness: 'codex',
      model: 'gpt-5.6-luna',
      available: true,
      discovery: {
        configSource: 'native-read-only',
        models: [{
          id: 'gpt-5.6-luna',
          label: 'gpt-5.6-luna',
          contextWindow: 272000,
          reasoning: {
            efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
            defaultEffort: 'high',
          },
        }],
      },
    },
    {
      id: 'claude-opus',
      harness: 'claude-code',
      model: 'opus[1m]',
      available: true,
      discovery: { models: [{ id: 'opus[1m]', label: 'opus[1m]' }] },
    },
    {
      id: 'missing',
      harness: 'pi',
      model: 'not-installed',
      available: false,
    },
  ];
}

function messages(prompt) {
  return [
    { role: 'user', content: [{ type: 'text', text: '先前的问题' }] },
    { role: 'assistant', content: [{ type: 'text', text: '先前的回答' }] },
    { role: 'user', content: [{ type: 'text', text: prompt }] },
  ];
}

test('LLM adapter exposes detected harnesses and native model names', async () => {
  const runtime = new FakeRuntime(profiles());
  const adapter = new MeshLlmAdapter(runtime);

  assert.deepEqual(adapter.refresh(), ['mesh:codex', 'mesh:claude-code', 'mesh:auto']);
  assert.deepEqual(await adapter.listModels('mesh:auto'), [{
    provider: 'mesh:auto',
    id: 'auto',
    name: '自动路由',
    inputModalities: ['text'],
    description: '默认单路；复杂或高风险任务才会并行核查',
  }]);
  assert.deepEqual(await adapter.listModels('mesh:codex'), [
    {
      provider: 'mesh:codex',
      id: 'gpt-5.6-luna',
      name: 'gpt-5.6-luna',
      inputModalities: ['text'],
    },
  ]);
  assert.deepEqual(await adapter.resolveModel('mesh:codex', 'gpt-5.6-luna'), {
    provider: 'mesh:codex',
    id: 'gpt-5.6-luna',
    name: 'gpt-5.6-luna',
    inputModalities: ['text'],
    context: { contextWindow: 272000 },
    reasoning: {
      efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
      defaultEffort: 'high',
    },
  });
  assert.equal(adapter.providerRetryPolicy('mesh:codex'), undefined);
});

test('LLM adapter streams native output and seeds a new route with bounded DSH context', async () => {
  const runtime = new FakeRuntime(profiles());
  const adapter = new MeshLlmAdapter(runtime);
  adapter.refresh();

  const chunks = [];
  for await (const chunk of adapter.stream({
    provider: 'mesh:codex',
    model: 'gpt-5.6-luna',
    sessionId: 'session-123',
    messages: messages('现在的问题'),
    signal: new AbortController().signal,
  })) chunks.push(chunk);

  assert.equal(runtime.sent.length, 1);
  assert.deepEqual(runtime.started, [{ profileId: 'codex-luna', sessionId: runtime.sent[0].sessionId }]);
  assert.match(runtime.sent[0].sessionId, /^dsh-session-123-mesh-codex-/);
  assert.match(runtime.sent[0].prompt, /\[DSH 会话上下文\]/);
  assert.match(runtime.sent[0].prompt, /先前的问题/);
  assert.match(runtime.sent[0].prompt, /\[当前请求\]\n现在的问题/);
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish']);
  assert.equal(chunks[1].text, '本机答复');
  assert.deepEqual(chunks[3].usage, { inputTokens: 7, outputTokens: 3 });
});

test('LLM adapter exposes automatic routing as one ordinary DSH model choice', async () => {
  const runtime = new FakeRuntime(profiles());
  const adapter = new MeshLlmAdapter(runtime);
  adapter.refresh();

  const chunks = [];
  for await (const chunk of adapter.stream({
    provider: 'mesh:auto',
    model: 'auto',
    sessionId: 'session-auto',
    messages: messages('把这个问题简要总结'),
    signal: new AbortController().signal,
  })) chunks.push(chunk);

  assert.equal(runtime.sent.length, 1);
  assert.equal(chunks[1].text, '本机答复');
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish']);
});

test('LLM adapter resumes the same native route without repeating the handoff', async () => {
  const runtime = new FakeRuntime(profiles());
  const adapter = new MeshLlmAdapter(runtime);
  adapter.refresh();

  for await (const _chunk of adapter.stream({
    provider: 'mesh:codex',
    model: 'gpt-5.6-luna',
    sessionId: 'session-123',
    messages: messages('第一次'),
    signal: new AbortController().signal,
  })) {}
  for await (const _chunk of adapter.stream({
    provider: 'mesh:codex',
    model: 'gpt-5.6-luna',
    sessionId: 'session-123',
    messages: messages('第二次'),
    signal: new AbortController().signal,
  })) {}

  assert.equal(runtime.sent.length, 2);
  assert.equal(runtime.started.length, 1);
  assert.equal(runtime.sent[1].prompt, '第二次');
});

test('LLM adapter cancellation does not wait for a hung native process', async () => {
  const runtime = new HangingRuntime(profiles());
  const adapter = new MeshLlmAdapter(runtime);
  adapter.refresh();
  const controller = new AbortController();
  const iterator = adapter.stream({
    provider: 'mesh:codex',
    model: 'gpt-5.6-luna',
    sessionId: 'session-cancel',
    messages: messages('取消这个请求'),
    signal: controller.signal,
  })[Symbol.asyncIterator]();
  const next = iterator.next();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(next, (error) => error?.code === 'ABORTED');
});
