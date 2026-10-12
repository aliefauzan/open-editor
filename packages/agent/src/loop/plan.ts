// Plan mode (agent spec "Plan mode"; plan phase 11 step 9). The model answers with one structured
// plan (a `ClipPlan` or a list of engine ops), zod-validated; invalid plans go back with the zod
// error (max 2 retries). Code then executes it as one `batch`: slot filling (search → fetch →
// cutout; generate only when search finds nothing and a provider exists; else a placeholder scene)
// and small repairs (at most two scenes of a template, D-94; move scenes to when their words are
// spoken, D-92; variables fitted to their template, D-94; clamp durations to template bounds and the
// sequence, drop beats that cannot fit). With `confirmPlan` each validated plan pauses for approval (kind `plan`) before it runs.
import {
  OP_ARGS,
  OP_NAMES,
  mapWordsToTimeline,
  type Project,
  type Transcript,
  type TemplateInfo,
  type TemplateLookup,
  validateVariables,
} from '@vox/engine';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { VoxError, isVoxError, toVoxErrorJson } from '../errors.ts';
import { writingJob } from '../tools/jobs.ts';
import { applyAsAgent } from '../tools/ops.ts';
import { invokeTool } from '../tools/registry.ts';
import { loadTranscript, transcriptLines } from '../tools/transcript.ts';
import type { AgentRun } from './run.ts';
import { RunStopped } from './run.ts';
import { wrapData } from './envelope.ts';
import {
  clearOfCaptions,
  fitVariables,
  textLedTemplates,
  toTextLed,
  varySceneTemplates,
} from './plan-repair.ts';
import { sceneTexts, speechTokens, syncScenesToSpeech, type SpokenWord } from './speech-sync.ts';
import type { TurnOptions, TurnResult } from './types.ts';

export const MAX_PLAN_RETRIES = 2;
export const PLACEHOLDER_TEMPLATE = 'base/placeholder';

const ms = z.int().min(0);

export const ClipPlanSchema = z.strictObject({
  sequences: z
    .array(
      z.strictObject({
        sequenceId: z.string().min(1),
        beats: z
          .array(
            z
              .strictObject({
                startMs: ms,
                endMs: ms,
                kind: z.enum(['speaker', 'scene']),
                // Guided-generation models (Apple on-device) fill every field: a speaker beat may
                // come back with an empty template, which means none.
                template: z.string().optional(),
                variables: z.record(z.string(), z.unknown()).optional(),
                imageQueries: z.array(z.string().trim().min(1).max(200)).max(4).optional(),
              })
              // a beat that does not end after it starts is dropped as a repair (clipPlanToOps), so
              // one slip among many beats of a small model does not reject the whole plan
              .refine((b) => b.kind === 'speaker' || (b.template ?? '') !== '', {
                message: 'a scene beat needs a template',
              }),
          )
          .min(1)
          .max(80),
      }),
    )
    .min(1)
    .max(20),
});
export type ClipPlan = z.infer<typeof ClipPlanSchema>;

const PLAN_OPS = OP_NAMES.filter((o) => o !== 'batch') as [string, ...string[]];
export const OpsPlanSchema = z.strictObject({
  ops: z
    .array(z.strictObject({ op: z.enum(PLAN_OPS), args: z.record(z.string(), z.unknown()) }))
    .min(1)
    .max(100),
});
export type OpsPlan = z.infer<typeof OpsPlanSchema>;

export interface PlanOp {
  op: string;
  args: Record<string, unknown>;
}

export interface Repair {
  beat: number;
  sequenceId: string;
  what: string;
}

/**
 * The retry hint for a plan with nothing to apply: says why each scene beat was dropped (a caption
 * preset used as a scene template, a beat that does not fit), so the next answer can fix it.
 */
export function emptyPlanHint(repairs: readonly Repair[]): string {
  const dropped = repairs.filter((r) => r.what.startsWith('dropped'));
  if (dropped.length === 0)
    return 'Plan at least one change: add a scene beat with a scene template from the list.';
  const why = dropped
    .slice(0, 8)
    .map((r) => r.what.replace(/^dropped: /, ''))
    .join('; ');
  return `Plan at least one change. Scene beats not applied: ${why}. Use scene templates from the list.`;
}

const issuesOf = (e: z.ZodError) =>
  e.issues
    .slice(0, 12)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');

/** Validates a plan answer (aliases resolved to engine ids). Throws PLAN_INVALID with the issues. */
export function validatePlan(
  run: Pick<AgentRun, 'aliases'>,
  kind: 'clip' | 'ops',
  value: unknown,
): ClipPlan | OpsPlan {
  let resolved: unknown;
  try {
    resolved = run.aliases.fromModel(value);
  } catch (err) {
    if (isVoxError(err)) throw new VoxError('PLAN_INVALID', err.message, err.hint);
    throw err;
  }
  const schema = kind === 'clip' ? ClipPlanSchema : OpsPlanSchema;
  const r = schema.safeParse(resolved);
  if (!r.success)
    throw new VoxError(
      'PLAN_INVALID',
      `the plan is invalid: ${issuesOf(r.error)}`,
      'Send a corrected plan.',
    );
  if (kind === 'ops') {
    const plan = r.data as OpsPlan;
    for (const [i, o] of plan.ops.entries()) {
      const schemaOf = OP_ARGS[o.op as keyof typeof OP_ARGS] as z.ZodType;
      const a = schemaOf.safeParse(o.args);
      if (!a.success) {
        throw new VoxError(
          'PLAN_INVALID',
          `ops.${String(i)} (${o.op}): ${issuesOf(a.error)}`,
          'Send a corrected plan.',
        );
      }
    }
  }
  return r.data;
}

function sequenceEnd(p: Project, sequenceId: string): number {
  const s = p.sequences.find((x) => x.id === sequenceId);
  if (!s)
    throw new VoxError(
      'PLAN_INVALID',
      `no sequence ${sequenceId}`,
      'Use a sequence id from the view.',
    );
  let end = 0;
  for (const t of [...s.videoTracks, ...s.audioTracks]) {
    for (const it of t.items) end = Math.max(end, it.startMs + it.durationMs);
  }
  return end;
}

/** Top-level image/cutout slots of a template (arrays and panels are filled by their own helpers). */
const fillableSlots = (t: TemplateInfo) =>
  Object.entries(t.slots).filter(
    ([path, kind]) => /^[A-Za-z0-9_]+$/.test(path) && (kind === 'image' || kind === 'cutout'),
  );

/** Media slots inside an array (slot path `items/<any>/media`): [array variable, field, kind]. */
const nestedSlots = (t: TemplateInfo) =>
  Object.entries(t.slots).flatMap(([path, kind]) => {
    const m = /^([A-Za-z0-9_]+)\/\*\/([A-Za-z0-9_]+)$/.exec(path);
    return m && (kind === 'image' || kind === 'cutout') ? [[m[1]!, m[2]!, kind] as const] : [];
  });

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Engine media id from an aliased tool result. */
function mediaIdOf(run: AgentRun, result: unknown): string | undefined {
  const r = (result as { result?: { mediaId?: unknown } } | undefined)?.result;
  return typeof r?.mediaId === 'string' ? run.aliases.resolve(r.mediaId) : undefined;
}

