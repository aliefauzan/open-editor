// Active picture area (baked-in black bars): the cropdetect argument builder and parser, the
// bars decision (≥ 2 % per side, stable across samples, else the full frame), and the crop path
// that keeps a 9:16 crop inside the area (tracked, pinned and static). The real-ffmpeg runs on a
// synthetic letterboxed clip are in `active-area.slow.test.ts`.
import { describe, expect, test } from 'vitest';
import { inputsAreWhitelisted } from '../../src/stages/media/ffargs.ts';
import {
  ACTIVE_AREA_SAMPLES,
  activeAreaSampleTimes,
  cropdetectArgs,
  decideActiveArea,
  normaliseArea,
  parseCropdetect,
  type CropBox,
} from '../../src/stages/media/activeArea.ts';
import {
  applyClipFraming,
  areaCoverScale,
  buildTrackPath,
  cropSize,
  facetrackCacheKey,
  staticTrackPath,
  type Area,
  type FrameKeyframe,
} from '../../src/stages/facetrack.ts';
import { box, synth } from './facetrack-synth.ts';

const VERTICAL = { width: 1080, height: 1920 };
const SRC = { width: 640, height: 360 };
/** 1920×1080 with a 1920×800 active area (140 px bars top and bottom), normalised. */
const LETTERBOX: Area = { x: 0, y: 140 / 1080, w: 1, h: 800 / 1080 };
/** 1920×1080 with a 1440×1080 (4:3) active area, normalised. */
const PILLARBOX: Area = { x: 240 / 1920, y: 0, w: 1440 / 1920, h: 1 };
const EPS = 1e-4;

/** The crop rectangle (normalised to the source) of a keyframe. */
function rectOf(source: typeof SRC, k: { x: number; y: number; scale: number }) {
  const c = cropSize(source, VERTICAL, k.scale);
  return { left: k.x - c.w / 2, right: k.x + c.w / 2, top: k.y - c.h / 2, bottom: k.y + c.h / 2 };
}
function expectInside(kfs: readonly FrameKeyframe[], area: Area, source = SRC): void {
  expect(kfs.length).toBeGreaterThan(0);
  for (const k of kfs) {
    const r = rectOf(source, k);
    expect(r.left, `left at ${k.atMs}`).toBeGreaterThanOrEqual(area.x - EPS);
    expect(r.right, `right at ${k.atMs}`).toBeLessThanOrEqual(area.x + area.w + EPS);
    expect(r.top, `top at ${k.atMs}`).toBeGreaterThanOrEqual(area.y - EPS);
    expect(r.bottom, `bottom at ${k.atMs}`).toBeLessThanOrEqual(area.y + area.h + EPS);
  }
}

describe('cropdetect arguments and output', () => {
  test('one whitelisted, input-seeked 1 s run of the first video stream into metadata print', () => {
    const args = cropdetectArgs('/p/media/m_1.mp4', 'mov', 12_500);
    expect(inputsAreWhitelisted(args)).toBe(true);
    const ss = args.indexOf('-ss');
    expect(ss).toBeGreaterThan(-1);
    expect(ss).toBeLessThan(args.indexOf('-i'));
    expect(args[ss + 1]).toBe('12.500');
    expect(args[args.indexOf('-t') + 1]).toBe('1');
    expect(args[args.indexOf('-map') + 1]).toBe('0:V:0');
    expect(args[args.indexOf('-vf') + 1]).toMatch(
      /^cropdetect=limit=[0-9.]+:round=2:reset=0,metadata=mode=print:file=-$/,
    );
    expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
  });

  test('relative and option-like inputs and bad times are refused', () => {
    expect(() => cropdetectArgs('media/a.mp4', 'mov', 0)).toThrow();
    expect(() => cropdetectArgs('-a.mp4', 'mov', 0)).toThrow();
    expect(() => cropdetectArgs('/a.mp4', 'mov', -1)).toThrow();
    expect(() => cropdetectArgs('/a.mp4', 'mov', 1.5)).toThrow();
  });

  test('the last frame bounds win; no frames gives undefined', () => {
    const frame = (n: number, x1: number, x2: number, y1: number, y2: number) =>
      [
        `frame:${n}   pts:${n}   pts_time:${n / 25}`,
        `lavfi.cropdetect.x1=${x1}`,
        `lavfi.cropdetect.x2=${x2}`,
        `lavfi.cropdetect.y1=${y1}`,
        `lavfi.cropdetect.y2=${y2}`,
        `lavfi.cropdetect.w=${x2 - x1 + 1}`,
        `lavfi.cropdetect.h=${y2 - y1 + 1}`,
        'lavfi.cropdetect.limit=0.094000',
      ].join('\n');
    const out = [frame(2, 10, 1900, 200, 900), frame(3, 0, 1919, 140, 939), ''].join('\n');
    expect(parseCropdetect(out)).toEqual({ x1: 0, x2: 1919, y1: 140, y2: 939 });
    expect(parseCropdetect('')).toBeUndefined();
    expect(parseCropdetect('frame:1 pts:1 pts_time:0.04\nlavfi.cropdetect.x1=3\n')).toBeUndefined();
  });

  test('six samples spread over the media, each fully inside it', () => {
    const t = activeAreaSampleTimes(60_000);
    expect(t).toHaveLength(ACTIVE_AREA_SAMPLES);
    expect(t).toEqual([...t].sort((a, b) => a - b));
    for (const v of t) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v + 1000).toBeLessThanOrEqual(60_000);
    }
    expect(t[t.length - 1]! - t[0]!).toBeGreaterThan(40_000);
    for (const v of activeAreaSampleTimes(1500)) expect(v + 1000).toBeLessThanOrEqual(1500);
    expect(activeAreaSampleTimes(400)).toEqual([0]);
  });
});

