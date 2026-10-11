/**
 * Preview measurements run inside the spike window (driven by electron/main.ts):
 * - play: full play of the 90 s fixture; per-second fps (timeline frames and presented video frames),
 *   stalls, `<audio>` vs picture offset, heavy-scene fps margin (item 4, D-15);
 * - seek: 20 cut frames and the frames before them, latency to the right counter on screen (item 4);
 * - avseek: seek + play cycles, audio vs picture after seeks (item 4);
 * - mech: vars / tokens / muted video / volume tween in the preview (item 7);
 * - reload, patch: one trimItem, op → visible update for a full reload and a scene-only patch (item 6).
 */
import { writeFileSync } from 'node:fs';
import { decodeBits, margin } from '../lib/barcode.ts';
import { compile, type MediaSet } from '../lib/compile.ts';
import { frameMs, frameToSec } from '../lib/frames.ts';
import {
  COUNTER_CROP,
  LANDSCAPE_BOX,
  SWATCH_AT,
  cutFrames,
  expectedAt,
  makeMainSequence,
  type SceneItem,
  type Sequence,
} from '../lib/model.ts';
import { COLOR_TOL, colorDist, hexRgb, meanRgb, mechanismProbes } from '../lib/probes.ts';

export interface Capture {
  /** BGRA pixels. */
  buf: Buffer;
  width: number;
  height: number;
  jpeg: (quality?: number) => Buffer;
}

