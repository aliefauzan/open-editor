import { describe, expect, it } from 'vitest';
import {
  applyChanges,
  denormalise,
  invertChanges,
  normalise,
  projectFrame,
} from '../../src/renderer/editor/entities.ts';
import type { Change, Project } from '../../src/shared/project.ts';
import { editorProject, op, tempEngine } from './engine-fixture.ts';

describe('renderer entity map', () => {
  it('round-trips an engine project in canonical order', async () => {
    const e = tempEngine();
    const p = await editorProject(e);
    expect(denormalise(normalise(p), projectFrame(p))).toEqual(p);
  });

  it('applying the change records of engine ops gives the engine project', async () => {
    const e = tempEngine();
    const before = await editorProject(e);
    const v1 = before.sequences[0]!.videoTracks[0]!.items;
    const changes: Change[] = [];
    const steps = [
      ['moveItem', { sequenceId: 'seq_main', itemId: v1[1]!.id, startMs: 9000 }],
      ['updateClip', { sequenceId: 'seq_main', itemId: v1[0]!.id, volume: 0.5 }],
      ['splitItem', { sequenceId: 'seq_main', itemId: v1[0]!.id, atMs: 2000 }],
      ['setCaptions', { sequenceId: 'seq_main', maxWords: 3 }],
      ['addTrack', { sequenceId: 'seq_main', kind: 'video' }],
    ] as const;
    let version = before.version;
    for (const [name, args] of steps) {
      const r = await op(e, before.id, name, args, version);
      version = r.version;
      changes.push(...(r.changes as Change[]));
    }
    const after = (await e.getProject(before.id)) as unknown as Project;
    const map = applyChanges(normalise(before), changes);
    expect(denormalise(map, projectFrame(after))).toEqual(after);
    // and backwards
    const back = applyChanges(map, invertChanges(changes));
    expect(denormalise(back, projectFrame(before))).toEqual(before);
  });
});
