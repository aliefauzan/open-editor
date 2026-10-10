import { describe, expect, test } from 'vitest';
import { FPS_SET, fpsName, onGridFor } from '../helpers/grid.ts';
import { ap, apply, expectCode, spans, trackItems } from '../helpers/ops.ts';
import { K, speechCtx, speechProject } from '../helpers/speech.ts';

const rp = (args: Record<string, unknown>, p = speechProject()) =>
  apply(p, 'removePauses', { sequenceId: 'seq_1', ...args }, speechCtx());
const ranges = (o: { report?: unknown }) => (o.report as { ranges: unknown[] }).ranges;

describe('removePauses (D-15)', () => {
  test('dry run returns the review list and changes nothing', () => {
    const p = speechProject();
    const out = rp({ dryRun: true }, p);
    expect(out.dryRun).toBe(true);
    expect(out.project).toBe(p);
    expect(out.steps[0]!.changes).toEqual([]);
    // pauses 3810–4216 and 5456–6227 keep 40 ms at each edge, snapped to 30 fps
    expect(ranges(out)).toEqual([
      { startMs: 3867, endMs: 4167, kind: 'pause', wordKeys: [K(11)] },
      { startMs: 5500, endMs: 6200, kind: 'pause', wordKeys: [K(17)] },
    ]);
  });
  test('cuts the ranges latest first over the linked V and A clips in one op', () => {
    const out = rp({});
    expect(out.steps).toHaveLength(1);
    expect(ranges(out)).toHaveLength(2);
    expect(spans(trackItems(out.project, 'V1'))).toEqual([
      [0, 3867],
      [3867, 5200],
      [5200, 6200],
    ]);
    expect(spans(trackItems(out.project, 'A1'))).toEqual(spans(trackItems(out.project, 'V1')));
    const v = trackItems(out.project, 'V1');
    expect(v.map((i) => i.type === 'media' && i.inMs)).toEqual([0, 4167, 6200]);
    // each split pair stays linked
    const a = trackItems(out.project, 'A1');
    expect(v.map((i) => i.linkId)).toEqual(a.map((i) => i.linkId));
  });
  test('pauses shorter than minPauseMs are kept', () => {
    expect(ranges(rp({ minPauseMs: 500, dryRun: true }))).toEqual([
      { startMs: 5500, endMs: 6200, kind: 'pause', wordKeys: [K(17)] },
    ]);
  });
  test('keepMs sets the silence kept (half at each edge)', () => {
    expect(ranges(rp({ keepMs: 0, dryRun: true }))[0]).toEqual({
      startMs: 3800,
      endMs: 4200,
      kind: 'pause',
      wordKeys: [K(11)],
    });
  });
  test('kinds adds fillers and repeats; touching ranges merge', () => {
    expect(ranges(rp({ kinds: ['pause', 'filler', 'repeat'], dryRun: true }))).toEqual([
      { startMs: 633, endMs: 933, kind: 'filler', wordKeys: [K(1)] },
      { startMs: 1133, endMs: 1467, kind: 'repeat', wordKeys: [K(2), K(3)] },
      { startMs: 2567, endMs: 2900, kind: 'filler', wordKeys: [K(8)] },
      { startMs: 3867, endMs: 4167, kind: 'pause', wordKeys: [K(11)] },
      { startMs: 5500, endMs: 6200, kind: 'pause', wordKeys: [K(17)] },
    ]);
  });
  test('wordKeys removes only the listed ranges, still keeping keepMs', () => {
    const out = rp({ kinds: ['pause', 'filler'], wordKeys: [K(17), K(8)] });
    expect(ranges(out)).toEqual([
      { startMs: 2567, endMs: 2900, kind: 'filler', wordKeys: [K(8)] },
      { startMs: 5500, endMs: 6200, kind: 'pause', wordKeys: [K(17)] },
    ]);
    // unlisted pause 11 stays: total length 7200 - 300 - 700
    const v = trackItems(out.project, 'V1');
    expect(v.reduce((n, i) => n + i.durationMs, 0)).toBe(7200 - 333 - 700);
  });
  test('words come from the caption source tracks when captions are on', () => {
    let p = ap(speechProject(), 'setCaptions', { sequenceId: 'seq_1', sourceTrackIds: ['A2'] });
    expect(ranges(rp({ dryRun: true }, p))).toEqual([]);
    p = ap(p, 'setCaptions', { sequenceId: 'seq_1', enabled: false });
    expect(ranges(rp({ dryRun: true }, p))).toHaveLength(2);
  });
  test('a sync-locked scene across a pause is shortened', () => {
    const p = ap(
      speechProject(),
      'addScene',
      {
        sequenceId: 'seq_1',
        trackId: 'V2',
        startMs: 5000,
        durationMs: 2000,
        template: 'test/title',
        variables: { title: 'x' },
      },
      speechCtx(),
    );
    const out = rp({}, p);
    expect(spans(trackItems(out.project, 'V2'))).toEqual([[4700, 6000]]);
  });
  test.each(FPS_SET.map((f) => [fpsName(f), f] as const))(
    'at %s fps the cuts land on the grid',
    (_n, fps) => {
      const out = rp({ kinds: ['pause', 'filler', 'repeat'] }, speechProject(fps));
      for (const t of ['V1', 'A1']) {
        for (const i of trackItems(out.project, t)) {
          expect(onGridFor(i.startMs, fps)).toBe(true);
          expect(onGridFor(i.startMs + i.durationMs, fps)).toBe(true);
        }
      }
    },
  );
  test('bad kinds fail VALIDATION', () => {
    expectCode(() => rp({ kinds: ['word'] }), 'VALIDATION');
  });
});
