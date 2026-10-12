// Stale gate tools (D-87): a tools folder copied from an installed app keeps that app's vox_py. With
// the dev-checkout sync turned on for the folder (the dev CLI with VOX_TOOLS_DIR), the first Python
// tool first re-syncs the env from the checkout's py/ (the app's own sync command and stamps, D-12);
// without it (packaged app, engine tests) nothing changes. The stamps are what `vox doctor` shows.
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { doctor } from '../../src/doctor.ts';
import { isVoxError } from '../../src/errors.ts';
import { assertPyEnvCurrent, runPyTool } from '../../src/py.ts';
import {
  disableCheckoutPyEnvSync,
  enableCheckoutPyEnvSync,
  pyEnvStamp,
  pyEnvSyncArgs,
  sourceHashOf,
} from '../../src/pyenv.ts';

const Echo = z.object({ echo: z.unknown() });
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) {
    disableCheckoutPyEnvSync(join(d, 'tools'));
    rmSync(d, { recursive: true, force: true });
  }
});

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A checkout's py/ project, a tools folder whose py-env was built from older sources, a fake uv. */
function fixture(opts: { failSync?: boolean } = {}) {
  const root = tmp('vox-pyenv-');
  const py = join(root, 'py');
  mkdirSync(join(py, 'vox_py'), { recursive: true });
  writeFileSync(join(py, 'pyproject.toml'), '[project]\nname = "vox_py"\n');
  writeFileSync(join(py, 'uv.lock'), 'lock v1\n');
  writeFileSync(join(py, 'vox_py', 'facetrack.py'), 'DETECTOR_VERSION = 2\n');
  const tools = join(root, 'tools');
  const pyEnv = join(tools, 'py-env');
  mkdirSync(join(pyEnv, 'bin'), { recursive: true });
  writeFileSync(join(pyEnv, 'bin', 'python'), '');
  // what the installed app's setup left: the same lock, older tool sources
  writeFileSync(join(pyEnv, '.vox-lock-hash'), `${sha('lock v1\n')}\n`);
  writeFileSync(join(pyEnv, '.vox-src-hash'), `${'0'.repeat(64)}\n`);
  const calls = join(root, 'calls.txt');
  const uv = join(root, 'fake-uv');
  writeFileSync(
    uv,
    [
      '#!/bin/sh',
      `echo "$UV_PROJECT_ENVIRONMENT|$*" >> '${calls}'`,
      'if [ "$1" = sync ]; then',
      opts.failSync ? '  echo "error: no network" >&2; exit 3' : '  echo "Installed 1 package" >&2',
      '  exit 0',
      'fi',
      'cat > /dev/null',
      `echo '{"echo": 1}'`,
      '',
    ].join('\n'),
  );
  chmodSync(uv, 0o755);
  const lines = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  return { root, py, tools, pyEnv, uv, lines };
}

const run = (f: ReturnType<typeof fixture>) =>
  runPyTool('echo_tool', {}, Echo, { uv: f.uv, pyProject: f.py, toolsDir: f.tools });

describe('the py-env stamp (D-12, D-87)', () => {
  test('current, stale sources, stale lock, unsynced', async () => {
    const f = fixture();
    const tools = { py: f.py, pyEnv: f.pyEnv };
    const s = await pyEnvStamp(tools);
    expect(s).toMatchObject({
      state: 'stale-sources',
      pyEnv: f.pyEnv,
      src: { have: '0'.repeat(64) },
    });
    expect(s?.src.want).toBe(await sourceHashOf(f.py));
    writeFileSync(join(f.pyEnv, '.vox-src-hash'), await sourceHashOf(f.py));
    expect((await pyEnvStamp(tools))?.state).toBe('current');
    // a tool fix changes the source hash, not the lock
    writeFileSync(join(f.py, 'vox_py', 'facetrack.py'), 'DETECTOR_VERSION = 3\n');
    expect((await pyEnvStamp(tools))?.state).toBe('stale-sources');
    writeFileSync(join(f.pyEnv, '.vox-lock-hash'), 'f'.repeat(64));
    expect((await pyEnvStamp(tools))?.state).toBe('stale-lock');
    rmSync(join(f.pyEnv, '.vox-lock-hash'));
    expect((await pyEnvStamp(tools))?.state).toBe('unsynced');
    expect(await pyEnvStamp({ py: f.py })).toBeUndefined();
  });

  test('vox doctor shows the source hashes and whether they match', async () => {
    const f = fixture();
    const report = () =>
      doctor({
        tools: { py: f.py, pyEnv: f.pyEnv, dir: f.tools },
        config: { contact: 'me@example.org' },
        exec: async () => ({ code: -1, stdout: '', stderr: '' }),
        quick: true,
        home: tmp('vox-home-'),
      });
    const want = (await sourceHashOf(f.py)).slice(0, 12);
    const stale = (await report()).checks.find((c) => c.name === 'python-env-source');
    expect(stale).toMatchObject({ level: 'warn', path: f.pyEnv });
    expect(stale?.detail).toContain(want);
    expect(stale?.detail).toContain('0'.repeat(12));
    expect(stale?.fix).toMatch(/Repair/);
    enableCheckoutPyEnvSync(f.tools);
    const dev = (await report()).checks.find((c) => c.name === 'python-env-source');
    expect(dev?.fix).toMatch(/next Python tool/);
    // a lock from another build: an error in the app, a warning where the next tool syncs it
    writeFileSync(join(f.pyEnv, '.vox-lock-hash'), 'f'.repeat(64));
    const devLock = await report();
    expect(devLock.checks.find((c) => c.name === 'python-env-lock')).toMatchObject({
      level: 'warn',
      fix: expect.stringMatching(/next Python tool/),
    });
    disableCheckoutPyEnvSync(f.tools);
    const appLock = await report();
    expect(appLock.checks.find((c) => c.name === 'python-env-lock')).toMatchObject({
      level: 'error',
    });
    expect(appLock.ok).toBe(false);
    enableCheckoutPyEnvSync(f.tools);
    writeFileSync(join(f.pyEnv, '.vox-lock-hash'), sha('lock v1\n'));
    writeFileSync(join(f.pyEnv, '.vox-src-hash'), await sourceHashOf(f.py));
    const ok = (await report()).checks.find((c) => c.name === 'python-env-source');
    expect(ok).toMatchObject({ level: 'ok' });
    expect(ok?.detail).toContain(want);
  });
});

