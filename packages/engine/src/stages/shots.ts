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

import { runTool } from './media/run.ts';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { VoxError } from '../errors.ts';

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
        ctx.addIssue({
          code: 'custom',
          message: `shot ${i} does not start where shot ${i - 1} ends`,
        });
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
    throw new VoxError(
      'VALIDATION',
      `shots input must be an absolute path: ${JSON.stringify(path)}`,
      engineBug,
    );
  }
  return path;
}

export function scdetArgs(opts: ScdetArgsInput): string[] {
  const input = checkInput(opts.input);
  const wl = opts.formatWhitelist ?? DEFAULT_FORMAT_WHITELIST;
  if (!/^[a-z0-9_]+(,[a-z0-9_]+)*$/.test(wl)) {
    throw new VoxError(
      'VALIDATION',
      `Invalid ffmpeg format whitelist: ${JSON.stringify(wl)}`,
      engineBug,
    );
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
    throw new VoxError(
      'VALIDATION',
      `durationMs must be a positive integer, got ${durationMs}`,
      engineBug,
    );
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

const STDOUT_MAX = 16 * 1024 * 1024;

/** ffmpeg on the shared runner (stages/media/run.ts): timeout-free, cancellable, redacted tail. */
async function runFfmpeg(args: readonly string[], opts: DetectShotsOptions): Promise<string> {
  const { stdout } = await runTool('ffmpeg', args, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.ffmpeg ? { tools: { ffmpeg: opts.ffmpeg } } : {}),
    ...(opts.redact ? { redact: opts.redact } : {}),
    maxStdoutBytes: STDOUT_MAX,
  });
  return stdout;
}
