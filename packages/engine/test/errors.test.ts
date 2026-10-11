import { describe, expect, test } from 'vitest';
import { VoxError, isVoxError, toVoxErrorJson } from '../src/errors.ts';

describe('VoxError', () => {
  test('carries code, message, hint, details and is an Error', () => {
    const e = new VoxError('TRACK_LOCKED', 'Track V1 is locked', 'Unlock V1 first', {
      details: { trackId: 'V1' },
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('TRACK_LOCKED');
    expect(e.message).toBe('Track V1 is locked');
    expect(e.hint).toBe('Unlock V1 first');
    expect(e.details).toEqual({ trackId: 'V1' });
    expect(isVoxError(e)).toBe(true);
    expect(isVoxError(new Error('x'))).toBe(false);
  });

  test('isVoxError also accepts a VoxError from another copy of the module (duck-typed)', () => {
    const other = Object.assign(new Error('x'), { name: 'VoxError', code: 'STALE', hint: 'h' });
    expect(isVoxError(other)).toBe(true);
    expect(isVoxError(Object.assign(new Error('x'), { name: 'VoxError' }))).toBe(false);
    expect(isVoxError({ name: 'VoxError', code: 'STALE', hint: 'h', message: 'x' })).toBe(false);
  });

  test('serialises to the JSON object the CLI prints', () => {
    const e = new VoxError('STALE', 'Project moved on', 'Reload and retry');
    expect(toVoxErrorJson(e)).toEqual({
      code: 'STALE',
      message: 'Project moved on',
      hint: 'Reload and retry',
    });
  });

  test('every spec code is known', async () => {
    const { ERROR_CODES } = await import('../src/errors.ts');
    for (const c of [
      'STALE',
      'LOCKED',
      'HISTORY_CORRUPT',
      'UNDO_CONFLICT',
      'TRACK_LOCKED',
      'NO_HANDLES',
      'SCHEMA_TOO_NEW',
      'JOB_CONFLICT',
    ])
      expect(ERROR_CODES).toContain(c);
  });

  test('media, tool and export codes are known (early e3, D-25)', async () => {
    const { ERROR_CODES } = await import('../src/errors.ts');
    for (const c of [
      'MEDIA_UNSUPPORTED',
      'TOOL_MISSING',
      'TOOL_FAILED',
      'CANCELLED',
      'EXPORT_PATH',
    ])
      expect(ERROR_CODES).toContain(c);
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  test('compile codes are known (phase 03)', async () => {
    const { ERROR_CODES } = await import('../src/errors.ts');
    for (const c of ['MEDIA_MISSING', 'TEMPLATE_VERSION', 'HOOK_UNTRUSTED'])
      expect(ERROR_CODES).toContain(c);
  });
});

describe('VoxError redaction (S19)', () => {
  const CANARY = 'sk-or-v1-CANARY0000000000000000000000000000000000000000000000000000';
  test('cause is redacted when the error is made', () => {
    const e = new VoxError('TOOL_FAILED', 'x', 'h', {
      cause: `stderr line\nAuthorization: Bearer ${CANARY}\n`,
    });
    expect(String(e.cause)).not.toContain(CANARY);
    expect(String(e.cause)).toContain('[REDACTED]');
  });
  test('the JSON form redacts message and details', () => {
    const e = new VoxError('TOOL_FAILED', `failed at https://x.test/?api_key=${CANARY}`, 'h', {
      details: { url: `https://x.test/?key=${CANARY}`, apiKey: CANARY },
    });
    expect(JSON.stringify(toVoxErrorJson(e))).not.toContain(CANARY);
  });
});
