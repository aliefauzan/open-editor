// Quick clips through `engine.jobs` on the offline project (phase 05 steps 12, 12b; engine spec
// "Quick clips", plan D-11, D-15): sentence-bounded ranges within the bounds, no overlaps, the same
// ranges on a second run, fewer clips reported, one sequence per pick (base style, sourceRange, a
// linked V1/A1 pair with `auto` framing, captions base/plain maxWords 3, no scenes), registered
// scorers (pick changes, prompt passed, a throwing scorer falls back, only a shortlist of
// candidates sent: D-75), video highlights changing the heuristic pick (D-75), one history entry
// and one undo, and an NTSC source giving a 30000/1001 sequence. The selection rules on crafted inputs are in
// quick-clips-select.test.ts.
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { makeOfflineProject, type OfflineProject } from '../../../scripts/make-offline-project.ts';
import {
  openEngine,
  sentenceUnits,
  type Engine,
  type QuickClipsResult,
  type ScorerInput,
} from '../src/api.ts';
import type { JobInfo } from '../src/jobs.ts';
import { TranscriptSchema, type Sequence, type Transcript } from '../src/model/schema.ts';
import { tempDir } from './helpers/store.ts';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { SCORER_MIN_CANDIDATES } from '../src/stages/quickClips.ts';
import { REPO_STYLES } from './export/project.ts';

const OPTS = { count: 3, minMs: 4000, maxMs: 8000 };

const newEngine = (): Engine =>
  openEngine({
    projectsDir: join(tempDir('vox-quick-'), 'Projects'),
    stylesDirs: [REPO_STYLES],
    config: async () => ({}),
  });

async function quick(e: Engine, args: Record<string, unknown>): Promise<JobInfo<QuickClipsResult>> {
  return (await e.jobs.wait(e.jobs.start('quickClips', args))) as JobInfo<QuickClipsResult>;
}

let e: Engine;
let off: OfflineProject;
let transcript: Transcript;
beforeAll(async () => {
  e = newEngine();
  off = await makeOfflineProject(e);
  const m = (await e.getProject(off.projectId)).media[0]!;
  transcript = TranscriptSchema.parse(
    JSON.parse(readFileSync(join(off.dir, m.transcriptPath!), 'utf8')),
  );
}, 60_000);

describe('quickClips job (step 12)', () => {
  let r: QuickClipsResult;
  let seqs: Sequence[];
  beforeAll(async () => {
    const job = await quick(e, { projectId: off.projectId, mediaId: off.mediaId, ...OPTS });
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    r = job.result!;
    const p = await e.getProject(off.projectId);
    seqs = r.sequenceIds.map((id) => p.sequences.find((s) => s.id === id)!);
  });

  test('3 clips on sentence boundaries, within the bounds, no overlaps', () => {
    expect(r.clips).toHaveLength(3);
    expect(r.scorer).toBe('heuristic');
    expect(r.note).toBeUndefined();
    const units = sentenceUnits(transcript.words);
    for (const c of r.clips) {
      const len = c.endMs - c.startMs;
      expect(len).toBeGreaterThanOrEqual(OPTS.minMs);
      expect(len).toBeLessThanOrEqual(OPTS.maxMs);
      // starts in the lead-in of a unit's first word, ends at a unit's last word
      expect(units.some((u) => c.startMs <= u.startMs && u.startMs - c.startMs <= 120)).toBe(true);
      expect(units.some((u) => u.endMs === c.endMs)).toBe(true);
    }
    for (const a of r.clips)
      for (const b of r.clips)
        if (a !== b) expect(a.endMs <= b.startMs || b.endMs <= a.startMs).toBe(true);
  });

  test('each pick is a base sequence with sourceRange, a linked auto V1/A1 pair and plain captions', () => {
    seqs.forEach((s, n) => {
      const c = r.clips[n]!;
      expect(s.name).toBe(`Clip ${n + 1}`);
      expect(s.styleId).toBe('base');
      expect(s.canvas).toEqual({ width: 1080, height: 1920, fps: { num: 30, den: 1 } });
      expect(s.sourceRange).toEqual({ mediaId: off.mediaId, inMs: c.startMs, outMs: c.endMs });
      const items = [...s.videoTracks, ...s.audioTracks].flatMap((t) =>
        t.items.map((i) => ({ ...i, track: t.id })),
      );
      expect(items.map((i) => [i.track, i.type])).toEqual([
        ['V1', 'media'],
        ['A1', 'media'],
      ]);
      const [v, a] = items as ((typeof items)[number] & { type: 'media' })[];
      expect(v!.frame?.mode).toBe('auto');
      expect(v!.linkId).toBeDefined();
      expect(a!.linkId).toBe(v!.linkId);
      expect([a!.startMs, a!.inMs, a!.durationMs]).toEqual([v!.startMs, v!.inMs, v!.durationMs]);
      expect(Math.abs(v!.inMs - c.startMs)).toBeLessThanOrEqual(34);
      expect(s.captions).toMatchObject({
        enabled: true,
        sourceTrackIds: ['A1'],
        preset: 'base/plain',
        maxWords: 3,
      });
    });
  });

  test('same input → same ranges', async () => {
    const e2 = newEngine();
    const o2 = await makeOfflineProject(e2);
    const again = await quick(e2, { projectId: o2.projectId, mediaId: o2.mediaId, ...OPTS });
    expect(again.result!.clips.map((c) => [c.startMs, c.endMs])).toEqual(
      r.clips.map((c) => [c.startMs, c.endMs]),
    );
  }, 60_000);

  test('one history entry with the job id; one undo removes every clip', async () => {
    const e2 = newEngine();
    const o2 = await makeOfflineProject(e2);
    const before = (await e2.getProject(o2.projectId)).sequences.map((s) => s.id);
    const job = await quick(e2, { projectId: o2.projectId, mediaId: o2.mediaId, ...OPTS });
    const h = await e2.history(o2.projectId);
    const mine = h.filter((x) => x.jobId === job.id);
    expect(mine).toHaveLength(1);
    expect(h.at(-1)!.jobId).toBe(job.id);
    await e2.undo(o2.projectId);
    expect((await e2.getProject(o2.projectId)).sequences.map((s) => s.id)).toEqual(before);
  }, 60_000);

  test('an agent run id on the job lands on the entry; undoRun removes the clips (D-50)', async () => {
    const e2 = newEngine();
    const o2 = await makeOfflineProject(e2);
    const before = (await e2.getProject(o2.projectId)).sequences.map((s) => s.id);
    const job = await quick(e2, {
      projectId: o2.projectId,
      mediaId: o2.mediaId,
      ...OPTS,
      actor: 'agent',
      runId: 'run_quick0001',
    });
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    const entry = (await e2.history(o2.projectId)).at(-1)!;
    expect(entry).toMatchObject({ actor: 'agent', runId: 'run_quick0001', jobId: job.id });
    await e2.undoRun(o2.projectId, 'run_quick0001');
    expect((await e2.getProject(o2.projectId)).sequences.map((s) => s.id)).toEqual(before);
  }, 60_000);
});

