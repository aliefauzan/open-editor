// Facetrack crop-path builder (engine spec "Shots and framing", plan D-15, phase 04 step 12c).
//
// Input: the detections file written once per media by `py/vox_py/facetrack.py`
// (`facetracks/<mediaId>.json`, format in D-21) and the shot list (`shots/<mediaId>.json`).
// Output: crop keyframes `{ atMs, x, y, scale }` in source-media time (`buildTrackPath`), then per
// clip in item-relative time with the user's pins blended in (`applyClipFraming`).
//
// Coordinates (D-24): `x`, `y` are the crop centre, normalised to the source frame (0..1, origin
// top-left); `scale` is the zoom relative to the cover crop of the sequence aspect (1 = the largest
// crop of that aspect that fits the source). The tracked path pans at scale 1; pins may zoom.
//
// Active area: a source with black bars baked into the picture (letterbox, pillarbox) has an
// active area (ingest's `cache/media/<id>.json`, normalised here). The area replaces the frame as
// the crop bounds: the path pans at the zoom that fits the cover crop inside the area
// (`areaCoverScale`), and every crop centre, pin included, keeps the crop inside the area.
// No area means the full frame (the paths are exactly the ones built before areas existed).
//
// The `frame.*` types come from phase 02's model (`MediaClip.frame`). Phase 05 plugs this builder
// into 03's compile path-provider interface.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { VoxError } from '../errors.ts';
import type { Frame, Keyframe } from '../model/schema.ts';

// ---- model types (MediaClip.frame, phase 02) ----

export type { Frame };
export type FrameMode = Frame['mode'];
export type Stability = NonNullable<Frame['stability']>;
export type TrackSpeed = NonNullable<Frame['trackSpeed']>;
export type FrameKeyframe = Keyframe;

// ---- detections file (vox_py.facetrack result; py/tests/schemas/facetrack.result.json) ----

const unit = z.number().min(0).max(1);
export const BoxSchema = z.strictObject({ x: unit, y: unit, w: unit, h: unit, score: unit });
export type Box = z.infer<typeof BoxSchema>;

export const DetectionSampleSchema = z.strictObject({
  atMs: z.int().nonnegative(),
  faces: z.array(BoxSchema),
  bodies: z.array(BoxSchema),
  saliency: BoxSchema.nullable(),
});
export type DetectionSample = z.infer<typeof DetectionSampleSchema>;

