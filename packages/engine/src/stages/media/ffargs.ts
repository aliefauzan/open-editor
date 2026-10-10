// ffmpeg/ffprobe argument builders (engine spec "Ingest hardening"; R3 "External processes"; R4 S5).
// Every input opened from an untrusted file carries `-protocol_whitelist file,pipe` and a
// `-format_whitelist` limited to the demuxers of the sniffed type, so HLS, concat and other
// playlist-style demuxers that open further files are never used. Paths must be absolute.

import { isAbsolute } from 'node:path';
import { VoxError } from '../../errors.pending.ts';
import type { MediaFormat } from './sniff.ts';

export const PROTOCOL_WHITELIST = 'file,pipe';

/** Demuxer names allowed per sniffed format (ffmpeg `-formats` names). */
export const FORMAT_WHITELIST: Readonly<Record<MediaFormat, string>> = {
  mov: 'mov,mp4,m4a,3gp,3g2,mj2',
  matroska: 'matroska,webm',
  wav: 'wav',
  mp3: 'mp3',
  aac: 'aac',
  ogg: 'ogg',
  flac: 'flac',
  png: 'png_pipe',
  jpeg: 'jpeg_pipe',
};

/** First args of every ffmpeg run: no banner, no stdin, errors only. */
export const FFMPEG_BASE: readonly string[] = ['-hide_banner', '-nostdin', '-loglevel', 'error'];

function invalid(message: string): VoxError {
  return new VoxError('VALIDATION', message, 'This is an engine bug; please report it.');
}

/** Absolute, no NUL; returned unchanged. Never starts with `-`, so ffmpeg cannot read it as an option. */
export function checkPath(path: string, what = 'path'): string {
  if (path.includes('\0') || !isAbsolute(path)) {
    throw invalid(`ffmpeg ${what} must be an absolute path: ${JSON.stringify(path)}`);
  }
  return path;
}

/**
 * Demuxer forced with `-f` per sniffed format, so ffmpeg never probes (an image named `.jpg` would
 * otherwise pick `image2`, which the whitelist refuses). The whitelist stays as the second layer.
 */
export const FORCED_DEMUXER: Readonly<Record<MediaFormat, string>> = {
  mov: 'mov',
  matroska: 'matroska',
  wav: 'wav',
  mp3: 'mp3',
  aac: 'aac',
  ogg: 'ogg',
  flac: 'flac',
  png: 'png_pipe',
  jpeg: 'jpeg_pipe',
};

/** The whitelisted input block for one untrusted file: `… -format_whitelist <wl> -f <demuxer> -i <path>`. */
export function inputArgs(path: string, format: MediaFormat): string[] {
  const wl = FORMAT_WHITELIST[format];
  const demuxer = FORCED_DEMUXER[format];
  if (wl === undefined || demuxer === undefined)
    throw invalid(`Unknown media format "${String(format)}".`);
  return [
    '-protocol_whitelist',
    PROTOCOL_WHITELIST,
    '-format_whitelist',
    wl,
    '-f',
    demuxer,
    '-i',
    checkPath(path, 'input'),
  ];
}

/** ffprobe JSON of format and streams. */
export function ffprobeStreamsArgs(path: string, format: MediaFormat): string[] {
  return [
    '-v',
    'error',
    '-of',
    'json',
    '-show_format',
    '-show_streams',
    ...inputArgs(path, format),
  ];
}

/** ffprobe pts of every packet of the first video stream, one per line (no decode). */
export function ffprobePtsArgs(path: string, format: MediaFormat): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=pts_time',
    '-of',
    'csv=p=0',
    ...inputArgs(path, format),
  ];
}

/** ffmpeg `ebur128` with true peak over the first audio stream; the summary goes to stderr. */
export function ebur128Args(path: string, format: MediaFormat): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-loglevel',
    'info',
    ...inputArgs(path, format),
    '-map',
    '0:a:0',
    '-af',
    'ebur128=peak=true:framelog=verbose',
    '-f',
    'null',
    '-',
  ];
}

/**
 * True when every `-i` in `argv` is preceded (since the previous `-i`) by both whitelists.
 * Used by tests and as a guard before running ffmpeg on untrusted input.
 */
export function inputsAreWhitelisted(argv: readonly string[]): boolean {
  let proto = false;
  let fmt = false;
  let inputs = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-protocol_whitelist') proto = argv[i + 1] === PROTOCOL_WHITELIST;
    if (a === '-format_whitelist') fmt = typeof argv[i + 1] === 'string' && argv[i + 1] !== '';
    if (a === '-i') {
      if (!proto || !fmt) return false;
      inputs++;
      proto = false;
      fmt = false;
    }
  }
  return inputs > 0;
}
