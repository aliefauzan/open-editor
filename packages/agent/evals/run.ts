// Live evals (agent spec "Testing"; plan phase 12): `pnpm eval [--provider <id>] [--model <id>]
// [--mode tools|plan] [--json]` runs the clipper on the two fixture inputs and the injection case
// (transcript + image) with the user's configured role models, or with every role on one configured
// provider, and prints a scorecard per run. Each run is capped by the config's `maxUsdPerRun`. Opt-in:
// it needs real providers, so it is not part of CI. Pauses are never approved (S20).
import { createRedactor, openEngine, type Engine, type Project, type Redactor } from '@vox/engine';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createSecurityKeychain } from '../src/config/keychain.ts';
import { buildRunModels } from '../src/config/run-models.ts';
import { engineConfigIO, findProvider, loadAgentConfig } from '../src/config/store.ts';
import type { PauseInfo, RunModels } from '../src/loop/types.ts';
import { createLanguageModel } from '../src/providers/factory.ts';
import type { AgentMode } from '../src/providers/roles.ts';
import { runEngineJob } from '../src/tools/jobs.ts';
import { runWorkflow, type WorkflowDeps } from '../src/workflows/run-workflow.ts';
import {
  clipViolations,
  injectionViolations,
  scorecard,
  type ClipBounds,
  type Scorecard,
} from './scorecard.ts';

const HERE = new URL('.', import.meta.url).pathname;
export const REPO_ROOT = join(HERE, '../../..');

export interface EvalInput {
  id: string;
  video: string;
  transcript: string;
  instruction: string;
  count?: number;
  minMs: number;
  maxMs: number;
  imageText?: string;
}

export interface EvalPlan {
  inputs: EvalInput[];
  injection: EvalInput & { imageText: string };
}

export function loadInputs(): EvalPlan {
  return JSON.parse(readFileSync(join(HERE, 'inputs.json'), 'utf8')) as EvalPlan;
}

export interface EvalDeps {
  models: Partial<RunModels>;
  mode: AgentMode;
  maxUsdPerRun: number;
  maxStepsPerRun: number;
  /** A fresh engine on a temp projects folder (tests: render stand-ins). */
  engine?: (projectsDir: string) => Engine;
  /** Job stand-ins (tests). */
  runJob?: WorkflowDeps['runJob'];
  /** The redactor holding the configured keys (S19): every run record and event goes through it. */
  redactor: Redactor;
}

const SEEDS = [
  ['shots', 'shotsPath', 'packages/engine/test/fixtures/shots/talking-head-20s.json'],
  ['facetracks', 'facetrackPath', 'packages/engine/test/fixtures/facetracks/talking-head-20s.json'],
] as const;

/** A project with the input's video ingested from disk and its analysis files seeded. */
export async function setupInput(
  e: Engine,
  input: EvalInput,
): Promise<{ projectId: string; mediaId: string }> {
  const p = await e.createProject(`eval ${input.id}`);
  const ing = (await runEngineJob(e, 'ingest', {
    projectId: p.id,
    inputs: [join(REPO_ROOT, input.video)],
    actor: 'cli',
  })) as { media: { mediaId: string }[] };
  const mediaId = ing.media[0]!.mediaId;
  const dir = join(e.projectsDir, p.id);
  const patch: Record<string, string> = {};
  const seed = (folder: string, field: string, src: string) => {
    mkdirSync(join(dir, folder), { recursive: true });
    copyFileSync(join(REPO_ROOT, src), join(dir, folder, `${mediaId}.json`));
    patch[field] = `${folder}/${mediaId}.json`;
  };
  for (const [folder, field, src] of SEEDS) seed(folder, field, src);
  seed('transcripts', 'transcriptPath', input.transcript);
  patch['transcriptRev'] = createHash('sha256')
    .update(readFileSync(join(REPO_ROOT, input.transcript)))
    .digest('hex')
    .slice(0, 16);
  await e.applyOp(p.id, { op: 'updateMedia', args: { mediaId, patch } } as never, { actor: 'cli' });
  return { projectId: p.id, mediaId };
}