export const DetectionsSchema = z.strictObject({
  sampleFps: z.number().positive(),
  width: z.int().positive(),
  height: z.int().positive(),
  durationMs: z.int().nonnegative(),
  faceModel: z.strictObject({
    name: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  /** D-82: which detector found the faces; absent in files written before it. */
  detector: z
    .strictObject({
      version: z.int().positive(),
      faces: z.enum(['vision', 'blazeface']),
      fallbackSamples: z.int().nonnegative(),
    })
    .optional(),
  samples: z.array(DetectionSampleSchema),
});
export type Detections = z.infer<typeof DetectionsSchema>;

// ---- tuning (D-24) ----

/**
 * Detections version (`vox_py.facetrack` DETECTOR_VERSION). A cached detections file with another
 * version (or none: written before D-82) is detected again. 2: Apple Vision faces first (D-82).
 */
export const DETECTOR_VERSION = 2;
/**
 * Path algorithm version; part of the cache key, bump it when the output changes. 2: the boxes come
 * from Apple Vision faces (D-82), so paths built from BlazeFace boxes are not reused.
 */
export const PATH_VERSION = 2;

/** A cached detections file is reused only when the current detector wrote it (D-82). */
export function isCurrentDetections(det: Detections | undefined): det is Detections {
  return det?.detector?.version === DETECTOR_VERSION;
}
/** Hysteresis: another face must be more than 30 % larger (area) … */
export const HYSTERESIS_RATIO = 1.3;
/** … for at least 1 s. */
export const HYSTERESIS_MS = 1000;
/** A subject unmatched for this long is dropped and the largest box is picked again. */
export const REACQUIRE_MS = 1000;
/**
 * Boxes within 5 % of the largest area count as the same size, and the leftmost of them is the
 * largest (D-82). Two equal faces never give exactly equal boxes from a detector (Apple Vision
 * boxes of the same-size faces differ by about 1 %), so an exact tie alone would pick by noise.
 */
export const EQUAL_AREA = 0.05;
/** `locked`: the subject centre may move up to 10 % of the crop size from the locked centre. */
export const DEAD_ZONE = 0.1;
/** A subject class counts for a shot when present in at least this share of its samples. */
export const MIN_PRESENCE = 0.25;
/** Smoothing time constant (s) per stability. */
export const SMOOTHING_S: Readonly<Record<'smooth' | 'follow', number>> = {
  smooth: 0.4,
  follow: 0.1,
};
/** Maximum crop speed in crop sizes per second. */
export const TRACK_SPEED: Readonly<Record<TrackSpeed, number>> = { slow: 0.5, normal: 1, fast: 2 };
/** A user keyframe blends to and from the tracked path over 300 ms. */
export const PIN_BLEND_MS = 300;
/** Pins are clamped to scale 1..8 and to a centre that keeps the crop inside the source. */
export const MAX_PIN_SCALE = 8;

// ---- public types ----

export interface Aspect {
  width: number;
  height: number;
}

export interface TrackPathOptions {
  mode: 'facetrack' | 'auto';
  /** The sequence canvas (only its ratio matters). */
  aspect: Aspect;
  stability?: Stability;
  trackSpeed?: TrackSpeed;
  /** Pins one face: index in left-to-right order of the faces in the shot's first sample with faces. */
  faceIndex?: number;
}

export type Subject = 'face' | 'body' | 'saliency' | 'centre';

export interface ShotFraming {
  startMs: number;
  endMs: number;
  /** What the crop follows in this shot (no silent fallback: the caller can report it). */
  subject: Subject;
  /** Effective stability (`locked` becomes `smooth` when the subject leaves the dead zone). */
  stability: Stability;
  /** Sample times where the followed face or body changed (hysteresis or re-pick after loss). */
  switchesAtMs: number[];
  /** `faceIndex` was set but this shot has fewer faces; the largest face was used. */
  faceIndexMissing?: true;
}

/** Active picture area, normalised to the source frame (0..1, origin top-left). */
export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TrackPath {
  /** Source frame size (the detections' sample size) and the sequence aspect the path was built for. */
  source: Aspect;
  aspect: Aspect;
  /** The active area the crop stays in (absent: the full frame). */
  area?: Area;
  /** Source-media time; linear between keyframes; each shot has a keyframe at its start and at `endMs - 1`. */
  keyframes: FrameKeyframe[];
  shots: ShotFraming[];
}

export interface ShotRange {
  startMs: number;
  endMs: number;
}

// ---- helpers ----

function invalid(message: string, details?: Record<string, unknown>): VoxError {
  return new VoxError(
    'VALIDATION',
    message,
    'Check the framing settings, or re-run shots and facetrack for this media.',
    {
      ...(details === undefined ? {} : { details }),
    },
  );
}

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const cx = (b: Box): number => b.x + b.w / 2;
const cy = (b: Box): number => b.y + b.h / 2;
const area = (b: Box): number => b.w * b.h;

function checkAspect(a: Aspect): void {
  if (!(Number.isFinite(a.width) && Number.isFinite(a.height) && a.width > 0 && a.height > 0)) {
    throw invalid(`aspect must be positive, got ${a.width}×${a.height}`);
  }
}

/** Crop size (normalised to the source) of the cover crop of `aspect`, divided by `scale`. */
export function cropSize(source: Aspect, aspect: Aspect, scale = 1): { w: number; h: number } {
  checkAspect(source);
  checkAspect(aspect);
  const a = aspect.width * source.height;
  const s = aspect.height * source.width;
  return a < s ? { w: a / s / scale, h: 1 / scale } : { w: 1 / scale, h: s / a / scale };
}

const FULL_AREA: Area = { x: 0, y: 0, w: 1, h: 1 };

/** The area if it is a real sub-rectangle of the frame, else undefined (the full frame). */
function checkArea(area: Area | undefined): Area | undefined {
  if (area === undefined) return undefined;
  const { x, y, w, h } = area;
  if (
    ![x, y, w, h].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    w <= 0 ||
    h <= 0 ||
    x + w > 1 + 1e-9 ||
    y + h > 1 + 1e-9
  ) {
    throw invalid('active area must lie inside the frame', { area });
  }
  return x === 0 && y === 0 && w === 1 && h === 1 ? undefined : { x, y, w, h };
}

/**
 * Zoom (against the full-frame cover crop) of the largest crop of `aspect` inside `area`; 1 without
 * an area. Rounded up to 1e-4 (the keyframe precision), so the crop is never larger than the area.
 */
export function areaCoverScale(source: Aspect, aspect: Aspect, area: Area | undefined): number {
  const a = checkArea(area);
  if (a === undefined) return 1;
  const full = cropSize(source, aspect);
  const inner = cropSize({ width: a.w * source.width, height: a.h * source.height }, aspect);
  const s = Math.max(full.w / (inner.w * a.w), full.h / (inner.h * a.h));
  return Math.max(1, Math.ceil(s * 1e4 - 1e-6) / 1e4);
}

/**
 * A crop pulled into the path's bounds: scale at least the area's cover zoom (pins: at most
 * `MAX_PIN_SCALE`, or that zoom if larger), centre so the crop stays inside the area.
 */
export function fitCrop(
  path: Pick<TrackPath, 'source' | 'aspect' | 'area'>,
  v: { x: number; y: number; scale: number },
): { x: number; y: number; scale: number } {
  const a = path.area ?? FULL_AREA;
  const lo = areaCoverScale(path.source, path.aspect, path.area);
  const scale = clamp(v.scale, lo, Math.max(lo, MAX_PIN_SCALE));
  const c = cropSize(path.source, path.aspect, scale);
  return {
    x: clamp(v.x, a.x + c.w / 2, a.x + a.w - c.w / 2),
    y: clamp(v.y, a.y + c.h / 2, a.y + a.h - c.h / 2),
    scale,
  };
}

/** The crop at `atMs` by linear interpolation; holds the first/last keyframe outside the range. */
export function sampleKeyframes(
  kfs: readonly FrameKeyframe[],
  atMs: number,
): { x: number; y: number; scale: number } {
  const first = kfs[0];
  const last = kfs.at(-1);
  if (first === undefined || last === undefined) return { x: 0.5, y: 0.5, scale: 1 };
  if (atMs <= first.atMs) return { x: first.x, y: first.y, scale: first.scale };
  if (atMs >= last.atMs) return { x: last.x, y: last.y, scale: last.scale };
  let lo = 0;
  let hi = kfs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((kfs[mid] as FrameKeyframe).atMs <= atMs) lo = mid;
    else hi = mid;
  }
  const a = kfs[lo] as FrameKeyframe;
  const b = kfs[hi] as FrameKeyframe;
  const t = (atMs - a.atMs) / (b.atMs - a.atMs);
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), scale: lerp(a.scale, b.scale, t) };
}

