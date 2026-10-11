// Screenplay match (agent spec "Workflows" 3; plan 14b): a screenplay document and a footage set become
// one sequence with the right clip in every scene, in screenplay order.
//
// 1. Parse the scenes (heading, description, dialogue, estimated duration).
// 2. Tag the footage: keyframes → `vision` model → `update_media` (tags, description). A clip that
//    already has a description is not asked again (cached per media item).
// 3. Match every scene to a clip: embedding similarity when an embedder is set, else LLM ranking over
//    the tags, else (a failed call) word overlap. Several matching clips: the best take is used and the
//    others are noted.
// 4. Lay the clips on `V1` (their sound on `A1`) in screenplay order, each scene as long as the
//    screenplay says (never longer than the clip); a scene nothing matched gets a `base/placeholder`
//    scene with its heading. One `batch` op, so it is one undo entry.
//
// The workflow decides every step; the models only describe frames and rank clips. All text they and
// the screenplay carry is data (wrapped, sanitised before it is stored; S21, S34).
import {
  DEFAULT_FPS,
  TranscriptSchema,
  projectDirFor,
  resolveProjectPath,
  snap,
  type MediaItem,
  type Project,
} from '@vox/engine';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { VoxError } from '../errors.ts';
import { RunStopped, type AgentRun } from '../loop/run.ts';
import {
  assign,
  footageText,
  MATCH_MIN_EMBED,
  MATCH_MIN_LLM,
  MATCH_MIN_WORDS,
  rankByEmbedding,
  rankByLlm,
  wordOverlap,
  type Assignment,
  type Embedder,
  type Footage,
  type RankMethod,
  type Ranked,
} from '../screenplay/match.ts';
import { parseScreenplay, type Scene } from '../screenplay/parse.ts';
import { readStill } from '../tools/read.ts';
import type { Checkpoints } from './checkpoints.ts';

const PLACEHOLDER = 'base/placeholder';
/** Keyframes the vision model sees per clip. */
export const KEYFRAMES = [0.2, 0.5, 0.8] as const;
export const MAX_SCENES = 60;
const MAX_TEXT_BYTES = 400_000;
const MAX_TAGS = 8;

export interface ScreenplayOptions {
  /** A document media id, or a file/link the user named (ingested first). Default: the project's first document. */
  screenplay?: string;
  /** Footage to match; default every video in the project. */
  mediaIds?: string[];
  /** Embedding function (the `embed` role); absent: LLM ranking over tags. */
  embed?: Embedder;
  styleId: string;
}

export interface SceneReport {
  scene: number;
  heading: string;
  /** Media id of the clip; absent for a placeholder. */
  mediaId?: string;
  file?: string;
  score?: number;
  placeholder: boolean;
  startMs: number;
  durationMs: number;
  note?: string;
}

export interface ScreenplayReport {
  sequenceId: string;
  scenes: number;
  matched: number;
  placeholders: number;
  method: RankMethod | 'mixed';
  tagged: number;
  cached: number;
  /** One line per problem or best-take choice. */
  notes: string[];
  layout: SceneReport[];
  /** Clips no scene used. */
  unused: string[];
}

/** One line of untrusted text for storage: no control characters, no markup brackets, capped. */
export function cleanText(s: string, max: number): string {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
      .replace(/[<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  );
}

/** Vision answer → description + tags (`Tags: a, b, c` line; else the first words). */
export function parseDescription(text: string): { description: string; tags: string[] } {
  const m = /^(.*?)(?:\n+|\s)tags?\s*:\s*(.+)$/ims.exec(text.trim());
  const body = m ? m[1]! : text;
  const description = cleanText(body.replace(/^description\s*:\s*/i, ''), 400);
  const raw = m
    ? m[2]!.split(/[,;\n]/)
    : description
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 3);
  const tags = [...new Set(raw.map((t) => cleanText(t, 40).toLowerCase()).filter((t) => t !== ''))];
  return { description, tags: tags.slice(0, MAX_TAGS) };
}

const nameWords = (name: string) =>
  basename(name)
    .replace(/\.[A-Za-z0-9]+$/, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);

async function readText(run: AgentRun, media: MediaItem): Promise<string> {
  if (media.textPath === undefined)
    throw new VoxError(
      'NOT_FOUND',
      `${media.id} has no text`,
      'Use a .fountain, .txt, .md or .pdf screenplay.',
    );
  const dir = projectDirFor(run.ctx.engine.projectsDir, run.ctx.projectId);
  const text = await readFile(await resolveProjectPath(dir, media.textPath), 'utf8');
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES)
    throw new VoxError('VALIDATION', 'the screenplay is larger than 400 KB', 'Use a shorter file.');
  return text;
}

