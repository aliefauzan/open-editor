// Phase 14d (D-12): an app built from phase 13 and then updated to 14d (mflux added to py/uv.lock)
// finds a different bundled lock hash on launch and resyncs the Python env exactly once.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  checkPyEnv,
  ensurePyEnv,
  lockHashOf,
  sourceHashOf,
} from '../../src/engine-host/setup/pyenv.ts';
import { toolPaths } from '../../src/engine-host/setup/paths.ts';
import { noSignal, tmp, writeScript } from './helpers.ts';

const PY = fileURLToPath(new URL('../../../../py', import.meta.url));
/** SHA-256 of py/uv.lock as shipped by phase 13 (v1.0, commit ee82856). */
const LOCK_SHA_PHASE_13 = '65bccc65825ff6c28c44fe3f62c852d8fc0a2d20f8ac72b1b815951a577d4d0d';

describe('py-env resync after the 13 → 14d update', () => {
  test('the 14d lock adds mflux and has a different hash than the 13 lock', async () => {
    const lock = readFileSync(join(PY, 'uv.lock'), 'utf8');
    expect(lock).toMatch(/name = "mflux"\nversion = "0\.22\.0"/);
    expect(await lockHashOf(join(PY, 'uv.lock'))).not.toBe(LOCK_SHA_PHASE_13);
  });

  test('an env built by 13 is stale on launch; one sync with --frozen --no-editable; then current', async () => {
    const root = tmp('vox-resync');
    const toolsDir = join(root, 'tools');
    const calls = join(root, 'calls.txt');
    const uv = writeScript(
      join(root, 'fake-uv'),
      `echo "$*" >> '${calls}'\nmkdir -p "$UV_PROJECT_ENVIRONMENT/bin"; : > "$UV_PROJECT_ENVIRONMENT/bin/python"`,
    );
    // what the setup of the 13 app left behind: a working env, its lock hash and source hash
    const paths = toolPaths(toolsDir);
    mkdirSync(join(paths.pyEnv, 'bin'), { recursive: true });
    writeFileSync(join(paths.pyEnv, 'bin', 'python'), '');
    writeFileSync(paths.lockHash, `${LOCK_SHA_PHASE_13}\n`);
    writeFileSync(paths.srcHash, `${await sourceHashOf(PY)}\n`);

    const lockPath = join(PY, 'uv.lock');
    expect(await checkPyEnv({ toolsDir, lockPath })).toMatchObject({
      state: 'stale',
      stale: 'lock',
      actual: LOCK_SHA_PHASE_13,
    });
    const args = { uvPath: uv, pyDir: PY, toolsDir, signal: noSignal() };
    expect((await ensurePyEnv(args)).synced).toBe(true);
    expect((await checkPyEnv({ toolsDir, lockPath })).state).toBe('current');
    expect((await ensurePyEnv(args)).synced).toBe(false);
    const lines = readFileSync(calls, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/sync/);
    expect(lines[0]).toMatch(/--frozen/);
    expect(lines[0]).toMatch(/--no-editable/);
    expect(existsSync(paths.lockHash)).toBe(true);
    expect(readFileSync(paths.lockHash, 'utf8').trim()).toBe(await lockHashOf(lockPath));
  });
});
