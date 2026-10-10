// TEMPORARY local error type (D-19, early package G1). Phase 11 replaces it with VoxError from
// @vox/engine (same constructor shape) and appends CONFIG_INVALID, KEYCHAIN_FAILED and
// PRICE_MISSING to ERROR_CODES. Nothing here imports @vox/engine.

export interface UtilErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class UtilError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, hint: string, opts: UtilErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'UtilError';
    this.code = code;
    this.hint = hint;
    this.details = opts.details;
  }
}