async function speechOf(run: AgentRun, media: MediaItem): Promise<string> {
  if (media.transcriptPath === undefined) return '';
  try {
    const dir = projectDirFor(run.ctx.engine.projectsDir, run.ctx.projectId);
    const t = TranscriptSchema.parse(
      JSON.parse(await readFile(await resolveProjectPath(dir, media.transcriptPath), 'utf8')),
    );
    return cleanText(t.words.map((w) => w.text).join(' '), 400);
  } catch {
    return '';
  }
}

async function project(run: AgentRun): Promise<Project> {
  return run.ctx.engine.getProject(run.ctx.projectId);
}

/** Step 1: the screenplay document and its scenes. */
async function findScenes(
  run: AgentRun,
  opts: ScreenplayOptions,
): Promise<{ scenes: Scene[]; documentId: string }> {
  let ref = opts.screenplay ?? run.request.attachments?.[0];
  let p = await project(run);
  let doc = ref === undefined ? undefined : p.media.find((m) => m.id === ref);
  if (ref !== undefined && !doc) {
    const ing = await run.workflowCall('ingest', { source: ref });
    const res = run.aliases.fromModel(ing.result) as { result?: { media?: { mediaId: string }[] } };
    ref = res.result?.media?.[0]?.mediaId;
    p = await project(run);
    doc = p.media.find((m) => m.id === ref);
  }
  doc ??= ref === undefined ? p.media.find((m) => m.kind === 'document') : undefined;
  if (!doc || doc.kind !== 'document')
    throw new VoxError(
      'VALIDATION',
      'the screenplay workflow needs a screenplay document',
      'Pass one: --screenplay <file.fountain|.txt|.md|.pdf> (or add the document to the project).',
    );
  const scenes = parseScreenplay(await readText(run, doc));
  if (scenes.length === 0)
    throw new VoxError(
      'VALIDATION',
      'no scene headings found in the screenplay',
      'Scenes start with INT. or EXT. (fountain), or "SCENE 1".',
    );
  if (scenes.length > MAX_SCENES)
    throw new VoxError(
      'VALIDATION',
      `the screenplay has ${String(scenes.length)} scenes; the limit is ${String(MAX_SCENES)}`,
      'Match it in parts.',
    );
  return { scenes, documentId: doc.id };
}

/** Step 2: tags and a description for every clip that has none. */
async function tagFootage(
  run: AgentRun,
  videos: readonly MediaItem[],
  notes: string[],
): Promise<{ tagged: number; cached: number }> {
  let tagged = 0;
  let cached = 0;
  const vision = run.ctx.vision;
  if (!vision && videos.some((v) => v.description === undefined))
    notes.push(
      'No vision model: untagged clips were tagged from their speech and file names only.',
    );
  for (const v of videos) {
    if (v.description !== undefined) {
      cached++;
      continue;
    }
    let media = v;
    if (media.hasAudio !== false && media.transcriptPath === undefined) {
      try {
        await run.workflowCall('transcribe', { mediaIds: [media.id] });
        media = (await project(run)).media.find((m) => m.id === v.id) ?? media;
      } catch (err) {
        if (err instanceof RunStopped) throw err;
        notes.push(
          `${basename(media.path)}: no transcript (${cleanText(String(err instanceof Error ? err.message : err), 120)}).`,
        );
      }
    }
    const speech = await speechOf(run, media);
    let description = '';
    let tags: string[] = [];
    if (vision && media.durationMs) {
      try {
        const at = KEYFRAMES.map((f) =>
          Math.min(Math.round(media.durationMs! * f), media.durationMs! - 1),
        );
        const paths = await run.ctx.engine.mediaFrames(run.ctx.projectId, media.id, at);
        const images = await Promise.all(
          at.map((ms, i) => readStill(run.ctx, paths[i] as string, `srcMs ${String(ms)}`)),
        );
        const text = await vision.describe(
          images,
          'These stills are from one clip of footage. Describe what the clip shows for a video editor in one sentence (place, people, objects, action, mood, time of day). Then a last line "Tags:" with 5 to 8 short lowercase tags, comma separated.',
          run.ctx.signal,
        );
        ({ description, tags } = parseDescription(text));
      } catch (err) {
        if (err instanceof RunStopped) throw err;
        notes.push(
          `${basename(media.path)}: the vision model failed (${cleanText(String(err instanceof Error ? err.message : err), 120)}); tagged from speech and file name.`,
        );
      }
    }
    if (description === '') {
      description = speech;
      tags = [...new Set([...nameWords(media.path), ...parseDescription(speech).tags])].slice(
        0,
        MAX_TAGS,
      );
    }
    const merged = [...new Set([...media.tags, ...tags])];
    await run.workflowCall('update_media', {
      mediaId: media.id,
      patch: { tags: merged, ...(description !== '' && { description }) },
    });
    tagged++;
  }
  return { tagged, cached };
}

