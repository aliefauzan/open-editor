// GATE 4 timeline benchmark driver: builds the prototype with vite (production React), serves it
// on 127.0.0.1 and drives it with real mouse input in Playwright Chromium. Phase 08 re-runs the
// same scenario inside Electron once Electron is pinned (phase 01).
import { loadavg } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { _electron, type Browser, chromium, type ElectronApplication, type Page } from 'playwright';
import { build, preview } from 'vite';
import { BENCH_GEOMETRY as G } from './timeline-proto/model.ts';
import {
  type AttemptResult,
  type GestureStats,
  type LinkedCheck,
  type MarqueeCheck,
  frameStats,
} from './timeline-stats.ts';

const PROTO_DIR = fileURLToPath(new URL('./timeline-proto/', import.meta.url));
const OUT_DIR = path.join(PROTO_DIR, 'out');

export const VIEWPORT = { width: 1920, height: 1080, deviceScaleFactor: 2 } as const;
/** px per mouse event while a gesture runs. */
const STEP_PX = 3;

export interface RunOptions {
  attempts: number;
  headed: boolean;
  gestureMs: number;
  browser: 'shell' | 'chromium' | 'electron';
  log?: (line: string) => void;
}

export interface RunResult {
  browserVersion: string;
  /** 'headless shell', 'new headless' or 'headed'. */
  mode: string;
  gpuRenderer: string;
  attempts: AttemptResult[];
}

const actionSel = (id: string) => `.timeline-editor-action:has([data-item-id="${id}"])`;

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error(`no box for ${selector}`);
  return b;
}

const nextFrame = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

/**
 * Hold the mouse on `grab` and sweep it right and back by `amplitude` px for `ms`, sending moves as
 * fast as the renderer acknowledges them (about one per frame), while the page records every rAF
 * timestamp. The timed window ends after the drop has rendered, so the drop commit counts too.
 */
async function gesture(
  page: Page,
  grab: { x: number; y: number },
  amplitude: number,
  ms: number,
): Promise<GestureStats> {
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + STEP_PX, grab.y);
  const updates0 = await page.evaluate(() => window.__bench!.updates());
  await page.evaluate(() => window.__bench!.startFrames());
  let dx = STEP_PX;
  let dir = 1;
  let moves = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    dx += dir * STEP_PX;
    if (dx >= amplitude) dir = -1;
    else if (dx <= 0) dir = 1;
    await page.mouse.move(grab.x + dx, grab.y);
    moves++;
  }
  const updates = (await page.evaluate(() => window.__bench!.updates())) - updates0;
  await page.mouse.up();
  await nextFrame(page);
  const ts = await page.evaluate(() => window.__bench!.stopFrames());
  return { ...frameStats(ts), updates, moves };
}

async function centre(page: Page, id: string) {
  const b = await box(page, actionSel(id));
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function rightEdge(page: Page, id: string) {
  const b = await box(page, actionSel(id));
  return { x: b.x + b.width - 3, y: b.y + b.height / 2 };
}

/** Drag V1 clip 12 by +150 px (5 s): its A1 partner must follow during the drag and match after. */
async function linkedCheck(page: Page): Promise<LinkedCheck> {
  const v = 'it_V1_12';
  const a = 'it_A1_12';
  const before = (await page.evaluate((id) => window.__bench!.item(id), v))!.startMs;
  const from = await centre(page, v);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 150, from.y, { steps: 30 });
  await nextFrame(page);
  // Mid-drag the partner shows through its preview offset on our clip node.
  const midV = await box(page, `[data-item-id="${v}"]`);
  const midA = await box(page, `[data-item-id="${a}"]`);
  await page.mouse.up();
  await nextFrame(page);
  const endV = await box(page, actionSel(v));
  const endA = await box(page, actionSel(a));
  const [vi, ai] = await page.evaluate(
    ([x, y]) => [window.__bench!.item(x!), window.__bench!.item(y!)],
    [v, a],
  );
  const expectedX = from.x - midV.width / 2 + 150;
  const followedDuringDrag = Math.abs(midV.x - expectedX) < 1 && Math.abs(midA.x - expectedX) < 1;
  const draggedStartMs = vi!.startMs;
  const partnerStartMs = ai!.startMs;
  return {
    pass:
      followedDuringDrag &&
      draggedStartMs === partnerStartMs &&
      draggedStartMs === before + 5000 &&
      Math.abs(endV.x - endA.x) < 0.5,
    draggedStartMs,
    partnerStartMs,
    movedMs: draggedStartMs - before,
    followedDuringDrag,
  };
}

