// D-12 py-env resync: a changed bundled uv.lock triggers exactly one `uv sync --frozen --no-editable`;
// an unchanged one does not; S31: nothing is written into the bundled py/ folder.
import { describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkPyEnv,
  doctorPyEnv,
  ensurePyEnv,
  lockHashOf,
  syncPyEnv,
} from '../../src/engine-host/setup/pyenv.ts';
import { toolPaths } from '../../src/engine-host/setup/paths.ts';
import type { SetupProgressEvent } from '../../src/engine-host/setup/types.ts';
import { SetupError } from '../../src/engine-host/setup/errors.ts';
import { noSignal, sha256, tmp, writeScript } from './helpers.ts';

/** A fake uv: records argv + the UV_* env as one JSON line per call, then fakes an env. */
function fixture(opts: { failWith?: string } = {}) {
  const root = tmp();
  const pyDir = join(root, 'bundle', 'py');
  mkdirSync(pyDir, { recursive: true });
  writeFileSync(join(pyDir, 'uv.lock'), 'lock v1\n');
  writeFileSync(join(pyDir, 'pyproject.toml'), '[project]\nname="x"\n');
  const toolsDir = join(root, 'tools');
  const calls = join(root, 'calls.jsonl');
  const uv = writeScript(
    join(root, 'fake-uv'),
    `printf '{"argv":"%s","cwd":"%s","env":"%s|%s|%s"}\\n' "$*" "$PWD" "$UV_PROJECT_ENVIRONMENT" "$UV_CACHE_DIR" "$UV_PYTHON_INSTALL_DIR" >> '${calls}'
echo "Resolved packages"
${opts.failWith === undefined ? 'mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"; : > "$UV_PROJECT_ENVIRONMENT/bin/python"' : `echo '${opts.failWith}' >&2; exit 3`}`,
  );
  const readCalls = () =>
    existsSync(calls)
      ? readFileSync(calls, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as { argv: string; cwd: string; env: string })
      : [];
  return { root, pyDir, toolsDir, uv, lockPath: join(pyDir, 'uv.lock'), readCalls };
}

describe('lock hash', () => {
  test('lockHashOf is the SHA-256 of the file', async () => {
    const f = fixture();
    expect(await lockHashOf(f.lockPath)).toBe(sha256('lock v1\n'));
  });
});

