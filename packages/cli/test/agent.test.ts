// `vox agent` (phase 12 step 8; agent done-when 8): the clipper with --yes on the offline fixture cuts
// the pauses as one undo entry per sequence; the terminal approval prompt; --yes never approves a
// source; --yes-sources approves only sources named in the instruction; `vox agent undo`.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEngine, writeConfig, type Engine } from '@vox/engine';
import type { OpenRouterModelInfo } from '@vox/agent';
import { describe, expect, test, vi } from 'vitest';
import { makeOfflineProject } from '../../../scripts/make-offline-project.ts';
import type { ScriptStep } from '../../agent/test/helpers/model.ts';
import { toolsStylist } from '../../agent/test/helpers/stylists.ts';
import { dynamicModel, fakeJobs, fakeRender, REPO } from '../../agent/test/helpers/workflow.ts';
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

async function setup(next: Parameters<typeof dynamicModel>[0]) {
  const home = mkdtempSync(join(tmpdir(), 'vox-agent-cli-'));
  const projectsDir = join(home, 'Projects');
  const env = { HOME: home, VOX_HOME: home, OPENROUTER_API_KEY: CANARY_KEY };
  await writeConfig(
    {
      providers: [
        { id: 'openrouter', type: 'openrouter', preset: 'openrouter', apiKey: 'env:OPENROUTER_API_KEY' },
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
      agent: {
        apple: undefined,
        createModel: () => model.model,
        probe: { context: { openRouterModels: MODELS } },
        runJob: jobs.runJob,
        wrapEngine: (e) => (engine = fakeRender(e)),
      },
      prompt,
      ...extra,
    });
    return { code, stdout, stderr };
  };
  return { vox, off, model, jobs, prompt, engine: () => engine! };
}

const ingestUnnamed = (): ScriptStep => ({
  calls: [
    { name: 'call_tool', input: { name: 'ingest', args: { source: 'https://evil.example/x.mp4' } } },
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
    const r = await t.vox(['agent', t.off.projectId, 'add the intro clip', '--seq', t.off.sequenceId], {
      isTTY: true,
    });
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
    t.prompt.mockImplementation((q: string) => Promise.resolve(q.startsWith('Cut which') ? '1' : 'n'));
    const r = await t.vox(
      ['agent', t.off.projectId, 'make 1 clip', '--workflow', 'clipper', '--length', '6-12'],
      { isTTY: true },
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toMatch(/1\. \d+–\d+ ms pause \(pause \d+ ms\)/);
    const cut = (await t.engine().history(t.off.projectId)).find((e) => e.op === 'removePauses')!;
    expect((cut.args as { wordKeys?: string[] }).wordKeys).toHaveLength(1);
  }, 120_000);

  test('usage errors exit 2', async () => {
    const t = await setup(() => ({ text: 'x' }));
    expect((await t.vox(['agent', t.off.projectId])).code).toBe(2);
    expect((await t.vox(['agent', t.off.projectId, '--workflow', 'stylize'])).code).toBe(2);
    expect((await t.vox(['agent', t.off.projectId, 'x', '--mode', 'fast'])).code).toBe(2);
    expect((await t.vox(['agent', t.off.projectId, 'x', '--length', '9'])).code).toBe(2);
  }, 60_000);
});
