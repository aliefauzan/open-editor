// Shot detection (engine spec "Shots and framing", plan D-15, phase 04 step 9c).
// ffmpeg `scdet` (threshold 10, about `scene > 0.35`) on the proxy, or on the original scaled to 360p
// in the same filter graph when the media has no proxy. No Python. The cut times come from the
// `metadata` filter printing each cut frame's `pts_time` to stdout. The result is the shot list
// `{ startMs, endMs }[]` that covers the whole media (written as `shots/<mediaId>.json` by the job).
//
// R3 "External processes": argument array, never a shell; `-protocol_whitelist file,pipe` and a
// `-format_whitelist` on the input; every run takes an AbortSignal and cancel kills the child.
// The small runner below is local to this stage until phase 04 moves it onto the shared ffmpeg
// runner (E3 `stages/media/run.ts`).

import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { VoxError } from '../errors.pending.ts';

export const SCDET_THRESHOLD = 10;
export const PROTOCOL_WHITELIST = 'file,pipe';
/** Demuxers of the MP4/MOV family (the proxy is an engine-made MP4). Phase 04 passes the sniffed list. */
export const DEFAULT_FORMAT_WHITELIST = 'mov,mp4,m4a,3gp,3g2,mj2';

export const ShotSchema = z
  .strictObject({ startMs: z.int().nonnegative(), endMs: z.int().positive() })
  .refine((s) => s.endMs > s.startMs, { message: 'endMs must be after startMs' });
export type Shot = z.infer<typeof ShotSchema>;

/** `shots/<mediaId>.json`: sorted, contiguous shots starting at 0. */
export const ShotListSchema = z
  .array(ShotSchema)
  .min(1)
  .superRefine((shots, ctx) => {
    if (shots[0] !== undefined && shots[0].startMs !== 0) {
      ctx.addIssue({ code: 'custom', message: 'the first shot must start at 0' });
    }
    for (let i = 1; i < shots.length; i++) {
      if (shots[i]?.startMs !== shots[i - 1]?.endMs) {
        ctx.addIssue({ code: 'custom', message: `shot ${i} does not start where shot ${i - 1} ends` });
      }
    }
  });

export interface ScdetArgsInput {
  /** Absolute path of the proxy (or of the original when `scaleTo360`). */
  input: string;
  /** True when the input is the original (no proxy): scale to 360p in the same filter graph. */
  scaleTo360?: boolean;
  /** ffmpeg demuxer names for the sniffed type; default the MP4/MOV family. */
  formatWhitelist?: string;
}

const engineBug = 'This is an engine bug; please report it.';

function checkInput(path: string): string {
  if (typeof path !== 'string' || path.includes('\0') || !isAbsolute(path)) {
    throw new VoxError('VALIDATION', `shots input must be an absolute path: ${JSON.stringify(path)}`, engineBug);
  }
  return path;
}

export function scdetArgs(opts: ScdetArgsInput): string[] {
  const input = checkInput(opts.input);
  const wl = opts.formatWhitelist ?? DEFAULT_FORMAT_WHITELIST;
  if (!/^[a-z0-9_]+(,[a-z0-9_]+)*$/.test(wl)) {
    throw new VoxError('VALIDATION', `Invalid ffmpeg format whitelist: ${JSON.stringify(wl)}`, engineBug);
  }
  const graph = [
    ...(opts.scaleTo360 === true ? ['scale=-2:360'] : []),
    `scdet=threshold=${SCDET_THRESHOLD}`,
    'metadata=mode=print:key=lavfi.scd.time:file=-',
  ].join(',');
  return [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-loglevel',
    'error',
    '-protocol_whitelist',
    PROTOCOL_WHITELIST,
    '-format_whitelist',
    wl,
    '-i',
    input,
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-vf',
    graph,
    '-f',
    'null',
    '-',
  ];
}

/** Cut times (ms, sorted, unique) from the `metadata=mode=print` output: one `pts_time:<s>` per cut frame. */
export function parseScdetOutput(stdout: string): number[] {
  const cuts = new Set<number>();
  for (const m of stdout.matchAll(/pts_time:(\S+)/g)) {
    const s = Number(m[1]);
    if (Number.isFinite(s) && s >= 0) cuts.add(Math.round(s * 1000));
  }
  return [...cuts].sort((a, b) => a - b);
}