/** One registry tool call by the plan executor, recorded like a model's call. */
async function planCall(run: AgentRun, name: string, args: Record<string, unknown>) {
  const out = await invokeTool(run.ctx, run.registry, name, args);
  if (out.versions) run.versions.push(...out.versions);
  run.record.write({
    type: 'tool',
    tool: name,
    args,
    result: out.result,
    ...(out.versions && { versions: out.versions }),
    by: 'plan',
  });
  return out.result;
}

/** At most this many pictures a plan run generates (D-101): a local model takes about a minute each. */
export const MAX_GENERATED_PER_RUN = 6;
const generatedIn = new WeakMap<AgentRun, number>();

/**
 * A generated picture for `prompt` in the sequence's style (D-101): the engine appends the style's
 * `imagery.generateSuffix` (vox: torn paper collage). Square for a cutout, the canvas shape else.
 * Undefined when no provider is installed or the run already made MAX_GENERATED_PER_RUN.
 */
async function generated(
  run: AgentRun,
  prompt: string,
  kind: string,
  styleId: string | undefined,
): Promise<string | undefined> {
  const n = generatedIn.get(run) ?? 0;
  if (!run.registry.get('generate_image') || n >= MAX_GENERATED_PER_RUN) return undefined;
  generatedIn.set(run, n + 1);
  const size = kind === 'cutout' ? { width: 1024, height: 1024 } : { width: 1088, height: 1920 };
  return mediaIdOf(
    run,
    await planCall(run, 'generate_image', {
      prompt,
      ...(styleId !== undefined && { styleId }),
      ...size,
    }),
  );
}

/** The style of a slot's sequence (D-101: generated pictures take its look). */
function styleAt(p: Project, sequenceId: string): string | undefined {
  return p.sequences.find((s) => s.id === sequenceId)?.styleId;
}

/** search → fetch → (cutout); generate when search finds nothing and a provider exists. */
async function fillSlot(
  run: AgentRun,
  query: string,
  kind: string,
  styleId?: string,
): Promise<string | undefined> {
  try {
    let mediaId: string | undefined;
    const found = (await planCall(run, 'search_images', { query })) as {
      candidates?: { id?: unknown }[];
    };
    const first = found.candidates?.find((c) => typeof c.id === 'string');
    if (first)
      mediaId = mediaIdOf(run, await planCall(run, 'fetch_image', { candidateId: first.id }));
    else mediaId = await generated(run, query, kind, styleId);
    if (mediaId && kind === 'cutout')
      mediaId = mediaIdOf(
        run,
        await planCall(run, 'cutout', { mediaId: run.aliases.aliasOf(mediaId) }),
      );
    return mediaId;
  } catch (err) {
    if (err instanceof RunStopped) throw err;
    run.record.write({
      type: 'slotFailed',
      query,
      error: isVoxError(err) ? toVoxErrorJson(err) : 'error',
    });
    return undefined;
  }
}

/** The project media a slot value names (an engine id or a short id such as `m1`). */
function mediaNamed(run: AgentRun, p: Project, v: unknown) {
  if (typeof v !== 'string') return undefined;
  const id = run.aliases.resolve(v.trim());
  return id === undefined ? undefined : p.media.find((m) => m.id === id);
}

/** A picture of the project in a slot value (the model was told to leave slots empty). */
const imageNamed = (run: AgentRun, p: Project, v: unknown) => {
  const m = mediaNamed(run, p, v);
  return m?.kind === 'image' ? m.id : undefined;
};

/** The text the model wrote in a slot when it is a description (has a space), as a query. */
const describedQuery = (v: unknown) =>
  typeof v === 'string' && /\s/.test(v.trim()) ? v.trim().slice(0, 120) : undefined;

/** Where a picture slot sits in time: its sequence and the sequence ms a still would show. */
interface StillAt {
  sequenceId: string;
  atMs: number;
}

/**
 * A still of a project video at sequence time `at.atMs` (D-90): one local frame (`mediaFrames`),
 * added as an image with the video's origin (credits stay right), then cut out for a cutout slot
 * (the plain still when the cutout fails). The frame path is the engine's own, never the model's,
 * so the ingest source rule (S20) is not in play. Undefined when no still could be made.
 */
async function stillOf(
  run: AgentRun,
  p: Project,
  videoId: string,
  at: StillAt,
  kind: string,
): Promise<{ mediaId: string; srcMs: number } | undefined> {
  const video = p.media.find((m) => m.id === videoId);
  if (video?.kind !== 'video' || !video.durationMs) return undefined;
  const seq = p.sequences.find((s) => s.id === at.sequenceId);
  const clips = (seq?.videoTracks ?? [])
    .flatMap((t) => t.items)
    .flatMap((it) => (it.type === 'media' && it.mediaId === videoId ? [it] : []));
  const clip =
    clips.find((c) => at.atMs >= c.startMs && at.atMs < c.startMs + c.durationMs) ?? clips[0];
  // source time shown at the beat time (engine spec "Clip speed"); a video not on the sequence: its middle
  const raw = clip
    ? clip.inMs +
      (clamp(at.atMs, clip.startMs, clip.startMs + clip.durationMs - 1) - clip.startMs) *
        (clip.speed ?? 1)
    : video.durationMs / 2;
  const srcMs = clamp(Math.round(raw), 0, video.durationMs - 1);
  try {
    const [frame] = await run.ctx.engine.mediaFrames(run.ctx.projectId, videoId, [srcMs]);
    if (!frame) return undefined;
    const added = await writingJob(run.ctx, 'ingest', { inputs: [frame] });
    if (added.versions) run.versions.push(...added.versions);
    const res = added.result as { result?: { media?: { mediaId?: unknown }[] } };
    const alias = res.result?.media?.[0]?.mediaId;
    const stillId = typeof alias === 'string' ? run.aliases.resolve(alias) : undefined;
    run.record.write({
      type: 'tool',
      tool: 'ingest',
      args: { still: { mediaId: run.aliases.aliasOf(videoId), atSrcMs: srcMs } },
      result: added.result,
      ...(added.versions && { versions: added.versions }),
      by: 'plan',
    });
    if (!stillId) return undefined;
    const description = `Still of ${videoId} at ${String(srcMs)} ms`;
    const now = await run.ctx.engine.getProject(run.ctx.projectId);
    if (now.media.find((m) => m.id === stillId)?.description !== description) {
      const op = await applyAsAgent(run.ctx, 'updateMedia', {
        mediaId: stillId,
        patch: { origin: video.origin, description, tags: ['still'] },
      });
      if (op.versions) run.versions.push(...op.versions);
    }
    if (kind !== 'cutout') return { mediaId: stillId, srcMs };
    try {
      const cut = mediaIdOf(
        run,
        await planCall(run, 'cutout', { mediaId: run.aliases.aliasOf(stillId) }),
      );
      return { mediaId: cut ?? stillId, srcMs };
    } catch (err) {
      if (err instanceof RunStopped) throw err;
      return { mediaId: stillId, srcMs };
    }
  } catch (err) {
    if (err instanceof RunStopped) throw err;
    run.record.write({
      type: 'slotFailed',
      still: { mediaId: run.aliases.aliasOf(videoId), atSrcMs: srcMs },
      error: isVoxError(err) ? toVoxErrorJson(err) : 'error',
    });
    return undefined;
  }
}

