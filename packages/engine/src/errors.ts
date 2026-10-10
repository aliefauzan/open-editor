// VoxError + codes (engine spec "Error handling", plan R2, D-18). Codes are never renamed.

export const ERROR_CODES = [
  // history, write order, locking (engine spec "History")
  'STALE',
  'LOCKED',
  'HISTORY_CORRUPT',
  'UNDO_CONFLICT',
  'NOTHING_TO_UNDO',
  'NOTHING_TO_REDO',
  'JOB_CONFLICT',
  'SCHEMA_TOO_NEW',
  'SCHEMA_UNSUPPORTED',
  // op rules
  'TRACK_LOCKED',
  'NO_HANDLES',
  'VALIDATION',
  'NOT_FOUND',
  'OVERLAP',
  'MEDIA_BOUNDS',
  'TRACK_KIND',
  'MEDIA_IN_USE',
  'TRACK_NOT_EMPTY',
  'TEMPLATE_UNKNOWN',
  'TEMPLATE_INCOMPATIBLE',
  'VARIABLES_INVALID',
  'DURATION_BOUNDS',
  'SFX_UNKNOWN',
  // files and projects
  'PATH_INVALID',
  'SNAPSHOT_EXISTS',
  'PROJECT_NOT_FOUND',
  'PROJECT_AMBIGUOUS',
  // config, jobs, Python bridge (phase 04, early E2, D-20)
  'CONFIG_INVALID',
  'CONFIG_LOCKED',
  'JOB_FAILED',
  'PY_TOOL_FAILED',
  'PY_OUTPUT_INVALID',
  'TOOL_MISSING',
  'CANCELLED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface VoxErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class VoxError extends Error {
  readonly code: ErrorCode;
  readonly hint: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, hint: string, opts: VoxErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'VoxError';
    this.code = code;
    this.hint = hint;
    this.details = opts.details;
  }
}

/** A VoxError, also one built by another copy of this module (duck-typed on name, code and hint). */
export function isVoxError(e: unknown): e is VoxError {
  if (e instanceof VoxError) return true;
  if (!(e instanceof Error) || e.name !== 'VoxError') return false;
  const o = e as Error & { code?: unknown; hint?: unknown };
  return typeof o.code === 'string' && typeof o.hint === 'string';
}

export interface VoxErrorJson {
  code: ErrorCode;
  message: string;
  hint: string;
  details?: Record<string, unknown>;
}

export function toVoxErrorJson(e: VoxError): VoxErrorJson {
  return {
    code: e.code,
    message: e.message,
    hint: e.hint,
    ...(e.details === undefined ? {} : { details: e.details }),
  };
}
