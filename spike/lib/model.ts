/**
 * The spike sequences, written by hand as data (no engine yet). Frames are integers on the sequence
 * grid; compile turns them into HyperFrames seconds. Layout (main, 30 fps, 2700 frames):
 *
 *   V1: spike cuts 0-600 | title 600-690 | spike cuts 690-960 | title 960-1020 | spike cuts 1020-1200 |
 *       stack 1200-1350 | phone (VFR via CFR copy) cuts 1350-1650 | video-slot 1650-1800 |
 *       image push-in 1800-1860 | spike cuts 1860-2400 (one crossfade) | title 2400-2490 |
 *       stat 2490-2580 | spike 2580-2700 (audio fade)
 *   V2: lower-third 300-390, lower-third 2000-2090
 *   A1: one audio clip linked to every video clip; captions over everything.
 */
import { FPS30, NTSC, type Fps } from './frames.ts';

export type Src = 'spike' | 'phone' | 'ntsc' | 'face';
export type Track = 'V1' | 'V2' | 'A1';
export type Template = 'title' | 'lower-third' | 'stat' | 'stack' | 'video-slot' | 'panel';
export type StyleId = 'base' | 'vox';

interface Timed {
  id: string;
  track: Track;
  startF: number;
  durF: number;
}
export interface VideoItem extends Timed {
  kind: 'video';
  src: 'spike' | 'phone' | 'ntsc';
  inF: number;
  /** Crossfade: the clip fades in over its first `fadeInF` frames above the previous clip. */
  fadeInF?: number;
}
export interface ImageItem extends Timed {
  kind: 'image';
  src: 'face';
  motion: 'push-in';
}
export interface PanelSpec {
  id: string;
  style: StyleId;
  vars: SceneVars;
}
export interface SceneVars {
  [key: string]: unknown;
  title: string;
  swatch: string;
}
export interface SceneItem extends Timed {
  kind: 'scene';
  template: Template;
  style: StyleId;
  vars: SceneVars;
  panels?: PanelSpec[];
  /** video-slot only: the spike source frame shown at the scene's first frame. */
  slotInF?: number;
}
export interface AudioItem extends Timed {
  kind: 'audio';
  src: 'spike' | 'phone' | 'ntsc';
  inF: number;
  linkedTo: string;
  /** GSAP volume tween, sequence frames. */
  fade?: { fromF: number; toF: number; from: number; to: number };
}
export type Item = VideoItem | ImageItem | SceneItem | AudioItem;

export interface Sequence {
  name: string;
  fps: Fps;
  width: number;
  height: number;
  durF: number;
  items: Item[];
}

/** Where the landscape sources sit on the 9:16 canvas (scale 0.5, so barcode cells are 20 px). */
export const LANDSCAPE_BOX = { x: 60, y: 690, w: 960, h: 540 } as const;

/** Barcode crop (x, y, w, h) on the rendered canvas, per source. */
export const COUNTER_CROP: Record<
  'spike' | 'phone' | 'ntsc',
  readonly [number, number, number, number]
> = {
  spike: [LANDSCAPE_BOX.x + 20, LANDSCAPE_BOX.y + 20, 320, 20],
  ntsc: [LANDSCAPE_BOX.x + 20, LANDSCAPE_BOX.y + 20, 320, 20],
  phone: [40, 40, 640, 40],
};
/** Flash box (x, y, w, h) on the canvas for the landscape sources (source box 1720,880,160,160). */
export const FLASH_CROP = [LANDSCAPE_BOX.x + 870, LANDSCAPE_BOX.y + 450, 60, 60] as const;

/** Swatch (per-instance var) and token (scoped `--tok-accent`) probes, scene-root coordinates. */
export const SWATCH_AT = { x: 60, y: 1720, size: 100 } as const;
export const TOKEN_AT = { x: 180, y: 1720, size: 100 } as const;
export const PANEL_BOXES = [
  { y: 80, h: 760 },
  { y: 860, h: 760 },
] as const;
export const PANEL_SWATCH_AT = { x: 60, y: 600, size: 100 } as const;
export const PANEL_TOKEN_AT = { x: 180, y: 600, size: 100 } as const;

export const STYLE_TOKENS: Record<StyleId, Record<string, string>> = {
  base: { accent: '#2f6fed', bg: '#101418', fg: '#ffffff' },
  vox: { accent: '#e8442e', bg: '#f3ead8', fg: '#1b1b1b' },
};

/** Small deterministic PRNG (LCG), so the fixture is the same on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const SWATCHES = [
  '#ff00ff',
  '#00ffff',
  '#ffff00',
  '#00ff00',
  '#ff8000',
  '#8000ff',
  '#0080ff',
  '#ff0080',
  '#80ff00',
  '#ff4040',
];

interface Builder {
  items: Item[];
  n: number;
}

function addVideo(
  b: Builder,
  src: VideoItem['src'],
  startF: number,
  durF: number,
  inF: number,
  fadeInF?: number,
): VideoItem {
  const id = `c${++b.n}`;
  const v: VideoItem = { kind: 'video', id, track: 'V1', startF, durF, src, inF };
  if (fadeInF) v.fadeInF = fadeInF;
  b.items.push(v, {
    kind: 'audio',
    id: `a${b.n}`,
    track: 'A1',
    startF,
    durF,
    src,
    inF,
    linkedTo: id,
  });
  return v;
}

/** Cuts of one source filling [from, to) with random lengths 20..50 frames. */
function run(
  b: Builder,
  rnd: () => number,
  src: VideoItem['src'],
  srcLen: number,
  from: number,
  to: number,
  minLen = 20,
  maxLen = 50,
): VideoItem[] {
  const out: VideoItem[] = [];
  let f = from;
  while (f < to) {
    let len = minLen + Math.floor(rnd() * (maxLen - minLen + 1));
    if (to - (f + len) < minLen) len = to - f;
    const inF = Math.floor(rnd() * (srcLen - len));
    out.push(addVideo(b, src, f, len, inF));
    f += len;
  }
  return out;
}

