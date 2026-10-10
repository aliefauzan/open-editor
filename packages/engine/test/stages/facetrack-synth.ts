// Synthetic detection files in the shape of `py/vox_py/facetrack.py`'s result (`facetracks/<mediaId>.json`).
import type { Box, Detections } from '../../src/stages/facetrack.ts';

export const SAMPLE_FPS = 12;

/** Sample times at 12 fps over [0, durationMs). */
export function sampleTimes(durationMs: number): number[] {
  const out: number[] = [];
  for (let i = 0; ; i++) {
    const t = Math.round((i * 1000) / SAMPLE_FPS);
    if (t >= durationMs) return out;
    out.push(t);
  }
}

/** Box from a centre and size (normalised), clipped into the frame. */
export function box(cx: number, cy: number, w: number, h: number, score = 0.9): Box {
  const x = Math.max(0, cx - w / 2);
  const y = Math.max(0, cy - h / 2);
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y), score };
}

export interface SampleContent {
  faces?: Box[];
  bodies?: Box[];
  saliency?: Box | null;
}

/** 640×360 (16:9) detections; `at(t)` gives the content of the sample at `t` ms. */
export function synth(durationMs: number, at: (t: number, i: number) => SampleContent): Detections {
  return {
    sampleFps: SAMPLE_FPS,
    width: 640,
    height: 360,
    durationMs,
    faceModel: { name: 'blaze_face_full_range', sha256: 'a'.repeat(64) },
    samples: sampleTimes(durationMs).map((t, i) => {
      const c = at(t, i);
      return { atMs: t, faces: c.faces ?? [], bodies: c.bodies ?? [], saliency: c.saliency ?? null };
    }),
  };
}

export const centreX = (b: Box): number => b.x + b.w / 2;

/** cuts-2shot-like: face-a left (0–3 s), face-b right (3–6 s), no face + a moving bright box (6–9 s). */
export function cuts2shot(): Detections {
  return synth(9000, (t) => {
    if (t < 3000) return { faces: [box(0.3, 0.45, 0.18, 0.4)], bodies: [box(0.3, 0.6, 0.3, 0.8)] };
    if (t < 6000) return { faces: [box(0.66, 0.45, 0.18, 0.4)], bodies: [box(0.66, 0.6, 0.3, 0.8)] };
    const s = (t - 6000) / 1000;
    return { saliency: box(Math.min(0.9, 0.08 + (s * 500) / 1920), 0.48, 0.07, 0.13) };
  });
}
export const CUTS_2SHOT = [
  { startMs: 0, endMs: 3000 },
  { startMs: 3000, endMs: 6000 },
  { startMs: 6000, endMs: 9000 },
];

/** podcast-2face-like: equal faces; face-b grows 1.4× during `grow` windows (inclusive, ms). */
export function podcast(grow: [number, number][], durationMs = 12000): Detections {
  return synth(durationMs, (t) => {
    const k = grow.some(([a, b]) => t >= a && t <= b) ? 1.4 : 1;
    return { faces: [box(0.3, 0.5, 0.2, 0.36), box(0.75, 0.5, 0.2 * k, 0.36 * k)] };
  });
}
