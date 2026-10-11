// Active picture area of a video (black bars baked into the picture: letterbox or pillarbox).
//
// Ingest samples a few seconds with ffmpeg `cropdetect` and stores the area in source pixels in
// `cache/media/<mediaId>.json` (`activeArea`), never in project.json (the data model is frozen).
// The auto / facetrack crop then treats the area as the source bounds, so a 9:16 crop never shows
// the bars. A missing area means the full frame (projects ingested before this behave as before).
//
// The decision is conservative: an axis is cropped only when both of its bars are at least 2 % of
// the frame and most readable samples put the edges at the same place (within 1 %). The bounds are
// the union over the samples, so a dark scene in one sample never crops real picture.

import { VoxError } from '../../errors.ts';
import { FFMPEG_BASE, checkPath, inputArgs } from './ffargs.ts';
import { runTool, type RunOptions } from './run.ts';
import type { MediaFormat } from './sniff.ts';

/** Seconds sampled per media, each `ACTIVE_AREA_SAMPLE_MS` long. */
export const ACTIVE_AREA_SAMPLES = 6;
export const ACTIVE_AREA_SAMPLE_MS = 1000;
/** A bar counts when it is at least this share of the frame on each side of the axis. */
export const MIN_BAR_SHARE = 0.02;
/** Samples agree on an edge when it is within this share of the frame of the union's edge. */
export const EDGE_TOLERANCE_SHARE = 0.01;
/** cropdetect black threshold as a share of the full range (24/255 for 8-bit, any bit depth). */
export const CROPDETECT_LIMIT = 0.094;
/** Per sample run: seeking and decoding one second is quick; a stuck decoder must not hold ingest. */
const SAMPLE_TIMEOUT_MS = 60_000;