function largest(boxes: readonly Box[]): Box | undefined {
  const floor = Math.max(0, ...boxes.map(area)) * (1 - EQUAL_AREA);
  let best: Box | undefined;
  for (const b of boxes) {
    if (area(b) >= floor && (best === undefined || cx(b) < cx(best))) best = b;
  }
  return best;
}

const dist = (a: Box, b: Box): number => Math.hypot(cx(a) - cx(b), cy(a) - cy(b));

/** The box in `boxes` nearest to `cur`, if its centre is within the size of `cur`. */
function nearest(cur: Box, boxes: readonly Box[]): Box | undefined {
  const gate = Math.max(cur.w, cur.h);
  let best: Box | undefined;
  for (const b of boxes) {
    const d = dist(cur, b);
    if (d <= gate && (best === undefined || d < dist(cur, best))) best = b;
  }
  return best;
}

interface Tracked {
  boxes: Box[];
  switchesAtMs: number[];
  faceIndexMissing: boolean;
}

/**
 * Follows one box through a shot. The first subject is the largest box (`largest`: the leftmost
 * of the boxes within `EQUAL_AREA` of the biggest), or the pinned index;
 * each sample keeps the nearest box to the current one. Hysteresis: another box more than 30 %
 * larger for at least 1 s takes over. A subject lost for 1 s is replaced by the largest box.
 * Samples before the first box take the first subject (no drift into the shot).
 */
