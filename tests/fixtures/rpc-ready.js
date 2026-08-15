import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

queueMicrotask(() => write({ type: 'ready', protocol_version: 2 }));

input.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === 'negotiate_protocol') {
    write({ type: 'response', id: message.id, result: { protocol_version: 2 } });
  } else if (message.type === 'new_session') {
    write({ type: 'response', id: message.id, result: { sessionId: 'rpc-ready-session' } });
  } else if (message.type === 'switch_session') {
    write({ type: 'response', id: message.id, result: { sessionId: message.sessionId ?? message.session_id } });
  } else if (message.type === 'set_model') {
    write({ type: 'response', id: message.id, result: { model: message.modelId ?? message.model } });
  } else if (message.type === 'prompt') {
    write({ type: 'response', id: message.id, command: 'prompt', result: { accepted: true } });
    write({ type: 'assistant_message_delta', sessionId: 'rpc-ready-session', delta: 'rpc answer' });
    setTimeout(() => write({ type: 'agent_end', id: message.id, sessionId: 'rpc-ready-session', usage: { inputTokens: 2, outputTokens: 2 } }), 2);
  }
});
