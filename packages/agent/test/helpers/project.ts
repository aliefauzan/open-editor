// Fixture project on a temp projects folder for tool and loop tests: one 20 s talking-head media
// item with the engine's checked-in transcript, one sequence with the linked V1/A1 pair, captions on.
import { mapTemplateLookup, openEngine, type Engine, type TemplateInfo } from '@vox/engine';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AliasTable } from '../../src/tools/aliases.ts';
import type { TodoItem, ToolContext } from '../../src/tools/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, '../../../..');
export const ENGINE_FIXTURES = join(REPO, 'packages/engine/test/fixtures');

export const TEMPLATES: TemplateInfo[] = [
  {
    id: 'base/title',
    version: '1.0.0',
    kind: 'scene',
    durationMs: { min: 500, default: 3000, max: 10000 },
    variables: {
      type: 'object',
      properties: { title: { type: 'string', maxLength: 60 } },
      required: ['title'],
      additionalProperties: false,
    },
    slots: {},
  },
  {
    id: 'base/crossfade',
    version: '1.0.0',
    kind: 'transition',
    durationMs: { min: 200, default: 500, max: 2000 },
    variables: { type: 'object', properties: {}, additionalProperties: false },
    slots: {},
  },
];

export interface Fixture {
  engine: Engine;
  projectId: string;
  sequenceId: string;
  mediaId: string;
  /** Item ids of the linked pair. */
  v1: string;
  a1: string;
  projectDir: string;
}

export async function fixtureProject(
  opts: { transcript?: string; engine?: Partial<Parameters<typeof openEngine>[0]> } = {},
): Promise<Fixture> {
  const projectsDir = join(mkdtempSync(join(tmpdir(), 'vox-agent-p-')), 'Projects');
  const engine = openEngine({
    projectsDir,
    stylesDirs: [join(REPO, 'styles')],
    templates: mapTemplateLookup(TEMPLATES),
    ...opts.engine,
  });
  const p = await engine.createProject('agent-fixture');
  const mediaId = 'm_talk0000000001';
  const projectDir = join(projectsDir, p.id);
  mkdirSync(join(projectDir, 'transcripts'), { recursive: true });
  copyFileSync(
    opts.transcript ?? join(ENGINE_FIXTURES, 'transcripts/talking-head-20s.json'),
    join(projectDir, `transcripts/${mediaId}.json`),
  );
  const sequenceId = 'seq_main00000001';
  await engine.applyOp(
    p.id,
    {
      op: 'batch',
      args: {
        ops: [
          {
            op: 'addMedia',
            args: {
              media: {
                id: mediaId,
                kind: 'video',
                path: `media/${mediaId}.mp4`,
                durationMs: 20000,
                width: 1920,
                height: 1080,
                hasAudio: true,
                fps: { num: 30, den: 1 },
                origin: { type: 'upload' },
                tags: [],
                transcriptPath: `transcripts/${mediaId}.json`,
                transcriptRev: 'r1',
              },
            },
          },
          { op: 'addSequence', args: { name: 'Main', id: sequenceId } },
          {
            op: 'placeClip',
            args: {
              sequenceId,
              trackId: 'V1',
              mediaId,
              startMs: 0,
              durationMs: 20000,
              withAudio: true,
            },
          },
        ],
      },
    },
    { actor: 'user' },
  );
  const proj = await engine.getProject(p.id);
  const seq = proj.sequences[0]!;
  const v1 = seq.videoTracks.find((t) => t.id === 'V1')!.items[0]!.id;
  const a1 = seq.audioTracks.find((t) => t.id === 'A1')!.items[0]!.id;
  return { engine, projectId: p.id, sequenceId, mediaId, v1, a1, projectDir };
}

/** A tool context on a fixture project (run `run_test`, tools mode, not a question turn). */
export function toolContext(
  f: Fixture,
  over: Partial<ToolContext> = {},
): ToolContext & { todos: TodoItem[][] } {
  const todos: TodoItem[][] = [];
  return {
    engine: f.engine,
    projectId: f.projectId,
    runId: 'run_test',
    aliases: new AliasTable(),
    question: false,
    userSources: new Set<string>(),
    approvedSources: new Set<string>(),
    editorVision: false,
    seenVersion: 1,
    setTodos: (items) => void todos.push(items),
    todos,
    ...over,
  };
}

/** A synthetic transcript of `words` words (`word0`…), 300 ms apart, written to a temp file. */
export function longTranscriptFile(words: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'vox-agent-t-'));
  const list = Array.from({ length: words }, (_, i) => ({
    text: `word${String(i)}${i % 17 === 16 ? '.' : ''}`,
    startMs: i * 300,
    endMs: i * 300 + 250,
    kind: 'word',
  }));
  const path = join(dir, 'long.json');
  writeFileSync(
    path,
    JSON.stringify({
      language: 'en',
      speechRegions: [{ startMs: 0, endMs: words * 300 }],
      words: list,
    }),
  );
  return path;
}
