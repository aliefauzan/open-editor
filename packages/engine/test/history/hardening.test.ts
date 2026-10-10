// Review follow-ups for the store: event isolation, S36 under a running store, forward-compatible
// history lines, reserved snapshot names, best-effort log.
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ProjectStore } from '../../src/history/store.ts';
import type { ProjectChangedEvent } from '../../src/history/types.ts';
import { templates } from '../helpers/templates.ts';
import { newStore, readEntries, readProjectFile } from '../helpers/store.ts';

const S = 'seq_1';
const rename = (name: string) => ({ op: 'updateSequence', args: { sequenceId: S, name } });

describe('store hardening', () => {
  test('a throwing project.changed handler does not fail a committed apply', async () => {
    const { store } = await newStore(undefined, {
      onChanged: () => {
        throw new Error('listener bug');
      },
    });
    await expect(store.apply(rename('a'), { actor: 'user' })).resolves.toMatchObject({
      version: 1,
    });
  });

  test('S36: a project made newer by another process fails SCHEMA_TOO_NEW before any lock or write', async () => {
    const { store, dir } = await newStore();
    const raw = { ...readProjectFile(dir), schemaVersion: 3 };
    writeFileSync(join(dir, 'project.json'), JSON.stringify(raw));
    const files = readdirSync(dir).sort();
    let locked = false;
    const s2 = store as unknown as { opts: { hooks?: { at?: (s: string) => void } } };
    s2.opts.hooks = { at: (s) => (locked ||= s === 'locked') };
    await expect(store.apply(rename('a'), { actor: 'user' })).rejects.toMatchObject({
      code: 'SCHEMA_TOO_NEW',
    });
    expect(locked).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(files);
  });

  test('an external write picked up by read() is announced as an external change', async () => {
    const a = await newStore();
    const events: ProjectChangedEvent[] = [];
    const b = await ProjectStore.open(a.dir, { templates, onChanged: (e) => events.push(e) });
    await a.store.apply(rename('x'), { actor: 'cli' });
    expect((await b.read()).sequences[0]!.name).toBe('x');
    expect(events.map((e) => [e.actor, e.version])).toEqual([['external', 1]]);
  });

  test('history lines with fields from a newer engine load and are kept', async () => {
    const { store, dir } = await newStore();
    await store.apply(rename('a'), { actor: 'user' });
    const line = JSON.parse(readFileSync(join(dir, 'history.jsonl'), 'utf8'));
    writeFileSync(join(dir, 'history.jsonl'), `${JSON.stringify({ ...line, future: { x: 1 } })}\n`);
    const again = await ProjectStore.open(dir, { templates });
    expect((await again.history())[0]).toMatchObject({ version: 1, future: { x: 1 } });
  });

  test('an undo entry without targets is not a valid history line', async () => {
    const { store, dir } = await newStore();
    await store.apply(rename('a'), { actor: 'user' });
    await store.apply(rename('b'), { actor: 'user' });
    const lines = readFileSync(join(dir, 'history.jsonl'), 'utf8').trim().split('\n');
    const bad = { ...JSON.parse(lines[0]!), kind: 'undo' };
    writeFileSync(join(dir, 'history.jsonl'), `${JSON.stringify(bad)}\n${lines[1]}\n`);
    await expect(ProjectStore.open(dir)).rejects.toMatchObject({ code: 'HISTORY_CORRUPT' });
  });

  test('snapshot names starting with auto- are reserved for the engine', async () => {
    const { store } = await newStore();
    await expect(store.snapshot('auto-pre-migrate-v1')).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  test('a job does not conflict with its own earlier entries', async () => {
    const { store } = await newStore();
    const o = { actor: 'cli' as const, baseVersion: 0, jobId: 'job_1' };
    await store.apply(rename('a'), o);
    const r = await store.apply(rename('b'), o);
    expect(r.version).toBe(2);
  });

  test('an unwritable logs/ folder does not fail recovery', async () => {
    const { store, dir, clock } = await newStore();
    await store.apply(rename('a'), { actor: 'user' });
    const v1 = readFileSync(join(dir, 'project.json'), 'utf8');
    await store.apply(rename('b'), { actor: 'user' });
    writeFileSync(join(dir, 'project.json'), v1);
    mkdirSync(join(dir, 'logs'));
    chmodSync(join(dir, 'logs'), 0o500);
    try {
      const again = await ProjectStore.open(dir, { templates, now: clock.now });
      expect(again.project.version).toBe(2);
    } finally {
      chmodSync(join(dir, 'logs'), 0o700);
    }
  });

  test('a history line with multi-byte text before a torn line truncates at the right byte', async () => {
    const { store, dir } = await newStore();
    await store.apply(rename('naïve — ünïcødé ✓'), { actor: 'user' });
    const good = readFileSync(join(dir, 'history.jsonl'));
    appendFileSync(join(dir, 'history.jsonl'), Buffer.from([0x7b, 0x22, 0xff, 0xfe]));
    await ProjectStore.open(dir, { templates });
    expect(readFileSync(join(dir, 'history.jsonl')).equals(good)).toBe(true);
    expect(readEntries(dir)).toHaveLength(1);
  });

  test('a failed op result carries a plain error object (IPC-safe)', async () => {
    const { store } = await newStore();
    const r = await store.apply(
      { op: 'removeItem', args: { sequenceId: S, itemId: 'it_nope' } },
      { actor: 'user' },
    );
    const err = r.results[0]!.error;
    expect(err).toMatchObject({ code: 'NOT_FOUND', hint: expect.any(String) });
    expect(err).not.toBeInstanceOf(Error);
    expect(JSON.parse(JSON.stringify(err))).toEqual(err);
  });
});