function trackBoxes(
  seq: readonly { atMs: number; boxes: Box[] }[],
  pinIndex: number | undefined,
): Tracked {
  const firstIdx = seq.findIndex((s) => s.boxes.length > 0);
  const firstBoxes = seq[firstIdx]?.boxes ?? [];
  let pinned = pinIndex !== undefined;
  let faceIndexMissing = false;
  const byIndex = (boxes: readonly Box[]): Box | undefined =>
    pinIndex === undefined ? undefined : [...boxes].sort((a, b) => cx(a) - cx(b))[pinIndex];
  let current: Box | undefined;
  if (pinIndex !== undefined) {
    current = byIndex(firstBoxes);
    if (current === undefined) {
      faceIndexMissing = true;
      pinned = false;
    }
  }
  current ??= largest(firstBoxes);
  if (current === undefined) return { boxes: [], switchesAtMs: [], faceIndexMissing };

  const out: Box[] = [];
  const switchesAtMs: number[] = [];
  let lostSince: number | null = null;
  let pending: { since: number; box: Box } | null = null;
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i] as { atMs: number; boxes: Box[] };
    if (i <= firstIdx) {
      out.push(current);
      continue;
    }
    const match = nearest(current, s.boxes);
    if (match !== undefined) {
      current = match;
      lostSince = null;
    } else {
      lostSince ??= s.atMs;
      pending = null; // the challenge must be continuous while the subject is matched
      // a pinned face is picked again by its index; otherwise the largest box
      const pick = (pinned ? byIndex(s.boxes) : undefined) ?? largest(s.boxes);
      if (s.atMs - lostSince >= REACQUIRE_MS && pick !== undefined) {
        current = pick;
        switchesAtMs.push(s.atMs);
        lostSince = null;
        pending = null;
      }
    }
    if (!pinned && match !== undefined) {
      const cur = current;
      const challenger = largest(
        s.boxes.filter((b) => b !== match && area(b) > HYSTERESIS_RATIO * area(cur)),
      );
      if (challenger === undefined) {
        pending = null;
      } else {
        if (pending === null || nearest(pending.box, [challenger]) === undefined) {
          pending = { since: s.atMs, box: challenger };
        } else {
          pending.box = challenger;
        }
        if (s.atMs - pending.since >= HYSTERESIS_MS) {
          current = challenger;
          switchesAtMs.push(s.atMs);
          pending = null;
        }
      }
    }
    out.push(current);
  }
  return { boxes: out, switchesAtMs, faceIndexMissing };
}

function checkShots(shots: readonly ShotRange[]): void {
  shots.forEach((s, i) => {
    if (!Number.isInteger(s.startMs) || !Number.isInteger(s.endMs) || s.endMs <= s.startMs) {
      throw invalid(`shot ${i} is not a valid range`, { shot: s });
    }
    const prevEnd = i === 0 ? 0 : (shots[i - 1] as ShotRange).endMs;
    if (s.startMs !== prevEnd)
      throw invalid(`shot ${i} does not start where the previous one ends`, { shot: s });
  });
}

