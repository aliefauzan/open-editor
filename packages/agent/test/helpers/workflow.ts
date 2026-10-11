// Workflow test kit (phase 12): an engine on the repo styles (`vox`, `base`) with the offline fixture
// video, fakes for the Python and render jobs (shots, transcribe and facetrack seed the checked-in
// files; frames and audio QA write small PNGs and scripted QA results), and a scripted model whose
// steps may be computed from the request (the injected view).
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { createRedactor, openEngine, type Engine } from '@vox/engine';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { RoleModel } from '../../src/loop/types.ts';
import { runEngineJob } from '../../src/tools/jobs.ts';
import type { WorkflowDeps } from '../../src/workflows/run-workflow.ts';
import { rgbPng } from './png.ts';
import { ENGINE_FIXTURES } from './project.ts';
import type { ScriptStep } from './model.ts';

export const REPO = join(ENGINE_FIXTURES, '../../../..');
export const FIXTURE_VIDEO = join(ENGINE_FIXTURES, 'assets/media/talking-head-20s.mp4');

export interface QaScript {
  /** QA result per call (the last one repeats). */
  results: ('pass' | 'spacing-fail')[];
  calls: number;
}

export function qaResult(kind: 'pass' | 'spacing-fail', png: string) {
  const fail = kind === 'spacing-fail';
  const listen = [600, 1500, 2600, 3400, 4800].map((atMs, i) => ({
    atMs,
    timecode: `00:0${String(Math.floor(atMs / 1000))}.${String(atMs % 1000).padStart(3, '0')}`,
    kind: i < 2 ? 'hero cue' : 'loud SFX',
    listenFor: 'one clean hit on the cut',
  }));
  return {
    schemaVersion: 1,
    mode: 'mix',
    pass: !fail,
    fps: 30,
    targetLufs: -14,
    durationMs: 6000,
    checks: [
      { id: 'cueTiming', status: 'pass', limitMs: 33, maxAbsDeltaMs: 12, failures: [] },
      { id: 'oneEventPerCue', status: 'pass', failures: [] },
      {
        id: 'spacing',
        status: fail ? 'fail' : 'pass',
        minGapMs: 120,
        failures: fail ? [{ cues: [1, 2], gapMs: 50 }] : [],
      },
      { id: 'underSpeech', status: 'pass', failures: [] },
      { id: 'loudness', status: 'pass', integratedLufs: -14.2, truePeakDbtp: -1.4 },
    ],
    cues: [
      { index: 1, atMs: 1200, type: 'appear', hero: false },
      { index: 2, atMs: 1250, type: 'appear', hero: false },
    ],
    listen,
    outDir: '/x/renders/qa/seq',
    png,
  };
}

export interface Kit {
  engine: Engine;
  projectId: string;
  deps: WorkflowDeps;
  events: { type: string; payload: Record<string, unknown> }[];
  qa: QaScript;
  /** Archive search results (default: none, so slots get placeholders). */
  search: { candidates: { id: string; title: string }[] };
  jobs: { kind: string; args: Record<string, unknown> }[];
}

const pngDir = () => mkdtempSync(join(tmpdir(), 'vox-agent-wf-png-'));

/** A fresh empty project on the repo styles, with fake Python/render jobs. */
export async function workflowKit(over: Partial<WorkflowDeps> = {}): Promise<Kit> {
  const projectsDir = join(mkdtempSync(join(tmpdir(), 'vox-agent-wf-')), 'Projects');
  const real = openEngine({
    projectsDir,
    stylesDirs: [join(REPO, 'styles')],
    config: async () => ({}),
  });
  const dir = pngDir();
  let frameNo = 0;
  const engine: Engine = {
    ...real,
    frames: (_p, _s, atMs) =>
      Promise.resolve(
        atMs.map((ms) => {
          const path = join(dir, `f${String(frameNo++)}-${String(ms)}.png`);
          writeFileSync(path, rgbPng(32, 24, (x, y) => [80 + ((x * 7 + y * 3) % 120), 90, 70]));
          return path;
        }),
      ),
    compile: () => Promise.resolve({ cues: { dropped: [] } } as never),
  };
  const p = await engine.createProject('workflow-fixture');
  const qa: QaScript = { results: ['pass'], calls: 0 };
  const kit = {
    engine,
    projectId: p.id,
    qa,
    search: { candidates: [] as { id: string; title: string }[] },
    jobs: [] as Kit['jobs'],
  } as Kit;
  const qaPng = join(dir, 'qa.png');
  writeFileSync(qaPng, rgbPng(40, 30, (x) => [x * 5, 60, 60]));
  const seed = async (args: Record<string, unknown>, folder: string, field: string) => {
    const mediaId = (args['mediaId'] as string | undefined) ?? '';
    const src = join(ENGINE_FIXTURES, folder, 'talking-head-20s.json');
    const rel = `${folder}/${mediaId}.json`;
    mkdirSync(join(projectsDir, p.id, folder), { recursive: true });
    copyFileSync(src, join(projectsDir, p.id, rel));
    const patch: Record<string, string> = { [field]: rel };
    if (folder === 'transcripts')
      patch['transcriptRev'] = createHash('sha256')
        .update(readFileSync(src))
        .digest('hex')
        .slice(0, 16);
    await engine.applyOp(
      p.id,
      { op: 'updateMedia', args: { mediaId, patch } } as never,
      {
        actor: args['actor'] as 'agent',
        ...(typeof args['runId'] === 'string' && { runId: args['runId'] }),
      },
    );
    return { mediaId };
  };
  const runJob = async (kind: string, args: Record<string, unknown>): Promise<unknown> => {
    kit.jobs.push({ kind, args });
    switch (kind) {
      case 'shots':
        return seed(args, 'shots', 'shotsPath');
      case 'transcribe':
        return seed(args, 'transcripts', 'transcriptPath');
      case 'facetrack':
        return seed(args, 'facetracks', 'facetrackPath');
      case 'audioQa': {
        const k = qa.results[Math.min(qa.calls, qa.results.length - 1)]!;
        qa.calls++;
        return qaResult(k, qaPng);
      }
      case 'assets.search':
        return kit.search;
      default:
        return runEngineJob(engine, kind, args);
    }
  };
  const events: Kit['events'] = [];
  kit.events = events;
  kit.deps = {
    engine,
    redactor: createRedactor(),
    models: {},
    limits: { maxUsdPerRun: 2, maxStepsPerRun: 60 },
    emit: (e) => void events.push(e as never),
    sleep: () => Promise.resolve(),
    newRunId: () => 'run_wftest0001',
    runJob,
    ...over,
  };
  return kit;
}

