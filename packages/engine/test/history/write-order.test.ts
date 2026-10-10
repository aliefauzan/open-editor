// C11: applyOp write order (lock → external-change check → STALE → op → history append + fsync →
// temp + fsync + rename + dir fsync → unlock → event).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ProjectStore, type WriteStep } from '../../src/history/store.ts';
import type { ProjectChangedEvent } from '../../src/history/types.ts';
import { templates } from '../helpers/templates.ts';
import { newStore, readEntries, readProjectFile } from '../helpers/store.ts';

const S = 'seq_1';
const rename = (name: string) => ({ op: 'updateSequence', args: { sequenceId: S, name } });

describe('write order', () => {
  test('each step sees the files in the documented state', async () => {
    const seen: Record<string, unknown> = {};
    const events: ProjectChangedEvent[] = [];
    let dir = '';
    const at = (step: WriteStep) => {
      seen[step] = {
        lock: existsSync(join(dir, 'project.lock')),
        lines: readEntries(dir).length,
        version: readProjectFile(dir).version,
        temp: readdirSync(dir).some((f) => f.startsWith('.project.json.tmp')),
      };
    };
    const made = await newStore(undefined, {
      hooks: { at },
      onChanged: (e) => {
        events.push(e);
        seen['event'] = { lock: existsSync(join(dir, 'project.lock')) };
      },
    });
    dir = made.dir;
    await made.store.apply(rename('a'), { actor: 'agent', runId: 'run_1' });
    expect(seen).toEqual({
      locked: { lock: true, lines: 0, version: 0, temp: false },
      'history-appended': { lock: true, lines: 1, version: 0, temp: false },
      'temp-written': { lock: true, lines: 1, version: 0, temp: true },
      renamed: { lock: true, lines: 1, version: 1, temp: false },
      event: { lock: false },
    });
    expect(events).toEqual([
      {
        projectId: 'p_test',
        version: 1,
        actor: 'agent',
        runId: 'run_1',
        op: 'updateSequence',
        changes: [expect.objectContaining({ key: `sequence:${S}` })],
      },
    ]);
  });

  test('a failed op takes and releases the lock but writes nothing and emits nothing', async () => {
    let events = 0;
    const { store, dir } = await newStore(undefined, { onChanged: () => events++ });
    await store.apply(
      { op: 'removeItem', args: { sequenceId: S, itemId: 'it_x' } },
      { actor: 'user' },
    );
    expect(existsSync(join(dir, 'project.lock'))).toBe(false);
    expect(events).toBe(0);
    expect(readProjectFile(dir).version).toBe(0);
  });

  test('another process wrote: reload, emit an external change, then apply on top', async () => {
    const a = await newStore();
    const events: ProjectChangedEvent[] = [];
    const b = await ProjectStore.open(a.dir, {
      templates,
      now: a.clock.now,
      onChanged: (e) => events.push(e),
    });
    await a.store.apply(rename('from-a'), { actor: 'cli' });
    const r = await b.apply(
      { op: 'updateTrack', args: { sequenceId: S, trackId: 'V2', name: 'from-b' } },
      { actor: 'user' },
    );
    expect(r.version).toBe(2);
    expect(events.map((e) => [e.actor, e.version])).toEqual([
      ['external', 1],
      ['user', 2],
    ]);
    expect(events[0]!.changes.map((c) => c.key)).toEqual([`sequence:${S}`]);
    expect(b.project.sequences[0]!.name).toBe('from-a');
    expect(readProjectFile(a.dir).sequences[0]!.name).toBe('from-a');
  });

  test('a stale baseVersion is checked against the reloaded version', async () => {
    const a = await newStore();
    const b = await ProjectStore.open(a.dir, { templates, now: a.clock.now });
    await a.store.apply(rename('x'), { actor: 'cli' });
    const r = await b.apply(rename('y'), { actor: 'agent', baseVersion: 0 });
    expect(r.results[0]).toMatchObject({ status: 'conflicted', error: { code: 'STALE' } });
  });

  test('a lock held by a live process of this host makes apply wait, then LOCKED (thrown)', async () => {
    const { store, dir } = await newStore(undefined, { lock: { timeoutMs: 200 } });
    const { acquireLock } = await import('../../src/history/lock.ts');
    const release = await acquireLock(dir);
    await expect(store.apply(rename('z'), { actor: 'user' })).rejects.toMatchObject({
      code: 'LOCKED',
    });
    await release();
    await expect(store.apply(rename('z'), { actor: 'user' })).resolves.toMatchObject({
      version: 1,
    });
  });

  test('concurrent applies in one process are serialised', async () => {
    const { store, dir } = await newStore();
    const rs = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.apply(
          { op: 'updateClip', args: { sequenceId: S, itemId: 'it_a1', volume: (i + 1) / 10 } },
          { actor: 'user' },
        ),
      ),
    );
    expect(rs.map((r) => r.version).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(readEntries(dir).map((e) => e.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('history and project files are private (0600)', async () => {
    const { store, dir } = await newStore();
    await store.apply(rename('a'), { actor: 'user' });
    const { statSync } = await import('node:fs');
    expect(statSync(join(dir, 'project.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'history.jsonl')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
