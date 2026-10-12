// Python environment (app spec "First-run setup", D-12). `uv sync --frozen --no-editable` of the bundled
// py/ project into <tools>/py-env. After a sync the SHA-256 of the bundled uv.lock is stored in
// <tools>/py-env/.vox-lock-hash and a hash of the project's own files (pyproject.toml, vox_py/) in
// .vox-src-hash; a different hash on launch (an app update that adds packages or changes a tool) triggers
// a re-sync. The sync reinstalls vox_py: its version never changes, so uv would keep the wheel it built
// first (GATE 5: an installed app ran the phase-04 facetrack after many rebuilds). Nothing is written
// into the bundle: the env, uv cache and Python all live in the tools folder.

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PY_PACKAGE, pyEnvSyncArgs, pyEnvSyncEnv, sourceHashOf } from '@vox/engine/pyenv';
import { SetupError } from './errors.ts';
import { sha256File } from './hash.ts';
import { withLock } from './lock.ts';
import { toolPaths } from './paths.ts';
import { runCommand, tail } from './run.ts';
import { progress } from './types.ts';
import type { ProgressSink } from './types.ts';

export const PY_ENV_ID = 'python-env';

export async function lockHashOf(lockPath: string): Promise<string> {
  try {
    return await sha256File(lockPath);
  } catch (cause) {
    throw new SetupError('NO_LOCKFILE', `bundled lockfile not readable: ${lockPath}`, { cause });
  }
}

// The hash, the sync arguments and its environment are shared with the engine's dev-checkout sync
// (D-87), so both write the same stamps.
export { PY_PACKAGE, sourceHashOf };

export type PyEnvState = 'missing' | 'stale' | 'current';

export interface PyEnvCheck {
  state: PyEnvState;
  /** SHA-256 of the bundled uv.lock */
  expected: string;
  /** Hash stored by the last sync, if any */
  actual?: string;
  /** What is stale: the package pins (uv.lock) or the project's own files */
  stale?: 'lock' | 'sources';
}

export async function checkPyEnv(opts: {
  toolsDir: string;
  lockPath: string;
}): Promise<PyEnvCheck> {
  const expected = await lockHashOf(opts.lockPath);
  let actual: string | undefined;
  try {
    actual = (await readFile(toolPaths(opts.toolsDir).lockHash, 'utf8')).trim();
  } catch {
    return { state: 'missing', expected };
  }
  if (actual !== expected) return { state: 'stale', expected, actual, stale: 'lock' };
  // A deleted python/ folder or a dangling interpreter link leaves the hash file behind: not usable.
  try {
    await stat(join(toolPaths(opts.toolsDir).pyEnv, 'bin', 'python'));
  } catch {
    return { state: 'missing', expected, actual };
  }
  // An env from before the source hash has no file: stale too, so it is rebuilt once.
  const sources = await sourceHashOf(dirname(opts.lockPath));
  const built = await readFile(toolPaths(opts.toolsDir).srcHash, 'utf8').then(
    (t) => t.trim(),
    () => undefined,
  );
  if (built !== sources) return { state: 'stale', expected, actual, stale: 'sources' };
  return { state: 'current', expected, actual };
}

export interface SyncOptions {
  uvPath: string;
  /** The bundled py/ project folder (read only). */
  pyDir: string;
  toolsDir: string;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onProgress?: ProgressSink;
  /** Each line uv prints. */
  onOutput?: (line: string) => void;
}

/** The exact arguments of the sync (`@vox/engine/pyenv` explains each flag). */
export function syncArgs(pyDir: string): string[] {
  return pyEnvSyncArgs(pyDir);
}

/** The sync's environment: uv's env, cache and Pythons in the tools folder, no outside uv config. */
export function syncEnv(
  toolsDir: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return pyEnvSyncEnv(toolsDir, base);
}

/** Runs the sync unconditionally. The stored hash is removed first, so a failed or aborted sync reads as `missing`. */
export function syncPyEnv(opts: SyncOptions): Promise<void> {
  return withLock(`pyenv:${opts.toolsDir}`, () => syncPyEnvLocked(opts));
}

async function syncPyEnvLocked(opts: SyncOptions): Promise<void> {
  const paths = toolPaths(opts.toolsDir);
  const expected = await lockHashOf(join(opts.pyDir, 'uv.lock'));
  const sources = await sourceHashOf(opts.pyDir);
  await mkdir(paths.root, { recursive: true });
  await rm(paths.lockHash, { force: true });
  await rm(paths.srcHash, { force: true });
  progress(opts.onProgress, PY_ENV_ID, 'sync', { message: 'uv sync --frozen --no-editable' });
  const r = await runCommand(opts.uvPath, syncArgs(opts.pyDir), {
    signal: opts.signal,
    env: syncEnv(opts.toolsDir, opts.env),
    cwd: paths.root,
    onLine: (line) => {
      opts.onOutput?.(line);
      progress(opts.onProgress, PY_ENV_ID, 'sync', { message: line });
    },
  });
  if (r.code !== 0) {
    const msg = `uv sync failed (exit ${String(r.code)}): ${tail(r.stderr || r.stdout)}`;
    progress(opts.onProgress, PY_ENV_ID, 'error', { message: msg });
    throw new SetupError('COMMAND_FAILED', msg);
  }
  await mkdir(dirname(paths.lockHash), { recursive: true });
  for (const [file, value] of [
    [paths.srcHash, sources],
    [paths.lockHash, expected],
  ] as const) {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, value);
    await rename(tmp, file);
  }
  progress(opts.onProgress, PY_ENV_ID, 'done');
}

const inFlight = new Map<string, Promise<{ synced: boolean }>>();

/**
 * Syncs when the env is missing or stale. Concurrent callers for one tools folder share one sync (the
 * first caller's signal and callbacks apply); a forced `syncPyEnv` queues behind a running sync.
 */
export function ensurePyEnv(opts: SyncOptions): Promise<{ synced: boolean }> {
  const existing = inFlight.get(opts.toolsDir);
  if (existing !== undefined) return existing;
  const run = (async () => {
    const check = await checkPyEnv({
      toolsDir: opts.toolsDir,
      lockPath: join(opts.pyDir, 'uv.lock'),
    });
    if (check.state === 'current') return { synced: false };
    await syncPyEnv(opts);
    return { synced: true };
  })().finally(() => inFlight.delete(opts.toolsDir));
  inFlight.set(opts.toolsDir, run);
  return run;
}

export interface PyEnvDoctor {
  ok: boolean;
  state: PyEnvState;
  message: string;
  fix?: string;
}

const FIX =
  'Open Vox Studio setup and choose Repair for the Python environment. It runs `uv sync --frozen --no-editable` on the bundled py/ project.';

/** The `vox doctor` / setup-screen view of the Python env (D-12). */
export async function doctorPyEnv(opts: {
  toolsDir: string;
  lockPath: string;
}): Promise<PyEnvDoctor> {
  const c = await checkPyEnv(opts);
  switch (c.state) {
    case 'current':
      return {
        ok: true,
        state: 'current',
        message: 'Python environment matches the bundled uv.lock and Python tools.',
      };
    case 'stale':
      return {
        ok: false,
        state: 'stale',
        message:
          c.stale === 'sources'
            ? 'The Python environment was built from older Python tools than this app version ships.'
            : 'The Python environment was built from an older uv.lock than this app version ships.',
        fix: FIX,
      };
    case 'missing':
      return {
        ok: false,
        state: 'missing',
        message: 'The Python environment is not installed.',
        fix: FIX,
      };
  }
}
