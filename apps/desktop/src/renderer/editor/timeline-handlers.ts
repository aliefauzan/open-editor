// Timeline gesture handlers, separate from the component so tests can drive them: a drag or trim
// only moves pixels (and the linked partners' preview offsets) while the mouse moves; the drop
// snaps and sends one op (app spec "Live updates" step 1).
import type { EditorContext } from './context.tsx';
import { endOf, seqOf } from './editing.ts';
import { allItems } from './entities.ts';
import { moveDropOp, snapMove, snapTargets, snapTime, trimDropOp } from './timeline-model.ts';
import type { CaptionChunk } from '../../shared/project.ts';

/** Snap distance on screen. */
export const SNAP_PX = 8;

/** Live offsets (ms) of linked partners and co-selected items while a gesture runs. */
export interface Follow {
  /** itemId → [startDeltaMs, endDeltaMs] */
  offsets: Map<string, [number, number]>;
  listeners: Set<() => void>;
}

export function createFollow(): Follow {
  return { offsets: new Map(), listeners: new Set() };
}

function setFollow(f: Follow, next: Map<string, [number, number]>) {
  if (next.size === 0 && f.offsets.size === 0) return;
  f.offsets = next;
  for (const l of f.listeners) l();
}

export function timelineHandlers(
  ctx: EditorContext,
  follow: Follow,
  captions: () => readonly CaptionChunk[],
) {
  const seq = () => {
    const s = ctx.editor.getState();
    return seqOf(s.project, s.sequenceId);
  };
  const threshold = () => (SNAP_PX / ctx.ui.getState().pxPerSec) * 1000;
  const targetsFor = (exclude: Set<string>) => {
    const s = seq();
    if (!s) return [];
    if (!ctx.ui.getState().snapping) return [];
    return snapTargets(s, {
      playheadMs: ctx.editor.getState().playheadMs,
      exclude,
      captions: captions(),
    });
  };
  /** Items that move with `itemId`: its linked partners and (if it is selected) the selection. */
  const companions = (itemId: string): string[] => {
    const s = seq();
    if (!s) return [];
    const all = allItems(s);
    const sel = ctx.editor.getState().selection;
    const ids = new Set(sel.includes(itemId) ? sel : [itemId]);
    for (const { item } of all) {
      if (!ids.has(item.id) || !item.linkId) continue;
      for (const x of all) if (x.item.linkId === item.linkId) ids.add(x.item.id);
    }
    ids.delete(itemId);
    return [...ids];
  };
  const item = (id: string) => {
    const s = seq();
    return s ? allItems(s).find((x) => x.item.id === id)?.item : undefined;
  };

  return {
    onMoving(id: string, startSec: number): void {
      const it = item(id);
      if (!it) return;
      const d = Math.round(startSec * 1000) - it.startMs;
      setFollow(follow, new Map(companions(id).map((c) => [c, [d, d] as [number, number]])));
    },
    onMoveEnd(id: string, startSec: number): void {
      setFollow(follow, new Map());
      const s = seq();
      const it = item(id);
      if (!s || !it) return;
      const exclude = new Set([id, ...companions(id)]);
      const start = ctx.ui.getState().snapping
        ? snapMove(
            Math.round(startSec * 1000),
            it.durationMs,
            targetsFor(exclude),
            threshold(),
            s.canvas.fps,
          )
        : snapTime(Math.round(startSec * 1000), [], 0, s.canvas.fps);
      const call = moveDropOp(s, id, start, ctx.editor.getState().selection);
      if (call) void ctx.editor.getState().apply(call);
    },
    onResizing(id: string, startSec: number, endSec: number, dir: 'left' | 'right'): void {
      const it = item(id);
      if (!it || !it.linkId) return setFollow(follow, new Map());
      const ds = dir === 'left' ? Math.round(startSec * 1000) - it.startMs : 0;
      const de = dir === 'right' ? Math.round(endSec * 1000) - endOf(it) : 0;
      const s = seq()!;
      const partners = allItems(s)
        .filter((x) => x.item.linkId === it.linkId && x.item.id !== id)
        .map((x) => [x.item.id, [ds, de]] as [string, [number, number]]);
      setFollow(follow, new Map(partners));
    },
    onResizeEnd(id: string, startSec: number, endSec: number, dir: 'left' | 'right'): void {
      setFollow(follow, new Map());
      const s = seq();
      const it = item(id);
      if (!s || !it) return;
      const t = targetsFor(new Set([id]));
      const start = snapTime(Math.round(startSec * 1000), t, threshold(), s.canvas.fps);
      const end = snapTime(Math.round(endSec * 1000), t, threshold(), s.canvas.fps);
      const call = trimDropOp(s, it, start, end, dir);
      if (call) void ctx.editor.getState().apply(call);
    },
  };
}
