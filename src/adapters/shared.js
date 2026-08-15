import { truncateText } from '../redact.js';
import { MeshError } from '../errors.js';

export function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    if (content.type === 'text' || content.type === 'output_text' || content.type === 'text_delta') return String(content.text ?? content.delta ?? content.value ?? '');
    return textFromContent(content.content ?? content.text ?? content.delta);
  }
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text' || part?.type === 'output_text') return String(part.text ?? part.value ?? '');
    if (part?.type === 'text_delta') return String(part.text ?? part.delta ?? '');
    return '';
  }).join('');
}

export function textFromValue(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return textFromContent(value.content ?? value.text ?? value.message?.content ?? value.output ?? value.result);
}

export function event(kind, data = {}) {
  return {
    kind,
    ts: Date.now(),
    ...data,
  };
}

export function defaultApprovalReply(method, policy = 'reject') {
  if (policy === 'approve') return { decision: 'allow' };
  if (/approval|permission/i.test(method)) return { decision: 'decline' };
  return {};
}

export function finalText(value) {
  return truncateText(textFromValue(value), 512 * 1024);
}

export function withTimeout(promise, timeoutMs, options = {}) {
  const limit = Number(timeoutMs);
  if (!Number.isFinite(limit) || limit <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      try { await Promise.resolve(options.onTimeout?.()); } catch { /* best effort */ }
      reject(new MeshError(options.code ?? 'HARNESS_TIMEOUT', options.message ?? `Harness turn exceeded ${limit}ms.`));
    }, limit);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
