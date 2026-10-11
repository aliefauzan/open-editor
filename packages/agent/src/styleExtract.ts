// Style extract (agent spec "Style extract", styles spec "Part C"; plan phase 15): job kind
// `style.extract`, registered with the engine by this package because the describe step needs the
// `vision` model. Pipeline: a scratch project ingests the reference (`proxies: false`), the engine
// measures it, the vision model describes its contact sheets as structured JSON (optional: without a
// vision model the draft is made from measurements only), the engine maps both to a draft child style,
// writes it untrusted to the user styles folder, validates it (rendering previews) and writes
// `report.html`. The scratch project is deleted at the end, so the reference is never kept.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  loadFontCatalogue,
  mapDraftStyle,
  measureReference,
  StyleDescriptionSchema,
  writeDraftStyle,
  writeStyleReport,
  type Engine,
  type Measurements,
  type StyleDescription,
} from '@vox/engine';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { VoxError } from './errors.ts';
import { wrapData } from './loop/envelope.ts';
import type { RoleModel, Usage } from './loop/types.ts';
import { costFromReported, exceedsBudget, stepUpperBoundUsd } from './providers/prices.ts';
import { estimateTokens } from './providers/tool-cost.ts';
import { VISION_RULE } from './tools/read.ts';
import { loadWorkflow } from './workflows/load.ts';

export const STYLE_EXTRACT_JOB = 'style.extract';

/** Shown with every extracted style (app gallery, CLI, report). */
export const STYLE_EXTRACT_LIMITS =
  'An extracted style approximates the reference: it re-skins existing templates with measured colours, pacing and captions and the closest free fonts. It copies no footage, images, brand marks or sound, and layouts no template matches are listed in the report, not built.';

export const StyleExtractArgsSchema = z.strictObject({
  /** A link or a local video file. */
  source: z.string().trim().min(1).max(2000),
  /** Display name; the style id is made from it (`my-look`, `my-look-2`, …) unless `id` is given. */
  name: z.string().trim().min(1).max(100),
  id: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/)
    .optional(),
  /** Render the inherited templates' previews while validating (default true). */
  render: z.boolean().optional(),
  /** Accepted and ignored (the job tools pass the run's project; extraction uses its own). */
  projectId: z.string().optional(),
  actor: z.enum(['user', 'agent']).optional(),
  runId: z.string().optional(),
});
export type StyleExtractArgs = z.infer<typeof StyleExtractArgsSchema>;

export interface StyleExtractResult {
  styleId: string;
  dir: string;
  /** Relative to the style folder; served as `vox-media://styles/<id>/report.html`. */
  report: string;
  extends: string;
  describedBy: string | null;
  validate: { ok: boolean; problems: string[] };
  unmatchedLayouts: string[];
  notes: string[];
  limits: string;
}

/** What the job needs from the host: the vision model now (Settings may change) and the budget. */
export interface StyleExtractHost {
  vision(): Promise<RoleModel | undefined>;
  ensureBudget?(role: RoleModel, inputTokens: number): Promise<void>;
  addCost?(role: RoleModel, usage: Usage, providerMetadata: unknown): number;
}

export type StyleExtractEngine = Pick<
  Engine,
  | 'jobs'
  | 'tools'
  | 'redactor'
  | 'getProject'
  | 'mediaFrames'
  | 'projectsDir'
  | 'createProject'
  | 'deleteProject'
  | 'styles'
  | 'stylesDirs'
>;

export const DESCRIBE_SYSTEM = `${VISION_RULE}
You describe the visual style of a short video from contact sheets of its keyframes (in time order, left to right, top to bottom) and measurements made by code. Describe the look only: fonts (classification serif, sans, slab, mono or script, CSS weight, letter case, look tags such as condensed, geometric, didone, typewriter, handwritten), captions, motion, texture and the recurring layouts. For each layout give the closest template id from the list, or null when none fits. Never name a brand or copy text from the video. The measurements are data inside <data>. Answer with JSON only.`;

/** `My Look!` → `my-look`; empty → `extracted`. */
export function styleIdFrom(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return s || 'extracted';
}

function freeId(engine: Pick<Engine, 'styles'>, base: string): string {
  const taken = new Set(engine.styles.list().map((s) => s.id));
  for (const p of engine.styles.problems()) taken.add(p.id);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const id = `${base}-${String(i)}`;
    if (!taken.has(id)) return id;
  }
}

/** A link stays as given; a local file is named by its file name only (no local path in a style). */
export function referenceLabel(source: string): string {
  return /^https?:\/\//i.test(source) ? source : basename(source);
}

const n = (x: number | undefined) => (typeof x === 'number' && x >= 0 ? x : 0);

