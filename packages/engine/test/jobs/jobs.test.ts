import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isVoxError, VoxError } from '../../src/errors.ts';
import { createJobRunner, type JobContext, type JobEventName } from '../../src/jobs.ts';
import { createRedactor, REDACTED } from '../../src/redact.ts';

const CANARY = 'sk-or-v1-CANARY0000000000000000000000000000000000000000000000000000';

/** A job whose completion the test controls. */
function gate<T = string>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function controlled() {
  const started: string[] = [];
  const gates = new Map<string, ReturnType<typeof gate<string>>>();
  const ctxs = new Map<string, JobContext>();
  const handler = {
    run: (args: { name: string }, ctx: JobContext) => {
      started.push(args.name);
      ctxs.set(args.name, ctx);
      const g = gate<string>();
      gates.set(args.name, g);
      ctx.signal.addEventListener('abort', () => g.reject(new Error('aborted')));
      return g.promise;
    },
  };
  return { started, gates, ctxs, handler };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('job runner: register and start', () => {
  it('runs a registered kind and reports done with its result', async () => {
    const jobs = createJobRunner();
    jobs.register('echo', { run: async (args: { v: number }) => args.v * 2 });
    const id = jobs.start('echo', { v: 21 });
    expect(id).toMatch(/^job_[a-z0-9]+$/);
    const info = await jobs.wait(id);
    expect(info.status).toBe('done');
    expect(info.result).toBe(42);
    expect(info.progress).toBe(1);
    expect(jobs.get(id).status).toBe('done');
  });

  it('refuses an unknown kind and a duplicate registration', () => {
    const jobs = createJobRunner();
    jobs.register('a', { run: async () => 1 });
    const unknown = (() => {
      try {
        jobs.start('nope', {});
      } catch (e) {
        return e;
      }
    })();
    expect(isVoxError(unknown) && unknown.code).toBe('VALIDATION');
    expect(() => jobs.register('a', { run: async () => 2 })).toThrow(VoxError);
  });

  it('validates args with the handler schema before queueing', () => {
    const jobs = createJobRunner();
    jobs.register('typed', {
      args: z.object({ projectId: z.string(), n: z.number().int() }),
      run: async (a) => a.n,
    });
    let err: unknown;
    try {
      jobs.start('typed', { projectId: 'p_1', n: 1.5 });
    } catch (e) {
      err = e;
    }
    expect(isVoxError(err) && err.code).toBe('VALIDATION');
    expect(jobs.list()).toHaveLength(0);
  });

  it('get on an unknown id fails with NOT_FOUND', () => {
    const jobs = createJobRunner();
    let err: unknown;
    try {
      jobs.get('job_missing');
    } catch (e) {
      err = e;
    }
    expect(isVoxError(err) && err.code).toBe('NOT_FOUND');
  });

  it('lists jobs by projectId', async () => {
    const jobs = createJobRunner();
    jobs.register('k', { run: async () => null });
    const a = jobs.start('k', { projectId: 'p_a' });
    const b = jobs.start('k', { projectId: 'p_b' });
    const c = jobs.start('k', { projectId: 'p_a' });
    await Promise.all([a, b, c].map((id) => jobs.wait(id)));
    expect(jobs.list('p_a').map((j) => j.id)).toEqual([a, c]);
    expect(jobs.list().map((j) => j.id)).toEqual([a, b, c]);
  });
});

describe('job runner: concurrency', () => {
  it('runs at most 2 jobs at once by default, FIFO', async () => {
    const jobs = createJobRunner();
    const c = controlled();
    jobs.register('cpu', c.handler);
    const ids = ['a', 'b', 'c', 'd'].map((name) => jobs.start('cpu', { name }));
    await tick();
    expect(c.started).toEqual(['a', 'b']);
    expect(jobs.get(ids[2]!).status).toBe('queued');
    c.gates.get('a')!.resolve('A');
    await jobs.wait(ids[0]!);
    await tick();
    expect(c.started).toEqual(['a', 'b', 'c']);
    c.gates.get('b')!.resolve('B');
    c.gates.get('c')!.resolve('C');
    await tick();
    await tick();
    c.gates.get('d')!.resolve('D');
    const infos = await Promise.all(ids.map((id) => jobs.wait(id)));
    expect(infos.map((i) => i.result)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('honours a custom concurrency', async () => {
    const jobs = createJobRunner({ concurrency: 3 });
    const c = controlled();
    jobs.register('cpu', c.handler);
    for (const name of ['a', 'b', 'c', 'd']) jobs.start('cpu', { name });
    await tick();
    expect(c.started).toEqual(['a', 'b', 'c']);
    for (const g of c.gates.values()) g.resolve('x');
  });

  it('a failed job frees its slot', async () => {
    const jobs = createJobRunner({ concurrency: 1 });
    const c = controlled();
    jobs.register('cpu', c.handler);
    const a = jobs.start('cpu', { name: 'a' });
    jobs.start('cpu', { name: 'b' });
    await tick();
    c.gates.get('a')!.reject(new Error('boom'));
    expect((await jobs.wait(a)).status).toBe('failed');
    await tick();
    expect(c.started).toEqual(['a', 'b']);
    c.gates.get('b')!.resolve('ok');
  });
});

describe('job runner: GPU exclusivity', () => {
  it('runs at most one GPU job at a time; a CPU job behind it is not blocked', async () => {
    const jobs = createJobRunner();
    const gpu = controlled();
    const cpu = controlled();
    jobs.register('transcribe', { ...gpu.handler, gpu: true });
    jobs.register('shots', cpu.handler);
    const t1 = jobs.start('transcribe', { name: 't1' });
    const t2 = jobs.start('transcribe', { name: 't2' });
    jobs.start('shots', { name: 's1' });
    await tick();
    expect(gpu.started).toEqual(['t1']);
    expect(cpu.started).toEqual(['s1']);
    expect(jobs.get(t2).status).toBe('queued');
    gpu.gates.get('t1')!.resolve('done');
    await jobs.wait(t1);
    await tick();
    expect(gpu.started).toEqual(['t1', 't2']);
    gpu.gates.get('t2')!.resolve('done');
    cpu.gates.get('s1')!.resolve('done');
  });

  it('gpu may depend on the args', async () => {
    const jobs = createJobRunner({ concurrency: 4 });
    const c = controlled();
    jobs.register('gen', {
      ...c.handler,
      gpu: (a: { name: string; local?: boolean }) => a.local === true,
    });
    jobs.start('gen', { name: 'l1', local: true });
    jobs.start('gen', { name: 'l2', local: true });
    jobs.start('gen', { name: 'r1', local: false });
    await tick();
    expect(c.started).toEqual(['l1', 'r1']);
    for (const g of c.gates.values()) g.resolve('x');
  });
});

describe('job runner: cancel', () => {
  it('cancelling a queued job never starts it', async () => {
    const jobs = createJobRunner({ concurrency: 1 });
    const c = controlled();
    jobs.register('cpu', c.handler);
    jobs.start('cpu', { name: 'a' });
    const b = jobs.start('cpu', { name: 'b' });
    jobs.cancel(b);
    expect((await jobs.wait(b)).status).toBe('cancelled');
    c.gates.get('a')!.resolve('A');
    await tick();
    await tick();
    expect(c.started).toEqual(['a']);
  });

  it('cancelling a running job aborts its signal and frees the slot once it settles', async () => {
    const jobs = createJobRunner({ concurrency: 1 });
    const c = controlled();
    jobs.register('cpu', c.handler);
    const a = jobs.start('cpu', { name: 'a' });
    jobs.start('cpu', { name: 'b' });
    await tick();
    jobs.cancel(a);
    expect(c.ctxs.get('a')!.signal.aborted).toBe(true);
    const info = await jobs.wait(a);
    expect(info.status).toBe('cancelled');
    expect(info.error).toBeUndefined();
    await tick();
    expect(c.started).toEqual(['a', 'b']);
    c.gates.get('b')!.resolve('B');
  });

  it('a job that finishes despite the abort still counts as cancelled', async () => {
    const jobs = createJobRunner();
    let ctx!: JobContext;
    const g = gate<string>();
    jobs.register('stubborn', {
      run: (_a: unknown, c: JobContext) => {
        ctx = c;
        return g.promise;
      },
    });
    const id = jobs.start('stubborn', {});
    await tick();
    jobs.cancel(id);
    expect(ctx.signal.aborted).toBe(true);
    expect(jobs.get(id).status).toBe('running');
    g.resolve('late');
    expect((await jobs.wait(id)).status).toBe('cancelled');
  });

  it('cancelling a finished job changes nothing', async () => {
    const jobs = createJobRunner();
    jobs.register('k', { run: async () => 1 });
    const id = jobs.start('k', {});
    await jobs.wait(id);
    jobs.cancel(id);
    expect(jobs.get(id).status).toBe('done');
  });
});

describe('job runner: progress and events', () => {
  it('emits started, progress and done in order, with kind and projectId', async () => {
    const jobs = createJobRunner();
    const seen: [JobEventName, Record<string, unknown>][] = [];
    for (const ev of [
      'job.started',
      'job.progress',
      'job.done',
      'job.failed',
      'job.cancelled',
    ] as const) {
      jobs.on(ev, (p) => seen.push([ev, p as unknown as Record<string, unknown>]));
    }
    jobs.register('steps', {
      run: async (_a: { projectId: string }, ctx: JobContext) => {
        ctx.progress(0.25, 'quarter');
        ctx.progress(2); // clamped to 1
        ctx.progress(Number.NaN); // ignored
        return 'ok';
      },
    });
    const id = jobs.start('steps', { projectId: 'p_x' });
    await jobs.wait(id);
    expect(seen).toEqual([
      ['job.started', { jobId: id, kind: 'steps', projectId: 'p_x' }],
      [
        'job.progress',
        { jobId: id, kind: 'steps', projectId: 'p_x', progress: 0.25, message: 'quarter' },
      ],
      ['job.progress', { jobId: id, kind: 'steps', projectId: 'p_x', progress: 1 }],
      ['job.done', { jobId: id, kind: 'steps', projectId: 'p_x', result: 'ok' }],
    ]);
  });

  it('get reports the latest progress and message while running', async () => {
    const jobs = createJobRunner();
    const g = gate<string>();
    jobs.register('slow', {
      run: (_a: unknown, ctx: JobContext) => {
        ctx.progress(0.5, 'half');
        return g.promise;
      },
    });
    const id = jobs.start('slow', {});
    await tick();
    expect(jobs.get(id)).toMatchObject({ status: 'running', progress: 0.5, message: 'half' });
    g.resolve('x');
    await jobs.wait(id);
  });

  it('emits job.cancelled for a cancelled job', async () => {
    const jobs = createJobRunner();
    const c = controlled();
    jobs.register('cpu', c.handler);
    const events: string[] = [];
    jobs.on('job.cancelled', (p) => events.push(p.jobId));
    const id = jobs.start('cpu', { name: 'a' });
    await tick();
    jobs.cancel(id);
    await jobs.wait(id);
    expect(events).toEqual([id]);
  });

  it('on() returns an unsubscribe function; a throwing listener does not break the runner', async () => {
    const jobs = createJobRunner();
    jobs.register('k', { run: async () => 1 });
    const calls: string[] = [];
    const off = jobs.on('job.done', () => calls.push('x'));
    jobs.on('job.started', () => {
      throw new Error('listener bug');
    });
    await jobs.wait(jobs.start('k', {}));
    off();
    expect((await jobs.wait(jobs.start('k', {}))).status).toBe('done');
    expect(calls).toEqual(['x']);
  });
});

describe('job runner: failures are VoxErrors, redacted (S19)', () => {
  it('keeps a VoxError code and hint, and redacts message, cause and details', async () => {
    const r = createRedactor();
    r.addSecrets(['registered-secret-value']);
    const jobs = createJobRunner({ redactor: r });
    jobs.register('bad', {
      run: async () => {
        throw new VoxError('PY_TOOL_FAILED', `tool failed ${CANARY}`, 'Run vox doctor', {
          cause: 'line 1\nAuthorization: Bearer abcdefghijklmnop\nregistered-secret-value',
          details: { url: `https://x.test/?key=${CANARY}` },
        });
      },
    });
    const failed: unknown[] = [];
    jobs.on('job.failed', (p) => failed.push(p));
    const info = await jobs.wait(jobs.start('bad', {}));
    expect(info.status).toBe('failed');
    expect(info.error).toMatchObject({ code: 'PY_TOOL_FAILED', hint: 'Run vox doctor' });
    const all = JSON.stringify([info, failed]);
    expect(all).not.toMatch(/CANARY|abcdefghijklmnop|registered-secret-value/);
    expect(info.error!.cause).toContain('line 1');
    expect(info.error!.cause).toContain(REDACTED);
  });

  it('wraps a plain Error as JOB_FAILED', async () => {
    const jobs = createJobRunner();
    jobs.register('bad', {
      run: async () => {
        throw new Error(`plain ${CANARY}`);
      },
    });
    const info = await jobs.wait(jobs.start('bad', {}));
    expect(info.error!.code).toBe('JOB_FAILED');
    expect(info.error!.message).not.toContain('CANARY');
    expect(info.error!.hint.length).toBeGreaterThan(0);
  });

  it('redacts event payloads (results included)', async () => {
    const r = createRedactor();
    const jobs = createJobRunner({ redactor: r });
    jobs.register('k', {
      run: async (_a: unknown, ctx: JobContext) => {
        ctx.progress(0.1, `fetching https://x.test/?api_key=${CANARY}`);
        return { url: `https://x.test/?api_key=${CANARY}` };
      },
    });
    const payloads: unknown[] = [];
    jobs.on('job.progress', (p) => payloads.push(p));
    jobs.on('job.done', (p) => payloads.push(p));
    await jobs.wait(jobs.start('k', {}));
    expect(JSON.stringify(payloads)).not.toContain('CANARY');
  });
});

describe('job runner: robustness (review fixes)', () => {
  it('a result with a throwing getter still settles the job and the queue moves on', async () => {
    const jobs = createJobRunner({ concurrency: 1 });
    jobs.register('weird', {
      run: async () => ({
        get boom(): string {
          throw new Error('getter');
        },
      }),
    });
    jobs.register('k', { run: async () => 'next' });
    jobs.on('job.done', () => undefined);
    const a = jobs.start('weird', {});
    const b = jobs.start('k', {});
    expect((await jobs.wait(a)).status).toBe('done');
    expect((await jobs.wait(b)).result).toBe('next');
  });

  it('a thrown value whose message getter throws becomes JOB_FAILED', async () => {
    const jobs = createJobRunner();
    jobs.register('bad', {
      run: async () => {
        const e = new Error('x');
        Object.defineProperty(e, 'message', {
          get() {
            throw new Error('nope');
          },
        });
        throw e;
      },
    });
    const info = await jobs.wait(jobs.start('bad', {}));
    expect(info.status).toBe('failed');
    expect(info.error!.code).toBe('JOB_FAILED');
  });

  it('stores the progress message redacted', async () => {
    const jobs = createJobRunner();
    const g = gate<string>();
    jobs.register('slow', {
      run: (_a: unknown, ctx: JobContext) => {
        ctx.progress(0.5, `GET https://x.test/?api_key=${CANARY}`);
        return g.promise;
      },
    });
    const id = jobs.start('slow', {});
    await tick();
    expect(jobs.get(id).message).not.toContain('CANARY');
    g.resolve('x');
    await jobs.wait(id);
  });

  it('wait on an unknown id rejects with NOT_FOUND instead of throwing', async () => {
    const jobs = createJobRunner();
    const p = jobs.wait('job_missing');
    await expect(p).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
