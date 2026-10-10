// Content sniffing (engine spec "Ingest hardening", "Ingest sources"; R4 S5, S6).
// The type of a file comes from its first bytes, never from its extension. SVG, HTML, playlists
// (HLS, PLS, DASH), concat lists and any other markup are never media. Text is a document only
// under a document extension (.txt, .md, .fountain); a PDF is a document from its content.
// The extension is used only to name a text document; everything else ignores it.
// A head that decodes as UTF-8 text is never media, whatever signature it carries: real media heads
// hold NUL bytes or invalid UTF-8, so a polyglot such as `<!--ftypisom--><html>` stays markup.

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { VoxError } from '../../errors.ts';

/** Demuxer families the engine opens with ffmpeg; each maps to one `-format_whitelist` (ffargs.ts). */
export type MediaFormat =
  | 'mov' // ISO BMFF / QuickTime: MP4, MOV, M4V, M4A
  | 'matroska' // MKV, WebM
  | 'wav'
  | 'mp3'
  | 'aac' // ADTS
  | 'ogg'
  | 'flac'
  | 'png'
  | 'jpeg';

export type SniffedMedia =
  | { kind: 'video'; format: 'mov' | 'matroska'; ext: string }
  | { kind: 'audio'; format: 'mov' | 'wav' | 'mp3' | 'aac' | 'ogg' | 'flac'; ext: string }
  | { kind: 'image'; format: 'png' | 'jpeg'; ext: string };

export type Sniffed = SniffedMedia | { kind: 'document'; format: 'pdf' | 'text'; ext: string };

/** Bytes read from the start of a file; enough for every signature and the text checks. */
export const SNIFF_BYTES = 4096;

const TEXT_DOC_EXTS = new Set(['txt', 'md', 'fountain']);

const ACCEPTED_HINT =
  'Use a video (MP4, MOV, M4V, WebM, MKV), audio (WAV, MP3, AAC, M4A, OGG, FLAC), image (PNG, JPEG) ' +
  'or document (.txt, .md, .fountain, .pdf) file.';

function unsupported(detected: string, name: string | undefined): VoxError {
  const what = name === undefined ? 'This file' : `"${name}"`;
  return new VoxError(
    'MEDIA_UNSUPPORTED',
    `${what} is not a supported media file (content looks like ${detected}).`,
    ACCEPTED_HINT,
    { details: { detected } },
  );
}

const ascii = (b: Uint8Array, start: number, end: number): string =>
  Buffer.from(b.subarray(start, end)).toString('latin1');

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

// ISO BMFF major brands that are still images, not video (HEIF/HEIC/AVIF, Canon raw).
const IMAGE_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'mif1',
  'msf1',
  'avif',
  'avis',
  'crx ',
]);
// Top-level QuickTime atoms that can open a .mov written without `ftyp`.
const QT_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

/** Box size at bytes 0-3: 0 (to end of file), 1 (64-bit size follows) or at least the header. */
const plausibleBoxSize = (b: Uint8Array): boolean => {
  const size = Buffer.from(b.subarray(0, 4)).readUInt32BE(0);
  return size === 0 || size === 1 || size >= 8;
};
const printable4 = (b: Uint8Array, at: number): boolean =>
  b.length >= at + 4 &&
  [0, 1, 2, 3].every((i) => (b[at + i] ?? 0) >= 0x20 && (b[at + i] ?? 0) < 0x7f);

/** A valid MPEG audio frame header (MP3 without ID3): version, layer, bitrate and rate not reserved. */
function mpegAudioHeader(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  const b1 = b[1] ?? 0;
  const b2 = b[2] ?? 0;
  const version = (b1 >> 3) & 0x3;
  const layer = (b1 >> 1) & 0x3;
  const bitrate = (b2 >> 4) & 0xf;
  const rate = (b2 >> 2) & 0x3;
  return version !== 1 && layer !== 0 && bitrate !== 0xf && rate !== 0x3;
}