export interface Harness {
  mode: 'opaque' | 'same-origin';
  box: { w: number; h: number };
  page: <T = unknown>(code: string) => Promise<T>;
  inFrame: <T = unknown>(code: string) => Promise<T>;
  capture: () => Promise<Capture>;
  overrides: Map<string, string>;
  blockedCount: () => number;
  media: () => Promise<MediaSet>;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function stats(xs: number[]) {
  if (!xs.length) return { n: 0, p50: null, p95: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { n: s.length, p50: r1(q(0.5)), p95: r1(q(0.95)), max: r1(s[s.length - 1]!) };
}

const median = (xs: number[]): number =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0;

// ---------- pixels ----------

/** Canvas box (composition px) → capture px. */
function toPx(
  c: Capture,
  box: readonly [number, number, number, number],
): [number, number, number, number] {
  const k = c.width / 1080;
  return [box[0] * k, box[1] * k, box[2] * k, box[3] * k];
}

function gray(c: Capture, box: readonly [number, number, number, number]): number {
  const [r, g, b] = meanRgb(c.buf, c.width, toPx(c, box), 4, 'bgr');
  return (r + g + b) / 3;
}

/** Reads the D-17 counter: inner half of each of the 16 cells. */
export function readCounter(c: Capture, crop: readonly [number, number, number, number]) {
  const [x, y, w, h] = crop;
  const cw = w / 16;
  const cells: number[] = [];
  for (let i = 0; i < 16; i++)
    cells.push(gray(c, [x + i * cw + cw * 0.25, y + h * 0.25, cw * 0.5, h * 0.5]));
  return { value: decodeBits(cells), margin: Math.round(margin(cells)) };
}

/** Grey/black check: stddev of a 16x9 grid of the video area. */
function flatness(c: Capture, area: readonly [number, number, number, number]): number {
  const [x, y, w, h] = area;
  const vals: number[] = [];
  for (let j = 0; j < 9; j++)
    for (let i = 0; i < 16; i++)
      vals.push(gray(c, [x + (i * w) / 16, y + (j * h) / 9, w / 16, h / 9]));
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
}

const VIDEO_AREA = {
  spike: [LANDSCAPE_BOX.x, LANDSCAPE_BOX.y, LANDSCAPE_BOX.w, LANDSCAPE_BOX.h],
  ntsc: [LANDSCAPE_BOX.x, LANDSCAPE_BOX.y, LANDSCAPE_BOX.w, LANDSCAPE_BOX.h],
  phone: [0, 0, 1080, 1920],
} as const;

// ---------- play ----------

interface Rec {
  raf: [number, number][];
  vfc: [number, string, number][];
  av: [number, number, string, number, number | null, number | null][];
  /** [wallMs, clock, videoId, event, currentTime, readyState] */
  events?: [number, number, string, string, number, number][];
  /** long animation frames (>= 80 ms) */
  loaf?: unknown[];
}

/** Which video element must be on screen at frame f, and its media frame offset. */
function videoPlan(seq: Sequence) {
  const plan: ({ id: string; startF: number; inF: number } | null)[] = [];
  for (let f = 0; f < seq.durF; f++) {
    const e = expectedAt(seq, f);
    if (!e) {
      plan.push(null);
      continue;
    }
    const it = seq.items.find((i) => i.id === e.itemId)!;
    if (it.kind === 'scene')
      plan.push({ id: `${it.id}-slot`, startF: it.startF, inF: (it as SceneItem).slotInF! });
    else plan.push({ id: it.id, startF: it.startF, inF: e.frame - (f - it.startF) });
  }
  return plan;
}

/**
 * Presented picture vs the composition clock, in ms (audio follows the clock: audioVsClockMs). For each
 * presented right frame f at wall w: clock(w) - (f + 0.5) / fps, so 0 when the frame is on screen in
 * the middle of its slot and |x| <= half a frame for a perfectly timed frame. Steady state only
 * (> 0.4 s into the element's segment, presentation after `fromWall`).
 */
export function pictureOffsets(seq: Sequence, rec: Rec, fromWall: number): number[] {
  const fps = seq.fps.num / seq.fps.den;
  const plan = videoPlan(seq);
  const raf = rec.raf.filter(([w]) => w >= fromWall);
  const segs = segments(plan);
  const clockAt = (w: number): number | null => {
    let lo = 0;
    let hi = raf.length - 1;
    if (hi < 1 || w < raf[0]![0] || w > raf[hi]![0]) return null;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (raf[mid]![0] <= w) lo = mid;
      else hi = mid;
    }
    const [w0, t0] = raf[lo]!;
    const [w1, t1] = raf[hi]!;
    return w1 === w0 ? t0 : t0 + ((t1 - t0) * (w - w0)) / (w1 - w0);
  };
  const out: number[] = [];
  for (const [w, id, mt] of rec.vfc) {
    if (w < fromWall) continue;
    const mf = Math.round(mt * fps);
    for (const sg of segs.get(id) ?? []) {
      const f = sg.startF + (mf - sg.inF);
      if (plan[f]?.id !== id || plan[f]!.startF !== sg.startF || f - sg.startF < 0.4 * fps)
        continue;
      const c = clockAt(w);
      if (c !== null) out.push((c - (f + 0.5) / fps) * 1000);
    }
  }
  return out;
}

/** Per element id: the plan segments (composition frame f shows media frame f - startF + inF). */
function segments(plan: ReturnType<typeof videoPlan>) {
  const segs = new Map<string, { startF: number; inF: number }[]>();
  plan.forEach((p) => {
    if (!p) return;
    const l = segs.get(p.id) ?? [];
    if (!l.some((x) => x.startF === p.startF)) l.push({ startF: p.startF, inF: p.inF });
    segs.set(p.id, l);
  });
  return segs;
}

export function analyzePlay(seq: Sequence, rec: Rec, startWall: number) {
  const fps = seq.fps.num / seq.fps.den;
  const plan = videoPlan(seq);
  const raf = rec.raf.filter(([w]) => w >= startWall);
  const frameOf = (t: number) => Math.floor(t * fps + 1e-6);
  const segs = segments(plan);
  // right video frames on screen: composition frame → first presentation wall time. A frame
  // presented while its clip is still hidden (the pre-cue parks the next clip on its in-point up to
  // 1 s early) is not on screen, so it counts only once the clock is within one frame of it.
  const clockAt = (w: number): number => {
    let lo = 0;
    let hi = raf.length - 1;
    if (hi < 0 || w < raf[0]![0]) return -Infinity;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (raf[mid]![0] <= w) lo = mid;
      else hi = mid - 1;
    }
    return raf[lo]![1];
  };
  const presented = new Map<number, number>();
  for (const [w, id, mt] of rec.vfc) {
    if (w < startWall) continue;
    const clock = clockAt(w);
    const mf = Math.round(mt * fps);
    for (const sg of segs.get(id) ?? []) {
      const f = sg.startF + (mf - sg.inF);
      if (
        plan[f]?.id === id &&
        plan[f]!.startF === sg.startF &&
        clock >= (f - 1) / fps &&
        !presented.has(f)
      )
        presented.set(f, w);
    }
  }
  const picture = pictureOffsets(seq, rec, startWall);
  const windows: {
    k: number;
    fps: number;
    timelineFps: number;
    videoFps: number | null;
    spanMs: number;
  }[] = [];
  const durS = Math.floor(seq.durF / fps);
  for (let k = 0; k < durS; k++) {
    const inW = raf.filter(([, t]) => t >= k && t < k + 1);
    const next = raf.find(([, t]) => t >= k + 1);
    if (inW.length < 2) continue;
    const span = ((next ? next[0] : inW[inW.length - 1]![0]) - inW[0]![0]) / 1000;
    const distinct = new Set(inW.map(([, t]) => frameOf(t))).size;
    const timelineFps = distinct / span;
    let expected = 0;
    let got = 0;
    for (let f = Math.ceil(k * fps); f < Math.ceil((k + 1) * fps) && f < seq.durF; f++) {
      if (!plan[f]) continue;
      expected++;
      if (presented.has(f)) got++;
    }
    // presented share of the window's video frames, as a rate over the window's wall span
    const videoFps = expected >= 10 ? ((got / expected) * fps) / span : null;
    windows.push({
      k,
      fps: r1(videoFps === null ? timelineFps : Math.min(timelineFps, videoFps)),
      timelineFps: r1(timelineFps),
      videoFps: videoFps === null ? null : r1(videoFps),
      spanMs: Math.round(span * 1000),
    });
  }
  // stalls
  let rafGap = 0;
  let advanceGap = 0;
  let lastF = -1;
  let lastChange = raf[0]?.[0] ?? 0;
  for (let i = 1; i < raf.length; i++) {
    rafGap = Math.max(rafGap, raf[i]![0] - raf[i - 1]![0]);
    const f = frameOf(raf[i]![1]);
    if (f !== lastF) {
      if (lastF >= 0) advanceGap = Math.max(advanceGap, raf[i]![0] - lastChange);
      lastF = f;
      lastChange = raf[i]![0];
    }
  }
  const pres = [...presented.entries()].sort((a, b) => a[1] - b[1]);
  let videoGap = 0;
  let videoGapAt: number | null = null;
  for (let i = 1; i < pres.length; i++) {
    const [f1, w1] = pres[i - 1]!;
    const [f2, w2] = pres[i]!;
    if (f2 <= f1) continue;
    let contiguous = true;
    for (let f = f1 + 1; f < f2; f++) if (!plan[f]) contiguous = false;
    if (contiguous && w2 - w1 > videoGap) {
      videoGap = w2 - w1;
      videoGapAt = f2;
    }
  }
  // audio vs picture during play (steady state: > 0.4 s into the clip)
  const starts = new Map<string, number>();
  for (const it of seq.items)
    if (it.kind === 'audio') starts.set(it.id, frameToSec(it.startF, seq.fps));
  const av = rec.av.filter(
    (r) => r[0] >= startWall && r[5] !== null && r[1] - (starts.get(r[2]) ?? 0) >= 0.4,
  );
  const avAbsMs = av.map((r) => Math.abs(r[5]!) * 1000);
  const aClockMs = rec.av
    .filter((r) => r[0] >= startWall && r[1] - (starts.get(r[2]) ?? 0) >= 0.4)
    .map((r) => Math.abs(r[3]) * 1000);
  const heavy = (from: number, to: number) => {
    const ws = windows.filter((w) => w.k >= from && w.k < to);
    return ws.length ? Math.min(...ws.map((w) => w.fps)) : null;
  };
  const stack = seq.items.find((i) => i.kind === 'scene' && (i as SceneItem).template === 'stack')!;
  const slot = seq.items.find(
    (i) => i.kind === 'scene' && (i as SceneItem).template === 'video-slot',
  )!;
  const sec = (f: number) => frameToSec(f, seq.fps);
  const heavyStack = heavy(sec(stack.startF), sec(stack.startF + stack.durF));
  const heavySlot = heavy(sec(slot.startF), sec(slot.startF + slot.durF));
  const heavyMin = Math.min(heavyStack ?? 0, heavySlot ?? 0);
  const minFps = windows.length ? Math.min(...windows.map((w) => w.fps)) : 0;
  const stallMs = Math.round(Math.max(rafGap, advanceGap, videoGap));
  return {
    windows,
    minFps: r1(minFps),
    windowsBelow24: windows.filter((w) => w.fps < 24).map((w) => w.k),
    stall: {
      maxMs: stallMs,
      rafGapMs: Math.round(rafGap),
      frameAdvanceGapMs: Math.round(advanceGap),
      videoGapMs: Math.round(videoGap),
      videoGapAtFrame: videoGapAt,
    },
    presentedVideoFrames: presented.size,
    expectedVideoFrames: plan.filter(Boolean).length,
    avMs: stats(avAbsMs),
    audioVsClockMs: stats(aClockMs),
    pictureVsClockMs: stats(picture.map(Math.abs)),
    pictureVsClockSignedP50Ms: r1(median(picture)),
    heavy: {
      stackMinFps: heavyStack,
      slotMinFps: heavySlot,
      minFps: r1(heavyMin),
      marginPct: r1(((heavyMin - 24) / 24) * 100),
    },
    frameMs: r3(frameMs(seq.fps)),
  };
}

