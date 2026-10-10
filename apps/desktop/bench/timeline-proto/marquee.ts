// GATE 4 prototype: marquee selection built in the app (the library has none).
// Pure geometry: a rectangle in edit-area content pixels (scroll already added) → items it touches.
import { BENCH_TRACKS, type BenchModel, type Geometry } from './model.ts';

export interface ContentRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface MarqueeRange {
  t0Ms: number;
  t1Ms: number;
  row0: number;
  row1: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function marqueeRange(rect: ContentRect, g: Geometry, rowCount: number): MarqueeRange {
  const toMs = (x: number) => ((x - g.startLeft) / g.scaleWidth) * g.scale * 1000;
  const toRow = (y: number) => clamp(Math.floor(y / g.rowHeight), 0, rowCount - 1);
  return {
    t0Ms: toMs(Math.min(rect.x0, rect.x1)),
    t1Ms: toMs(Math.max(rect.x0, rect.x1)),
    row0: toRow(Math.min(rect.y0, rect.y1)),
    row1: toRow(Math.max(rect.y0, rect.y1)),
  };
}

/** Items on rows row0..row1 whose time range overlaps [t0Ms, t1Ms] (touching counts). */
export function itemsInMarquee(model: BenchModel, r: MarqueeRange): string[] {
  const ids: string[] = [];
  for (let row = r.row0; row <= r.row1; row++) {
    const track = BENCH_TRACKS[row];
    if (!track) continue;
    for (const id of model.order[track]) {
      const item = model.items[id]!;
      if (item.startMs < r.t1Ms && item.startMs + item.durationMs > r.t0Ms) ids.push(id);
    }
  }
  return ids;
}
