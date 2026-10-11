import { describe, expect, test } from 'vitest';
import { ap, apply, expectCode, scene, spans, trackItems } from '../helpers/ops.ts';
import { baseProject, richProject } from '../helpers/project.ts';

const add = (args: Record<string, unknown>, p = baseProject()) =>
  apply(p, 'addScene', {
    sequenceId: 'seq_1',
    trackId: 'V2',
    startMs: 0,
    template: 'test/title',
    variables: { title: 'Hi' },
    ...args,
  });
const idOf = (out: { report?: unknown }) => (out.report as { itemIds: string[] }).itemIds[0]!;

describe('addScene', () => {
  test('defaults duration to the template default and records the template version', () => {
    const out = add({});
    const s = scene(out.project, idOf(out));
    expect([s.durationMs, s.templateVersion, s.template]).toEqual([3000, '1.2.0', 'test/title']);
  });
  test('two scenes that meet at an off-frame ms still meet after snapping (no overlap)', () => {
    // 750 ms and 2500 ms are not frame starts at 30 fps; each end snaps on its own
    const first = add({ startMs: 750, durationMs: 1750 });
    const second = add({ startMs: 2500, durationMs: 1750 }, first.project);
    const a = scene(second.project, idOf(first));
    const b = scene(second.project, idOf(second));
    expect(a.startMs + a.durationMs).toBe(b.startMs);
  });
  test('variables are validated against the template schema', () => {
    expectCode(() => add({ variables: {} }), 'VARIABLES_INVALID');
    expectCode(() => add({ variables: { title: 'x'.repeat(61) } }), 'VARIABLES_INVALID');
    expectCode(() => add({ variables: { title: 'a', nope: 1 } }), 'VARIABLES_INVALID');
    expectCode(() => add({ variables: { title: 'a', bg: 'neon' } }), 'VARIABLES_INVALID');
  });
  test('media slots need media of the right kind', () => {
    const ok = add({ template: 'test/card', variables: { title: 'a', photo: 'm_img' } });
    expect(scene(ok.project, idOf(ok)).variables).toEqual({ title: 'a', photo: 'm_img' });
    expectCode(
      () => add({ template: 'test/card', variables: { title: 'a', photo: 'm_video' } }),
      'VARIABLES_INVALID',
    );
    expectCode(
      () => add({ template: 'test/card', variables: { title: 'a', photo: 'm_none' } }),
      'VARIABLES_INVALID',
    );
  });
  test('stack panels are validated recursively', () => {
    const ok = {
      panels: [
        { template: 'test/title', variables: { title: 'a' } },
        { template: 'test/card', variables: { title: 'b', photo: 'm_img' } },
      ],
    };
    expect(() => add({ template: 'test/stack', variables: ok })).not.toThrow();
    const badInner = {
      panels: [
        { template: 'test/title', variables: {} },
        { template: 'test/title', variables: { title: 'b' } },
      ],
    };
    expectCode(() => add({ template: 'test/stack', variables: badInner }), 'VARIABLES_INVALID');
    const unknownInner = {
      panels: [
        { template: 'test/nope', variables: {} },
        { template: 'test/title', variables: { title: 'b' } },
      ],
    };
    expectCode(() => add({ template: 'test/stack', variables: unknownInner }), 'TEMPLATE_UNKNOWN');
    const nested = {
      panels: [
        { template: 'test/stack', variables: ok },
        { template: 'test/title', variables: { title: 'b' } },
      ],
    };
    expectCode(() => add({ template: 'test/stack', variables: nested }), 'VARIABLES_INVALID');
  });
  test('unknown templates and transition templates fail TEMPLATE_UNKNOWN', () => {
    expectCode(() => add({ template: 'test/none' }), 'TEMPLATE_UNKNOWN');
    expectCode(() => add({ template: 'test/crossfade', variables: {} }), 'TEMPLATE_UNKNOWN');
  });
  test('duration must be inside the template bounds', () => {
    expectCode(() => add({ durationMs: 400 }), 'DURATION_BOUNDS');
    expectCode(() => add({ durationMs: 10100 }), 'DURATION_BOUNDS');
    expect(() => add({ durationMs: 500 })).not.toThrow();
  });
  test('sfxOff names must be cues of the template (D-14)', () => {
    const out = add({ sfxOff: ['land'] });
    expect(scene(out.project, idOf(out)).sfxOff).toEqual(['land']);
    expectCode(() => add({ sfxOff: ['boom'] }), 'SFX_UNKNOWN');
  });
  test('scenes go on video tracks only', () => {
    expectCode(() => add({ trackId: 'A2' }), 'TRACK_KIND');
  });
  test('onOverlap modes', () => {
    expectCode(() => add({ startMs: 2000 }, richProject()), 'OVERLAP');
    const p = add({ startMs: 2000, onOverlap: 'overwrite' }, richProject()).project;
    expect(spans(trackItems(p, 'V2'))).toEqual([
      [1000, 2000],
      [2000, 5000],
    ]);
  });
  test('an overwrite that leaves a scene below its minimum fails DURATION_BOUNDS', () => {
    expectCode(
      () => add({ startMs: 1300, onOverlap: 'overwrite' }, richProject()),
      'DURATION_BOUNDS',
    );
  });
  test('placing directly via ap works on base project', () => {
    expect(
      trackItems(
        ap(baseProject(), 'addScene', {
          sequenceId: 'seq_1',
          trackId: 'V1',
          startMs: 0,
          template: 'test/number',
          variables: { title: 3 },
        }),
        'V1',
      ),
    ).toHaveLength(1);
  });
});
