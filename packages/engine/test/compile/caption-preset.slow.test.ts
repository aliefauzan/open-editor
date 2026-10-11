// Step 9c (D-15): the `base/plain` caption preset in headless Chrome (the browser HyperFrames renders
// with). The compiled captions instance is mounted in a harness page with a fixture CaptionChunk[]
// (two lines, one emphasis word, a 200 ms gap) on 9:16, and its timeline is seeked like the renderer.
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { templateInner } from '../../src/compile/compile.ts';
import { vendorSources } from '../../src/compile/write.ts';
import type { CaptionChunk, CaptionWord } from '../../src/model/captions.ts';
import { build, mainProject } from './fixture.ts';
import { chromePath, puppeteer, type Browser, type Page } from './hf.ts';

const W = 1080;
const H = 1920;

const word = (n: number, text: string, startMs: number, endMs: number, emphasis = false) =>
  ({ key: `m_a:r1:${n}`, text, startMs, endMs, emphasis }) satisfies CaptionWord;

// Chunk 1: line 1 "One two three" (word 2 is 400–800 ms), line 2 "again now" with the emphasis word
// "again"; a 200 ms gap; chunk 2 is one line of exactly maxCharsPerLine (18) characters.
const CHUNKS: CaptionChunk[] = [
  {
    startMs: 0,
    endMs: 1500,
    lines: [
      { words: [word(0, 'One', 100, 400), word(1, 'two', 400, 800), word(2, 'three', 800, 1100)] },
      { words: [word(3, 'again', 1100, 1300, true), word(4, 'now', 1300, 1500)] },
    ],
  },
  {
    startMs: 1700,
    endMs: 2500,
    lines: [{ words: [word(5, 'Wonderfully', 1700, 2100), word(6, 'quiet.', 2100, 2500)] }],
  },
];

