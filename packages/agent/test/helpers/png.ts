// Tiny RGB PNG writer for frame-health fixtures (filter 0 rows, one IDAT).
import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

export function rgbPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = y % 5; // exercise every filter type the decoder must undo
    const line = Buffer.alloc(width * 3);
    for (let x = 0; x < width; x++) line.set(pixel(x, y), x * 3);
    // write the row with the filter named in raw[row]
    const prevStart = row - (width * 3 + 1) + 1;
    for (let i = 0; i < line.length; i++) {
      const a = i >= 3 ? (line[i - 3] ?? 0) : 0;
      const b = y > 0 ? (rawLine(raw, prevStart, width, y - 1, i, pixel) ?? 0) : 0;
      const c = y > 0 && i >= 3 ? (rawLine(raw, prevStart, width, y - 1, i - 3, pixel) ?? 0) : 0;
      const f = raw[row] as number;
      const pred =
        f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      raw[row + 1 + i] = ((line[i] as number) - pred) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function rawLine(
  _raw: Buffer,
  _start: number,
  _width: number,
  y: number,
  i: number,
  pixel: (x: number, y: number) => readonly [number, number, number],
): number | undefined {
  return pixel(Math.floor(i / 3), y)[i % 3];
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Deterministic pseudo-random noise in [0, 1). */
export function noise(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}
