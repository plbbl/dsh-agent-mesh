import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const chunk = (chunkId, value) => {
  const data = Buffer.from(JSON.stringify(value), 'utf8');
  const split = Math.max(1, Math.floor(data.length / 2));
  return [
    { type: 'rpc_chunk', chunkId, index: 1, count: 2, byteLength: data.length, data: data.subarray(split).toString('base64') },
    { type: 'rpc_chunk', chunkId, index: 0, count: 2, byteLength: data.length, data: data.subarray(0, split).toString('base64') },
  ];
};

queueMicrotask(() => write({ type: 'ready', protocolVersion: 2, maxReassembledFrameBytes: 1024 * 1024 }));

input.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === 'new_session') write({ type: 'response', id: message.id, result: { sessionId: 'rpc-chunk-session' } });
  else if (message.type === 'prompt') {
    write({ type: 'response', id: message.id, result: { accepted: true } });
    for (const frame of chunk('answer', { type: 'assistant_message_delta', sessionId: 'rpc-chunk-session', delta: 'chunk answer' })) write(frame);
    for (const frame of chunk('done', { type: 'agent_end', id: message.id, sessionId: 'rpc-chunk-session' })) write(frame);
  }
});