interface Ranking {
  ranks: Ranked[][];
  mins: number[];
  method: RankMethod | 'mixed';
}

/** Step 3: a ranking of the clips for every scene. */
async function rank(
  run: AgentRun,
  scenes: readonly Scene[],
  footage: readonly Footage[],
  embed: Embedder | undefined,
  notes: string[],
): Promise<Ranking> {
  if (embed) {
    try {
      const ranks = await rankByEmbedding(embed, scenes, footage, run.ctx.signal);
      return { ranks, mins: scenes.map(() => MATCH_MIN_EMBED), method: 'embedding' };
    } catch (err) {
      if (err instanceof RunStopped) throw err;
      notes.push(
        `The embedding model failed (${cleanText(String(err instanceof Error ? err.message : err), 120)}); ranked with the language model.`,
      );
    }
  }
  const role = run.deps.models.fast ?? run.deps.models.editor;
  const ranks: Ranked[][] = [];
  const mins: number[] = [];
  const methods = new Set<RankMethod>();
  for (const scene of scenes) {
    try {
      ranks.push(await rankByLlm(run, role, scene, footage, run.ctx.signal));
      mins.push(MATCH_MIN_LLM);
      methods.add('llm');
    } catch (err) {
      if (err instanceof RunStopped || run.ctx.signal?.aborted)
        throw err instanceof RunStopped ? err : new RunStopped();
      notes.push(
        `Scene ${String(scene.index)}: the ranking call failed (${cleanText(String(err instanceof Error ? err.message : err), 120)}); matched by word overlap.`,
      );
      ranks.push(
        footage
          .map((f) => ({ mediaId: f.mediaId, score: wordOverlap(scene, f) }))
          .sort((a, b) => b.score - a.score || a.mediaId.localeCompare(b.mediaId)),
      );
      mins.push(MATCH_MIN_WORDS);
      methods.add('words');
    }
  }
  return { ranks, mins, method: methods.size > 1 ? 'mixed' : ([...methods][0] ?? 'llm') };
}

/** Step 4: one batch op: the sequence, the clips in screenplay order, placeholders for gaps. */
async function layOut(
  run: AgentRun,
  assignments: readonly Assignment[],
  footage: readonly Footage[],
  styleId: string,
  title: string,
): Promise<{ sequenceId: string; layout: SceneReport[] }> {
  const sequenceId = `seq_${randomBytes(6).toString('hex')}`;
  const byId = new Map(footage.map((f) => [f.mediaId, f]));
  const ops: { op: string; args: unknown }[] = [
    {
      op: 'addSequence',
      args: { id: sequenceId, name: cleanText(title, 80) || 'Screenplay', styleId },
    },
  ];
  const layout: SceneReport[] = [];
  let t = 0;
  for (const a of assignments) {
    const clip = a.mediaId ? byId.get(a.mediaId) : undefined;
    const want = snap(a.scene.estimatedMs, DEFAULT_FPS);
    const durationMs = clip
      ? Math.max(snap(Math.min(clip.durationMs, want), DEFAULT_FPS), 1)
      : want;
    if (clip) {
      ops.push({
        op: 'placeClip',
        args: {
          sequenceId,
          trackId: 'V1',
          mediaId: clip.mediaId,
          startMs: t,
          inMs: 0,
          durationMs,
          withAudio: true,
          audioTrackId: 'A1',
        },
      });
    } else {
      ops.push({
        op: 'addScene',
        args: {
          sequenceId,
          trackId: 'V1',
          startMs: t,
          durationMs,
          template: PLACEHOLDER,
          variables: { label: cleanText(a.scene.heading, 120) || `Scene ${String(a.scene.index)}` },
        },
      });
    }
    layout.push({
      scene: a.scene.index,
      heading: a.scene.heading,
      ...(clip && { mediaId: clip.mediaId, file: clip.label }),
      ...(a.score !== undefined && { score: Number(a.score.toFixed(3)) }),
      placeholder: !clip,
      startMs: t,
      durationMs,
      ...(a.note && { note: a.note }),
    });
    t += durationMs;
  }
  const r = await run.workflowCall('batch', { ops });
  const results =
    (r.result as { results?: { status: string; error?: { message: string } }[] }).results ?? [];
  const bad = results.find((x) => x.status !== 'succeeded');
  if (bad)
    throw new VoxError(
      'TOOL_FAILED',
      `the layout did not apply: ${bad.error?.message ?? bad.status}`,
      'See the run record.',
    );
  return { sequenceId, layout };
}

