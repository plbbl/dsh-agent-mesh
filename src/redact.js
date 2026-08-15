const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|private[-_]?key)/i;

export function truncateText(value, maxBytes = 64 * 1024) {
  const text = String(value ?? '');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return text;
  let end = Math.max(0, Math.floor(text.length * (maxBytes / bytes)) - 1);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes - 32) end -= 1;
  return `${text.slice(0, end)}… [truncated ${bytes - Buffer.byteLength(text.slice(0, end), 'utf8')} bytes]`;
}

export function redact(value, options = {}) {
  const maxDepth = options.maxDepth ?? 6;
  const maxBytes = options.maxBytes ?? 64 * 1024;

  function visit(input, depth) {
    if (depth > maxDepth) return '[depth-limit]';
    if (typeof input === 'string') return truncateText(input, maxBytes);
    if (input === null || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1));
    const output = {};
    for (const [key, item] of Object.entries(input)) {
      output[key] = SECRET_KEY.test(key) ? '[redacted]' : visit(item, depth + 1);
    }
    return output;
  }

  return visit(value, 0);
}

export function safeJson(value, options = {}) {
  try {
    return JSON.stringify(redact(value, options));
  } catch {
    return JSON.stringify({ error: 'unserializable-value' });
  }
}
