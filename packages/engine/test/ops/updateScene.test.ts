import { describe, expect, test } from 'vitest';
import { ap, apply, expectCode, scene } from '../helpers/ops.ts';
import { richProject } from '../helpers/project.ts';

const upd = (args: Record<string, unknown>, p = richProject()) =>
  apply(p, 'updateScene', { sequenceId: 'seq_1', itemId: 'it_s1', ...args });

describe('updateScene', () => {
  test('variables replace the object and are validated', () => {
    const p = upd({ variables: { title: 'New', subtitle: 'sub' } }).project;
    expect(scene(p, 'it_s1').variables).toEqual({ title: 'New', subtitle: 'sub' });
    expectCode(() => upd({ variables: { subtitle: 'no title' } }), 'VARIABLES_INVALID');
  });
  test('compatible template switch keeps shared variables and reports dropped ones', () => {
    const p0 = upd({ variables: { title: 'T', subtitle: 'S', bg: 'dark' } }).project;
    const out = upd({ template: 'test/card' }, p0);
    const s = scene(out.project, 'it_s1');
    expect([s.template, s.templateVersion]).toEqual(['test/card', '2.0.0']);
    expect(s.variables).toEqual({ title: 'T' });
    expect(out.report).toEqual({ droppedVariables: ['bg', 'subtitle'] });
  });
  test('a required variable with a different JSON-Schema type is incompatible', () => {
    expectCode(() => upd({ template: 'test/number' }), 'TEMPLATE_INCOMPATIBLE');
  });
  test('a missing required variable is incompatible', () => {
    const p = ap(richProject(), 'addScene', {
      sequenceId: 'seq_1',
      trackId: 'V2',
      startMs: 5000,
      template: 'test/stack',
      variables: {
        panels: [
          { template: 'test/title', variables: { title: 'a' } },
          { template: 'test/title', variables: { title: 'b' } },
        ],
      },
    });
    const id = p.sequences[0]!.videoTracks[1]!.items.find(
      (i) => i.type === 'scene' && i.template === 'test/stack',
    )!.id;
    expectCode(
      () => apply(p, 'updateScene', { sequenceId: 'seq_1', itemId: id, template: 'test/title' }),
      'TEMPLATE_INCOMPATIBLE',
    );
  });
  test('slot kinds must match by key', () => {
    const p = upd({ template: 'test/card', variables: { title: 'T', photo: 'm_img' } }).project;
    expectCode(() => upd({ template: 'test/map' }, p), 'TEMPLATE_INCOMPATIBLE');
  });
  test('switching to an unknown template fails TEMPLATE_UNKNOWN', () => {
    expectCode(() => upd({ template: 'test/none' }), 'TEMPLATE_UNKNOWN');
  });
  test('the new template duration bounds apply', () => {
    // it_s1 lasts 2000 ms; test/card needs >= 1000: fine. Shorten to 600 then switch → fails.
    const p = ap(richProject(), 'trimItem', {
      sequenceId: 'seq_1',
      itemId: 'it_s1',
      edge: 'end',
      toMs: 1600,
    });
    expectCode(() => upd({ template: 'test/card' }, p), 'DURATION_BOUNDS');
  });
  test('sfxOff (D-14): cue names of the template; [] clears', () => {
    let p = upd({ sfxOff: ['pop', 'land', 'pop'] }).project;
    expect(scene(p, 'it_s1').sfxOff).toEqual(['pop', 'land']);
    expectCode(() => upd({ sfxOff: ['boom'] }), 'SFX_UNKNOWN');
    p = upd({ sfxOff: [] }, p).project;
    expect(scene(p, 'it_s1')).not.toHaveProperty('sfxOff');
  });
  test('media clips are not scenes', () => {
    expectCode(
      () =>
        apply(richProject(), 'updateScene', {
          sequenceId: 'seq_1',
          itemId: 'it_v1',
          variables: {},
        }),
      'VALIDATION',
    );
  });
});
