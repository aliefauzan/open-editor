// Ingest analysis (engine spec "Ingest analysis", D-15): ffprobe streams, source frame rate, VFR
// check, the CFR-copy rate, and `ebur128` loudness. ffmpeg/ffprobe always run with the whitelists of
// the sniffed type (ffargs.ts). Phase 04's ingest decides what to write; this module only measures.

import { VoxError } from '../../errors.pending.ts';
import { FORMAT_WHITELIST, ebur128Args, ffprobePtsArgs, ffprobeStreamsArgs } from './ffargs.ts';
import { runTool, type RunOptions } from './run.ts';
import type { MediaFormat, SniffedMedia } from './sniff.ts';

/** Rational frame rate. Same shape as phase 02's `model/fps.ts` `Fps` (switch at the shim swap). */
export interface Fps {
  num: number;
  den: number;
}

/** The fixed set of sequence rates (engine spec "Time and the frame grid", D-15). */
export const FIXED_FPS: readonly Fps[] = [
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30, den: 1 },
  { num: 60, den: 1 },
  { num: 24000, den: 1001 },
  { num: 30000, den: 1001 },
  { num: 60000, den: 1001 },
];

/**
 * Which fixed-set rates a CFR copy may use: `all`, or `integer` when GATE 1 recorded the NTSC
 * fallback (then NTSC sources also get a CFR copy at the nearest integer rate).
 */
export type CfrRates = 'all' | 'integer';

export interface Loudness {
  integratedLufs: number;
  truePeakDb: number;
}

/** Stand-in for `-inf` (digital silence) so the value stays a finite JSON number. */
export const SILENCE_DB = -144;

export const fpsValue = (f: Fps): number => f.num / f.den;
export const fpsEqual = (a: Fps, b: Fps): boolean => a.num * b.den === b.num * a.den;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** `"30000/1001"` → `{ num: 30000, den: 1001 }` (reduced); `"0/0"`, junk or ≤ 0 → undefined. */
export function parseRational(s: string | undefined): Fps | undefined {
  const m = /^(\d+)\/(\d+)$/.exec(s ?? '');
  if (!m) return undefined;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0)
    return undefined;
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

/** The fixed-set rate nearest `rate` (fps); ties go to the earlier entry. */
export function nearestFixedFps(rate: number, rates: CfrRates = 'all'): Fps {
  const set = rates === 'integer' ? FIXED_FPS.filter((f) => f.den === 1) : FIXED_FPS;
  let best = set[0] as Fps;
  for (const f of set) {
    if (Math.abs(fpsValue(f) - rate) < Math.abs(fpsValue(best) - rate)) best = f;
  }
  return { ...best };
}

/** Spread (max − min) of consecutive deltas of the sorted pts, in seconds; undefined below 3 pts. */
export function ptsDeltaSpread(pts: readonly number[]): number | undefined {
  const s = pts.filter((p) => Number.isFinite(p)).sort((a, b) => a - b);
  if (s.length < 3) return undefined;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 1; i < s.length; i++) {
    const d = (s[i] as number) - (s[i - 1] as number);
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return max - min;
}

export interface VfrInput {
  rFrameRate?: Fps | undefined;
  avgFrameRate?: Fps | undefined;
  /** Packet pts of the video stream in seconds (any order). */
  pts?: readonly number[] | undefined;
}

/**
 * D-15: VFR when `r_frame_rate` ≠ `avg_frame_rate`, or when the pts deltas spread over more than
 * one frame (one frame at the average rate, else `r_frame_rate`).
 */
export function detectVfr({ rFrameRate, avgFrameRate, pts }: VfrInput): boolean {
  if (rFrameRate && avgFrameRate && !fpsEqual(rFrameRate, avgFrameRate)) return true;
  const rate = avgFrameRate ?? rFrameRate;
  const spread = pts ? ptsDeltaSpread(pts) : undefined;
  if (rate === undefined || spread === undefined) return false;
  return spread > 1 / fpsValue(rate) + 1e-9;
}

const NTSC: readonly Fps[] = FIXED_FPS.filter((f) => f.den === 1001);

export interface FrameRatePlan {
  /** `MediaItem.fps`: `r_frame_rate`, or the CFR copy's rate when a copy is made. */
  fps: Fps;
  vfr: boolean;
  /** Set when a constant-frame-rate copy must be made, at `fps`. */
  cfr?: { fps: Fps; reason: 'vfr' | 'integer-rate' };
}

