// Export with the real HyperFrames CLI (phase 05 steps 7, 8c; engine "Layer renderer", "Export
// targets"): `.otio` schema-valid through opentimelineio, clips referencing the originals by absolute
// path, scene and caption layers as ProRes 4444 MOVs with alpha in `<name>-layers/`; a moved export
// still resolves every reference. Also `engine.frames()` (compiled stills at canvas size, cached).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import type { JobInfo } from '../../src/jobs.ts';
import { tempDir } from '../helpers/store.ts';
import { REPO, exportEngine, exportProject, type Fixture } from './project.ts';

let fx: Fixture;
beforeAll(async () => {
  fx = await exportProject(exportEngine(), 3000);
}, 120_000);

function otioCheck(path: string): {
  tracks: number;
  clips: { track: number; name: string; targetUrl: string; exists: boolean }[];
} {
  const out = execFileSync('uv', ['run', '--project', join(REPO, 'py'), 'python', '-I', '-m', 'vox_py.timeline'], {
    input: JSON.stringify({ mode: 'check', path }),
    encoding: 'utf8',
    cwd: join(REPO, 'py'),
  });
  return JSON.parse(out) as ReturnType<typeof otioCheck>;
}

function streamInfo(file: string): Record<string, string> {
  const out = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], { encoding: 'utf8' }),
  ) as { streams: Record<string, string>[] };
  return out.streams[0]!;
}

describe('export-timeline (step 7)', () => {
  test('OTIO + layer MOVs with alpha in <name>-layers/, absolute media references', async () => {
    const out = tempDir('vox-otio-');
    const r = (await fx.e.jobs.wait(
      fx.e.jobs.start('exportTimeline', { projectId: fx.projectId, target: { dir: out } }),
    )) as JobInfo<{ path: string; layersDir: string; layers: string[]; clips: number }>;
    expect(r.status, JSON.stringify(r.error)).toBe('done');
    const res = r.result!;
    expect(res.path).toBe(join(out, 'Demo-Main.otio'));
    expect(res.layersDir).toBe(join(out, 'Demo-Main-layers'));
    expect(res.layers).toEqual(expect.arrayContaining(['captions']));
    expect(res.layers.some((l) => l.startsWith('it_'))).toBe(true);
    const movs = readdirSync(res.layersDir).filter((n) => n.endsWith('.mov'));
    expect(movs.length).toBe(res.layers.length);
    for (const m of movs) {
      const s = streamInfo(join(res.layersDir, m));
      expect(s['codec_name']).toBe('prores');
      expect(s['pix_fmt']).toMatch(/yuva444/);
    }
    const chk = otioCheck(res.path);
    expect(chk.clips.length).toBe(res.clips);
    expect(chk.clips.every((c) => c.exists)).toBe(true);
    const media = chk.clips.filter((c) => c.targetUrl.endsWith('m_head.mp4'));
    expect(media.length).toBe(2); // V1 picture + A1 sound, both the original file
    expect(media[0]!.targetUrl).toBe(`file://${join(fx.dir, 'media', 'm_head.mp4')}`);
    // A second export into the same folder never replaces: (2) with its own layers folder.
    const r2 = (await fx.e.jobs.wait(
      fx.e.jobs.start('exportTimeline', { projectId: fx.projectId, target: { dir: out } }),
    )) as JobInfo<{ path: string; layersDir: string }>;
    expect(r2.result?.path).toBe(join(out, 'Demo-Main (2).otio'));
    expect(r2.result?.layersDir).toBe(join(out, 'Demo-Main (2)-layers'));
    expect(otioCheck(r2.result!.path).clips.every((c) => c.exists)).toBe(true);
    expect(readdirSync(out).filter((n) => n.startsWith('.'))).toEqual([]);
  }, 600_000);
});

describe('engine.frames (compiled stills)', () => {
  test('PNG at canvas size per time, cached on the second call', async () => {
    const paths = await fx.e.frames(fx.projectId, 'seq_a', [0, 1000, 2500]);
    expect(paths).toHaveLength(3);
    for (const p of paths) {
      const s = streamInfo(p);
      expect([Number(s['width']), Number(s['height'])]).toEqual([1080, 1920]);
    }
    const mtimes = paths.map((p) => statSync(p).mtimeMs);
    const again = await fx.e.frames(fx.projectId, 'seq_a', [0, 1000, 2500]);
    expect(again).toEqual(paths);
    expect(again.map((p) => statSync(p).mtimeMs)).toEqual(mtimes);
    expect(existsSync(paths[0]!)).toBe(true);
  }, 300_000);
});