const engineAt = (deps: EvalDeps) => {
  const projectsDir = join(mkdtempSync(join(tmpdir(), 'vox-eval-')), 'Projects');
  return (
    deps.engine?.(projectsDir) ??
    openEngine({ projectsDir, stylesDirs: [join(REPO_ROOT, 'styles')] })
  );
};

function bounds(e: Engine, input: EvalInput): ClipBounds {
  const pacing = e.styles.get('vox').style.pacing;
  return {
    minMs: input.minMs,
    maxMs: input.maxMs,
    speakerRatio: pacing?.speakerRatio ?? { min: 0, max: 1 },
  };
}

export function workflowDeps(deps: EvalDeps, e: Engine, pauses: PauseInfo[]): WorkflowDeps {
  return {
    engine: e,
    redactor: deps.redactor,
    models: deps.models,
    limits: { maxUsdPerRun: deps.maxUsdPerRun, maxStepsPerRun: deps.maxStepsPerRun },
    onPause: (p) => {
      pauses.push(p);
      return Promise.resolve({ action: 'stop' });
    },
    ...(deps.runJob && { runJob: deps.runJob }),
  };
}

/** The clipper on one fixture input. */
export async function runInput(deps: EvalDeps, input: EvalInput): Promise<Scorecard> {
  const e = engineAt(deps);
  const { projectId, mediaId } = await setupInput(e, input);
  const t0 = Date.now();
  const r = await runWorkflow(workflowDeps(deps, e, []), {
    projectId,
    workflow: 'clipper',
    message: input.instruction,
    mode: deps.mode,
    mediaId,
    count: input.count ?? 3,
    minMs: input.minMs,
    maxMs: input.maxMs,
    tighten: 'all',
  });
  const p = await e.getProject(projectId);
  const violations = clipViolations(p, r.sequenceIds, bounds(e, input));
  if (r.sequenceIds.length !== (input.count ?? 3))
    violations.push(
      `${String(r.sequenceIds.length)} clip(s), asked for ${String(input.count ?? 3)}`,
    );
  return scorecard(input.id, r, violations, Date.now() - t0);
}

/**
 * The injection case (S20, S34): the injection transcript under a quick clip whose first scene shows
 * the orders as on-image text, and an archive-like image item whose picture and description carry
 * the same orders; then Stylize on that clip.
 */
export async function runInjection(deps: EvalDeps, inj: EvalPlan['injection']): Promise<Scorecard> {
  const e = engineAt(deps);
  const { projectId, mediaId } = await setupInput(e, inj);
  const job = deps.runJob ?? ((k, a) => runEngineJob(e, k, a));
  const q = (await job('quickClips', {
    projectId,
    mediaId,
    count: 1,
    minMs: inj.minMs,
    maxMs: inj.maxMs,
    scorer: 'heuristic',
    actor: 'cli',
  })) as { sequenceIds: string[] };
  const sequenceId = q.sequenceIds[0]!;
  const op = (o: unknown) => e.applyOp(projectId, o as never, { actor: 'cli' });
  await op({ op: 'updateSequence', args: { sequenceId, styleId: 'vox' } });
  await op({
    op: 'addScene',
    args: {
      sequenceId,
      trackId: 'V2',
      startMs: 0,
      durationMs: 2000,
      template: 'vox/kinetic-serif',
      variables: { text: inj.imageText.slice(0, 60) },
    },
  });
  const [frame] = await e.frames(projectId, sequenceId, [1000]);
  const rel = 'media/orders.png';
  copyFileSync(frame!, join(e.projectsDir, projectId, rel));
  await op({
    op: 'addMedia',
    args: {
      media: {
        id: 'm_orders0000000001',
        kind: 'image',
        path: rel,
        width: 1080,
        height: 1920,
        origin: { type: 'archive', attribution: inj.imageText },
        tags: ['archive'],
        description: inj.imageText,
      },
    },
  });
  const before = await e.getProject(projectId);
  const pauses: PauseInfo[] = [];
  const t0 = Date.now();
  const r = await runWorkflow(workflowDeps(deps, e, pauses), {
    projectId,
    workflow: 'stylize',
    message: inj.instruction,
    mode: deps.mode,
    sequenceIds: [sequenceId],
  });
  const after: Project = await e.getProject(projectId);
  const violations = injectionViolations({
    before,
    after,
    calls: r.run.calls,
    pauses,
    userTexts: [inj.instruction],
  });
  return scorecard(inj.id, r, violations, Date.now() - t0);
}

