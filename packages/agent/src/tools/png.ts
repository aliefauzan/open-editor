// A small PNG reader and writer for the stills the engine writes (HyperFrames snapshots, ffmpeg):
// non-interlaced 8/16-bit grey, grey+alpha, RGB and RGBA. Frame health reads the pixels; stills
// for the model are scaled down to STILL_MAX_EDGE first (D-80), and image tokens are counted from
// the size in the header.
import { crc32, deflateSync, inflateSync } from 'node:zlib';

/** Stills sent as pixels are at most this many pixels on the long edge (D-80). */
export const STILL_MAX_EDGE = 768;

/** Anthropic's image token rule: ≈ w × h / 750, after its own scaling to ≤ 1568 px and ≤ 1600 tokens. */
const ANTHROPIC_MAX_EDGE = 1568;
const ANTHROPIC_MAX_TOKENS = 1600;
const PIXELS_PER_TOKEN = 750;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };
const COLOUR_TYPE: Readonly<Record<number, number>> = { 1: 0, 2: 4, 3: 2, 4: 6 };

export interface DecodedPng {
  width: number;
  height: number;
  /** 1 grey, 2 grey+alpha, 3 RGB, 4 RGBA. */
  channels: number;
  depth: 8 | 16;
  /** Unfiltered rows, `height` × `width × channels × depth / 8` bytes. */
  pixels: Buffer;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

const asBuffer = (png: Uint8Array): Buffer =>
  Buffer.from(png.buffer, png.byteOffset, png.byteLength);

/** Width and height from the header, or null when `png` is not a PNG. */
export function pngSize(png: Uint8Array): { width: number; height: number } | null {
  const buf = asBuffer(png);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE)) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Throws on a PNG this decoder does not read (palette, interlaced, 1/2/4-bit). */
export function decodePng(png: Uint8Array): DecodedPng {
  const buf = asBuffer(png);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8] ?? 0;
      colour = data[9] ?? 0;
      if ((data[12] ?? 0) !== 0) throw new Error('interlaced PNG is not supported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = CHANNELS[colour];
  if (channels === undefined || (depth !== 8 && depth !== 16) || width === 0 || height === 0) {
    throw new Error(`PNG colour type ${String(colour)}/${String(depth)}-bit is not supported`);
  }
  const bpp = channels * (depth / 8);
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) throw new Error('truncated PNG');
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base] ?? 0;
    const row = y * stride;
    const up = row - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i] ?? 0;
      const a = i >= bpp ? (pixels[row + i - bpp] ?? 0) : 0;
      const b = y > 0 ? (pixels[up + i] ?? 0) : 0;
      const c = y > 0 && i >= bpp ? (pixels[up + i - bpp] ?? 0) : 0;
      const v =
        filter === 0
          ? x
          : filter === 1
            ? x + a
            : filter === 2
              ? x + b
              : filter === 3
                ? x + ((a + b) >> 1)
                : filter === 4
                  ? x + paeth(a, b, c)
                  : -1;
      if (v < 0) throw new Error('bad PNG filter');
      pixels[row + i] = v & 0xff;
    }
  }
  return { width, height, channels, depth, pixels };
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** An 8-bit PNG of `pixels` (rows of `width × channels` bytes), Paeth-filtered. */
export function encodePng(width: number, height: number, channels: number, pixels: Buffer): Buffer {
  const colour = COLOUR_TYPE[channels];
  if (colour === undefined) throw new Error(`no PNG colour type for ${String(channels)} channels`);
  const stride = width * channels;
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const out = y * (stride + 1);
    const row = y * stride;
    filtered[out] = 4;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? (pixels[row + i - channels] ?? 0) : 0;
      const b = y > 0 ? (pixels[row - stride + i] ?? 0) : 0;
      const c = y > 0 && i >= channels ? (pixels[row - stride + i - channels] ?? 0) : 0;
      filtered[out + 1 + i] = ((pixels[row + i] ?? 0) - paeth(a, b, c)) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colour;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(filtered)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * `png` with its long edge at most `maxEdge` (area average, 8-bit, same channels). A PNG that is
 * small enough, or that this decoder cannot read, comes back unchanged.
 */
export function downscalePng(png: Uint8Array, maxEdge: number = STILL_MAX_EDGE): Uint8Array {
  const size = pngSize(png);
  if (!size || Math.max(size.width, size.height) <= maxEdge) return png;
  let d: DecodedPng;
  try {
    d = decodePng(png);
  } catch {
    return png;
  }
  const scale = maxEdge / Math.max(d.width, d.height);
  const w = Math.max(1, Math.round(d.width * scale));
  const h = Math.max(1, Math.round(d.height * scale));
  const ch = d.channels;
  const bytes = d.depth / 8;
  const inStride = d.width * ch * bytes;
  const out = Buffer.alloc(w * h * ch);
  const sums = new Float64Array(ch);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * d.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * d.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * d.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * d.width) / w));
      sums.fill(0);
      for (let sy = y0; sy < y1; sy++) {
        const row = sy * inStride;
        for (let sx = x0; sx < x1; sx++) {
          const px = row + sx * ch * bytes;
          // 16-bit samples: the high byte (big-endian) is the 8-bit value
          for (let c = 0; c < ch; c++) sums[c] = (sums[c] ?? 0) + (d.pixels[px + c * bytes] ?? 0);
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * w + x) * ch;
      for (let c = 0; c < ch; c++) out[o + c] = Math.round((sums[c] ?? 0) / n);
    }
  }
  return new Uint8Array(encodePng(w, h, ch, out));
}

/**
 * Input tokens Anthropic bills for an image of this size (≈ w × h / 750 after its own scaling).
 * Not a PNG: the 1,600-token ceiling.
 */
export function imageTokens(png: Uint8Array): number {
  const size = pngSize(png);
  if (!size || size.width === 0 || size.height === 0) return ANTHROPIC_MAX_TOKENS;
  const px = size.width * size.height;
  const s = Math.min(
    1,
    ANTHROPIC_MAX_EDGE / Math.max(size.width, size.height),
    Math.sqrt((ANTHROPIC_MAX_TOKENS * PIXELS_PER_TOKEN) / px),
  );
  return Math.min(ANTHROPIC_MAX_TOKENS, Math.ceil((px * s * s) / PIXELS_PER_TOKEN));
}
