// A small real project for the render and export tests (phase 05 B): the checked-in talking-head
// clip (1920×1080, 30 fps, 20 s) with its seeded transcript, a 9:16 `base` sequence with a linked
// V1/A1 pair, one `base/title` scene on V2 and captions on. The real styles folder is used.
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openEngine, type Engine, type EngineOptions } from '../../src/api.ts';
import { tempDir } from '../helpers/store.ts';

export const REPO = new URL('../../../../', import.meta.url).pathname;
export const REPO_STYLES = join(REPO, 'styles');
const FX = join(REPO, 'packages', 'engine', 'test', 'fixtures');
export const HEAD = join(FX, 'assets', 'media', 'talking-head-20s.mp4');
export const HEAD_TRANSCRIPT = join(FX, 'transcripts', 'talking-head-20s.json');

export function exportEngine(extra: Partial<EngineOptions> = {}): Engine {
  return openEngine({
    projectsDir: join(tempDir('vox-export-'), 'Projects'),
    stylesDirs: [REPO_STYLES],
    config: async () => ({}),
    ...extra,
  });
}

export interface Fixture {
  e: Engine;
  projectId: string;
  dir: string;
  seq: string;
}

/** Project "Demo" with sequence `seq_a` ("Main"), `lengthMs` long from the clip's start. */
export async function exportProject(e: Engine, lengthMs = 3000, name = 'Demo'): Promise<Fixture> {
  const p = await e.createProject(name);
  const dir = join(e.projectsDir, p.id);
  await mkdir(join(dir, 'media'), { recursive: true });
  await mkdir(join(dir, 'transcripts'), { recursive: true });
  await copyFile(HEAD, join(dir, 'media', 'm_head.mp4'));
  await copyFile(HEAD_TRANSCRIPT, join(dir, 'transcripts', 'm_head.json'));
  const op = async (o: unknown) => {
    const r = await e.applyOp(p.id, o as never, { actor: 'cli' });
    const bad = r.results.find((x) => x.status === 'failed');
    if (bad) throw new Error(JSON.stringify(bad));
    return r;
  };
  await op({
    op: 'addMedia',
    args: {
      media: {
        id: 'm_head',
        kind: 'video',
        path: 'media/m_head.mp4',
        durationMs: 20000,
        width: 1920,
        height: 1080,
        hasAudio: true,
        fps: { num: 30, den: 1 },
        transcriptPath: 'transcripts/m_head.json',
        transcriptRev: 'r1',
        origin: { type: 'upload' },
        tags: [],
      },
    },
  });
  await op({ op: 'addSequence', args: { name: 'Main', id: 'seq_a', styleId: 'base' } });
  await op({
    op: 'placeClip',
    args: {
      sequenceId: 'seq_a',
      trackId: 'V1',
      mediaId: 'm_head',
      startMs: 0,
      inMs: 0,
      durationMs: lengthMs,
      withAudio: true,
      frame: { mode: 'cover' },
    },
  });
  await op({
    op: 'addScene',
    args: {
      sequenceId: 'seq_a',
      trackId: 'V2',
      startMs: 500,
      durationMs: Math.min(1500, lengthMs - 500),
      template: 'base/title',
      variables: { title: 'Hello' },
    },
  });
  await op({ op: 'setCaptions', args: { sequenceId: 'seq_a', enabled: true } });
  return { e, projectId: p.id, dir, seq: 'seq_a' };
}