/**
 * A picture query the run made up for a beat whose model gave none (D-94): the scene's first text
 * (its label), else the beat's spoken words. One archive search per beat; its candidates fill the
 * beat's picture slots in order (a collage's items get different pictures). When the archive has
 * nothing (left) and an image model is installed, up to AUTO_GENERATED_PER_BEAT pictures are made
 * from it in the style's look (D-101) before stills of the source.
 */
interface AutoQuery {
  query: string;
  from: 'scene text' | 'speech';
  /** Candidate ids left from the one search; undefined until searched. */
  candidates?: string[];
  found: number;
  /** Pictures generated for it (D-101), at most AUTO_GENERATED_PER_BEAT. */
  generated?: number;
}

/** Generated pictures one made-up query may take (D-101): a collage's other entries take stills. */
const AUTO_GENERATED_PER_BEAT = 2;

/** Longest made-up query, and the most spoken words it takes. */
const AUTO_QUERY_CHARS = 80;
const AUTO_QUERY_WORDS = 6;

/** The made-up query of a beat (D-94): its first text, else its spoken words of 4+ letters. */
function autoQuery(
  texts: readonly string[],
  words: readonly SpokenWord[],
  span: { startMs: number; endMs: number },
): AutoQuery | undefined {
  const text = texts.find((x) => speechTokens(x).some((w) => w.length >= 3));
  if (text !== undefined)
    return { query: text.slice(0, AUTO_QUERY_CHARS), from: 'scene text', found: 0 };
  const said = words
    .filter((w) => w.startMs >= span.startMs && w.startMs < span.endMs)
    .flatMap((w) => speechTokens(w.text))
    .filter((w) => w.length >= 4);
  const unique = [...new Set(said)].slice(0, AUTO_QUERY_WORDS);
  return unique.length === 0
    ? undefined
    : { query: unique.join(' ').slice(0, AUTO_QUERY_CHARS), from: 'speech', found: 0 };
}

/** The next archive picture of a made-up query: one search, then its candidates in order. */
async function autoPicture(
  run: AgentRun,
  auto: AutoQuery,
  kind: string,
  styleId?: string,
): Promise<string | undefined> {
  try {
    if (auto.candidates === undefined) {
      auto.candidates = [];
      const found = (await planCall(run, 'search_images', { query: auto.query })) as {
        candidates?: { id?: unknown }[];
      };
      for (const c of found.candidates ?? [])
        if (typeof c.id === 'string') auto.candidates.push(c.id);
    }
    const next = auto.candidates.shift();
    let mediaId: string | undefined;
    if (next !== undefined)
      mediaId = mediaIdOf(run, await planCall(run, 'fetch_image', { candidateId: next }));
    else if ((auto.generated ?? 0) < AUTO_GENERATED_PER_BEAT) {
      // D-101: nothing (left) in the archive: a picture made for the beat in the style's look
      mediaId = await generated(run, `An illustration of: ${auto.query}`, kind, styleId);
      if (mediaId === undefined) return undefined;
      auto.generated = (auto.generated ?? 0) + 1;
    } else return undefined;
    if (mediaId && kind === 'cutout')
      mediaId = mediaIdOf(
        run,
        await planCall(run, 'cutout', { mediaId: run.aliases.aliasOf(mediaId) }),
      );
    if (mediaId && next !== undefined) auto.found++;
    return mediaId;
  } catch (err) {
    if (err instanceof RunStopped) throw err;
    // a failed search or download ends the made-up query for this beat; stills take over
    auto.candidates = [];
    run.record.write({
      type: 'slotFailed',
      query: auto.query,
      error: isVoxError(err) ? toVoxErrorJson(err) : 'error',
    });
    return undefined;
  }
}

/** A picture slot's result: a picture, or the video a still should be taken of (`makeStill` off). */
interface Picture {
  id?: string;
  q?: string;
  /** The repair to note when a still filled the slot. */
  still?: string;
  /** With `makeStill` off: the video a still would be taken of. */
  stillVideo?: string;
}

/**
 * A picture for one slot whose value is not a picture of the project: the next image query, else the
 * description written in the slot. A slot that `needs` a picture and got no query and names no media
 * (`media: ""`) next tries the beat's made-up query (D-94). When that finds nothing, a still at the
 * slot's time (D-90) of the video the slot names (weak models write the source clip's id, D-88 live
 * runs), or, for a slot that `needs` a picture and got no query at all, of the sequence's own video
 * there. A query that finds nothing is never answered with a still of something else: the caller
 * makes a placeholder. `q` is the query used. With `makeStill` off the still is not made; the caller
 * gets `stillVideo` and decides (at most two stills of the source in a collage).
 */
async function pictureFor(
  run: AgentRun,
  p: Project,
  value: unknown,
  queries: string[],
  kind: string,
  at: StillAt,
  needs: boolean,
  auto?: AutoQuery,
  makeStill = true,
): Promise<Picture> {
  const known = imageNamed(run, p, value);
  if (known) return { id: known };
  const q = queries.shift() ?? describedQuery(value);
  const style = styleAt(p, at.sequenceId);
  const found = q === undefined ? undefined : await fillSlot(run, q, kind, style);
  if (found) return { id: found, q };
  const named = mediaNamed(run, p, value);
  if (needs && q === undefined && named === undefined && auto) {
    const id = await autoPicture(run, auto, kind, style);
    if (id) return { id };
  }
  const video =
    named?.kind === 'video'
      ? named.id
      : needs && q === undefined && named === undefined
        ? sequenceVideoAt(p, at)
        : undefined;
  if (video !== undefined && !makeStill)
    return { stillVideo: video, ...(q !== undefined && { q }) };
  return stillPicture(run, p, video, at, kind, q);
}

/** A still of `video` for a slot (D-90), with its repair note; `{ q }` alone when none was made. */
async function stillPicture(
  run: AgentRun,
  p: Project,
  video: string | undefined,
  at: StillAt,
  kind: string,
  q: string | undefined,
): Promise<Picture> {
  const s = video === undefined ? undefined : await stillOf(run, p, video, at, kind);
  if (!s) return q === undefined ? {} : { q };
  const still = `still of ${run.aliases.aliasOf(video!)} at ${String(s.srcMs)} ms (${q === undefined ? 'no picture query' : `no picture for ${q}`})`;
  return { id: s.mediaId, still, ...(q !== undefined && { q }) };
}

/** The video the sequence shows at `at` (its `V1` clip there, else its first `V1` clip). */
function sequenceVideoAt(p: Project, at: StillAt): string | undefined {
  const v1 = p.sequences
    .find((s) => s.id === at.sequenceId)
    ?.videoTracks.find((t) => t.id === 'V1')
    ?.items.flatMap((it) => (it.type === 'media' ? [it] : []))
    .filter((it) => p.media.find((m) => m.id === it.mediaId)?.kind === 'video');
  const clip = v1?.find((c) => at.atMs >= c.startMs && at.atMs < c.startMs + c.durationMs);
  return (clip ?? v1?.[0])?.mediaId;
}

