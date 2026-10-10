// C8: change records are the diff of the normalised before/after views.
import { describe, expect, test } from 'vitest';
import { newStore, readEntries } from '../helpers/store.ts';

const S = 'seq_1';

describe('change records', () => {
  test('a created entity has before null, a deleted one after null', async () => {
    const { store, dir } = await newStore();
    await store.apply(
      { op: 'addTrack', args: { sequenceId: S, kind: 'video' } },
      { actor: 'user' },
    );
    await store.apply(
      { op: 'removeItem', args: { sequenceId: S, itemId: 'it_s1' } },
      { actor: 'user' },
    );
    const [add, remove] = readEntries(dir);
    const created = add!.changes.find((c) => c.key === `track:${S}/V3`);
    expect(created).toMatchObject({ before: null, after: { id: 'V3' } });
    expect(add!.changes.map((c) => c.key)).toEqual([`sequence:${S}`, `track:${S}/V3`]);
    const deleted = remove!.changes.find((c) => c.key === `item:${S}/it_s1`);
    expect(deleted).toMatchObject({ before: { id: 'it_s1', trackId: 'V2' }, after: null });
  });

  test('only changed entities are recorded; items carry their trackId', async () => {
    const { store, dir } = await newStore();
    await store.apply(
      { op: 'updateClip', args: { sequenceId: S, itemId: 'it_a1', volume: 0.5 } },
      { actor: 'user' },
    );
    const [e] = readEntries(dir);
    expect(e!.changes).toHaveLength(1);
    expect(e!.changes[0]).toMatchObject({
      key: `item:${S}/it_a1`,
      before: { trackId: 'A1' },
      after: { trackId: 'A1', volume: 0.5 },
    });
  });

  test('a caption word edit records one captionOverride entity, not the caption track', async () => {
    const { store, dir } = await newStore();
    await store.apply(
      {
        op: 'setCaptions',
        args: { sequenceId: S, overrides: [{ wordKey: 'm_video:r1:5', text: 'yes' }] },
      },
      { actor: 'user' },
    );
    const [e] = readEntries(dir);
    expect(e!.changes).toEqual([
      {
        key: `captionOverride:${S}/m_video:r1:5`,
        before: null,
        after: { wordKey: 'm_video:r1:5', text: 'yes' },
      },
    ]);
  });

  test('the entry records version, ts, kind, actor, op and args', async () => {
    const { store, dir, clock } = await newStore();
    const args = { sequenceId: S, itemId: 'it_a1', volume: 0.5 };
    await store.apply({ op: 'updateClip', args }, { actor: 'agent', runId: 'run_1' });
    const [e] = readEntries(dir);
    expect(e).toMatchObject({
      version: 1,
      ts: clock.now().toISOString(),
      kind: 'op',
      actor: 'agent',
      runId: 'run_1',
      op: 'updateClip',
      args,
    });
  });

  test('an op that changes nothing writes no entry and keeps the version', async () => {
    const { store, dir } = await newStore();
    const r = await store.apply(
      { op: 'updateTrack', args: { sequenceId: S, trackId: 'V1', locked: false } },
      { actor: 'user' },
    );
    expect(r.version).toBe(0);
    expect(r.changes).toEqual([]);
    expect(r.results).toEqual([{ op: 'updateTrack', status: 'succeeded', items: [] }]);
    expect(readEntries(dir)).toEqual([]);
  });

  test('updatedAt is stamped on each write and never recorded as a change', async () => {
    const { store, dir, clock } = await newStore();
    clock.advance(5000);
    await store.apply(
      { op: 'updateSequence', args: { sequenceId: S, name: 'n' } },
      { actor: 'user' },
    );
    expect(store.project.meta.updatedAt).toBe(clock.now().toISOString());
    expect(readEntries(dir)[0]!.changes.map((c) => c.key)).toEqual([`sequence:${S}`]);
  });
});
