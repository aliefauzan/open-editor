// Phase 13 step 1c (D-16): `pnpm dist` builds the Apple helper and fails with a clear message when no
// macOS 26+ SDK is found (the SDK path faked away); `pnpm dist:no-apple` is named as the way out.
import type { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { APPLE_SDK_MIN, buildAppleHelper, macSdkVersion } from '../../scripts/stage-resources.ts';

type Run = typeof spawnSync;
const fake = (sdk: { status: number; stdout: string }, build = { status: 0 }): Run =>
  ((cmd: string) =>
    cmd === 'xcrun'
      ? { status: sdk.status, stdout: sdk.stdout, stderr: '' }
      : { status: build.status, stdout: '', stderr: '' }) as unknown as Run;

describe('Apple helper build (D-16)', () => {
  it('reads the SDK version from xcrun', () => {
    expect(macSdkVersion(fake({ status: 0, stdout: '27.0\n' }))).toBe(27);
    expect(macSdkVersion(fake({ status: 1, stdout: '' }))).toBeUndefined();
    expect(APPLE_SDK_MIN).toBe(26);
  });

  it('no SDK (xcrun fails): pnpm dist stops with a clear message naming dist:no-apple', () => {
    expect(() => buildAppleHelper(fake({ status: 1, stdout: '' }))).toThrow(
      /needs the macOS 26\+ SDK.*found none.*pnpm dist:no-apple/s,
    );
  });

  it('an older SDK (15.4) is refused the same way', () => {
    expect(() => buildAppleHelper(fake({ status: 0, stdout: '15.4' }))).toThrow(/found 15\.4/);
  });

  it('a failed swift build fails the dist', () => {
    expect(() => buildAppleHelper(fake({ status: 0, stdout: '26.0' }, { status: 1 }))).toThrow(
      /swift build of native\/apple-llm failed/,
    );
  });
});
