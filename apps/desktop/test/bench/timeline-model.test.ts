import { describe, expect, it } from 'vitest';
import {
  BENCH_TRACKS,
  makeBenchData,
  moveItem,
  partnerPreview,
  snapSecondsToMs,
  toEditorData,
  trimItem,
} from '../../bench/timeline-proto/model.ts';

describe('timeline bench data', () => {
  it('has 1,000 items on 8 tracks, 125 per track', () => {
    const model = makeBenchData();
    expect(BENCH_TRACKS).toHaveLength(8);
    expect(Object.keys(model.items)).toHaveLength(1000);
    for (const track of BENCH_TRACKS) expect(model.order[track]).toHaveLength(125);
  });

  it('links every V1 item to the A1 item at the same index with equal start and duration', () => {
    const model = makeBenchData();
    const v1 = model.order.V1.map((id) => model.items[id]!);
    const a1 = model.order.A1.map((id) => model.items[id]!);
    v1.forEach((item, i) => {
      const partner = a1[i]!;
      expect(item.linkId).not.toBeNull();
      expect(partner.linkId).toBe(item.linkId);
      expect(partner.startMs).toBe(item.startMs);
      expect(partner.durationMs).toBe(item.durationMs);
    });
    const others = BENCH_TRACKS.filter((t) => t !== 'V1' && t !== 'A1');
    for (const track of others) {
      for (const id of model.order[track]) expect(model.items[id]!.linkId).toBeNull();
    }
  });

  it('places items on the 30 fps frame grid without overlaps', () => {
    const model = makeBenchData();
    for (const track of BENCH_TRACKS) {
      let lastEnd = -1;
      for (const id of model.order[track]) {
        const item = model.items[id]!;
        expect(snapSecondsToMs(item.startMs / 1000)).toBe(item.startMs);
        expect(item.startMs).toBeGreaterThan(lastEnd);
        lastEnd = item.startMs + item.durationMs;
      }
    }
  });
});

describe('snapSecondsToMs', () => {
  it('rounds to the nearest 30 fps frame in integer ms', () => {
    expect(snapSecondsToMs(0)).toBe(0);
    expect(snapSecondsToMs(1 / 30)).toBe(33);
    expect(snapSecondsToMs(2 / 30)).toBe(67);
    expect(snapSecondsToMs(1.01)).toBe(1000);
    expect(snapSecondsToMs(-0.5)).toBe(0);
  });
});

describe('moveItem', () => {
  it('moves a linked V1 clip and its A1 partner to the same startMs', () => {
    const model = makeBenchData();
    const v1 = model.order.V1[7]!;
    const a1 = model.order.A1[7]!;
    const next = moveItem(model, v1, 30.51);
    expect(next.items[v1]!.startMs).toBe(30500);
    expect(next.items[a1]!.startMs).toBe(30500);
    expect(next.items[a1]!.durationMs).toBe(model.items[a1]!.durationMs);
  });

  it('moves the partner when the A1 side is dragged', () => {
    const model = makeBenchData();
    const v1 = model.order.V1[3]!;
    const a1 = model.order.A1[3]!;
    const next = moveItem(model, a1, 12);
    expect(next.items[v1]!.startMs).toBe(12000);
    expect(next.items[a1]!.startMs).toBe(12000);
  });

  it('moves an unlinked clip alone and keeps other objects unchanged', () => {
    const model = makeBenchData();
    const id = model.order.V2[5]!;
    const next = moveItem(model, id, 100);
    expect(next.items[id]!.startMs).toBe(100000);
    const other = model.order.V2[6]!;
    expect(next.items[other]).toBe(model.items[other]);
    expect(model.items[id]!.startMs).not.toBe(100000);
  });

  it('returns the same model when nothing changes', () => {
    const model = makeBenchData();
    const id = model.order.V2[0]!;
    expect(moveItem(model, id, model.items[id]!.startMs / 1000)).toBe(model);
  });
});

