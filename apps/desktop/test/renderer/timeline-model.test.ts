// Timeline model: rows, snapping to playhead / edges / words / frames, drop → one op, marquee.
import { describe, expect, it } from 'vitest';
import {
  CAPTION_ROW,
  itemsInRect,
  moveDropOp,
  snapMove,
  snapTargets,
  snapTime,
  toRows,
  trimDropOp,
} from '../../src/renderer/editor/timeline-model.ts';
import type { CaptionChunk, MediaClip } from '../../src/shared/project.ts';
import { idle, testEditor } from './ctx.ts';

const F30 = { num: 30, den: 1 };
const NTSC = { num: 30000, den: 1001 };
const words: CaptionChunk[] = [
  {
    startMs: 5000,
    endMs: 6000,
    lines: [
      { words: [{ key: 'm_v:r1:0', text: 'hi', startMs: 5100, endMs: 5500, emphasis: false }] },
    ],
  },
];

describe('timeline model', () => {
  it('rows: Vn..V1, the caption lane, A1..An; locked tracks cannot move', async () => {
    const t = await testEditor();
    const s = t.ctx.editor.getState().project!.sequences[0]!;
    const locked = {
      ...s,
      videoTracks: s.videoTracks.map((v) => (v.id === 'V1' ? { ...v, locked: true } : v)),
    };
    const rows = toRows(locked, t.ctx.editor.getState().project!.media, new Set(), words);
    expect(rows.map((r) => r.id)).toEqual(['V2', 'V1', CAPTION_ROW, 'A1', 'A2']);
    expect(rows[1]!.actions.every((a) => !a.movable && !a.flexible)).toBe(true);
    expect(rows[0]!.actions[0]).toMatchObject({ effectId: 'scene', start: 0, end: 2 });
    expect(rows[2]!.actions).toHaveLength(1);
    // the second clip starts at source 4 s: it cannot be trimmed before sequence 0 or past 16 s
    expect(rows[1]!.actions[1]).toMatchObject({ minStart: 0, maxEnd: 20 });
  });

  it('snaps to the playhead, clip edges and word boundaries, always on the frame grid', async () => {
    const t = await testEditor();
    const s = t.ctx.editor.getState().project!.sequences[0]!;
    const targets = snapTargets(s, { playheadMs: 7000, exclude: new Set(), captions: words });
    expect(targets).toEqual(expect.arrayContaining([0, 7000, 4000, 8000, 2000, 5100, 5500]));
    expect(snapTime(7040, targets, 100, F30)).toBe(7000);
    expect(snapTime(5130, targets, 100, F30)).toBe(5100);
    expect(snapTime(6420, targets, 100, F30)).toBe(6433); // nothing near: nearest frame
    expect(snapTime(1234, [], 0, NTSC) % 1).toBe(0);
    // a move snaps whichever edge is closer: end 7990 → 8000
    expect(snapMove(3990, 4000, [8000], 100, F30)).toBe(4000);
  });

  it('a drag drop is one moveItem; the linked audio follows in the engine', async () => {
    const t = await testEditor();
    const s = t.ctx.editor.getState().project!.sequences[0]!;
    const clip = s.videoTracks[0]!.items[1]!;
    const call = moveDropOp(s, clip.id, 9000, [])!;
    expect(call.op).toBe('moveItem');
    await t.ctx.editor.getState().apply(call);
    await idle(t);
    const p = t.ctx.editor.getState().project!.sequences[0]!;
    expect(p.videoTracks[0]!.items[1]!.startMs).toBe(9000);
    expect(p.audioTracks[0]!.items.map((i) => i.startMs)).toEqual([0, 9000]);
    expect(moveDropOp(p, clip.id, 9000, [])).toBeNull(); // no change, no op
  });

  it('multi-select move: one batch moves every selected item by the same delta', async () => {
    const t = await testEditor();
    const s = t.ctx.editor.getState().project!.sequences[0]!;
    const [c1, c2] = s.videoTracks[0]!.items;
    const scene = s.videoTracks[1]!.items[0]!;
    const call = moveDropOp(s, c1!.id, 1000, [c1!.id, c2!.id, scene.id])!;
    expect(call.op).toBe('batch');
    await t.ctx.editor.getState().apply(call);
    await idle(t);
    const p = t.ctx.editor.getState().project!.sequences[0]!;
    expect(p.videoTracks[0]!.items.map((i) => i.startMs)).toEqual([1000, 5000]);
    expect(p.videoTracks[1]!.items[0]!.startMs).toBe(1000);
    expect(t.ctx.editor.getState().toasts).toEqual([]);
  });

  it('trim drop: one trimItem on the edge that moved', async () => {
    const t = await testEditor();
    const s = t.ctx.editor.getState().project!.sequences[0]!;
    const c = s.videoTracks[0]!.items[0]! as MediaClip;
    expect(trimDropOp(s, c, 0, 3000, 'right')).toMatchObject({
      op: 'trimItem',
      args: { edge: 'end', toMs: 3000 },
    });
    expect(trimDropOp(s, c, 500, 4000, 'left')).toMatchObject({
      args: { edge: 'start', toMs: 500 },
    });
    expect(trimDropOp(s, c, 0, 4000, 'right')).toBeNull();
  });

  it('marquee selects exactly the items it touches, never caption chunks', () => {
    const rows = [
      { id: 'V1', rowHeight: 40, actions: Array.from({ length: 60 }, (_, i) => act(`a${i}`, i)) },
      { id: CAPTION_ROW, rowHeight: 30, actions: [act('cap_0', 0)] },
      { id: 'A1', rowHeight: 40, actions: [act('b0', 0)] },
    ];
    // 50 clips of 1 s at 10 px/s: x 0..499 covers a0..a49
    const ids = itemsInRect(
      { pxPerSec: 10, startLeft: 0, rows },
      { x0: 1, y0: 5, x1: 499, y1: 30 },
    );
    expect(ids).toHaveLength(50);
    expect(ids).toEqual(Array.from({ length: 50 }, (_, i) => `a${i}`));
    const both = itemsInRect(
      { pxPerSec: 10, startLeft: 0, rows },
      { x0: 1, y0: 5, x1: 5, y1: 100 },
    );
    expect(both).toEqual(['a0', 'b0']);
  });
});

function act(id: string, i: number) {
  return {
    id,
    start: i,
    end: i + 1,
    effectId: 'media' as const,
    movable: true,
    flexible: true,
    selected: false,
  };
}
