// Timeline model (app spec "Timeline"; GATE 4 / D-35: `@xzdarcy/react-timeline-editor` through its
// public props only): sequence → library rows, snapping (playhead, clip edges, transcript word
// boundaries, frame grid), marquee hit-testing and drop → op mapping. Pure functions; times in the
// library are seconds, in the model integer milliseconds.
import type { CaptionChunk, Item, MediaItem, Sequence } from '../../shared/project.ts';
import { allItems } from './entities.ts';
import type { OpCall } from './optimistic.ts';
import { snapMs } from './time.ts';

export const CAPTION_ROW = 'captions';
export const ROW_HEIGHT = 48;
export const CAPTION_ROW_HEIGHT = 34;

export interface Row {
  id: string;
  kind: 'video' | 'audio' | 'captions';
  rowHeight: number;
  actions: Action[];
}

export interface Action {
  id: string;
  start: number;
  end: number;
  effectId: 'media' | 'scene' | 'audio' | 'caption';
  movable: boolean;
  flexible: boolean;
  selected: boolean;
  minStart?: number;
  maxEnd?: number;
}

const sec = (ms: number) => ms / 1000;
const endOf = (i: Item) => i.startMs + i.durationMs;

/**
 * Rows top to bottom: the top video track first (Vn … V1, so V1 sits right above the caption lane),
 * the caption lane, then A1 … An. Locked tracks cannot move or trim.
 */
export function toRows(
  s: Sequence,
  media: readonly MediaItem[],
  selection: ReadonlySet<string>,
  captions: readonly CaptionChunk[],
): Row[] {
  const byId = new Map(media.map((m) => [m.id, m]));
  const rowOf = (kind: 'video' | 'audio', t: Sequence['videoTracks'][number]): Row => ({
    id: t.id,
    kind,
    rowHeight: ROW_HEIGHT,
    actions: t.items.map((i) => {
      const m = i.type === 'media' ? byId.get(i.mediaId) : undefined;
      // a media clip cannot start before its source or run past its end
      const limits =
        i.type === 'media' && m?.durationMs !== undefined && m.kind !== 'image'
          ? {
              minStart: sec(Math.max(0, i.startMs - i.inMs)),
              maxEnd: sec(i.startMs - i.inMs + m.durationMs),
            }
          : {};
      return {
        id: i.id,
        start: sec(i.startMs),
        end: sec(endOf(i)),
        effectId: i.type === 'scene' ? 'scene' : kind === 'audio' ? 'audio' : 'media',
        movable: !t.locked,
        flexible: !t.locked,
        selected: selection.has(i.id),
        ...limits,
      };
    }),
  });
  return [
    ...[...s.videoTracks].reverse().map((t) => rowOf('video', t)),
    {
      id: CAPTION_ROW,
      kind: 'captions',
      rowHeight: CAPTION_ROW_HEIGHT,
      actions: captions.map((c, i) => ({
        id: `cap_${i}`,
        start: sec(c.startMs),
        end: sec(c.endMs),
        effectId: 'caption',
        movable: false,
        flexible: false,
        selected: false,
      })),
    },
    ...s.audioTracks.map((t) => rowOf('audio', t)),
  ];
}

/** Snap targets: playhead, other clips' edges, transcript word boundaries. */
export function snapTargets(
  s: Sequence,
  o: { playheadMs: number; exclude: ReadonlySet<string>; captions: readonly CaptionChunk[] },
): number[] {
  const out = [0, o.playheadMs];
  for (const { item } of allItems(s)) {
    if (o.exclude.has(item.id)) continue;
    out.push(item.startMs, endOf(item));
  }
  for (const c of o.captions)
    for (const line of c.lines) for (const w of line.words) out.push(w.startMs, w.endMs);
  return out;
}

