// DOM checks for `vox style validate` (phase 06 steps 4, 5b, 5c): a compiled instance (render-mode
// scene file) is mounted in a harness page in the Chrome that HyperFrames renders with, its timeline
// is seeked like the renderer seeks it, and text boxes, element states and pixels are read.
import { spawnSync } from 'node:child_process';
import { createReadStream, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, extname, join, sep } from 'node:path';
import { templateInner } from '../compile/compile.ts';
import { hyperframesBin } from '../render/layers.ts';
import { moduleRequire } from '../resources.ts';
import type { CaptionChunk, CaptionWord } from '../model/captions.ts';

export interface Box {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ElementState {
  /** Index path from the instance root, e.g. `0/2/1`. */
  path: string;
  opacity: number;
  transform: string;
}

export interface WordLook {
  text: string;
  box: Box;
  /** Computed look without position: colours, weight, size, decoration, opacity, transform. */
  sig: string;
}

export interface HarnessPage {
  seek(ms: number): Promise<void>;
  textBoxes(): Promise<Box[]>;
  states(): Promise<ElementState[]>;
  word(key: string): Promise<WordLook | null>;
  screenshot(clip?: Box): Promise<Buffer>;
  errors: string[];
  close(): Promise<void>;
}

interface PptrPage {
  setViewport(v: { width: number; height: number }): Promise<void>;
  goto(url: string, o?: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(fn: string): Promise<T>;
  screenshot(o?: Record<string, unknown>): Promise<Uint8Array>;
  on(event: 'pageerror', fn: (e: Error) => void): void;
  on(event: 'request', fn: (r: PptrRequest) => void): void;
  setRequestInterception(on: boolean): Promise<void>;
  close(): Promise<void>;
}
interface PptrRequest {
  url(): string;
  continue(): Promise<void>;
  abort(): Promise<void>;
}
interface PptrBrowser {
  newPage(): Promise<PptrPage>;
  close(): Promise<void>;
}

const word = (n: number, text: string, startMs: number, endMs: number, emphasis = false) =>
  ({ key: `m_a:r1:${n}`, text, startMs, endMs, emphasis }) satisfies CaptionWord;

/**
 * The fixture `CaptionChunk[]` (styles spec "Testing", D-15): chunk 1 has two lines ("One two three",
 * word 2 at 400–800 ms; "again now" with the emphasis word), a 200 ms gap, then a one-line chunk with
 * punctuation for the `case`/`stripPunctuation` check.
 */
export const FIXTURE_CHUNKS: CaptionChunk[] = [
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

/** Executable of the Chrome HyperFrames renders with (`hyperframes browser path`). */
export function chromePath(): string {
  const r = spawnSync(process.execPath, [hyperframesBin(), 'browser', 'path'], {
    encoding: 'utf8',
    env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', NO_COLOR: '1' },
    timeout: 300_000,
  });
  const line = (r.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('/'))
    .pop();
  if (!line) throw new Error(`no Chrome from hyperframes: ${(r.stderr ?? '').slice(0, 300)}`);
  return line;
}

/** puppeteer-core as HyperFrames pins it (not an engine dependency of its own). */
export async function launchChrome(): Promise<PptrBrowser> {
  const hf = moduleRequire().resolve('hyperframes/package.json');
  const pptr = createRequire(hf)('puppeteer-core') as {
    launch(o: Record<string, unknown>): Promise<PptrBrowser>;
  };
  return pptr.launch({
    executablePath: chromePath(),
    headless: true,
    // No popups: a new window would skip the request filter of `openHarness` (R4 S8).
    args: ['--block-new-web-contents', '--font-render-hinting=none'],
  });
}

/** The `@font-face` rules of a build's `index.html`, rebased for a page in `scenes/`. */
export function fontFaces(indexHtml: string): string {
  return (indexHtml.match(/@font-face \{[^}]*\}/g) ?? [])
    .map((f) => f.replace(/url\("(?!\.\.\/)/g, 'url("../'))
    .join('\n');
}

const SIG_PROPS = [
  'color',
  'background-color',
  'font-weight',
  'font-size',
  'font-style',
  'text-decoration-line',
  'text-transform',
  'opacity',
  'transform',
  'text-shadow',
  '-webkit-text-stroke-width',
  'border-top-color',
  'outline-color',
  'box-shadow',
  'filter',
];

/**
 * Writes `scenes/<id>.check.html` (the instance in a W×H host over `bg`) and opens it. `vars`
 * replaces the instance variables (captions get the fixture chunks).
 */
export async function openHarness(
  browser: PptrBrowser,
  buildDir: string,
  id: string,
  size: { width: number; height: number },
  o: { vars?: unknown; bg?: string } = {},
): Promise<HarnessPage> {
  const scene = join(buildDir, 'scenes', `${id}.html`);
  let inner = templateInner(scene);
  if (o.vars !== undefined) {
    const json = JSON.stringify(o.vars).replace(/</g, '\\u003c');
    const marker = `data-vox-instance="${id}">`;
    const a = inner.indexOf(marker);
    const b = inner.indexOf('</script>', a);
    if (a < 0 || b < 0) throw new Error(`instance ${id} has no variables block`);
    inner = inner.slice(0, a + marker.length) + json + inner.slice(b);
  }
  const index = readFileSync(join(buildDir, 'index.html'), 'utf8');
  const file = join(dirname(scene), `${id}.check.html`);
  writeFileSync(
    file,
    `<!doctype html>
<html><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="connect-src 'none'; frame-src 'none'; form-action 'none'" />
<script>window.__timelines = window.__timelines || {};</script>
<script src="../vendor/gsap.min.js"></script>
<script src="../vendor/vox-runtime.js"></script>
<style>
${fontFaces(index)}
html, body { margin: 0; background: ${o.bg ?? '#000000'}; }
#vox-host { position: relative; width: ${size.width}px; height: ${size.height}px; overflow: hidden; }
</style></head>
<body><div id="vox-host">${inner}</div></body></html>`,
  );
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e).slice(0, 300)));
  // The style may be untrusted (R4 S8): like the app's player (S13, S14) the page gets no network
  // and no file outside the build folder. The folder is served on loopback (a file:// page with file
  // access on can read any file) and every other request is aborted.
  const srv = await serveDir(buildDir);
  const allowed = (url: string) =>
    url.startsWith(`${srv.origin}/`) || /^(data|blob|about):/.test(url);
  await page.setRequestInterception(true);
  page.on('request', (r) => void (allowed(r.url()) ? r.continue() : r.abort()));
  await page.setViewport(size);
  await page.goto(`${srv.origin}/scenes/${encodeURIComponent(`${id}.check.html`)}`, {
    waitUntil: 'load',
  });
  await page.evaluate(
    `Promise.all([...document.fonts].map((f) => f.load().catch(() => null))).then(() => document.fonts.ready).then(() => true)`,
  );
  const tl = `window.__timelines[${JSON.stringify(id)}]`;
  return {
    errors,
    async seek(ms) {
      const ok = await page.evaluate<boolean>(
        `(() => { const t = ${tl}; if (!t) return false; t.seek(${ms / 1000}, false); return true; })()`,
      );
      if (!ok) throw new Error(`instance ${id} registered no timeline`);
    },
    textBoxes: () =>
      page.evaluate<Box[]>(`(() => {
        const host = document.getElementById('vox-host');
        const out = [];
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const n = walker.currentNode;
          if (!n.textContent.trim()) continue;
          const el = n.parentElement;
          if (!el || el.closest('script,style,template')) continue;
          // visibility is inherited and a child can set it back to visible: only the text's own
          // element's computed value counts; display and opacity apply from every ancestor
          let op = getComputedStyle(el).visibility === 'visible' ? 1 : 0;
          for (let e = el; op > 0 && e && e !== host.parentElement; e = e.parentElement) {
            const cs = getComputedStyle(e);
            if (cs.display === 'none') { op = 0; break; }
            op *= parseFloat(cs.opacity);
          }
          if (op < 0.01) continue;
          const r = document.createRange();
          r.selectNodeContents(n);
          for (const b of r.getClientRects()) {
            if (b.width < 1 || b.height < 1) continue;
            out.push({ text: n.textContent.trim().slice(0, 40), left: b.left, top: b.top, right: b.right, bottom: b.bottom });
          }
        }
        return out;
      })()`),
    states: () =>
      page.evaluate<ElementState[]>(`(() => {
        const host = document.getElementById('vox-host');
        const out = [];
        const walk = (el, path) => {
          [...el.children].forEach((c, i) => {
            if (/^(SCRIPT|STYLE|TEMPLATE)$/.test(c.tagName)) return;
            const p = path === '' ? String(i) : path + '/' + i;
            const cs = getComputedStyle(c);
            out.push({ path: p, opacity: parseFloat(cs.opacity), transform: cs.transform });
            walk(c, p);
          });
        };
        walk(host, '');
        return out;
      })()`),
    word: (key) =>
      page.evaluate<WordLook | null>(`(() => {
        const k = ${JSON.stringify(key)};
        const el = document.querySelector('[data-key="' + CSS.escape(k) + '"]');
        if (!el) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        let op = 1;
        for (let e = el; e; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity);
        const sig = ${JSON.stringify(SIG_PROPS)}.map((p) => p + ':' + cs.getPropertyValue(p)).join(';') + ';effective-opacity:' + op.toFixed(3);
        return { text: el.textContent.trim(), sig, box: { text: el.textContent.trim(), left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
      })()`),
    async screenshot(clip) {
      const c = clip
        ? {
            x: Math.max(0, Math.floor(clip.left) - 4),
            y: Math.max(0, Math.floor(clip.top) - 4),
            width: Math.ceil(clip.right - clip.left) + 8,
            height: Math.ceil(clip.bottom - clip.top) + 8,
          }
        : undefined;
      return Buffer.from(await page.screenshot({ type: 'png', ...(c ? { clip: c } : {}) }));
    },
    async close() {
      await page.close();
      await srv.close();
    },
  };
}

/** Parsed `matrix(...)`/`matrix3d(...)`/`none` as [a, b, c, d, tx, ty]. */
export function matrixOf(t: string): [number, number, number, number, number, number] {
  if (!t || t === 'none') return [1, 0, 0, 1, 0, 0];
  const n = (t.match(/-?[\d.]+(?:e-?\d+)?/g) ?? []).map(Number);
  if (t.startsWith('matrix3d') && n.length >= 16) {
    const m = n.slice(-16);
    return [m[0]!, m[1]!, m[4]!, m[5]!, m[12]!, m[13]!];
  }
  const m = n.slice(-6);
  return [m[0] ?? 1, m[1] ?? 0, m[2] ?? 0, m[3] ?? 1, m[4] ?? 0, m[5] ?? 0];
}

/** Same resting look: opacity within 0.01; scale/rotation within 0.01; translation within `px`. */
export function sameState(a: ElementState, b: ElementState, px: number): boolean {
  if (Math.abs(a.opacity - b.opacity) > 0.01) return false;
  const ma = matrixOf(a.transform);
  const mb = matrixOf(b.transform);
  for (let i = 0; i < 4; i++) if (Math.abs(ma[i]! - mb[i]!) > 0.01) return false;
  return Math.abs(ma[4] - mb[4]) <= px && Math.abs(ma[5] - mb[5]) <= px;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/** Serves the files inside `dir` (symlinks resolved) on 127.0.0.1, GET only. */
async function serveDir(dir: string): Promise<{ origin: string; close(): Promise<void> }> {
  const root = realpathSync(dir);
  const server = createServer((req, res) => {
    let p = '';
    try {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://h').pathname);
      p = realpathSync(join(root, path));
    } catch {
      // missing or malformed: 404 below
    }
    if (req.method !== 'GET' || !p.startsWith(root + sep) || !statSync(p).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(p).toLowerCase()] ?? 'application/octet-stream',
    });
    createReadStream(p).pipe(res);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