async function settle() {
  await sleep(400);
}

async function play(h: Harness, seq: Sequence) {
  await h.page('voxPage.player.pause(); voxPage.seek(0)');
  await sleep(1500);
  await h.inFrame('__voxProbe.start()');
  const startWall = await h.inFrame<number>('performance.now()');
  await h.page('voxPage.player.play()');
  const dur = frameToSec(seq.durF, seq.fps);
  const t0 = now();
  for (;;) {
    await sleep(500);
    const t = await h.inFrame<number>('__voxProbe.time()');
    if (t >= dur - 0.1 || now() - t0 > (dur + 60) * 1000) break;
  }
  const rec = await h.inFrame<Rec>('__voxProbe.stop()');
  await h.page('voxPage.player.pause()');
  const wallS = (now() - t0) / 1000;
  // first rAF where the clock moved: playback start
  const first = rec.raf.find(([w, t]) => w >= startWall && t > 0.0001);
  const a = analyzePlay(seq, rec, first ? first[0] : startWall);
  if (process.env.VOX_PROBE_DUMP)
    writeFileSync(process.env.VOX_PROBE_DUMP, JSON.stringify({ startWall, rec }));
  return {
    wallS: r1(wallS),
    startupMs: first ? Math.round(first[0] - startWall) : null,
    ...a,
    longFrames: rec.loaf ?? [],
    samples: {
      raf: rec.raf.length,
      vfc: rec.vfc.length,
      av: rec.av.length,
      mediaEvents: rec.events?.length ?? 0,
    },
  };
}

