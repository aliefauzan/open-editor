import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { VoxError } from '../../src/errors.pending.ts';
import {
  DEFAULT_FORMAT_WHITELIST,
  SCDET_THRESHOLD,
  ShotListSchema,
  detectShots,
  parseScdetOutput,
  scdetArgs,
  shotsFromCuts,
} from '../../src/stages/shots.ts';

describe('scdetArgs', () => {
  test('proxy input: whitelists before -i, scdet threshold 10, metadata to stdout, no scaling', () => {
    expect(scdetArgs({ input: '/p/media/m_1.proxy.mp4' })).toEqual([
      '-hide_banner',
      '-nostdin',
      '-nostats',
      '-loglevel',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-format_whitelist',
      DEFAULT_FORMAT_WHITELIST,
      '-i',
      '/p/media/m_1.proxy.mp4',
      '-map',
      '0:v:0',
      '-an',
      '-sn',
      '-dn',
      '-vf',
      'scdet=threshold=10,metadata=mode=print:key=lavfi.scd.time:file=-',
      '-f',
      'null',
      '-',
    ]);
    expect(SCDET_THRESHOLD).toBe(10);
  });

  test('original input without a proxy is scaled to 360p in the same filter graph', () => {
    const args = scdetArgs({
      input: '/p/media/m_1.mov',
      scaleTo360: true,
      formatWhitelist: 'mov,mp4',
    });
    expect(args).toContain('mov,mp4');
    expect(args[args.indexOf('-vf') + 1]).toBe(
      'scale=-2:360,scdet=threshold=10,metadata=mode=print:key=lavfi.scd.time:file=-',
    );
  });

  test('relative paths, option-like paths and NUL bytes are refused', () => {
    for (const input of ['media/a.mp4', '-i.mp4', '/a\0b.mp4']) {
      expect(() => scdetArgs({ input })).toThrow(VoxError);
    }
  });

  test('a format whitelist with odd characters is refused', () => {
    expect(() => scdetArgs({ input: '/a.mp4', formatWhitelist: 'mov,concat;x' })).toThrow(
      /whitelist/,
    );
    expect(() => scdetArgs({ input: '/a.mp4', formatWhitelist: '' })).toThrow(/whitelist/);
  });
});

describe('parseScdetOutput', () => {
  test('reads pts_time of each cut frame in ms', () => {
    const out = [
      'frame:90   pts:46080   pts_time:3',
      'lavfi.scd.time=3',
      'frame:180  pts:92160   pts_time:6.006',
      'lavfi.scd.time=6.006',
      '',
    ].join('\n');
    expect(parseScdetOutput(out)).toEqual([3000, 6006]);
  });

  test('ignores junk, negative and non-finite times; sorts and dedupes', () => {
    const out = 'pts_time:5\nnoise\npts_time:-1\npts_time:nan\npts_time:2.0004\npts_time:5.0001\n';
    expect(parseScdetOutput(out)).toEqual([2000, 5000]);
  });
});

describe('shotsFromCuts', () => {
  test('covers the whole media with contiguous shots', () => {
    expect(shotsFromCuts([3000, 6000], 9000)).toEqual([
      { startMs: 0, endMs: 3000 },
      { startMs: 3000, endMs: 6000 },
      { startMs: 6000, endMs: 9000 },
    ]);
  });

  test('no cuts → one shot; cuts at 0, at or past the end are dropped', () => {
    expect(shotsFromCuts([], 5000)).toEqual([{ startMs: 0, endMs: 5000 }]);
    expect(shotsFromCuts([0, 5000, 7000], 5000)).toEqual([{ startMs: 0, endMs: 5000 }]);
  });

  test('result validates against ShotListSchema', () => {
    expect(ShotListSchema.parse(shotsFromCuts([1000], 2000))).toHaveLength(2);
    expect(() => ShotListSchema.parse([{ startMs: 0, endMs: 0 }])).toThrow();
  });

  test('a duration that is not a positive integer is refused', () => {
    expect(() => shotsFromCuts([], 0)).toThrow(VoxError);
    expect(() => shotsFromCuts([], 12.5)).toThrow(VoxError);
  });
});

describe('detectShots with ffmpeg (small generated clip)', () => {
  let dir: string;
  let clip: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vox-shots-'));
    clip = join(dir, 'three.mp4');
    // three 1 s shots of flat colours at 30 fps: cuts at frame 30 (1000 ms) and 60 (2000 ms)
    execFileSync('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=160x90:r=30:d=1',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=160x90:r=30:d=1',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x90:r=30:d=1',
      '-filter_complex',
      '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]',
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      clip,
    ]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('finds both cuts within 1 frame and covers the clip', async () => {
    const shots = await detectShots({ input: clip, durationMs: 3000 });
    expect(shots).toHaveLength(3);
    expect(shots[0]?.startMs).toBe(0);
    expect(shots.at(-1)?.endMs).toBe(3000);
    expect(Math.abs((shots[1]?.startMs ?? 0) - 1000)).toBeLessThanOrEqual(34);
    expect(Math.abs((shots[2]?.startMs ?? 0) - 2000)).toBeLessThanOrEqual(34);
  });

  test('the 360p path gives the same cuts', async () => {
    const a = await detectShots({ input: clip, durationMs: 3000 });
    const b = await detectShots({ input: clip, durationMs: 3000, scaleTo360: true });
    expect(b).toEqual(a);
  });

  test('a missing ffmpeg binary fails with TOOL_MISSING', async () => {
    await expect(
      detectShots({ input: clip, durationMs: 3000, ffmpeg: join(dir, 'no-such-ffmpeg') }),
    ).rejects.toMatchObject({ code: 'TOOL_MISSING' });
  });

  test('an unreadable input fails with TOOL_FAILED and the stderr tail in cause', async () => {
    const bad = join(dir, 'bad.mp4');
    writeFileSync(bad, 'not a video');
    const err = await detectShots({ input: bad, durationMs: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoxError);
    expect((err as VoxError).code).toBe('TOOL_FAILED');
    expect(String((err as VoxError).cause)).not.toBe('');
  });

  test('abort kills the child and fails with CANCELLED', async () => {
    const fake = join(dir, 'slow-ffmpeg.mjs');
    writeFileSync(fake, '#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n');
    chmodSync(fake, 0o755);
    const ac = new AbortController();
    const started = Date.now();
    const p = detectShots({ input: clip, durationMs: 3000, ffmpeg: fake, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('an already aborted signal never starts ffmpeg', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      detectShots({ input: clip, durationMs: 3000, signal: ac.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
