import { MeshRuntime } from './runtime.js';
import { MeshLlmAdapter } from './mesh-llm.js';

export const name = 'agent-mesh';
export const inject = ['tools', 'systemPrompt', 'llm', 'agents'];

const OBJECT_OUTPUT = {
  type: 'object',
  additionalProperties: true,
};

/**
 * Construct the small immutable value accepted by Agent.followup without
 * importing DSH's service-bearing LLM package. A linked plugin is resolved
 * from its own filesystem, while DSH owns that package inside its deployment;
 * making the relay value locally keeps the plugin self-contained and avoids a
 * profile boot failure when peer auto-install is disabled.
 */
function createRelayUserMessage(text) {
  const content = Object.freeze([{ type: 'text', text }]);
  const source = Object.freeze({ kind: 'plugin', plugin: name, form: 'relay' });
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'user',
    content,
    source,
  });
}

function parameterSchema(specification = {}) {
  const properties = {};
  const required = [];
  for (const [name, raw] of Object.entries(specification)) {
    const spec = raw && typeof raw === 'object' ? { ...raw } : { type: 'string' };
    const isRequired = spec.required === true;
    delete spec.required;
    properties[name] = spec;
    if (isRequired) required.push(name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
  };
}

function validateValue(spec, value, location) {
  if (!spec || typeof spec !== 'object') return [];
  if (spec.type === 'string' && typeof value !== 'string') return [`${location} must be a string`];
  if (spec.type === 'integer' && (!Number.isInteger(value))) return [`${location} must be an integer`];
  if (spec.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return [`${location} must be a number`];
  if (spec.type === 'boolean' && typeof value !== 'boolean') return [`${location} must be a boolean`];
  if (spec.type === 'array') {
    if (!Array.isArray(value)) return [`${location} must be an array`];
    return value.flatMap((item, index) => validateValue(spec.items, item, `${location}[${index}]`));
  }
  return [];
}

function validateParameters(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ['arguments must be an object'];
  const errors = [];
  for (const name of schema.required ?? []) {
    if (args[name] === undefined) errors.push(`${name} is required`);
  }
  for (const [name, spec] of Object.entries(schema.properties ?? {})) {
    if (args[name] !== undefined) errors.push(...validateValue(spec, args[name], name));
  }
  return errors;
}

/**
 * Keep the host half dependent on the injected `tools` service, not on the
 * package that happens to provide it. This matters for local linked plugins:
 * DSH resolves service implementations from the composed profile, while a
 * peer import would resolve from this package's filesystem location.
 */
function defineMeshTool(options) {
  const parameters = parameterSchema(options.parameters);
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: options.output,
    async execute(args, exec) {
      const errors = validateParameters(parameters, args);
      if (errors.length) throw new Error(`invalid arguments: ${errors.join('; ')}`);
      return options.execute(args, exec);
    },
  };
}

function textRender(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
}

function currentAgent(exec) {
  return String(exec?.agent?.session?.id ?? exec?.agent?.id ?? 'dsh:current');
}

function dshAgentBridge(ctx) {
  const registry = ctx.agents;
  const describe = (agent) => ({
    id: String(agent.id),
    profileId: 'dsh-native',
    harness: 'dsh',
    transport: 'dsh',
    model: agent.options?.model,
    provider: agent.options?.provider,
    cwd: agent.session?.header?.cwd,
    status: agent.status,
    nativeSessionId: String(agent.id),
    capabilities: {
      inProcess: true,
      followup: typeof agent.followup === 'function',
      streaming: true,
      resume: true,
      toolEvents: true,
      modelSwitch: false,
    },
    updatedAt: Date.now(),
  });
  return {
    list() {
      return registry?.list?.().map(describe) ?? [];
    },
    get(id) {
      return registry?.get?.(String(id));
    },
    has(id) {
      return Boolean(registry?.get?.(String(id)));
    },
    deliver(id, text, message) {
      const agent = registry?.get?.(String(id));
      if (!agent || typeof agent.followup !== 'function') throw new Error(`DSH agent is not available: ${id}`);
      agent.followup(createRelayUserMessage(text));
      return { accepted: true, messageId: message?.id, nativeSessionId: String(agent.id) };
    },
  };
}

function loggerFor(ctx) {
  return {
    debug(data, message) { ctx.logger?.debug?.(`${message ?? 'agent-mesh'} ${JSON.stringify(data ?? {})}`); },
    info(data, message) { ctx.logger?.info?.(`${message ?? 'agent-mesh'} ${JSON.stringify(data ?? {})}`); },
    warn(data, message) { ctx.logger?.warn?.(`${message ?? 'agent-mesh'} ${JSON.stringify(data ?? {})}`); },
    error(data, message) { ctx.logger?.error?.(`${message ?? 'agent-mesh'} ${JSON.stringify(data ?? {})}`); },
  };
}

function registerTools(ctx, runtime) {
  ctx.tools.register(defineMeshTool({
    name: 'agent_mesh_profiles',
    description: 'List locally discovered agent harnesses and model profiles. Credentials stay in the native harness stores.',
    parameters: {},
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute() {
      await runtime.ready;
      return { profiles: runtime.listProfiles(), discovery: runtime.snapshot().discovery };
    },
  }));

  ctx.tools.register(defineMeshTool({
    name: 'agent_mesh_agents',
    description: 'List persistent Agent Mesh sessions, their harness/model, status, workspace, and native session id.',
    parameters: {},
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute() {
      await runtime.ready;
      return { agents: runtime.listAgents() };
    },
  }));

  ctx.tools.register(defineMeshTool({
    name: 'agent_mesh_start',
    description: 'Start or resume a local harness session using a discovered profile.',
    parameters: {
      profile_id: { type: 'string', required: true, description: 'Profile id from agent_mesh_profiles.' },
      session_id: { type: 'string', description: 'Optional stable Agent Mesh session id to resume.' },
      cwd: { type: 'string', description: 'Optional absolute workspace path.' },
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute(args) {
      return runtime.start(args.profile_id, { sessionId: args.session_id, cwd: args.cwd });
    },
  }));

  ctx.tools.register(defineMeshTool({
    name: 'agent_mesh_send',
    description: 'Queue a durable message to another Agent Mesh session. The target session is resumed on demand.',
    parameters: {
      to: { type: 'string', required: true, description: 'Target Agent Mesh session id.' },
      text: { type: 'string', required: true, description: 'Message or task for the target agent.' },
      from: { type: 'string', description: 'Sender id; defaults to the current DSH agent.' },
      kind: { type: 'string', description: 'Message kind, for example task, review, result, or question.' },
      reply_to: { type: 'string', description: 'Message id being answered.' },
      trace_id: { type: 'string', description: 'Optional trace id shared by a multi-agent task.' },
      parent_id: { type: 'string', description: 'Optional parent message id.' },
      idempotency_key: { type: 'string', description: 'Optional stable key; retries do not duplicate delivery.' },
      expects_reply: { type: 'boolean', description: 'Whether the target should return one bounded reply.' },
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute(args, exec) {
      const from = args.from ?? currentAgent(exec);
      return runtime.sendMessage({
        to: args.to,
        text: args.text,
        from,
        kind: args.kind,
        replyTo: args.reply_to,
        traceId: args.trace_id,
        parentId: args.parent_id,
        idempotencyKey: args.idempotency_key,
        expectsReply: args.expects_reply,
        metadata: { mailbox: args.from === undefined },
      });
    },
  }));

  ctx.tools.register(defineMeshTool({
    name: 'agent_mesh_inbox',
    description: 'Read durable cross-agent messages for a session.',
    parameters: {
      to: { type: 'string', description: 'Target session id; defaults to the current DSH agent.' },
      limit: { type: 'integer', description: 'Maximum number of messages, default 50.' },
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute(args, exec) {
      await runtime.ready;
      return { messages: runtime.inbox({ to: args.to ?? currentAgent(exec), limit: args.limit }) };
    },
  }));

  ctx.tools.register(defineMeshTool({
    name: 'agent_mesh_handoff',
    description: 'Send a structured handoff between different harness/model sessions.',
    parameters: {
      to: { type: 'string', required: true, description: 'Target session id.' },
      summary: { type: 'string', required: true, description: 'What was learned or completed.' },
      next_steps: { type: 'array', items: { type: 'string' }, description: 'Concrete next actions.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Relevant files or paths.' },
      tests: { type: 'array', items: { type: 'string' }, description: 'Tests already run and their result.' },
      blockers: { type: 'array', items: { type: 'string' }, description: 'Known blockers or risks.' },
      from: { type: 'string', description: 'Sender id; defaults to the current DSH agent.' },
      trace_id: { type: 'string', description: 'Optional trace id shared by the handoff chain.' },
      idempotency_key: { type: 'string', description: 'Optional stable key for safe retries.' },
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute(args, exec) {
      const sections = [
        'Structured handoff',
        `Summary:\n${args.summary}`,
        args.next_steps?.length ? `Next steps:\n${args.next_steps.map((item) => `- ${item}`).join('\n')}` : undefined,
        args.files?.length ? `Files:\n${args.files.map((item) => `- ${item}`).join('\n')}` : undefined,
        args.tests?.length ? `Tests:\n${args.tests.map((item) => `- ${item}`).join('\n')}` : undefined,
        args.blockers?.length ? `Blockers:\n${args.blockers.map((item) => `- ${item}`).join('\n')}` : undefined,
      ].filter(Boolean).join('\n\n');
      return runtime.sendMessage({
        to: args.to,
        from: args.from ?? currentAgent(exec),
        text: sections,
        kind: 'handoff',
        traceId: args.trace_id,
        idempotencyKey: args.idempotency_key,
        artifacts: [
          ...(args.files ?? []).map((path) => ({ type: 'file', path })),
          ...(args.tests ?? []).map((value) => ({ type: 'test', value })),
          ...(args.blockers ?? []).map((value) => ({ type: 'blocker', value })),
          ...(args.next_steps ?? []).map((value) => ({ type: 'next-step', value })),
        ],
        metadata: { mailbox: args.from === undefined },
      });
    },
  }));

  ctx.tools.register(defineMeshTool({
    name: 'agent_mesh_stop',
    description: 'Stop a live local harness process while retaining its persistent session mapping for later resume.',
    parameters: { session_id: { type: 'string', required: true, description: 'Agent Mesh session id.' } },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute(args) {
      return runtime.stop(args.session_id);
    },
  }));

  ctx.tools.register(defineMeshTool({
    name: 'agent_mesh_cancel',
    description: 'Cancel a queued or retrying cross-agent message before delivery. A native turn already dispatched to a harness may finish, but it will not be delivered again.',
    parameters: {
      message_id: { type: 'string', required: true, description: 'Durable Agent Mesh message id.' },
      reason: { type: 'string', description: 'Optional cancellation reason.' },
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute(args) {
      return runtime.cancelMessage(args.message_id, args.reason);
    },
  }));

  ctx.tools.register(defineMeshTool({
    name: 'agent_mesh_discover',
    description: 'Refresh the read-only local harness and model discovery report.',
    parameters: {},
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute() {
      return runtime.discover();
    },
  }));

  ctx.tools.register(defineMeshTool({
    name: 'agent_mesh_doctor',
    description: 'Run bounded no-turn health checks for detected harnesses; never reads credential values or sends a model prompt.',
    parameters: {},
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute() {
      return runtime.doctor();
    },
  }));

  ctx.tools.register(defineMeshTool({
    name: 'agent_mesh_route_plan',
    description: 'Explain which usable local harness/model routes would be selected, without starting a session or sending a prompt.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The task to classify and route.' },
      mode: { type: 'string', description: 'single, auto, panel, or aggregate; default auto.' },
      max_calls: { type: 'integer', description: 'Hard cap on producer and evaluator calls, maximum 5.' },
      max_branches: { type: 'integer', description: 'Hard cap on parallel producer branches, maximum 3.' },
      position_swap: { type: 'boolean', description: 'Run a second judge pass with candidate positions swapped.' },
      strong: { type: 'boolean', description: 'Allow the extra blind judge pass for an explicit panel request.' },
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute(args) {
      await runtime.ready;
      return runtime.routePlan({
        prompt: args.prompt,
        mode: args.mode,
        maxCalls: args.max_calls,
        maxBranches: args.max_branches,
        positionSwap: args.position_swap,
        strong: args.strong,
      });
    },
  }));

  ctx.tools.register(defineMeshTool({
    name: 'agent_mesh_route',
    description: 'Run a bounded multi-agent route over usable local CLI harnesses. Default auto mode uses one producer and only fans out for complex or high-risk tasks.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The task to execute.' },
      session_id: { type: 'string', description: 'Stable route id; reuses the same per-harness sessions across turns.' },
      mode: { type: 'string', description: 'single, auto, panel, or aggregate; default auto.' },
      max_calls: { type: 'integer', description: 'Hard cap on producer and evaluator calls, maximum 5.' },
      max_branches: { type: 'integer', description: 'Hard cap on parallel producer branches, maximum 3.' },
      route_timeout_ms: { type: 'integer', description: 'Overall route deadline.' },
      branch_timeout_ms: { type: 'integer', description: 'Per-harness branch deadline.' },
      position_swap: { type: 'boolean', description: 'Run a second blind judge pass with candidate positions swapped.' },
      strong: { type: 'boolean', description: 'Allow the extra blind judge pass for an explicit panel request.' },
    },
    output: { schema: OBJECT_OUTPUT, render: (_args, value) => textRender(value) },
    async execute(args) {
      return runtime.route({
        prompt: args.prompt,
        sessionId: args.session_id,
        mode: args.mode,
        maxCalls: args.max_calls,
        maxBranches: args.max_branches,
        routeTimeoutMs: args.route_timeout_ms,
        branchTimeoutMs: args.branch_timeout_ms,
        positionSwap: args.position_swap,
        strong: args.strong,
      });
    },
  }));
}

function registerLlmRoutes(ctx, runtime, config) {
  const adapter = new MeshLlmAdapter(runtime, { logger: ctx.logger });
  let registration;
  let disposed = false;

  const sync = () => {
    if (disposed) return;
    const routes = adapter.refresh();
    try {
      if (registration) registration.replace(routes);
      else if (routes.length) registration = ctx.llm.registerAdapter(routes, adapter);
    } catch (error) {
      ctx.logger?.warn?.(`agent-mesh: keeping the last good LLM route set: ${error.message}`);
    }
  };

  // Profiles exist before the asynchronous native discovery finishes, so the
  // first registration is synchronous. Discovery then atomically replaces the
  // route set and emits DSH's normal adapters-updated signal.
  sync();
  runtime.on('discovery', sync);
  runtime.on('diagnostics', sync);
  runtime.ready.then(sync, (error) => {
    ctx.logger?.warn?.(`agent-mesh: native harness discovery failed: ${error.message}`);
  });

  ctx.effect(() => () => {
    disposed = true;
    runtime.off('discovery', sync);
    runtime.off('diagnostics', sync);
    registration?.();
  }, config.llmEffectLabel ?? 'agent-mesh: native LLM routes');
}

async function readRequestBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function registerWebRoutes(ctx, runtime) {
  const keys = ['webServer', 'httpServer'];
  let registered = false;
  const register = () => {
    if (registered) return;
    const server = keys.map((key) => ctx.get?.(key)).find(Boolean);
    if (!server) return;
    registered = true;
    ctx.effect(() => server.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-mesh/state',
      handler: async (_req, res) => {
        await runtime.ready;
        const body = JSON.stringify(runtime.snapshot({ limit: 80 }));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
      },
    }), 'agent-mesh: state route');
    ctx.effect(() => server.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-mesh/action',
      handler: async (req, res) => {
        try {
          const body = await readRequestBody(req);
          let result;
          if (body.action === 'discover') result = await runtime.discover({ cwd: body.cwd });
          else if (body.action === 'doctor') result = await runtime.doctor({ cwd: body.cwd, refresh: body.refresh });
          else if (body.action === 'start') result = await runtime.start(body.profileId, { sessionId: body.sessionId, cwd: body.cwd });
          else if (body.action === 'send') result = await runtime.sendMessage({ from: body.from ?? 'dsh-ui', to: body.to, text: body.text, kind: body.kind, metadata: { mailbox: body.from === undefined } });
          else if (body.action === 'stop') result = await runtime.stop(body.sessionId);
          else if (body.action === 'routePlan') { await runtime.ready; result = runtime.routePlan(body); }
          else if (body.action === 'route') result = await runtime.route(body);
          else throw new Error('unsupported action');
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: { message: error.message, code: error.code } }));
        }
      },
    }), 'agent-mesh: action route');
  };
  register();
  ctx.on('internal/service', (serviceName) => {
    if (keys.includes(serviceName)) register();
  });
}

