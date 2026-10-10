// C10: undoRun with and without conflicts (engine spec "Undo an agent run").
import { describe, expect, test } from 'vitest';
import { content, newStore, readEntries } from '../helpers/store.ts';

const S = 'seq_1';
const agent = { actor: 'agent' as const, runId: 'run_a' };

describe('undoRun', () => {
  test('reverts every entry of the run in one undo entry, keeping the user edits', async () => {
    const { store, dir } = await newStore();
    const start = content(store.project);
    await store.apply(
      { op: 'updateClip', args: { sequenceId: S, itemId: 'it_a1', volume: 0.4 } },
      agent,
    );
    await store.apply(
      { op: 'updateTrack', args: { sequenceId: S, trackId: 'V2', name: 'user' } },
      { actor: 'user' },
    );
    await store.apply(
      { op: 'updateClip', args: { sequenceId: S, itemId: 'it_a1', volume: 0.2 } },
      agent,
    );
    await store.apply({ op: 'updateSequence', args: { sequenceId: S, name: 'agent' } }, agent);
    const r = await store.undoRun('run_a', { actor: 'user' });
    expect(r.version).toBe(5);
    const last = readEntries(dir).at(-1)!;
    expect(last).toMatchObject({ kind: 'undo', targets: [1, 3, 4] });
    expect(last.changes.map((c) => c.key).sort()).toEqual([`item:${S}/it_a1`, `sequence:${S}`]);
    const expected = structuredClone(start) as {
      sequences: { videoTracks: { name?: string }[] }[];
    };
    expected.sequences[0]!.videoTracks[1]!.name = 'user';
    expect(content(store.project)).toEqual(expected);
  });

  test('redo after undoRun re-applies the whole run', async () => {
    const { store } = await newStore();
    await store.apply(
      { op: 'updateClip', args: { sequenceId: S, itemId: 'it_a1', volume: 0.4 } },
      agent,
    );
    await store.apply({ op: 'updateSequence', args: { sequenceId: S, name: 'agent' } }, agent);
    const after = content(store.project);
    await store.undoRun('run_a', { actor: 'user' });
    await store.redo({ actor: 'user' });
    expect(content(store.project)).toEqual(after);
  });

  test('a later edit of a run key by someone else is UNDO_CONFLICT listing keys and item ids; nothing changes', async () => {
    const { store, dir } = await newStore();
    await store.apply(
      { op: 'updateClip', args: { sequenceId: S, itemId: 'it_a1', volume: 0.4 } },
      agent,
    );
    await store.apply({ op: 'updateSequence', args: { sequenceId: S, name: 'agent' } }, agent);
    await store.apply(
      { op: 'updateClip', args: { sequenceId: S, itemId: 'it_a1', volume: 0.9 } },
      { actor: 'user' },
    );
    const before = content(store.project);
    const lines = readEntries(dir).length;
    await expect(store.undoRun('run_a', { actor: 'user' })).rejects.toMatchObject({
      code: 'UNDO_CONFLICT',
      details: { keys: [`item:${S}/it_a1`], itemIds: ['it_a1'] },
    });
    expect(content(store.project)).toEqual(before);
    expect(readEntries(dir)).toHaveLength(lines);
  });

  test('caption conflicts are per word: a user edit of another word does not conflict', async () => {
    const { store } = await newStore();
    const word = (k: number, text: string) => ({
      op: 'setCaptions',
      args: { sequenceId: S, overrides: [{ wordKey: `m_video:r1:${k}`, text }] },
    });
    await store.apply(word(3, 'agent'), agent);
    await store.apply(word(4, 'user'), { actor: 'user' });
    await store.undoRun('run_a', { actor: 'user' });
    const keys = store.project.sequences[0]!.captions!.overrides.map((o) => o.wordKey);
    expect(keys).toContain('m_video:r1:4');
    expect(keys).not.toContain('m_video:r1:3');
  });

  test('an unknown or already undone run is NOTHING_TO_UNDO', async () => {
    const { store } = await newStore();
    await expect(store.undoRun('run_x', { actor: 'user' })).rejects.toMatchObject({
      code: 'NOTHING_TO_UNDO',
    });
    await store.apply({ op: 'updateSequence', args: { sequenceId: S, name: 'agent' } }, agent);
    await store.undoRun('run_a', { actor: 'user' });
    await expect(store.undoRun('run_a', { actor: 'user' })).rejects.toMatchObject({
      code: 'NOTHING_TO_UNDO',
    });
  });
});