/** A beat's place in time, for stills: entry `k` of `n` sits at (k + 1) / (n + 1) of the beat. */
interface BeatSpan {
  sequenceId: string;
  startMs: number;
  endMs: number;
  /** The beat's made-up picture query (D-94), when its model gave none. */
  auto?: AutoQuery;
}

/** At most this many stills of the source video in one collage (D-94): more look the same. */
export const MAX_STILLS_PER_SCENE = 2;
const stillAt = (b: BeatSpan, k = 0, n = 1): StillAt => ({
  sequenceId: b.sequenceId,
  atMs: b.startMs + Math.round(((b.endMs - b.startMs) * (k + 1)) / (n + 1)),
});

/**
 * Pictures inside arrays (paper-collage `items/*\/media`): an entry that does not name a picture of
 * the project gets one from the next image query, or from its own text when the model wrote a
 * description there, or from the beat's made-up query (D-94), or a still of the video (D-90).
 * `missing` names the first entry left without a picture. Stills are made last (D-94): when more
 * than MAX_STILLS_PER_SCENE entries would show a still of the source and none got another picture,
 * `textLed()` may turn the scene into a text-led one (`textLed: true`, nothing filled); otherwise
 * the entries over that many stills are dropped (when the array keeps its minimum), with a note.
 */
async function fillArrays(
  run: AgentRun,
  p: Project,
  t: TemplateInfo,
  variables: Record<string, unknown>,
  queries: string[],
  span: BeatSpan,
  note: (what: string) => void,
  textLed?: () => boolean,
): Promise<{ variables: Record<string, unknown>; missing?: string; textLed?: true }> {
  let out = variables;
  const props = (t.variables['properties'] ?? {}) as Record<
    string,
    { minItems?: unknown } | undefined
  >;
  for (const [arr, field, kind] of nestedSlots(t)) {
    const list = out[arr];
    if (!Array.isArray(list)) continue;
    const got: { entry: Record<string, unknown>; pic: Picture }[] = [];
    for (const [k, el] of list.entries()) {
      if (typeof el !== 'object' || el === null) continue;
      const entry = { ...(el as Record<string, unknown>) };
      const at = stillAt(span, k, list.length);
      const pic = await pictureFor(run, p, entry[field], queries, kind, at, true, span.auto, false);
      if (!pic.id && pic.stillVideo === undefined)
        return { variables: out, missing: pic.q ?? `${arr} ${field}` };
      got.push({ entry, pic });
    }
    const stills = got.filter((g) => !g.pic.id);
    const minItems = props[arr]?.minItems;
    const min = typeof minItems === 'number' ? minItems : 1;
    let keep = got;
    if (stills.length > MAX_STILLS_PER_SCENE) {
      if (stills.length === got.length && textLed?.()) return { variables: out, textLed: true };
      const drop = new Set(stills.slice(MAX_STILLS_PER_SCENE));
      if (got.length - drop.size >= min) {
        keep = got.filter((g) => !drop.has(g));
        const which = got.flatMap((g, k) => (drop.has(g) ? [String(k)] : [])).join(', ');
        note(
          `${arr} ${which}: dropped (at most ${String(MAX_STILLS_PER_SCENE)} stills of the source video in a scene)`,
        );
      }
    }
    const filled: unknown[] = [];
    for (const [k, { entry, pic }] of keep.entries()) {
      let id = pic.id;
      if (!id) {
        const s = await stillPicture(
          run,
          p,
          pic.stillVideo,
          stillAt(span, k, keep.length),
          kind,
          pic.q,
        );
        if (!s.id) return { variables: out, missing: pic.q ?? `${arr} ${field}` };
        if (s.still) note(`${arr} ${String(k)}: ${s.still}`);
        id = s.id;
      }
      entry[field] = id;
      filled.push(entry);
    }
    out = { ...out, [arr]: filled };
  }
  return { variables: out };
}

/**
 * Top-level picture slots of a scene (or of a panel): a value that is not a picture of the project
 * gets one through `pictureFor`. A required slot with no picture is `missing` (the caller makes a
 * placeholder); an optional one is left empty, with a repair note when a picture was asked for (D-88
 * for panels, D-90 for scenes: the template renders without it).
 */
async function fillTopSlots(
  run: AgentRun,
  p: Project,
  t: TemplateInfo,
  variables: Record<string, unknown>,
  queries: string[],
  span: BeatSpan,
  note: (what: string) => void,
): Promise<{ variables: Record<string, unknown>; missing?: { q?: string; slot: string } }> {
  const vars = { ...variables };
  const required = new Set((t.variables['required'] ?? []) as string[]);
  for (const [slot, kind] of fillableSlots(t)) {
    const got = await pictureFor(
      run,
      p,
      vars[slot],
      queries,
      kind,
      stillAt(span),
      required.has(slot),
      span.auto,
    );
    if (got.id) {
      if (got.still) note(`${slot}: ${got.still}`);
      vars[slot] = got.id;
      continue;
    }
    if (required.has(slot))
      return { variables: vars, missing: { slot, ...(got.q !== undefined && { q: got.q }) } };
    if (vars[slot] !== undefined || got.q !== undefined)
      note(`no picture for ${got.q ?? slot}, ${slot} left empty`);
    delete vars[slot];
  }
  return { variables: vars };
}

/** The ellipsis that marks shortened text (one character). */
const ELLIPSIS = '…';

/**
 * `text` cut at word boundaries to at most `max` characters (D-90): the first run of whole words
 * that fits and holds the most key words (all of them when they fit together), with an ellipsis on
 * each cut side. A single word longer than `max` is cut inside the word.
 */
export function shortenText(text: string, max: number, keys: readonly string[] = []): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const words = clean.split(' ');
  const wanted = keys.map((k) => k.toLowerCase()).filter((k) => k !== '');
  const piece = (i: number, j: number) => {
    let s = words.slice(i, j).join(' ');
    if (j < words.length) s = `${s.replace(/[\s,;:.!?–—-]+$/u, '')}${ELLIPSIS}`;
    return i > 0 ? `${ELLIPSIS}${s}` : s;
  };
  let best: { text: string; covered: number } | undefined;
  for (let i = 0; i < words.length; i++) {
    let j = i;
    while (j < words.length && piece(i, j + 1).length <= max) j++;
    if (j === i) continue;
    const s = piece(i, j);
    const lower = s.toLowerCase();
    const covered = wanted.filter((k) => lower.includes(k)).length;
    if (!best || covered > best.covered) best = { text: s, covered };
    if (covered === wanted.length) break;
  }
  return best?.text ?? `${clean.slice(0, Math.max(0, max - 1))}${ELLIPSIS}`;
}

/**
 * Top-level text variables over their `maxLength` (weak models write long kinetic-serif lines, D-88
 * live runs) are shortened at a word boundary, keeping the `emphasis` words when they fit; emphasis
 * words the shortened text no longer holds are dropped. Each change is a repair note.
 */
