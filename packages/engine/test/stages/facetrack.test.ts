import { describe, expect, test } from 'vitest';
import { VoxError } from '../../src/errors.pending.ts';
import {
  DEAD_ZONE,
  DetectionsSchema,
  PIN_BLEND_MS,
  TRACK_SPEED,
  applyClipFraming,
  buildTrackPath,
  cropSize,
  facetrackCacheKey,
  sampleKeyframes,
  type FrameKeyframe,
  type TrackPathOptions,
} from '../../src/stages/facetrack.ts';
import { CUTS_2SHOT, box, cuts2shot, podcast, synth } from './facetrack-synth.ts';

const VERTICAL = { width: 1080, height: 1920 };
const opts = (o: Partial<TrackPathOptions> = {}): TrackPathOptions => ({
  mode: 'facetrack',
  aspect: VERTICAL,
  ...o,
});
const crop = cropSize({ width: 640, height: 360 }, VERTICAL);
const clampX = (x: number) => Math.min(1 - crop.w / 2, Math.max(crop.w / 2, x));
const xAt = (kfs: FrameKeyframe[], t: number) => sampleKeyframes(kfs, t).x;

describe('DetectionsSchema (vox_py.facetrack result)', () => {
  test('accepts the Python tool shape', () => {
    expect(DetectionsSchema.parse(cuts2shot()).samples.length).toBe(108);
  });

  test('rejects boxes outside 0..1, extra keys and a bad model hash', () => {
    const d = cuts2shot();
    const bad1 = structuredClone(d);
    bad1.samples[0]!.faces[0]!.x = 1.5;
    expect(() => DetectionsSchema.parse(bad1)).toThrow();
    expect(() => DetectionsSchema.parse({ ...d, extra: 1 })).toThrow();
    expect(() => DetectionsSchema.parse({ ...d, faceModel: { name: 'x', sha256: 'zz' } })).toThrow();
  });
});

describe('cropSize', () => {
  test('9:16 from 16:9 keeps the full height; 16:9 from 16:9 is the whole frame; scale zooms in', () => {
    expect(cropSize({ width: 1920, height: 1080 }, VERTICAL)).toEqual({ w: 81 / 256, h: 1 });
    expect(cropSize({ width: 1920, height: 1080 }, { width: 1280, height: 720 })).toEqual({ w: 1, h: 1 });
    expect(cropSize({ width: 1080, height: 1080 }, { width: 1920, height: 1080 }, 2)).toEqual({
      w: 0.5,
      h: 0.28125,
    });
  });
});

describe('shot boundaries (no drift across a cut)', () => {
  for (const stability of ['smooth', 'follow', 'locked'] as const) {
    test(`${stability}: the first keyframe of each shot is on the new subject; the old shot holds to the cut`, () => {
      const path = buildTrackPath(cuts2shot(), CUTS_2SHOT, opts({ stability }));
      const k = path.keyframes;
      const first2 = k.find((f) => f.atMs >= 3000);
      expect(first2?.atMs).toBe(3000);
      expect(first2?.x).toBeCloseTo(clampX(0.66), 3);
      const last1 = k.filter((f) => f.atMs < 3000).at(-1);
      expect(last1?.atMs).toBe(2999);
      expect(last1?.x).toBeCloseTo(clampX(0.3), 3);
      // nothing in shot 1 moves toward shot 2's subject
      for (const f of k.filter((f) => f.atMs < 3000)) expect(f.x).toBeCloseTo(clampX(0.3), 3);
      // facetrack mode: the no-face shot is centred
      const first3 = k.find((f) => f.atMs >= 6000);
      expect(first3).toMatchObject({ atMs: 6000, x: 0.5, y: 0.5, scale: 1 });
      expect(path.shots.map((s) => s.subject)).toEqual(['face', 'face', 'centre']);
    });
  }

  test('auto: the no-face shot uses saliency and starts on the box, not on the previous face', () => {
    const d = cuts2shot();
    const path = buildTrackPath(d, CUTS_2SHOT, opts({ mode: 'auto' }));
    expect(path.shots.map((s) => s.subject)).toEqual(['face', 'face', 'saliency']);
    const s6000 = d.samples.find((s) => s.atMs === 6000)!.saliency!;
    const first3 = path.keyframes.find((f) => f.atMs >= 6000);
    expect(first3?.atMs).toBe(6000);
    expect(first3?.x).toBeCloseTo(clampX(s6000.x + s6000.w / 2), 3);
    // later in the shot the crop follows the moving box to the right
    expect(xAt(path.keyframes, 8900)).toBeGreaterThan(xAt(path.keyframes, 6500));
  });

  test('every shot gets a keyframe at its start and a hold one ms before its end', () => {
    const path = buildTrackPath(cuts2shot(), CUTS_2SHOT, opts());
    const times = path.keyframes.map((f) => f.atMs);
    for (const s of CUTS_2SHOT) {
      expect(times).toContain(s.startMs);
      expect(times).toContain(s.endMs - 1);
    }
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
  });
});

