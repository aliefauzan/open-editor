// Encoder choice for the CFR copy (decision "CFR copy speed") and ffmpeg `-progress` parsing
// (ingest progress per step).

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
  h264Encoder,
  markHardwareFailed,
  parseEncoders,
  resetEncoderCache,
} from '../../src/stages/media/encoders.ts';
import { PROGRESS_ARGS, progressReader, withProgress } from '../../src/stages/media/progress.ts';
import { removeDir, tempDir } from './helpers.ts';

const LIST = [
  'Encoders:',
  ' V..... = Video',
  ' ------',
  ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)',
  ' V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)',
  ' A....D aac                  AAC (Advanced Audio Coding)',
].join('\n');

describe('parseEncoders', () => {
  test('reads the encoder names, not the legend', () => {
    const e = parseEncoders(LIST);
    expect(e.has('libx264')).toBe(true);
    expect(e.has('h264_videotoolbox')).toBe(true);
    expect(e.has('aac')).toBe(true);
    expect(e.has('=')).toBe(false);
  });
});

describe('h264Encoder (detected once per ffmpeg, cached)', () => {
  const made: string[] = [];
  afterAll(async () => {
    for (const d of made) await removeDir(d);
  });
  beforeEach(() => resetEncoderCache());
  const fakeFfmpeg = (list: string): { bin: string; count: () => number } => {
    const dir = tempDir('vox-fakeff-');
    made.push(dir);
    const bin = join(dir, 'ffmpeg');
    const log = join(dir, 'calls');
    writeFileSync(log, '');
    writeFileSync(
      bin,
      `#!/bin/sh\necho x >> '${log}'\nprintf '%s\\n' '${list.replaceAll("'", "'\\''")}'\nexit 0\n`,
    );
    chmodSync(bin, 0o755);
    return { bin, count: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).length };
  };

  test('videotoolbox when the build lists h264_videotoolbox; one ffmpeg run for many asks', async () => {
    const f = fakeFfmpeg(LIST);
    const ro = { tools: { ffmpeg: f.bin } };
    expect(await h264Encoder(ro)).toBe('videotoolbox');
    expect(await Promise.all([h264Encoder(ro), h264Encoder(ro)])).toEqual([
      'videotoolbox',
      'videotoolbox',
    ]);
    expect(f.count()).toBe(1);
  });

  test('libx264 when the build has no hardware encoder', async () => {
    const f = fakeFfmpeg(LIST.replace(/.*h264_videotoolbox.*\n/, ''));
    expect(await h264Encoder({ tools: { ffmpeg: f.bin } })).toBe('libx264');
  });

  test('libx264 when ffmpeg cannot be run', async () => {
    expect(await h264Encoder({ tools: { ffmpeg: '/nonexistent/ffmpeg' } })).toBe('libx264');
  });

  test('a failed hardware encode switches that ffmpeg to libx264 for the rest of the run', async () => {
    const f = fakeFfmpeg(LIST);
    const ro = { tools: { ffmpeg: f.bin } };
    expect(await h264Encoder(ro)).toBe('videotoolbox');
    markHardwareFailed(ro);
    expect(await h264Encoder(ro)).toBe('libx264');
    expect(f.count()).toBe(1);
  });
});

describe('ffmpeg -progress', () => {
  test('progressReader: out_time_us over the duration, chunked lines, end → 1', () => {
    const seen: number[] = [];
    const read = progressReader(10_000, (p) => seen.push(p));
    read('frame=10\nout_time_us=2500');
    read('000\nout_time_ms=5000000\nprogress=continue\n');
    read('out_time=00:00:07.500000\nout_time_us=N/A\nprogress=continue\n');
    read('out_time_us=12000000\nprogress=end\n');
    expect(seen).toEqual([0.25, 0.5, 0.75, 1, 1]);
  });

  test('progressReader with no duration reports nothing until the end', () => {
    const seen: number[] = [];
    const read = progressReader(undefined, (p) => seen.push(p));
    read('out_time_us=1000000\nprogress=end\n');
    expect(seen).toEqual([1]);
  });

  test('withProgress puts the global progress flags first and keeps the rest', () => {
    const argv = ['-hide_banner', '-nostdin', '-i', '/a', '/b'];
    expect(withProgress(argv)).toEqual([...PROGRESS_ARGS, ...argv]);
    expect(PROGRESS_ARGS).toEqual(['-progress', 'pipe:1', '-nostats']);
  });
});