function checkOptions(o: TrackPathOptions): void {
  if (o.mode !== 'facetrack' && o.mode !== 'auto')
    throw invalid(`framing mode ${String(o.mode)} has no tracked path`);
  checkAspect(o.aspect);
  if (o.faceIndex !== undefined && !(Number.isInteger(o.faceIndex) && o.faceIndex >= 0)) {
    throw invalid(`faceIndex must be a non-negative integer, got ${o.faceIndex}`);
  }
  if (o.stability !== undefined && !['locked', 'smooth', 'follow'].includes(o.stability)) {
    throw invalid(`unknown stability ${String(o.stability)}`);
  }
  if (o.trackSpeed !== undefined && !Object.hasOwn(TRACK_SPEED, o.trackSpeed)) {
    throw invalid(`unknown trackSpeed ${String(o.trackSpeed)}`);
  }
}

/** Removes interior keyframes equal to both neighbours (output is unchanged under interpolation). */
function prune(kfs: FrameKeyframe[]): FrameKeyframe[] {
  const same = (a: FrameKeyframe, b: FrameKeyframe) =>
    a.x === b.x && a.y === b.y && a.scale === b.scale;
  return kfs.filter((k, i) => {
    const p = kfs[i - 1];
    const n = kfs[i + 1];
    return p === undefined || n === undefined || !same(p, k) || !same(k, n);
  });
}

// ---- path builder ----

function extent(pts: readonly { x: number; y: number }[], k: 'x' | 'y'): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    lo = Math.min(lo, p[k]);
    hi = Math.max(hi, p[k]);
  }
  return [lo, hi];
}
const halfRange = (pts: readonly { x: number; y: number }[], k: 'x' | 'y'): number => {
  const [lo, hi] = extent(pts, k);
  return (hi - lo) / 2;
};
const midRange = (pts: readonly { x: number; y: number }[], k: 'x' | 'y'): number => {
  const [lo, hi] = extent(pts, k);
  return (hi + lo) / 2;
};

/**
 * Detections + shot list → source-time crop keyframes. Smoothing resets at every shot boundary,
 * so the crop jumps to the new shot's subject at the cut and never drifts across it.
 * An empty shot list means one shot over the detections.
 */