export async function runEvals(deps: EvalDeps, plan = loadInputs()): Promise<Scorecard[]> {
  const out: Scorecard[] = [];
  for (const input of plan.inputs) out.push(await runInput(deps, input));
  out.push(await runInjection(deps, plan.injection));
  return out;
}

export function formatScorecards(cards: readonly Scorecard[]): string {
  return cards
    .map(
      (c) =>
        `${c.pass ? 'PASS' : 'FAIL'} ${c.input} [${c.mode}] ${Object.values(c.models).join(', ')}\n` +
        `  status ${c.status}; checkpoints met ${String(c.checkpoints.met)}, skipped ${String(c.checkpoints.skipped)}, missed ${String(c.checkpoints.missed.length)}; cost $${c.costUsd.toFixed(4)}; ${String(Math.round(c.timeMs / 1000))} s\n` +
        [
          ...c.checkpoints.missed.map((m) => `  missed: ${m}`),
          ...c.violations.map((v) => `  violation: ${v}`),
        ]
          .map((l) => `${l}\n`)
          .join(''),
    )
    .join('');
}

/** The top-level error line, redacted (S19): a provider error may quote a key. */
export function fatalMessage(err: unknown, redactor: Redactor): string {
  return `${redactor.redact(err instanceof Error ? err.message : String(err))}\n`;
}

async function main(argv: string[], redactor: Redactor): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      provider: { type: 'string' },
      model: { type: 'string' },
      mode: { type: 'string' },
      json: { type: 'boolean' },
    },
    strict: true,
  });
  const cfgDeps = {
    io: engineConfigIO(process.env),
    keychain: createSecurityKeychain(),
    env: process.env,
    redactor,
  };
  let conf = await loadAgentConfig(cfgDeps);
  if (values.provider !== undefined) {
    // every role on one configured provider: --model, else the first reference model for it
    const entry = findProvider(conf, values.provider);
    const refs = JSON.parse(readFileSync(join(HERE, 'models.json'), 'utf8')) as Record<
      string,
      { provider: string; model: string }[] | string
    >;
    const kind = entry.preset ?? entry.type;
    const model =
      values.model ??
      Object.values(refs)
        .flatMap((v) => (Array.isArray(v) ? v : []))
        .find((r) => r.provider === kind)?.model;
    if (!model) throw new Error(`no reference model for ${kind}; pass --model <id>`);
    const ref = { providerId: entry.id ?? values.provider, model };
    // the Apple on-device model has no vision; its runs use the text-only fallbacks
    conf = {
      ...conf,
      roles:
        kind === 'apple' ? { editor: ref, fast: ref } : { editor: ref, fast: ref, vision: ref },
    };
  }
  // the Apple helper as the CLI finds it: VOX_APPLE_LLM, else the dev build in native/apple-llm
  const appleCommand =
    process.env['VOX_APPLE_LLM'] ||
    join(REPO_ROOT, 'native/apple-llm/.build/release/vox-apple-llm');
  const apple = existsSync(appleCommand) ? { command: appleCommand } : undefined;
  const built = await buildRunModels(conf, cfgDeps, {
    createModel: (entry, modelId, apiKey) =>
      createLanguageModel(entry, modelId, { apiKey, ...(apple && { apple }) }),
    ...(apple && { apple }),
  });
  if (!built.models.editor) throw new Error('no editor model: set one, or pass --provider');
  const mode = (values.mode as AgentMode | undefined) ?? built.mode ?? 'tools';
  const cards = await runEvals({
    models: built.models,
    mode,
    maxUsdPerRun: conf.limits.maxUsdPerRun,
    maxStepsPerRun: conf.limits.maxStepsPerRun,
    redactor,
  });
  process.stdout.write(
    redactor.redact(values.json ? `${JSON.stringify(cards, null, 2)}\n` : formatScorecards(cards)),
  );
  return cards.every((c) => c.pass) ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const redactor = createRedactor();
  main(process.argv.slice(2), redactor).then(
    (code) => (process.exitCode = code),
    (err: unknown) => {
      process.stderr.write(fatalMessage(err, redactor));
      process.exitCode = 1;
    },
  );
}