describe('subject choice', () => {
  const one = [{ startMs: 0, endMs: 3000 }];

  test('auto falls back face → body → saliency → centre; facetrack uses faces only', () => {
    const bodyOnly = synth(3000, () => ({ bodies: [box(0.7, 0.5, 0.2, 0.8)], saliency: box(0.2, 0.5, 0.1, 0.1) }));
    const salOnly = synth(3000, () => ({ saliency: box(0.2, 0.5, 0.1, 0.1) }));
    const empty = synth(3000, () => ({}));
    expect(buildTrackPath(bodyOnly, one, opts({ mode: 'auto' })).shots[0]?.subject).toBe('body');
    expect(xAt(buildTrackPath(bodyOnly, one, opts({ mode: 'auto' })).keyframes, 1000)).toBeCloseTo(0.7, 3);
    expect(buildTrackPath(salOnly, one, opts({ mode: 'auto' })).shots[0]?.subject).toBe('saliency');
    expect(buildTrackPath(empty, one, opts({ mode: 'auto' })).shots[0]?.subject).toBe('centre');
    expect(buildTrackPath(bodyOnly, one, opts({ mode: 'facetrack' })).shots[0]?.subject).toBe('centre');
  });

  test('a face in fewer than a quarter of the samples does not make a face shot', () => {
    const rare = synth(3000, (_t, i) => ({
      faces: i === 5 ? [box(0.8, 0.5, 0.1, 0.2)] : [],
      saliency: box(0.25, 0.5, 0.1, 0.1),
    }));
    expect(buildTrackPath(rare, one, opts({ mode: 'auto' })).shots[0]?.subject).toBe('saliency');
  });

  test('the first subject is the largest face; faceIndex pins a face by left-to-right order', () => {
    const d = synth(3000, () => ({ faces: [box(0.75, 0.5, 0.3, 0.5), box(0.25, 0.5, 0.1, 0.2)] }));
    expect(xAt(buildTrackPath(d, one, opts()).keyframes, 1500)).toBeCloseTo(clampX(0.75), 3);
    expect(xAt(buildTrackPath(d, one, opts({ faceIndex: 0 })).keyframes, 1500)).toBeCloseTo(clampX(0.25), 3);
    expect(xAt(buildTrackPath(d, one, opts({ faceIndex: 1 })).keyframes, 1500)).toBeCloseTo(clampX(0.75), 3);
    const missing = buildTrackPath(d, one, opts({ faceIndex: 5 }));
    expect(missing.shots[0]?.faceIndexMissing).toBe(true);
    expect(xAt(missing.keyframes, 1500)).toBeCloseTo(clampX(0.75), 3);
  });

  test('a lost face is held, then the largest face is picked again after 1 s', () => {
    const d = synth(4000, (t) => ({
      faces: t < 1000 ? [box(0.2, 0.5, 0.1, 0.2)] : [box(0.8, 0.5, 0.1, 0.2)],
    }));
    const path = buildTrackPath(d, [{ startMs: 0, endMs: 4000 }], opts({ stability: 'follow', trackSpeed: 'fast' }));
    expect(path.shots[0]?.switchesAtMs).toEqual([2000]);
    expect(xAt(path.keyframes, 1900)).toBeCloseTo(clampX(0.2), 3);
    expect(xAt(path.keyframes, 3999)).toBeGreaterThan(0.7);
  });
});