export function buildTrackPath(
  detections: Detections,
  shots: readonly ShotRange[],
  options: TrackPathOptions,
  activeArea?: Area,
): TrackPath {
  const parsed = DetectionsSchema.safeParse(detections);
  if (!parsed.success) {
    throw invalid('The facetrack detections file is not valid.', {
      issues: parsed.error.issues.slice(0, 5),
    });
  }
  const det = parsed.data;
  checkOptions(options);
  const ranges: ShotRange[] =
    shots.length > 0 ? [...shots] : [{ startMs: 0, endMs: Math.max(1, det.durationMs) }];
  checkShots(ranges);

  const stability: Stability = options.stability ?? 'smooth';
  const speed = TRACK_SPEED[options.trackSpeed ?? 'normal'];
  const source = { width: det.width, height: det.height };
  checkAspect(options.aspect);
  const area = checkArea(activeArea);
  const a = area ?? FULL_AREA;
  const base = areaCoverScale(source, options.aspect, area);
  const crop = cropSize(source, options.aspect, base);
  const xr: [number, number] = [a.x + crop.w / 2, a.x + a.w - crop.w / 2];
  const yr: [number, number] = [a.y + crop.h / 2, a.y + a.h - crop.h / 2];
  // sorted by time; a repeated atMs keeps the last sample
  const byTime = new Map<number, DetectionSample>();
  for (const s of det.samples) byTime.set(s.atMs, s);
  const samples = [...byTime.values()].sort((a, b) => a.atMs - b.atMs);

  const keyframes: FrameKeyframe[] = [];
  const infos: ShotFraming[] = [];

  for (const shot of ranges) {
    const inShot = samples.filter((s) => s.atMs >= shot.startMs && s.atMs < shot.endMs);
    const need = Math.max(1, Math.ceil(MIN_PRESENCE * inShot.length));
    const present = (f: (s: DetectionSample) => boolean) => inShot.filter(f).length >= need;

    let subject: Subject = 'centre';
    if (present((s) => s.faces.length > 0)) subject = 'face';
    else if (options.mode === 'auto' && present((s) => s.bodies.length > 0)) subject = 'body';
    else if (options.mode === 'auto' && present((s) => s.saliency !== null)) subject = 'saliency';

    const info: ShotFraming = {
      startMs: shot.startMs,
      endMs: shot.endMs,
      subject,
      stability,
      switchesAtMs: [],
    };
    let targets: { atMs: number; x: number; y: number }[] = [];

    if (subject === 'face' || subject === 'body') {
      const tr = trackBoxes(
        inShot.map((s) => ({ atMs: s.atMs, boxes: subject === 'face' ? s.faces : s.bodies })),
        subject === 'face' ? options.faceIndex : undefined,
      );
      info.switchesAtMs = tr.switchesAtMs;
      if (tr.faceIndexMissing) info.faceIndexMissing = true;
      targets = inShot.map((s, i) => {
        const b = tr.boxes[i] as Box;
        return { atMs: s.atMs, x: cx(b), y: cy(b) };
      });
    } else if (subject === 'saliency') {
      let last = inShot.find((s) => s.saliency !== null)?.saliency as Box;
      targets = inShot.map((s) => {
        if (s.saliency !== null) last = s.saliency;
        return { atMs: s.atMs, x: cx(last), y: cy(last) };
      });
    }
    targets = targets.map((t) => ({
      atMs: t.atMs,
      x: clamp(t.x, xr[0], xr[1]),
      y: clamp(t.y, yr[0], yr[1]),
    }));

    let path: { atMs: number; x: number; y: number }[];
    if (targets.length === 0) {
      path = [
        {
          atMs: shot.startMs,
          x: clamp(a.x + a.w / 2, xr[0], xr[1]),
          y: clamp(a.y + a.h / 2, yr[0], yr[1]),
        },
      ];
    } else if (
      stability === 'locked' &&
      halfRange(targets, 'x') <= DEAD_ZONE * crop.w + 1e-9 &&
      halfRange(targets, 'y') <= DEAD_ZONE * crop.h + 1e-9
    ) {
      path = [{ atMs: shot.startMs, x: midRange(targets, 'x'), y: midRange(targets, 'y') }];
    } else {
      if (stability === 'locked') info.stability = 'smooth';
      const tau = SMOOTHING_S[info.stability === 'follow' ? 'follow' : 'smooth'];
      const t0 = targets[0] as { atMs: number; x: number; y: number };
      let sx = t0.x;
      let sy = t0.y;
      path = [{ atMs: shot.startMs, x: sx, y: sy }];
      for (let i = 1; i < targets.length; i++) {
        const t = targets[i] as { atMs: number; x: number; y: number };
        const dt = (t.atMs - (targets[i - 1] as { atMs: number }).atMs) / 1000;
        const alpha = 1 - Math.exp(-dt / tau);
        const capX = speed * crop.w * dt;
        const capY = speed * crop.h * dt;
        sx += clamp(alpha * (t.x - sx), -capX, capX);
        sy += clamp(alpha * (t.y - sy), -capY, capY);
        path.push({ atMs: t.atMs, x: sx, y: sy });
      }
    }
    const lastP = path.at(-1) as { atMs: number; x: number; y: number };
    if (shot.endMs - 1 > lastP.atMs) path.push({ atMs: shot.endMs - 1, x: lastP.x, y: lastP.y });
    keyframes.push(
      ...prune(path.map((p) => ({ atMs: p.atMs, x: r4(p.x), y: r4(p.y), scale: base }))),
    );
    infos.push(info);
  }
  return {
    source,
    aspect: { width: options.aspect.width, height: options.aspect.height },
    ...(area === undefined ? {} : { area }),
    keyframes,
    shots: infos,
  };
}

