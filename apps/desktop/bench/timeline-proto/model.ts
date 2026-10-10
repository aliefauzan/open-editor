// GATE 4 prototype model (phase 08 step A1–A2, D-19 early package U1).
// Pure data and ops for the timeline benchmark: 1,000 items on 8 tracks, V1/A1 linked pairs.
// Times are integer ms on a 30/1 frame grid (R3); the library works in seconds.

export const BENCH_TRACKS = ['V4', 'V3', 'V2', 'V1', 'A1', 'A2', 'A3', 'A4'] as const;
export type TrackId = (typeof BENCH_TRACKS)[number];

/** Sequence frame rate for the benchmark (rational, R3). */
export const BENCH_FPS = { num: 30, den: 1 } as const;

/**
 * Library geometry. 30 px per second and 30 grid cells per second make one frame one pixel,
 * so the library's grid snap and the frame grid agree. 25 items (60 s) fit in a 1920 px view.
 */
export const BENCH_GEOMETRY = {
  scale: 1,
  scaleWidth: 30,
  scaleSplitCount: 30,
  startLeft: 20,
  rowHeight: 40,
} as const;
export type Geometry = { scale: number; scaleWidth: number; startLeft: number; rowHeight: number };

export interface BenchItem {
  id: string;
  track: TrackId;
  startMs: number;
  durationMs: number;
  /** V1 item i and A1 item i share a link id; every other item is unlinked. */
  linkId: string | null;
}

export interface BenchModel {
  items: Readonly<Record<string, BenchItem>>;
  order: Readonly<Record<TrackId, readonly string[]>>;
}

/** Structural copy of the library's TimelineRow / TimelineAction (only the fields we set). */
export interface EditorAction {
  id: string;
  start: number;
  end: number;
  effectId: string;
  selected: boolean;
}
export interface EditorRow {
  id: string;
  actions: EditorAction[];
}

const msFromFrame = (f: number) => Math.round((f * 1000 * BENCH_FPS.den) / BENCH_FPS.num);
const frameFromSeconds = (sec: number) => Math.round((sec * BENCH_FPS.num) / BENCH_FPS.den);
const frameFromMs = (ms: number) => frameFromSeconds(ms / 1000);

/** Library seconds → integer ms on the frame grid, never negative. */
export function snapSecondsToMs(sec: number): number {
  return msFromFrame(Math.max(0, frameFromSeconds(sec)));
}

export interface BenchDataOptions {
  itemsPerTrack?: number;
  offsetFrames?: number;
  durationFrames?: number;
  gapFrames?: number;
}

/** 8 tracks × 125 items: start 1 s, 2 s clips, 0.4 s gaps (all on the 30 fps grid). */
export function makeBenchData(opts: BenchDataOptions = {}): BenchModel {
  const { itemsPerTrack = 125, offsetFrames = 30, durationFrames = 60, gapFrames = 12 } = opts;
  const items: Record<string, BenchItem> = {};
  const order = {} as Record<TrackId, string[]>;
  for (const track of BENCH_TRACKS) {
    order[track] = [];
    for (let i = 0; i < itemsPerTrack; i++) {
      const id = `it_${track}_${i}`;
      const startFrame = offsetFrames + i * (durationFrames + gapFrames);
      items[id] = {
        id,
        track,
        startMs: msFromFrame(startFrame),
        durationMs: msFromFrame(startFrame + durationFrames) - msFromFrame(startFrame),
        linkId: track === 'V1' || track === 'A1' ? `lk_${i}` : null,
      };
      order[track].push(id);
    }
  }
  return { items, order };
}

/** Ids of the item and every item linked to it. */
function withPartners(model: BenchModel, id: string): string[] {
  const item = model.items[id];
  if (!item) throw new Error(`unknown item ${id}`);
  if (item.linkId === null) return [id];
  // V1/A1 pairs sit at the same index on their tracks.
  const index = model.order[item.track].indexOf(id);
  const other: TrackId = item.track === 'V1' ? 'A1' : 'V1';
  const partner = model.order[other][index];
  return partner && model.items[partner]?.linkId === item.linkId ? [id, partner] : [id];
}

function patch(model: BenchModel, ids: string[], next: (item: BenchItem) => BenchItem): BenchModel {
  let changed = false;
  const items = { ...model.items };
  for (const id of ids) {
    const before = items[id]!;
    const after = next(before);
    if (after.startMs !== before.startMs || after.durationMs !== before.durationMs) {
      items[id] = after;
      changed = true;
    }
  }
  return changed ? { items, order: model.order } : model;
}

/**
 * Move a clip to `startSec` (snapped to the frame grid); linked partners move by the same number of
 * frames, so a pair that starts together still starts together.
 */
export function moveItem(model: BenchModel, id: string, startSec: number): BenchModel {
  const item = model.items[id];
  if (!item) throw new Error(`unknown item ${id}`);
  const dF = Math.max(0, frameFromSeconds(startSec)) - frameFromMs(item.startMs);
  return patch(model, withPartners(model, id), (it) => ({
    ...it,
    startMs: msFromFrame(Math.max(0, frameFromMs(it.startMs) + dF)),
  }));
}

/**
 * Set a clip's range (frame grid, at least one frame long); each partner edge moves by the same
 * number of frames as the clip's edge.
 */
export function trimItem(
  model: BenchModel,
  id: string,
  startSec: number,
  endSec: number,
): BenchModel {
  const item = model.items[id];
  if (!item) throw new Error(`unknown item ${id}`);
  const s = Math.max(0, frameFromSeconds(startSec));
  const e = Math.max(frameFromSeconds(endSec), s + 1);
  const dS = s - frameFromMs(item.startMs);
  const dE = e - frameFromMs(item.startMs + item.durationMs);
  return patch(model, withPartners(model, id), (it) => {
    const ps = Math.max(0, frameFromMs(it.startMs) + dS);
    const pe = Math.max(frameFromMs(it.startMs + it.durationMs) + dE, ps + 1);
    return { ...it, startMs: msFromFrame(ps), durationMs: msFromFrame(pe) - msFromFrame(ps) };
  });
}

/** Library rows, one per track in BENCH_TRACKS order. */
export function toEditorData(model: BenchModel, selected: ReadonlySet<string>): EditorRow[] {
  return BENCH_TRACKS.map((track) => ({
    id: track,
    actions: model.order[track].map((id) => {
      const item = model.items[id]!;
      return {
        id,
        start: item.startMs / 1000,
        end: (item.startMs + item.durationMs) / 1000,
        effectId: 'clip',
        selected: selected.has(id),
      };
    }),
  }));
}

export interface PartnerPreview {
  id: string;
  /** Pixel offsets of the partner's left and right edges from where the store has them. */
  dStartPx: number;
  dEndPx: number;
}

/**
 * While the library drags or trims a linked clip, its partners follow on screen through these
 * offsets (applied to our own getActionRender node); the store changes only at the drop.
 */
export function partnerPreview(
  model: BenchModel,
  id: string,
  startSec: number,
  endSec: number,
  pxPerSec: number,
): PartnerPreview[] {
  const item = model.items[id];
  if (!item) throw new Error(`unknown item ${id}`);
  const dStartPx = (startSec - item.startMs / 1000) * pxPerSec;
  const dEndPx = (endSec - (item.startMs + item.durationMs) / 1000) * pxPerSec;
  return withPartners(model, id)
    .filter((p) => p !== id)
    .map((p) => ({
      id: p,
      dStartPx: Math.round(dStartPx * 1000) / 1000,
      dEndPx: Math.round(dEndPx * 1000) / 1000,
    }));
}
