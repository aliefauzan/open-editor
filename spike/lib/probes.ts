/**
 * Item 7 probe points shared by the render check (bench/mechanisms.ts) and the preview check
 * (electron/main.ts): at the middle frame of every scene instance, the per-instance variable
 * swatch and the scoped `--tok-accent` token must show their expected colours.
 */
import {
  PANEL_BOXES,
  PANEL_SWATCH_AT,
  PANEL_TOKEN_AT,
  STYLE_TOKENS,
  SWATCH_AT,
  TOKEN_AT,
  type SceneItem,
  type Sequence,
} from './model.ts';

export interface ProbePoint {
  /** Scene instance id (panels: `<stack>-p1`). */
  id: string;
  what: 'swatch' | 'token';
  /** Inner sample box on the canvas (x, y, w, h), away from the box edges. */
  box: [number, number, number, number];
  expect: string;
}

export interface ProbeFrame {
  f: number;
  points: ProbePoint[];
}

const inner = (x: number, y: number, size: number): [number, number, number, number] => [
  x + size * 0.25,
  y + size * 0.25,
  size * 0.5,
  size * 0.5,
];

export function mechanismProbes(seq: Sequence): ProbeFrame[] {
  const out: ProbeFrame[] = [];
  for (const it of seq.items) {
    if (it.kind !== 'scene') continue;
    const s = it as SceneItem;
    const f = s.startF + Math.floor(s.durF / 2);
    const points: ProbePoint[] = [
      {
        id: s.id,
        what: 'swatch',
        box: inner(SWATCH_AT.x, SWATCH_AT.y, SWATCH_AT.size),
        expect: s.vars.swatch,
      },
      {
        id: s.id,
        what: 'token',
        box: inner(TOKEN_AT.x, TOKEN_AT.y, TOKEN_AT.size),
        expect: STYLE_TOKENS[s.style].accent!,
      },
    ];
    (s.panels ?? []).forEach((p, i) => {
      const { x: x0, y: y0 } = PANEL_BOXES[i]!;
      points.push(
        {
          id: p.id,
          what: 'swatch',
          box: inner(x0 + PANEL_SWATCH_AT.x, y0 + PANEL_SWATCH_AT.y, PANEL_SWATCH_AT.size),
          expect: p.vars.swatch,
        },
        {
          id: p.id,
          what: 'token',
          box: inner(x0 + PANEL_TOKEN_AT.x, y0 + PANEL_TOKEN_AT.y, PANEL_TOKEN_AT.size),
          expect: STYLE_TOKENS[p.style].accent!,
        },
      );
    });
    out.push({ f, points });
  }
  return out.sort((a, b) => a.f - b.f);
}

export function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mean RGB of `box` in an RGB(A) buffer of width `w` and `channels` bytes per pixel. */
export function meanRgb(
  buf: Uint8Array,
  w: number,
  box: readonly [number, number, number, number],
  channels = 3,
  order: 'rgb' | 'bgr' = 'rgb',
): [number, number, number] {
  const [x0, y0, bw, bh] = box.map(Math.round) as [number, number, number, number];
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y0 + bh; y++)
    for (let x = x0; x < x0 + bw; x++) {
      const o = (y * w + x) * channels;
      r += buf[o]!;
      g += buf[o + 1]!;
      b += buf[o + 2]!;
      n++;
    }
  const m: [number, number, number] = [r / n, g / n, b / n].map(Math.round) as [
    number,
    number,
    number,
  ];
  return order === 'bgr' ? [m[2], m[1], m[0]] : m;
}

export function colorDist(a: readonly number[], b: readonly number[]): number {
  return Math.round(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!));
}

/** Colour tolerance (RGB distance) after yuv420 + codec round trips. */
export const COLOR_TOL = 48;
