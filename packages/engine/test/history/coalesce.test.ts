// C10a: coalescing (engine spec "Coalescing", plan D-15).
import { describe, expect, test } from 'vitest';
import type { ApplyOptions } from '../../src/history/types.ts';
import { content, newStore, readEntries } from '../helpers/store.ts';

const S = 'seq_1';
const vol = (v: number, itemId = 'it_a1') => ({
  op: 'updateClip',
  args: { sequenceId: S, itemId, volume: v },
});

describe('coalescing', () => {
  test('ten ops with one coalesceKey within 1 s are one undo step that restores the first before', async () => {
    const { store, dir, clock } = await newStore();
    const start = content(store.project);
    for (let i = 1; i <= 10; i++) {
      await store.apply(vol(i / 10), { actor: 'user', coalesceKey: 'slider' });
      clock.advance(90);
    }
    const entries = readEntries(dir);
    expect(entries).toHaveLength(10); // append-only
    expect(entries.map((e) => e.replaces)).toEqual([undefined, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const last = entries.at(-1)!;
    expect(last.changes).toHaveLength(1);
    expect(last.changes[0]!.before).not.toHaveProperty('volume');
    expect(last.changes[0]!.after).toMatchObject({ volume: 1 });
    await store.undo({ actor: 'user' });
    expect(content(store.project)).toEqual(start);
    await expect(store.undo({ actor: 'user' })).rejects.toMatchObject({ code: 'NOTHING_TO_UNDO' });
  });

  test('keys of both entries are merged; a key back to its first value drops out', async () => {
    const { store, dir } = await newStore();
    const o: ApplyOptions = { actor: 'user', coalesceKey: 'k' };
    await store.apply(vol(0.5), o);
    await store.apply(vol(0.5, 'it_a2'), o);
    await store.apply(
      { op: 'updateClip', args: { sequenceId: S, itemId: 'it_a1', volume: null } },
      o,
    );
    const last = readEntries(dir).at(-1)!;
    expect(last.changes.map((c) => c.key)).toEqual([`item:${S}/it_a2`]);
  });

  const separate: [string, ApplyOptions, ApplyOptions, number][] = [
    [
      'a different key',
      { actor: 'user', coalesceKey: 'a' },
      { actor: 'user', coalesceKey: 'b' },
      0,
    ],
    [
      'a different actor',
      { actor: 'user', coalesceKey: 'a' },
      { actor: 'agent', coalesceKey: 'a' },
      0,
    ],
    [
      'a different runId',
      { actor: 'agent', runId: 'run_1', coalesceKey: 'a' },
      { actor: 'agent', runId: 'run_2', coalesceKey: 'a' },
      0,
    ],
    [
      'a gap over 1 s',
      { actor: 'user', coalesceKey: 'a' },
      { actor: 'user', coalesceKey: 'a' },
      1001,
    ],
    ['no key', { actor: 'user' }, { actor: 'user' }, 0],
  ];
  test.each(separate)('%s gives separate entries', async (_n, o1, o2, gap) => {
    const { store, dir, clock } = await newStore();
    await store.apply(vol(0.2), o1);
    clock.advance(gap);
    await store.apply(vol(0.3), o2);
    expect(readEntries(dir).at(-1)!.replaces).toBeUndefined();
    await store.undo({ actor: 'user' });
    expect(store.project.sequences[0]!.audioTracks[0]!.items[0]).toMatchObject({ volume: 0.2 });
  });

  test('an entry in between gives separate entries', async () => {
    const { store, dir } = await newStore();
    await store.apply(vol(0.2), { actor: 'user', coalesceKey: 'a' });
    await store.apply(
      { op: 'updateSequence', args: { sequenceId: S, name: 'x' } },
      { actor: 'user' },
    );
    await store.apply(vol(0.3), { actor: 'user', coalesceKey: 'a' });
    expect(readEntries(dir).at(-1)!.replaces).toBeUndefined();
  });

  test('an undo in between gives separate entries', async () => {
    const { store, dir } = await newStore();
    await store.apply(vol(0.2), { actor: 'user', coalesceKey: 'a' });
    await store.apply(vol(0.3, 'it_a2'), { actor: 'user', coalesceKey: 'a' });
    await store.undo({ actor: 'user' });
    await store.apply(vol(0.4), { actor: 'user', coalesceKey: 'a' });
    expect(readEntries(dir).at(-1)!.replaces).toBeUndefined();
  });

  test('the cursor rebuilt on load drops replaced entries', async () => {
    const { store, dir, clock } = await newStore();
    const start = content(store.project);
    await store.apply(vol(0.2), { actor: 'user', coalesceKey: 'a' });
    await store.apply(vol(0.3), { actor: 'user', coalesceKey: 'a' });
    const { ProjectStore } = await import('../../src/history/store.ts');
    const again = await ProjectStore.open(dir, { now: clock.now });
    await again.undo({ actor: 'user' });
    expect(content(again.project)).toEqual(start);
  });
});
