// Fixture chain through `engine.jobs` with the real Python tools (local tier: mlx-whisper, MediaPipe,
// Vision; never on CI). talking-head-20s.mp4: ingest → shots → transcribe → facetrack, each one
// history entry, all cached on rerun; the facetrack path is built and cached. cuts-2shot: facetrack
// on a `{ proxies: false }` ingest runs from the original at 360p and gives the same per-shot
// subjects as the proxy run (plan phase 04 steps 9c, 10, 12).
// `VOX_WRITE_SEEDS=1` rewrites the committed seeds (fixtures/transcripts|shots|facetracks/talking-head-20s.json).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openEngine, resolveToolPaths, type Engine } from '../../src/api.ts';
import type { JobInfo } from '../../src/jobs.ts';
import { tempDir } from '../helpers/store.ts';
import { templates } from '../helpers/templates.ts';

const repo = new URL('../../../../', import.meta.url).pathname;
const fx = `${repo}packages/engine/test/fixtures/`;
const HEAD = `${fx}assets/media/talking-head-20s.mp4`;
const CUTS = `${fx}out/cuts-2shot.mp4`;
const MODEL = 'blaze_face_full_range.tflite';
const modelSources = [
  process.env['VOX_TEST_MODELS_DIR'],
  `${repo}py/cache/models`,
  `${repo}../../py/cache/models`,
];

function engine(): Engine {
  const toolsDir = tempDir('vox-chain-tools-');
  const tools = resolveToolPaths({ toolsDir, env: process.env, pyProject: `${repo}py` });
  const src = modelSources.find((d) => d && existsSync(join(d, MODEL)));
  if (src) {
    mkdirSync(tools['models']!, { recursive: true });
    copyFileSync(join(src, MODEL), join(tools['models']!, MODEL));
  }
  return openEngine({
    projectsDir: join(tempDir('vox-chain-'), 'Projects'),
    stylesDirs: [],
    templates,
    tools,
    config: async () => ({}),
  });
}

async function run<R>(e: Engine, kind: string, args: unknown): Promise<R> {
  const info = (await e.jobs.wait(e.jobs.start(kind, args))) as JobInfo<R>;
  if (info.status !== 'done') throw new Error(`${kind}: ${JSON.stringify(info.error)}`);
  return info.result!;
}

describe('fixture chain (local)', () => {
  test('talking-head: ingest → shots → transcribe → facetrack, one entry each, cached on rerun', async () => {
    const e = engine();
    const p = await e.createProject('chain');
    const ing = await run<{ media: { mediaId: string }[] }>(e, 'ingest', {
      projectId: p.id,
      inputs: [HEAD],
      actor: 'cli',
    });
    const mediaId = ing.media[0]!.mediaId;
    const args = { projectId: p.id, mediaId, actor: 'cli' };
    const shots = await run<{ shotsPath: string }>(e, 'shots', args);
    const tr = await run<{
      transcriptPath: string;
      language: string;
      words: number;
      cached: boolean;
    }>(e, 'transcribe', args);
    expect(tr).toMatchObject({ language: 'en', cached: false });
    expect(tr.words).toBeGreaterThan(20);
    const ft = await run<{ facetrackPath: string; samples: number; input: string }>(
      e,
      'facetrack',
      args,
    );
    expect(ft.input).toBe('proxy');
    expect(ft.samples).toBeGreaterThan(100);
    const hist = await e.history(p.id);
    expect(hist.map((h) => h.op)).toEqual([
      'addMedia',
      'updateMedia',
      'updateMedia',
      'updateMedia',
    ]);
    expect(hist.every((h) => h.actor === 'cli' && typeof h.jobId === 'string')).toBe(true);

    // Reruns: no Python, no new entry.
    expect(await run(e, 'transcribe', args)).toMatchObject({ cached: true });
    expect(await run(e, 'facetrack', args)).toMatchObject({ cached: true });
    expect(await run(e, 'shots', args)).toMatchObject({ cached: true });
    expect(await e.history(p.id)).toHaveLength(4);

    const path = await e.facetrackPath(p.id, mediaId, {
      mode: 'auto',
      aspect: { width: 1080, height: 1920 },
    });
    expect(path.keyframes.length).toBeGreaterThan(0);
    expect(path.shots[0]?.subject).toBe('face');
    expect(
      await e.facetrackPath(p.id, mediaId, { mode: 'auto', aspect: { width: 1080, height: 1920 } }),
    ).toEqual(path);

    if (process.env['VOX_WRITE_SEEDS'] === '1') {
      const dir = join(e.projectsDir, p.id);
      for (const [sub, rel] of [
        ['transcripts', tr.transcriptPath],
        ['shots', shots.shotsPath],
        ['facetracks', ft.facetrackPath],
      ] as const) {
        mkdirSync(`${fx}${sub}`, { recursive: true });
        writeFileSync(`${fx}${sub}/talking-head-20s.json`, readFileSync(join(dir, rel)));
      }
    }
  }, 600_000);

  test('cuts-2shot with proxies:false: facetrack from the original at 360p, same subjects as the proxy run', async () => {
    if (!existsSync(CUTS))
      throw new Error('Run `bash packages/engine/test/fixtures/make.sh` first.');
    const e = engine();
    const subjects: string[][] = [];
    for (const proxies of [true, false]) {
      const p = await e.createProject(`cuts-${proxies}`);
      const ing = await run<{ media: { mediaId: string }[] }>(e, 'ingest', {
        projectId: p.id,
        inputs: [CUTS],
        proxies,
      });
      const args = { projectId: p.id, mediaId: ing.media[0]!.mediaId };
      await run(e, 'shots', args);
      const ft = await run<{ input: string }>(e, 'facetrack', args);
      expect(ft.input).toBe(proxies ? 'proxy' : 'original');
      const path = await e.facetrackPath(p.id, args.mediaId, {
        mode: 'auto',
        aspect: { width: 1080, height: 1920 },
      });
      subjects.push(path.shots.map((s) => s.subject));
    }
    expect(subjects[1]).toEqual(subjects[0]);
  }, 600_000);
});
