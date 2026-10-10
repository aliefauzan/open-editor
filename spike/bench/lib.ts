/** Shared helpers for the spike measurements (phase 01). */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import path from 'node:path';
import { run, runOk } from '../lib/proc.ts';

export const SPIKE = path.join(import.meta.dirname, '..');
export const OUT = path.join(SPIKE, 'out');
export const RENDERS = path.join(OUT, 'renders');

/** `--evidence-dir <dir>` (default spike/out/evidence). */
export function evidenceDir(): string {
  const i = process.argv.indexOf('--evidence-dir');
  const dir = i > 0 ? path.resolve(process.argv[i + 1]!) : path.join(OUT, 'evidence');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeEvidence(name: string, data: unknown): void {
  writeFileSync(path.join(evidenceDir(), name), `${JSON.stringify(data, null, 2)}\n`);
}

/** One JSON line on stdout per measured item. */
export function emit(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/** Load averages (1, 5, 15 min) and core count, recorded with every timing number. */
export function load(): { load: number[]; cores: number } {
  return { load: loadavg().map((x) => Math.round(x * 100) / 100), cores: cpus().length };
}

/**
 * Re-executes the current script under the shared bench lock (`.git/vox-bench.lock`, plan brief) so
 * timings are never taken while another phase measures. No-op when already locked.
 */
export function ensureBenchLock(): void {
  if (process.env.VOX_BENCH_LOCKED === '1') return;
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: SPIKE,
    encoding: 'utf8',
  }).stdout.trim();
  if (!common) return;
  const lock = path.join(common, 'vox-bench.lock');
  const r = spawnSync(
    'lockf',
    ['-t', '1800', lock, process.execPath, ...process.execArgv, ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, VOX_BENCH_LOCKED: '1' } },
  );
  process.exit(r.status ?? 1);
}

/** Sum of RSS (bytes) of `root` and all its descendants, from `ps`. */
export async function treeRss(root: number): Promise<number> {
  const r = await run('ps', ['-A', '-o', 'pid=,ppid=,rss=']);
  const kids = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const line of r.stdout.toString().split('\n')) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined || kb === undefined) continue;
    rss.set(pid, kb * 1024);
    const k = kids.get(ppid) ?? [];
    k.push(pid);
    kids.set(ppid, k);
  }
  let sum = 0;
  const stack = [root];
  while (stack.length) {
    const p = stack.pop()!;
    sum += rss.get(p) ?? 0;
    stack.push(...(kids.get(p) ?? []));
  }
  return sum;
}

/** Raw gray bytes of `crop` (x, y, w, h) scaled to `sw`x`sh` for every frame of a video. */
export async function grayStream(
  file: string,
  crop: readonly [number, number, number, number],
  sw: number,
  sh: number,
): Promise<Buffer> {
  const [x, y, w, h] = crop;
  const r = await runOk('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-i',
    file,
    '-vf',
    `crop=${w}:${h}:${x}:${y},scale=${sw}:${sh}:flags=area,format=gray`,
    '-f',
    'rawvideo',
    '-',
  ]);
  return r.stdout;
}

/** Mono float32 PCM of the first audio stream. */
export async function pcm(file: string, rate = 48000): Promise<Float32Array> {
  const r = await runOk('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-i',
    file,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(rate),
    '-f',
    'f32le',
    '-',
  ]);
  const b = r.stdout;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
}

export async function probeFrames(file: string): Promise<{ frames: number; rate: string }> {
  const r = await runOk('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-count_packets',
    '-show_entries',
    'stream=nb_read_packets,r_frame_rate',
    '-of',
    'json',
    file,
  ]);
  const s = (
    JSON.parse(r.stdout.toString()) as {
      streams: { nb_read_packets: string; r_frame_rate: string }[];
    }
  ).streams[0]!;
  return { frames: Number(s.nb_read_packets), rate: s.r_frame_rate };
}

/** Path relative to the spike folder, for evidence (no personal paths). */
export const rel = (p: string): string => path.relative(SPIKE, p) || '.';
