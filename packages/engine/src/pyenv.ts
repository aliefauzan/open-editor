// The Python env in a tools folder (`<tools>/py-env`, D-12) and its stamps. Setup syncs it with
// `uv sync --frozen --no-editable --compile-bytecode --reinstall-package vox_py` and then stores the
// SHA-256 of the uv.lock in `.vox-lock-hash` and a hash of the project's own files (pyproject.toml,
// vox_py/) in `.vox-src-hash`. The app (apps/desktop setup) re-syncs on launch when they differ.
//
// Dev checkout (D-87): a tools folder copied from an installed app keeps that app's vox_py, so a dev or
// gate run on a branch that changed py/ would silently test the old code. A caller that runs from a
// checkout (the dev CLI with VOX_TOOLS_DIR) turns on `enableCheckoutPyEnvSync` for the folder: the
// first Python tool (and the lock check before mflux jobs) then re-syncs a stale env from the
// checkout's py/ with the same command and stamps, once per process. The packaged app never turns it
// on. Published as `@vox/engine/pyenv` for the desktop main process: node built-ins and errors.ts only.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VoxError } from './errors.ts';

/** The package the py/ project builds (pyproject.toml `name`). */
export const PY_PACKAGE = 'vox_py';
export const LOCK_STAMP = '.vox-lock-hash';
export const SRC_STAMP = '.vox-src-hash';

export async function sha256Of(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/**
 * SHA-256 over the project's own files: pyproject.toml and every file under vox_py/ (path and bytes,
 * sorted; bytecode left out). The lock hash misses these: a tool fix changes no package pin.
 */
export async function sourceHashOf(pyDir: string): Promise<string> {
  const files: string[] = ['pyproject.toml'];
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(pyDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '__pycache__' || e.name.endsWith('.pyc')) continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) files.push(r);
    }
  };
  await walk(PY_PACKAGE);
  files.sort();
  const h = createHash('sha256');
  for (const f of files) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(pyDir, f));
    } catch {
      continue;
    }
    h.update(`${f}\0${String(bytes.length)}\0`);
    h.update(bytes);
  }
  return h.digest('hex');
}

/**
 * The exact arguments of the sync, in one place. `--compile-bytecode` (phase 09): the sync pays the
 * one-time bytecode compile, so the first doctor run and the first job do not (minutes otherwise).
 * `--reinstall-package vox_py` rebuilds the project itself (uv keys its cached build on
 * pyproject.toml, not on the tool files); the pinned packages stay as they are.
 */
export function pyEnvSyncArgs(pyDir: string): string[] {
  return [
    'sync',
    '--frozen',
    '--no-editable',
    '--compile-bytecode',
    '--reinstall-package',
    PY_PACKAGE,
    '--project',
    pyDir,
  ];
}

/** Variables that could redirect the frozen sync to another index, mirror, config or interpreter. */
const STRIPPED_ENV =
  /^(UV_(.*INDEX.*|FIND_LINKS|PYTHON(_INSTALL_MIRROR|_DOWNLOADS.*)?|CONFIG_FILE|NO_CONFIG|PROJECT.*|CACHE_DIR|FROZEN|LOCKED)|PIP_.*|PYTHON.*|VIRTUAL_ENV)$/;

/** The sync's environment: uv's env, cache and Pythons in the tools folder, no outside uv config. */
export function pyEnvSyncEnv(
  toolsDir: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(base).filter(([k]) => !STRIPPED_ENV.test(k)));
  return {
    ...kept,
    UV_NO_CONFIG: '1',
    UV_PROJECT_ENVIRONMENT: join(toolsDir, 'py-env'),
    UV_CACHE_DIR: join(toolsDir, 'uv-cache'),
    UV_PYTHON_INSTALL_DIR: join(toolsDir, 'python'),
  };
}