describe('syncPyEnv / ensurePyEnv', () => {
  test('first run: one frozen no-editable sync into the tools folder, then the lock hash is recorded', async () => {
    const f = fixture();
    const paths = toolPaths(f.toolsDir);
    expect((await checkPyEnv({ toolsDir: f.toolsDir, lockPath: f.lockPath })).state).toBe(
      'missing',
    );
    const events: SetupProgressEvent[] = [];
    const out: string[] = [];
    await ensurePyEnv({
      uvPath: f.uv,
      pyDir: f.pyDir,
      toolsDir: f.toolsDir,
      signal: noSignal(),
      onProgress: (e) => events.push(e),
      onOutput: (l) => out.push(l),
    });
    const calls = f.readCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toBe(`sync --frozen --no-editable --project ${f.pyDir}`);
    expect(calls[0]!.env).toBe(`${paths.pyEnv}|${paths.uvCache}|${paths.python}`);
    expect(readFileSync(paths.lockHash, 'utf8').trim()).toBe(sha256('lock v1\n'));
    expect(await checkPyEnv({ toolsDir: f.toolsDir, lockPath: f.lockPath })).toMatchObject({
      state: 'current',
    });
    expect(out).toContain('Resolved packages');
    expect(events.map((e) => e.phase)).toEqual(expect.arrayContaining(['sync', 'done']));
    expect(events.every((e) => e.component === 'python-env')).toBe(true);
  });

  test('unchanged lock: no second sync', async () => {
    const f = fixture();
    const args = { uvPath: f.uv, pyDir: f.pyDir, toolsDir: f.toolsDir, signal: noSignal() };
    await ensurePyEnv(args);
    const second = await ensurePyEnv(args);
    expect(second.synced).toBe(false);
    expect(f.readCalls()).toHaveLength(1);
  });

  test('changed lock (app update): exactly one more sync, hash updated', async () => {
    const f = fixture();
    const args = { uvPath: f.uv, pyDir: f.pyDir, toolsDir: f.toolsDir, signal: noSignal() };
    await ensurePyEnv(args);
    writeFileSync(f.lockPath, 'lock v2 with onnxruntime\n');
    expect(await checkPyEnv({ toolsDir: f.toolsDir, lockPath: f.lockPath })).toMatchObject({
      state: 'stale',
      expected: sha256('lock v2 with onnxruntime\n'),
      actual: sha256('lock v1\n'),
    });
    const r = await ensurePyEnv(args);
    expect(r.synced).toBe(true);
    expect(f.readCalls()).toHaveLength(2);
    expect((await checkPyEnv({ toolsDir: f.toolsDir, lockPath: f.lockPath })).state).toBe(
      'current',
    );
  });

  test('concurrent ensure calls share one sync', async () => {
    const f = fixture();
    const args = { uvPath: f.uv, pyDir: f.pyDir, toolsDir: f.toolsDir, signal: noSignal() };
    await Promise.all([ensurePyEnv(args), ensurePyEnv(args), ensurePyEnv(args)]);
    expect(f.readCalls()).toHaveLength(1);
  });

  test('a failed sync records no hash, drops the old one, and carries the stderr tail', async () => {
    const f = fixture();
    const good = { uvPath: f.uv, pyDir: f.pyDir, toolsDir: f.toolsDir, signal: noSignal() };
    await ensurePyEnv(good);
    writeFileSync(f.lockPath, 'lock v2\n');
    const bad = fixture({ failWith: 'error: no matching wheel for mlx' });
    let err: unknown;
    try {
      await syncPyEnv({ ...good, uvPath: bad.uv });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SetupError);
    expect((err as SetupError).code).toBe('COMMAND_FAILED');
    expect((err as SetupError).message).toContain('no matching wheel for mlx');
    expect((await checkPyEnv({ toolsDir: f.toolsDir, lockPath: f.lockPath })).state).toBe(
      'missing',
    );
  });

  test('S31: sync writes nothing into the bundled py/ folder', async () => {
    const f = fixture();
    const before = readdirSync(f.pyDir).sort();
    await ensurePyEnv({ uvPath: f.uv, pyDir: f.pyDir, toolsDir: f.toolsDir, signal: noSignal() });
    expect(readdirSync(f.pyDir).sort()).toEqual(before);
  });

  test('an abort kills the child and rejects', async () => {
    const f = fixture();
    const slow = writeScript(join(f.root, 'slow-uv'), 'sleep 30');
    const ac = new AbortController();
    const p = syncPyEnv({ uvPath: slow, pyDir: f.pyDir, toolsDir: f.toolsDir, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect((await checkPyEnv({ toolsDir: f.toolsDir, lockPath: f.lockPath })).state).toBe(
      'missing',
    );
  });

  test('a missing lockfile is reported', async () => {
    const f = fixture();
    await expect(
      checkPyEnv({ toolsDir: f.toolsDir, lockPath: join(f.pyDir, 'nope.lock') }),
    ).rejects.toMatchObject({ code: 'NO_LOCKFILE' });
  });
});

describe('doctorPyEnv', () => {
  test('reports ok, missing and stale with a fix', async () => {
    const f = fixture();
    const base = { toolsDir: f.toolsDir, lockPath: f.lockPath };
    const missing = await doctorPyEnv(base);
    expect(missing).toMatchObject({ ok: false, state: 'missing' });
    expect(missing.fix).toContain('uv sync --frozen --no-editable');
    await ensurePyEnv({ uvPath: f.uv, pyDir: f.pyDir, toolsDir: f.toolsDir, signal: noSignal() });
    expect(await doctorPyEnv(base)).toMatchObject({ ok: true, state: 'current' });
    writeFileSync(f.lockPath, 'changed\n');
    const stale = await doctorPyEnv(base);
    expect(stale).toMatchObject({ ok: false, state: 'stale' });
    expect(stale.message).toMatch(/lock/i);
    expect(stale.fix).toContain('uv sync --frozen --no-editable');
  });
});
