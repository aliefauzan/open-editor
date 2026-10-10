// C14: rotation at 5,000 entries + snapshot; snapshot / restoreSnapshot / listSnapshots.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { ProjectStore } from '../../src/history/store.ts';
import { templates } from '../helpers/templates.ts';
import { content, newStore, readEntries } from '../helpers/store.ts';

const S = 'seq_1';
const rename = (name: string) => ({ op: 'updateSequence', args: { sequenceId: S, name } });

describe('rotation', () => {
  test('at rotateAt entries, all but the newest `keep` move to history/<firstVersion>.jsonl.gz with a snapshot', async () => {
    const { store, dir, clock } = await newStore(undefined, { rotateAt: 20, keep: 5 });
    for (let i = 1; i <= 20; i++) await store.apply(rename(`n${i}`), { actor: 'user' });
    const kept = readEntries(dir);
    expect(kept.map((e) => e.version)).toEqual([16, 17, 18, 19, 20]);
    const gz = gunzipSync(readFileSync(join(dir, 'history/1.jsonl.gz'))).toString('utf8');
    expect(
      gz
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).version),
    ).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    const snap = JSON.parse(readFileSync(join(dir, 'history/snapshot-20.json'), 'utf8'));
    expect(snap.version).toBe(20);
    expect(snap.sequences[0].name).toBe('n20');
    // undo keeps working across the rotation, also after a reload
    const again = await ProjectStore.open(dir, {
      templates,
      now: clock.now,
      rotateAt: 20,
      keep: 5,
    });
    await again.undo({ actor: 'user' });
    expect(again.project.sequences[0]!.name).toBe('n19');
    for (let i = 21; i <= 35; i++) await again.apply(rename(`n${i}`), { actor: 'user' });
    expect(existsSync(join(dir, 'history/16.jsonl.gz'))).toBe(true);
  });

  test('the default threshold is 5,000 entries keeping 500', async () => {
    const { DEFAULT_ROTATE_AT, DEFAULT_KEEP } = await import('../../src/history/store.ts');
    expect([DEFAULT_ROTATE_AT, DEFAULT_KEEP]).toEqual([5000, 500]);
  });

  test('history({ sinceVersion }) lists the loaded entries after a version', async () => {
    const { store } = await newStore();
    for (const n of ['a', 'b', 'c']) await store.apply(rename(n), { actor: 'user' });
    expect((await store.history({ sinceVersion: 1 })).map((e) => e.version)).toEqual([2, 3]);
    expect((await store.history()).map((e) => e.version)).toEqual([1, 2, 3]);
  });
});

describe('snapshots', () => {
  test('snapshot copies project.json to snapshots/<name>.json; names are never replaced', async () => {
    const { store, dir } = await newStore();
    await store.apply(rename('a'), { actor: 'user' });
    await store.snapshot('before-cut');
    expect(readFileSync(join(dir, 'snapshots/before-cut.json'), 'utf8')).toBe(
      readFileSync(join(dir, 'project.json'), 'utf8'),
    );
    await expect(store.snapshot('before-cut')).rejects.toMatchObject({ code: 'SNAPSHOT_EXISTS' });
    expect(await store.listSnapshots()).toEqual([{ name: 'before-cut', version: 1 }]);
  });

  test.each(['../x', 'a/b', '.', '..', '', 'x'.repeat(101), 'a\u0000b'])(
    'snapshot name %j is VALIDATION',
    async (name) => {
      const { store } = await newStore();
      await expect(store.snapshot(name)).rejects.toMatchObject({ code: 'VALIDATION' });
    },
  );

  test('restoreSnapshot is one undoable entry', async () => {
    const { store, dir } = await newStore();
    await store.apply(rename('a'), { actor: 'user' });
    await store.snapshot('s1');
    const atSnap = content(store.project);
    await store.apply(rename('b'), { actor: 'user' });
    await store.apply(
      { op: 'removeItem', args: { sequenceId: S, itemId: 'it_s1' } },
      { actor: 'user' },
    );
    const beforeRestore = content(store.project);
    const r = await store.apply({ op: 'restoreSnapshot', args: { name: 's1' } }, { actor: 'user' });
    expect(r.version).toBe(4);
    expect(content(store.project)).toEqual(atSnap);
    expect(readEntries(dir)).toHaveLength(4);
    await store.undo({ actor: 'user' });
    expect(content(store.project)).toEqual(beforeRestore);
  });

  test('restoring a missing snapshot fails NOT_FOUND', async () => {
    const { store } = await newStore();
    const r = await store.apply(
      { op: 'restoreSnapshot', args: { name: 'nope' } },
      { actor: 'user' },
    );
    expect(r.results[0]).toMatchObject({ status: 'failed', error: { code: 'NOT_FOUND' } });
  });
});