/** The nearest target within `thresholdMs`, else the nearest frame; always on the frame grid. */
export function snapTime(
  ms: number,
  targets: readonly number[],
  thresholdMs: number,
  fps: Sequence['canvas']['fps'],
): number {
  let best = ms;
  let dist = thresholdMs + 1;
  for (const t of targets) {
    const d = Math.abs(t - ms);
    if (d < dist) {
      dist = d;
      best = t;
    }
  }
  return Math.max(0, snapMs(dist <= thresholdMs ? best : ms, fps));
}

/** Snaps a moved clip by whichever edge lands closer to a target. Returns the new start. */
export function snapMove(
  startMs: number,
  durationMs: number,
  targets: readonly number[],
  thresholdMs: number,
  fps: Sequence['canvas']['fps'],
): number {
  const a = snapTime(startMs, targets, thresholdMs, fps);
  const b = snapTime(startMs + durationMs, targets, thresholdMs, fps) - durationMs;
  const da = Math.abs(a - startMs);
  const db = Math.abs(b - startMs);
  return Math.max(0, db < da ? snapMs(b, fps) : a);
}

/**
 * Drop of a dragged clip at `startMs`: one op, never one per mouse move. With several items selected,
 * every selected item moves by the same delta in one `batch` (one per linked group; partners follow).
 */
export function moveDropOp(
  s: Sequence,
  itemId: string,
  startMs: number,
  selection: readonly string[],
): OpCall | null {
  const all = allItems(s);
  const self = all.find((x) => x.item.id === itemId)?.item;
  if (!self || startMs === self.startMs) return null;
  const delta = startMs - self.startMs;
  const group = selection.includes(itemId) ? selection : [itemId];
  const seen = new Set<string>();
  const moves = all
    .filter(({ item }) => group.includes(item.id))
    .filter(({ item }) => {
      if (!item.linkId) return true;
      if (seen.has(item.linkId)) return false;
      seen.add(item.linkId);
      return true;
    })
    // moving right: the last item first, so no item lands on one that has not moved yet
    .sort((a, b) => (delta > 0 ? b.item.startMs - a.item.startMs : a.item.startMs - b.item.startMs))
    .map(({ item }) => ({
      op: 'moveItem',
      args: { sequenceId: s.id, itemId: item.id, startMs: Math.max(0, item.startMs + delta) },
    }));
  if (moves.length === 1) return moves[0]!;
  return { op: 'batch', args: { ops: moves } };
}

/** Drop of a trim handle: `trimItem` on the edge that moved. */
export function trimDropOp(
  s: Sequence,
  item: Item,
  startMs: number,
  endMs: number,
  dir: 'left' | 'right',
): OpCall | null {
  if (dir === 'left' && startMs !== item.startMs)
    return {
      op: 'trimItem',
      args: { sequenceId: s.id, itemId: item.id, edge: 'start', toMs: startMs },
    };
  if (dir === 'right' && endMs !== endOf(item))
    return {
      op: 'trimItem',
      args: { sequenceId: s.id, itemId: item.id, edge: 'end', toMs: endMs },
    };
  return null;
}

export interface Geometry {
  pxPerSec: number;
  startLeft: number;
  rows: readonly Pick<Row, 'rowHeight' | 'actions' | 'id'>[];
}

/** Items whose box intersects a marquee rectangle in edit-area content pixels. */
export function itemsInRect(
  g: Geometry,
  r: { x0: number; y0: number; x1: number; y1: number },
): string[] {
  const x0 = Math.min(r.x0, r.x1);
  const x1 = Math.max(r.x0, r.x1);
  const y0 = Math.min(r.y0, r.y1);
  const y1 = Math.max(r.y0, r.y1);
  const t0 = (x0 - g.startLeft) / g.pxPerSec;
  const t1 = (x1 - g.startLeft) / g.pxPerSec;
  const out: string[] = [];
  let top = 0;
  for (const row of g.rows) {
    const bottom = top + row.rowHeight;
    if (row.id !== CAPTION_ROW && bottom > y0 && top < y1) {
      for (const a of row.actions) if (a.end > t0 && a.start < t1) out.push(a.id);
    }
    top = bottom;
  }
  return out;
}
