// C10b: ApplyResult, STALE and JOB_CONFLICT (engine spec "Write order", "Library API" job results).
import { describe, expect, test } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { speechProject, speechTranscript } from '../helpers/speech.ts';
import { content, newStore, readEntries } from '../helpers/store.ts';

const S = 'seq_1';
const vol = (v: number, itemId = 'it_a1') => ({
  op: 'updateClip',
  args: { sequenceId: S, itemId, volume: v },
});
const batch = (...ops: { op: string; args: unknown }[]) => ({ op: 'batch', args: { ops } });

describe('ApplyResult', () => {
  test('a single op: one succeeded result with the touched items and the version', async () => {
    const { store } = await newStore();
    const r = await store.apply(
      { op: 'moveItem', args: { sequenceId: S, itemId: 'it_s1', startMs: 1500 } },
      { actor: 'user' },
    );
    expect(r.version).toBe(1);
    expect(r.changes.map((c) => c.key)).toEqual([`item:${S}/it_s1`]);
    expect(r.results).toEqual([
      {
        op: 'moveItem',
        status: 'succeeded',
        items: [expect.objectContaining({ id: 'it_s1', startMs: 1500, trackId: 'V2' })],
      },
    ]);
  });

  test('a batch: one result per op, each with its own items and report', async () => {
    const { store } = await newStore();
    const r = await store.apply(
      batch(
        vol(0.5),
        { op: 'addTrack', args: { sequenceId: S, kind: 'audio' } },
        vol(0.6, 'it_a2'),
      ),
      { actor: 'user' },
    );
    expect(r.results.map((x) => [x.op, x.status, x.items?.map((i) => i.id)])).toEqual([
      ['updateClip', 'succeeded', ['it_a1']],
      ['addTrack', 'succeeded', []],
      ['updateClip', 'succeeded', ['it_a2']],
    ]);
    expect(r.results[1]!.report).toEqual({ trackId: 'A3' });
    expect(r.version).toBe(1);
  });

  test('a batch with one rejected op applies nothing; that op fails with its error, the others without', async () => {
    const { store, dir } = await newStore();
    const before = content(store.project);
    const r = await store.apply(
      batch(
        vol(0.5),
        { op: 'removeItem', args: { sequenceId: S, itemId: 'it_nope' } },
        vol(0.6, 'it_a2'),
      ),
      { actor: 'user' },
    );
    expect(r.version).toBe(0);
    expect(r.changes).toEqual([]);
    expect(r.results.map((x) => x.status)).toEqual(['failed', 'failed', 'failed']);
    expect(r.results[1]!.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(r.results[0]!.error).toBeUndefined();
    expect(r.results[2]!.error).toBeUndefined();
    expect(content(store.project)).toEqual(before);
    expect(readEntries(dir)).toEqual([]);
  });

  test('a validation failure of a single op is a failed result, not a throw', async () => {
    const { store } = await newStore();
    const r = await store.apply({ op: 'updateClip', args: { sequenceId: S } }, { actor: 'user' });
    expect(r).toMatchObject({
      version: 0,
      changes: [],
      results: [{ op: 'updateClip', status: 'failed' }],
    });
    expect(r.results[0]!.error).toMatchObject({ code: 'VALIDATION' });
  });

  test('a stale baseVersion is conflicted with STALE', async () => {
    const { store } = await newStore();
    await store.apply(vol(0.5), { actor: 'user' });
    const r = await store.apply(batch(vol(0.2), vol(0.3, 'it_a2')), {
      actor: 'agent',
      baseVersion: 0,
    });
    expect(r.version).toBe(1);
    expect(r.results.map((x) => [x.status, x.error?.code])).toEqual([
      ['conflicted', 'STALE'],
      ['conflicted', 'STALE'],
    ]);
    const ok = await store.apply(vol(0.2), { actor: 'agent', baseVersion: 1 });
    expect(ok.version).toBe(2);
  });

  test('jobId: an entry after baseVersion touching a result key is JOB_CONFLICT listing the keys', async () => {
    const { store, dir } = await newStore();
    await store.apply(vol(0.9), { actor: 'user' }); // v1, after the job's base 0
    const r = await store.apply(batch(vol(0.2), vol(0.3, 'it_a2')), {
      actor: 'cli',
      baseVersion: 0,
      jobId: 'job_1',
    });
    expect(r.version).toBe(1);
    expect(r.results.every((x) => x.status === 'conflicted')).toBe(true);
    expect(r.results[0]!.error).toMatchObject({
      code: 'JOB_CONFLICT',
      details: { keys: [`item:${S}/it_a1`] },
    });
    expect(readEntries(dir)).toHaveLength(1);
  });

  test('jobId: an unrelated entry after baseVersion does not block the result', async () => {
    const { store, dir } = await newStore();
    await store.apply(
      { op: 'updateSequence', args: { sequenceId: S, name: 'x' } },
      { actor: 'user' },
    );
    const r = await store.apply(batch(vol(0.2)), { actor: 'cli', baseVersion: 0, jobId: 'job_1' });
    expect(r.version).toBe(2);
    expect(readEntries(dir).at(-1)).toMatchObject({ jobId: 'job_1', actor: 'cli', op: 'batch' });
  });

  test('removePauses dryRun returns ranges from the transcript file and writes nothing', async () => {
    const { store, dir } = await newStore(speechProject());
    mkdirSync(join(dir, 'transcripts'));
    writeFileSync(join(dir, 'transcripts/m_talk.json'), JSON.stringify(speechTranscript));
    const d = await store.apply(
      { op: 'removePauses', args: { sequenceId: S, dryRun: true } },
      { actor: 'agent' },
    );
    expect(d.version).toBe(0);
    expect(d.changes).toEqual([]);
    expect(d.results[0]!.status).toBe('succeeded');
    expect((d.results[0]!.report as { ranges: unknown[] }).ranges).toHaveLength(2);
    expect(readEntries(dir)).toEqual([]);
    const r = await store.apply(
      { op: 'removePauses', args: { sequenceId: S } },
      { actor: 'agent' },
    );
    expect(r.version).toBe(1);
    expect(readEntries(dir)).toHaveLength(1);
  });
});
