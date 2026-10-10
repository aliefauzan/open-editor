import { describe, expect, it } from 'vitest';
import { itemsInMarquee, marqueeRange } from '../../bench/timeline-proto/marquee.ts';
import { BENCH_GEOMETRY, makeBenchData } from '../../bench/timeline-proto/model.ts';

const g = BENCH_GEOMETRY;
const xAt = (sec: number) => g.startLeft + (sec / g.scale) * g.scaleWidth;
const yAt = (row: number) => row * g.rowHeight + g.rowHeight / 2;

describe('marqueeRange', () => {
  it('maps content pixels to a time range and a row range in any drag direction', () => {
    const r = marqueeRange({ x0: xAt(60.8), y0: yAt(2), x1: xAt(0.8), y1: yAt(1) }, g, 8);
    expect(r.t0Ms).toBeCloseTo(800, 6);
    expect(r.t1Ms).toBeCloseTo(60800, 6);
    expect(r.row0).toBe(1);
    expect(r.row1).toBe(2);
  });

  it('clamps rows to the track count', () => {
    const r = marqueeRange({ x0: 0, y0: -50, x1: 10, y1: 10_000 }, g, 8);
    expect(r.row0).toBe(0);
    expect(r.row1).toBe(7);
  });
});

describe('itemsInMarquee', () => {
  it('a marquee over 25 items on V3 and V2 selects exactly those 50', () => {
    const model = makeBenchData();
    const ids = itemsInMarquee(
      model,
      marqueeRange({ x0: xAt(0.8), y0: yAt(1), x1: xAt(60.8), y1: yAt(2) }, g, 8),
    );
    const expected = [...model.order.V3.slice(0, 25), ...model.order.V2.slice(0, 25)];
    expect(ids.sort()).toEqual(expected.sort());
  });

  it('selects an item the marquee only touches', () => {
    const model = makeBenchData();
    const item = model.items[model.order.V4[0]!]!;
    const end = (item.startMs + item.durationMs) / 1000;
    const ids = itemsInMarquee(
      model,
      marqueeRange({ x0: xAt(end - 0.05), y0: yAt(0), x1: xAt(end + 0.1), y1: yAt(0) }, g, 8),
    );
    expect(ids).toEqual([item.id]);
  });

  it('selects nothing in a gap', () => {
    const model = makeBenchData();
    const ids = itemsInMarquee(
      model,
      marqueeRange({ x0: xAt(3.05), y0: yAt(0), x1: xAt(3.35), y1: yAt(7) }, g, 8),
    );
    expect(ids).toEqual([]);
  });
});