/** Frame-rate decision for one video stream (pure). */
export function planFrameRate(input: VfrInput, rates: CfrRates = 'all'): FrameRatePlan | undefined {
  const vfr = detectVfr(input);
  const r = input.rFrameRate;
  const avg = input.avgFrameRate;
  if (vfr) {
    const base = avg ?? r;
    if (base === undefined) return undefined;
    const fps = nearestFixedFps(fpsValue(base), rates);
    return { fps, vfr, cfr: { fps, reason: 'vfr' } };
  }
  const src = r ?? avg;
  if (src === undefined) return undefined;
  if (rates === 'integer' && NTSC.some((f) => fpsEqual(f, src))) {
    const fps = nearestFixedFps(fpsValue(src), 'integer');
    return { fps, vfr, cfr: { fps, reason: 'integer-rate' } };
  }
  return { fps: { ...src }, vfr };
}

const DB = String.raw`(-?\d+(?:\.\d+)?|-inf|inf|nan)`;

const toDb = (s: string | undefined): number => {
  const v = Number(s);
  return Number.isFinite(v) ? v : SILENCE_DB;
};

/** Parse the `ebur128` summary (the last one in stderr). */
export function parseEbur128(stderr: string): Loudness {
  const at = stderr.lastIndexOf('Summary:');
  const summary = at < 0 ? '' : stderr.slice(at);
  const i = new RegExp(String.raw`\bI:\s+${DB}\s+LUFS`).exec(summary);
  const p = new RegExp(String.raw`\bPeak:\s+${DB}\s+dBFS`).exec(summary);
  if (!i || !p) {
    throw new VoxError(
      'TOOL_FAILED',
      'ffmpeg ebur128 printed no loudness summary.',
      'Run vox doctor; the ffmpeg build may be too old.',
      {
        details: { tool: 'ffmpeg' },
      },
    );
  }
  return { integratedLufs: toDb(i[1]), truePeakDb: toDb(p[1]) };
}

export interface ProbeVideo {
  codec: string;
  /** Display size (after rotation). */
  width: number;
  height: number;
  rotation: number;
  rFrameRate: Fps | undefined;
  avgFrameRate: Fps | undefined;
}

export interface ProbeAudio {
  codec: string;
  sampleRate: number;
  channels: number;
}

export interface ProbeInfo {
  formatName: string;
  durationMs: number | undefined;
  video: ProbeVideo | undefined;
  audio: ProbeAudio | undefined;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

function rotationOf(stream: Json): number {
  for (const sd of Array.isArray(stream['side_data_list']) ? stream['side_data_list'] : []) {
    const r = num(obj(sd)['rotation']);
    if (r !== undefined) return r;
  }
  return num(obj(stream['tags'])['rotate']) ?? 0;
}

/** Parse `ffprobe -show_format -show_streams -of json` output (pure). */
export function parseProbeJson(json: string, format: MediaFormat): ProbeInfo {
  let root: Json;
  try {
    root = obj(JSON.parse(json));
  } catch (e) {
    throw new VoxError('TOOL_FAILED', 'ffprobe printed invalid JSON.', 'Run vox doctor.', {
      cause: e,
      details: { tool: 'ffprobe' },
    });
  }
  const fmt = obj(root['format']);
  const formatName = str(fmt['format_name']) ?? '';
  // ffprobe enforces the whitelist; this re-checks that the demuxer used is the sniffed one.
  const allowed = FORMAT_WHITELIST[format].split(',');
  if (!formatName.split(',').some((n) => allowed.includes(n))) {
    throw new VoxError(
      'MEDIA_UNSUPPORTED',
      `ffprobe read the file as "${formatName}", not ${format}.`,
      'Use a regular video, audio or image file.',
      {
        details: { detected: formatName },
      },
    );
  }
  const streams = (Array.isArray(root['streams']) ? root['streams'] : []).map(obj);
  const v = streams.find(
    (s) => s['codec_type'] === 'video' && num(obj(s['disposition'])['attached_pic']) !== 1,
  );
  const a = streams.find((s) => s['codec_type'] === 'audio');
  let video: ProbeVideo | undefined;
  if (v) {
    const rotation = rotationOf(v);
    const w = num(v['width']) ?? 0;
    const h = num(v['height']) ?? 0;
    const swap = Math.abs(rotation) % 180 === 90;
    video = {
      codec: str(v['codec_name']) ?? '',
      width: swap ? h : w,
      height: swap ? w : h,
      rotation,
      rFrameRate: parseRational(str(v['r_frame_rate'])),
      avgFrameRate: parseRational(str(v['avg_frame_rate'])),
    };
  }
  const audio: ProbeAudio | undefined = a
    ? {
        codec: str(a['codec_name']) ?? '',
        sampleRate: num(a['sample_rate']) ?? 0,
        channels: num(a['channels']) ?? 0,
      }
    : undefined;
  const dur = num(fmt['duration']);
  return {
    formatName,
    durationMs: dur === undefined ? undefined : Math.round(dur * 1000),
    video,
    audio,
  };
}

export async function probeMedia(
  path: string,
  format: MediaFormat,
  opts: RunOptions = {},
): Promise<ProbeInfo> {
  const { stdout } = await runTool('ffprobe', ffprobeStreamsArgs(path, format), opts);
  return parseProbeJson(stdout, format);
}

/** Packet pts (seconds) of the first video stream, in file order. */
export async function readVideoPts(
  path: string,
  format: MediaFormat,
  opts: RunOptions = {},
): Promise<number[]> {
  const { stdout } = await runTool('ffprobe', ffprobePtsArgs(path, format), opts);
  // `N/A` (no pts) lines and blank lines drop out.
  return stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => Number(l.split(',')[0]))
    .filter((n) => Number.isFinite(n));
}

