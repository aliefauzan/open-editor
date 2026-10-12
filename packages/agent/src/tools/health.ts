// Frame health (agent spec "Frame health", plan D-15): model-free checks on every review still,
// computed from pixel luma before any model sees the frame, and also with no vision model.
// The stills are PNGs written by the engine (HyperFrames snapshots, ffmpeg); a small decoder for
// non-interlaced 8/16-bit grey, grey+alpha, RGB and RGBA covers them (png.ts).
import { decodePng } from './png.ts';

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

/** Luma statistics of a PNG; throws on a PNG this decoder does not read (palette, interlaced). */
export function pngLumaStats(png: Uint8Array): LumaStats {
  const { width, height, channels, depth, pixels } = decodePng(png);
  const bytes = depth / 8;
  const bpp = channels * bytes;
  let sum = 0;
  let sumSq = 0;
  let black = 0;
  let white = 0;
  // 16-bit samples: the high byte (big-endian) is the 8-bit value
  const sample = (px: number, ch: number): number => pixels[px + ch * bytes] ?? 0;
  for (let i = 0, n = width * height; i < n; i++) {
    const px = i * bpp;
    const luma =
      channels <= 2
        ? sample(px, 0)
        : 0.2126 * sample(px, 0) + 0.7152 * sample(px, 1) + 0.0722 * sample(px, 2);
    sum += luma;
    sumSq += luma * luma;
    if (luma < HEALTH.blackLuma) black++;
    if (luma > HEALTH.whiteLuma) white++;
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
