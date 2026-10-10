// C12: crash recovery on load (engine spec "Write order, crash recovery, locking").
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ProjectStore } from '../../src/history/store.ts';
import { templates } from '../helpers/templates.ts';
import { content, newStore, readEntries, readProjectFile } from '../helpers/store.ts';

const S = 'seq_1';
const rename = (name: string) => ({ op: 'updateSequence', args: { sequenceId: S, name } });

async function twoVersions() {
  const made = await newStore();
  await made.store.apply(rename('a'), { actor: 'user' });
  await made.store.apply(rename('b'), { actor: 'user' });
  return made;
}

describe('recovery on load', () => {
  test('a torn last history line is truncated', async () => {
    const { dir, clock } = await twoVersions();
    const good = readFileSync(join(dir, 'history.jsonl'), 'utf8');
    appendFileSync(join(dir, 'history.jsonl'), '{"version":3,"ts":"2026-');
    const store = await ProjectStore.open(dir, { templates, now: clock.now });
    expect(readFileSync(join(dir, 'history.jsonl'), 'utf8')).toBe(good);
    expect(store.project.version).toBe(2);
  });

  test('an entry at version + 1 (crash between history append and project write) is re-applied', async () => {
    const { dir, clock, store } = await twoVersions();
    const v1Project = readFileSync(join(dir, 'project.json'), 'utf8');
    await store.apply(rename('c'), { actor: 'user' });
    const v3 = content(store.project);
    const lines = readEntries(dir).length;
    writeFileSync(join(dir, 'project.json'), v1Project); // project.json back at v2, history at v3
    const again = await ProjectStore.open(dir, { templates, now: clock.now });
    expect(again.project.version).toBe(3);
    expect(content(again.project)).toEqual(v3);
    expect(readProjectFile(dir).version).toBe(3);
    expect(readEntries(dir)).toHaveLength(lines); // no new line
    expect(readFileSync(join(dir, 'logs/engine.log'), 'utf8')).toMatch(/recovered version 3/);
  });

  test('a coalesced entry that returns a key to its start is recovered from the replaced entry', async () => {
    const { store, dir, clock } = await newStore();
    const vol = (v: number | null) => ({
      op: 'updateClip',
      args: { sequenceId: S, itemId: 'it_a1', volume: v },
    });
    await store.apply(vol(0.5), { actor: 'user', coalesceKey: 'drag' }); // v1: volume 0.5
    const atV1 = readFileSync(join(dir, 'project.json'), 'utf8');
    await store.apply(vol(null), { actor: 'user', coalesceKey: 'drag' }); // v2: back to no volume
    expect(readEntries(dir).at(-1)!.changes).toEqual([]);
    const v2 = content(store.project);
    writeFileSync(join(dir, 'project.json'), atV1); // crash before the v2 project write
    const again = await ProjectStore.open(dir, { templates, now: clock.now });
    expect(again.project.version).toBe(2);
    expect(content(again.project)).toEqual(v2);
  });

  test('any other gap fails HISTORY_CORRUPT with a hint to restore from snapshots/', async () => {
    const { dir } = await twoVersions();
    const lines = readFileSync(join(dir, 'history.jsonl'), 'utf8').split('\n');
    writeFileSync(join(dir, 'history.jsonl'), `${lines[0]}\n`); // history at v1, project at v2
    await expect(ProjectStore.open(dir)).rejects.toMatchObject({
      code: 'HISTORY_CORRUPT',
      hint: expect.stringContaining('snapshots/'),
    });
  });

  test('a project ahead of its history by two versions is HISTORY_CORRUPT', async () => {
    const { dir } = await twoVersions();
    writeFileSync(join(dir, 'history.jsonl'), '');
    await expect(ProjectStore.open(dir)).rejects.toMatchObject({ code: 'HISTORY_CORRUPT' });
  });

  test('a bad line that is not the last one is HISTORY_CORRUPT, not truncated', async () => {
    const { dir } = await twoVersions();
    const lines = readFileSync(join(dir, 'history.jsonl'), 'utf8').split('\n');
    const text = `${lines[0]}\nnot json\n${lines[1]}\n`;
    writeFileSync(join(dir, 'history.jsonl'), text);
    await expect(ProjectStore.open(dir)).rejects.toMatchObject({ code: 'HISTORY_CORRUPT' });
    expect(readFileSync(join(dir, 'history.jsonl'), 'utf8')).toBe(text);
  });

  test('a missing project folder is PROJECT_NOT_FOUND', async () => {
    await expect(ProjectStore.open('/nonexistent/vox/p_x')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
  });
});
