// Screenplay workflow test kit (14b): the generated fixture set ingested as the user, a scripted vision
// model that describes the clips in ingest order, and a scripted ranker that scores by the fixture's
// ground truth (a clip fits the scene its description belongs to).
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeScreenplaySet, SCENES } from '../../../../scripts/make-screenplay-set.ts';
import type { FrameCard } from '@vox/engine';
import { VoxError } from '../../src/errors.ts';
import type { ScriptStep } from './model.ts';
import { dynamicModel, role, workflowKit, type Kit } from './workflow.ts';

let cached: string | undefined;
/** The fixture set, generated once per test file process. */
export function screenplaySet(): string {
  if (!cached) {
    cached = mkdtempSync(join(tmpdir(), 'vox-sp-set-'));
    makeScreenplaySet(cached);
  }
  return cached;
}

export interface TagEntry {
  file: string;
  description: string;
  tags: string[];
  say: string;
}

export const tagEntries = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'tags.json'), 'utf8')) as TagEntry[];

/** A copy of a clip with other bytes (a second take of the same scene). */
export function secondTake(dir: string, file: string): string {
  const out = join(dir, 'clips', 'take-dup.mp4');
  execFileSync('ffmpeg', [
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-i',
    join(dir, file),
    '-c',
    'copy',
    '-metadata',
    'comment=second take',
    out,
  ]);
  return out;
}

export interface SpKit extends Kit {
  dir: string;
  /**
   * Frame cards (D-73) for the keyframes of a clip, by its fixture file; default: cards are not
   * available here (as off macOS), so the tagging uses the vision model.
   */
  cards?: (file: string, paths: readonly string[]) => FrameCard[];
  /** Calls to `frameCards` (media id per call). */
  cardCalls: string[];
  /** Media id by fixture file (`clips/take-a.mp4`). */
  ids: Map<string, string>;
  documentId: string;
  /** Ingests the screenplay and the given clips (default all six) as the user. */
  load(files?: string[], extra?: string[]): Promise<void>;
}

export async function screenplayKit(): Promise<SpKit> {
  const dir = screenplaySet();
  const kit = (await workflowKit()) as SpKit;
  const inner = kit.deps.runJob!;
  // a transcript job would seed the talking-head words onto these clips
  kit.deps.runJob = (kind, args, signal) =>
    kind === 'transcribe' ? Promise.resolve({}) : inner(kind, args, signal);
  kit.dir = dir;
  kit.ids = new Map();
  kit.cardCalls = [];
  // which clip a keyframe belongs to, so a scripted card can describe that clip
  const stillOf = new Map<string, string>();
  const mediaFrames = kit.engine.mediaFrames.bind(kit.engine);
  kit.engine.mediaFrames = async (projectId, mediaId, at) => {
    const paths = await mediaFrames(projectId, mediaId, at);
    for (const p of paths) stillOf.set(p, mediaId);
    return paths;
  };
  kit.engine.frameCards = (_projectId, paths) => {
    const mediaId = stillOf.get(paths[0]!) ?? '';
    kit.cardCalls.push(mediaId);
    const file = [...kit.ids].find(([, id]) => id === mediaId)?.[0];
    if (!kit.cards || file === undefined)
      return Promise.reject(
        new VoxError('APPLE_UNAVAILABLE', 'Frame cards need Apple Vision (macOS).', 'test'),
      );
    return Promise.resolve(kit.cards(file, paths));
  };
  kit.load = async (files = tagEntries(dir).map((t) => t.file), extra = []) => {
    const ingest = async (path: string) => {
      const r = (await inner('ingest', {
        projectId: kit.projectId,
        inputs: [path],
        actor: 'user',
      })) as {
        media: { mediaId: string }[];
      };
      return r.media[0]!.mediaId;
    };
    kit.documentId = await ingest(join(dir, 'screenplay.fountain'));
    for (const f of files) kit.ids.set(f, await ingest(join(dir, f)));
    for (const f of extra) kit.ids.set(f, await ingest(f));
    kit.jobs.length = 0;
  };
  return kit;
}

/** The vision model: describes the clips in the order given (ingest order), with a `Tags:` line. */
export function visionModel(
  entries: readonly TagEntry[],
  text?: (e: TagEntry, n: number) => string,
) {
  return dynamicModel((_o, n): ScriptStep => ({
    text: text
      ? text(entries[n]!, n)
      : `${entries[n]!.description}\nTags: ${entries[n]!.tags.join(', ')}`,
  }));
}

const userText = (o: LanguageModelV4CallOptions): string =>
  o.prompt
    .filter((m) => m.role === 'user')
    .flatMap((m) =>
      typeof m.content === 'string'
        ? [m.content]
        : m.content.map((c) => (c.type === 'text' ? c.text : '')),
    )
    .join('\n');

/** Default score: 9 when the clip description contains the scene description, else 1. */
const byTruth = (scene: (typeof SCENES)[number], desc: string) =>
  desc.includes(scene.description) ? 9 : 1;
/** The scene (by its heading) a ranking request is about. */
export const sceneIn = (o: LanguageModelV4CallOptions) =>
  SCENES.find((s) => userText(o).includes(s.heading));

/**
 * The ranker: reads the scene and the clip lines (`#k name: description | tags`) out of the request
 * and scores each clip with `score` (default: the fixture truth).
 */
export function rankerModel(
  opts: { score?: (scene: (typeof SCENES)[number], desc: string) => number; fail?: Error } = {},
) {
  return dynamicModel((o: LanguageModelV4CallOptions): ScriptStep => {
    if (opts.fail) return { error: opts.fail };
    const scene = sceneIn(o);
    const text = userText(o);
    const scores = [...text.matchAll(/^#(\d+) [^:\n]*: (.*)$/gm)].map((m) => ({
      index: Number(m[1]),
      score: scene ? (opts.score ?? byTruth)(scene, m[2]!) : 0,
    }));
    return { json: { scores } };
  });
}

export { role };

/** A frame card with the given Vision labels (confidence 0.9 down), no text, faces as given. */
export function card(path: string, labels: readonly string[], faces = 0): FrameCard {
  return {
    path,
    cached: false,
    width: 320,
    height: 240,
    labels: labels.map((label, i) => ({ label, confidence: 0.9 - i * 0.05 })),
    text: [],
    faces: { count: faces, boxes: [] },
    saliency: null,
    ms: 1,
  };
}
