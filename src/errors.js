export class MeshError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'MeshError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function assertMesh(condition, code, message, details = undefined) {
  if (!condition) throw new MeshError(code, message, details);
}

export function asMeshError(error, fallbackCode = 'INTERNAL_ERROR') {
  if (error instanceof MeshError) return error;
  return new MeshError(fallbackCode, error?.message || String(error), {
    cause: error?.code || error?.name,
  });
}

const CREDENTIAL_FAILURE = /no credential|missing credential|credential.*(?:not|isn't|is not)\s*(?:set|configured|available|found)|(?:api[_ -]?key|token).*(?:not|isn't|is not)\s*(?:set|configured|available|found)|authentication required|not logged in|unauthorized|401/i;

/** Normalize provider-specific auth failures without projecting their raw text. */
export function asHarnessError(error, fallbackCode = 'PROMPT_ERROR') {
  const normalized = asMeshError(error, fallbackCode);
  if (normalized.code === 'MISSING_CREDENTIAL') return normalized;
  if (!CREDENTIAL_FAILURE.test(String(normalized.message ?? ''))) return normalized;
  return new MeshError(
    'MISSING_CREDENTIAL',
    '本机 harness 没有可用凭据；请在该 harness 的原生登录或凭据设置中完成配置。Agent Mesh 不会复制或索要凭据。',
    { causeCode: normalized.code },
  );
}
