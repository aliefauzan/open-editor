// Compile test fixtures: a small project on the real `base` style (plus the test-only `kit`
// styles), an in-memory compile, and a machine-independent serialisation of a build.
import { join, relative } from 'node:path';
import {
  compileSequence,
  type BuildResult,
  type CompileInput,
  type CompileOptions,
} from '../../src/compile/compile.ts';
import type {
  Item,
  MediaItem,
  Project,
  SceneClip,
  Sequence,
  Transcript,
} from '../../src/model/schema.ts';
import { CAPTION_DEFAULTS } from '../../src/ops/captions.ts';
import { loadStyleRegistry, type StyleRegistry } from '../../src/styles/registry.ts';
import { baseProject, emptySequence, F30, track } from '../helpers/project.ts';

export const REPO = join(import.meta.dirname, '..', '..', '..', '..');
export const REPO_STYLES = join(REPO, 'styles');
export const KIT = join(import.meta.dirname, '..', 'fixtures', 'styles', 'kit');
export const PROJECT_DIR = '/vox-test/Projects/p_test';

export function registry(trusted: string[] = []): StyleRegistry {
  return loadStyleRegistry({
    stylesDirs: [REPO_STYLES, KIT],
    isTrusted: (id) => trusted.includes(id),
  });
}

export function media(id: string, extra: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    kind: 'video',
    path: `media/${id}.mp4`,
    proxyPath: `proxies/${id}.mp4`,
    audioPath: `audio/${id}.m4a`,
    durationMs: 60000,
    width: 1920,
    height: 1080,
    hasAudio: true,
    fps: F30,
    origin: { type: 'upload' },
    tags: [],
    transcriptPath: `transcripts/${id}.json`,
    transcriptRev: 'r1',
    ...extra,
  };
}

export const image = (id: string): MediaItem => ({
  id,
  kind: 'image',
  path: `media/${id}.jpg`,
  width: 1200,
  height: 1600,
  origin: { type: 'upload' },
  tags: [],
});

export const clip = (
  id: string,
  mediaId: string,
  startMs: number,
  durationMs: number,
  inMs = 0,
  extra: Partial<Extract<Item, { type: 'media' }>> = {},
): Item => ({ id, type: 'media', mediaId, startMs, durationMs, inMs, ...extra });

export const scene = (
  id: string,
  template: string,
  version: string,
  startMs: number,
  durationMs: number,
  variables: Record<string, unknown>,
  extra: Partial<SceneClip> = {},
): Item => ({
  id,
  type: 'scene',
  template,
  templateVersion: version,
  startMs,
  durationMs,
  variables,
  ...extra,
});

export const TRANSCRIPT: Transcript = {
  language: 'en',
  words: [
    ['Hello', 0, 400],
    ['there,', 400, 800],
    ['this', 1200, 1500],
    ['is', 1500, 1700],
    ['Vox.', 1700, 2300],
    ['It', 3000, 3200],
    ['has', 3200, 3500],
    ['42', 3500, 3900],
    ['clips!', 3900, 4500],
  ].map(([text, startMs, endMs]) => ({
    text: text as string,
    startMs: startMs as number,
    endMs: endMs as number,
    kind: 'word' as const,
  })),
  speechRegions: [{ startMs: 0, endMs: 4500 }],
};

/**
 * The main fixture: V1 two video clips cut with a dip to black + an image with push-in, V2 a title
 * and a text overlay, A1 the speech under captions, A2 music with fades.
 */
export function mainProject(styleId = 'base'): Project {
  const seq: Sequence = {
    ...emptySequence('seq_main', F30),
    name: 'Main <fixture>',
    styleId,
    videoTracks: [
      track('V1', [
        clip('it_v1', 'm_a', 0, 3000, 1000),
        clip('it_v2', 'm_b', 3000, 2000, 0, {
          transitionIn: { template: 'base/dip-to-black', durationMs: 400 },
        }),
        clip('it_i1', 'm_img', 5000, 1000, 0, { motion: { type: 'push-in', amount: 0.1 } }),
      ]),
      track('V2', [
        scene('it_t1', 'base/title', '1.0.0', 0, 2000, { title: 'Vox', subtitle: 'compile' }),
        scene('it_o1', 'base/text-overlay', '1.0.0', 3000, 2500, {
          text: 'A note',
          position: 'top',
          align: 'left',
        }),
      ]),
    ],
    audioTracks: [
      track('A1', [clip('it_a1', 'm_a', 0, 6000, 1000)]),
      track('A2', [clip('it_m1', 'm_music', 0, 6000, 0, { volume: 0.5, fadeOutMs: 1000 })]),
    ],
    captions: { ...CAPTION_DEFAULTS, overrides: [] },
  };
  return baseProject(seq, [
    media('m_a'),
    media('m_b', { vfr: true, cfrPath: `cfr/m_b.mp4` }),
    image('m_img'),
    media('m_music', { kind: 'audio', width: undefined, height: undefined, fps: undefined }),
  ]);
}

export function input(p: Project, reg: StyleRegistry = registry(), extra: Partial<CompileInput> = {}): CompileInput {
  return {
    project: p,
    projectDir: PROJECT_DIR,
    sequenceId: p.sequences[0]!.id,
    registry: reg,
    transcriptOf: (m) => (m.id === 'm_a' ? TRANSCRIPT : undefined),
    ...extra,
  };
}

export async function build(
  p: Project,
  opts: CompileOptions = { mode: 'render' },
  reg?: StyleRegistry,
  extra: Partial<CompileInput> = {},
): Promise<BuildResult> {
  return compileSequence(input(p, reg ?? registry(), extra), opts);
}

const stable = (abs: string) =>
  abs.startsWith(PROJECT_DIR) ? `<project>/${relative(PROJECT_DIR, abs)}` : `<repo>/${relative(REPO, abs)}`;

/** Every file and link of a build in path order, absolute sources made machine-independent. */
export function serialise(b: BuildResult): string {
  const files = [...b.files]
    .sort(([a], [c]) => (a < c ? -1 : 1))
    .map(([path, content]) => `=== ${path}\n${typeof content === 'string' ? content : `<${content.length} bytes>`}`);
  const links = [...b.links]
    .sort(([a], [c]) => (a < c ? -1 : 1))
    .map(([path, from]) => `${path} <- ${stable(from)}`);
  return [
    `mode ${b.mode} duration ${b.durationMs} vendor ${b.vendor.join(',')}`,
    `warnings ${JSON.stringify(b.warnings)}`,
    ...files,
    '=== links',
    ...links,
    '',
  ].join('\n');
}

/** The instance file (render) of `id`. */
export const instance = (b: BuildResult, id: string): string => {
  const f = b.files.get(`scenes/${id}.html`);
  if (typeof f !== 'string') throw new Error(`no instance ${id}`);
  return f;
};

/** The JSON vars of instance `id`. */
export function varsOf(html: string, id: string): Record<string, unknown> {
  const m = new RegExp(
    `<script type="application/json" data-vox-vars data-vox-instance="${id}">(.*?)</script>`,
    's',
  ).exec(html);
  if (!m) throw new Error(`no vars for ${id}`);
  return JSON.parse(m[1]!) as Record<string, unknown>;
}