/** Runs the workflow; returns the report and sets the checkpoints on the new sequence. */
export async function screenplaySteps(
  run: AgentRun,
  cp: Checkpoints,
  opts: ScreenplayOptions,
): Promise<ScreenplayReport> {
  const notes: string[] = [];
  const { scenes } = await findScenes(run, opts);
  let p = await project(run);
  let videos = p.media.filter((m) => m.kind === 'video');
  if (opts.mediaIds) {
    const want = new Set(opts.mediaIds);
    const missing = [...want].filter((id) => !videos.some((v) => v.id === id));
    if (missing.length > 0)
      throw new VoxError(
        'VALIDATION',
        `no video ${missing.join(', ')} in the project`,
        'Pass ids of videos in the project.',
      );
    videos = videos.filter((v) => want.has(v.id));
  }
  if (videos.length === 0)
    throw new VoxError(
      'VALIDATION',
      'the screenplay workflow needs footage: the project has no video',
      'Add the clips first (ingest or the media bin).',
    );

  const { tagged, cached } = await tagFootage(run, videos, notes);
  p = await project(run);
  const footage: Footage[] = [];
  for (const v of videos) {
    const m = p.media.find((x) => x.id === v.id)!;
    const speech = await speechOf(run, m);
    footage.push({
      mediaId: m.id,
      label: basename(m.path),
      tags: m.tags,
      description: m.description ?? '',
      ...(speech && { speech }),
      durationMs: m.durationMs ?? 0,
    });
  }
  const tagless = footage.filter((f) => footageText(f) === '');
  if (tagless.length > 0)
    notes.push(
      `No description or tags for ${tagless.map((f) => f.label).join(', ')}: those clips cannot match a scene.`,
    );

  const ranking = await rank(
    run,
    scenes,
    footage.filter((f) => footageText(f) !== ''),
    opts.embed,
    notes,
  );
  const matchable = footage.filter((f) => footageText(f) !== '');
  const assignments = assign(scenes, ranking.ranks, ranking.mins, matchable);

  const { sequenceId, layout } = await layOut(
    run,
    assignments,
    footage,
    opts.styleId,
    'Screenplay',
  );

  const used = new Set(layout.flatMap((l) => (l.mediaId ? [l.mediaId] : [])));
  const placeholders = layout.filter((l) => l.placeholder).length;
  for (const a of assignments) if (a.note) notes.push(a.note);
  for (const l of layout)
    if (l.placeholder)
      notes.push(
        `Scene ${String(l.scene)} (${l.heading}): no clip matched; a placeholder holds the place.`,
      );
  const unused = footage.filter((f) => !used.has(f.mediaId)).map((f) => f.label);

  // checkpoints (once the sequence exists): tag, match, layout
  cp.met('tag', sequenceId, `${String(tagged)} tagged, ${String(cached)} cached`);
  cp.met(
    'match',
    sequenceId,
    `${String(scenes.length - placeholders)} of ${String(scenes.length)} scenes matched (${ranking.method})`,
  );
  const after = (await project(run)).sequences.find((s) => s.id === sequenceId);
  const v1 = after?.videoTracks.find((t) => t.id === 'V1')?.items ?? [];
  const inOrder =
    v1.length === layout.length && v1.every((it, i) => it.startMs === layout[i]!.startMs);
  if (inOrder)
    cp.met('layout', sequenceId, `${String(layout.length)} scene(s) on V1 in screenplay order`);
  else cp.missed('layout', sequenceId, 'V1 does not hold the scenes in screenplay order');

  return {
    sequenceId,
    scenes: scenes.length,
    matched: scenes.length - placeholders,
    placeholders,
    method: ranking.method,
    tagged,
    cached,
    notes,
    layout,
    unused,
  };
}

/** The run summary lines for a report (the model never writes them). */
export function screenplaySummary(run: AgentRun, r: ScreenplayReport): string {
  const head = `Screenplay ${run.aliases.aliasOf(r.sequenceId)}: ${String(r.matched)} of ${String(r.scenes)} scenes matched (${r.method}), ${String(r.placeholders)} placeholder(s); tagged ${String(r.tagged)} clip(s), ${String(r.cached)} already tagged.`;
  const lines = r.layout.map(
    (l) =>
      `  ${String(l.scene)}. ${l.heading}: ${l.placeholder ? 'placeholder' : `${l.file ?? ''} (${String(l.score ?? 0)})`}`,
  );
  return [
    head,
    ...lines,
    ...(r.unused.length > 0 ? [`Unused clips: ${r.unused.join(', ')}.`] : []),
  ].join('\n');
}
