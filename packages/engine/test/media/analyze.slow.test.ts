// Ingest analysis on the make.sh fixtures (D-15; slow tier, needs
// `bash packages/engine/test/fixtures/make.sh`): VFR detection and CFR copy on phone-vfr-20s.mp4,
// 30000/1001 on ntsc-2997-20s.mp4, and a real 540p proxy with a keyframe every 0.5 s.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { analyzeMedia, ptsDeltaSpread, readVideoPts } from '../../src/stages/media/analyze.ts';
import { cfrCopyArgs, proxyArgs } from '../../src/stages/media/proxy.ts';
import { runTool } from '../../src/stages/media/run.ts';
import { sniffFile, type SniffedMedia } from '../../src/stages/media/sniff.ts';
import { fixture, removeDir, tempDir } from './helpers.ts';

const VFR = fixture('out/phone-vfr-20s.mp4');
const NTSC = fixture('out/ntsc-2997-20s.mp4');
const r = (num: number, den = 1) => ({ num, den });

let dir = '';
beforeAll(() => {
  if (!existsSync(VFR) || !existsSync(NTSC)) {
    throw new Error(
      'Run `bash packages/engine/test/fixtures/make.sh` first (fixtures/out is generated).',
    );
  }
  dir = tempDir('vox-analyze-slow-');
});
afterAll(() => removeDir(dir));

const analyze = async (p: string, cfrRates: 'all' | 'integer' = 'all') =>
  analyzeMedia(p, (await sniffFile(p)) as SniffedMedia, { cfrRates });

describe('phone-vfr-20s.mp4', () => {
  test('is VFR and needs a CFR copy at 30000/1001 (30/1 under the integer fallback)', async () => {
    const a = await analyze(VFR);
    expect(a).toMatchObject({
      kind: 'video',
      vfr: true,
      fps: r(30000, 1001),
      cfr: { fps: r(30000, 1001), reason: 'vfr' },
    });
    expect(a.loudness).toBeDefined();
    expect((await analyze(VFR, 'integer')).cfr).toEqual({ fps: r(30), reason: 'vfr' });
  });

  test('the CFR copy has constant pts deltas, the planned rate and the audio; its proxy is 540 wide', async () => {
    const a = await analyze(VFR);
    const cfr = join(dir, 'm_vfr.cfr.mp4');
    await runTool(
      'ffmpeg',
      cfrCopyArgs({ input: VFR, format: 'mov', output: cfr, fps: a.cfr?.fps ?? r(30) }),
    );
    const b = await analyze(cfr);
    expect(b).toMatchObject({
      vfr: false,
      fps: r(30000, 1001),
      cfr: undefined,
      hasAudio: true,
      width: 1080,
      height: 1920,
    });
    const spread = ptsDeltaSpread(await readVideoPts(cfr, 'mov'));
    expect(spread).toBeLessThan(0.0005);
    expect(Math.abs((b.durationMs ?? 0) - (a.durationMs ?? 0))).toBeLessThan(100);

    const proxy = join(dir, 'm_vfr.proxy.mp4');
    await runTool(
      'ffmpeg',
      proxyArgs({ input: cfr, format: 'mov', output: proxy, fps: b.fps ?? r(30) }),
    );
    const p = await runTool('ffprobe', ['-v', 'error', '-of', 'json', '-show_streams', proxy]);
    const streams = JSON.parse(p.stdout).streams as {
      codec_type: string;
      width: number;
      height: number;
    }[];
    expect(streams.map((s) => s.codec_type)).toEqual(['video']);
    expect(streams[0]).toMatchObject({ width: 540, height: 960 });
  });
});

describe('ntsc-2997-20s.mp4', () => {
  test('stores fps 30000/1001, not VFR, no copy', async () => {
    expect(await analyze(NTSC)).toMatchObject({
      kind: 'video',
      vfr: false,
      fps: r(30000, 1001),
      cfr: undefined,
    });
  });
  test('integer fallback: CFR copy at 30/1', async () => {
    expect((await analyze(NTSC, 'integer')).cfr).toEqual({ fps: r(30), reason: 'integer-rate' });
  });
});

describe('proxy of the seed media', () => {
  test('960×540 H.264, a keyframe every 15 frames (0.5 s at 30 fps), no audio', async () => {
    const out = join(dir, 'm_th.proxy.mp4');
    await runTool(
      'ffmpeg',
      proxyArgs({
        input: fixture('assets/media/talking-head-20s.mp4'),
        format: 'mov',
        output: out,
        fps: r(30),
      }),
    );
    const s = await runTool('ffprobe', ['-v', 'error', '-of', 'json', '-show_streams', out]);
    const streams = JSON.parse(s.stdout).streams as {
      codec_type: string;
      codec_name: string;
      width: number;
      height: number;
    }[];
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      codec_type: 'video',
      codec_name: 'h264',
      width: 960,
      height: 540,
    });
    const k = await runTool('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'packet=pts_time,flags',
      '-of',
      'csv=p=0',
      out,
    ]);
    const keys = k.stdout
      .trim()
      .split('\n')
      .filter((l) => l.split(',')[1]?.startsWith('K'))
      .map((l) => Number(l.split(',')[0]))
      .sort((a, b) => a - b);
    expect(keys.length).toBe(40);
    for (let i = 1; i < keys.length; i++)
      expect((keys[i] as number) - (keys[i - 1] as number)).toBeCloseTo(0.5, 3);
  });
});