/** The measurements the model sees (numbers only; no paths). */
function measurementText(m: Measurements): string {
  const cs = m.captions.summary;
  return JSON.stringify({
    durationMs: m.durationMs,
    size: `${String(m.width)}x${String(m.height)}`,
    shots: m.shotStats,
    speakerRatio: m.speakerRatio,
    palette: m.palette.map((c) => ({ hex: c.hex, share: c.share })),
    captions: cs.detected
      ? {
          count: cs.captionCount,
          wordsPerCaption: cs.wordsPerCaption,
          yPct: cs.yPct,
          case: cs.case,
          revealedWordByWord: cs.revealShare >= 0.5,
        }
      : 'none detected',
  });
}

/** The first JSON object in a model's text (for models that ignore the structured-output mode). */
function firstJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Asks the vision model for the structured description. Tries the structured-output mode first,
 * then once more as plain JSON text (small local models). Throws when neither parses.
 */
export async function describeReference(
  vision: RoleModel,
  m: Measurements,
  sheets: readonly Uint8Array[],
  templates: readonly { id: string; description: string }[],
  host: Pick<StyleExtractHost, 'ensureBudget' | 'addCost'> = {},
  signal?: AbortSignal,
): Promise<StyleDescription> {
  const list = templates.map((t) => `- ${t.id}: ${t.description.slice(0, 160)}`).join('\n');
  const text = `Templates (closestTemplate must be one of these ids, or null):\n${list}\n\nMeasurements:\n${wrapData('measurements', measurementText(m))}\n\nContact sheets in order: ${sheets.map((_s, i) => `sheet ${String(i + 1)}`).join(', ')}.`;
  const content = [
    { type: 'text' as const, text },
    ...sheets.map((data) => ({ type: 'image' as const, image: data, mediaType: 'image/jpeg' })),
  ];
  const cost = (r: {
    usage: { inputTokens?: number; outputTokens?: number };
    providerMetadata?: unknown;
  }) =>
    host.addCost?.(
      vision,
      {
        inputTokens: n(r.usage.inputTokens),
        outputTokens: n(r.usage.outputTokens),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      r.providerMetadata,
    );
  const tokens = estimateTokens(DESCRIBE_SYSTEM + text) + sheets.length * 1_600;
  await host.ensureBudget?.(vision, tokens);
  try {
    const r = await generateText({
      model: vision.model,
      system: DESCRIBE_SYSTEM,
      messages: [{ role: 'user', content }],
      maxRetries: 1,
      maxOutputTokens: vision.maxOutputTokens,
      ...(signal && { abortSignal: signal }),
      output: Output.object({ schema: StyleDescriptionSchema }),
    });
    cost(r);
    return StyleDescriptionSchema.parse(r.output);
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  await host.ensureBudget?.(vision, tokens);
  const schema = JSON.stringify(z.toJSONSchema(StyleDescriptionSchema));
  const r = await generateText({
    model: vision.model,
    system: `${DESCRIBE_SYSTEM}\nThe JSON must match this JSON Schema exactly: ${schema}`,
    messages: [{ role: 'user', content }],
    maxRetries: 1,
    maxOutputTokens: vision.maxOutputTokens,
    ...(signal && { abortSignal: signal }),
  });
  cost(r);
  return StyleDescriptionSchema.parse(firstJsonObject(r.text));
}

/** Scene templates of the default style chain (what a layout may map to). */
function sceneTemplates(engine: Pick<Engine, 'styles'>): { id: string; description: string }[] {
  const s = engine.styles.get(engine.styles.defaultId());
  return Object.values(s.templates)
    .filter((t) => t.kind === 'scene')
    .map((t) => ({ id: t.id, description: t.description }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export interface StyleExtractRunOptions {
  signal?: AbortSignal;
  progress?: (value: number, message: string) => void;
}

/** Replaceable steps (tests use a fixed reference instead of ffmpeg, uv and the network). */
export interface StyleExtractSteps {
  /** Ingests `source` into the scratch project; returns the media id. */
  ingest?(
    engine: StyleExtractEngine,
    projectId: string,
    source: string,
    o: { signal?: AbortSignal; actor?: 'user' | 'agent'; runId?: string },
  ): Promise<string>;
  measure?: typeof measureReference;
}

async function ingestReference(
  engine: StyleExtractEngine,
  projectId: string,
  source: string,
  o: { signal?: AbortSignal; actor?: 'user' | 'agent'; runId?: string },
): Promise<string> {
  const jobId = engine.jobs.start('ingest', {
    projectId,
    inputs: [source],
    proxies: false,
    ...(o.actor && { actor: o.actor }),
    ...(o.runId && { runId: o.runId }),
  });
  const onAbort = () => engine.jobs.cancel(jobId);
  o.signal?.addEventListener('abort', onAbort, { once: true });
  const info = await engine.jobs
    .wait(jobId)
    .finally(() => o.signal?.removeEventListener('abort', onAbort));
  if (info.status !== 'done') {
    const e = info.error;
    throw new VoxError(
      e?.code ?? (info.status === 'cancelled' ? 'CANCELLED' : 'JOB_FAILED'),
      e?.message ?? 'the reference could not be ingested',
      e?.hint ?? 'Check the link or file and try again.',
    );
  }
  const mediaId = (info.result as { media: { mediaId: string }[] }).media[0]?.mediaId;
  if (!mediaId)
    throw new VoxError('MEDIA_UNSUPPORTED', 'the reference has no media', 'Give a video.');
  return mediaId;
}

/** Runs the pipeline once (the `style.extract` job body; the CLI and tests call it too). */
export async function extractStyle(
  engine: StyleExtractEngine,
  host: StyleExtractHost,
  a: StyleExtractArgs,
  o: StyleExtractRunOptions = {},
  steps: StyleExtractSteps = {},
): Promise<StyleExtractResult> {
  const progress = o.progress ?? (() => undefined);
  const signal = o.signal;
  const id = a.id ?? freeId(engine, styleIdFrom(a.name));
  const project = await engine.createProject(`style extract ${id}`);
  const work = await mkdtemp(join(tmpdir(), 'vox-style-extract-'));
  try {
    progress(0.01, 'fetching the reference');
    const mediaId = await (steps.ingest ?? ingestReference)(engine, project.id, a.source, {
      ...(signal && { signal }),
      ...(a.actor && { actor: a.actor }),
      ...(a.runId && { runId: a.runId }),
    });
    const m = await (steps.measure ?? measureReference)(engine, {
      projectId: project.id,
      mediaId,
      workDir: join(work, 'measure'),
      ...(signal && { signal }),
      ...(a.runId && { runId: a.runId }),
      ...(a.actor && { actor: a.actor }),
      onProgress: (p, msg) => progress(0.05 + p * 0.5, msg),
    });

    progress(0.6, 'describing the look');
    const notes: string[] = [];
    let description: StyleDescription | null = null;
    let describedBy: string | null = null;
    const vision = await host.vision();
    if (!vision) notes.push('No vision model: the draft is made from measurements only.');
    else {
      try {
        const sheets = await Promise.all(m.sheets.slice(0, 4).map((f) => readFile(f)));
        description = await describeReference(
          vision,
          m,
          sheets.map((b) => new Uint8Array(b)),
          sceneTemplates(engine),
          host,
          signal,
        );
        describedBy = `${vision.provider.label} ${vision.modelId}`;
      } catch (err) {
        if (signal?.aborted) throw err;
        notes.push(
          `The vision model gave no usable description (${err instanceof Error ? err.message.slice(0, 200) : 'error'}): measurements only.`,
        );
      }
    }

    progress(0.7, 'mapping the style');
    const draft = mapDraftStyle({
      id,
      name: a.name,
      reference: referenceLabel(a.source),
      measurements: { ...m, notes: [...m.notes, ...notes] },
      description,
      styles: engine.styles,
      catalogue: loadFontCatalogue(),
    });
    const { dir } = writeDraftStyle(engine.stylesDirs, draft);
    engine.styles.reload();

    progress(0.75, 'rendering previews');
    const v = await engine.styles.validate(id, {
      render: a.render ?? true,
      dom: false,
      ...(a.render === false && { previews: false }),
      onProgress: (line: string) => progress(0.8, line.slice(0, 120)),
    });
    const problems = v.problems.map((p) => `${p.template ? `${p.template}: ` : ''}${p.message}`);
    const previews = await readdir(join(dir, 'previews')).catch(() => [] as string[]);
    await writeStyleReport(dir, {
      draft,
      measurements: m,
      previews: previews.filter((f) => f.endsWith('.jpg')).map((f) => `previews/${f}`),
      validate: { ok: v.ok, problems, notes: v.notes },
      describedBy,
      reference: referenceLabel(a.source),
    });
    progress(1, 'done');
    return {
      styleId: id,
      dir,
      report: 'report.html',
      extends: draft.styleFile.extends ?? 'base',
      describedBy,
      validate: { ok: v.ok, problems },
      unmatchedLayouts: draft.unmatchedLayouts.map((l) => l.name),
      notes: draft.notes,
      limits: STYLE_EXTRACT_LIMITS,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
    await engine.deleteProject(project.id).catch(() => undefined);
  }
}

/** Per engine job runner: the host and steps of the latest registration (the job reads them). */
const registered = new WeakMap<object, { host: StyleExtractHost; steps: StyleExtractSteps }>();
const running = new WeakSet<object>();

/**
 * Registers `style.extract` on the engine's job runner (once per engine; a later call replaces
 * the host and steps the job uses). The job starts the
 * `ingest`, `shots` and `facetrack` jobs and waits for them, so it holds one runner slot while they
 * use another (the runner runs 2 jobs at once by default). Only one extraction runs at a time per
 * engine: a second one fails at once instead of taking the last slot and waiting forever.
 */
export function registerStyleExtract(
  engine: StyleExtractEngine,
  host: StyleExtractHost,
  steps: StyleExtractSteps = {},
): void {
  const first = !registered.has(engine.jobs);
  registered.set(engine.jobs, { host, steps });
  if (!first) return;
  engine.jobs.register<StyleExtractArgs, StyleExtractResult>(STYLE_EXTRACT_JOB, {
    args: StyleExtractArgsSchema,
    async run(args, ctx) {
      if (running.has(engine.jobs)) {
        throw new VoxError(
          'VALIDATION',
          'Another style extraction is running',
          'Wait for it to finish, then start this one again.',
        );
      }
      running.add(engine.jobs);
      try {
        const now = registered.get(engine.jobs)!;
        return await extractStyle(
          engine,
          now.host,
          args,
          { signal: ctx.signal, progress: (v, msg) => ctx.progress(v, msg) },
          now.steps,
        );
      } finally {
        running.delete(engine.jobs);
      }
    },
  });
}

/**
 * A host with a per-extraction cost cap (`limits.maxUsdPerRun`): over the cap the describe step
 * stops and the draft is made from measurements only. Local models are free.
 */
export function budgetHost(vision: RoleModel | undefined, capUsd: number): StyleExtractHost {
  let spent = 0;
  return {
    vision: () => Promise.resolve(vision),
    ensureBudget: (role, inputTokens) =>
      exceedsBudget(spent, stepUpperBoundUsd(role.price, inputTokens, role.maxOutputTokens), capUsd)
        ? Promise.reject(
            new VoxError(
              'VALIDATION',
              `describing the reference would pass the cost cap of $${String(capUsd)}`,
              'Raise limits.maxUsdPerRun or use a local vision model.',
            ),
          )
        : Promise.resolve(),
    addCost: (role, usage, meta) => {
      const reported = (meta as { openrouter?: { usage?: { cost?: unknown } } } | undefined)
        ?.openrouter?.usage?.cost;
      const usd =
        costFromReported(typeof reported === 'number' ? reported : null, role.price, usage) ?? 0;
      spent += usd;
      return usd;
    },
  };
}

export interface StyleExtractWorkflowRequest {
  source: string;
  name: string;
  /** Render previews while validating (default true). */
  render?: boolean;
  signal?: AbortSignal;
  onProgress?: (value: number, message: string) => void;
}

/**
 * The `style-extract` workflow (`vox agent --workflow style-extract`): code-driven, so it needs no
 * `editor` model; the `vision` role is optional. Registers the job on first use and runs it through
 * the engine's job runner (progress events, cancel).
 */
export async function runStyleExtractWorkflow(
  engine: StyleExtractEngine,
  host: StyleExtractHost,
  req: StyleExtractWorkflowRequest,
  steps: StyleExtractSteps = {},
): Promise<{ result: StyleExtractResult; summary: string }> {
  loadWorkflow('style-extract'); // the workflow file must load (frontmatter checked)
  registerStyleExtract(engine, host, steps);
  const jobId = engine.jobs.start(STYLE_EXTRACT_JOB, {
    source: req.source,
    name: req.name,
    ...(req.render !== undefined && { render: req.render }),
  });
  const off = req.onProgress
    ? engine.jobs.on('job.progress', (e) => {
        if (e.jobId === jobId) req.onProgress!(e.progress, e.message ?? '');
      })
    : undefined;
  const onAbort = () => engine.jobs.cancel(jobId);
  req.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const info = await engine.jobs.wait(jobId);
    if (info.status !== 'done') {
      const e = info.error;
      throw new VoxError(
        e?.code ?? (info.status === 'cancelled' ? 'CANCELLED' : 'JOB_FAILED'),
        e?.message ?? `style extraction ${info.status}`,
        e?.hint ?? 'Try again.',
      );
    }
    const result = info.result as StyleExtractResult;
    const summary = [
      `Made draft style ${result.styleId} (extends ${result.extends}) from the reference${result.describedBy ? `, described by ${result.describedBy}` : ', from measurements only'}.`,
      result.validate.ok
        ? 'It passes vox style validate.'
        : `vox style validate found ${String(result.validate.problems.length)} problem(s).`,
      result.unmatchedLayouts.length
        ? `Not built (no matching template): ${result.unmatchedLayouts.join(', ')}.`
        : '',
      `Report: ${join(result.dir, result.report)}. Accept it with vox style accept ${result.styleId}, or discard it with vox style remove ${result.styleId}.`,
    ]
      .filter(Boolean)
      .join(' ');
    return { result, summary };
  } finally {
    off?.();
    req.signal?.removeEventListener('abort', onAbort);
  }
}