describe('hysteresis (podcast-2face)', () => {
  const one = [{ startMs: 0, endMs: 12000 }];

  test('0.5 s of a 1.4× larger face does not switch; 1.5 s does, after 1 s', () => {
    const path = buildTrackPath(podcast([[3000, 3500], [7000, 8500]]), one, opts());
    expect(path.shots[0]?.switchesAtMs).toEqual([8000]);
    for (const t of [0, 2900, 3300, 3600, 5000, 7900]) expect(xAt(path.keyframes, t)).toBeLessThan(0.35);
    expect(xAt(path.keyframes, 11999)).toBeGreaterThan(0.7);
  });

  test('only the short growth: never switches', () => {
    const path = buildTrackPath(podcast([[3000, 3500]]), one, opts({ stability: 'follow' }));
    expect(path.shots[0]?.switchesAtMs).toEqual([]);
    expect(Math.max(...path.keyframes.map((f) => f.x))).toBeLessThan(0.35);
  });

  test('a face pinned by faceIndex never switches', () => {
    const path = buildTrackPath(podcast([[3000, 3500], [7000, 8500]]), one, opts({ faceIndex: 0 }));
    expect(path.shots[0]?.switchesAtMs).toEqual([]);
  });
});

describe('stability', () => {
  const one = [{ startMs: 0, endMs: 4000 }];

  test('locked: a subject inside the 10 % dead zone gives one static crop for the shot', () => {
    const jitter = 0.9 * DEAD_ZONE * crop.w;
    const d = synth(4000, (_t, i) => ({ faces: [box(0.4 + (i % 2 ? jitter : -jitter), 0.5, 0.1, 0.2)] }));
    const path = buildTrackPath(d, one, opts({ stability: 'locked' }));
    expect(path.shots[0]?.stability).toBe('locked');
    expect(path.keyframes).toHaveLength(2);
    expect(path.keyframes.map((f) => f.atMs)).toEqual([0, 3999]);
    expect(path.keyframes[0]?.x).toBe(path.keyframes[1]?.x);
    expect(path.keyframes[0]?.x).toBeCloseTo(0.4, 3);
  });

  test('locked: a subject leaving the dead zone makes the shot smooth', () => {
    const d = synth(4000, (t) => ({ faces: [box(0.3 + (0.3 * t) / 4000, 0.5, 0.1, 0.2)] }));
    const path = buildTrackPath(d, one, opts({ stability: 'locked' }));
    expect(path.shots[0]?.stability).toBe('smooth');
    expect(path.keyframes.length).toBeGreaterThan(2);
    expect(xAt(path.keyframes, 3999)).toBeGreaterThan(xAt(path.keyframes, 0) + 0.15);
  });

  test('follow tracks closer than smooth', () => {
    // saliency has no identity tracking, so a step in its box is a step in the target
    const d = synth(4000, (t) => ({ saliency: box(t < 1000 ? 0.3 : 0.6, 0.5, 0.1, 0.2) }));
    const lag = (s: 'smooth' | 'follow') =>
      Math.abs(0.6 - xAt(buildTrackPath(d, one, opts({ mode: 'auto', stability: s, trackSpeed: 'fast' })).keyframes, 1250));
    expect(lag('follow')).toBeLessThan(lag('smooth'));
  });

  test('trackSpeed caps how fast the crop moves; faster speeds arrive earlier', () => {
    const d = synth(8000, (t) => ({ saliency: box(t < 1000 ? 0.2 : 0.8, 0.5, 0.1, 0.2) }));
    const arrival: Record<string, number> = {};
    for (const speed of ['slow', 'normal', 'fast'] as const) {
      const k = buildTrackPath(d, [{ startMs: 0, endMs: 8000 }], opts({ mode: 'auto', stability: 'follow', trackSpeed: speed })).keyframes;
      for (let i = 1; i < k.length; i++) {
        const dt = (k[i]!.atMs - k[i - 1]!.atMs) / 1000;
        expect(Math.abs(k[i]!.x - k[i - 1]!.x)).toBeLessThanOrEqual(TRACK_SPEED[speed] * crop.w * dt + 2e-4);
      }
      arrival[speed] = k.find((f) => f.x > clampX(0.8) - 0.01)?.atMs ?? Infinity;
    }
    expect(arrival['fast']).toBeLessThan(arrival['normal']!);
    expect(arrival['normal']).toBeLessThan(arrival['slow']!);
  });
});