// ---------- seek ----------

/** Diagnostics for a wrong frame: the active videos' element time vs the runtime's target time. */
const ACTIVE_VIDEOS_JS = `(function(){var t=window.__player.getTime();return {t:t,videos:Array.prototype.slice.call(document.querySelectorAll('video[data-start]')).filter(function(v){var s=parseFloat(v.getAttribute('data-start'));var d=parseFloat(v.getAttribute('data-duration'));return t>=s&&t<s+d;}).map(function(v){var s=parseFloat(v.getAttribute('data-start'));var m=parseFloat(v.getAttribute('data-media-start')||'0');return {id:v.id,presented:window.__voxProbe&&window.__voxProbe.presented(v.id),now:Math.round(performance.now()),currentTime:v.currentTime,target:t-s+m,diffMs:Math.round((v.currentTime-(t-s+m))*100000)/100,seeking:v.seeking,readyState:v.readyState};})};})()`;

/** `at` = 0: frame start (f / fps); 0.5: frame midpoint. */
async function seekTo(h: Harness, seq: Sequence, f: number, at: number, tol = 300, limit = 2000) {
  const e = expectedAt(seq, f)!;
  const crop = COUNTER_CROP[e.src as 'spike' | 'phone' | 'ntsc'];
  const frameT0 = await h.inFrame<number>('performance.now()');
  const t0 = now();
  await h.page(`voxPage.seek(${frameToSec(f + at, seq.fps)})`);
  let caps = 0;
  const trace: [number, number, number][] = [];
  const states: unknown[] = [];
  for (;;) {
    const c = await h.capture();
    caps++;
    const last = readCounter(c, crop);
    const flat = flatness(c, VIDEO_AREA[e.src as 'spike' | 'phone' | 'ntsc']);
    const ms = now() - t0;
    const prev = trace[trace.length - 1];
    if (!prev || prev[1] !== last.value || prev[2] > 6 !== flat > 6) {
      trace.push([Math.round(ms), last.value, r1(flat)]);
      if (ms > 30) states.push([Math.round(ms), await h.inFrame<unknown>(ACTIVE_VIDEOS_JS)]);
    }
    if (last.value === e.frame && flat > 6)
      return {
        f,
        ok: ms <= tol,
        ms: Math.round(ms),
        got: last.value,
        expected: e.frame,
        src: e.src,
        captures: caps,
        ...(ms > tol
          ? {
              trace,
              states,
              events: await h.inFrame<unknown>(`__voxProbe.events(${frameT0})`),
              swallowed: await h.inFrame<unknown>(`__voxProbe.swallowed(${frameT0})`),
            }
          : {}),
      };
    if (ms > limit) {
      const media = await h.inFrame<unknown>(ACTIVE_VIDEOS_JS);
      return {
        f,
        ok: false,
        ms: null,
        got: last.value,
        expected: e.frame,
        src: e.src,
        flat: r1(flat),
        captures: caps,
        media,
        trace,
      };
    }
  }
}

