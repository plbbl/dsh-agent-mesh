import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

queueMicrotask(() => write({ type: 'ready', protocolVersion: 2 }));

input.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === 'new_session') write({ type: 'response', id: message.id, result: { sessionId: 'rpc-hang-session' } });
  // Deliberately leave prompt requests open so the adapter timeout is tested.
});