describe('applyClipFraming (user keyframes)', () => {
  const still = synth(6000, () => ({ faces: [box(0.3, 0.5, 0.1, 0.2)] }));
  const path = buildTrackPath(still, [{ startMs: 0, endMs: 6000 }], opts());
  const base = clampX(0.3);

  test('a pin holds the crop at its time and blends back to the track over 300 ms', () => {
    const k = applyClipFraming(path, { inMs: 0, durationMs: 6000, keyframes: [{ atMs: 2000, x: 0.7, y: 0.5, scale: 1.2 }] });
    expect(sampleKeyframes(k, 2000)).toEqual({ x: 0.7, y: 0.5, scale: 1.2 });
    const half = sampleKeyframes(k, 2000 + PIN_BLEND_MS / 2);
    expect(half.x).toBeCloseTo((0.7 + base) / 2, 3);
    expect(half.scale).toBeCloseTo(1.1, 3);
    expect(sampleKeyframes(k, 2000 + PIN_BLEND_MS).x).toBeCloseTo(base, 3);
    expect(sampleKeyframes(k, 2000 + PIN_BLEND_MS).scale).toBe(1);
    expect(sampleKeyframes(k, 2000 - PIN_BLEND_MS / 2).x).toBeCloseTo((0.7 + base) / 2, 3);
    expect(sampleKeyframes(k, 2000 - PIN_BLEND_MS).x).toBeCloseTo(base, 3);
    expect(sampleKeyframes(k, 5000).x).toBeCloseTo(base, 3);
  });

  test('two pins closer than 600 ms join directly', () => {
    const k = applyClipFraming(path, {
      inMs: 0,
      durationMs: 6000,
      keyframes: [
        { atMs: 2000, x: 0.7, y: 0.5, scale: 1 },
        { atMs: 2400, x: 0.5, y: 0.5, scale: 1 },
      ],
    });
    expect(sampleKeyframes(k, 2200).x).toBeCloseTo(0.6, 3);
  });

  test('a pin never blends across a cut', () => {
    const p2 = buildTrackPath(cuts2shot(), CUTS_2SHOT, opts());
    const k = applyClipFraming(p2, { inMs: 0, durationMs: 9000, keyframes: [{ atMs: 2900, x: 0.8, y: 0.5, scale: 1 }] });
    expect(sampleKeyframes(k, 3000).x).toBeCloseTo(sampleKeyframes(p2.keyframes, 3000).x, 3);
    expect(sampleKeyframes(k, 2999).x).toBeCloseTo(0.8 + ((clampX(0.3) - 0.8) * 99) / PIN_BLEND_MS, 3);
  });

  test('keyframes are relative to the item start and a start trim shifts them', () => {
    const p2 = buildTrackPath(cuts2shot(), CUTS_2SHOT, opts({ mode: 'auto' }));
    const pin = { x: 0.8, y: 0.5, scale: 1.3 };
    const a = applyClipFraming(p2, { inMs: 1000, durationMs: 7000, keyframes: [{ atMs: 3500, ...pin }] });
    // trim the start by 400 ms: inMs grows, the pin's relative time shrinks by the same amount
    const b = applyClipFraming(p2, { inMs: 1400, durationMs: 6600, keyframes: [{ atMs: 3100, ...pin }] });
    expect(a[0]?.atMs).toBe(0);
    expect(a.at(-1)?.atMs).toBe(7000);
    expect(b.at(-1)?.atMs).toBe(6600);
    for (let src = 1400; src <= 8000; src += 37) {
      const va = sampleKeyframes(a, src - 1000);
      const vb = sampleKeyframes(b, src - 1400);
      expect(vb.x).toBeCloseTo(va.x, 3);
      expect(vb.scale).toBeCloseTo(va.scale, 3);
    }
    expect(sampleKeyframes(a, 3500)).toEqual(pin);
  });

  test('without pins the clip window is the path sliced and shifted', () => {
    const p2 = buildTrackPath(cuts2shot(), CUTS_2SHOT, opts());
    const k = applyClipFraming(p2, { inMs: 2500, durationMs: 1000 });
    expect(k[0]?.atMs).toBe(0);
    expect(k.at(-1)?.atMs).toBe(1000);
    expect(sampleKeyframes(k, 499).x).toBeCloseTo(clampX(0.3), 3);
    expect(sampleKeyframes(k, 500).x).toBeCloseTo(clampX(0.66), 3);
  });

  test('pins outside the clip window are ignored', () => {
    const k = applyClipFraming(path, { inMs: 0, durationMs: 1000, keyframes: [{ atMs: 5000, x: 0.9, y: 0.5, scale: 1 }] });
    expect(k.every((f) => f.x === base)).toBe(true);
  });
});

