import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
input.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === 'user') {
    write({ type: 'system', session_id: 'fixture-claude-session' });
    write({ type: 'assistant', session_id: 'fixture-claude-session', message: { content: [{ type: 'text', text: 'fixture claude answer' }] } });
    write({ type: 'result', session_id: 'fixture-claude-session', result: 'fixture claude answer', is_error: false });
  }
});
