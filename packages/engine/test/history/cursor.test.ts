// C9: undo/redo cursor (engine spec "Undo / redo cursor").
import { describe, expect, test } from 'vitest';
import { ProjectStore } from '../../src/history/store.ts';
import type { OpCall } from '../../src/ops/index.ts';
import { templates } from '../helpers/templates.ts';
import { content, newStore, readEntries } from '../helpers/store.ts';

const S = 'seq_1';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomOp(r: () => number): OpCall {
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  switch (pick(['vol', 'name', 'track', 'word', 'split', 'move'])) {
    case 'vol':
      return {
        op: 'updateClip',
        args: {
          sequenceId: S,
          itemId: pick(['it_a1', 'it_a2']),
          volume: Math.round(r() * 200) / 100,
        },
      };
    case 'name':
      return { op: 'updateSequence', args: { sequenceId: S, name: `n${Math.floor(r() * 1000)}` } };
    case 'track':
      return {
        op: 'updateTrack',
        args: { sequenceId: S, trackId: 'V2', name: `t${Math.floor(r() * 99)}` },
      };
    case 'word':
      return {
        op: 'setCaptions',
        args: {
          sequenceId: S,
          overrides: [
            { wordKey: `m_video:r1:${Math.floor(r() * 6)}`, text: `w${Math.floor(r() * 9)}` },
          ],
        },
      };
    case 'split':
      return {
        op: 'splitItem',
        args: { sequenceId: S, itemId: 'it_v1', atMs: 100 + Math.floor(r() * 4800) },
      };
    default:
      return {
        op: 'moveItem',
        args: { sequenceId: S, itemId: 'it_s1', startMs: 1000 + Math.floor(r() * 1500) },
      };
  }
}

describe('undo / redo cursor', () => {
  test('N random ops, undo all, redo all: the exact project at each step', async () => {
    const { store } = await newStore();
    const r = rng(42);
    const states = [content(store.project)];
    for (let i = 0; i < 60; i++) {
      const res = await store.apply(randomOp(r), { actor: 'user' });
      if (res.changes.length > 0) states.push(content(store.project));
    }
    expect(states.length).toBeGreaterThan(30);
    for (let i = states.length - 2; i >= 0; i--) {
      await store.undo({ actor: 'user' });
      expect(content(store.project)).toEqual(states[i]);
    }
    await expect(store.undo({ actor: 'user' })).rejects.toMatchObject({ code: 'NOTHING_TO_UNDO' });
    for (let i = 1; i < states.length; i++) {
      await store.redo({ actor: 'user' });
      expect(content(store.project)).toEqual(states[i]);
    }
    await expect(store.redo({ actor: 'user' })).rejects.toMatchObject({ code: 'NOTHING_TO_REDO' });
  });

  test('undo writes an undo entry with targets; redo a redo entry; versions always grow', async () => {
    const { store, dir } = await newStore();
    await store.apply(
      { op: 'updateSequence', args: { sequenceId: S, name: 'a' } },
      { actor: 'user' },
    );
    const u = await store.undo({ actor: 'user' });
    const rd = await store.redo({ actor: 'user' });
    expect([u.version, rd.version]).toEqual([2, 3]);
    const [, undo, redo] = readEntries(dir);
    expect(undo).toMatchObject({ kind: 'undo', targets: [1], actor: 'user' });
    expect(undo!.changes[0]).toMatchObject({ before: { name: 'a' } });
    expect(redo).toMatchObject({ kind: 'redo', targets: [1] });
    expect(store.project.sequences[0]!.name).toBe('a');
    expect(u.results).toEqual([{ op: 'undo', status: 'succeeded', items: [] }]);
  });

  test('a new op clears the redo stack', async () => {
    const { store } = await newStore();
    await store.apply(
      { op: 'updateSequence', args: { sequenceId: S, name: 'a' } },
      { actor: 'user' },
    );
    await store.undo({ actor: 'user' });
    await store.apply(
      { op: 'updateSequence', args: { sequenceId: S, name: 'b' } },
      { actor: 'user' },
    );
    await expect(store.redo({ actor: 'user' })).rejects.toMatchObject({ code: 'NOTHING_TO_REDO' });
  });

  test('a redo can itself be undone and redone', async () => {
    const { store } = await newStore();
    const name0 = store.project.sequences[0]!.name;
    await store.apply(
      { op: 'updateSequence', args: { sequenceId: S, name: 'a' } },
      { actor: 'user' },
    );
    await store.undo({ actor: 'user' });
    await store.redo({ actor: 'user' });
    await store.undo({ actor: 'user' });
    expect(store.project.sequences[0]!.name).toBe(name0);
    await store.redo({ actor: 'user' });
    expect(store.project.sequences[0]!.name).toBe('a');
  });

  test('undo returns the touched items in results', async () => {
    const { store } = await newStore();
    await store.apply(
      { op: 'updateClip', args: { sequenceId: S, itemId: 'it_a1', volume: 0.3 } },
      { actor: 'user' },
    );
    const u = await store.undo({ actor: 'user' });
    expect(u.results[0]!.items).toEqual([expect.objectContaining({ id: 'it_a1', trackId: 'A1' })]);
    expect(u.results[0]!.items![0]).not.toHaveProperty('volume');
  });

  test('undo depth is 500 entries', async () => {
    const { store } = await newStore();
    for (let i = 0; i < 502; i++) {
      await store.apply(
        { op: 'updateSequence', args: { sequenceId: S, name: `n${i}` } },
        { actor: 'user' },
      );
    }
    for (let i = 0; i < 500; i++) await store.undo({ actor: 'user' });
    expect(store.project.sequences[0]!.name).toBe('n1');
    await expect(store.undo({ actor: 'user' })).rejects.toMatchObject({ code: 'NOTHING_TO_UNDO' });
  }, 60_000);

  test('the cursor is rebuilt on load', async () => {
    const { store, dir, clock } = await newStore();
    for (const n of ['a', 'b', 'c']) {
      await store.apply(
        { op: 'updateSequence', args: { sequenceId: S, name: n } },
        { actor: 'user' },
      );
    }
    await store.undo({ actor: 'user' });
    const again = await ProjectStore.open(dir, { templates, now: clock.now });
    expect(again.project.sequences[0]!.name).toBe('b');
    await again.redo({ actor: 'user' });
    expect(again.project.sequences[0]!.name).toBe('c');
    await again.undo({ actor: 'user' });
    await again.undo({ actor: 'user' });
    expect(again.project.sequences[0]!.name).toBe('a');
  });
});