async function seeks(h: Harness, seq: Sequence, at: number) {
  await h.page('voxPage.player.pause()');
  await h.inFrame('true'); // probes: runtime diagnostics for slow seeks
  // warm up capturePage (the first capture of a session is slow)
  await h.capture();
  await h.capture();
  const cuts = cutFrames(seq);
  const pick: number[] = [];
  for (let i = 0; i < 20; i++) pick.push(cuts[Math.floor((i * cuts.length) / 20)]!);
  const out: Awaited<ReturnType<typeof seekTo>>[] = [];
  for (const f of pick) {
    out.push(await seekTo(h, seq, f, at));
    out.push(await seekTo(h, seq, f - 1, at));
  }
  const atCut = out.filter((_, i) => i % 2 === 0);
  const lat = out.filter((r) => r.ms !== null).map((r) => r.ms!);
  return {
    pass: out.every((r) => r.ok),
    seekAt: at === 0 ? 'frame start f/fps' : 'frame midpoint (f+0.5)/fps',
    seeks: out.length,
    cutsTested: pick.length,
    wrongFrame: out.filter((r) => r.ms === null).length,
    over300: out.filter((r) => r.ms !== null && r.ms > 300).length,
    latencyMs: stats(lat),
    atCutLatencyMs: stats(atCut.filter((r) => r.ms !== null).map((r) => r.ms!)),
    list: out,
  };
}

// ---------- audio after seeks ----------