describe('decideActiveArea', () => {
  const W = 1920;
  const H = 1080;
  const lb: CropBox = { x1: 0, x2: 1919, y1: 140, y2: 939 };
  const six = (b: CropBox | undefined) => Array.from({ length: 6 }, () => b);

  test('stable letterbox bars give the active area in source pixels', () => {
    expect(decideActiveArea(W, H, six(lb))).toEqual({ x: 0, y: 140, w: 1920, h: 800 });
  });

  test('stable pillarbox bars give the active area', () => {
    const pb: CropBox = { x1: 240, x2: 1679, y1: 0, y2: 1079 };
    expect(decideActiveArea(W, H, six(pb))).toEqual({ x: 240, y: 0, w: 1440, h: 1080 });
  });

  test('the union of the samples counts: a dark scene in one sample does not crop content', () => {
    const dark: CropBox = { x1: 300, x2: 1600, y1: 300, y2: 800 };
    expect(decideActiveArea(W, H, [lb, lb, dark, lb, lb, lb])).toEqual({
      x: 0,
      y: 140,
      w: 1920,
      h: 800,
    });
  });

  test('a normal frame is the full frame', () => {
    expect(decideActiveArea(W, H, six({ x1: 0, x2: 1919, y1: 0, y2: 1079 }))).toEqual({
      x: 0,
      y: 0,
      w: W,
      h: H,
    });
  });

  test('bars under 2 % on a side, or on one side only, keep the full frame on that axis', () => {
    // 20 px = 1.85 % of 1080
    expect(decideActiveArea(W, H, six({ x1: 0, x2: 1919, y1: 20, y2: 1059 }))).toEqual({
      x: 0,
      y: 0,
      w: W,
      h: H,
    });
    expect(decideActiveArea(W, H, six({ x1: 0, x2: 1919, y1: 0, y2: 939 }))).toEqual({
      x: 0,
      y: 0,
      w: W,
      h: H,
    });
  });

  test('bars that move between samples are not stable: full frame', () => {
    const a: CropBox = { x1: 0, x2: 1919, y1: 140, y2: 939 };
    const b: CropBox = { x1: 0, x2: 1919, y1: 200, y2: 880 };
    const c: CropBox = { x1: 0, x2: 1919, y1: 260, y2: 820 };
    expect(decideActiveArea(W, H, [a, b, c, b, c, c])).toEqual({ x: 0, y: 0, w: W, h: H });
  });

  test('too few readable samples (black frames) give the full frame', () => {
    expect(decideActiveArea(W, H, six(undefined))).toEqual({ x: 0, y: 0, w: W, h: H });
    expect(
      decideActiveArea(W, H, [lb, undefined, undefined, undefined, undefined, undefined]),
    ).toEqual({ x: 0, y: 0, w: W, h: H });
    const empty: CropBox = { x1: 1919, x2: 0, y1: 1079, y2: 0 };
    expect(decideActiveArea(W, H, six(empty))).toEqual({ x: 0, y: 0, w: W, h: H });
  });

  test('normaliseArea: a valid non-full area in the frame, else undefined', () => {
    expect(normaliseArea({ x: 0, y: 140, w: 1920, h: 800 }, 1920, 1080)).toEqual({
      x: 0,
      y: 140 / 1080,
      w: 1,
      h: 800 / 1080,
    });
    expect(normaliseArea({ x: 0, y: 0, w: 1920, h: 1080 }, 1920, 1080)).toBeUndefined();
    expect(normaliseArea({ x: 0, y: 140, w: 1920, h: 1000 }, 1920, 1080)).toBeUndefined();
    expect(normaliseArea({ x: -1, y: 140, w: 1920, h: 800 }, 1920, 1080)).toBeUndefined();
    expect(normaliseArea({ x: 0, y: 140, w: 0, h: 800 }, 1920, 1080)).toBeUndefined();
    expect(normaliseArea('nope', 1920, 1080)).toBeUndefined();
    expect(normaliseArea(undefined, 1920, 1080)).toBeUndefined();
  });
});

