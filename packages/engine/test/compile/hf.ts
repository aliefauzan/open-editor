// Slow-test helpers: the pinned HyperFrames CLI, generated media, ffprobe, headless Chrome.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { BuildResult } from '../../src/compile/compile.ts';
import { writeBuildTo } from '../../src/compile/write.ts';

const req = createRequire(import.meta.url);
export const HF_DIR = dirname(req.resolve('hyperframes/package.json'));
export const HF_BIN = join(HF_DIR, 'bin', 'hyperframes.mjs');
export const hfEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  HYPERFRAMES_NO_TELEMETRY: '1',
  DO_NOT_TRACK: '1',
  NO_COLOR: '1',
});

export function hf(
  args: string[],
  timeoutMs = 300_000,
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [HF_BIN, ...args], {
    env: hfEnv(),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export interface LintFinding {
  severity?: string;
  level?: string;
  code?: string;
  rule?: string;
  message?: string;
}

/** `hyperframes lint --json` findings with error severity. */
export function lintErrors(dir: string): { errors: LintFinding[]; raw: string } {
  const r = hf(['lint', dir, '--json']);
  const start = r.stdout.indexOf('{');
  const parsed = JSON.parse(r.stdout.slice(start)) as Record<string, unknown>;
  const list = (parsed['findings'] ?? parsed['issues'] ?? parsed['results'] ?? []) as LintFinding[];
  const errors = list.filter((f) => (f.severity ?? f.level) === 'error');
  return { errors, raw: r.stdout.slice(0, 4000) };
}

export function render(dir: string, out: string, fps = '30'): { ok: boolean; log: string } {
  mkdirSync(dirname(out), { recursive: true });
  const r = hf(
    [
      'render',
      dir,
      '-o',
      out,
      '--quality',
      'draft',
      '--fps',
      fps,
      '--strict-all',
      '--frames-cache-dir',
      'off',
    ],
    900_000,
  );
  return { ok: r.code === 0, log: (r.stderr + r.stdout).slice(-3000) };
}

export function frameCount(file: string): number {
  const out = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-count_frames',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=nb_read_frames',
      '-of',
      'csv=p=0',
      file,
    ],
    { encoding: 'utf8' },
  );
  return Number(out.trim());
}

/** Mean luma (0–255) of frame `n` (0-based) of a video. */
export function meanLuma(file: string, n: number): number {
  const buf = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `select=eq(n\\,${n}),scale=64:64,format=gray`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-',
    ],
    { maxBuffer: 1 << 20 },
  );
  let s = 0;
  for (const b of buf) s += b;
  return buf.length ? s / buf.length : 0;
}

/** Test media in `<projectDir>/media/`: a 1080p30 video with a tone, and a portrait JPEG. */
export function makeMedia(projectDir: string, seconds = 6): void {
  mkdirSync(join(projectDir, 'media'), { recursive: true });
  const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
  ff([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1920x1080:rate=30:duration=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${seconds}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '15',
    '-c:a',
    'aac',
    '-shortest',
    join(projectDir, 'media', 'm_a.mp4'),
  ]);
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=1200x1600:rate=1:duration=1',
    '-frames:v',
    '1',
    join(projectDir, 'media', 'm_img.jpg'),
  ]);
}

export function writeBuild(b: BuildResult, dir: string): string {
  return writeBuildTo(b, dir);
}

/** Executable of the Chrome HyperFrames renders with (`hyperframes browser path`). */
export function chromePath(): string {
  const r = hf(['browser', 'path']);
  const line = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('/'))
    .pop();
  if (!line) throw new Error(`no Chrome: ${r.stderr.slice(0, 500)}`);
  return line;
}

export interface Page {
  setViewport(v: { width: number; height: number }): Promise<void>;
  goto(url: string, o?: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(fn: string): Promise<T>;
  screenshot(o?: Record<string, unknown>): Promise<Uint8Array>;
}
export interface Browser {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
/** puppeteer-core as HyperFrames pins it (not an engine dependency). */
export const puppeteer = (): { launch(o: Record<string, unknown>): Promise<Browser> } =>
  createRequire(join(HF_DIR, 'package.json'))('puppeteer-core') as {
    launch(o: Record<string, unknown>): Promise<Browser>;
  };

export function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
