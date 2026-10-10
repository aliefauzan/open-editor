// Render with the real HyperFrames CLI and ffmpeg (phase 05 steps 5, 8c, 8e; engine "Encoding",
// "Export targets"). A 3 s project: picture from a silent HyperFrames render, the engine mix muxed
// with `-c:v copy` + AAC; duration, 1080×1920, an audio stream and 3 non-blank frames; export
// targets (file, folder, overwrite, (2), --all, cancel); loudness presets measured by ebur128.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import type { Engine } from '../../src/api.ts';
import type { JobInfo } from '../../src/jobs.ts';
import { tempDir } from '../helpers/store.ts';
import { exportEngine, exportProject, type Fixture } from './project.ts';

type R = { files: { sequenceId: string; path: string; durationMs: number }[] };

async function run<T = R>(e: Engine, kind: string, args: unknown): Promise<JobInfo<T>> {
  return (await e.jobs.wait(e.jobs.start(kind, args))) as JobInfo<T>;
}

function probe(file: string): { v: Record<string, string>; a?: Record<string, string>; dur: number } {
  const out = JSON.parse(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
      { encoding: 'utf8' },
    ),
  ) as { streams: Record<string, string>[]; format: { duration: string } };
  return {
    v: out.streams.find((s) => s['codec_type'] === 'video')!,
    a: out.streams.find((s) => s['codec_type'] === 'audio'),
    dur: Number(out.format.duration),
  };
}

/** Mean and spread of the luma of one frame at `sec` (64×114 grey). */
function lumaStats(file: string, sec: number): { mean: number; spread: number } {
  const buf = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-ss', String(sec), '-i', file, '-frames:v', '1', '-vf', 'scale=64:114,format=gray', '-f', 'rawvideo', '-'],
    { maxBuffer: 1 << 20 },
  );
  const px = [...buf];
  const mean = px.reduce((a, b) => a + b, 0) / px.length;
  const spread = Math.sqrt(px.reduce((a, b) => a + (b - mean) ** 2, 0) / px.length);
  return { mean, spread };
}

/** Integrated loudness (LUFS) of the first audio stream, from ffmpeg `ebur128`'s summary. */
function loudnessOf(file: string): number {
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 16 << 20 },
  );
  const m = [...(r.stderr ?? '').matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1);
  return m ? Number(m[1]) : Number.NaN;
}

let fx: Fixture;
let first: string;
beforeAll(async () => {
  const e = exportEngine();
  fx = await exportProject(e, 3000);
  const r = await run(e, 'render', { projectId: fx.projectId, quality: 'draft' });
  if (r.status !== 'done') throw new Error(JSON.stringify(r.error));
  first = r.result!.files[0]!.path;
}, 600_000);

describe('render (step 5)', () => {
  test('renders/ by default: 3 s, 1080×1920, AAC audio, 3 non-blank frames', () => {
    expect(first).toBe(join(fx.dir, 'renders', 'Demo-Main.mp4'));
    const p = probe(first);
    expect(Number(p.v['width'])).toBe(1080);
    expect(Number(p.v['height'])).toBe(1920);
    expect(p.v['codec_name']).toBe('h264');
    expect(p.a?.['codec_name']).toBe('aac');
    expect(Number(p.a?.['sample_rate'])).toBe(48000);
    expect(p.dur).toBeGreaterThan(2.9);
    expect(p.dur).toBeLessThan(3.15);
    for (const t of [0.3, 1.2, 2.6]) expect(lumaStats(first, t).spread).toBeGreaterThan(8);
  });

  test('the picture stream is copied from the HyperFrames render (no re-encode of the mux)', () => {
    // A copied stream keeps HyperFrames' encoder tag; the AAC track comes from our mix.
    const p = probe(first);
    expect(p.v['codec_tag_string']).toBe('avc1');
  });
});