describe('dev checkout: the py-env is synced before the first Python tool (D-87)', () => {
  test('a stale env is synced once with the app command, then every tool runs on it', async () => {
    const f = fixture();
    const log: string[] = [];
    enableCheckoutPyEnvSync(f.tools, { log: (l) => log.push(l) });
    await Promise.all([run(f), run(f)]);
    await run(f);
    const lines = f.lines();
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(`${f.pyEnv}|${pyEnvSyncArgs(f.py).join(' ')}`);
    expect(lines[0]).toMatch(/sync --frozen --no-editable .*--reinstall-package vox_py/);
    expect(lines.slice(1).every((l) => l.startsWith(`${f.pyEnv}|run `))).toBe(true);
    expect(readFileSync(join(f.pyEnv, '.vox-src-hash'), 'utf8').trim()).toBe(
      await sourceHashOf(f.py),
    );
    expect(readFileSync(join(f.pyEnv, '.vox-lock-hash'), 'utf8').trim()).toBe(sha('lock v1\n'));
    expect(log.join('\n')).toMatch(/built from other Python sources.*syncing/);
    expect(log.join('\n')).toMatch(/Installed 1 package/);
    expect(log.join('\n')).toMatch(/synced in/);
  });

  test('a current env is not synced', async () => {
    const f = fixture();
    writeFileSync(join(f.pyEnv, '.vox-src-hash'), await sourceHashOf(f.py));
    enableCheckoutPyEnvSync(f.tools);
    await run(f);
    expect(f.lines()).toHaveLength(1);
    expect(f.lines()[0]).toMatch(/\|run /);
  });

  test('the lock check before mflux jobs syncs first instead of refusing', async () => {
    const f = fixture();
    writeFileSync(join(f.pyEnv, '.vox-lock-hash'), 'f'.repeat(64));
    enableCheckoutPyEnvSync(f.tools);
    await assertPyEnvCurrent({ py: f.py, pyEnv: f.pyEnv, dir: f.tools, uv: f.uv });
    expect(f.lines()).toHaveLength(1);
    expect(f.lines()[0]).toMatch(/\|sync /);
  });

  test('a failed sync fails the tool with the command to run, and never runs the old code', async () => {
    const f = fixture({ failSync: true });
    enableCheckoutPyEnvSync(f.tools);
    const err = await run(f).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isVoxError(err) && err.code).toBe('TOOL_FAILED');
    expect(isVoxError(err) && err.message).toMatch(/error: no network/);
    expect(isVoxError(err) && err.hint).toMatch(/uv sync --frozen --no-editable/);
    expect(f.lines()).toHaveLength(1);
    // the stamps are gone, so the env reads as unsynced until a sync succeeds
    expect((await pyEnvStamp({ py: f.py, pyEnv: f.pyEnv }))?.state).toBe('unsynced');
  });

  test('without the dev sync (packaged app, engine tests) a stale env runs as before', async () => {
    const f = fixture();
    await run(f);
    expect(f.lines()).toHaveLength(1);
    expect(f.lines()[0]).toMatch(/\|run /);
  });
});