function shortenTexts(
  t: TemplateInfo,
  variables: Record<string, unknown>,
  note: (what: string) => void,
): Record<string, unknown> {
  const props = (t.variables['properties'] ?? {}) as Record<
    string,
    { type?: unknown; maxLength?: unknown } | undefined
  >;
  const out = { ...variables };
  const emphasis = Array.isArray(out['emphasis'])
    ? out['emphasis'].filter((e): e is string => typeof e === 'string')
    : [];
  let changed = false;
  for (const [key, schema] of Object.entries(props)) {
    const v = out[key];
    const max = schema?.maxLength;
    if (schema?.type !== 'string' || typeof max !== 'number' || typeof v !== 'string') continue;
    if (v.length <= max) continue;
    out[key] = shortenText(v, max, emphasis);
    note(
      `${key} shortened to the ${String(max)}-character limit (was ${String(v.length)} characters)`,
    );
    changed = true;
  }
  if (changed && emphasis.length > 0 && Array.isArray(out['emphasis'])) {
    const texts = Object.keys(props)
      .map((k) => out[k])
      .filter((x): x is string => typeof x === 'string')
      .join(' ')
      .toLowerCase();
    const kept = emphasis.filter((e) => texts.includes(e.toLowerCase()));
    for (const e of emphasis.filter((x) => !kept.includes(x)))
      note(`emphasis ${JSON.stringify(e)} dropped (not in the shortened text)`);
    out['emphasis'] = kept;
  }
  return out;
}

/** `template` slots of a scene (stack `panels/*`): the array variable holding the panels. */
const panelSlots = (t: TemplateInfo) =>
  Object.entries(t.slots).flatMap(([path, kind]) => {
    const m = /^([A-Za-z0-9_]+)\/\*$/.exec(path);
    return m && kind === 'template' ? [m[1]!] : [];
  });

/**
 * Pictures inside the panels of a `template` slot (D-86). A panel's picture slot that does not name
 * a picture of the project gets one from the next image query (or the description written there,
 * or a still of the video it names, D-90); text over a length limit is shortened (D-90).
 * An optional slot with no picture is left empty, with a repair note when a picture was asked for
 * (the panel renders without it); a required one is `missing`, and the scene becomes a placeholder.
 * Panels with an unknown template are left as they are: the engine's variable check decides.
 */
async function fillPanels(
  run: AgentRun,
  p: Project,
  t: TemplateInfo,
  variables: Record<string, unknown>,
  queries: string[],
  templates: TemplateLookup,
  span: BeatSpan,
  note: (what: string) => void,
): Promise<{ variables: Record<string, unknown>; missing?: string }> {
  let out = variables;
  for (const arr of panelSlots(t)) {
    const list = out[arr];
    if (!Array.isArray(list)) continue;
    const panels: unknown[] = [];
    for (const [i, el] of list.entries()) {
      const panel = el as { template?: unknown; variables?: unknown } | null;
      const inner = typeof panel?.template === 'string' ? templates.get(panel.template) : undefined;
      if (!panel || !inner || inner.kind !== 'scene') {
        panels.push(el);
        continue;
      }
      const vars: Record<string, unknown> =
        typeof panel.variables === 'object' && panel.variables !== null
          ? { ...(panel.variables as Record<string, unknown>) }
          : {};
      const pnote = (what: string) => note(`panel ${String(i)}: ${what}`);
      const top = await fillTopSlots(run, p, inner, vars, queries, span, pnote);
      if (top.missing !== undefined)
        return { variables: out, missing: top.missing.q ?? `${arr} ${top.missing.slot}` };
      const arrays = await fillArrays(run, p, inner, top.variables, queries, span, pnote);
      if (arrays.missing !== undefined) return { variables: out, missing: arrays.missing };
      panels.push({ ...panel, variables: shortenTexts(inner, arrays.variables, pnote) });
    }
    out = { ...out, [arr]: panels };
  }
  return { variables: out };
}

