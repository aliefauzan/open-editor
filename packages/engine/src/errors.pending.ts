// TEMPORARY shim (D-19). Mirrors phase 02's src/errors.ts VoxError signature until 02 merges.
// Replaced by `../errors.ts` at merge time; new codes are appended to ERROR_CODES there.

export interface VoxErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class VoxError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, hint: string, opts: VoxErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'VoxError';
    this.code = code;
    this.hint = hint;
    this.details = opts.details;
  }
}

export function isVoxError(e: unknown): e is VoxError {
  return e instanceof VoxError;
}