/** A rectangle in source pixels (`x`, `y` top-left). */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** cropdetect bounds of the non-black picture, inclusive pixel indices. */
export interface CropBox {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

/** The active area normalised to the frame (0..1), as the crop path uses it. */
export interface NormalisedArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

function bug(message: string): VoxError {
  return new VoxError('VALIDATION', message, 'This is an engine bug; please report it.');
}

/** Start times (ms) of the samples: spread evenly over the media, each fully inside it. */
export function activeAreaSampleTimes(durationMs: number): number[] {
  const last = Math.max(0, Math.floor(durationMs) - ACTIVE_AREA_SAMPLE_MS);
  if (last === 0) return [0];
  const out = new Set<number>();
  for (let i = 0; i < ACTIVE_AREA_SAMPLES; i++) {
    out.add(Math.round((last * (i + 0.5)) / ACTIVE_AREA_SAMPLES));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * One sample: input seek to `atMs`, decode 1 s of the first video stream, and print the
 * cropdetect bounds of every frame (`reset=0`: each frame's bounds cover all frames so far).
 */
export function cropdetectArgs(input: string, format: MediaFormat, atMs: number): string[] {
  if (!Number.isInteger(atMs) || atMs < 0)
    throw bug(`atMs must be a whole number ≥ 0, got ${atMs}`);
  const inp = inputArgs(checkPath(input, 'input'), format);
  const i = inp.lastIndexOf('-i');
  return [
    ...FFMPEG_BASE,
    '-nostats',
    ...inp.slice(0, i),
    '-ss',
    (atMs / 1000).toFixed(3),
    ...inp.slice(i),
    '-t',
    String(ACTIVE_AREA_SAMPLE_MS / 1000),
    '-map',
    '0:V:0',
    '-an',
    '-sn',
    '-dn',
    '-vf',
    `cropdetect=limit=${CROPDETECT_LIMIT}:round=2:reset=0,metadata=mode=print:file=-`,
    '-f',
    'null',
    '-',
  ];
}

/** The bounds printed for the last frame, or undefined when no frame printed all four. */
export function parseCropdetect(stdout: string): CropBox | undefined {
  let found: CropBox | undefined;
  let cur: Partial<CropBox> = {};
  const flush = () => {
    if (
      cur.x1 !== undefined &&
      cur.x2 !== undefined &&
      cur.y1 !== undefined &&
      cur.y2 !== undefined
    )
      found = { x1: cur.x1, x2: cur.x2, y1: cur.y1, y2: cur.y2 };
    cur = {};
  };
  for (const line of stdout.split('\n')) {
    if (line.startsWith('frame:')) {
      flush();
      continue;
    }
    const m = /^lavfi\.cropdetect\.(x1|x2|y1|y2)=(-?\d+)\s*$/.exec(line);
    if (m) cur[m[1] as keyof CropBox] = Number(m[2]);
  }
  flush();
  return found;
}

/**
 * The active area from the per-sample bounds (undefined: the sample printed nothing). Full frame
 * unless the bars are clear: both bars of an axis ≥ 2 %, and a majority of the readable samples
 * (at least 2) agree on both edges. Each axis is decided on its own.
 */
export function decideActiveArea(
  width: number,
  height: number,
  boxes: readonly (CropBox | undefined)[],
): PixelRect {
  const full: PixelRect = { x: 0, y: 0, w: width, h: height };
  const valid = boxes.filter(
    (b): b is CropBox =>
      b !== undefined &&
      [b.x1, b.x2, b.y1, b.y2].every(Number.isInteger) &&
      b.x1 >= 0 &&
      b.y1 >= 0 &&
      b.x2 < width &&
      b.y2 < height &&
      b.x2 >= b.x1 &&
      b.y2 >= b.y1,
  );
  const need = Math.max(2, Math.ceil(boxes.length / 2));
  if (valid.length < need) return full;

  const axis = (lo: 'x1' | 'y1', hi: 'x2' | 'y2', size: number): [number, number] => {
    const a = Math.min(...valid.map((b) => b[lo]));
    const z = Math.max(...valid.map((b) => b[hi]));
    const minBar = MIN_BAR_SHARE * size;
    if (a < minBar || size - 1 - z < minBar) return [0, size];
    const tol = Math.max(2, EDGE_TOLERANCE_SHARE * size);
    const agree = valid.filter((b) => b[lo] - a <= tol && z - b[hi] <= tol).length;
    return agree >= need ? [a, z - a + 1] : [0, size];
  };
  const [x, w] = axis('x1', 'x2', width);
  const [y, h] = axis('y1', 'y2', height);
  return { x, y, w, h };
}

/** Samples the media and decides its active area (source pixels). */
export async function detectActiveArea(
  input: string,
  format: MediaFormat,
  frame: { width: number; height: number; durationMs: number },
  ro: RunOptions = {},
): Promise<PixelRect> {
  const boxes: (CropBox | undefined)[] = [];
  for (const at of activeAreaSampleTimes(frame.durationMs)) {
    const { stdout } = await runTool('ffmpeg', cropdetectArgs(input, format, at), {
      ...ro,
      timeoutMs: ro.timeoutMs ?? SAMPLE_TIMEOUT_MS,
      maxStdoutBytes: 4 << 20,
    });
    boxes.push(parseCropdetect(stdout));
  }
  return decideActiveArea(frame.width, frame.height, boxes);
}

/**
 * A stored area (`cache/media/<id>.json` `activeArea`) normalised to a `width`×`height` frame.
 * Undefined for the full frame and for anything that is not a whole-pixel area inside the frame,
 * so a missing or damaged entry frames the media as before.
 */
export function normaliseArea(
  raw: unknown,
  width: number,
  height: number,
): NormalisedArea | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { x, y, w, h } = raw as Record<string, unknown>;
  const ints = [x, y, w, h].every((v) => typeof v === 'number' && Number.isInteger(v));
  if (!ints || !(width > 0 && height > 0)) return undefined;
  const r = { x, y, w, h } as PixelRect;
  if (r.x < 0 || r.y < 0 || r.w <= 0 || r.h <= 0) return undefined;
  if (r.x + r.w > width || r.y + r.h > height) return undefined;
  if (r.w === width && r.h === height) return undefined;
  return { x: r.x / width, y: r.y / height, w: r.w / width, h: r.h / height };
}