/** ClipPlan → ops for one batch, with slot filling and repairs. */
export async function clipPlanToOps(
  run: AgentRun,
  plan: ClipPlan,
  templates: TemplateLookup,
): Promise<{ ops: PlanOp[]; repairs: Repair[] }> {
  const p = await run.ctx.engine.getProject(run.ctx.projectId);
  const ops: PlanOp[] = [];
  const repairs: Repair[] = [];
  for (const sp of plan.sequences) {
    const textLed = textLedTemplates(styleTemplateIds(run, p, sp.sequenceId, templates), templates);
    const end = sequenceEnd(p, sp.sequenceId);
    const seq = p.sequences.find((s) => s.id === sp.sequenceId)!;
    const free = seq.videoTracks.find(
      (t) => t.id !== 'V1' && t.items.every((it) => it.type !== 'media'),
    );
    let trackId = free?.id;
    // the Scenes track is added only when at least one scene beat of this sequence applies
    const addTrackAt = trackId ? -1 : ops.length;
    if (!trackId) {
      const n = Math.max(0, ...seq.videoTracks.map((t) => Number(t.id.slice(1)))) + 1;
      trackId = `V${String(n)}`;
    }
    const occupied = (free?.items ?? []).map(
      (it) => [it.startMs, it.startMs + it.durationMs] as const,
    );
    let prevEnd = 0;
    // D-94: at most MAX_SAME_TEMPLATE scenes of one template; the others turn text-led.
    const varied = varySceneTemplates(
      [...sp.beats].sort((a, b) => a.startMs - b.startMs),
      textLed,
      templates,
    );
    const beats = varied.beats;
    const counts = varied.counts;
    for (const n of varied.notes)
      repairs.push({ beat: n.beat, sequenceId: sp.sequenceId, what: n.what });
    const words = await spokenWords(run, p, seq);
    const captionY = seq.captions?.enabled ? seq.captions.position.yPct : undefined;
    // D-92: scenes start when their words are spoken. `synced` holds the new times of the moved
    // scenes; beats run in their new start order (repair notes keep the planned beat index).
    const synced = syncBeatsToSpeech(beats, templates, end, words);
    const order = beats
      .map((b, i) => ({ b, i, at: synced.get(i)?.startMs ?? b.startMs }))
      .sort((x, y) => x.at - y.at || x.i - y.i);
    for (const { b: planned, i } of order) {
      if (planned.kind !== 'scene') continue;
      const note = (what: string) => repairs.push({ beat: i, sequenceId: sp.sequenceId, what });
      const moved = synced.get(i);
      if (moved)
        note(
          `scene ${JSON.stringify(moved.text)} moved ${String(planned.startMs)} → ${String(moved.startMs)} ms to match speech${moved.word === undefined ? '' : ` (the word ${JSON.stringify(moved.word)})`}`,
        );
      const b = moved
        ? { ...planned, startMs: moved.startMs, endMs: moved.startMs + moved.durationMs }
        : planned;
      if (b.endMs <= b.startMs) {
        note(`dropped: ends at ${String(b.endMs)}, not after its start ${String(b.startMs)}`);
        continue;
      }
      let template = b.template as string;
      let t = templates.get(template);
      if (!t || t.kind !== 'scene') {
        note(`dropped: ${template} is not a scene template`);
        continue;
      }
      let variables: Record<string, unknown> = { ...(b.variables ?? {}) };
      const queries = [...(b.imageQueries ?? [])];
      const span: BeatSpan = { sequenceId: sp.sequenceId, startMs: b.startMs, endMs: b.endMs };
      // D-94: no picture query from the model: one made up from the scene text or the speech
      if (queries.length === 0) {
        const auto = autoQuery(sceneTexts(t, variables, templates), words, span);
        if (auto) span.auto = auto;
      }
      // Top-level picture slots: a required one with no picture turns the scene into a placeholder;
      // an optional one is left empty with a repair note (D-90: a stat renders without its bgPhoto).
      const top = await fillTopSlots(run, p, t, variables, queries, span, note);
      variables = top.variables;
      if (top.missing !== undefined) {
        const { q, slot } = top.missing;
        const ph = templates.get(PLACEHOLDER_TEMPLATE);
        if (!ph) {
          note(`dropped: no picture for slot ${slot} and no placeholder template`);
          continue;
        }
        note(`placeholder: no picture for ${q ?? slot}`);
        template = PLACEHOLDER_TEMPLATE;
        variables = { label: `Picture: ${q ?? slot}`.slice(0, 120) };
        t = ph;
      }
      // Pictures inside an array (paper-collage `items/*/media`): the model was told to leave image
      // slots empty, so an entry that does not name a picture of the project gets one from the beat's
      // next image query, or from its own text when the model wrote a description there. No picture
      // for an entry → the scene becomes a placeholder, as for a top-level slot.
      // Scenes inside a `template` slot (stack `panels/*`, D-86): each panel's own picture slots are
      // filled the same way, from the same queue of image queries, in panel order.
      let missing: string | undefined;
      // D-94: a collage that would show only stills of the source turns text-led when it can
      const from = t;
      const conv: { to?: ReturnType<typeof toTextLed> } = {};
      const toText = () => {
        conv.to = toTextLed(from, variables, textLed, counts, templates);
        return conv.to !== undefined;
      };
      if (template !== PLACEHOLDER_TEMPLATE) {
        const arrays = await fillArrays(run, p, t, variables, queries, span, note, toText);
        missing = arrays.missing;
        const turned = conv.to;
        if (arrays.textLed && turned) {
          note(
            `${template} would show only stills of the source: ${turned.template} ${JSON.stringify(turned.text)} instead`,
          );
          template = turned.template;
          variables = turned.variables;
          t = templates.get(template)!;
        } else if (missing === undefined) {
          const panels = await fillPanels(
            run,
            p,
            t,
            arrays.variables,
            queries,
            templates,
            span,
            note,
          );
          missing = panels.missing;
          variables = panels.variables;
        }
      }
      // D-95: a scene whose variables do not fit turns text-led with its own text when the style
      // has a text-led template left (an empty collage), not a placeholder
      const textInstead = (why: string): boolean => {
        const to = t ? toTextLed(t, variables, textLed, counts, templates) : undefined;
        if (!to) return false;
        note(`${template} ${why}: ${to.template} ${JSON.stringify(to.text)} instead`);
        template = to.template;
        variables = to.variables;
        t = templates.get(template)!;
        return true;
      };
      if (missing !== undefined) {
        const ph = templates.get(PLACEHOLDER_TEMPLATE);
        if (!ph) {
          note(`dropped: no picture for ${missing} and no placeholder template`);
          continue;
        }
        note(`placeholder: no picture for ${missing}`);
        template = PLACEHOLDER_TEMPLATE;
        variables = { label: `Picture: ${missing}`.slice(0, 120) };
        t = ph;
      }
      // Variables that still do not fit the template (a required array left out) would fail the
      // whole batch: the scene becomes a placeholder instead, with the reason in the repairs.
      if (template !== PLACEHOLDER_TEMPLATE) {
        variables = shortenTexts(t, variables, note);
        // D-94: unknown keys and invalid optional values are dropped, not the whole scene
        variables = fitVariables(t, variables, templates, note);
        // D-96: a text block with a position choice sits clear of burned-in captions
        variables = clearOfCaptions(t, variables, captionY, note);
        let problem = await variablesProblem(run, t, variables, templates);
        if (problem !== undefined && textInstead(`variables do not fit (${problem})`)) {
          variables = shortenTexts(t, variables, note);
          problem = await variablesProblem(run, t, variables, templates);
        }
        const ph = problem === undefined ? undefined : templates.get(PLACEHOLDER_TEMPLATE);
        if (problem !== undefined && !ph) {
          note(`dropped: ${template} variables do not fit (${problem})`);
          continue;
        }
        if (problem !== undefined && ph) {
          note(`placeholder: ${template} variables do not fit (${problem})`);
          variables = { label: `Scene: ${template}`.slice(0, 120) };
          template = PLACEHOLDER_TEMPLATE;
          t = ph;
        }
      }
      const auto = span.auto;
      if (auto?.candidates !== undefined)
        note(
          auto.found > 0
            ? `${String(auto.found)} archive picture(s) for ${JSON.stringify(auto.query)} (query from the ${auto.from}; the plan gave none)`
            : `no archive picture for ${JSON.stringify(auto.query)} (query from the ${auto.from})`,
        );
      if (auto?.generated)
        note(
          `${String(auto.generated)} picture(s) generated for ${JSON.stringify(auto.query)} in the style's look`,
        );
      let start = clamp(Math.max(b.startMs, prevEnd), 0, end);
      if (start !== b.startMs) note(`start moved ${String(b.startMs)} → ${String(start)}`);
      const want = planned.endMs - planned.startMs;
      let dur = clamp(want, t.durationMs.min, t.durationMs.max);
      if (dur !== want) note(`duration clamped to ${String(dur)} (template bounds)`);
      if (moved) dur = clamp(moved.durationMs, t.durationMs.min, t.durationMs.max);
      for (const [s, e] of occupied) {
        if (start < e && start + dur > s) {
          if (start >= s) start = e;
          else dur = s - start;
        }
      }
      if (start + dur > end) dur = end - start;
      if (dur < t.durationMs.min) {
        note('dropped: does not fit in the sequence');
        continue;
      }
      prevEnd = start + dur;
      ops.push({
        op: 'addScene',
        args: {
          sequenceId: sp.sequenceId,
          trackId,
          startMs: start,
          durationMs: dur,
          template,
          variables,
        },
      });
    }
    if (addTrackAt >= 0 && ops.length > addTrackAt)
      ops.splice(addTrackAt, 0, {
        op: 'addTrack',
        args: { sequenceId: sp.sequenceId, kind: 'video', name: 'Scenes' },
      });
  }
  return { ops, repairs };
}

/** Longest scene text quoted in a speech-sync repair note. */
const SYNC_NOTE_CHARS = 48;

/**
 * Spoken words of a sequence in sequence time: the words of every media clip with a transcript,
 * mapped the way captions map them (pauses left out). Empty when no clip has a readable transcript.
 */
