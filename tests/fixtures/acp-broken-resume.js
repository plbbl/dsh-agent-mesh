import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);

input.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === 'initialize') write({ id: message.id, result: { capabilities: {} } });
  else if (message.method === 'session/load') {
    write({ id: message.id, error: { code: -32603, message: 'Internal error', data: { details: "undefined is not an object (evaluating 'j.length')" } } });
  } else if (message.method === 'session/new') {
    write({ id: message.id, result: { sessionId: 'fresh-omp-session' } });
  }
});
