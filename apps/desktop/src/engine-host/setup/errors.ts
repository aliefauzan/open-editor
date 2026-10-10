// Setup errors. Phase 02's VoxError is not on main yet; the engine host maps `code` to a VoxError
// (or its own IPC error) when it wires these modules in (phase 09).

export type SetupErrorCode =
  | 'HASH_MISMATCH'
  | 'SIZE_MISMATCH'
  | 'BAD_URL'
  | 'HTTP'
  | 'NETWORK'
  | 'EXTRACT_UNSAFE'
  | 'EXTRACT_FAILED'
  | 'BINARY_MISSING'
  | 'COMMAND_FAILED'
  | 'SPAWN_FAILED'
  | 'NOT_INSTALLABLE'
  | 'NO_UV'
  | 'NO_LOCKFILE'
  | 'BAD_MANIFEST';

export class SetupError extends Error {
  readonly code: SetupErrorCode;

  constructor(code: SetupErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SetupError';
    this.code = code;
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

export function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}
