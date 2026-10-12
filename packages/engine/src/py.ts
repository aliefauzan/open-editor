// Typed bridge to the Python tools in py/ (engine spec "Repository layout" → Python bridge; plan R3).
// Each tool runs as `uv run --frozen --project <py> python -I -m vox_py.<tool>`: one JSON request on
// stdin, one JSON result on stdout, JSON-lines progress on stderr. With a tools directory (packaged
// app) it adds `--no-sync` and keeps uv's env, cache and Pythons in that folder (D-12), so nothing is
// written into the app bundle and uv.lock is never rewritten. Both sides are validated with zod.
// Failures carry the last 40 stderr lines in `cause`, redacted (S19); without the tool's D-21 error
// line, the last stderr line (e.g. a ModuleNotFoundError) is also put in the message and
// `details.stderr` (D-69). Cancel kills the process group.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import { pyProjectDir } from './resources.ts';
import { VoxError, type ErrorCode } from './errors.ts';
import { redactor as sharedRedactor, type Redactor } from './redact.ts';

export const STDERR_TAIL_LINES = 40;
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_LINE_CHARS = 4000;
const MAX_PARTIAL_CHARS = 64 * 1024;
const KILL_GRACE_MS = 2000;
const TOOL_NAME = /^[a-z_][a-z0-9_]*$/;

export interface PyBridgeOptions {
  /** The uv project folder (`py/` in the repo, `<resources>/py` in the app). */
  pyProject: string;
  /** uv executable; default `uv` from PATH. */
  uv?: string;
  /** Packaged mode: the app's tools directory (adds `--no-sync` and the uv env variables). */
  toolsDir?: string;
  /** Validates the request before spawning. */
  input?: z.ZodType;
  signal?: AbortSignal;
  onProgress?: (progress: number, message?: string) => void;
  redactor?: Redactor;
}

/** The repo's `py/` folder (development). */
export function repoPyProject(): string {
  return pyProjectDir();
}

export function pyArgv(
  tool: string,
  opts: Pick<PyBridgeOptions, 'pyProject' | 'toolsDir'>,
): string[] {
  if (!TOOL_NAME.test(tool)) {
    throw new VoxError(
      'VALIDATION',
      `Invalid Python tool name ${JSON.stringify(tool)}`,
      'Use a vox_py module name',
      {
        details: { tool },
      },
    );
  }
  return [
    'run',
    '--frozen',
    ...(opts.toolsDir === undefined ? [] : ['--no-sync']),
    '--project',
    opts.pyProject,
    'python',
    '-I',
    '-m',
    `vox_py.${tool}`,
  ];
}

// Environment passed to uv/python: an allowlist, so provider keys and other secrets the engine
// process holds never reach a tool (S19/S30 spirit). Proxy and CA settings are kept for downloads.
const ENV_NAMES = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'LANG',
  'TZ',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'XDG_CACHE_HOME',
]);
const ENV_PREFIXES = ['LC_', 'UV_', 'HF_', 'VOX_'];

// Always set, never taken from the caller: the tools must not phone home. onnxruntime ≥ 1.2x
// uploads usage events to mobile.events.data.microsoft.com from a background thread, and that
// thread can abort the process at exit (SIGABRT, exit 134: a failed transcribe in GATE 5).
const NO_TELEMETRY = {
  ORT_DISABLE_TELEMETRY: '1',
  HF_HUB_DISABLE_TELEMETRY: '1',
  DO_NOT_TRACK: '1',
} as const;

export function pyEnv(
  opts: Partial<Pick<PyBridgeOptions, 'pyProject' | 'toolsDir'>>,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && (ENV_NAMES.has(k) || ENV_PREFIXES.some((p) => k.startsWith(p)))) {
      env[k] = v;
    }
  }
  Object.assign(env, NO_TELEMETRY);
  if (opts.toolsDir === undefined) return env;
  return {
    ...env,
    UV_PROJECT_ENVIRONMENT: join(opts.toolsDir, 'py-env'),
    UV_CACHE_DIR: join(opts.toolsDir, 'uv-cache'),
    UV_PYTHON_INSTALL_DIR: join(opts.toolsDir, 'python'),
  };
}