/**
 * A path that holds one crop over the whole media, for a tracked clip whose media has an active
 * area but no shots or facetrack yet: the frame's own `x`, `y`, `scale` (default: the area's
 * centre at its cover zoom), pulled inside the area. `applyClipFraming` then adds the pins.
 */
export function staticTrackPath(
  source: Aspect,
  aspect: Aspect,
  activeArea: Area | undefined,
  frame: { x?: number; y?: number; scale?: number },
): TrackPath {
  checkAspect(source);
  checkAspect(aspect);
  const area = checkArea(activeArea);
  const a = area ?? FULL_AREA;
  const bounds = { source, aspect, ...(area === undefined ? {} : { area }) };
  const v = fitCrop(bounds, {
    x: frame.x ?? a.x + a.w / 2,
    y: frame.y ?? a.y + a.h / 2,
    scale: frame.scale ?? 1,
  });
  return {
    ...bounds,
    keyframes: [{ atMs: 0, x: r4(v.x), y: r4(v.y), scale: v.scale }],
    shots: [
      {
        startMs: 0,
        endMs: Number.MAX_SAFE_INTEGER,
        subject: 'centre',
        stability: 'locked',
        switchesAtMs: [],
      },
    ],
  };
}

// ---- clip framing (user keyframes) ----

export interface ClipWindow {
  /** Offset into the source (`MediaClip.inMs`). */
  inMs: number;
  durationMs: number;
  /** `frame.keyframes`: user pins, `atMs` relative to the item start. */
  keyframes?: readonly FrameKeyframe[];
}

/**
 * The tracked path for one clip, in item-relative time, with the user's keyframes as pins: a pin
 * holds the crop at its time and the crop blends to and from the tracked path over 300 ms (D-24).
 * Two pins up to 600 ms apart join directly. A blend never crosses a shot boundary.
 */
export function applyClipFraming(path: TrackPath, clip: ClipWindow): FrameKeyframe[] {
  if (
    !Number.isInteger(clip.inMs) ||
    clip.inMs < 0 ||
    !Number.isInteger(clip.durationMs) ||
    clip.durationMs <= 0
  ) {
    throw invalid(`clip window must be integer ms with inMs ≥ 0 and durationMs > 0`, {
      inMs: clip.inMs,
      durationMs: clip.durationMs,
    });
  }
  for (const k of clip.keyframes ?? []) {
    if (!Number.isInteger(k.atMs) || ![k.x, k.y, k.scale].every(Number.isFinite) || k.scale <= 0) {
      throw invalid('frame keyframes need integer atMs, finite x/y and a positive scale', {
        keyframe: k,
      });
    }
  }
  const a = clip.inMs;
  const b = clip.inMs + clip.durationMs;
  const shots = path.shots;
  const shotIndex = (t: number): number => {
    const i = shots.findIndex((s) => t >= s.startMs && t < s.endMs);
    return i === -1 ? (t < (shots[0]?.startMs ?? 0) ? 0 : shots.length - 1) : i;
  };
  const pins = (clip.keyframes ?? [])
    .map((k) => ({ src: a + k.atMs, ...fitCrop(path, k) }))
    .filter((p) => p.src >= a && p.src <= b)
    .sort((p, q) => p.src - q.src)
    .map((p) => ({ ...p, shot: shotIndex(p.src) }));

  const times = new Set<number>([a, b]);
  for (const k of path.keyframes) if (k.atMs > a && k.atMs < b) times.add(k.atMs);
  for (const p of pins) {
    const s = shots[p.shot];
    const lo = Math.max(a, s?.startMs ?? a, p.src - PIN_BLEND_MS);
    const hi = Math.min(b, s === undefined ? b : s.endMs - 1, p.src + PIN_BLEND_MS);
    times.add(p.src).add(lo).add(hi);
  }

  const value = (t: number): { x: number; y: number; scale: number } => {
    const base = sampleKeyframes(path.keyframes, t);
    const si = shotIndex(t);
    const mine = pins.filter((p) => p.shot === si);
    const prev = mine.filter((p) => p.src <= t).at(-1);
    const next = mine.find((p) => p.src >= t);
    if (prev !== undefined && prev.src === t) return { x: prev.x, y: prev.y, scale: prev.scale };
    if (prev !== undefined && next !== undefined && next.src - prev.src <= 2 * PIN_BLEND_MS) {
      const u = (t - prev.src) / (next.src - prev.src);
      return {
        x: lerp(prev.x, next.x, u),
        y: lerp(prev.y, next.y, u),
        scale: lerp(prev.scale, next.scale, u),
      };
    }
    const wPrev = prev === undefined ? 0 : 1 - (t - prev.src) / PIN_BLEND_MS;
    const wNext = next === undefined ? 0 : 1 - (next.src - t) / PIN_BLEND_MS;
    const pin = wPrev >= wNext ? prev : next;
    const w = Math.max(wPrev, wNext);
    if (pin === undefined || w <= 0) return base;
    return {
      x: lerp(base.x, pin.x, w),
      y: lerp(base.y, pin.y, w),
      scale: lerp(base.scale, pin.scale, w),
    };
  };

  return prune(
    [...times]
      .sort((p, q) => p - q)
      .map((t) => {
        const v = value(t);
        return { atMs: t - a, x: r4(v.x), y: r4(v.y), scale: r4(v.scale) };
      }),
  );
}