export async function measureLoudness(
  path: string,
  format: MediaFormat,
  opts: RunOptions = {},
): Promise<Loudness> {
  const { stderr } = await runTool('ffmpeg', ebur128Args(path, format), opts);
  return parseEbur128(stderr);
}

export interface MediaAnalysis {
  kind: 'video' | 'audio' | 'image';
  durationMs: number | undefined;
  width: number | undefined;
  height: number | undefined;
  /** `MediaItem.fps` (video only). */
  fps: Fps | undefined;
  vfr: boolean;
  /** Set when phase 04 must write `media/<id>.cfr.mp4` at this rate (proxy.ts `cfrCopyArgs`). */
  cfr: { fps: Fps; reason: 'vfr' | 'integer-rate' } | undefined;
  hasAudio: boolean;
  /** `MediaItem.loudness` for every audio-bearing source. */
  loudness: Loudness | undefined;
}

export interface AnalyzeOptions extends RunOptions {
  /** From the GATE 1 NTSC result (default `all`). */
  cfrRates?: CfrRates;
}

/** Probe, frame-rate plan and loudness for one sniffed media file. */
export async function analyzeMedia(
  path: string,
  sniffed: SniffedMedia,
  opts: AnalyzeOptions = {},
): Promise<MediaAnalysis> {
  const probe = await probeMedia(path, sniffed.format, opts);
  if (sniffed.kind === 'image') {
    if (!probe.video) {
      throw new VoxError(
        'MEDIA_UNSUPPORTED',
        'The image has no picture stream.',
        'Use a PNG or JPEG file.',
        { details: { detected: probe.formatName } },
      );
    }
    return {
      kind: 'image',
      durationMs: undefined,
      width: probe.video.width,
      height: probe.video.height,
      fps: undefined,
      vfr: false,
      cfr: undefined,
      hasAudio: false,
      loudness: undefined,
    };
  }
  const isVideo = sniffed.kind === 'video' && probe.video !== undefined;
  if (!isVideo && !probe.audio) {
    throw new VoxError(
      'MEDIA_UNSUPPORTED',
      'The file has no audio or video stream.',
      'Use a file with sound or picture.',
      {
        details: { detected: probe.formatName },
      },
    );
  }
  let plan: FrameRatePlan | undefined;
  if (isVideo && probe.video) {
    const { rFrameRate, avgFrameRate } = probe.video;
    // The pts scan is needed only when the two rates agree (unequal rates are VFR already).
    const pts =
      rFrameRate && avgFrameRate && !fpsEqual(rFrameRate, avgFrameRate)
        ? undefined
        : await readVideoPts(path, sniffed.format, opts);
    plan = planFrameRate({ rFrameRate, avgFrameRate, pts }, opts.cfrRates ?? 'all');
  }
  const loudness = probe.audio ? await measureLoudness(path, sniffed.format, opts) : undefined;
  return {
    kind: isVideo ? 'video' : 'audio',
    durationMs: probe.durationMs,
    width: isVideo ? probe.video?.width : undefined,
    height: isVideo ? probe.video?.height : undefined,
    fps: plan?.fps,
    vfr: plan?.vfr ?? false,
    cfr: plan?.cfr,
    hasAudio: probe.audio !== undefined,
    loudness,
  };
}
