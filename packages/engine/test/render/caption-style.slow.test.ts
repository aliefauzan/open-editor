// GATE 5 finding: burned-in captions rendered in the default serif with no stroke. HyperFrames
// mounts a scene template by flattening its authored root below the host (the root loses
// `data-composition-id` and `id`, and gains `data-hf-inner-root` / `data-hf-authored-id`), and it
// scopes the scene's `#root { --tok-* }` rule to that inner root. The caption script appends its
// chunks to `vox.mount(id).root`; when that is the host instead of the inner root, the words sit
// outside the element that carries the token variables, so `var(--tok-font-caption)` and the stroke
// colour are undefined. These tests mount captions the way HyperFrames does (preview runtime in
// Chrome, and a real `hyperframes render`) and check the words are styled by the tokens.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Project } from '../../src/model/schema.ts';
import { renderLayerBuild } from '../../src/render/layers.ts';
import { build, mainProject } from '../compile/fixture.ts';
import { chromePath, makeMedia, puppeteer, writeBuild, type Browser } from '../compile/hf.ts';

/** mainProject with every media item pointing at the generated files. */
function withRealMedia(p: Project): Project {
  for (const m of p.media) {
    if (m.kind === 'image') m.path = 'media/m_img.jpg';
    else {
      m.path = 'media/m_a.mp4';
      m.audioPath = 'media/m_a.mp4';
      m.proxyPath = 'media/m_a.mp4';
      delete m.cfrPath;
      delete m.vfr;
    }
  }
  return p;
}

interface WordStyle {
  inInnerRoot: boolean;
  fontFamily: string;
  strokeWidth: number;
  color: string;
}

describe('captions mounted by HyperFrames use the style tokens (GATE 5)', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'vox-capstyle-')), 'p_test');
  let browser: Browser;

  beforeAll(async () => {
    makeMedia(dir);
    browser = await puppeteer().launch({
      executablePath: chromePath(),
      headless: true,
      args: ['--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'],
    });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  test('preview build: the runtime-mounted caption words are in IBM Plex Mono with a stroke', async () => {
    const b = await build(withRealMedia(mainProject()), { mode: 'preview' }, undefined, {
      projectDir: dir,
    });
    const out = writeBuild(b, join(dir, 'build', 'preview'));
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(pathToFileURL(join(out, 'index.html')).href, { waitUntil: 'load' });
    const s = await page.evaluate<WordStyle>(
      `new Promise((resolve, reject) => {
        const t0 = Date.now();
        (function poll() {
          const w = document.querySelector('.c-word');
          if (!w) return Date.now() - t0 > 20000 ? reject(new Error('no .c-word')) : setTimeout(poll, 50);
          const cs = getComputedStyle(w);
          resolve({
            inInnerRoot: !!w.closest('[data-hf-inner-root]'),
            fontFamily: cs.fontFamily,
            strokeWidth: parseFloat(cs.webkitTextStrokeWidth),
            color: cs.color,
          });
        })();
      })`,
    );
    expect(s.inInnerRoot).toBe(true);
    expect(s.fontFamily).toMatch(/IBM Plex Mono/);
    expect(s.strokeWidth).toBeGreaterThan(0);
    expect(s.color).toBe('rgb(255, 255, 255)');
  }, 120_000);

  test('render: a captions layer frame has white glyph fill inside a dark stroke', async () => {
    // fixture captions: chunk "this is Vox." is on screen from 200 to 1300 ms
    const b = await build(
      withRealMedia(mainProject()),
      { mode: 'render', layers: ['captions'], range: { startMs: 0, endMs: 1500 } },
      undefined,
      { projectDir: dir },
    );
    const mov = await renderLayerBuild(b, {
      buildDir: join(dir, 'build', 'captions-layer'),
      out: join(dir, 'renders', 'captions.mov'),
    });
    const rgba = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', mov, '-vf', 'select=eq(n\\,30),format=rgba', '-frames:v', '1',
        '-f', 'rawvideo', '-'],
      { maxBuffer: 64 << 20 },
    ); // prettier-ignore
    let fill = 0;
    let stroke = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3]! < 230) continue;
      const lo = Math.min(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
      const hi = Math.max(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
      if (lo > 230) fill++;
      else if (hi < 40) stroke++;
    }
    // unstyled words are black (no token colour) with no stroke, so no white fill at all
    expect(fill).toBeGreaterThan(500);
    expect(stroke).toBeGreaterThan(500);
  }, 900_000);
});