describe('quickClips options and scorers (steps 12, 12b)', () => {
  test('too few candidates → fewer clips, reported', async () => {
    const job = await quick(e, {
      projectId: off.projectId,
      mediaId: off.mediaId,
      count: 3,
      minMs: 15000,
      maxMs: 20000,
    });
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    expect(job.result!.clips.length).toBeLessThan(3);
    expect(job.result!.clips.length).toBeGreaterThan(0);
    expect(job.result!.note).toMatch(/^Found \d of 3 clips/);
  });

  test('a registered scorer gets the job’s runId (none for a job outside a run)', async () => {
    const e2 = newEngine();
    const o2 = await makeOfflineProject(e2);
    const seen: ScorerInput[] = [];
    e2.quickClips.registerScorer('fake', (input) => {
      seen.push(input);
      return input.candidates.map((c) => c.startMs);
    });
    const args = { projectId: o2.projectId, mediaId: o2.mediaId, ...OPTS, count: 1 };
    await quick(e2, { ...args, actor: 'agent', runId: 'run_tagged01' });
    await quick(e2, args);
    expect(seen.map((s) => s.runId)).toEqual(['run_tagged01', undefined]);
    expect('runId' in seen[1]!).toBe(false);
  });

  test('scorerMs: the time spent in a registered scorer, also when it fails; absent without one', async () => {
    const e2 = newEngine();
    const o2 = await makeOfflineProject(e2);
    const args = { projectId: o2.projectId, mediaId: o2.mediaId, ...OPTS, count: 1 };
    const plain = (await quick(e2, args)).result!;
    expect(plain.scorerMs).toBeUndefined();
    const wait = () => new Promise((r) => setTimeout(r, 120));
    e2.quickClips.registerScorer('slow', async (input) => {
      await wait();
      return input.candidates.map((c) => c.startMs);
    });
    const slow = (await quick(e2, args)).result!;
    expect(slow.scorer).toBe('slow');
    expect(Number.isInteger(slow.scorerMs)).toBe(true);
    expect(slow.scorerMs).toBeGreaterThanOrEqual(100);
    e2.quickClips.registerScorer('broken', async () => {
      await wait();
      throw new Error('model offline');
    });
    const fell = (await quick(e2, args)).result!;
    expect(fell.scorer).toBe('heuristic');
    expect(fell.scorerMs).toBeGreaterThanOrEqual(100);
  }, 60_000);

  test('a registered scorer changes the pick and gets the prompt; a throwing one falls back', async () => {
    const e2 = newEngine();
    const o2 = await makeOfflineProject(e2);
    const base = (
      await quick(e2, { projectId: o2.projectId, mediaId: o2.mediaId, ...OPTS, count: 1 })
    ).result!;
    const seen: ScorerInput[] = [];
    // prefers the latest candidate: the opposite of the heuristic's earlier-start tie rule
    e2.quickClips.registerScorer('fake', (input) => {
      seen.push(input);
      return input.candidates.map((c) => c.startMs);
    });
    expect(e2.quickClips.scorers()).toEqual(['fake']);
    const faked = (
      await quick(e2, {
        projectId: o2.projectId,
        mediaId: o2.mediaId,
        ...OPTS,
        count: 1,
        prompt: 'moments about captions',
      })
    ).result!;
    expect(faked.scorer).toBe('fake');
    expect([faked.clips[0]!.startMs, faked.clips[0]!.endMs]).not.toEqual([
      base.clips[0]!.startMs,
      base.clips[0]!.endMs,
    ]);
    expect(seen[0]!.prompt).toBe('moments about captions');
    expect(seen[0]!.candidates.length).toBe(faked.candidates);
    expect(seen[0]!.candidates[0]).toEqual({
      index: 0,
      startMs: expect.any(Number),
      endMs: expect.any(Number),
      text: expect.any(String),
    });

    // `heuristic` forces the built-in scorer, and the prompt does not change its pick
    const forced = (
      await quick(e2, {
        projectId: o2.projectId,
        mediaId: o2.mediaId,
        ...OPTS,
        count: 1,
        scorer: 'heuristic',
        prompt: 'x',
      })
    ).result!;
    expect(forced.scorer).toBe('heuristic');
    expect(forced.clips.map((c) => [c.startMs, c.endMs])).toEqual(
      base.clips.map((c) => [c.startMs, c.endMs]),
    );

    e2.quickClips.registerScorer('broken', () => {
      throw new Error('model offline');
    });
    const fell = (
      await quick(e2, { projectId: o2.projectId, mediaId: o2.mediaId, ...OPTS, count: 1 })
    ).result!;
    expect(fell.scorer).toBe('heuristic');
    expect(fell.scorerError).toEqual({ scorer: 'broken', message: 'model offline' });
    expect(fell.clips.map((c) => [c.startMs, c.endMs])).toEqual(
      base.clips.map((c) => [c.startMs, c.endMs]),
    );

    const unknown = await quick(e2, {
      projectId: o2.projectId,
      mediaId: o2.mediaId,
      ...OPTS,
      scorer: 'nope',
    });
    expect(unknown.error?.code).toBe('NOT_FOUND');
  }, 60_000);

  test('a registered scorer gets only the shortlist: the heuristic best, max(30, 2 × count) (D-75)', async () => {
    const e2 = newEngine();
    const o2 = await makeOfflineProject(e2);
    // 16 one-second sentences: 136 runs of whole sentences
    const words = Array.from({ length: 16 }, (_, k) => ({
      text: k % 3 === 0 ? `Point ${k}?` : `Point ${k}.`,
      startMs: k * 1200,
      endMs: k * 1200 + 1000,
      kind: 'word' as const,
    }));
    await writeFile(
      join(o2.dir, 'transcripts', 'many.json'),
      JSON.stringify({
        language: 'en',
        words,
        speechRegions: words.map((x) => ({ startMs: x.startMs, endMs: x.endMs })),
      }),
    );
    await e2.applyOp(
      o2.projectId,
      {
        op: 'updateMedia',
        args: {
          mediaId: o2.mediaId,
          patch: { transcriptPath: 'transcripts/many.json', transcriptRev: 'many' },
        },
      } as never,
      { actor: 'cli' },
    );
    const wide = { projectId: o2.projectId, mediaId: o2.mediaId, minMs: 1000, maxMs: 20_000 };
    const plain = (await quick(e2, { ...wide, count: 1 })).result!;
    expect(plain.scorerCandidates).toBeUndefined();
    expect(plain.candidates).toBeGreaterThan(SCORER_MIN_CANDIDATES * 2);
    const seen: ScorerInput[] = [];
    e2.quickClips.registerScorer('fake', (input) => {
      seen.push(input);
      return input.candidates.map((c) => c.startMs);
    });
    const r = (await quick(e2, { ...wide, count: 1 })).result!;
    expect(r.scorer).toBe('fake');
    expect(r.candidates).toBe(plain.candidates);
    expect(r.scorerCandidates).toBe(SCORER_MIN_CANDIDATES);
    expect(seen[0]!.candidates).toHaveLength(SCORER_MIN_CANDIDATES);
    // in candidate order, each with its own index; the heuristic's best is among them
    const idx = seen[0]!.candidates.map((c) => c.index);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(plain.clips[0]!.startMs).toBeOneOf(seen[0]!.candidates.map((c) => c.startMs));
    // the fake prefers the latest start: the pick is the latest start of the shortlist
    const latest = Math.max(...seen[0]!.candidates.map((c) => c.startMs));
    expect(r.clips[0]!.startMs).toBe(latest);

    const many = (await quick(e2, { ...wide, count: 20 })).result!;
    expect(many.scorerCandidates).toBe(Math.min(40, many.candidates));
    expect(seen[1]!.candidates).toHaveLength(many.scorerCandidates!);
    // ranges that do not overlap come from the rest when the shortlist has too few
    for (const a of many.clips)
      for (const b of many.clips)
        if (a !== b) expect(a.endMs <= b.startMs || b.endMs <= a.startMs).toBe(true);

    // a failing scorer: the heuristic picks from all candidates, the shortlist is still reported
    e2.quickClips.registerScorer('broken', () => {
      throw new Error('model offline');
    });
    const fell = (await quick(e2, { ...wide, count: 1 })).result!;
    expect(fell.scorer).toBe('heuristic');
    expect(fell.scorerCandidates).toBe(SCORER_MIN_CANDIDATES);
    expect(fell.clips.map((c) => [c.startMs, c.endMs])).toEqual(
      plain.clips.map((c) => [c.startMs, c.endMs]),
    );
  }, 60_000);

  test('video highlights on the media move the heuristic pick to the highlighted part (D-75)', async () => {
    const e2 = newEngine();
    const o2 = await makeOfflineProject(e2);
    const args = { projectId: o2.projectId, mediaId: o2.mediaId, ...OPTS, count: 1 };
    const base = (await quick(e2, args)).result!;
    expect(base.highlights).toBeUndefined();
    const m = (await e2.getProject(o2.projectId)).media.find((x) => x.id === o2.mediaId)!;
    // the highest level over the last candidate range of the base run's set that does not
    // overlap the base pick
    const all = (await quick(e2, { ...args, count: 20 })).result!.clips;
    const other = all.find(
      (c) => c.endMs <= base.clips[0]!.startMs || c.startMs >= base.clips[0]!.endMs,
    )!;
    const levels = Array.from({ length: Math.ceil(m.durationMs! / 500) }, (_, k) => ({
      startMs: k * 500,
      endMs: (k + 1) * 500,
      level: k * 500 >= other.startMs && (k + 1) * 500 <= other.endMs ? 10 : 0,
    }));
    // what the `highlights` job stores
    await mkdir(join(o2.dir, 'cache', 'highlights'), { recursive: true });
    await writeFile(
      join(o2.dir, 'cache', 'highlights', `${o2.mediaId}.json`),
      JSON.stringify({ highlights: [], levels, keyFrameMs: null }),
    );
    const lifted = (await quick(e2, args)).result!;
    expect(lifted.highlights).toBe(true);
    expect([lifted.clips[0]!.startMs, lifted.clips[0]!.endMs]).not.toEqual([
      base.clips[0]!.startMs,
      base.clips[0]!.endMs,
    ]);
    // inside the highlighted part
    expect(lifted.clips[0]!.startMs).toBeLessThan(other.endMs);
    expect(lifted.clips[0]!.endMs).toBeGreaterThan(other.startMs);
  }, 60_000);

  test('an NTSC source gives a 30000/1001 sequence', async () => {
    const p = await e.getProject(off.projectId);
    const m = p.media.find((x) => x.id === off.mediaId)!;
    const ntsc = { ...m, id: 'm_ntsc', fps: { num: 30000, den: 1001 } };
    const add = await e.applyOp(off.projectId, { op: 'addMedia', args: { media: ntsc } } as never, {
      actor: 'cli',
    });
    expect(add.results[0]!.status).toBe('succeeded');
    const job = await quick(e, { projectId: off.projectId, mediaId: 'm_ntsc', ...OPTS, count: 1 });
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    const s = (await e.getProject(off.projectId)).sequences.find(
      (x) => x.id === job.result!.sequenceIds[0],
    )!;
    expect(s.canvas.fps).toEqual({ num: 30000, den: 1001 });
  });

  test('media without a transcript fails with a hint', async () => {
    const p = await e.getProject(off.projectId);
    const m = p.media.find((x) => x.id === off.mediaId)!;
    const bare: Partial<typeof m> = { ...m, id: 'm_bare' };
    delete bare.transcriptPath;
    delete bare.transcriptRev;
    await e.applyOp(off.projectId, { op: 'addMedia', args: { media: bare } } as never, {
      actor: 'cli',
    });
    const job = await quick(e, { projectId: off.projectId, mediaId: 'm_bare', ...OPTS });
    expect(job.error?.code).toBe('VALIDATION');
    expect(job.error?.hint).toMatch(/vox transcribe m_bare/);
  });
});