/** Track options from a clip's `frame` (facetrack/auto only). */
export function trackOptionsFromFrame(frame: Frame, aspect: Aspect): TrackPathOptions {
  if (frame.mode !== 'facetrack' && frame.mode !== 'auto')
    throw invalid(`framing mode ${frame.mode} has no tracked path`);
  return {
    mode: frame.mode,
    aspect,
    ...(frame.stability === undefined ? {} : { stability: frame.stability }),
    ...(frame.trackSpeed === undefined ? {} : { trackSpeed: frame.trackSpeed }),
    ...(frame.faceIndex === undefined ? {} : { faceIndex: frame.faceIndex }),
  };
}

// ---- cache key ----

export interface FacetrackCacheKeyInput {
  /** Content hash of the media (ingest's cache hash). */
  mediaHash: string;
  aspect: Aspect;
  mode: 'facetrack' | 'auto';
  stability?: Stability;
  trackSpeed?: TrackSpeed;
  /** Not in the spec's key list, but it changes the path (D-24). */
  faceIndex?: number;
  /** Optional hash of the inputs (shots + detections files), so re-detection misses the cache. */
  inputsHash?: string;
  /** The media's active area (absent: the full frame; the key is then the one built before areas). */
  area?: Area | undefined;
}

const gcd = (p: number, q: number): number => (q === 0 ? p : gcd(q, p % q));

/** SHA-256 hex over (path version, media hash, reduced aspect, mode, stability, trackSpeed, faceIndex). */
export function facetrackCacheKey(k: FacetrackCacheKeyInput): string {
  const { width: w, height: h } = k.aspect;
  if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0)) {
    throw invalid(`aspect must be positive integers, got ${w}×${h}`);
  }
  if (typeof k.mediaHash !== 'string' || k.mediaHash === '') throw invalid('mediaHash is required');
  const g = gcd(w, h);
  const parts = [
    'facetrack-path',
    PATH_VERSION,
    k.mediaHash,
    `${w / g}:${h / g}`,
    k.mode,
    k.stability ?? 'smooth',
    k.trackSpeed ?? 'normal',
    k.faceIndex ?? null,
    k.inputsHash ?? null,
  ];
  if (k.area !== undefined) parts.push(JSON.stringify(k.area));
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