// Process groups still running; killed if the engine process exits, so no tool outlives it.
const liveGroups = new Set<number>();
let exitHookInstalled = false;
function trackGroup(pid: number): void {
  liveGroups.add(pid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const g of liveGroups) {
      try {
        process.kill(-g, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });
}

function cancelled(tool: string): VoxError {
  return new VoxError(
    'CANCELLED',
    `Python tool ${tool} was cancelled`,
    'Start the job again when needed',
    {
      details: { tool },
    },
  );
}

function issuesOf(error: z.ZodError): { path: string[]; message: string }[] {
  return error.issues.map((i) => ({ path: i.path.map(String), message: i.message }));
}

function parseProgress(line: string): { progress: number; message?: string } | undefined {
  if (!line.startsWith('{')) return undefined;
  try {
    const v = JSON.parse(line) as { progress?: unknown; message?: unknown };
    if (typeof v !== 'object' || v === null || typeof v.progress !== 'number') return undefined;
    if (!Number.isFinite(v.progress)) return undefined;
    return {
      progress: Math.min(1, Math.max(0, v.progress)),
      ...(typeof v.message === 'string' ? { message: v.message } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Runs `vox_py.<tool>` with `request` and returns its result parsed by `output`.
 * Errors: VALIDATION (request), TOOL_MISSING (uv), PY_TOOL_FAILED (exit code), PY_OUTPUT_INVALID
 * (not JSON / schema mismatch), CANCELLED (signal). Every rejection is redacted.
 */
export function runPyTool<S extends z.ZodType>(
  tool: string,
  request: unknown,
  output: S,
  opts: PyBridgeOptions,
): Promise<z.output<S>> {
  const redactor = opts.redactor ?? sharedRedactor;
  const uv = opts.uv ?? 'uv';
  const rejectWith = (e: VoxError): Promise<never> => Promise.reject(redactor.redact(e));

  let argv: string[];
  try {
    argv = pyArgv(tool, opts);
  } catch (e) {
    return rejectWith(e as VoxError);
  }
  if (opts.input) {
    const res = opts.input.safeParse(request);
    if (!res.success) {
      return rejectWith(
        new VoxError(
          'VALIDATION',
          `Invalid request for Python tool ${tool}`,
          'Check the tool arguments',
          {
            details: { tool, issues: issuesOf(res.error) },
          },
        ),
      );
    }
    request = res.data;
  }
  // Serialise before spawning, so a bad request never leaves a child behind.
  let body: string;
  try {
    body = JSON.stringify(request) ?? 'null';
  } catch (e) {
    return rejectWith(
      new VoxError(
        'VALIDATION',
        `Request for Python tool ${tool} is not JSON-serialisable`,
        'Check the tool arguments',
        {
          details: { tool, reason: e instanceof Error ? e.message : String(e) },
        },
      ),
    );
  }
  if (opts.signal?.aborted) return rejectWith(cancelled(tool));

  return new Promise((resolve, reject) => {
    // Own process group, so cancel also reaches python under uv.
    const child = spawn(uv, argv, {
      env: pyEnv(opts),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const group = child.pid;
    if (group !== undefined) trackGroup(group);

    const tail: string[] = [];
    let partial = '';
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let overflow = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    let aborted = false;

    const killGroup = (sig: NodeJS.Signals): void => {
      if (group === undefined) return;
      try {
        process.kill(-group, sig);
      } catch {
        // group already gone
      }
    };

    const onAbort = (): void => {
      aborted = true;
      killGroup('SIGTERM');
      // Not cleared on close: python may outlive uv; the group gets SIGKILL after the grace period.
      setTimeout(() => {
        killGroup('SIGKILL');
        if (group !== undefined) liveGroups.delete(group);
      }, KILL_GRACE_MS).unref();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const takeLine = (raw: string): void => {
      const trimmed = raw.trim();
      if (trimmed.length === 0) return;
      const p = parseProgress(trimmed);
      if (p) {
        try {
          opts.onProgress?.(
            p.progress,
            p.message === undefined ? undefined : redactor.redact(p.message),
          );
        } catch {
          // a progress listener bug must not break the tool run
        }
        return;
      }
      // Redact before truncating, so a cut can never leave half a secret.
      const safe = redactor.redact(raw);
      tail.push(safe.length > MAX_LINE_CHARS ? safe.slice(0, MAX_LINE_CHARS) + '…' : safe);
      if (tail.length > STDERR_TAIL_LINES) tail.shift();
    };

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      if (partial.length > MAX_PARTIAL_CHARS) {
        takeLine(partial);
        partial = '';
      }
      for (const l of lines) takeLine(l.replace(/\r$/, ''));
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        if (!overflow) {
          overflow = true;
          killGroup('SIGKILL');
        }
        return;
      }
      stdout.push(chunk);
    });

    child.stdin.on('error', () => {
      // EPIPE when the tool exits without reading stdin; the exit code reports the failure.
    });
    child.stdin.end(body);

    child.on('error', (e: NodeJS.ErrnoException) => {
      spawnError = e;
    });

    child.on('close', (code, signal) => {
      try {
        opts.signal?.removeEventListener('abort', onAbort);
        if (group !== undefined && !aborted) liveGroups.delete(group);
        if (partial.length > 0) takeLine(partial);
        resolve(settle(code, signal));
      } catch (e) {
        reject(redactor.redact(e));
      }
    });

    const settle = (code: number | null, signal: NodeJS.Signals | null): z.output<S> => {
      const cause = tail.length > 0 ? tail.join('\n') : undefined;
      const fail = (
        codeName: ErrorCode,
        message: string,
        hint: string,
        details: Record<string, unknown>,
      ): never => {
        throw new VoxError(codeName, message, hint, { cause, details: { tool, ...details } });
      };

      if (aborted) throw cancelled(tool);
      if (spawnError) {
        if (spawnError.code === 'ENOENT') {
          throw new VoxError(
            'TOOL_MISSING',
            `uv was not found (${uv})`,
            'Install uv, or run the app setup again (vox doctor shows the fix)',
            {
              details: { tool: 'uv', path: uv },
            },
          );
        }
        fail(
          'PY_TOOL_FAILED',
          `Could not start Python tool ${tool}: ${spawnError.message}`,
          'Run vox doctor',
          {
            errno: spawnError.code,
          },
        );
      }
      if (overflow) {
        fail(
          'PY_OUTPUT_INVALID',
          `Python tool ${tool} wrote more than ${MAX_STDOUT_BYTES} bytes`,
          'Report this as a bug',
          {},
        );
      }
      if (code !== 0) {
        const te = toolErrorOf(tail);
        // Without the D-21 error line (python died before the tool's handler ran, e.g. a module
        // missing from a stale py-env) the last stderr line names the cause: keep it visible.
        const last = te ? undefined : lastStderrLine(tail);
        const said = te ? `${te.code}: ${te.message}` : (last ?? '');
        fail(
          'PY_TOOL_FAILED',
          te
            ? `Python tool ${tool} failed: ${said}`
            : `Python tool ${tool} failed (${signal ? `signal ${signal}` : `exit code ${code}`})${last ? `: ${last}` : ''}`,
          (te && TOOL_ERROR_HINTS[te.code]) ??
            (IMPORT_ERROR.test(said)
              ? PY_ENV_IMPORT_HINT
              : 'Run vox doctor to check the Python environment; the error output is in the cause'),
          {
            exitCode: code,
            signal,
            ...(te ? { toolCode: te.code } : {}),
            ...(last ? { stderr: last } : {}),
          },
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(Buffer.concat(stdout).toString('utf8'));
      } catch {
        fail(
          'PY_OUTPUT_INVALID',
          `Python tool ${tool} did not return JSON`,
          'Run vox doctor; the py/ tools may be out of date',
          {},
        );
      }
      const res = output.safeParse(json);
      if (!res.success) {
        fail(
          'PY_OUTPUT_INVALID',
          `Python tool ${tool} returned a result that does not match its schema`,
          'Run vox doctor; the py/ tools and the engine may be out of sync',
          { issues: issuesOf(res.error) },
        );
      }
      return (res as { data: z.output<S> }).data;
    };
  });
}

/** Hints for the tool error codes of D-21 (`{"error": {"code", "message"}}`, last stderr line). */
export const TOOL_ERROR_HINTS: Readonly<Record<string, string>> = {
  INPUT_NOT_FOUND: 'The media file is missing from the project folder; ingest it again.',
  MEDIA_UNREADABLE: 'The file may be damaged; try another file.',
  MODEL_MISSING: 'Run vox doctor; it shows how to get the model.',
  MODEL_GATED:
    'The model needs accepted terms and a Hugging Face token; run vox doctor for the steps.',
  NETWORK: 'The download failed; check the connection and try again (it resumes).',
  MODEL_HASH_MISMATCH: 'The model file is damaged; delete it and run the stage again to fetch it.',
  TOOL_MISSING: 'Run vox doctor to repair the Python environment.',
  VISION_FAILED: 'Apple Vision failed on this file; run vox doctor.',
  DOC_UNREADABLE: 'The document cannot be read; export it again as PDF or plain text.',
  DOC_ENCRYPTED: 'Remove the password from the PDF, then add it again.',
};

const IMPORT_ERROR = /\b(ModuleNotFoundError|ImportError)\b|No module named/;
const MAX_STDERR_LINE = 300;
/** Hint when a Python package or a vox_py module does not import (D-69). */
export const PY_ENV_IMPORT_HINT =
  'A Python package is missing from the Python env, which usually means it was synced from a different uv.lock: open Vox Studio (setup re-syncs it on launch) or Setup → Repair "Python env"; in the repo run `uv sync --project py`. vox doctor shows the state.';

/** The last non-empty, trimmed stderr line, cut to MAX_STDERR_LINE characters (already redacted). */
export function lastStderrLine(tail: readonly string[]): string | undefined {
  for (let i = tail.length - 1; i >= 0; i--) {
    const l = tail[i]!.trim();
    if (l.length > 0) return l.length > MAX_STDERR_LINE ? `${l.slice(0, MAX_STDERR_LINE)}…` : l;
  }
  return undefined;
}

// ---- the packaged Python env (D-12, D-69) ----

export type PyEnvLockState = 'current' | 'stale' | 'unsynced';

/**
 * Whether the app-installed env (`tools.pyEnv`) was synced from this build's `py/uv.lock`: setup
 * stores the lock's SHA-256 in `<pyEnv>/.vox-lock-hash` after each sync. Undefined without such an
 * env (repo mode: `uv run --frozen` syncs by itself). Same check as `vox doctor` `python-env-lock`.
 */
export async function pyEnvLockState(
  tools: Readonly<Record<string, string | undefined>>,
): Promise<{ state: PyEnvLockState; pyEnv: string } | undefined> {
  const env = tools['pyEnv'];
  const py = tools['py'];
  if (!env || !py) return undefined;
  const want = await readFile(join(py, 'uv.lock')).then(
    (b) => createHash('sha256').update(b).digest('hex'),
    () => undefined,
  );
  const have = (await readFile(join(env, '.vox-lock-hash'), 'utf8').catch(() => '')).trim();
  const state: PyEnvLockState =
    have === '' ? 'unsynced' : want !== undefined && have === want ? 'current' : 'stale';
  return { state, pyEnv: env };
}

/** Fix line for a stale or unsynced env (doctor `python-env-lock` and the jobs that check it). */
export const PY_ENV_LOCK_FIX =
  'open Vox Studio (setup re-syncs it on launch) or Setup → Repair "Python env"';

/** Throws TOOL_MISSING before a Python tool runs on an env from another uv.lock (D-69). */
export async function assertPyEnvCurrent(
  tools: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const s = await pyEnvLockState(tools);
  if (!s || s.state === 'current') return;
  throw new VoxError(
    'TOOL_MISSING',
    s.state === 'unsynced'
      ? 'The Python env has no lock hash: it was not synced by setup, so its packages may not match this build.'
      : 'The Python env was synced from a different uv.lock than this build ships, so packages it needs may be missing.',
    `To fix it, ${PY_ENV_LOCK_FIX}. vox doctor shows the state (python-env-lock).`,
    { details: { check: 'python-env-lock', state: s.state, pyEnv: s.pyEnv } },
  );
}

/** The tool's own error from the stderr tail, if its last line is the D-21 error JSON. */
export function toolErrorOf(
  tail: readonly string[],
): { code: string; message: string } | undefined {
  const last = tail.at(-1)?.trim();
  if (!last?.startsWith('{')) return undefined;
  try {
    const e = (JSON.parse(last) as { error?: { code?: unknown; message?: unknown } }).error;
    if (typeof e?.code !== 'string' || !/^[A-Z_]{1,40}$/.test(e.code)) return undefined;
    return { code: e.code, message: typeof e.message === 'string' ? e.message.slice(0, 500) : '' };
  } catch {
    return undefined;
  }
}
