// Facetrack path provider on cuts-2shot.mp4 with real detection (local tier, phase 05 step 9b):
// ingest → shots → facetrack through `engine.jobs`, then a `facetrack` and an `auto` clip compile to
// the builder's keyframes, cut to each clip window; a changed `stability` recompiles.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openEngine, resolveToolPaths, type FramingProvider } from '../../src/api.ts';
import type { JobInfo } from '../../src/jobs.ts';
import { applyClipFraming, trackOptionsFromFrame } from '../../src/stages/facetrack.ts';
import { tempDir } from '../helpers/store.ts';
import { REPO, REPO_STYLES } from '../export/project.ts';

const CUTS = join(REPO, 'packages/engine/test/fixtures/out/cuts-2shot.mp4');
const MODEL = 'blaze_face_full_range.tflite';
const modelSources = [
  process.env['VOX_TEST_MODELS_DIR'],
  `${REPO}py/cache/models`,
  `${REPO}../../py/cache/models`,
];

describe('facetrack path provider on cuts-2shot (local)', () => {
  test('tracked clips compile to the builder keyframes; stability recompiles', async () => {
    const toolsDir = tempDir('vox-fp-tools-');
    const tools = resolveToolPaths({ toolsDir, env: process.env, pyProject: `${REPO}py` });
    const src = modelSources.find((d) => d && existsSync(join(d, MODEL)));
    if (src) {
      mkdirSync(tools['models']!, { recursive: true });
      copyFileSync(join(src, MODEL), join(tools['models']!, MODEL));
    }
    const projectsDir = join(tempDir('vox-fp-'), 'Projects');
    const e = openEngine({
      projectsDir,
      stylesDirs: [REPO_STYLES],
      tools,
      config: async () => ({}),
    });
    const run = async <R>(kind: string, args: unknown): Promise<R> => {
      const info = (await e.jobs.wait(e.jobs.start(kind, args))) as JobInfo<R>;
      if (info.status !== 'done') throw new Error(`${kind}: ${JSON.stringify(info.error)}`);
      return info.result!;
    };
    const p = await e.createProject('cuts');
    const ing = await run<{ media: { mediaId: string }[] }>('ingest', {
      projectId: p.id,
      inputs: [CUTS],
    });
    const mediaId = ing.media[0]!.mediaId;
    await run('shots', { projectId: p.id, mediaId });
    await run('facetrack', { projectId: p.id, mediaId });
    const op = (o: unknown) => e.applyOp(p.id, o as never, { actor: 'cli' });
    await op({ op: 'addSequence', args: { name: 'Main', id: 'seq_a', styleId: 'base' } });
    for (const [startMs, mode] of [
      [0, 'facetrack'],
      [2000, 'auto'],
    ] as const) {
      await op({
        op: 'placeClip',
        args: {
          sequenceId: 'seq_a',
          trackId: 'V1',
          mediaId,
          startMs,
          inMs: startMs,
          durationMs: 2000,
          frame: { mode },
        },
      });
    }
    const seq = (await e.getProject(p.id)).sequences[0]!;
    const aspect = { width: seq.canvas.width, height: seq.canvas.height };
    const expected = new Map<string, ReturnType<typeof applyClipFraming>>();
    for (const it of seq.videoTracks[0]!.items) {
      if (it.type !== 'media') continue;
      const path = await e.facetrackPath(p.id, mediaId, trackOptionsFromFrame(it.frame!, aspect));
      expected.set(it.id, applyClipFraming(path, { inMs: it.inMs, durationMs: it.durationMs }));
      expect(path.shots.length).toBeGreaterThanOrEqual(1);
    }
    const explicit: FramingProvider = (_m, c) => expected.get(c.id);
    const ref = openEngine({ projectsDir, stylesDirs: [REPO_STYLES], tools, framing: explicit });
    const html = async (eng: typeof e) =>
      String((await eng.compile(p.id, 'seq_a', { mode: 'render' })).files.get('index.html'));
    const got = await html(e);
    expect(got).toBe(await html(ref));
    const first = seq.videoTracks[0]!.items[0]!;
    await op({
      op: 'updateClip',
      args: {
        sequenceId: 'seq_a',
        itemId: first.id,
        frame: { mode: 'facetrack', stability: 'follow' },
      },
    });
    expect(await html(e)).not.toBe(got);
  }, 300_000);
});