/** A scripted model whose next step is computed from the request (`dyn`) or taken from a list. */
export function dynamicModel(
  next: (o: LanguageModelV4CallOptions, n: number) => ScriptStep | Promise<ScriptStep>,
) {
  const prompts: LanguageModelV4CallOptions[] = [];
  const usage = {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 20, text: 20, reasoning: 0 },
  };
  const step = async (o: LanguageModelV4CallOptions) => {
    prompts.push(o);
    return next(o, prompts.length - 1);
  };
  const model = new MockLanguageModelV4({
    doStream: async (o) => {
      const s = await step(o);
      if (s.error !== undefined) throw s.error;
      const chunks: unknown[] = [];
      const text = s.json !== undefined ? JSON.stringify(s.json) : s.text;
      if (text)
        chunks.push(
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: text },
          { type: 'text-end', id: 't' },
        );
      for (const [k, c] of (s.calls ?? []).entries()) {
        chunks.push({
          type: 'tool-call',
          toolCallId: `call_${String(prompts.length)}_${String(k)}`,
          toolName: c.name,
          input: typeof c.input === 'string' ? c.input : JSON.stringify(c.input),
        });
      }
      chunks.push({
        type: 'finish',
        finishReason: { unified: s.calls?.length ? 'tool-calls' : 'stop', raw: 'x' },
        usage,
      });
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
    doGenerate: async (o) => {
      const s = await step(o);
      if (s.error !== undefined) throw s.error;
      const text = s.json !== undefined ? JSON.stringify(s.json) : (s.text ?? '');
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      } as never;
    },
  });
  return { model, prompts };
}

export function role(model: MockLanguageModelV4, over: Partial<RoleModel> = {}): RoleModel {
  return {
    model,
    provider: { type: 'openrouter', label: 'OpenRouter' },
    modelId: 'test/model',
    contextTokens: 128_000,
    price: { inPerMTok: 1, outPerMTok: 2 },
    maxOutputTokens: 8_000,
    ...over,
  };
}

export interface ViewItem {
  id: string;
  track: string;
  startMs: number;
  endMs: number;
  kind: string;
  template?: string;
}

/** The newest injected view in a request: the sequence alias and its items. */
export function viewIn(o: LanguageModelV4CallOptions): { seq: string; items: ViewItem[] } {
  const text = JSON.stringify(o.prompt);
  const re = /Sequence (s\d+) @v\d+: (\[.*?\])(?:\\n|")/g;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  if (!last) throw new Error('no view in the request');
  return { seq: last[1]!, items: JSON.parse(JSON.parse(`"${last[2]!}"`) as string) as ViewItem[] };
}

/** Tool-result messages in a request (the step within a fresh sub-run). */
export const toolTurns = (o: LanguageModelV4CallOptions) =>
  o.prompt.filter((m) => m.role === 'tool').length;

/** The fixture video ingested and analysed as the user, then `count` quick clips (4–8 s). */
export async function quickClipsProject(
  kit: Kit,
  count = 1,
): Promise<{ mediaId: string; sequenceIds: string[] }> {
  const job = kit.deps.runJob!;
  const ing = (await job('ingest', {
    projectId: kit.projectId,
    inputs: [FIXTURE_VIDEO],
    actor: 'user',
  })) as { media: { mediaId: string }[] };
  const mediaId = ing.media[0]!.mediaId;
  for (const kind of ['shots', 'transcribe', 'facetrack'])
    await job(kind, { projectId: kit.projectId, mediaId, actor: 'user' });
  const q = (await job('quickClips', {
    projectId: kit.projectId,
    mediaId,
    count,
    minMs: 4000,
    maxMs: 8000,
    actor: 'user',
  })) as { sequenceIds: string[] };
  kit.jobs.length = 0;
  return { mediaId, sequenceIds: q.sequenceIds };
}

/** project.json without the fields every write changes (version, updatedAt). */
export async function normalisedProject(kit: Kit): Promise<unknown> {
  const p = await kit.engine.getProject(kit.projectId);
  return { media: p.media, sequences: p.sequences, name: p.name };
}