describe('export targets on render (step 8c)', () => {
  test('-o file, no replace without overwrite, --out-dir twice gives (2)', async () => {
    const out = tempDir('vox-render-out-');
    const file = join(out, 'a.mp4');
    const a = await run(fx.e, 'render', { projectId: fx.projectId, quality: 'draft', target: { file } });
    expect(a.result?.files[0]?.path).toBe(file);
    const again = await run(fx.e, 'render', { projectId: fx.projectId, quality: 'draft', target: { file } });
    expect(again.error?.code).toBe('EXPORT_PATH');
    const over = await run(fx.e, 'render', {
      projectId: fx.projectId,
      quality: 'draft',
      target: { file },
      overwrite: true,
    });
    expect(over.status).toBe('done');
    const d1 = await run(fx.e, 'render', { projectId: fx.projectId, quality: 'draft', target: { dir: out } });
    const d2 = await run(fx.e, 'render', { projectId: fx.projectId, quality: 'draft', target: { dir: out } });
    expect(d1.result?.files[0]?.path).toBe(join(out, 'Demo-Main.mp4'));
    expect(d2.result?.files[0]?.path).toBe(join(out, 'Demo-Main (2).mp4'));
    expect(readdirSync(out).sort()).toEqual(['Demo-Main (2).mp4', 'Demo-Main.mp4', 'a.mp4']);
  }, 600_000);

  test('missing and read-only folders fail EXPORT_PATH before rendering', async () => {
    const missing = await run(fx.e, 'render', {
      projectId: fx.projectId,
      target: { dir: join(tempDir('vox-x-'), 'nope') },
    });
    expect(missing.error?.code).toBe('EXPORT_PATH');
    const ro = tempDir('vox-ro-');
    chmodSync(ro, 0o500);
    try {
      const r = await run(fx.e, 'render', { projectId: fx.projectId, target: { dir: ro } });
      expect(r.error?.code).toBe('EXPORT_PATH');
    } finally {
      chmodSync(ro, 0o700);
    }
  });

  test('a cancelled render leaves no file in the target folder', async () => {
    const out = tempDir('vox-render-cancel-');
    const id = fx.e.jobs.start('render', { projectId: fx.projectId, quality: 'draft', target: { dir: out } });
    await new Promise<void>((res) => {
      const off = fx.e.on('job.progress', (x) => {
        if (x.jobId === id && (x.message ?? '').includes('rendering picture')) {
          off();
          res();
        }
      });
    });
    await new Promise((r) => setTimeout(r, 1500));
    fx.e.jobs.cancel(id);
    const info = await fx.e.jobs.wait(id);
    expect(info.status).toBe('cancelled');
    expect(readdirSync(out)).toEqual([]);
  }, 600_000);

  test('--all writes one file per sequence into the folder', async () => {
    await fx.e.applyOp(
      fx.projectId,
      { op: 'addSequence', args: { name: 'Second', id: 'seq_b', styleId: 'base' } } as never,
      { actor: 'cli' },
    );
    await fx.e.applyOp(
      fx.projectId,
      {
        op: 'placeClip',
        args: { sequenceId: 'seq_b', trackId: 'V1', mediaId: 'm_head', startMs: 0, inMs: 5000, durationMs: 1000, withAudio: true },
      } as never,
      { actor: 'cli' },
    );
    const out = tempDir('vox-render-all-');
    const r = await run(fx.e, 'render', { projectId: fx.projectId, quality: 'draft', all: true, target: { dir: out } });
    expect(r.status, JSON.stringify(r.error)).toBe('done');
    expect(readdirSync(out).sort()).toEqual(['Demo-Main.mp4', 'Demo-Second.mp4']);
    expect(probe(join(out, 'Demo-Second.mp4')).dur).toBeLessThan(1.2);
  }, 600_000);
});

describe('loudness presets (step 8e)', () => {
  test('youtube, tiktok and broadcast renders measure at their target ±1 LU', async () => {
    const e = exportEngine();
    const long = await exportProject(e, 12000, 'Loud');
    const out = tempDir('vox-render-loud-');
    mkdirSync(out, { recursive: true });
    const measured: Record<string, number> = {};
    for (const [preset, target] of [
      ['youtube', -14],
      ['tiktok', -12],
      ['broadcast', -23],
    ] as const) {
      const r = await run(e, 'render', {
        projectId: long.projectId,
        quality: 'draft',
        loudness: preset,
        captions: 'none',
        target: { file: join(out, `${preset}.mp4`) },
      });
      expect(r.status, JSON.stringify(r.error)).toBe('done');
      measured[preset] = loudnessOf(join(out, `${preset}.mp4`));
      expect(Math.abs(measured[preset]! - target)).toBeLessThanOrEqual(1);
    }
    console.log('loudness', JSON.stringify(measured));
    expect(existsSync(join(out, 'youtube.mp4'))).toBe(true);
  }, 900_000);
});
