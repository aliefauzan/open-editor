// The `makeClips` app job's stage plan (decision "Quick clips speed"): facetrack and highlights run
// beside shots → transcribe, a stage that loses the project-version race (JOB_CONFLICT) is run
// again (its output is cached, so only the media update is redone), highlights (D-75) and sound
// tags (D-83) never stop the clips and are waited for only a grace time, and progress is weighted
// by stage cost.
import type { Engine } from '@vox/engine';
import { describe, expect, it } from 'vitest';
import { AppJobs, STAGE_WEIGHT } from '../../src/engine-host/quick.ts';
import type { EventName } from '../../src/shared/api.ts';

type Status = 'done' | 'failed' | 'cancelled';
interface Script {
  /** Per kind: the outcomes of successive runs (default done). */
  outcomes?: Partial<Record<string, { status: Status; error?: unknown }[]>>;
  /** Per kind: ms before the job ends. */
  delay?: Partial<Record<string, number>>;
}

function fakeEngine(script: Script) {
  const log: string[] = [];
  const listeners = new Set<(e: { jobId: string; progress: number }) => void>();
  const ends = new Map<string, Promise<{ status: Status; result?: unknown; error?: unknown }>>();
  const runs = new Map<string, number>();
  let n = 0;
  const cancelled = new Set<string>();
  const engine = {
    jobs: {
      start(kind: string) {
        const id = `j${++n}`;
        log.push(`start ${kind}`);
        const run = runs.get(kind) ?? 0;
        runs.set(kind, run + 1);
        const outcome = script.outcomes?.[kind]?.[run] ?? { status: 'done' as Status };
        ends.set(
          id,
          (async () => {
            const steps = 4;
            for (let i = 1; i <= steps; i++) {
              await new Promise((r) => setTimeout(r, (script.delay?.[kind] ?? 5) / steps));
              if (cancelled.has(id)) return { status: 'cancelled' as Status };
              for (const l of listeners) l({ jobId: id, progress: i / steps });
            }
            log.push(`end ${kind} ${outcome.status}`);
            return { ...outcome, result: { kind } };
          })(),
        );
        return id;
      },
      on(_name: string, fn: (e: { jobId: string; progress: number }) => void) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      wait: (id: string) => ends.get(id)!,
      cancel: (id: string) => cancelled.add(id),
    },
  };
  return { engine: engine as unknown as Engine, log, runs };
}