/** Marquee from 0.8 s on V3 to 60.8 s on V2: exactly items 0–24 on both tracks (50). */
async function marqueeCheck(page: Page): Promise<MarqueeCheck> {
  const area = await box(page, '.timeline-editor-edit-area');
  const x = (sec: number) => area.x + G.startLeft + (sec / G.scale) * G.scaleWidth;
  const y = (row: number) => area.y + row * G.rowHeight + G.rowHeight / 2;
  await page.mouse.move(x(0.8), y(1));
  await page.mouse.down();
  await page.mouse.move(x(60.8), y(2), { steps: 20 });
  await page.mouse.up();
  await nextFrame(page);
  const expected = [...Array(25).keys()].flatMap((i) => [`it_V3_${i}`, `it_V2_${i}`]).sort();
  const selected = (await page.evaluate(() => window.__bench!.selected())).sort();
  const domSelected = await page.locator('.timeline-editor-action-selected').count();
  return {
    pass: JSON.stringify(selected) === JSON.stringify(expected) && domSelected === expected.length,
    expected: expected.length,
    selected: selected.length,
    domSelected,
  };
}

async function runAttempt(page: Page, url: string, gestureMs: number): Promise<AttemptResult> {
  const loadBefore = loadavg()[0]!;
  await page.goto(url);
  await page.waitForFunction(() => window.__bench?.actionCount() === 1000);
  await nextFrame(page);
  // Checks first, on untouched data; then the timed gestures.
  const marquee = await marqueeCheck(page);
  const linked = await linkedCheck(page);
  await gesture(page, await centre(page, 'it_V4_3'), 120, 500); // warm-up, not measured
  const drag = await gesture(page, await centre(page, 'it_V2_10'), 300, gestureMs);
  const trim = await gesture(page, await rightEdge(page, 'it_V2_20'), 300, gestureMs);
  const linkedDrag = await gesture(page, await centre(page, 'it_V1_7'), 300, gestureMs);
  return {
    drag,
    trim,
    linkedDrag,
    linkedCheck: linked,
    marqueeCheck: marquee,
    loadBefore,
    loadAfter: loadavg()[0]!,
  };
}

export async function buildPrototype(): Promise<void> {
  await build({
    root: PROTO_DIR,
    configFile: false,
    logLevel: 'warn',
    base: './',
    oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
    build: { outDir: OUT_DIR, emptyOutDir: true },
  });
}

export async function runTimelineBench(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? (() => {});
  log('building prototype (vite, production React)');
  await buildPrototype();
  const server = await preview({
    root: PROTO_DIR,
    configFile: false,
    logLevel: 'warn',
    build: { outDir: OUT_DIR },
    preview: { host: '127.0.0.1', port: 0, open: false },
  });
  if (opts.browser === 'electron') {
    try {
      return await runInElectron(server, opts, log);
    } finally {
      await server.close();
    }
  }
  // The headless shell cannot run headed; --headed always means full Chromium.
  const full = opts.headed || opts.browser === 'chromium';
  const mode = opts.headed ? 'headed' : full ? 'new headless' : 'headless shell';
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch(
      full ? { channel: 'chromium', headless: !opts.headed } : { headless: true },
    );
    const { port } = server.httpServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/`;
    const context = await browser.newContext({
      viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
      deviceScaleFactor: VIEWPORT.deviceScaleFactor,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    const attempts: AttemptResult[] = [];
    for (let i = 1; i <= opts.attempts; i++) {
      log(`attempt ${i}/${opts.attempts}`);
      attempts.push(await runAttempt(page, url, opts.gestureMs));
      if (errors.length > 0) throw new Error(`page errors: ${errors.join('; ')}`);
    }
    const gpuRenderer = await page.evaluate(() => window.__bench!.gpuRenderer());
    return { browserVersion: browser.version(), mode, gpuRenderer, attempts };
  } finally {
    await browser?.close();
    await server.close();
  }
}

/** Step A3: the same attempts inside the pinned Electron, a real window on the display. */
async function runInElectron(
  server: { httpServer: { address(): unknown } },
  opts: RunOptions,
  log: (line: string) => void,
): Promise<RunResult> {
  const { port } = server.httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/`;
  const executablePath = createRequire(import.meta.url)('electron') as unknown as string;
  let app: ElectronApplication | null = null;
  try {
    app = await _electron.launch({
      executablePath,
      args: [path.join(import.meta.dirname, 'timeline-electron-main.cjs'), url],
    });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    await page.waitForLoadState('load');
    const attempts: AttemptResult[] = [];
    for (let i = 1; i <= opts.attempts; i++) {
      log(`attempt ${i}/${opts.attempts} (electron)`);
      attempts.push(await runAttempt(page, url, opts.gestureMs));
      if (errors.length > 0) throw new Error(`page errors: ${errors.join('; ')}`);
    }
    const gpuRenderer = await page.evaluate(() => window.__bench!.gpuRenderer());
    const win = await page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio,
    }));
    const versions = await app.evaluate(() => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    }));
    return {
      browserVersion: `Electron ${versions.electron} (Chromium ${versions.chrome})`,
      mode: `electron window ${win.w}x${win.h} at DPR ${win.dpr}`,
      gpuRenderer,
      attempts,
    };
  } finally {
    await app?.close();
  }
}
