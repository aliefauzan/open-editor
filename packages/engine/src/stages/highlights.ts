// Video highlights (plan D-75): macOS 27 MediaIntelligence highlight ranges, per-step highlight
// levels (0.5 s steps) and one key frame, from `vox-apple-llm --highlights <videoPath>` (the one
// native helper, D-16). The engine runs it on the media's 540p H.264 proxy only (the analyzer fails
// on VP9 sources). Optional: below macOS 27, without the helper (`pnpm dist:no-apple`) or with a
// helper older than D-75 the stage reports "not available" and nothing else changes.
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { VoxError } from '../errors.ts';

/** How to start the native helper (the app's `bin/vox-apple-llm`, or a test fake). */
export interface NativeHelper {
  command: string;
  /** Arguments before `--highlights` (a script fake: its path). */
  args?: readonly string[];
  /** Added to the helper's environment (HOME, TMPDIR, LANG, LC_ALL and PATH only otherwise). */
  env?: Readonly<Record<string, string>>;
}

const ms = z.int().min(0);
const Range = z.strictObject({ startMs: ms, endMs: ms });

/** The helper's answer and the stored `highlights/<mediaId>.json`. */
export const HighlightsSchema = z.strictObject({
  highlights: z.array(Range),
  /** The framework's level per step (on macOS 27.0 whole numbers about 0–10). */
  levels: z.array(Range.extend({ level: z.number().min(0) })),
  keyFrameMs: ms.nullable(),
  /** One of the two analyses failed; the other's part is still there. */
  errors: z.array(z.strictObject({ request: z.string(), message: z.string() })).optional(),
});
export type Highlights = z.infer<typeof HighlightsSchema>;

const HelperErrorSchema = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string() }),
});

export type HighlightsRun =
  { available: true; highlights: Highlights } | { available: false; reason: string };

/** Fixed part of the time limit; the rest scales with the video (180 s took 23 s on an M-series Mac). */
const BASE_TIMEOUT_MS = 120_000;
/** Answer lines are small (about 60 bytes per 0.5 s step); more is a broken helper. */
const MAX_OUTPUT = 8 << 20;

/**
 * How long a quick run (the app's Make clips and `vox quick`) waits for highlights once shots,
 * transcribe and facetrack are done; then it goes on without them (D-75, D-85). On a 667 s talk on an
 * M5 they took 59 s against 46 s for shots → transcribe.
 */
export const HIGHLIGHTS_GRACE_MS = 30_000;

/** Time limit for a video of `durationMs`: 2 min plus half the video's length. */
export const highlightsTimeoutMs = (durationMs: number): number =>
  BASE_TIMEOUT_MS + Math.max(0, durationMs) / 2;

const unavailable = (reason: string): HighlightsRun => ({ available: false, reason });

/**
 * Runs the helper on one video. "Not available" (no helper, an old helper, `unavailable` from the
 * helper) is a value; a failed analysis, a timeout or a bad answer throws TOOL_FAILED; an abort
 * throws CANCELLED.
 */
export async function runHighlights(
  helper: NativeHelper | undefined,
  videoPath: string,
  o: { signal?: AbortSignal; timeoutMs: number; redact?: (s: string) => string },
): Promise<HighlightsRun> {
  if (!helper) return unavailable('this build has no native helper');
  const redact = o.redact ?? ((s: string) => s);
  const out = await runHelper(helper, ['--highlights', videoPath], o);
  if (out.spawnError) return unavailable(`the native helper did not start (${out.spawnError})`);
  if (out.cancelled)
    throw new VoxError('CANCELLED', 'Highlights were cancelled.', 'Run it again when ready.');
  if (out.timedOut) {
    throw new VoxError(
      'TOOL_FAILED',
      `Video highlights took longer than ${Math.round(o.timeoutMs / 1000)} s.`,
      'Quick clips go on without them.',
    );
  }
  const line = out.stdout.trim().split('\n').at(-1) ?? '';
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    // a helper older than D-75 exits 2 with its usage on stderr
    if (out.code === 2 && /usage/i.test(out.stderr))
      return unavailable('the native helper is older than video highlights');
    throw new VoxError(
      'TOOL_FAILED',
      `The native helper sent no highlights (exit ${out.code}): ${redact(out.stderr.trim().slice(0, 300))}`,
      'Quick clips go on without them.',
    );
  }
  const err = HelperErrorSchema.safeParse(raw);
  if (err.success) {
    if (err.data.error.code === 'unavailable') return unavailable(err.data.error.message);
    throw new VoxError(
      'TOOL_FAILED',
      `Video highlights failed: ${redact(err.data.error.message)}`,
      'Quick clips go on without them.',
      { details: { code: err.data.error.code } },
    );
  }
  const ok = HighlightsSchema.safeParse(raw);
  if (!ok.success || out.code !== 0) {
    throw new VoxError(
      'TOOL_FAILED',
      `The native helper sent an invalid highlights answer (exit ${out.code}).`,
      'Quick clips go on without them.',
    );
  }
  return { available: true, highlights: ok.data };
}

interface ExecOut {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  spawnError?: string;
}

/** Like the agent's Apple provider: the helper gets only HOME, TMPDIR, LANG, LC_ALL and PATH. */
function helperEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'PATH']) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

function runHelper(
  helper: NativeHelper,
  args: readonly string[],
  o: { signal?: AbortSignal; timeoutMs: number },
): Promise<ExecOut> {
  return new Promise((resolve) => {
    if (o.signal?.aborted) {
      resolve({ code: -1, stdout: '', stderr: '', timedOut: false, cancelled: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    // argument array, no shell
    const child = spawn(helper.command, [...(helper.args ?? []), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...helperEnv(), ...helper.env },
    });
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      if (stdout.length > MAX_OUTPUT) kill();
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < 1 << 16) stderr += d;
    });
    let spawnError: string | undefined;
    child.on('error', (e: NodeJS.ErrnoException) => {
      spawnError = e.code ?? e.message;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        timedOut,
        cancelled,
        ...(spawnError !== undefined && { spawnError }),
      });
    });
  });
}