async function spokenWords(
  run: AgentRun,
  p: Project,
  seq: Project['sequences'][number],
): Promise<SpokenWord[]> {
  const ids = new Set(
    [...seq.audioTracks, ...seq.videoTracks].flatMap((t) =>
      t.items.flatMap((it) => (it.type === 'media' ? [it.mediaId] : [])),
    ),
  );
  const transcripts = new Map<string, Transcript>();
  for (const m of p.media) {
    if (!ids.has(m.id) || m.transcriptPath === undefined) continue;
    try {
      transcripts.set(m.id, await loadTranscript(run.ctx.engine, run.ctx.projectId, m));
    } catch (err) {
      if (!isVoxError(err)) throw err;
    }
  }
  if (transcripts.size === 0) return [];
  const tracks = [...seq.audioTracks, ...seq.videoTracks].map((t) => t.id);
  const seen = new Set<string>();
  const out: SpokenWord[] = [];
  for (const w of mapWordsToTimeline(p, seq, (m) => transcripts.get(m.id), tracks)) {
    if (w.kind === 'pause' || seen.has(w.key)) continue;
    seen.add(w.key);
    out.push({ text: w.text, startMs: w.startMs });
  }
  return out;
}

interface SyncedBeat {
  startMs: number;
  durationMs: number;
  /** The scene text matched (shortened for the repair note). */
  text: string;
  /** The one rare word that placed it (D-94). */
  word?: string;
}

/**
 * Speech sync of the scene beats of one sequence (D-92): beat index → new start, duration and the
 * matched text, for the scenes that move. Durations are the planned ones after template clamps.
 */
function syncBeatsToSpeech(
  beats: ClipPlan['sequences'][number]['beats'],
  templates: TemplateLookup,
  end: number,
  words: readonly SpokenWord[],
): Map<number, SyncedBeat> {
  const moved = new Map<number, SyncedBeat>();
  const scenes = beats.flatMap((b, i) => {
    const t = b.kind === 'scene' && b.template ? templates.get(b.template) : undefined;
    if (!t || t.kind !== 'scene' || b.endMs <= b.startMs) return [];
    return [
      {
        i,
        startMs: b.startMs,
        durationMs: clamp(b.endMs - b.startMs, t.durationMs.min, t.durationMs.max),
        minMs: t.durationMs.min,
        texts: sceneTexts(t, b.variables ?? {}, templates),
      },
    ];
  });
  if (!scenes.some((s) => s.texts.length > 0) || words.length === 0) return moved;
  for (const [k, r] of syncScenesToSpeech(scenes, words, end).entries()) {
    const s = scenes[k]!;
    if (r.matchedText === undefined || r.startMs === s.startMs) continue;
    const text =
      r.matchedText.length > SYNC_NOTE_CHARS
        ? `${r.matchedText.slice(0, SYNC_NOTE_CHARS - 1)}${ELLIPSIS}`
        : r.matchedText;
    moved.set(s.i, {
      startMs: r.startMs,
      durationMs: r.durationMs,
      text,
      ...(r.matchedWord !== undefined && { word: r.matchedWord }),
    });
  }
  return moved;
}

/**
 * Scene template ids of the sequence's style, in the style's order (the plan menu's list), for the
 * text-led alternatives of the variety repair (D-94). Empty when the style cannot be read.
 */
function styleTemplateIds(
  run: AgentRun,
  p: Project,
  sequenceId: string,
  templates: TemplateLookup,
): string[] {
  try {
    const ids = Object.keys(run.ctx.engine.styles.get(styleIdOf(p, [sequenceId])).templates);
    return ids.filter((id) => templates.get(id)?.kind === 'scene');
  } catch (err) {
    if (!isVoxError(err)) throw err;
    return [];
  }
}

/** Why the variables do not fit the template (the engine's own check), or undefined when they do. */
async function variablesProblem(
  run: AgentRun,
  t: TemplateInfo,
  variables: Record<string, unknown>,
  templates: TemplateLookup,
): Promise<string | undefined> {
  // pictures found for this plan were added to the project after the plan started: read it again
  const p = await run.ctx.engine.getProject(run.ctx.projectId);
  try {
    validateVariables(t, variables, templates, p);
    return undefined;
  } catch (err) {
    if (!isVoxError(err)) throw err;
    return err.message.slice(0, 200);
  }
}

/** Templates of the project's style (default when the run has no lookup). */
function styleIdOf(p: Project, scope: readonly string[]): string {
  const s = p.sequences.find((x) => x.id === scope[0]) ?? p.sequences[0];
  if (!s)
    throw new VoxError('PLAN_INVALID', 'the project has no sequence', 'Add a sequence first.');
  return s.styleId;
}

async function projectTemplates(run: AgentRun, scope: readonly string[]): Promise<TemplateLookup> {
  if (run.deps.templates) return run.deps.templates;
  const p = await run.ctx.engine.getProject(run.ctx.projectId);
  const style = run.ctx.engine.styles.get(styleIdOf(p, scope));
  return {
    get: (id) => {
      const t = style.templates[id] as unknown as TemplateInfo | undefined;
      return t;
    },
  };
}

async function planContext(
  run: AgentRun,
  scope: readonly string[],
  kind: 'clip' | 'ops',
  templates: TemplateLookup,
): Promise<string> {
  const inj = await run.injection(scope);
  const parts = [inj.text];
  const p = await run.ctx.engine.getProject(run.ctx.projectId);
  for (const sequenceId of scope) {
    const s = p.sequences.find((x) => x.id === sequenceId);
    const clip = s?.videoTracks.find((t) => t.id === 'V1')?.items.find((it) => it.type === 'media');
    const mediaId = clip && clip.type === 'media' ? clip.mediaId : undefined;
    if (!mediaId || !p.media.find((m) => m.id === mediaId)?.transcriptPath) continue;
    // the sequence's span only, one line per sentence in sequence ms (D-81)
    const { page } = await transcriptLines(
      run.ctx.engine,
      run.ctx.projectId,
      { mediaId, sequenceId },
      3_000,
    );
    parts.push(
      `Transcript of ${run.aliases.aliasOf(sequenceId)} ([startMs-endMs] text, sequence ms):\n${wrapData('transcript', page.lines)}`,
    );
  }
  if (kind === 'clip') {
    const style = run.ctx.engine.styles.get(styleIdOf(p, scope));
    const list = Object.keys(style.templates)
      .map((id) => templates.get(id))
      .filter((t): t is TemplateInfo => t !== undefined && t.kind === 'scene')
      .map((t) => ({ id: t.id, durationMs: t.durationMs, variables: t.variables, slots: t.slots }));
    parts.push(`Scene templates: ${JSON.stringify(list)}`);
  }
  return parts.join('\n\n');
}

const PLAN_FORMAT = {
  clip: 'Answer with a ClipPlan: { sequences: [{ sequenceId, beats: [{ startMs, endMs, kind: "speaker" | "scene", template?, variables?, imageQueries? }] }] }. Beat times are sequence time. Use a mix of scene templates: at most 2 scenes of one template in a clip. Leave image slots empty and give imageQueries instead: one short English query per picture, naming a concrete thing to photograph (archive search); never the source video. Write all scene text (labels, headlines, lines) in the language the speaker speaks, in the speaker\'s own words where you can: only imageQueries are English.',
  ops: 'Answer with { ops: [{ op, args }] }: engine op names (moveItem, trimItem, addScene, …) with the same args as their tools. Use the short ids from the view.',
} as const;

