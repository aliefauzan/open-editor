/**
 * D-17 frame counter: 16 cells, MSB first, white = 1, black = 0. The bench crops the counter region
 * with ffmpeg and scales it to 16x1 gray (area average), so each cell becomes one byte.
 */
export const CELLS = 16;

export function decodeBits(cells: ArrayLike<number>, threshold = 128): number {
  let v = 0;
  for (let i = 0; i < CELLS; i++) v = v * 2 + ((cells[i] ?? 0) >= threshold ? 1 : 0);
  return v;
}

/** Confidence of one decode: the smallest distance of any cell from the threshold (0..127). */
export function margin(cells: ArrayLike<number>, threshold = 128): number {
  let m = 255;
  for (let i = 0; i < CELLS; i++) m = Math.min(m, Math.abs((cells[i] ?? 0) - threshold));
  return m;
}

/** One value per frame from a raw 16-bytes-per-frame gray stream. */
export function decodeStream(raw: Uint8Array, threshold = 128): number[] {
  const out: number[] = [];
  for (let o = 0; o + CELLS <= raw.length; o += CELLS)
    out.push(decodeBits(raw.subarray(o, o + CELLS), threshold));
  return out;
}

/** Per-frame decode margins of a raw stream. */
export function marginStream(raw: Uint8Array, threshold = 128): number[] {
  const out: number[] = [];
  for (let o = 0; o + CELLS <= raw.length; o += CELLS)
    out.push(margin(raw.subarray(o, o + CELLS), threshold));
  return out;
}
