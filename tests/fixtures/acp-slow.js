import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);

input.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === 'initialize') write({ id: message.id, result: { capabilities: {} } });
  else if (message.method === 'session/new') write({ id: message.id, result: { sessionId: 'slow-fixture-session' } });
  else if (message.method === 'session/prompt') {
    setTimeout(() => {
      write({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'slow fixture answer' } } } });
      write({ id: message.id, result: { stopReason: 'end_turn' } });
    }, 120);
  }
});