async function avSeek(h: Harness, seq: Sequence) {
  const fps = seq.fps.num / seq.fps.den;
  const starts = new Map<string, number>();
  for (const it of seq.items) if (it.kind === 'audio') starts.set(it.id, it.startF / fps);
  const targets = [3.2, 12.5, 27.4, 35.1, 63.0, 70.6, 76.2, 81.9];
  const cycles: {
    at: number;
    avMs: ReturnType<typeof stats>;
    pictureVsClockMs: ReturnType<typeof stats>;
    audioVsClockMs: ReturnType<typeof stats>;
    firstMs: number | null;
  }[] = [];
  const all: number[] = [];
  const allPic: number[] = [];
  const allAud: number[] = [];
  for (const at of targets) {
    await h.page(`voxPage.player.pause(); voxPage.seek(${at})`);
    await sleep(500);
    await h.inFrame('__voxProbe.start()');
    const w0 = await h.inFrame<number>('performance.now()');
    await h.page('voxPage.player.play()');
    await sleep(2200);
    const rec = await h.inFrame<Rec>('__voxProbe.stop()');
    await h.page('voxPage.player.pause()');
    const rows = rec.av.filter(
      (r) => r[5] !== null && r[0] - w0 >= 400 && r[1] - (starts.get(r[2]) ?? 0) >= 0.4,
    );
    const ms = rows.map((r) => Math.abs(r[5]!) * 1000);
    all.push(...ms);
    const pic = pictureOffsets(seq, rec, w0 + 400).map(Math.abs);
    const aud = rec.av
      .filter((r) => r[0] - w0 >= 400 && r[1] - (starts.get(r[2]) ?? 0) >= 0.4)
      .map((r) => Math.abs(r[3]) * 1000);
    allPic.push(...pic);
    allAud.push(...aud);
    const first = rec.av.find((r) => r[5] !== null);
    cycles.push({
      at,
      avMs: stats(ms),
      pictureVsClockMs: stats(pic),
      audioVsClockMs: stats(aud),
      firstMs: first ? r1(Math.abs(first[5]!) * 1000) : null,
    });
  }
  return {
    avMs: stats(all),
    pictureVsClockMs: stats(allPic),
    audioVsClockMs: stats(allAud),
    cycles,
  };
}

// ---------- item 7 in the preview ----------

async function mech(h: Harness, seq: Sequence) {
  await h.page('voxPage.player.pause()');
  const points: {
    f: number;
    id: string;
    what: string;
    expect: string;
    got: number[];
    dist: number;
    ok: boolean;
  }[] = [];
  for (const p of mechanismProbes(seq)) {
    await h.page(`voxPage.seek(${frameToSec(p.f, seq.fps)})`);
    await sleep(600);
    const c = await h.capture();
    for (const pt of p.points) {
      const got = meanRgb(c.buf, c.width, toPx(c, pt.box), 4, 'bgr');
      const dist = colorDist(got, hexRgb(pt.expect));
      points.push({
        f: p.f,
        id: pt.id,
        what: pt.what,
        expect: pt.expect,
        got,
        dist,
        ok: dist <= COLOR_TOL,
      });
    }
  }
  const media = await h.inFrame<{
    videos: { id: string; muted: boolean }[];
    audios: { id: string; volume: number }[];
  }>('__voxProbe.media()');
  const fadeAudio = seq.items.find((i) => i.kind === 'audio' && i.fade)!;
  // volume tween: paused seek, then during play
  await h.page('voxPage.seek(88)');
  await sleep(500);
  const vol = (
    await h.inFrame<{ audios: { id: string; volume: number }[] }>('__voxProbe.media()')
  ).audios.find((a) => a.id === fadeAudio.id)!.volume;
  await h.inFrame('__voxProbe.hookGain()');
  await h.page('voxPage.seek(86.4); voxPage.player.play()');
  await sleep(2400);
  await h.page('voxPage.player.pause()');
  const g = await h.inFrame<[number, number, number][]>('__voxProbe.gains()');
  // gain set closest to t = 88.0 (inside the fade) and at t < 86.6 (before it)
  const near = (t: number) =>
    g.reduce<[number, number, number] | null>(
      (b, x) => (!b || Math.abs(x[1] - t) < Math.abs(b[1] - t) ? x : b),
      null,
    );
  const at88 = near(88);
  const pre = near(86.6);
  const during = {
    t: at88 ? at88[1] : NaN,
    v: at88 ? at88[2] : NaN,
    before: pre ? pre[2] : null,
    gainSets: g.length,
  };
  const fade = (fadeAudio as { fade: { fromF: number; toF: number; from: number; to: number } })
    .fade;
  const expectAt = (t: number) => {
    const f = t * (seq.fps.num / seq.fps.den);
    const x = Math.min(1, Math.max(0, (f - fade.fromF) / (fade.toF - fade.fromF)));
    return fade.from + (fade.to - fade.from) * x;
  };
  const vars = points.filter((p) => p.what === 'swatch');
  const tokens = points.filter((p) => p.what === 'token');
  const result = {
    vars: {
      pass: vars.every((p) => p.ok),
      instances: vars.length,
      worstDist: Math.max(...vars.map((p) => p.dist)),
    },
    tokens: {
      pass: tokens.every((p) => p.ok),
      instances: tokens.length,
      worstDist: Math.max(...tokens.map((p) => p.dist)),
    },
    mutedVideo: {
      pass: media.videos.every((v) => v.muted),
      videos: media.videos.length,
      audios: media.audios.length,
    },
    volumeTween: {
      pass: Math.abs(vol - expectAt(88)) <= 0.05 && Math.abs(during.v - expectAt(during.t)) <= 0.08,
      atSeek88: vol,
      expected88: r3(expectAt(88)),
      duringPlayGain: {
        t: r3(during.t),
        gain: r3(during.v),
        expected: r3(expectAt(during.t)),
        gainBeforeFade: during.before,
        gainSets: during.gainSets,
      },
      note: 'el.volume reads 1 during play (WebAudio routing); the gain node values are checked',
    },
  };
  return { pass: Object.values(result).every((r) => r.pass), ...result, points };
}