/** Contiguous shots over `[0, durationMs]`, split at each cut strictly inside it. */
export function shotsFromCuts(cutsMs: readonly number[], durationMs: number): Shot[] {
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    throw new VoxError('VALIDATION', `durationMs must be a positive integer, got ${durationMs}`, engineBug);
  }
  const inner = [...new Set(cutsMs.map((c) => Math.round(c)))]
    .filter((c) => c > 0 && c < durationMs)
    .sort((a, b) => a - b);
  const bounds = [0, ...inner, durationMs];
  const shots: Shot[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    shots.push({ startMs: bounds[i] as number, endMs: bounds[i + 1] as number });
  }
  return shots;
}

export interface DetectShotsOptions extends ScdetArgsInput {
  /** `MediaItem.durationMs`; the shot list covers `[0, durationMs]`. */
  durationMs: number;
  signal?: AbortSignal;
  /** ffmpeg binary; default `ffmpeg` from PATH. */
  ffmpeg?: string;
  /** Applied to the stderr tail before it goes into `VoxError.cause` (phase 04: `engine.redactor.redact`). */
  redact?: (text: string) => string;
}

export async function detectShots(opts: DetectShotsOptions): Promise<Shot[]> {
  const args = scdetArgs(opts);
  const stdout = await runFfmpeg(args, opts);
  return shotsFromCuts(parseScdetOutput(stdout), opts.durationMs);
}

// ---- local ffmpeg runner (moves onto the shared runner in phase 04) ----

const STDERR_TAIL_LINES = 40;
const STDERR_KEEP = 256 * 1024;
const STDOUT_MAX = 16 * 1024 * 1024;
const KILL_GRACE_MS = 2000;

const cancelled = (): VoxError =>
  new VoxError('CANCELLED', 'Shot detection was cancelled.', 'Nothing was written; run it again when ready.');

function tail(text: string): string {
  return text
    .split(/\r?\n|\r/)
    .filter((l) => l.trim() !== '')
    .slice(-STDERR_TAIL_LINES)
    .join('\n');
}

function runFfmpeg(args: readonly string[], opts: DetectShotsOptions): Promise<string> {
  const bin = opts.ffmpeg ?? 'ffmpeg';
  const redact = opts.redact ?? ((s: string) => s);
  if (opts.signal?.aborted === true) return Promise.reject(cancelled());

  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let out = '';
    let err = '';
    let overflow = false;
    let aborted = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const kill = (sig: NodeJS.Signals): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill(sig);
    };
    const onAbort = (): void => {
      aborted = true;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (overflow) return;
      out += chunk;
      if (out.length > STDOUT_MAX) {
        overflow = true;
        kill('SIGKILL');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      err += chunk;
      if (err.length > STDERR_KEEP * 2) err = err.slice(-STDERR_KEEP);
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      spawnError = e;
    });
    child.on('close', (code, signal) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (aborted) return reject(cancelled());
      if (spawnError !== undefined) {
        if (spawnError.code === 'ENOENT') {
          return reject(
            new VoxError('TOOL_MISSING', `ffmpeg was not found (${bin}).`, 'Install ffmpeg (brew install ffmpeg), then run vox doctor.', {
              details: { tool: 'ffmpeg', path: bin },
            }),
          );
        }
        return reject(
          new VoxError('TOOL_FAILED', `Could not start ffmpeg: ${spawnError.message}`, 'Run vox doctor.', {
            cause: spawnError,
            details: { tool: 'ffmpeg', errno: spawnError.code },
          }),
        );
      }
      const t = tail(err);
      const cause = t === '' ? undefined : redact(t);
      if (overflow) {
        return reject(
          new VoxError('TOOL_FAILED', 'ffmpeg scene detection wrote too much output.', 'Report this as a bug.', {
            cause,
            details: { tool: 'ffmpeg' },
          }),
        );
      }
      if (code !== 0) {
        return reject(
          new VoxError(
            'TOOL_FAILED',
            `ffmpeg scene detection failed (${signal !== null ? `signal ${signal}` : `exit code ${String(code)}`}).`,
            'The file may be damaged or in a format ffmpeg cannot read; try another file or run vox doctor.',
            { cause, details: { tool: 'ffmpeg', exitCode: code, signal } },
          ),
        );
      }
      resolve(out);
    });
  });
}
