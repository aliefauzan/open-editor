// Step 14: renderLayers to a ProRes 4444 MOV with alpha (`hyperframes render --format mov`).
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { renderLayerBuild } from '../../src/render/layers.ts';
import { build, mainProject } from '../compile/fixture.ts';
import { frameCount } from '../compile/hf.ts';

const probe = (file: string, entries: string) =>
  execFileSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', entries, '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  ).trim();

/** Mean of the alpha plane (0-255) of frame `n`. */
function meanAlpha(file: string, n: number): number {
  const buf = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n}),alphaextract,scale=64:64,format=gray`,
      '-frames:v', '1', '-f', 'rawvideo', '-'],
    { maxBuffer: 1 << 20 },
  ); // prettier-ignore
  let s = 0;
  for (const b of buf) s += b;
  return s / buf.length;
}

describe('renderLayers (step 14)', () => {
  test('a text overlay layer renders to ProRes 4444 with a partly transparent alpha plane', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vox-layers-'));
    const b = await build(mainProject(), {
      mode: 'render',
      layers: ['it_o1'],
      range: { startMs: 3000, endMs: 5000 },
    });
    const out = await renderLayerBuild(b, {
      buildDir: join(dir, 'build'),
      out: join(dir, 'layers.mov'),
    });
    const [codec, pixFmt] = probe(out, 'stream=codec_name,pix_fmt').split(',');
    expect(codec).toBe('prores');
    expect(pixFmt).toMatch(/^yuva/);
    expect(frameCount(out)).toBe(60);
    // after the entrance: the overlay covers part of the frame, the rest is transparent
    const a = meanAlpha(out, 45);
    expect(a).toBeGreaterThan(1);
    expect(a).toBeLessThan(200);
  }, 900_000);
});