// ---------- item 6 ----------

const MAGENTA = hexRgb('#ff00ff');
const SW_BOX = [SWATCH_AT.x + 25, SWATCH_AT.y + 25, 50, 50] as const;

async function swatch(h: Harness) {
  const c = await h.capture();
  return meanRgb(c.buf, c.width, toPx(c, SW_BOX), 4, 'bgr');
}

/** Polls the screen until the s1 swatch at frame 675 is (or is not) magenta. */
/** Composition time inside the frame, or null while the frame is being replaced. */
async function frameTime(h: Harness): Promise<number | null> {
  const t = await Promise.race([
    sleep(300).then(() => null),
    h.inFrame<number>('window.__player ? window.__player.getTime() : -1').catch(() => null),
  ]);
  return typeof t === 'number' ? t : null;
}

/** Waits until the swatch is (not) magenta, and, with `atSec`, the frame's playhead is there. */
async function waitSwatch(
  h: Harness,
  wantMagenta: boolean,
  t0: number,
  limit = 5000,
  atSec?: number,
) {
  for (;;) {
    const got = await swatch(h);
    const isMagenta = colorDist(got, MAGENTA) <= COLOR_TOL;
    const ms = now() - t0;
    const atOk =
      atSec === undefined || isMagenta !== wantMagenta
        ? true
        : Math.abs(((await frameTime(h)) ?? -1) - atSec) < 0.001;
    if (isMagenta === wantMagenta && atOk) return { ms: Math.round(ms), got };
    if (ms > limit) return { ms: null, got };
  }
}

function trimmed(on: boolean): Sequence {
  const seq = makeMainSequence();
  if (on) {
    const s1 = seq.items.find((i) => i.id === 's1')!;
    s1.durF = 60; // trimItem s1: 600-690 → 600-660
  }
  return seq;
}

const AT = 675;

async function reload(h: Harness) {
  const media = await h.media();
  await h.page(`voxPage.player.clearRuntimeData('vox-patch')`);
  const runs: {
    trimmed: boolean;
    ms: number | null;
    compileMs: number;
    readyMs: number;
    got: number[];
  }[] = [];
  for (let i = 0; i < 6; i++) {
    const on = i % 2 === 0;
    const t0 = now();
    const b = compile(trimmed(on), 'preview', media);
    h.overrides.set('/index.html', b.files.get('index.html')!);
    h.overrides.set('/sequence.json', b.files.get('sequence.json') ?? '{}');
    const compileMs = now() - t0;
    const n0 = await h.page<number>('voxPage.events.length');
    // the saved playhead travels with the reload (vox-preview.js seeks once the scenes are mounted)
    await h.page(
      `voxPage.player.setRuntimeData('vox-playhead', ${frameToSec(AT, trimmed(on).fps)})`,
    );
    await h.page(`voxPage.player.setAttribute('src', 'vox-media://build/index.html?r=${i + 1}')`);
    await h.page(`voxPage.waitFor('ready', ${n0}, 20000)`);
    const readyMs = now() - t0;
    const w = await waitSwatch(h, !on, t0, 5000, frameToSec(AT, trimmed(on).fps));
    runs.push({
      trimmed: on,
      ms: w.ms,
      compileMs: Math.round(compileMs),
      readyMs: Math.round(readyMs),
      got: w.got,
    });
  }
  const ms = runs.map((r) => r.ms ?? Infinity);
  return {
    pass: Math.max(...ms) < 1000,
    latencyMs: stats(ms.filter(Number.isFinite)),
    failed: ms.filter((x) => !Number.isFinite(x)).length,
    runs,
  };
}