describe('facetrackCacheKey', () => {
  const k = {
    mediaHash: 'f'.repeat(64),
    aspect: { width: 1080, height: 1920 },
    mode: 'auto',
    stability: 'smooth',
    trackSpeed: 'normal',
  } as const;

  test('same inputs → same key; the aspect is reduced (1080×1920 = 540×960)', () => {
    expect(facetrackCacheKey(k)).toBe(facetrackCacheKey({ ...k }));
    expect(facetrackCacheKey({ ...k, aspect: { width: 540, height: 960 } })).toBe(facetrackCacheKey(k));
    expect(facetrackCacheKey(k)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a changed media hash, aspect, mode, stability, trackSpeed or faceIndex misses the cache', () => {
    const base = facetrackCacheKey(k);
    const variants = [
      { ...k, mediaHash: 'e'.repeat(64) },
      { ...k, aspect: { width: 1080, height: 1080 } },
      { ...k, mode: 'facetrack' as const },
      { ...k, stability: 'locked' as const },
      { ...k, trackSpeed: 'fast' as const },
      { ...k, faceIndex: 0 },
    ];
    const keys = variants.map((v) => facetrackCacheKey(v));
    for (const key of keys) expect(key).not.toBe(base);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('defaults: absent stability/trackSpeed equal smooth/normal', () => {
    expect(facetrackCacheKey({ mediaHash: k.mediaHash, aspect: k.aspect, mode: 'auto' })).toBe(facetrackCacheKey(k));
  });
});

describe('validation and determinism', () => {
  test('shots that do not tile the media, a bad aspect or a bad faceIndex fail with VALIDATION', () => {
    const d = cuts2shot();
    const bad: unknown[] = [
      () => buildTrackPath(d, [{ startMs: 0, endMs: 3000 }, { startMs: 2000, endMs: 9000 }], opts()),
      () => buildTrackPath(d, [{ startMs: 100, endMs: 9000 }], opts()),
      () => buildTrackPath(d, CUTS_2SHOT, opts({ aspect: { width: 0, height: 1 } })),
      () => buildTrackPath(d, CUTS_2SHOT, opts({ faceIndex: -1 })),
      () => applyClipFraming(buildTrackPath(d, CUTS_2SHOT, opts()), { inMs: -1, durationMs: 10 }),
    ];
    for (const f of bad) {
      let err: unknown;
      try {
        (f as () => void)();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(VoxError);
      expect((err as VoxError).code).toBe('VALIDATION');
    }
  });

  test('empty shot list means one shot over the detections', () => {
    const p = buildTrackPath(cuts2shot(), [], opts());
    expect(p.shots).toHaveLength(1);
    expect(p.shots[0]).toMatchObject({ startMs: 0, endMs: 9000 });
  });

  test('the same inputs give the same path; values are rounded to 4 decimals', () => {
    const a = buildTrackPath(podcast([[7000, 8500]]), [], opts({ mode: 'auto' }));
    const b = buildTrackPath(podcast([[7000, 8500]]), [], opts({ mode: 'auto' }));
    expect(a).toEqual(b);
    for (const f of a.keyframes) {
      expect(Number.isInteger(f.atMs)).toBe(true);
      expect(Math.round(f.x * 1e4) / 1e4).toBe(f.x);
    }
  });
});