const q = (s: string) => (/^[\w./@%+=:,-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/** The sync as one shell command, for hints and logs. */
export function pyEnvSyncCommand(pyDir: string, toolsDir: string, uv = 'uv'): string {
  return [
    'UV_NO_CONFIG=1',
    `UV_PROJECT_ENVIRONMENT=${q(join(toolsDir, 'py-env'))}`,
    `UV_CACHE_DIR=${q(join(toolsDir, 'uv-cache'))}`,
    `UV_PYTHON_INSTALL_DIR=${q(join(toolsDir, 'python'))}`,
    q(uv),
    ...pyEnvSyncArgs(pyDir).map(q),
  ].join(' ');
}

export type PyEnvStampState = 'current' | 'stale-sources' | 'stale-lock' | 'unsynced';

export interface PyEnvStamp {
  state: PyEnvStampState;
  pyEnv: string;
  /** `want`: of the py/ project in use; `have`: stored by the last sync (absent when none). */
  lock: { want?: string; have?: string };
  src: { want: string; have?: string };
}

const readStamp = (path: string) =>
  readFile(path, 'utf8').then(
    (t) => t.trim() || undefined,
    () => undefined,
  );

/**
 * Whether the tools folder's env (`tools.pyEnv`) was synced from the py/ project in use
 * (`tools.py`): its uv.lock and its own files. Undefined without such an env (repo mode: `uv run
 * --frozen` syncs py/.venv by itself).
 */
export async function pyEnvStamp(
  tools: Readonly<Record<string, string | undefined>>,
): Promise<PyEnvStamp | undefined> {
  const pyEnv = tools['pyEnv'];
  const py = tools['py'];
  if (!pyEnv || !py) return undefined;
  const lockWant = await sha256Of(join(py, 'uv.lock')).catch(() => undefined);
  const lockHave = await readStamp(join(pyEnv, LOCK_STAMP));
  const srcWant = await sourceHashOf(py);
  const srcHave = await readStamp(join(pyEnv, SRC_STAMP));
  // a deleted python/ folder or a dangling interpreter link leaves the stamps behind: not usable
  const python = await stat(join(pyEnv, 'bin', 'python')).then(
    () => true,
    () => false,
  );
  const state: PyEnvStampState =
    lockHave === undefined || !python
      ? 'unsynced'
      : lockWant === undefined || lockHave !== lockWant
        ? 'stale-lock'
        : srcHave !== srcWant
          ? 'stale-sources'
          : 'current';
  return {
    state,
    pyEnv,
    lock: {
      ...(lockWant !== undefined && { want: lockWant }),
      ...(lockHave !== undefined && { have: lockHave }),
    },
    src: { want: srcWant, ...(srcHave !== undefined && { have: srcHave }) },
  };
}

// ---- dev checkout sync (D-87) ----

export interface CheckoutPyEnvSyncOptions {
  /** One line per event (the sync starts, each uv output line, the sync ends). */
  log?: (line: string) => void;
}

const enabled = new Map<string, CheckoutPyEnvSyncOptions>();
const inFlight = new Map<string, Promise<void>>();

/** Turns on the dev-checkout sync for one tools folder (the dev CLI with VOX_TOOLS_DIR). */
export function enableCheckoutPyEnvSync(
  toolsDir: string,
  opts: CheckoutPyEnvSyncOptions = {},
): void {
  enabled.set(toolsDir, opts);
}

export function disableCheckoutPyEnvSync(toolsDir: string): void {
  enabled.delete(toolsDir);
  inFlight.delete(toolsDir);
}

export function checkoutPyEnvSyncEnabled(toolsDir: string | undefined): boolean {
  return toolsDir !== undefined && enabled.has(toolsDir);
}

/** What a stale env was built from, for messages. */
export const PY_ENV_STALE_WHAT: Record<Exclude<PyEnvStampState, 'current'>, string> = {
  'stale-sources': 'other Python sources (vox_py) than this checkout',
  'stale-lock': 'another uv.lock than this checkout',
  unsynced: 'no recorded sync',
};

/**
 * With the dev sync on for `toolsDir`: re-syncs the env from `pyProject` when its stamps differ, once
 * per process (concurrent callers share one sync; a failed sync is tried again on the next call).
 * Resolves at once when the sync is off. Errors: TOOL_FAILED (uv sync failed).
 */
export function ensureCheckoutPyEnv(o: {
  toolsDir: string;
  pyProject: string;
  uv?: string;
}): Promise<void> {
  const opts = enabled.get(o.toolsDir);
  if (opts === undefined) return Promise.resolve();
  let p = inFlight.get(o.toolsDir);
  if (p === undefined) {
    p = syncIfStale(o, opts);
    p.catch(() => inFlight.delete(o.toolsDir));
    inFlight.set(o.toolsDir, p);
  }
  return p;
}

async function syncIfStale(
  o: { toolsDir: string; pyProject: string; uv?: string },
  opts: CheckoutPyEnvSyncOptions,
): Promise<void> {
  const pyEnv = join(o.toolsDir, 'py-env');
  const s = await pyEnvStamp({ pyEnv, py: o.pyProject });
  if (s === undefined || s.state === 'current') return;
  const log = opts.log ?? (() => undefined);
  const uv = o.uv ?? 'uv';
  const lock = await sha256Of(join(o.pyProject, 'uv.lock'));
  const args = pyEnvSyncArgs(o.pyProject);
  log(
    `vox: the Python env in ${pyEnv} was built from ${PY_ENV_STALE_WHAT[s.state]} (sources ${short(s.src.have)}, checkout ${short(s.src.want)}); syncing it from ${o.pyProject}: uv ${args.join(' ')}`,
  );
  const started = Date.now();
  await rm(join(pyEnv, LOCK_STAMP), { force: true });
  await rm(join(pyEnv, SRC_STAMP), { force: true });
  const r = await runSync(uv, args, o.toolsDir, (line) => log(`  uv: ${line}`));
  if (r.code !== 0) {
    throw new VoxError(
      'TOOL_FAILED',
      `uv sync of the Python env in ${pyEnv} failed (exit ${String(r.code)}): ${r.last ?? 'no output'}`,
      `Run it by hand to see the whole output: ${pyEnvSyncCommand(o.pyProject, o.toolsDir, uv)}`,
      { details: { check: 'python-env-source', pyEnv, exit: r.code } },
    );
  }
  // the sources hashed now: an edit during the sync reads as stale on the next run
  const src = await sourceHashOf(o.pyProject);
  await mkdir(pyEnv, { recursive: true });
  for (const [file, value] of [
    [join(pyEnv, SRC_STAMP), src],
    [join(pyEnv, LOCK_STAMP), lock],
  ] as const) {
    await writeFile(`${file}.tmp`, value);
    await rename(`${file}.tmp`, file);
  }
  log(
    `vox: Python env synced in ${((Date.now() - started) / 1000).toFixed(1)} s (sources ${short(src)})`,
  );
}

const short = (h: string | undefined) => (h === undefined ? 'none' : h.slice(0, 12));

function runSync(
  uv: string,
  args: string[],
  toolsDir: string,
  onLine: (line: string) => void,
): Promise<{ code: number; last?: string }> {
  return mkdir(toolsDir, { recursive: true }).then(
    () =>
      new Promise((resolve) => {
        let last: string | undefined;
        let partial = '';
        const feed = (chunk: Buffer) => {
          partial += chunk.toString('utf8');
          const parts = partial.split('\n');
          partial = parts.pop() ?? '';
          for (const l of parts) {
            const t = l.trim();
            if (t === '') continue;
            last = t.slice(0, 300);
            onLine(last);
          }
        };
        const child = spawn(uv, args, {
          env: pyEnvSyncEnv(toolsDir),
          cwd: toolsDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', feed);
        child.stderr.on('data', feed);
        child.on('error', (e) => resolve({ code: -1, last: e.message }));
        child.on('close', (code) => {
          if (partial.trim() !== '') {
            last = partial.trim().slice(0, 300);
            onLine(last);
          }
          resolve({ code: code ?? -1, ...(last !== undefined && { last }) });
        });
      }),
  );
}
