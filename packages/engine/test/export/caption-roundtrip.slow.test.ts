// Caption edit round trip (phase 05 step 13): one `setCaptions` override replaces a word's text and
// nudges its start; `exportCaptions` SRT shows the new word at the new time, and the compiled caption
// layer, mounted in headless Chrome and seeked like the renderer, shows the new word at that time
// (DOM text check). `captions: false` (render --captions none) leaves the caption layer out.
// The `vox quick … --render` part of step 13 is packages/cli/test/quick.local.test.ts.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { templateInner } from '../../src/compile/compile.ts';
import { vendorSources } from '../../src/compile/write.ts';
import type { JobInfo } from '../../src/jobs.ts';
import { chromePath, puppeteer, type Browser } from '../compile/hf.ts';
import { tempDir } from '../helpers/store.ts';
import { exportEngine, exportProject, type Fixture } from './project.ts';

const NEW_WORD = 'Zebra';
const NUDGE_MS = 100;

let fx: Fixture;
let browser: Browser;
beforeAll(async () => {
  fx = await exportProject(exportEngine(), 6000);
  browser = await puppeteer().launch({
    executablePath: chromePath(),
    headless: true,
    args: ['--allow-file-access-from-files'],
  });
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

const srtTime = (ms: number) => {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

/** Text of the caption chunks visible at `atMs`, read from the compiled layer in Chrome. */
async function visibleCaption(atMs: number): Promise<string> {
  const b = await fx.e.compile(fx.projectId, fx.seq, { mode: 'render' });
  const dir = mkdtempSync(join(tmpdir(), 'vox-caption-dom-'));
  for (const [path, from] of b.links) {
    if (!path.startsWith('fonts/')) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    copyFileSync(from, join(dir, path));
  }
  mkdirSync(join(dir, 'vendor'));
  const v = vendorSources();
  for (const n of ['gsap.min.js', 'vox-runtime.js']) copyFileSync(v[n]!, join(dir, 'vendor', n));
  const sceneFile = join(dir, 'captions-scene.html');
  writeFileSync(sceneFile, String(b.files.get('scenes/captions.html')));
  const file = join(dir, 'harness.html');
  writeFileSync(
    file,
    `<!doctype html><html><head><meta charset="UTF-8" />
<script src="vendor/gsap.min.js"></script><script src="vendor/vox-runtime.js"></script>
<style>html, body { margin: 0; } #host { position: relative; width: 1080px; height: 1920px; overflow: hidden; }</style>
</head><body><div id="host">${templateInner(sceneFile)}</div></body></html>`,
  );
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });
  await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
  await page.evaluate(`(window.__timelines.captions.seek(${atMs / 1000}, false), true)`);
  return page.evaluate<string>(
    `[...document.querySelectorAll('.c-chunk')].filter((c) => Number(getComputedStyle(c).opacity) > 0.5).map((c) => c.textContent.replace(/\\s+/g, ' ').trim()).join(' | ')`,
  );
}

describe('caption edit round trip (step 13)', () => {
  test('an override replaces a word and nudges its start: SRT and the compiled layer show it', async () => {
    const before = await fx.e.captions(fx.projectId, fx.seq);
    // the first word of the second chunk: its start is the chunk's start, so the SRT time moves
    const chunk = before[1]!;
    const word = chunk.lines[0]!.words[0]!;
    const next = chunk.lines.flatMap((l) => l.words)[1];
    const nudged = word.startMs + NUDGE_MS;
    expect(nudged).toBeLessThan(next ? next.startMs : word.endMs);
    const r = await fx.e.applyOp(
      fx.projectId,
      {
        op: 'setCaptions',
        args: {
          sequenceId: fx.seq,
          overrides: [{ wordKey: word.key, text: NEW_WORD, startMs: nudged }],
        },
      } as never,
      { actor: 'cli' },
    );
    expect(r.results[0]!.status, JSON.stringify(r.results)).toBe('succeeded');

    const after = await fx.e.captions(fx.projectId, fx.seq);
    const edited = after
      .flatMap((c) => c.lines.flatMap((l) => l.words))
      .find((w) => w.key === word.key)!;
    expect(edited.text).toBe(NEW_WORD);
    expect(Math.abs(edited.startMs - nudged)).toBeLessThanOrEqual(34); // on the frame grid
    const editedChunk = after.find((c) =>
      c.lines.some((l) => l.words.some((w) => w.key === word.key)),
    )!;
    expect(editedChunk.startMs).toBe(edited.startMs);

    const out = tempDir('vox-caption-srt-');
    const job = (await fx.e.jobs.wait(
      fx.e.jobs.start('exportCaptions', {
        projectId: fx.projectId,
        format: 'srt',
        target: { dir: out },
      }),
    )) as JobInfo<{ path: string }>;
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    const srt = readFileSync(job.result!.path, 'utf8');
    const cue = srt.split('\n\n').find((c) => c.includes(NEW_WORD));
    expect(cue, srt).toBeDefined();
    expect(cue).toContain(`${srtTime(editedChunk.startMs)} --> `);
    expect(srt).not.toContain(`${srtTime(chunk.startMs)} --> `);

    // the DOM at the new time shows the new word; just before it, the edited chunk is not shown yet
    expect(await visibleCaption(edited.startMs + 20)).toContain(NEW_WORD);
    expect(await visibleCaption(editedChunk.startMs - 40)).not.toContain(NEW_WORD);
  }, 300_000);

  test('captions: false (render --captions none) has no caption layer', async () => {
    const b = await fx.e.compile(fx.projectId, fx.seq, { mode: 'render', captions: false });
    expect(b.files.has('scenes/captions.html')).toBe(false);
    expect(String(b.files.get('index.html'))).not.toContain('id="captions"');
  });
});
