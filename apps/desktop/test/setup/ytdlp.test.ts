import { describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  checkImpersonation,
  parseImpersonateTargets,
  updateYtDlp,
  ytDlpVersion,
} from '../../src/engine-host/setup/ytdlp.ts';
import { noSignal, tmp, writeScript } from './helpers.ts';

const UNAVAILABLE = `[info] Available impersonate targets
Client    OS   Source
--------------------------------------------
Tor       -    curl_cffi>=0.11 (unavailable)
Edge      -    curl_cffi (unavailable)
Firefox   -    curl_cffi>=0.10 (unavailable)
Safari    -    curl_cffi (unavailable)
Chrome    -    curl_cffi (unavailable)
`;

const AVAILABLE = `[info] Available impersonate targets
Client         OS          Source
---------------------------------------------
Chrome         -           curl_cffi
Chrome-131     Android-14  curl_cffi
Edge           -           curl_cffi
Safari         -           curl_cffi
Firefox        -           curl_cffi (unavailable)
`;

describe('parseImpersonateTargets', () => {
  test('lists only available targets', () => {
    expect(parseImpersonateTargets(UNAVAILABLE)).toEqual([]);
    expect(parseImpersonateTargets(AVAILABLE)).toEqual(['chrome', 'chrome-131', 'edge', 'safari']);
    expect(parseImpersonateTargets('garbage')).toEqual([]);
  });
});

describe('checkImpersonation', () => {
  test('supported when at least one target is available; carries a reason otherwise', async () => {
    const dir = tmp();
    const ok = writeScript(join(dir, 'ok'), `cat <<'EOF'\n${AVAILABLE}EOF`);
    const no = writeScript(join(dir, 'no'), `cat <<'EOF'\n${UNAVAILABLE}EOF`);
    expect(await checkImpersonation(ok, { signal: noSignal() })).toMatchObject({
      supported: true,
      targets: ['chrome', 'chrome-131', 'edge', 'safari'],
    });
    const r = await checkImpersonation(no, { signal: noSignal() });
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/curl_cffi/);
  });

  test('a missing binary is reported, not thrown', async () => {
    const r = await checkImpersonation(join(tmp(), 'absent'), { signal: noSignal() });
    expect(r).toMatchObject({ supported: false });
    expect(r.reason).toMatch(/not found|could not run/i);
  });

  test('asks yt-dlp with an argument array', async () => {
    const dir = tmp();
    const log = join(dir, 'argv');
    const bin = writeScript(join(dir, 'ytd'), `echo "$@" > '${log}'\ncat <<'EOF'\n${AVAILABLE}EOF`);
    await checkImpersonation(bin, { signal: noSignal() });
    expect(readFileSync(log, 'utf8').trim()).toBe('--list-impersonate-targets');
  });
});

describe('updateYtDlp / ytDlpVersion', () => {
  test('runs `-U` then reads the version', async () => {
    const dir = tmp();
    const log = join(dir, 'argv');
    const bin = writeScript(
      join(dir, 'ytd'),
      `echo "$@" >> '${log}'\n[ "$1" = "--version" ] && echo 2026.09.01\n[ "$1" = "-U" ] && echo "Updated yt-dlp to 2026.09.01"\nexit 0`,
    );
    const lines: string[] = [];
    const r = await updateYtDlp(bin, { signal: noSignal(), onOutput: (l) => lines.push(l) });
    expect(r).toEqual({ version: '2026.09.01' });
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['-U', '--version']);
    expect(lines).toContain('Updated yt-dlp to 2026.09.01');
    expect(await ytDlpVersion(bin, { signal: noSignal() })).toBe('2026.09.01');
  });

  test('a failing update surfaces COMMAND_FAILED', async () => {
    const bin = writeScript(join(tmp(), 'ytd'), 'echo "ERROR: no network" >&2; exit 1');
    await expect(updateYtDlp(bin, { signal: noSignal() })).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
    });
  });
});
