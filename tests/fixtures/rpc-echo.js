import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

input.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: { ok: true } });
  } else if (message.method === 'ping') {
    write({ jsonrpc: '2.0', id: 99, method: 'permission/request', params: { safe: true } });
    setTimeout(() => write({ jsonrpc: '2.0', id: message.id, result: { pong: true } }), 5);
  } else if (message.id === 99) {
    write({ jsonrpc: '2.0', id: message.id, result: {} });
  } else if (message.method === 'session/new') {
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fixture-session' } });
  } else if (message.method === 'session/set_model') {
    write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'set_model is not implemented' } });
  } else if (message.method === 'session/set_config_option') {
    write({ jsonrpc: '2.0', id: message.id, result: { configId: message.params?.configId, value: message.params?.value } });
  } else if (message.method === 'session/prompt') {
    write({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture answer' } } } });
    write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    write({ id: message.id, result: { thread: { id: 'fixture-thread' } } });
  } else if (message.method === 'turn/start') {
    write({ id: message.id, result: { turn: { id: 'fixture-turn' } } });
    write({ method: 'item/agentMessage/delta', params: { turnId: 'fixture-turn', delta: 'fixture codex answer' } });
    write({ method: 'turn/completed', params: { turn: { id: 'fixture-turn', status: 'completed' } } });
  } else if (message.method === 'session/create') {
    write({ id: message.id, result: { sessionId: 'fixture-zcode-session' } });
  } else if (message.method === 'session/messages') {
    write({ method: 'session/event', params: { sessionId: 'fixture-zcode-session', text: 'fixture zcode answer' } });
    write({ id: message.id, result: { text: 'fixture zcode answer' } });
  }
});
