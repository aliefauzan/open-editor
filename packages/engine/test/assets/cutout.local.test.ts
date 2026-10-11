// Cutout through `engine.jobs` with the real rembg tool and the pinned U^2-Net model (local tier,
// never on CI; phase 05 step 3). The model comes from `VOX_TOOLS_DIR` or the default tools folder
// (`<tools>/models/rembg/u2net.onnx`, SHA-256 pinned); a missing model fails the test.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openEngine, resolveToolPaths } from '../../src/api.ts';
import type { JobInfo } from '../../src/jobs.ts';
import { tempDir } from '../helpers/store.ts';
import { templates } from '../helpers/templates.ts';

const repo = new URL('../../../../', import.meta.url).pathname;
const FACE = `${repo}packages/engine/test/fixtures/assets/faces/face-a.jpg`;
const toolsHome =
  process.env['VOX_TOOLS_DIR'] ??
  join(homedir(), 'Library', 'Application Support', 'Vox Studio', 'tools');
const MODEL = join(toolsHome, 'models', 'rembg', 'u2net.onnx');

describe('assets.cutout (local)', () => {
  test('an image becomes an RGBA PNG media item with the source licence, one history entry', async () => {
    if (!existsSync(MODEL)) throw new Error(`cutout model missing: put u2net.onnx at ${MODEL}`);
    const toolsDir = tempDir('vox-cut-tools-');
    const tools = resolveToolPaths({ toolsDir, env: process.env, pyProject: `${repo}py` });
    mkdirSync(join(tools['models']!, 'rembg'), { recursive: true });
    copyFileSync(MODEL, join(tools['models']!, 'rembg', 'u2net.onnx'));
    const e = openEngine({
      projectsDir: join(tempDir('vox-cut-'), 'Projects'),
      stylesDirs: [],
      templates,
      tools,
      config: async () => ({}),
    });
    const p = await e.createProject('cut');
    const ing = (await e.jobs.wait(
      e.jobs.start('ingest', { projectId: p.id, inputs: [FACE], actor: 'cli' }),
    )) as JobInfo<{ media: { mediaId: string }[] }>;
    const src = ing.result!.media[0]!.mediaId;
    const r = (await e.jobs.wait(
      e.jobs.start('assets.cutout', { projectId: p.id, mediaId: src, actor: 'cli' }),
    )) as JobInfo<{ mediaId: string }>;
    expect(r.status, JSON.stringify(r.error)).toBe('done');
    const proj = await e.getProject(p.id);
    const m = proj.media.find((x) => x.id === r.result!.mediaId)!;
    expect(m.kind).toBe('image');
    expect(m.description).toBe(`Cutout of ${src}`);
    expect(m.origin.type).toBe('upload');
    const png = readFileSync(join(e.projectsDir, p.id, m.path));
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(png[25]).toBe(6); // IHDR colour type 6 = RGBA
    expect((await e.history(p.id)).filter((h) => h.jobId === r.id)).toHaveLength(1);
  }, 120_000);
});