/** One plan-mode (sub-)run. */
export async function planTurn(run: AgentRun, opts: TurnOptions): Promise<TurnResult> {
  if (run.ctx.question) return questionTurn(run, opts);
  const kind = run.request.planKind ?? 'ops';
  const schema = kind === 'clip' ? ClipPlanSchema : OpsPlanSchema;
  let step = 0;
  try {
    const templates = await projectTemplates(run, opts.scope);
    const system = `${run.systemPrompt()}\n\n${PLAN_FORMAT[kind]}`;
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: `${opts.instruction ?? run.request.message}\n\n${await planContext(run, opts.scope, kind, templates)}`,
      },
    ];
    for (let attempt = 0; attempt <= MAX_PLAN_RETRIES; attempt++) {
      step++;
      const out = await run.structured({ system, messages, schema: schema as z.ZodType });
      run.record.write({
        type: 'step',
        step,
        mode: 'plan',
        ...(opts.subRun !== undefined && { subRun: opts.subRun }),
        scope: opts.scope,
        plan: out.value,
        usage: out.usage,
        spentUsd: run.spentUsd,
      });
      run.emit({
        type: 'agent.step',
        payload: {
          runId: run.runId,
          step,
          ...(opts.subRun !== undefined && { subRun: opts.subRun }),
          scope: opts.scope,
          summary: `plan (attempt ${String(attempt + 1)})`,
          usage: out.usage,
          costUsd: 0,
        },
      });
      let ops: PlanOp[];
      let repairs: Repair[] = [];
      try {
        const plan = validatePlan(run, kind, out.value);
        if (kind === 'clip')
          ({ ops, repairs } = await clipPlanToOps(run, plan as ClipPlan, templates));
        else ops = (plan as OpsPlan).ops;
        if (ops.length === 0)
          throw new VoxError(
            'PLAN_INVALID',
            'the plan has nothing to apply',
            emptyPlanHint(repairs),
          );
      } catch (err) {
        if (!isVoxError(err) || err.code !== 'PLAN_INVALID') throw err;
        run.record.write({ type: 'planInvalid', step, error: toVoxErrorJson(err) });
        if (attempt === MAX_PLAN_RETRIES) throw err;
        messages.push({ role: 'assistant', content: JSON.stringify(out.value) ?? '' });
        messages.push({ role: 'user', content: `${err.message}. ${err.hint}` });
        continue;
      }
      if (run.request.confirmPlan) {
        const d = await run.pause({
          reason: 'approval',
          kind: 'plan',
          detail: `Plan with ${String(ops.length)} op(s)${repairs.length ? `, ${String(repairs.length)} repair(s)` : ''}.`,
          plan: run.aliases.toModel({ ops, repairs }),
        });
        if (d.action === 'stop')
          return {
            status: 'stopped',
            summary: 'Stopped before the plan ran; nothing was applied.',
            steps: step,
          };
      }
      const applied = await applyAsAgent(run.ctx, 'batch', { ops });
      if (applied.versions) run.versions.push(...applied.versions);
      const res = applied.result as {
        version: number;
        results: { status: string; error?: { message: string; hint: string } }[];
      };
      run.record.write({
        type: 'tool',
        tool: 'batch',
        by: 'plan',
        args: { ops: ops.length },
        result: res,
        repairs,
        ...(applied.versions && { versions: applied.versions }),
      });
      const bad = res.results.filter((r) => r.status !== 'succeeded');
      if (bad.length === 0) {
        const r = `Applied a plan of ${String(ops.length)} op(s) at version ${String(res.version)}.${repairs.length ? ` Repairs: ${repairs.map((x) => x.what).join('; ')}.` : ''}`;
        return endPlan(run, opts, {
          status: 'completed',
          summary: r,
          steps: step,
          ...(repairs.length > 0 && { repairs: repairs.map((x) => x.what) }),
        });
      }
      if (attempt === MAX_PLAN_RETRIES) {
        throw new VoxError(
          'PLAN_INVALID',
          `the plan did not apply: ${bad.map((b) => b.error?.message ?? b.status).join('; ')}`,
          'Edit by hand or try another model.',
        );
      }
      messages.push({ role: 'assistant', content: JSON.stringify(out.value) ?? '' });
      messages.push({
        role: 'user',
        content: `The plan did not apply (nothing changed): ${JSON.stringify(run.aliases.toModel(bad))}. Send a corrected plan.`,
      });
    }
    throw new VoxError('PLAN_INVALID', 'no valid plan', 'Try another model.');
  } catch (err) {
    if (err instanceof RunStopped)
      return endPlan(run, opts, {
        status: 'stopped',
        summary: 'Stopped by the user.',
        steps: step,
      });
    const e = run.deps.redactor.redact(
      toVoxErrorJson(
        isVoxError(err)
          ? err
          : new VoxError('TOOL_FAILED', 'plan mode failed', 'See the run record.', { cause: err }),
      ),
    );
    return endPlan(run, opts, {
      status: 'failed',
      summary: `${e.message}. ${e.hint}`,
      steps: step,
      error: e,
    });
  }
}

const AnswerSchema = z.strictObject({ answer: z.string().min(1).max(4000) });

/** A question turn in plan mode (S35): one structured answer from the view, no writes. */
async function questionTurn(run: AgentRun, opts: TurnOptions): Promise<TurnResult> {
  try {
    const inj = await run.injection(opts.scope);
    const out = await run.structured({
      system: `${run.systemPrompt()}\n\nThis turn is a question: answer it from the current state; change nothing. Answer with { answer }.`,
      messages: [
        { role: 'user', content: `${opts.instruction ?? run.request.message}\n\n${inj.text}` },
      ],
      schema: AnswerSchema,
    });
    run.record.write({
      type: 'step',
      step: 1,
      mode: 'plan',
      scope: opts.scope,
      plan: out.value,
      usage: out.usage,
    });
    const r = AnswerSchema.safeParse(out.value);
    const summary = r.success
      ? r.data.answer
      : String(typeof out.value === 'string' ? out.value : 'No answer.');
    return endPlan(run, opts, { status: 'completed', summary, steps: 1 });
  } catch (err) {
    if (err instanceof RunStopped)
      return endPlan(run, opts, { status: 'stopped', summary: 'Stopped by the user.', steps: 1 });
    const e = run.deps.redactor.redact(
      toVoxErrorJson(
        isVoxError(err)
          ? err
          : new VoxError('TOOL_FAILED', 'plan mode failed', 'See the run record.', { cause: err }),
      ),
    );
    return endPlan(run, opts, {
      status: 'failed',
      summary: `${e.message}. ${e.hint}`,
      steps: 1,
      error: e,
    });
  }
}

function endPlan(run: AgentRun, opts: TurnOptions, r: TurnResult): TurnResult {
  run.record.write({ type: 'aliases', table: run.aliases.snapshot() });
  if (opts.subRun !== undefined)
    run.record.write({ type: 'subRun', subRun: opts.subRun, scope: opts.scope, ...r });
  return r;
}
