// Python environment (app spec "First-run setup", D-12). `uv sync --frozen --no-editable` of the bundled
// py/ project into <tools>/py-env. After a sync the SHA-256 of the bundled uv.lock is stored in
// <tools>/py-env/.vox-lock-hash; a different hash on launch (an app update that adds packages) triggers a
// re-sync. Nothing is written into the bundle: the env, uv cache and Python all live in the tools folder.

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

export type PyEnvState = 'missing' | 'stale' | 'current';

export interface PyEnvCheck {
  state: PyEnvState;
  /** SHA-256 of the bundled uv.lock */
  expected: string;
  /** Hash stored by the last sync, if any */
  actual?: string;
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
  if (actual !== expected) return { state: 'stale', expected, actual };
  // A deleted python/ folder or a dangling interpreter link leaves the hash file behind: not usable.
  try {
    await stat(join(toolPaths(opts.toolsDir).pyEnv, 'bin', 'python'));
  } catch {
    return { state: 'missing', expected, actual };
  }
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

/**
 * The exact arguments of the sync, in one place. `--compile-bytecode` (phase 09): the setup pays the
 * one-time bytecode compile, so the first doctor run and the first job do not (minutes otherwise).
 */
export function syncArgs(pyDir: string): string[] {
  return ['sync', '--frozen', '--no-editable', '--compile-bytecode', '--project', pyDir];
}

/** Variables that could redirect the frozen sync to another index, mirror, config or interpreter. */
const STRIPPED_ENV =
  /^(UV_(.*INDEX.*|FIND_LINKS|PYTHON(_INSTALL_MIRROR|_DOWNLOADS.*)?|CONFIG_FILE|NO_CONFIG|PROJECT.*|CACHE_DIR|FROZEN|LOCKED)|PIP_.*|PYTHON.*|VIRTUAL_ENV)$/;

export function syncEnv(
  toolsDir: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const p = toolPaths(toolsDir);
  const kept = Object.fromEntries(Object.entries(base).filter(([k]) => !STRIPPED_ENV.test(k)));
  return {
    ...kept,
    UV_NO_CONFIG: '1',
    UV_PROJECT_ENVIRONMENT: p.pyEnv,
    UV_CACHE_DIR: p.uvCache,
    UV_PYTHON_INSTALL_DIR: p.python,
  };
}

/** Runs the sync unconditionally. The stored hash is removed first, so a failed or aborted sync reads as `missing`. */
export function syncPyEnv(opts: SyncOptions): Promise<void> {
  return withLock(`pyenv:${opts.toolsDir}`, () => syncPyEnvLocked(opts));
}

async function syncPyEnvLocked(opts: SyncOptions): Promise<void> {
  const paths = toolPaths(opts.toolsDir);
  const expected = await lockHashOf(join(opts.pyDir, 'uv.lock'));
  await mkdir(paths.root, { recursive: true });
  await rm(paths.lockHash, { force: true });
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
  const tmp = `${paths.lockHash}.tmp`;
  await writeFile(tmp, expected);
  await rename(tmp, paths.lockHash);
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
        message: 'Python environment matches the bundled uv.lock.',
      };
    case 'stale':
      return {
        ok: false,
        state: 'stale',
        message:
          'The Python environment was built from an older uv.lock than this app version ships.',
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
