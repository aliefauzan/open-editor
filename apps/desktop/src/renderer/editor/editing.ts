// UI actions → engine ops (engine spec "Edit operations"): every timeline action is one op or one
// `batch`, so it is one undo entry. Pure functions of the project; the store sends the result.
import type { Item, Project, Sequence } from '../../shared/project.ts';
import { allItems } from './entities.ts';
import type { OpCall } from './optimistic.ts';

export const endOf = (i: Item) => i.startMs + i.durationMs;

export function seqOf(p: Project | null, id: string | null): Sequence | undefined {
  return p?.sequences.find((s) => s.id === id);
}

const lockedTracks = (s: Sequence) =>
  new Set([...s.videoTracks, ...s.audioTracks].filter((t) => t.locked).map((t) => t.id));

/** Selected items (with track ids) on unlocked tracks, one per linked group when `onePerLink`. */
function selected(s: Sequence, ids: readonly string[], onePerLink: boolean) {
  const want = new Set(ids);
  const locked = lockedTracks(s);
  const seen = new Set<string>();
  return allItems(s).filter(({ item, trackId }) => {
    if (!want.has(item.id) || locked.has(trackId)) return false;
    if (!onePerLink || !item.linkId) return true;
    if (seen.has(item.linkId)) return false;
    seen.add(item.linkId);
    return true;
  });
}

const batch = (ops: OpCall[]): OpCall | null =>
  ops.length === 0 ? null : ops.length === 1 ? ops[0]! : { op: 'batch', args: { ops } };

/** Blade at `atMs`: the selected items under it, else every item under it on unlocked tracks. */
export function bladeOp(s: Sequence, selection: readonly string[], atMs: number): OpCall | null {
  const under = (i: Item) => i.startMs < atMs && endOf(i) > atMs;
  const pool = selection.length > 0 ? selection : allItems(s).map((x) => x.item.id);
  const ops = selected(s, pool, true)
    .filter(({ item }) => under(item))
    .map(({ item }) => ({ op: 'splitItem', args: { sequenceId: s.id, itemId: item.id, atMs } }));
  return batch(ops);
}

/** Delete: removes exactly the selected items (alt-selected halves of a pair stay apart). */
export function deleteOp(s: Sequence, selection: readonly string[]): OpCall | null {
  return batch(
    selected(s, selection, false).map(({ item }) => ({
      op: 'removeItem',
      args: { sequenceId: s.id, itemId: item.id, unlinked: true },
    })),
  );
}

/**
 * Ripple delete: cuts each selected item's range and closes the gap (sync-locked and linked tracks
 * follow, engine `rippleDelete`); latest first so earlier ranges do not move.
 */
export function rippleDeleteOp(s: Sequence, selection: readonly string[]): OpCall | null {
  const parts = selected(s, selection, true).sort((a, b) => b.item.startMs - a.item.startMs);
  return batch(
    parts.map(({ item, trackId }) => ({
      op: 'rippleDelete',
      args: { sequenceId: s.id, trackId, startMs: item.startMs, endMs: endOf(item) },
    })),
  );
}

export function copyItems(s: Sequence, selection: readonly string[]) {
  return selected(s, selection, false).map(({ item, trackId }) => ({
    trackId,
    item: structuredClone(item),
  }));
}

export function pasteOp(
  s: Sequence,
  items: readonly { trackId: string; item: Item }[],
  atMs: number,
): OpCall | null {
  const have = new Set([...s.videoTracks, ...s.audioTracks].map((t) => t.id));
  const usable = items.filter((x) => have.has(x.trackId));
  if (usable.length === 0) return null;
  return {
    op: 'pasteItems',
    args: { sequenceId: s.id, atMs, items: usable.map((x) => structuredClone(x)) },
  };
}

/** Duplicate: a copy of the selection right after its end. */
export function duplicateOp(s: Sequence, selection: readonly string[]): OpCall | null {
  const items = copyItems(s, selection);
  if (items.length === 0) return null;
  return pasteOp(s, items, Math.max(...items.map((x) => endOf(x.item))));
}

/** "Add text": `base/text-overlay` at the playhead on the top video track (a new track if busy). */
export function addTextOp(s: Sequence, atMs: number, durationMs = 3000): OpCall {
  const top = s.videoTracks.at(-1);
  const free =
    top && !top.locked && !top.items.some((i) => i.startMs < atMs + durationMs && endOf(i) > atMs);
  const scene = (trackId: string) => ({
    op: 'addScene',
    args: {
      sequenceId: s.id,
      trackId,
      startMs: atMs,
      durationMs,
      template: 'base/text-overlay',
      variables: { text: 'Text' },
    },
  });
  if (free) return scene(top.id);
  const next = `V${Math.max(0, ...s.videoTracks.map((t) => Number(t.id.slice(1)))) + 1}`;
  return {
    op: 'batch',
    args: { ops: [{ op: 'addTrack', args: { sequenceId: s.id, kind: 'video' } }, scene(next)] },
  };
}
