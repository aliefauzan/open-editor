// VoxError + codes (engine spec "Error handling", plan R2, D-18). Codes are never renamed.
import { redactor } from './redact.ts';

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
  // network and links (engine spec "Ingest hardening"; S3, S29)
  'URL_INVALID',
  'NET_BLOCKED',
  'NET_DNS',
  'NET_REDIRECTS',
  'NET_TOO_LARGE',
  // ingest sources (engine spec "Ingest sources", D-13)
  'LOGIN_REQUIRED',
  // external tools and jobs (early E4: shots, facetrack; early e3-media-export)
  'TOOL_MISSING',
  'TOOL_FAILED',
  'CANCELLED',
  // media ingest and export targets (early e3-media-export, D-25)
  'MEDIA_UNSUPPORTED',
  'EXPORT_PATH',
  // styles (styles spec "Format", D-23)
  'STYLE_NOT_FOUND',
  'STYLE_INVALID',
  'STYLE_DUPLICATE',
  // config, jobs, Python bridge (phase 04, early E2, D-20)
  'CONFIG_INVALID',
  'CONFIG_LOCKED',
  'JOB_FAILED',
  'PY_TOOL_FAILED',
  'PY_OUTPUT_INVALID',
  // compile (phase 03, engine spec "Compile", S8)
  'MEDIA_MISSING',
  'TEMPLATE_VERSION',
  'HOOK_UNTRUSTED',
  // assets, render and export (phase 05)
  'LICENSE_REFUSED',
  'PROVIDER_MISSING',
  // agent: keys, prices, Apple helper, probe (phase 11; D-26, D-38)
  'KEYCHAIN_FAILED',
  'PRICE_MISSING',
  'APPLE_UNAVAILABLE',
  'APPLE_FAILED',
  'CONTEXT_OVERFLOW',
  'PROBE_FAILED',
  // agent: provider errors after redaction (agent spec "Error handling")
  'PROVIDER_AUTH',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_FAILED',
  // agent: tool layer and plan mode (agent spec "Tools", "Plan mode"; plan D-15)
  'UNKNOWN_ALIAS',
  'TOOL_UNKNOWN',
  'TOOL_REFUSED',
  'PLAN_INVALID',
  // agent: workflows (agent spec "Workflows"; phase 12)
  'CHECKPOINT_MISSED',
  'ROLE_MISSING',
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
    // The cause (often a tool's stderr tail) is redacted once, here (S19).
    super(message, opts.cause === undefined ? undefined : { cause: redactor.redact(opts.cause) });
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
  // Printed by the CLI and sent over IPC: redacted (S19).
  return redactor.redact({
    code: e.code,
    message: e.message,
    hint: e.hint,
    ...(e.details === undefined ? {} : { details: e.details }),
  });
}
