// The built `.app` / `.dmg` (`pnpm dist`) for the packaging and clean-install tests (plan phase 09
// steps 5 and 9). The packaged app has the Node inspect fuse off (S27), so Playwright's Electron
// driver cannot attach; it is started with Chromium's remote debugging port and driven over CDP.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import {
  componentBinaryPath,
  componentState,
  installComponent,
} from '../../src/engine-host/setup/install.ts';
import { loadManifest } from '../../src/engine-host/setup/manifest.ts';
import { sourceHashOf, syncArgs, syncEnv } from '../../src/engine-host/setup/pyenv.ts';
import { DESKTOP, REPO } from './app.ts';

export const DIST = join(DESKTOP, 'dist');
export const APP = join(DIST, 'mac-arm64', 'Vox Studio.app');
/** Phase 09 by default; a rerun at a later gate passes its own folder (10b: GATE 5). */
export const EVIDENCE =
  process.env['VOX_EVIDENCE_DIR'] ?? join(REPO, 'docs', 'evidence', 'phase-09');
/** Pinned components downloaded once (hash-checked) and cloned into each test's tools folder. */
const CACHE_TOOLS = join(DESKTOP, 'cache', 'tools');

export function builtDmg(): string {
  const dmg = existsSync(DIST)
    ? readdirSync(DIST).find((f) => /^Vox-Studio-.*-arm64\.dmg$/.test(f))
    : undefined;
  if (dmg === undefined) throw new Error('no .dmg in apps/desktop/dist: run `pnpm dist` first');
  return join(DIST, dmg);
}

export function appBinary(app: string): string {
  return join(app, 'Contents', 'MacOS', 'Vox Studio');
}

/** SHA-256 of every file (and link target) in a bundle, by relative path. */
export function hashTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out.set(r, `link:${readlinkSync(p)}`);
      else if (st.isDirectory()) walk(p, r);
      else out.set(r, createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(root, '');
  return out;
}

/** A fake Homebrew whose `brew --prefix ffmpeg` points at the real ffmpeg (D-05 detection path). */
export function fakeBrew(dir: string): string {
  const real = ['/opt/homebrew/bin', '/usr/local/bin'].find((d) => existsSync(join(d, 'ffmpeg')));
  if (real === undefined)
    throw new Error('the clean-install test needs a real ffmpeg (brew install ffmpeg)');
  const prefix = join(dir, 'ffmpeg-prefix');
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  for (const t of ['ffmpeg', 'ffprobe']) symlinkSync(join(real, t), join(prefix, 'bin', t));
  const bin = join(dir, 'brew-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'brew'),
    `#!/bin/sh\n[ "$1" = --prefix ] && [ "$2" = ffmpeg ] && { echo '${prefix}'; exit 0; }\nexit 1\n`,
    { mode: 0o755 },
  );
  return bin;
}

/**
 * Fixture components for a temp tools folder: uv, deno and yt-dlp are the pinned downloads (the
 * same hash-checked installer, cached once), the Python env is a real `uv sync` from the warm uv
 * cache with the lock hash setup writes, and Chrome is the managed headless shell from the user's
 * puppeteer cache (linked into the temp HOME).
 */
export async function seedTools(o: {
  toolsDir: string;
  home: string;
  pyDir: string;
}): Promise<void> {
  const manifest = loadManifest();
  for (const id of ['uv', 'deno', 'yt-dlp']) {
    const c = manifest.components.find((x) => x.id === id);
    if (c === undefined || (c.kind !== 'archive' && c.kind !== 'binary')) throw new Error(id);
    if ((await componentState(CACHE_TOOLS, c)) !== 'ready')
      await installComponent(c, { toolsDir: CACHE_TOOLS, signal: AbortSignal.timeout(900_000) });
    cpSync(join(CACHE_TOOLS, id), join(o.toolsDir, id), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  const uv = manifest.components.find((x) => x.id === 'uv');
  const uvBin = uv?.kind === 'archive' ? join(o.toolsDir, 'uv', uv.version, uv.binary) : '';
  const env: NodeJS.ProcessEnv = {
    ...syncEnv(o.toolsDir),
    UV_CACHE_DIR: process.env['UV_CACHE_DIR'] ?? join(homedir(), '.cache', 'uv'),
  };
  delete env['UV_PYTHON_INSTALL_DIR'];
  execFileSync(uvBin, [...syncArgs(o.pyDir), '--quiet'], { env, stdio: 'inherit' });
  // first runs of fresh binaries are slow on macOS (security scan, PyInstaller unpack): warm them
  for (const id of ['deno', 'yt-dlp']) {
    const c = manifest.components.find((x) => x.id === id);
    if (c?.kind === 'archive' || c?.kind === 'binary')
      execFileSync(componentBinaryPath(o.toolsDir, c), ['--version'], { stdio: 'ignore' });
  }
  const lock = createHash('sha256')
    .update(readFileSync(join(o.pyDir, 'uv.lock')))
    .digest('hex');
  writeFileSync(join(o.toolsDir, 'py-env', '.vox-lock-hash'), `${lock}\n`);
  writeFileSync(join(o.toolsDir, 'py-env', '.vox-src-hash'), `${await sourceHashOf(o.pyDir)}\n`);
  linkPuppeteerCache(o.home);
}

export function linkPuppeteerCache(home: string): void {
  const real = join(homedir(), '.cache', 'puppeteer');
  if (!existsSync(real)) throw new Error('no managed chrome-headless-shell in ~/.cache/puppeteer');
  mkdirSync(join(home, '.cache'), { recursive: true });
  symlinkSync(real, join(home, '.cache', 'puppeteer'));
}

export interface PackagedApp {
  proc: ChildProcess;
  browser: Browser;
  page: Page;
  stderr: () => string;
  close(): Promise<void>;
}

/** Starts the packaged app with a temp user-data folder and connects over CDP. */
export async function launchPackaged(
  app: string,
  o: { env: NodeJS.ProcessEnv; userData: string },
): Promise<PackagedApp> {
  const proc = spawn(
    appBinary(app),
    ['--remote-debugging-port=0', `--user-data-dir=${o.userData}`],
    { env: o.env, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  // a timed-out test must not leave the app running (it would hold the temp folders)
  const reap = () => proc.kill('SIGKILL');
  process.once('exit', reap);
  proc.once('exit', () => process.off('exit', reap));
  let err = '';
  const ws = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no DevTools endpoint:\n${err}`)), 60_000);
    proc.stderr!.on('data', (d: Buffer) => {
      err += d.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) {
        clearTimeout(t);
        resolve(m[1]!);
      }
    });
    proc.once('exit', (code) => reject(new Error(`app exited (${String(code)}):\n${err}`)));
  });
  const browser = await chromium.connectOverCDP(ws);
  const ctx = browser.contexts()[0]!;
  const page =
    ctx.pages().find((p) => p.url().startsWith('vox-app:')) ??
    (await ctx.waitForEvent('page', { timeout: 30_000 }));
  await page.waitForLoadState('domcontentloaded');
  return {
    proc,
    browser,
    page,
    stderr: () => err,
    async close() {
      await browser.close().catch(() => undefined);
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.once('exit', r));
        proc.kill('SIGTERM');
        await exited;
      }
    },
  };
}
