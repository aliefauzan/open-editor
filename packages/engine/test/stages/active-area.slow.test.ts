// Active picture area with real ffmpeg (slow tier): synthetic 1920×1080 clips from lavfi, one with
// a 1920×800 picture between black bars (letterbox), one 4:3 picture between side bars (pillarbox)
// and one normal. Ingest stores the area in `cache/media/<id>.json`, never in project.json, and the
// 9:16 crop path built from it stays inside the picture.
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MediaItemSchema } from '../../src/model/schema.ts';
import { buildTrackPath, cropSize } from '../../src/stages/facetrack.ts';
import { ingest, type IngestEnv } from '../../src/stages/ingest.ts';
import { detectActiveArea, normaliseArea } from '../../src/stages/media/activeArea.ts';
import { runTool } from '../../src/stages/media/run.ts';
import { removeDir, tempDir } from '../media/helpers.ts';
import { box, synth } from './facetrack-synth.ts';

let root = '';
const clip = (name: string) => join(root, `${name}.mp4`);

async function make(name: string, graph: string): Promise<void> {
  await runTool('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    graph,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    clip(name),
  ]);
}

beforeAll(async () => {
  root = tempDir('vox-active-area-');
  await make('letterbox', 'testsrc2=s=1920x800:r=25:d=8,pad=1920:1080:0:140:black');
  await make('pillarbox', 'testsrc2=s=1440x1080:r=25:d=8,pad=1920:1080:240:0:black');
  await make('normal', 'testsrc2=s=1920x1080:r=25:d=8');
});
afterAll(() => removeDir(root));

const frame = { width: 1920, height: 1080, durationMs: 8000 };

describe('detectActiveArea (slow)', () => {
  test('a letterboxed clip gives the 1920×800 picture', async () => {
    expect(await detectActiveArea(clip('letterbox'), 'mov', frame)).toEqual({
      x: 0,
      y: 140,
      w: 1920,
      h: 800,
    });
  });

  test('a pillarboxed clip gives the 1440×1080 picture', async () => {
    expect(await detectActiveArea(clip('pillarbox'), 'mov', frame)).toEqual({
      x: 240,
      y: 0,
      w: 1440,
      h: 1080,
    });
  });

  test('a normal clip gives the full frame', async () => {
    expect(await detectActiveArea(clip('normal'), 'mov', frame)).toEqual({
      x: 0,
      y: 0,
      w: 1920,
      h: 1080,
    });
  });

  test('the 9:16 crop path from the detected area stays inside the picture', async () => {
    const px = await detectActiveArea(clip('letterbox'), 'mov', frame);
    const area = normaliseArea(px, 1920, 1080)!;
    expect(area).toBeDefined();
    const det = {
      ...synth(8000, (t) => ({ faces: [box(0.05 + (0.9 * t) / 8000, 0.1, 0.08, 0.1)] })),
    };
    const aspect = { width: 1080, height: 1920 };
    const path = buildTrackPath(
      { ...det, width: 1920, height: 1080 },
      [],
      { mode: 'auto', aspect },
      area,
    );
    for (const k of path.keyframes) {
      const c = cropSize({ width: 1920, height: 1080 }, aspect, k.scale);
      expect((k.y - c.h / 2) * 1080).toBeGreaterThanOrEqual(140 - 0.5);
      expect((k.y + c.h / 2) * 1080).toBeLessThanOrEqual(940 + 0.5);
    }
  });
});

describe('ingest stores the active area beside the content hash (slow)', () => {
  const env = (projectDir: string): IngestEnv => ({
    projectDir,
    existing: [],
    tools: {},
    docText: async () => {
      throw new Error('no docs here');
    },
  });

  test.each([
    ['letterbox', { x: 0, y: 140, w: 1920, h: 800 }],
    ['normal', { x: 0, y: 0, w: 1920, h: 1080 }],
  ] as const)('%s', async (name, want) => {
    const dir = join(root, `p-${name}`);
    await mkdir(dir, { recursive: true });
    const r = await ingest(env(dir), { projectId: 'p', inputs: [clip(name)], proxies: false });
    const m = MediaItemSchema.parse(r.media[0]!.media);
    expect(m).not.toHaveProperty('activeArea');
    const cache = JSON.parse(
      await readFile(join(dir, 'cache', 'media', `${m.id}.json`), 'utf8'),
    ) as {
      sha256: string;
      activeArea: unknown;
    };
    expect(cache.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cache.activeArea).toEqual(want);
  });
});