function scene(
  b: Builder,
  template: Template,
  style: StyleId,
  track: Track,
  startF: number,
  durF: number,
  title: string,
): SceneItem {
  const i = b.items.filter((x) => x.kind === 'scene').length;
  const s: SceneItem = {
    kind: 'scene',
    id: `s${i + 1}`,
    track,
    startF,
    durF,
    template,
    style,
    vars: { title, swatch: SWATCHES[i % SWATCHES.length]! },
  };
  b.items.push(s);
  return s;
}

export function makeMainSequence(): Sequence {
  const rnd = lcg(20261011);
  const b: Builder = { items: [], n: 0 };
  run(b, rnd, 'spike', 2700, 0, 600);
  scene(b, 'title', 'base', 'V1', 600, 90, 'First title');
  run(b, rnd, 'spike', 2700, 690, 960);
  scene(b, 'title', 'vox', 'V1', 960, 60, 'Second title');
  run(b, rnd, 'spike', 2700, 1020, 1200);
  const stack = scene(b, 'stack', 'vox', 'V1', 1200, 150, 'Stack');
  stack.panels = [
    { id: `${stack.id}-p1`, style: 'base', vars: { title: 'Panel one', swatch: '#40ff40' } },
    { id: `${stack.id}-p2`, style: 'vox', vars: { title: 'Panel two', swatch: '#4040ff' } },
  ];
  run(b, rnd, 'phone', 600, 1350, 1650, 50, 70);
  const slot = scene(b, 'video-slot', 'base', 'V1', 1650, 150, 'Video slot');
  slot.slotInF = 900;
  b.items.push({
    kind: 'image',
    id: 'i1',
    track: 'V1',
    startF: 1800,
    durF: 60,
    src: 'face',
    motion: 'push-in',
  });
  const r3 = run(b, rnd, 'spike', 2700, 1860, 2400);
  // One crossfade in the middle of run 3: the next clip starts 7 frames early (fades in over 15),
  // the clip before it runs 8 frames longer (handles).
  const k = Math.floor(r3.length / 2);
  const a = r3[k]!;
  const bClip = r3[k + 1]!;
  const cut = bClip.startF;
  a.durF += 8;
  bClip.startF = cut - 7;
  bClip.durF += 7;
  bClip.inF = Math.max(0, bClip.inF - 7);
  bClip.fadeInF = 15;
  for (const it of b.items) {
    if (it.kind !== 'audio') continue;
    const v = it.linkedTo === a.id ? a : it.linkedTo === bClip.id ? bClip : null;
    if (v) Object.assign(it, { startF: v.startF, durF: v.durF, inF: v.inF });
  }
  scene(b, 'title', 'base', 'V1', 2400, 90, 'Third title');
  scene(b, 'stat', 'vox', 'V1', 2490, 90, '1,234');
  const last = addVideo(b, 'spike', 2580, 120, 600);
  const lastAudio = b.items.find((i) => i.kind === 'audio' && i.linkedTo === last.id) as AudioItem;
  lastAudio.fade = { fromF: 2600, toF: 2660, from: 1, to: 0.1 };
  scene(b, 'lower-third', 'vox', 'V2', 300, 90, 'Lower third one');
  scene(b, 'lower-third', 'base', 'V2', 2000, 90, 'Lower third two');
  return { name: 'spike-90s', fps: FPS30, width: 1080, height: 1920, durF: 2700, items: b.items };
}

/** NTSC variant (item 9): 18 s of 30000/1001 cuts of the 29.97 source, linked audio. */
export function makeNtscSequence(): Sequence {
  const rnd = lcg(30000);
  const b: Builder = { items: [], n: 0 };
  run(b, rnd, 'ntsc', 599, 0, 480, 30, 60);
  addVideo(b, 'ntsc', 480, 60, 120);
  return { name: 'spike-ntsc', fps: NTSC, width: 1080, height: 1920, durF: 540, items: b.items };
}

const on = (i: Item, f: number) => f >= i.startF && f < i.startF + i.durF;

/**
 * The counter that must be visible at sequence frame `f`: source and source frame, or null when
 * no counter-bearing video is on top (scenes, image, crossfade overlap).
 */
export function expectedAt(
  seq: Sequence,
  f: number,
): { src: VideoItem['src']; frame: number; itemId: string } | null {
  const v1 = seq.items.filter((i) => i.track === 'V1' && on(i, f));
  if (v1.length !== 1) return null;
  const it = v1[0]!;
  if (it.kind === 'video') return { src: it.src, frame: it.inF + (f - it.startF), itemId: it.id };
  if (it.kind === 'scene' && it.template === 'video-slot' && it.slotInF !== undefined)
    return { src: 'spike', frame: it.slotInF + (f - it.startF), itemId: it.id };
  return null;
}

/** Frames where V1 switches from one counter-bearing clip to another (hard cuts only). */
export function cutFrames(seq: Sequence): number[] {
  const out: number[] = [];
  for (let f = 1; f < seq.durF; f++) {
    const a = expectedAt(seq, f - 1);
    const b = expectedAt(seq, f);
    if (a && b && a.itemId !== b.itemId) out.push(f);
  }
  return out;
}
