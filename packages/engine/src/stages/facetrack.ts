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
  samples: z.array(DetectionSampleSchema),
});
export type Detections = z.infer<typeof DetectionsSchema>;

// ---- tuning (D-24) ----

/** Path algorithm version; part of the cache key, bump it when the output changes. */
export const PATH_VERSION = 1;
/** Hysteresis: another face must be more than 30 % larger (area) … */
export const HYSTERESIS_RATIO = 1.3;
/** … for at least 1 s. */
export const HYSTERESIS_MS = 1000;
/** A subject unmatched for this long is dropped and the largest box is picked again. */
export const REACQUIRE_MS = 1000;
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

export interface TrackPath {
  /** Source frame size (the detections' sample size) and the sequence aspect the path was built for. */
  source: Aspect;
  aspect: Aspect;
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
  let best: Box | undefined;
  for (const b of boxes) {
    if (best === undefined || area(b) > area(best) || (area(b) === area(best) && cx(b) < cx(best)))
      best = b;
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
 * Follows one box through a shot. The first subject is the largest box (or the pinned index);
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
  const crop = cropSize({ width: det.width, height: det.height }, options.aspect);
  const xr: [number, number] = [crop.w / 2, 1 - crop.w / 2];
  const yr: [number, number] = [crop.h / 2, 1 - crop.h / 2];
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
      path = [{ atMs: shot.startMs, x: 0.5, y: 0.5 }];
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
    keyframes.push(...prune(path.map((p) => ({ atMs: p.atMs, x: r4(p.x), y: r4(p.y), scale: 1 }))));
    infos.push(info);
  }
  return {
    source: { width: det.width, height: det.height },
    aspect: { width: options.aspect.width, height: options.aspect.height },
    keyframes,
    shots: infos,
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
    .map((k) => {
      const scale = clamp(k.scale, 1, MAX_PIN_SCALE);
      const c = cropSize(path.source, path.aspect, scale);
      return {
        src: a + k.atMs,
        x: clamp(k.x, c.w / 2, 1 - c.w / 2),
        y: clamp(k.y, c.h / 2, 1 - c.h / 2),
        scale,
      };
    })
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
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
