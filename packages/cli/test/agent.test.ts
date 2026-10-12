// `vox agent` (phase 12 step 8; agent done-when 8): the clipper with --yes on the offline fixture cuts
// the pauses as one undo entry per sequence; the terminal approval prompt; --yes never approves a
// source; --yes-sources approves only sources named in the instruction; `vox agent undo`.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRedactor, openEngine, writeConfig, type Engine } from '@vox/engine';
import type { OpenRouterModelInfo } from '@vox/agent';
import { describe, expect, test, vi } from 'vitest';
import { makeOfflineProject } from '../../../scripts/make-offline-project.ts';
import {
  dynamicModel,
  fakeJobs,
  fakeRender,
  REPO,
  screenplaySet,
  toolsStylist,
  type ScriptStep,
} from '@vox/agent/test-kit';
import { terminalPauses } from '../src/agent.ts';
import { run, type Io } from '../src/main.ts';

const CANARY_KEY = 'sk-or-v1-CANARY0000000000000000000000000000000000000000000000000000';
const MODELS = new Map<string, OpenRouterModelInfo>([
  [
    'gw/model',
    {
      id: 'gw/model',
      contextLength: 128_000,
      price: { inPerMTok: 1, outPerMTok: 2 },
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: true,
    },
  ],
]);

async function setup(next: Parameters<typeof dynamicModel>[0], apiKey = CANARY_KEY) {
  const home = mkdtempSync(join(tmpdir(), 'vox-agent-cli-'));
  const projectsDir = join(home, 'Projects');
  const env = { HOME: home, VOX_HOME: home, OPENROUTER_API_KEY: apiKey };
  await writeConfig(
    {
      providers: [
        {
          id: 'openrouter',
          type: 'openrouter',
          preset: 'openrouter',
          apiKey: 'env:OPENROUTER_API_KEY',
        },
      ],
      roles: { editor: { providerId: 'openrouter', model: 'gw/model' } },
    } as never,
    env,
  );
  const setupEngine = openEngine({
    projectsDir,
    stylesDirs: [join(REPO, 'styles')],
    config: async () => ({}),
  });
  const off = await makeOfflineProject(setupEngine);
  const model = dynamicModel(next);
  let engine: Engine | undefined;
  const jobs = fakeJobs(() => engine!);
  const prompt = vi.fn((_q: string) => Promise.resolve('n'));
  const vox = async (args: string[], extra: Partial<Io> = {}) => {
    let stdout = '';
    let stderr = '';
    const code = await run([...args, '--projects-dir', projectsDir], {
      stdout: (s) => (stdout += s),
      stderr: (s) => (stderr += s),
      env,
      cwd: home,
      prompt,
      ...extra,
      agent: {
        apple: undefined,
        createModel: () => model.model,
        probe: { context: { openRouterModels: MODELS } },
        runJob: jobs.runJob,
        wrapEngine: (e) => (engine = fakeRender(e)),
        ...extra.agent,
      },
    });
    return { code, stdout, stderr };
  };
  return { vox, off, model, jobs, prompt, engine: () => engine! };
}

const ingestUnnamed = (): ScriptStep => ({
  calls: [
    {
      name: 'call_tool',
      input: { name: 'ingest', args: { source: 'https://evil.example/x.mp4' } },
    },
  ],
});

