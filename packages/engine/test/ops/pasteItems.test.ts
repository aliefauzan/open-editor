import { describe, expect, test } from 'vitest';
import { apply, expectCode, item, spans, trackItems } from '../helpers/ops.ts';
import { richProject } from '../helpers/project.ts';

const copied = () => {
  const p = richProject();
  const v = p.sequences[0]!.videoTracks[0]!.items[1]!; // it_v2 5000–8000 ln_2
  const a = p.sequences[0]!.audioTracks[0]!.items[1]!; // it_a2
  return [
    { trackId: 'V1', item: v },
    { trackId: 'A1', item: a },
  ];
};

describe('pasteItems', () => {
  test('the earliest item lands at atMs; ids and linkIds are new', () => {
    const out = apply(richProject(), 'pasteItems', {
      sequenceId: 'seq_1',
      atMs: 10000,
      items: copied(),
    });
    const [v, a] = (out.report as { itemIds: string[] }).itemIds;
    const pv = item(out.project, v!);
    const pa = item(out.project, a!);
    expect([pv.startMs, pv.trackId, pa.startMs, pa.trackId]).toEqual([10000, 'V1', 10000, 'A1']);
    expect(pv.id).not.toBe('it_v2');
    expect(pv.linkId).toBe(pa.linkId);
    expect(pv.linkId).not.toBe('ln_2');
  });
  test('trackMap maps source tracks', () => {
    const out = apply(richProject(), 'pasteItems', {
      sequenceId: 'seq_1',
      atMs: 10000,
      items: copied(),
      trackMap: { V1: 'V2', A1: 'A2' },
    });
    expect(trackItems(out.project, 'V2')).toHaveLength(2);
    expect(trackItems(out.project, 'A2')).toHaveLength(1);
  });
  test('onOverlap applies', () => {
    expectCode(
      () =>
        apply(richProject(), 'pasteItems', { sequenceId: 'seq_1', atMs: 1000, items: copied() }),
      'OVERLAP',
    );
    const out = apply(richProject(), 'pasteItems', {
      sequenceId: 'seq_1',
      atMs: 0,
      items: copied(),
      onOverlap: 'insert',
    });
    expect(spans(trackItems(out.project, 'V1'))).toEqual([
      [0, 3000],
      [3000, 8000],
      [8000, 11000],
    ]);
    expect(spans(trackItems(out.project, 'V2'))).toEqual([[4000, 6000]]);
  });
  test('pasted scenes are validated', () => {
    const bad = {
      trackId: 'V2',
      item: {
        id: 'it_x',
        type: 'scene',
        template: 'test/title',
        templateVersion: '1.0.0',
        startMs: 0,
        durationMs: 1000,
        variables: {},
      },
    };
    expectCode(
      () => apply(richProject(), 'pasteItems', { sequenceId: 'seq_1', atMs: 9000, items: [bad] }),
      'VARIABLES_INVALID',
    );
  });
});
