// Frame health (agent spec "Frame health", plan D-15): model-free checks on every review still,
// computed from pixel luma before any model sees the frame, and also with no vision model.
// The stills are PNGs written by the engine (HyperFrames snapshots, ffmpeg); a small decoder for
// non-interlaced 8/16-bit grey, grey+alpha, RGB and RGBA covers them.
import { inflateSync } from 'node:zlib';

export type FrameFlag = 'mostlyBlack' | 'mostlyWhite' | 'blank' | 'lowLuma';

/** Thresholds (phase-11 decision): luma is BT.709 on 0–255. */
export const HEALTH = Object.freeze({
  blackLuma: 16,
  whiteLuma: 239,
  /** Share of pixels that makes a frame mostly black or mostly white. */
  mostlyShare: 0.95,
  /** Luma standard deviation under this = one flat colour (blank). */
  blankStdDev: 2,
  /** Mean luma under this = too dark (when not already mostly black). */
  lowMeanLuma: 40,
});

export interface LumaStats {
  width: number;
  height: number;
  mean: number;
  stdDev: number;
  blackShare: number;
  whiteShare: number;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Luma statistics of a PNG; throws on a PNG this decoder does not read (palette, interlaced). */
export function pngLumaStats(png: Uint8Array): LumaStats {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
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
  let prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let sum = 0;
  let sumSq = 0;
  let black = 0;
  let white = 0;
  const sample = (row: Buffer, x: number, ch: number): number =>
    depth === 8 ? (row[x * bpp + ch] ?? 0) : (row[x * bpp + ch * 2] ?? 0);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base] ?? 0;
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i] ?? 0;
      const a = i >= bpp ? (cur[i - bpp] ?? 0) : 0;
      const b = prev[i] ?? 0;
      const c = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
      const v =
        filter === 0 ? x
        : filter === 1 ? x + a
        : filter === 2 ? x + b
        : filter === 3 ? x + ((a + b) >> 1)
        : filter === 4 ? x + paeth(a, b, c)
        : -1;
      if (v < 0) throw new Error('bad PNG filter');
      cur[i] = v & 0xff;
    }
    for (let px = 0; px < width; px++) {
      let luma: number;
      if (channels <= 2) luma = sample(cur, px, 0);
      else luma = 0.2126 * sample(cur, px, 0) + 0.7152 * sample(cur, px, 1) + 0.0722 * sample(cur, px, 2);
      sum += luma;
      sumSq += luma * luma;
      if (luma < HEALTH.blackLuma) black++;
      if (luma > HEALTH.whiteLuma) white++;
    }
    prev = Buffer.from(cur);
  }
  const n = width * height;
  const mean = sum / n;
  return {
    width,
    height,
    mean,
    stdDev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
    blackShare: black / n,
    whiteShare: white / n,
  };
}

export function healthFlags(s: LumaStats): FrameFlag[] {
  const flags: FrameFlag[] = [];
  if (s.blackShare >= HEALTH.mostlyShare) flags.push('mostlyBlack');
  if (s.whiteShare >= HEALTH.mostlyShare) flags.push('mostlyWhite');
  if (s.stdDev < HEALTH.blankStdDev) flags.push('blank');
  if (s.mean < HEALTH.lowMeanLuma && !flags.includes('mostlyBlack')) flags.push('lowLuma');
  return flags;
}

export function frameHealth(png: Uint8Array): FrameFlag[] {
  return healthFlags(pngLumaStats(png));
}