describe('trimItem', () => {
  it('sets start and duration on the frame grid and keeps at least one frame', () => {
    const model = makeBenchData();
    const id = model.order.V3[2]!;
    const next = trimItem(model, id, 5, 7.02);
    expect(next.items[id]!.startMs).toBe(5000);
    expect(next.items[id]!.durationMs).toBe(2033);
    const tiny = trimItem(model, id, 5, 5);
    expect(tiny.items[id]!.durationMs).toBe(33);
  });

  it('trims a linked partner to the same range', () => {
    const model = makeBenchData();
    const v1 = model.order.V1[1]!;
    const a1 = model.order.A1[1]!;
    const next = trimItem(model, v1, 4, 5);
    expect(next.items[a1]!.startMs).toBe(4000);
    expect(next.items[a1]!.durationMs).toBe(1000);
  });
});

describe('toEditorData', () => {
  it('gives one row per track in order, times in seconds, selection flags', () => {
    const model = makeBenchData();
    const first = model.order.V3[0]!;
    const rows = toEditorData(model, new Set([first]));
    expect(rows.map((r) => r.id)).toEqual([...BENCH_TRACKS]);
    const v3 = rows[1]!;
    expect(v3.actions).toHaveLength(125);
    const a = v3.actions[0]!;
    const item = model.items[first]!;
    expect(a.id).toBe(first);
    expect(a.start).toBe(item.startMs / 1000);
    expect(a.end).toBe((item.startMs + item.durationMs) / 1000);
    expect(a.selected).toBe(true);
    expect(v3.actions[1]!.selected).toBe(false);
  });
});

describe('partnerPreview', () => {
  it('gives the A1 partner the pixel offsets of the dragged V1 range', () => {
    const model = makeBenchData();
    const v1 = model.order.V1[7]!;
    const a1 = model.order.A1[7]!;
    const item = model.items[v1]!;
    const s = item.startMs / 1000;
    const e = (item.startMs + item.durationMs) / 1000;
    expect(partnerPreview(model, v1, s + 5, e + 5, 30)).toEqual([
      { id: a1, dStartPx: 150, dEndPx: 150 },
    ]);
    expect(partnerPreview(model, a1, s, e + 1, 30)).toEqual([{ id: v1, dStartPx: 0, dEndPx: 30 }]);
  });

  it('is empty for an unlinked clip', () => {
    const model = makeBenchData();
    expect(partnerPreview(model, model.order.V2[0]!, 9, 11, 30)).toEqual([]);
  });
});

describe('linked partners keep their offset', () => {
  const offsetPartner = () => {
    const model = makeBenchData();
    const v1 = model.order.V1[4]!;
    const a1 = model.order.A1[4]!;
    const a = model.items[a1]!;
    // A1 starts 10 frames later and ends 5 frames later than V1 (on the 30 fps grid).
    const startMs = snapSecondsToMs(a.startMs / 1000 + 10 / 30);
    const endMs = snapSecondsToMs((a.startMs + a.durationMs) / 1000 + 5 / 30);
    const items = { ...model.items, [a1]: { ...a, startMs, durationMs: endMs - startMs } };
    return { model: { ...model, items }, v1, a1 };
  };

  it('moveItem shifts the partner by the same delta', () => {
    const { model, v1, a1 } = offsetPartner();
    const next = moveItem(model, v1, model.items[v1]!.startMs / 1000 + 2);
    expect(next.items[v1]!.startMs - model.items[v1]!.startMs).toBe(2000);
    expect(next.items[a1]!.startMs - model.items[a1]!.startMs).toBe(2000);
    expect(next.items[a1]!.durationMs).toBe(model.items[a1]!.durationMs);
  });

  it('trimItem moves each partner edge by the same delta', () => {
    const { model, v1, a1 } = offsetPartner();
    const v = model.items[v1]!;
    const next = trimItem(model, v1, v.startMs / 1000 + 1, (v.startMs + v.durationMs) / 1000);
    expect(next.items[a1]!.startMs - model.items[a1]!.startMs).toBe(1000);
    expect(next.items[a1]!.durationMs).toBe(model.items[a1]!.durationMs - 1000);
  });
});