describe('vox agent (step 8, done-when 8)', () => {
  test('--workflow clipper --yes on the fixture: pauses cut as one entry per sequence', async () => {
    const t = await setup(toolsStylist());
    const r = await t.vox([
      'agent',
      t.off.projectId,
      '--workflow',
      'clipper',
      '--yes',
      '--length',
      '4-8',
      '--json',
    ]);
    const out = JSON.parse(r.stdout) as {
      status: string;
      runId: string;
      sequenceIds: string[];
      costUsd: number;
      summary: string;
    };
    expect(out.status, out.summary).toBe('completed');
    expect(r.code).toBe(0);
    expect(out.sequenceIds).toHaveLength(3);
    expect(out.costUsd).toBeGreaterThan(0);
    expect(t.prompt).not.toHaveBeenCalled();
    const h = await t.engine().history(t.off.projectId);
    for (const id of out.sequenceIds) {
      const cuts = h.filter(
        (e) => e.op === 'removePauses' && (e.args as { sequenceId: string }).sequenceId === id,
      );
      expect(cuts).toHaveLength(1);
      expect(cuts[0]!.runId).toBe(out.runId);
    }
    // no analysis job ran again: the fixture media has its transcript, shots and facetracks
    expect(t.jobs.jobs.map((j) => j.kind).filter((k) => k !== 'audioQa')).toEqual(['quickClips']);

    // vox agent undo restores the project as it was before the run
    const u = await t.vox(['agent', 'undo', t.off.projectId, out.runId]);
    expect(u.code, u.stderr).toBe(0);
    const p = await t.engine().getProject(t.off.projectId);
    expect(p.sequences.map((s) => s.id)).toEqual([t.off.sequenceId]);
  }, 120_000);

  test('a source pause asks on the terminal; "n" stops the run with nothing ingested', async () => {
    const t = await setup(ingestUnnamed);
    const r = await t.vox(
      ['agent', t.off.projectId, 'add the intro clip', '--seq', t.off.sequenceId],
      {
        isTTY: true,
      },
    );
    expect(t.prompt).toHaveBeenCalledWith('Allow these sources? [y/N] ');
    expect(r.stderr).toContain('source: https://evil.example/x.mp4');
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/run run_\S+: stopped/);
    expect((await t.engine().getProject(t.off.projectId)).media).toHaveLength(1);
  }, 60_000);

  test('--yes never approves a source; --yes-sources approves only named ones', async () => {
    for (const flag of ['--yes', '--yes-sources']) {
      const t = await setup(ingestUnnamed);
      const r = await t.vox([
        'agent',
        t.off.projectId,
        'use https://example.com/ok.mp4 for the intro',
        '--workflow',
        'edit',
        flag,
        '--json',
      ]);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({ status: 'stopped' });
      expect(r.stderr).toContain('no terminal to ask: stopped (nothing was approved)');
      expect(t.jobs.jobs.filter((j) => j.kind === 'ingest')).toEqual([]);
    }
  }, 60_000);

  test('the tighten prompt takes numbers: one ticked range is cut', async () => {
    const t = await setup(toolsStylist());
    t.prompt.mockImplementation((q: string) =>
      Promise.resolve(q.startsWith('Cut which') ? '1' : 'n'),
    );
    const r = await t.vox(
      ['agent', t.off.projectId, 'make 1 clip', '--workflow', 'clipper', '--length', '6-12'],
      { isTTY: true },
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toMatch(/1\. \d+–\d+ ms pause \(pause \d+ ms\)/);
    const cut = (await t.engine().history(t.off.projectId)).find((e) => e.op === 'removePauses')!;
    expect((cut.args as { wordKeys?: string[] }).wordKeys).toHaveLength(1);
  }, 120_000);

  test('--workflow screenplay --screenplay <file>: ingests the document, ranks, lays out, reports --json', async () => {
    // the project holds one video; the ranker likes it for every scene, the first scene takes it
    const t = await setup((o) => {
      const text = JSON.stringify(o.prompt);
      const n = [...text.matchAll(/#(\d+) /g)].length;
      return {
        json: { scores: Array.from({ length: n }, (_x, i) => ({ index: i + 1, score: 9 })) },
      };
    });
    const file = join(screenplaySet(), 'screenplay.fountain');
    const r = await t.vox([
      'agent',
      t.off.projectId,
      '--workflow',
      'screenplay',
      '--screenplay',
      file,
      '--json',
    ]);
    const out = JSON.parse(r.stdout) as {
      status: string;
      summary: string;
      workflow: string;
      sequenceIds: string[];
      checkpoints: { checkpoint: string; status: string }[];
      screenplay: { scenes: number; matched: number; placeholders: number };
    };
    expect(out.status, out.summary).toBe('completed');
    expect(r.code).toBe(0);
    expect(out.workflow).toBe('screenplay');
    expect(out.screenplay).toMatchObject({ scenes: 6, matched: 1, placeholders: 5 });
    expect(out.checkpoints.map((c) => c.checkpoint + ':' + c.status)).toEqual([
      'tag:met',
      'match:met',
      'layout:met',
    ]);
  }, 120_000);

  test('usage errors exit 2', async () => {
    const t = await setup(() => ({ text: 'x' }));
    expect((await t.vox(['agent', t.off.projectId])).code).toBe(2);
    expect((await t.vox(['agent', t.off.projectId, '--workflow', 'stylize'])).code).toBe(2);
    expect((await t.vox(['agent', t.off.projectId, '--workflow', 'screenplay'])).code).toBe(2);
    expect((await t.vox(['agent', t.off.projectId, 'x', '--mode', 'fast'])).code).toBe(2);
    expect((await t.vox(['agent', t.off.projectId, 'x', '--length', '9'])).code).toBe(2);
  }, 60_000);
});

describe('the tighten prompt: picks', () => {
  const ranges = [1, 2].map((i) => ({
    wordKey: `w${String(i)}`,
    kind: 'pause' as const,
    seqStartMs: i * 1000,
    seqEndMs: i * 1000 + 500,
    text: '(pause 500 ms)',
  }));
  const pause = {
    runId: 'run_x',
    reason: 'approval' as const,
    kind: 'pauses' as const,
    detail: '2 pauses',
    ranges,
  };
  function asker(answers: string[]) {
    const io = {
      stdout: () => undefined,
      stderr: (s: string) => void (io.err += s),
      err: '',
      env: {},
      isTTY: true,
      prompt: vi.fn((_q: string) => Promise.resolve(answers.shift() ?? '')),
    };
    const ask = terminalPauses(io, {
      json: false,
      yesSources: false,
      instruction: '',
      redactor: createRedactor(),
    });
    return { io, ask };
  }

  test('no valid number asks again; ignored tokens are reported', async () => {
    const { io, ask } = asker(['x, 9', '2 z']);
    expect(await ask(pause)).toEqual({ action: 'continue', wordKeys: ['w2'] });
    expect(io.prompt).toHaveBeenCalledTimes(2);
    expect(io.err).toContain('ignored: x, 9');
    expect(io.err).toContain('ignored: z');
  });

  test('three answers without a valid number: nothing is cut, said so', async () => {
    const { io, ask } = asker(['x', '0', 'nope']);
    expect(await ask(pause)).toEqual({ action: 'continue', wordKeys: [] });
    expect(io.prompt).toHaveBeenCalledTimes(3);
    expect(io.err).toContain('no valid pick: nothing is cut');
  });
});

describe('vox agent: Ctrl-C', () => {
  test('SIGINT stops the run; the runId is printed at the start; the handler is removed', async () => {
    let interrupt: (() => void) | undefined;
    let removed = 0;
    const t = await setup((o) => {
      interrupt?.();
      return toolsStylist()(o);
    });
    const r = await t.vox(['agent', t.off.projectId, 'add a title', '--seq', t.off.sequenceId], {
      agent: {
        onInterrupt: (handler) => {
          interrupt = handler;
          return () => void removed++;
        },
      },
    });
    expect(r.stderr).toMatch(/^run run_\S+ started/m);
    const runId = /^run (run_\S+) started/m.exec(r.stderr)![1]!;
    expect(r.stdout).toContain(`run ${runId}: stopped`);
    expect(r.code).toBe(1);
    expect(removed).toBe(1);
  }, 60_000);
});

describe('vox agent: one redactor (S19)', () => {
  test('the configured key is registered on the engine’s redactor too', async () => {
    // a key with no known shape: only its registration can redact it
    const key = 'plaincanary7f3a9c2e5b1d4068';
    const t = await setup(() => ({ text: 'Done.' }), key);
    const r = await t.vox(['agent', t.off.projectId, 'add a title', '--seq', t.off.sequenceId]);
    expect(r.code, r.stderr).toBe(0);
    expect(t.engine().redactor.redact(`key ${key}`)).not.toContain(key);
  }, 60_000);
});
