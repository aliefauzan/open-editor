// D-104: the two-tier caption preset over a full-frame scene, in headless Chrome. Demo run 7 showed
// the preset's dark scrim as a grey blot on the flat paper of a collage scene. A chunk the engine
// marks `over` a scene gets no scrim; over a light scene its plain words are set in ink.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { templateInner } from '../../src/compile/compile.ts';
import { vendorSources } from '../../src/compile/write.ts';
import type { CaptionChunk, CaptionWord } from '../../src/model/captions.ts';
import { CAPTION_DEFAULTS } from '../../src/ops/captions.ts';
import { twoTierHtml, twoTierLook } from '../../src/styles/extract/caption-preset.ts';
import { loadStyleRegistry } from '../../src/styles/registry.ts';
import { KIT, REPO_STYLES, build, mainProject } from './fixture.ts';
import { chromePath, puppeteer, type Browser, type Page } from './hf.ts';

const W = 1080;
const H = 1920;
const ID = 'vtiers';

const word = (n: number, text: string, startMs: number, endMs: number) =>
  ({ key: `m_a:r1:${n}`, text, startMs, endMs, emphasis: false }) satisfies CaptionWord;
const chunk = (n: number, startMs: number, over?: 'light' | 'dark'): CaptionChunk => ({
  startMs,
  endMs: startMs + 800,
  lines: [
    {
      words: [
        word(n, 'rezeki', startMs, startMs + 400),
        word(n + 1, 'kita', startMs + 400, startMs + 800),
      ],
    },
  ],
  ...(over && { over }),
});
// over the footage, over a paper scene, over a dark card
const CHUNKS = [chunk(0, 0), chunk(2, 1000, 'light'), chunk(4, 2000, 'dark')];

describe('two-tier captions over a full-frame scene (D-104)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vox-tiers-'));
  let browser: Browser;
  let inner = '';
  let faces = '';
  let rest = {};

  beforeAll(async () => {
    const sdir = join(dir, 'styles', ID);
    mkdirSync(join(sdir, 'captions'), { recursive: true });
    writeFileSync(
      join(sdir, 'style.json'),
      JSON.stringify({
        id: ID,
        name: ID,
        version: '0.1.0',
        description: 'Test style: the measured two-tier preset.',
        status: 'active',
        extends: 'base',
        source: { type: 'user' },
        trusted: false,
        templates: [],
        transitions: [],
        tokens: { colors: { ink: '#151517' } },
        captions: { default: `${ID}/tiers`, presets: [`${ID}/tiers`] },
      }),
    );
    const look = twoTierLook({
      tiers: [],
      twoTierShare: 0.25,
      occlusion: { available: false, frames: 0, decided: 0, behind: 0, atMs: [] },
      trackingReveal: { events: 1, of: 4 },
    } as never);
    writeFileSync(join(sdir, 'captions', 'tiers.html'), twoTierHtml(look));
    writeFileSync(
      join(sdir, 'captions', 'tiers.json'),
      JSON.stringify({
        name: 'tiers',
        description: 'two-tier',
        case: 'asis',
        stripPunctuation: false,
        position: { yPct: 50 },
        tiered: true,
      }),
    );
    const p = mainProject(ID);
    p.sequences[0]!.captions = { ...CAPTION_DEFAULTS, preset: `${ID}/tiers`, overrides: [] };
    const reg = loadStyleRegistry({ stylesDirs: [REPO_STYLES, KIT, join(dir, 'styles')] });
    const b = await build(p, { mode: 'render' }, reg);
    const scene = b.files.get('scenes/captions.html');
    const index = b.files.get('index.html');
    if (typeof scene !== 'string' || typeof index !== 'string') throw new Error('no captions');
    faces = (index.match(/@font-face \{[^}]*\}/g) ?? []).join('\n');
    for (const [path, from] of b.links) {
      if (!path.startsWith('fonts/')) continue;
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      copyFileSync(from, join(dir, path));
    }
    mkdirSync(join(dir, 'vendor'));
    const v = vendorSources();
    for (const n of ['gsap.min.js', 'vox-runtime.js']) copyFileSync(v[n]!, join(dir, 'vendor', n));
    const sceneFile = join(dir, 'captions-scene.html');
    writeFileSync(sceneFile, scene);
    inner = templateInner(sceneFile);
    const vars = JSON.parse(/data-vox-instance="captions">(.*?)<\/script>/s.exec(inner)![1]!) as {
      safeArea: unknown;
      maxCharsPerLine: number;
    };
    rest = { safeArea: vars.safeArea, maxCharsPerLine: vars.maxCharsPerLine };
    browser = await puppeteer().launch({
      executablePath: chromePath(),
      headless: true,
      args: ['--allow-file-access-from-files', '--font-render-hinting=none'],
    });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function open(): Promise<Page> {
    const vars = JSON.stringify({ chunks: CHUNKS, position: { yPct: 50 }, ...rest }).replace(
      /</g,
      '\\u003c',
    );
    const body = inner.replace(
      /(data-vox-instance="captions">)(.*?)(<\/script>)/s,
      (_m, a: string, _v: string, c: string) => a + vars + c,
    );
    const file = join(dir, 'harness.html');
    writeFileSync(
      file,
      `<!doctype html>
<html><head><meta charset="UTF-8" />
<script src="vendor/gsap.min.js"></script>
<script src="vendor/vox-runtime.js"></script>
<style>
${faces}
html, body { margin: 0; background: #c3b4a1; }
#host { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; }
</style></head>
<body><div id="host">${body}</div></body></html>`,
    );
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H });
    await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
    return page;
  }

  test('no scrim over a scene; ink words over a light one, white over the footage and a dark card', async () => {
    const page = await open();
    await page.evaluate(`(window.__timelines.captions.seek(2.7, false), true)`);
    const look = await page.evaluate<{ scrims: number; color: string }[]>(
      `[0, 2, 4].map((n) => {
        const s = document.querySelector('[data-key="m_a:r1:' + n + '"]');
        const c = s.closest('.c-chunk');
        return { scrims: c.querySelectorAll('.c-scrim').length, color: getComputedStyle(s).color };
      })`,
    );
    expect(look.map((l) => l.scrims)).toEqual([1, 0, 0]);
    expect(look[1]!.color).toBe('rgb(21, 21, 23)');
    expect(look[0]!.color).not.toBe('rgb(21, 21, 23)');
    expect(look[2]!.color).toBe(look[0]!.color);
  }, 120_000);
});
