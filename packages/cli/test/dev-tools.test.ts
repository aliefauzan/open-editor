// Stale gate tools (D-87): the dev CLI never runs Python tools on a tools folder env built from other
// sources than the checkout. With VOX_TOOLS_DIR it turns on the engine's sync for that folder; the
// installed app's own folder (the default) is never changed, a stale one is left out instead (the
// tools then run in py/.venv). The bundled CLI changes nothing. The Apple helper gets an mtime check.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { checkoutPyEnvSyncEnabled, disableCheckoutPyEnvSync } from '@vox/engine';
import { appleHelperFreshness, checkoutTools } from '../src/dev-tools.ts';
import { run } from '../src/main.ts';

const PY = fileURLToPath(new URL('../../../py', import.meta.url));
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A tools folder with a py-env built by an older app: this checkout's lock, older sources. */
function toolsWithOldEnv(dir: string): string {
  const pyEnv = join(dir, 'py-env');
  mkdirSync(join(pyEnv, 'bin'), { recursive: true });
  writeFileSync(join(pyEnv, 'bin', 'python'), '');
  return pyEnv;
}
async function stamp(pyEnv: string, src: string) {
  const { readFileSync } = await import('node:fs');
  const lock = createHash('sha256')
    .update(readFileSync(join(PY, 'uv.lock')))
    .digest('hex');
  writeFileSync(join(pyEnv, '.vox-lock-hash'), lock);
  writeFileSync(join(pyEnv, '.vox-src-hash'), src);
}

describe('dev CLI and the tools folder Python env (D-87)', () => {
  test('VOX_TOOLS_DIR: the engine sync is turned on for that folder; the tools stay', async () => {
    const dir = tmp('vox-gate-tools-');
    const pyEnv = toolsWithOldEnv(dir);
    await stamp(pyEnv, '0'.repeat(64));
    const tools = { dir, pyEnv, py: PY };
    let err = '';
    try {
      const out = await checkoutTools(
        { env: { VOX_TOOLS_DIR: dir }, stderr: (s) => (err += s) },
        tools,
      );
      expect(out).toEqual(tools);
      expect(checkoutPyEnvSyncEnabled(dir)).toBe(true);
    } finally {
      disableCheckoutPyEnvSync(dir);
    }
  });

  test("the installed app's folder: a stale env is left out with a line, never changed", async () => {
    const dir = tmp('vox-app-tools-');
    const pyEnv = toolsWithOldEnv(dir);
    await stamp(pyEnv, '0'.repeat(64));
    let err = '';
    const out = await checkoutTools({ env: {}, stderr: (s) => (err += s) }, { dir, pyEnv, py: PY });
    expect(out).toEqual({ dir, py: PY });
    expect(err).toMatch(/not using the Python env in .*other Python sources.*py\/\.venv/s);
    expect(err).toMatch(/VOX_TOOLS_DIR/);
    expect(checkoutPyEnvSyncEnabled(dir)).toBe(false);
    // a current env is kept, silently
    const { sourceHashOf } = await import('@vox/engine/pyenv');
    await stamp(pyEnv, await sourceHashOf(PY));
    err = '';
    expect(
      await checkoutTools({ env: {}, stderr: (s) => (err += s) }, { dir, pyEnv, py: PY }),
    ).toEqual({ dir, pyEnv, py: PY });
    expect(err).toBe('');
  });

  test('vox doctor in a checkout shows the env source hash and that the next tool syncs it', async () => {
    const dir = tmp('vox-gate-tools-');
    const pyEnv = toolsWithOldEnv(dir);
    await stamp(pyEnv, '0'.repeat(64));
    let stdout = '';
    try {
      await run(['doctor', '--quick', '--json'], {
        stdout: (s) => (stdout += s),
        stderr: () => undefined,
        env: {
          HOME: '/nonexistent-home',
          VOX_HOME: tmp('vox-home-'),
          VOX_TOOLS_DIR: dir,
          PATH: process.env['PATH'],
        },
        cwd: tmp('vox-cwd-'),
      });
    } finally {
      disableCheckoutPyEnvSync(dir);
    }
    const r = JSON.parse(stdout) as { checks: { name: string; level: string; fix?: string }[] };
    expect(r.checks.find((c) => c.name === 'python-env-source')).toMatchObject({
      level: 'warn',
      fix: expect.stringMatching(/next Python tool/),
    });
  }, 60_000);
});

describe('dev CLI and the Apple helper build', () => {
  test('a helper older than the Swift sources is stale; a newer build is fresh', () => {
    const native = tmp('vox-native-');
    mkdirSync(join(native, 'Sources', 'core'), { recursive: true });
    writeFileSync(join(native, 'Package.swift'), '// swift\n');
    writeFileSync(join(native, 'Sources', 'core', 'Sounds.swift'), '// v2\n');
    const helper = join(native, 'vox-apple-llm');
    writeFileSync(helper, '');
    const t = Date.now() / 1000;
    utimesSync(helper, t - 3600, t - 3600);
    utimesSync(join(native, 'Package.swift'), t - 7200, t - 7200);
    utimesSync(join(native, 'Sources', 'core', 'Sounds.swift'), t - 60, t - 60);
    expect(appleHelperFreshness(helper, native)).toMatchObject({ stale: true });
    utimesSync(helper, t, t);
    expect(appleHelperFreshness(helper, native)).toMatchObject({ stale: false });
    expect(appleHelperFreshness(helper, join(native, 'none'))).toBeUndefined();
  });
});
