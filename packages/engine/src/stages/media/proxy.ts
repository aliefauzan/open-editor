// ffmpeg argv builders for ingest outputs (engine spec "Encoding", "Ingest analysis", "Ingest
// hardening"; D-15): the 540p preview proxy, the constant-frame-rate copy of a VFR (or, under the
// GATE 1 NTSC fallback, NTSC) video, and the PNG/JPEG re-encode of an image (S6). Every input is
// whitelisted (ffargs.ts). The CFR rate is a parameter: analyze.ts picks it from GATE 1's result.

import { VoxError } from '../../errors.pending.ts';
import { FFMPEG_BASE, checkPath, inputArgs } from './ffargs.ts';
import type { Fps } from './analyze.ts';
import type { MediaFormat } from './sniff.ts';

/** Shorter side of the preview proxy, in pixels (never upscaled). */
export const PROXY_SHORT_SIDE = 540;

function invalid(message: string): VoxError {
  return new VoxError('VALIDATION', message, 'This is an engine bug; please report it.');
}

function checkFps(fps: Fps): Fps {
  if (
    !Number.isSafeInteger(fps.num) ||
    !Number.isSafeInteger(fps.den) ||
    fps.num <= 0 ||
    fps.den <= 0
  ) {
    throw invalid(`Invalid frame rate ${JSON.stringify(fps)}.`);
  }
  return fps;
}

/** Keyframe interval for a keyframe every 0.5 s at `fps` (`-g` and `-keyint_min`), at least 1. */
export function keyframeInterval(fps: Fps): number {
  checkFps(fps);
  return Math.max(1, Math.round(fps.num / fps.den / 2));
}

/** Scale so the shorter side is 540 (or the source's, if smaller); both sides even. */
export const PROXY_SCALE =
  `scale=w='if(gte(iw,ih),-2,trunc(min(${PROXY_SHORT_SIDE},iw)/2)*2)'` +
  `:h='if(gte(iw,ih),trunc(min(${PROXY_SHORT_SIDE},ih)/2)*2,-2)'`;

export interface ProxyArgsOptions {
  /** The original, or the CFR copy for a VFR video. */
  input: string;
  format: MediaFormat;
  output: string;
  /** Source rate (`MediaItem.fps`), for the keyframe interval. */
  fps: Fps;
}

/** `proxies/<mediaId>.mp4`: libx264 `-crf 23`, 540p, keyframe every 0.5 s, video only. */
export function proxyArgs(o: ProxyArgsOptions): string[] {
  const g = String(keyframeInterval(o.fps));
  return [
    ...FFMPEG_BASE,
    '-y',
    ...inputArgs(o.input, o.format),
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-vf',
    PROXY_SCALE,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-g',
    g,
    '-keyint_min',
    g,
    '-sc_threshold',
    '0',
    '-movflags',
    '+faststart',
    checkPath(o.output, 'output'),
  ];
}

export interface CfrCopyArgsOptions {
  input: string;
  format: MediaFormat;
  /** `media/<mediaId>.cfr.mp4`. */
  output: string;
  /** Target rate from analyze.ts (`MediaAnalysis.cfr.fps`). */
  fps: Fps;
}

/** `media/<mediaId>.cfr.mp4`: libx264 `-crf 18` at a constant `fps`, first audio stream copied. */
export function cfrCopyArgs(o: CfrCopyArgsOptions): string[] {
  const fps = checkFps(o.fps);
  return [
    ...FFMPEG_BASE,
    '-y',
    ...inputArgs(o.input, o.format),
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-fps_mode',
    'cfr',
    '-r',
    `${fps.num}/${fps.den}`,
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
    checkPath(o.output, 'output'),
  ];
}

export interface ImageReencodeOptions {
  input: string;
  format: 'png' | 'jpeg';
  /** Written as PNG for a PNG source (keeps alpha), JPEG for a JPEG source. */
  output: string;
}

/** S6: decode and re-encode one image frame; metadata and any trailing bytes are dropped. */
export function imageReencodeArgs(o: ImageReencodeOptions): string[] {
  const codec =
    o.format === 'png'
      ? ['-c:v', 'png', '-f', 'image2', '-update', '1']
      : ['-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2', '-update', '1'];
  return [
    ...FFMPEG_BASE,
    '-y',
    ...inputArgs(o.input, o.format),
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-map_metadata',
    '-1',
    ...codec,
    checkPath(o.output, 'output'),
  ];
}