describe('crop path inside the active area', () => {
  test('areaCoverScale: the zoom that fits the 9:16 cover crop into the area (≥ 1, never larger)', () => {
    expect(areaCoverScale(SRC, VERTICAL, undefined)).toBe(1);
    const s = areaCoverScale(SRC, VERTICAL, LETTERBOX);
    expect(s).toBeGreaterThanOrEqual(1080 / 800);
    expect(s).toBeLessThan(1080 / 800 + 2e-4);
    // a 9:16 crop of a 4:3 pillarbox keeps the full height
    expect(areaCoverScale(SRC, VERTICAL, PILLARBOX)).toBe(1);
  });

  test('a tracked path on a letterboxed source never shows the bars, even for a face at the edge', () => {
    // the face runs from the top edge to the bottom edge of the frame and across it
    const det = synth(6000, (t) => ({
      faces: [box(0.05 + (0.9 * t) / 6000, 0.02 + (0.96 * t) / 6000, 0.08, 0.1)],
    }));
    for (const mode of ['facetrack', 'auto'] as const) {
      const path = buildTrackPath(det, [], { mode, aspect: VERTICAL }, LETTERBOX);
      expect(path.area).toEqual(LETTERBOX);
      expectInside(path.keyframes, LETTERBOX);
      for (const k of path.keyframes) expect(k.scale).toBeGreaterThanOrEqual(1080 / 800);
      // the path still follows the face across the width
      expect(path.keyframes.at(-1)!.x - path.keyframes[0]!.x).toBeGreaterThan(0.3);
    }
  });

  test('a pillarboxed source keeps the crop between the side bars', () => {
    const det = synth(6000, (t) => ({ faces: [box(0.02 + (0.96 * t) / 6000, 0.5, 0.08, 0.1)] }));
    const path = buildTrackPath(det, [], { mode: 'facetrack', aspect: VERTICAL }, PILLARBOX);
    expectInside(path.keyframes, PILLARBOX);
  });

  test('no area (or the full frame) builds exactly the old path', () => {
    const det = synth(6000, (t) => ({ faces: [box(0.1 + (0.8 * t) / 6000, 0.4, 0.08, 0.1)] }));
    const o = { mode: 'facetrack' as const, aspect: VERTICAL };
    const old = buildTrackPath(det, [], o);
    expect(old.area).toBeUndefined();
    expect(buildTrackPath(det, [], o, { x: 0, y: 0, w: 1, h: 1 })).toEqual(old);
    for (const k of old.keyframes) expect(k.scale).toBe(1);
  });

  test('user pins are pulled inside the area (scale and centre)', () => {
    const det = synth(6000, () => ({ faces: [box(0.5, 0.5, 0.08, 0.1)] }));
    const path = buildTrackPath(det, [], { mode: 'facetrack', aspect: VERTICAL }, LETTERBOX);
    const kfs = applyClipFraming(path, {
      inMs: 1000,
      durationMs: 4000,
      keyframes: [
        { atMs: 500, x: 0.5, y: 0.02, scale: 1 },
        { atMs: 2500, x: 0.99, y: 0.98, scale: 2 },
      ],
    });
    expectInside(kfs, LETTERBOX);
  });

  test('a static crop (no facetrack yet) sits in the area centre at its cover zoom', () => {
    const path = staticTrackPath(SRC, VERTICAL, LETTERBOX, {});
    const kfs = applyClipFraming(path, { inMs: 5000, durationMs: 3000 });
    expectInside(kfs, LETTERBOX);
    expect(kfs[0]!.y).toBeCloseTo(LETTERBOX.y + LETTERBOX.h / 2, 4);
    expect(kfs[0]!.scale).toBeCloseTo(1080 / 800, 3);
    // the frame's own x / y / scale are kept when inside
    const off = applyClipFraming(
      staticTrackPath(SRC, VERTICAL, LETTERBOX, { x: 0.3, scale: 1.5 }),
      {
        inMs: 0,
        durationMs: 1000,
      },
    );
    expect(off[0]!.x).toBeCloseTo(0.3, 4);
    expect(off[0]!.scale).toBe(1.5);
    expectInside(off, LETTERBOX);
  });

  test('the cache key changes with the area and is unchanged without one', () => {
    const k = { mediaHash: 'a'.repeat(64), aspect: VERTICAL, mode: 'facetrack' as const };
    expect(facetrackCacheKey({ ...k, area: undefined })).toBe(facetrackCacheKey(k));
    expect(facetrackCacheKey({ ...k, area: LETTERBOX })).not.toBe(facetrackCacheKey(k));
  });
});