export function apply(ctx, config = {}) {
  const dsh = dshAgentBridge(ctx);
  const runtime = new MeshRuntime({
    ...config,
    dsh,
    logger: loggerFor(ctx),
    cwd: config.cwd ?? process.cwd(),
  });
  ctx.provide('agentMesh', runtime);
  registerTools(ctx, runtime);
  registerLlmRoutes(ctx, runtime, config);
  ctx.systemPrompt.section({
    name: 'agent-mesh:usage',
    order: config.promptSectionOrder ?? 118,
    text: 'Agent Mesh is available for local harness orchestration. Use agent_mesh_profiles before choosing a harness/model, agent_mesh_route_plan to inspect automatic routing without a turn, and agent_mesh_route for a bounded route across usable local CLIs. Automatic routing defaults to one producer and fans out only for complex, high-risk, or explicitly multi-agent tasks; agent_mesh_start/send/handoff remain available for persistent cross-session communication. DSH host agents are first-class in-process Mesh participants: relay messages arrive as ordinary follow-up user messages, and replies should use Agent Mesh tools with the trace/reply id. Credentials remain in each native CLI configuration; never ask the user to paste keys into Agent Mesh.',
  });
  ctx.effect(() => () => runtime.close(), 'agent-mesh: runtime');
  registerWebRoutes(ctx, runtime);
  return runtime;
}
