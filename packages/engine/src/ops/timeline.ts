// Timeline primitives shared by the item ops: trim, split, cut (ripple), clear (overwrite), insert.
// All times are on the sequence grid already; inMs is re-snapped to the source grid.
import type { Item, Project, Sequence, Track } from '../model/schema.ts';
import {
  endOf,
  fail,
  frameOf,
  LinkRemap,
  overlapError,
  shiftT,
  snapDown,
  snapIn,
  sortItems,
  sourceFps,
  tracksOf,
  type OpContext,
} from './core.ts';

/** Keep a re-snapped inMs inside the media when source-grid rounding pushed it over by < 1 frame. */
export function fitIn(p: Project, s: Sequence, it: Item): void {
  if (it.type !== 'media') return;
  const media = p.media.find((m) => m.id === it.mediaId);
  if (!media?.durationMs || media.kind === 'image') return;
  const fps = sourceFps(p, s, it);
  const over = it.inMs + it.durationMs - media.durationMs;
  if (over > 0 && over <= Math.ceil((1000 * fps.den) / fps.num)) {
    const pulled = snapDown(media.durationMs - it.durationMs, fps);
    if (pulled >= 0) it.inMs = pulled;
  }
}

/** Shift an item by whole frames (start and end each stay on the grid). */
export function shiftItem(p: Project, s: Sequence, it: Item, frames: number): void {
  if (frames === 0) return;
  const start = shiftT(s, it.startMs, frames);
  const end = shiftT(s, endOf(it), frames);
  it.startMs = start;
  it.durationMs = end - start;
  fitIn(p, s, it);
}

/** Move an item's start edge by `delta` ms (positive = later), keeping its end. */
export function trimStartBy(p: Project, s: Sequence, it: Item, delta: number): void {
  it.startMs += delta;
  it.durationMs -= delta;
  if (it.type === 'media') {
    const media = p.media.find((m) => m.id === it.mediaId);
    if (media?.kind !== 'image') {
      const next = it.inMs + delta;
      if (next < 0) {
        fail(
          'MEDIA_BOUNDS',
          `Item ${it.id} would start before its media`,
          'Trim less, the source has no earlier frames',
          {
            itemId: it.id,
          },
        );
      }
      it.inMs = snapIn(p, s, it, next);
      fitIn(p, s, it);
    }
    if (it.frame?.keyframes) {
      for (const k of it.frame.keyframes) k.atMs -= delta;
    }
  }
}

/** Split `it` at timeline time `at` (strictly inside). `it` becomes the left part; returns the right part. */
export function splitAt(p: Project, s: Sequence, it: Item, at: number, newItemId: string): Item {
  const right = structuredClone(it);
  const offset = at - it.startMs;
  right.id = newItemId;
  right.startMs = at;
  right.durationMs = endOf(it) - at;
  it.durationMs = offset;
  delete right.transitionIn;
  if (it.type === 'media' && right.type === 'media') {
    delete it.fadeOutMs;
    delete right.fadeInMs;
    right.inMs = snapIn(p, s, right, it.inMs + offset);
    fitIn(p, s, right);
    if (right.frame?.keyframes) for (const k of right.frame.keyframes) k.atMs -= offset;
  }
  return right;
}

/** Ripple cut of [a, b) on one track: remove, trim or split, then close the gap. */
export function cutRange(
  p: Project,
  s: Sequence,
  track: Track,
  a: number,
  b: number,
  remap: LinkRemap,
  ctx: OpContext,
): void {
  const dF = frameOf(s, b) - frameOf(s, a);
  const out: Item[] = [];
  for (const it of track.items) {
    const st = it.startMs;
    const en = endOf(it);
    const shiftedEnd = shiftT(s, en, -dF);
    if (en <= a) out.push(it);
    else if (st >= b) {
      shiftItem(p, s, it, -dF);
      out.push(it);
    } else if (st >= a && en <= b) {
      // fully inside: removed
    } else if (st < a && en > b) {
      if (it.type === 'scene') {
        it.durationMs = shiftedEnd - st;
        out.push(it);
      } else {
        const right = splitAt(p, s, it, b, ctx.newId('it_'));
        it.durationMs = a - st;
        right.startMs = a;
        right.durationMs = shiftedEnd - a;
        fitIn(p, s, right);
        if (it.linkId) right.linkId = remap.get(it.linkId);
        out.push(it, right);
      }
    } else if (st < a) {
      it.durationMs = a - st;
      out.push(it);
    } else {
      trimStartBy(p, s, it, b - st);
      it.startMs = a;
      it.durationMs = shiftedEnd - a;
      fitIn(p, s, it);
      out.push(it);
    }
  }
  track.items = out;
  sortItems(track);
}

/** Overwrite: clear [a, b) on one track without shifting; linked items elsewhere are left alone. */
export function clearRange(
  p: Project,
  s: Sequence,
  track: Track,
  a: number,
  b: number,
  ctx: OpContext,
): void {
  const out: Item[] = [];
  for (const it of track.items) {
    const st = it.startMs;
    const en = endOf(it);
    if (en <= a || st >= b) out.push(it);
    else if (st >= a && en <= b) {
      // covered: removed
    } else if (st < a && en > b) {
      const right = splitAt(p, s, it, b, ctx.newId('it_'));
      it.durationMs = a - st;
      delete right.linkId;
      out.push(it, right);
    } else if (st < a) {
      it.durationMs = a - st;
      out.push(it);
    } else {
      trimStartBy(p, s, it, b - st);
      out.push(it);
    }
  }
  track.items = out;
  sortItems(track);
}

/** Insert: split items spanning `at` on `tracks`, then shift every item at or after `at` by `frames`. */
export function insertGap(
  p: Project,
  s: Sequence,
  tracks: Track[],
  at: number,
  frames: number,
  remap: LinkRemap,
  ctx: OpContext,
): void {
  for (const track of tracks) {
    const out: Item[] = [];
    for (const it of track.items) {
      if (it.startMs < at && endOf(it) > at) {
        const right = splitAt(p, s, it, at, ctx.newId('it_'));
        if (it.linkId) right.linkId = remap.get(it.linkId);
        out.push(it, right);
      } else out.push(it);
    }
    for (const it of out) if (it.startMs >= at) shiftItem(p, s, it, frames);
    track.items = out;
    sortItems(track);
  }
}

export type OnOverlap = 'error' | 'overwrite' | 'insert';

export interface Placement {
  track: Track;
  item: Item;
}

/** Put new (or moved, already removed) items on their tracks under an onOverlap mode. */
export function placeItems(
  p: Project,
  s: Sequence,
  placements: Placement[],
  mode: OnOverlap,
  ctx: OpContext,
  remap: LinkRemap = new LinkRemap(ctx),
): void {
  if (placements.length === 0) return;
  if (mode === 'insert') {
    const at = Math.min(...placements.map((x) => x.item.startMs));
    const frames = frameOf(s, Math.max(...placements.map((x) => endOf(x.item)))) - frameOf(s, at);
    const targets = new Set<Track>(placements.map((x) => x.track));
    for (const t of tracksOf(s)) if (t.syncLock) targets.add(t);
    insertGap(p, s, [...targets], at, frames, remap, ctx);
  } else if (mode === 'overwrite') {
    for (const { track, item } of placements)
      clearRange(p, s, track, item.startMs, endOf(item), ctx);
  }
  for (const { track, item } of placements) {
    const hit = track.items.find((o) => o.startMs < endOf(item) && endOf(o) > item.startMs);
    if (hit) overlapError(track, hit, item);
    track.items.push(item);
    sortItems(track);
  }
  remap.finish(s);
}