function run(script: Script, opts: { highlightsGraceMs?: number } = {}) {
  const fe = fakeEngine(script);
  const events: [EventName, { progress?: number; message?: string }][] = [];
  const jobs = new AppJobs(
    fe.engine,
    (name, p) => events.push([name, p as never]),
    undefined,
    undefined,
    opts,
  );
  const id = jobs.start('makeClips', { projectId: 'p', mediaId: 'm' });
  const done = (async () => {
    for (let i = 0; i < 400; i++) {
      const j = jobs.get(id);
      if (j.status !== 'running') return j;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('makeClips did not end');
  })();
  return { ...fe, events, done, jobs, id };
}

describe('makeClips stages', () => {
  it('starts facetrack before shots and transcribe finish; quick clips run last', async () => {
    const r = run({ delay: { shots: 20, transcribe: 40, facetrack: 60 } });
    const j = await r.done;
    expect(j.status).toBe('done');
    const at = (s: string) => r.log.indexOf(s);
    expect(at('start facetrack')).toBeLessThan(at('end shots done'));
    expect(at('start transcribe')).toBeGreaterThan(at('end shots done'));
    expect(at('start quickClips')).toBeGreaterThan(at('end facetrack done'));
    expect(at('start quickClips')).toBeGreaterThan(at('end transcribe done'));
  });

  it('highlights start with the other stages and end before quick clips (D-75)', async () => {
    const r = run({ delay: { shots: 5, transcribe: 10, highlights: 60, facetrack: 20 } });
    const j = await r.done;
    expect(j.status).toBe('done');
    const at = (s: string) => r.log.indexOf(s);
    expect(at('start highlights')).toBeLessThan(at('end shots done'));
    expect(at('start quickClips')).toBeGreaterThan(at('end highlights done'));
    const messages = new Set(
      r.events.filter(([n]) => n === 'job.progress').map(([, p]) => p.message),
    );
    // named only while nothing else runs
    expect(messages).toContain('Finding highlights');
    expect([...messages].filter((m) => m?.includes('highlights'))).toEqual(['Finding highlights']);
  });

  it('a failed highlights stage never stops the clips', async () => {
    for (const code of ['TOOL_FAILED', 'CANCELLED', 'JOB_CONFLICT']) {
      const fail = { status: 'failed' as Status, error: { code, message: 'x' } };
      const r = run({ outcomes: { highlights: [fail, fail, fail, fail] } });
      const j = await r.done;
      expect(j.status, code).toBe('done');
      expect(r.runs.get('quickClips'), code).toBe(1);
    }
  });

  it('sound tags start with the other stages, end before quick clips, and never stop the clips (D-83)', async () => {
    const r = run({ delay: { shots: 5, transcribe: 10, facetrack: 20, sounds: 60 } });
    expect((await r.done).status).toBe('done');
    const at = (s: string) => r.log.indexOf(s);
    expect(at('start sounds')).toBeLessThan(at('end shots done'));
    expect(at('start quickClips')).toBeGreaterThan(at('end sounds done'));
    const messages = new Set(
      r.events.filter(([n]) => n === 'job.progress').map(([, p]) => p.message),
    );
    expect(messages).toContain('Tagging sounds');
    for (const code of ['TOOL_FAILED', 'CANCELLED', 'JOB_CONFLICT']) {
      const fail = { status: 'failed' as Status, error: { code, message: 'x' } };
      const f = run({ outcomes: { sounds: [fail, fail, fail, fail] } });
      expect((await f.done).status, code).toBe('done');
      expect(f.runs.get('quickClips'), code).toBe(1);
    }
    const slow = run(
      { delay: { shots: 5, transcribe: 5, facetrack: 5, sounds: 1500 } },
      { highlightsGraceMs: 30 },
    );
    expect((await slow.done).status).toBe('done');
    expect(slow.log).not.toContain('end sounds done');
  });

  it('highlights still running after the grace time are cancelled; the clips go on', async () => {
    const r = run(
      { delay: { shots: 5, transcribe: 5, facetrack: 5, highlights: 1500 } },
      {
        highlightsGraceMs: 30,
      },
    );
    const j = await r.done;
    expect(j.status).toBe('done');
    expect(r.log).not.toContain('end highlights done');
    expect(r.runs.get('quickClips')).toBe(1);
  });

  it('a failed required stage cancels highlights', async () => {
    const r = run({
      delay: { facetrack: 5, highlights: 1500 },
      outcomes: { facetrack: [{ status: 'failed', error: { code: 'TOOL_FAILED', message: 'x' } }] },
    });
    const j = await r.done;
    expect(j.status).toBe('failed');
    expect(r.log).not.toContain('end highlights done');
    expect(r.runs.get('quickClips')).toBeUndefined();
  });

  it('a stage that ends JOB_CONFLICT is run again, then the chain goes on', async () => {
    const conflict = { status: 'failed' as Status, error: { code: 'JOB_CONFLICT', message: 'x' } };
    const r = run({
      delay: { shots: 5, transcribe: 30, facetrack: 10 },
      outcomes: { transcribe: [conflict], facetrack: [conflict] },
    });
    const j = await r.done;
    expect(j.status).toBe('done');
    expect(r.runs.get('transcribe')).toBe(2);
    expect(r.runs.get('facetrack')).toBe(2);
    expect(r.runs.get('quickClips')).toBe(1);
  });

  it('any other failure fails the job and cancels the stage still running', async () => {
    const r = run({
      delay: { shots: 5, transcribe: 10, facetrack: 200 },
      outcomes: {
        transcribe: [{ status: 'failed', error: { code: 'TOOL_FAILED', message: 'x' } }],
      },
    });
    const j = await r.done;
    expect(j.status).toBe('failed');
    expect(j.error).toMatchObject({ code: 'TOOL_FAILED' });
    expect(r.log).not.toContain('end facetrack done');
    expect(r.runs.get('quickClips')).toBeUndefined();
  });

  it('progress is weighted by stage cost, never goes back, and names the running stages', async () => {
    const r = run({ delay: { shots: 5, transcribe: 20, facetrack: 60 } });
    await r.done;
    const ps = r.events.filter(([n]) => n === 'job.progress').map(([, p]) => p);
    for (let i = 1; i < ps.length; i++)
      expect(ps[i]!.progress!).toBeGreaterThanOrEqual(ps[i - 1]!.progress!);
    const total = Object.values(STAGE_WEIGHT).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(STAGE_WEIGHT.facetrack).toBeGreaterThan(STAGE_WEIGHT.transcribe);
    expect(STAGE_WEIGHT.transcribe).toBeGreaterThan(STAGE_WEIGHT.shots);
    const messages = new Set(ps.map((p) => p.message));
    expect(messages).toContain('Finding shots and tracking faces');
    expect(messages).toContain('Transcribing and tracking faces');
    expect(messages).toContain('Picking clips');
    // With shots and transcribe done the bar is past their share, not stuck at a fixed step.
    const facetrackOnly = ps.filter((p) => p.message === 'Tracking faces').map((p) => p.progress!);
    expect(new Set(facetrackOnly).size).toBeGreaterThan(1);
  });
});