interface Box {
  key: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

describe('base/plain caption preset in Chrome (step 9c)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vox-captions-'));
  let browser: Browser;
  let inner = '';
  let faces = '';
  let safe = { bottomPct: 0, rightPct: 0 };
  let maxChars = 0;

  beforeAll(async () => {
    const b = await build(mainProject());
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
    const vars = /data-vox-instance="captions">(.*?)<\/script>/s.exec(inner)![1]!;
    const parsed = JSON.parse(vars) as {
      safeArea: typeof safe;
      maxCharsPerLine: number;
    };
    safe = parsed.safeArea;
    maxChars = parsed.maxCharsPerLine;
    browser = await puppeteer().launch({
      executablePath: chromePath(),
      headless: true,
      args: ['--allow-file-access-from-files', '--font-render-hinting=none'],
    });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** A harness page with the compiled instance, the fixture chunks and `position.yPct`. */
  async function open(yPct: number): Promise<Page> {
    const vars = JSON.stringify({
      chunks: CHUNKS,
      position: { yPct },
      safeArea: safe,
      maxCharsPerLine: maxChars,
    }).replace(/</g, '\\u003c');
    const body = inner.replace(
      /(data-vox-instance="captions">)(.*?)(<\/script>)/s,
      (_m, a: string, _v: string, c: string) => a + vars + c,
    );
    const file = join(dir, `harness-${yPct}.html`);
    writeFileSync(
      file,
      `<!doctype html>
<html><head><meta charset="UTF-8" />
<script src="vendor/gsap.min.js"></script>
<script src="vendor/vox-runtime.js"></script>
<style>
${faces}
html, body { margin: 0; background: #2d4a3e; }
#host { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; }
</style></head>
<body><div id="host">${body}</div></body></html>`,
    );
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H });
    await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
    await page.evaluate(
      `Promise.all([document.fonts.load('400 50px "IBM Plex Mono"'), document.fonts.load('700 50px "IBM Plex Mono"')]).then(() => document.fonts.ready).then(() => true)`,
    );
    return page;
  }

  const seek = (page: Page, ms: number) =>
    page.evaluate(`(window.__timelines.captions.seek(${ms / 1000}, false), true)`);

  const styleOf = (page: Page, key: string) =>
    page.evaluate<{ weight: string; size: number; chunkSize: number; opacity: string }>(
      `(() => { const s = document.querySelector('[data-key="${key}"]');
        const c = s.closest('.c-chunk');
        return { weight: getComputedStyle(s).fontWeight, size: parseFloat(getComputedStyle(s).fontSize),
          chunkSize: parseFloat(getComputedStyle(c).fontSize), opacity: getComputedStyle(c).opacity }; })()`,
    );

  const boxOf = (page: Page, key: string) =>
    page.evaluate<Box>(
      `(() => { const r = document.querySelector('[data-key="${key}"]').getBoundingClientRect();
        return { key: '${key}', left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()`,
    );

  async function shot(page: Page, b?: Box): Promise<Buffer> {
    const clip = b
      ? {
          x: Math.floor(b.left) - 8,
          y: Math.floor(b.top) - 8,
          width: Math.ceil(b.right - b.left) + 16,
          height: Math.ceil(b.bottom - b.top) + 16,
        }
      : undefined;
    return Buffer.from(await page.screenshot({ type: 'png', ...(clip ? { clip } : {}) }));
  }

  test('inside word 2: word 2 active, words 1 and 3 read/unread look the same (DOM + pixels)', async () => {
    const page = await open(75);
    const k = (n: number) => `m_a:r1:${n}`;
    // word 1 unread (chunk visible, before word 1)
    await seek(page, 50);
    const w1 = await boxOf(page, k(0));
    const w2 = await boxOf(page, k(1));
    const w1Unread = await shot(page, w1);
    const w2Unread = await shot(page, w2);
    await seek(page, 600);
    const [s1, s2, s3] = [
      await styleOf(page, k(0)),
      await styleOf(page, k(1)),
      await styleOf(page, k(2)),
    ];
    expect(s2.weight).toBe('700');
    expect(s1.weight).toBe('400');
    expect(s3.weight).toBe('400');
    expect(s2.opacity).toBe('1');
    const w1Read = await shot(page, w1);
    const w2Active = await shot(page, w2);
    expect(w1Read.equals(w1Unread)).toBe(true);
    expect(w2Active.equals(w2Unread)).toBe(false);
    // word 2 read (after it): back to the unread look
    await seek(page, 900);
    expect((await styleOf(page, k(1))).weight).toBe('400');
    expect((await shot(page, w2)).equals(w2Unread)).toBe(true);
    // the 200 ms gap shows no caption
    await seek(page, 1600);
    expect((await styleOf(page, k(0))).opacity).toBe('0');
    expect((await styleOf(page, k(5))).opacity).toBe('0');
  }, 120_000);

  test('the same frame reached by seeking backwards is byte-identical', async () => {
    const page = await open(75);
    await seek(page, 0);
    await seek(page, 600);
    const forward = await shot(page);
    await seek(page, 2400);
    await seek(page, 1200);
    await seek(page, 600);
    const backward = await shot(page);
    expect(backward.equals(forward)).toBe(true);
  }, 120_000);

  test('the emphasis word keeps its own look (1.2x) unread, active and read', async () => {
    const page = await open(75);
    const key = 'm_a:r1:3';
    for (const [ms, weight] of [
      [600, '400'],
      [1200, '700'],
      [1400, '400'],
    ] as const) {
      await seek(page, ms);
      const s = await styleOf(page, key);
      expect(s.weight, `${ms} ms`).toBe(weight);
      expect(s.size / s.chunkSize, `${ms} ms`).toBeCloseTo(1.2, 5);
      const plain = await styleOf(page, 'm_a:r1:4');
      expect(plain.size).toBeCloseTo(plain.chunkSize, 5);
    }
  }, 120_000);

  test.each([75, 95])(
    'position.yPct %i: every word box stays inside the safe area',
    async (yPct) => {
      const page = await open(yPct);
      const side = (safe.rightPct / 100) * W;
      const limit = (1 - safe.bottomPct / 100) * H;
      expect(safe).toEqual({ bottomPct: 20, rightPct: 12 });
      for (const [ms, keys] of [
        [1200, [0, 1, 2, 3, 4]],
        [2200, [5, 6]],
      ] as const) {
        await seek(page, ms);
        for (const n of keys) {
          const b = await boxOf(page, `m_a:r1:${n}`);
          expect(b.left, `${yPct} word ${n}`).toBeGreaterThanOrEqual(side - 0.5);
          expect(b.right, `${yPct} word ${n}`).toBeLessThanOrEqual(W - side + 0.5);
          expect(b.top, `${yPct} word ${n}`).toBeGreaterThanOrEqual(0);
          expect(b.bottom, `${yPct} word ${n}`).toBeLessThanOrEqual(limit + 0.5);
        }
      }
    },
    120_000,
  );
});