function sceneHtml(indexHtml: string, id: string): string {
  const m = new RegExp(`<template id="${id}-template">([\\s\\S]*?)</template>`).exec(indexHtml);
  if (!m) throw new Error(`no template for ${id}`);
  return m[1]!;
}

async function patch(h: Harness) {
  const media = await h.media();
  // start from the untrimmed build
  h.overrides.clear();
  await h.page(`voxPage.player.clearRuntimeData('vox-patch')`);
  const n0 = await h.page<number>('voxPage.events.length');
  await h.page(`voxPage.player.setAttribute('src', 'vox-media://build/index.html?r=100')`);
  await h.page(`voxPage.waitFor('ready', ${n0}, 20000)`);
  await h.page(`voxPage.seek(${frameToSec(AT, trimmed(false).fps)})`);
  const base = await waitSwatch(h, true, now());
  const runs: {
    trimmed: boolean;
    ms: number | null;
    compileMs: number;
    got: number[];
    before645: number[] | null;
  }[] = [];
  for (let i = 0; i < 6; i++) {
    const on = i % 2 === 0;
    const t0 = now();
    const seq = trimmed(on);
    const b = compile(seq, 'preview', media);
    const s1 = seq.items.find((x) => x.id === 's1')!;
    const payload = {
      id: 's1',
      start: frameToSec(s1.startF, seq.fps),
      duration: frameToSec(s1.durF, seq.fps),
      html: sceneHtml(b.files.get('index.html')!, 's1'),
    };
    const compileMs = now() - t0;
    await h.page(`voxPage.player.setRuntimeData('vox-patch', ${JSON.stringify(payload)})`);
    const w = await waitSwatch(h, !on, t0);
    // the patched scene itself still plays inside its new range
    await h.page(`voxPage.seek(${frameToSec(645, seq.fps)})`);
    await sleep(300);
    const before645 = await swatch(h);
    await h.page(`voxPage.seek(${frameToSec(AT, seq.fps)})`);
    await sleep(300);
    runs.push({ trimmed: on, ms: w.ms, compileMs: Math.round(compileMs), got: w.got, before645 });
  }
  const ms = runs.map((r) => r.ms ?? Infinity);
  const inRangeOk = runs.every(
    (r) => r.before645 !== null && colorDist(r.before645, MAGENTA) <= COLOR_TOL,
  );
  const tlKeys = await h.inFrame<string[]>('Object.keys(window.__timelines)');
  return {
    pass: Math.max(...ms) < 1000 && inRangeOk && base.ms !== null,
    baseline: base,
    latencyMs: stats(ms.filter(Number.isFinite)),
    failed: ms.filter((x) => !Number.isFinite(x)).length,
    patchedSceneStillVisibleAt645: inRangeOk,
    timelines: tlKeys.length,
    runs,
  };
}

export async function runTests(h: Harness, names: string[]): Promise<Record<string, unknown>> {
  const seq = makeMainSequence();
  const out: Record<string, unknown> = {};
  for (const n of names) {
    const t0 = now();
    if (n === 'play') out.play = await play(h, seq);
    else if (n === 'seek') out.seek = await seeks(h, seq, 0.5);
    else if (n === 'seekedge') out.seekedge = await seeks(h, seq, 0);
    else if (n === 'avseek') out.avseek = await avSeek(h, seq);
    else if (n === 'mech') out.mech = await mech(h, seq);
    else if (n === 'reload') out.reload = await reload(h);
    else if (n === 'patch') out.patch = await patch(h);
    else throw new Error(`unknown test ${n}`);
    out[`${n}WallMs`] = Math.round(now() - t0);
    await settle();
  }
  return out;
}