function sniffBinary(b: Uint8Array): Sniffed | string | undefined {
  // ISO BMFF / QuickTime
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp' && plausibleBoxSize(b) && printable4(b, 8)) {
    const brand = ascii(b, 8, 12);
    if (brand === 'qt  ') return { kind: 'video', format: 'mov', ext: 'mov' };
    if (brand === 'M4A ' || brand === 'M4B ') return { kind: 'audio', format: 'mov', ext: 'm4a' };
    if (brand === 'M4V ' || brand === 'M4VH' || brand === 'M4VP') {
      return { kind: 'video', format: 'mov', ext: 'm4v' };
    }
    if (IMAGE_BRANDS.has(brand)) return 'heif';
    return { kind: 'video', format: 'mov', ext: 'mp4' };
  }
  if (b.length >= 8 && QT_ATOMS.has(ascii(b, 4, 8)) && plausibleBoxSize(b))
    return { kind: 'video', format: 'mov', ext: 'mov' };
  // EBML: Matroska or WebM (DocType sits in the EBML header, within the first bytes)
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) {
    const head = ascii(b, 0, Math.min(b.length, 64));
    if (head.includes('webm')) return { kind: 'video', format: 'matroska', ext: 'webm' };
    if (head.includes('matroska')) return { kind: 'video', format: 'matroska', ext: 'mkv' };
    return 'ebml';
  }
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: 'image', format: 'png', ext: 'png' };
  }
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { kind: 'image', format: 'jpeg', ext: 'jpg' };
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF') {
    const form = ascii(b, 8, 12);
    if (form === 'WAVE') return { kind: 'audio', format: 'wav', ext: 'wav' };
    if (form === 'WEBP') return 'webp';
    if (form === 'AVI ') return 'avi';
    return 'riff';
  }
  if (ascii(b, 0, 4) === 'OggS') return { kind: 'audio', format: 'ogg', ext: 'ogg' };
  if (ascii(b, 0, 4) === 'fLaC') return { kind: 'audio', format: 'flac', ext: 'flac' };
  if (ascii(b, 0, 3) === 'ID3') return { kind: 'audio', format: 'mp3', ext: 'mp3' };
  if (ascii(b, 0, 4) === 'GIF8') return 'gif';
  if (b.length >= 4 && b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0) {
    const b1 = b[1] ?? 0;
    const layer = (b1 >> 1) & 0x3;
    // ADTS AAC: 12-bit sync, layer 00, sampling index not reserved (13-15).
    if ((b1 & 0xf0) === 0xf0 && layer === 0) {
      return (((b[2] ?? 0) >> 2) & 0xf) < 13
        ? { kind: 'audio', format: 'aac', ext: 'aac' }
        : undefined;
    }
    // MPEG audio (MP3): 11-bit sync and a valid frame header.
    if (mpegAudioHeader(b)) return { kind: 'audio', format: 'mp3', ext: 'mp3' };
  }
  return undefined;
}

/** What a text head looks like: a markup or playlist kind that is never media, or plain text. */
function classifyText(b: Uint8Array): string {
  let text = Buffer.from(b).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const t = text.trimStart().toLowerCase();
  if (t.startsWith('#extm3u') || t.startsWith('#ext-x-')) return 'hls';
  if (t.startsWith('ffconcat')) return 'concat';
  if (t.startsWith('[playlist]')) return 'playlist';
  // Markup is judged only when the text opens with a tag, so a note that mentions `<svg>` or
  // `<script>` in its body is still a document. Any text opening with `<` is never a document.
  if (!t.startsWith('<')) return 'text';
  if (/<svg[\s>/]/.test(t)) return 'svg';
  if (
    t.startsWith('<!doctype html') ||
    /<(html|head|body|script|iframe|object|embed)[\s>/]/.test(t)
  ) {
    return 'html';
  }
  return 'xml';
}

function isUtf8Text(b: Uint8Array): boolean {
  if (b.includes(0)) return false;
  // A head cut mid-character is fine: drop up to 3 trailing bytes before the strict decode.
  for (let cut = 0; cut <= Math.min(3, b.length); cut++) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, b.length - cut));
      return true;
    } catch {
      // try a shorter slice
    }
  }
  return false;
}

/**
 * Sniff the first bytes of a file. `name` is used only to name a text document and for the error
 * message. Throws `MEDIA_UNSUPPORTED` with `details.detected` for anything that is not accepted.
 */
export function sniffBytes(head: Uint8Array, name?: string): Sniffed {
  if (head.length === 0) throw unsupported('an empty file', name);
  // A PDF may be pure ASCII; it is a document by content either way.
  if (ascii(head, 0, 5) === '%PDF-') return { kind: 'document', format: 'pdf', ext: 'pdf' };
  if (!isUtf8Text(head)) {
    const bin = sniffBinary(head);
    if (typeof bin === 'object') return bin;
    throw unsupported(bin ?? 'unknown binary data', name);
  }
  const kind = classifyText(head);
  if (kind !== 'text') throw unsupported(kind, name);
  const ext = name === undefined ? '' : extname(name).slice(1).toLowerCase();
  if (TEXT_DOC_EXTS.has(ext)) return { kind: 'document', format: 'text', ext };
  throw unsupported('plain text', name);
}

/** Sniff a file on disk (reads at most `SNIFF_BYTES`). Folders and special files are rejected. */
export async function sniffFile(path: string): Promise<Sniffed> {
  let fh;
  try {
    // O_NONBLOCK: opening a FIFO must not hang; the stat check below then rejects it.
    fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EISDIR') throw unsupported('a folder', path);
    if (code === 'ELOOP') throw unsupported('a symbolic link', path);
    throw new VoxError(
      'NOT_FOUND',
      `Cannot read "${path}" (${code ?? 'error'}).`,
      'Check the path and try again.',
      {
        cause: e,
      },
    );
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw unsupported(st.isDirectory() ? 'a folder' : 'a special file', path);
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    return sniffBytes(buf.subarray(0, bytesRead), path);
  } finally {
    await fh.close();
  }
}
