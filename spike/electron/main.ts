/**
 * Phase 01 spike window (items 4, 6, 7-preview): the app's exact security setup with the
 * HyperFrames player.
 *
 * - renderer page on `vox-app://app/` (CSP_APP), build on `vox-media://build/` (CSP_MEDIA, range
 *   requests, engine path rule), player with `sandbox-origin="opaque"` (or `--mode same-origin`);
 * - contextIsolation, sandbox, no node integration, webSecurity, no preload; navigation, new
 *   windows and permission requests denied; every http(s)/ws(s) request from renderers blocked and
 *   recorded (catches CDN runtime injection);
 * - the runtime and GSAP are vendored in the build; nothing is fetched from the network.
 *
 * Run by bench/preview.ts:
 *   electron electron/main.ts --out result.json [--mode opaque|same-origin] [--tests play,seek,...]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BrowserWindow, app, protocol, screen, session, type WebFrameMain } from 'electron';
import { CSP_APP, CSP_MEDIA, fileResponse, resolveInside, textResponse } from './protocol.ts';
import { prepareMedia } from '../make-project.ts';
import type { MediaSet } from '../lib/compile.ts';
import { runTests, type Harness } from './tests.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : def;
};

const HERE = import.meta.dirname;
const SPIKE = path.join(HERE, '..');
const PAGE_DIR = path.join(HERE, 'page');
const PLAYER_JS = path.join(
  path.dirname(createRequire(import.meta.url).resolve('@hyperframes/player')),
  'hyperframes-player.global.js',
);
const PROBES_JS = readFileSync(path.join(HERE, 'probes.js'), 'utf8');

const mode = arg('--mode', 'opaque') === 'same-origin' ? 'same-origin' : 'opaque';
const buildRoot = path.resolve(arg('--build', path.join(SPIKE, 'out', 'preview')));
const outFile = path.resolve(arg('--out', path.join(SPIKE, 'out', 'preview-result.json')));
const tests = arg('--tests', 'play,seek,seekedge,avseek,mech,patch,reload').split(',');

protocol.registerSchemesAsPrivileged([
  { scheme: 'vox-app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  {
    scheme: 'vox-media',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: false,
    },
  },
]);

/** In-memory build files (reload path): URL path → content; served before the files on disk. */
const overrides = new Map<string, string>();
const blocked: string[] = [];
const consoleLog: { level: string; message: string; url: string }[] = [];
const notFound: string[] = [];

function notFoundResponse(url: string): Response {
  notFound.push(url);
  return new Response('not found', {
    status: 404,
    headers: { 'X-Content-Type-Options': 'nosniff' },
  });
}

async function main(): Promise<void> {
  await app.whenReady();
  const ses = session.fromPartition('vox-spike');
  ses.protocol.handle('vox-app', (req) => {
    const u = new URL(req.url);
    if (u.host !== 'app') return notFoundResponse(req.url);
    if (u.pathname === '/player.js') return fileResponse(PLAYER_JS, req, null);
    const file = resolveInside(PAGE_DIR, u.pathname);
    return file ? fileResponse(file, req, CSP_APP) : notFoundResponse(req.url);
  });
  ses.protocol.handle('vox-media', (req) => {
    const u = new URL(req.url);
    if (u.host !== 'build') return notFoundResponse(req.url);
    const ov = overrides.get(u.pathname);
    if (ov !== undefined) return textResponse(u.pathname, ov, CSP_MEDIA);
    const file = resolveInside(buildRoot, u.pathname);
    return file ? fileResponse(file, req, CSP_MEDIA) : notFoundResponse(req.url);
  });
  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (d, cb) => {
      blocked.push(d.url);
      cb({ cancel: true });
    },
  );
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);

  // Player box: 9:16, as large as 540x960 CSS px allows on this display.
  const work = screen.getPrimaryDisplay().workAreaSize;
  const h = Math.min(960, Math.floor((work.height - 64) / 16) * 16);
  const w = (h / 16) * 9;
  const TRANSPORT_H = 24; // page.js transport bar below the player (not captured)
  const win = new BrowserWindow({
    width: w,
    height: h + TRANSPORT_H,
    useContentSize: true,
    resizable: false,
    show: true,
    backgroundColor: '#000000',
    webPreferences: {
      session: ses,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      backgroundThrottling: false,
      // The spike plays without a click; the app starts playback from a user gesture.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', (e) => {
    const d = e as unknown as {
      level?: string | number;
      message?: string;
      frame?: WebFrameMain | null;
    };
    consoleLog.push({
      level: String(d.level ?? ''),
      message: String(d.message ?? ''),
      url: d.frame?.url ?? '',
    });
  });

  const pageUrl = `vox-app://app/index.html?mode=${mode}&w=${w}&h=${h}`;
  await win.loadURL(pageUrl);

  const page = <T = unknown>(code: string): Promise<T> =>
    win.webContents.executeJavaScript(code, true) as Promise<T>;
  const frame = (): WebFrameMain => {
    const f = win.webContents.mainFrame.framesInSubtree.find((x) =>
      x.url.startsWith('vox-media://'),
    );
    if (!f) throw new Error('composition frame not found');
    return f;
  };
  const inFrame = async <T = unknown>(code: string): Promise<T> => {
    const f = frame();
    const has = (await f.executeJavaScript('typeof window.__voxProbe', true)) as string;
    if (has !== 'object') await f.executeJavaScript(PROBES_JS, true);
    return (await f.executeJavaScript(code, true)) as T;
  };
  let mediaSet: Promise<MediaSet> | undefined;
  const harness: Harness = {
    mode,
    box: { w, h },
    page,
    inFrame,
    capture: async () => {
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
      const size = img.getSize();
      const buf = img.toBitmap();
      const sf = Math.round(Math.sqrt(buf.length / 4 / (size.width * size.height)));
      return {
        buf,
        width: size.width * sf,
        height: size.height * sf,
        jpeg: (q = 70) => img.toJPEG(q),
      };
    },
    overrides,
    blockedCount: () => blocked.length,
    media: () => (mediaSet ??= prepareMedia()),
  };

  let results: Record<string, unknown> = {};
  let error: string | null = null;
  try {
    const ready = await page<{ at: number }>(`voxPage.waitFor('ready', 0, 30000)`);
    results.readyAtPageMs = Math.round(ready.at);
    results = { ...results, ...(await runTests(harness, tests)) };
  } catch (e) {
    error = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  }
  const playerEvents = await page('voxPage.events').catch(() => null);
  writeFileSync(
    outFile,
    `${JSON.stringify(
      {
        mode,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        box: { w, h, scaleFactor: screen.getPrimaryDisplay().scaleFactor },
        error,
        results,
        blocked,
        notFound,
        playerEvents,
        console: consoleLog
          .filter((c) => c.level !== 'info' && c.level !== '0' && c.level !== 'verbose')
          .slice(0, 200),
      },
      null,
      2,
    )}\n`,
  );
  app.exit(error ? 1 : 0);
}

app.on('window-all-closed', () => app.quit());
main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  app.exit(2);
});
