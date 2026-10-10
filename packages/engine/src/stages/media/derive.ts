// Derived ingest files (engine spec "Project folder"): extracted audio, the thumbnail sprite, peaks
// and source stills. Argument builders are pure; inputs always go through `inputArgs` (S5).
import { VoxError } from '../../errors.ts';
import { FFMPEG_BASE, checkPath, inputArgs } from './ffargs.ts';
import type { MediaFormat } from './sniff.ts';

/** Thumbnail sprite: one frame every 2 s, cells 90 px high, 10 per row (D-PH4). */
export const THUMB_EVERY_MS = 2000;
export const THUMB_HEIGHT = 90;
export const THUMB_COLUMNS = 10;
/** Peaks: mono 4 kHz, the largest |sample| of every 40 samples = 100 peaks per second (D-PH4). */
export const PEAKS_SAMPLE_RATE = 4000;
export const PEAKS_PER_SECOND = 100;

export interface SpriteLayout {
  frames: number;
  columns: number;
  rows: number;
}

export function spriteLayout(durationMs: number): SpriteLayout {
  const frames = Math.max(1, Math.ceil(durationMs / THUMB_EVERY_MS));
  const columns = Math.min(THUMB_COLUMNS, frames);
  return { frames, columns, rows: Math.ceil(frames / columns) };
}

/** `audio/<mediaId>.m4a`: the first audio stream as AAC 160k for preview `<audio>`. */
export function audioArgs(input: string, format: MediaFormat, output: string): string[] {
  return [
    ...FFMPEG_BASE,
    '-y',
    ...inputArgs(input, format),
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    checkPath(output, 'output'),
  ];
}

/** `thumbs/<mediaId>.jpg`: a JPEG sprite, frame i at i × 2 s, row-major. */
export function thumbsArgs(
  input: string,
  format: MediaFormat,
  output: string,
  durationMs: number,
): string[] {
  const { columns, rows } = spriteLayout(durationMs);
  return [
    ...FFMPEG_BASE,
    '-y',
    ...inputArgs(input, format),
    '-map',
    '0:V:0',
    '-an',
    '-vf',
    `fps=1/${THUMB_EVERY_MS / 1000},scale=-2:${THUMB_HEIGHT},tile=${columns}x${rows}`,
    '-frames:v',
    '1',
    '-c:v',
    'mjpeg',
    '-q:v',
    '5',
    '-f',
    'image2',
    '-update',
    '1',
    checkPath(output, 'output'),
  ];
}

/** Raw mono s16le at 4 kHz on stdout, for `computePeaks`. */
export function peaksArgs(input: string, format: MediaFormat): string[] {
  return [
    ...FFMPEG_BASE,
    ...inputArgs(input, format),
    '-map',
    '0:a:0',
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(PEAKS_SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    '-f',
    's16le',
    'pipe:1',
  ];
}

export interface Peaks {
  version: 1;
  peaksPerSecond: number;
  /** 0..1, 3 decimals. */
  peaks: number[];
}

export function computePeaks(pcm: Buffer): Peaks {
  const per = PEAKS_SAMPLE_RATE / PEAKS_PER_SECOND;
  const samples = Math.floor(pcm.length / 2);
  const peaks: number[] = [];
  for (let start = 0; start < samples; start += per) {
    let max = 0;
    const end = Math.min(samples, start + per);
    for (let i = start; i < end; i++) {
      const v = Math.abs(pcm.readInt16LE(i * 2));
      if (v > max) max = v;
    }
    peaks.push(Math.round((Math.min(max, 32767) / 32767) * 1000) / 1000);
  }
  return { version: 1, peaksPerSecond: PEAKS_PER_SECOND, peaks };
}

/** One PNG still of the source at `atMs` (input seek: ffmpeg decodes from the keyframe before it, so the frame is exact). */
export function frameArgs(input: string, format: MediaFormat, atMs: number, output: string): string[] {
  if (!Number.isInteger(atMs) || atMs < 0) {
    throw new VoxError('VALIDATION', `atMs must be a whole number ≥ 0, got ${atMs}`, 'Pass times in ms.');
  }
  return [
    ...FFMPEG_BASE,
    '-y',
    ...seekInput(inputArgs(input, format), atMs),
    '-map',
    '0:V:0',
    '-frames:v',
    '1',
    '-c:v',
    'png',
    '-f',
    'image2',
    '-update',
    '1',
    checkPath(output, 'output'),
  ];
}

/** `-ss` goes right before `-i` (an input option). */
function seekInput(args: string[], atMs: number): string[] {
  const i = args.lastIndexOf('-i');
  return [...args.slice(0, i), '-ss', (atMs / 1000).toFixed(3), ...args.slice(i)];
}
