// S5: ffmpeg/ffprobe on untrusted files always carry `-format_whitelist` for the sniffed type and
// `-protocol_whitelist file,pipe`; concat/HLS disguised as `.mp4` are rejected by ffprobe itself
// (second layer behind the sniffer). Hostile files are generated in a temp folder.

import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  FORCED_DEMUXER,
  FORMAT_WHITELIST,
  ebur128Args,
  ffprobePtsArgs,
  ffprobeStreamsArgs,
  inputArgs,
  inputsAreWhitelisted,
} from '../../src/stages/media/ffargs.ts';
import { runTool } from '../../src/stages/media/run.ts';
import type { MediaFormat } from '../../src/stages/media/sniff.ts';
import { cfrCopyArgs, imageReencodeArgs, proxyArgs } from '../../src/stages/media/proxy.ts';
import { codeOf, codeOfAsync, fixture, removeDir, tempDir } from './helpers.ts';

let dir = '';
beforeAll(() => {
  dir = tempDir('vox-ffargs-');
});
afterAll(() => removeDir(dir));

const FORMATS = Object.keys(FORMAT_WHITELIST) as MediaFormat[];

describe('argv builders always whitelist protocols and demuxers (S5)', () => {
  test('inputArgs per format', () => {
    expect(inputArgs('/m/a.mp4', 'mov')).toEqual([
      '-protocol_whitelist',
      'file,pipe',
      '-format_whitelist',
      'mov,mp4,m4a,3gp,3g2,mj2',
      '-f',
      'mov',
      '-enable_drefs',
      '0',
      '-use_absolute_path',
      '0',
      '-i',
      '/m/a.mp4',
    ]);
    expect(inputArgs('/m/a.wav', 'wav')).not.toContain('-enable_drefs');
    expect(inputArgs('/m/a.webm', 'matroska')[3]).toBe('matroska,webm');
    expect(inputArgs('/m/a.png', 'png')[3]).toBe('png_pipe');
    expect(inputArgs('/m/a.jpg', 'jpeg')[3]).toBe('jpeg_pipe');
  });

  test('the forced demuxer of each format is inside its whitelist', () => {
    for (const f of FORMATS) expect(FORMAT_WHITELIST[f].split(',')).toContain(FORCED_DEMUXER[f]);
  });

  test('no whitelist ever names a playlist-style demuxer', () => {
    for (const wl of Object.values(FORMAT_WHITELIST)) {
      for (const name of wl.split(',')) {
        expect([
          'hls',
          'concat',
          'image2',
          'mpd',
          'dash',
          'ffmetadata',
          'tee',
          'lavfi',
        ]).not.toContain(name);
      }
    }
  });

  const fps = { num: 30, den: 1 };
  const builders: [string, (f: MediaFormat) => string[]][] = [
    ['ffprobeStreamsArgs', (f) => ffprobeStreamsArgs('/m/in', f)],
    ['ffprobePtsArgs', (f) => ffprobePtsArgs('/m/in', f)],
    ['ebur128Args', (f) => ebur128Args('/m/in', f)],
    ['proxyArgs', (f) => proxyArgs({ input: '/m/in', format: f, output: '/p/out.mp4', fps })],
    ['cfrCopyArgs', (f) => cfrCopyArgs({ input: '/m/in', format: f, output: '/p/out.mp4', fps })],
    [
      'imageReencodeArgs',
      (f) =>
        imageReencodeArgs({
          input: '/m/in',
          format: f === 'png' ? 'png' : 'jpeg',
          output: '/p/out.img',
        }),
    ],
  ];
  test.each(builders)('%s whitelists every input, for every format', (_name, build) => {
    for (const f of FORMATS) {
      const argv = build(f);
      expect(inputsAreWhitelisted(argv)).toBe(true);
      expect(argv.filter((a) => a === '-i')).toHaveLength(1);
    }
  });

  test('inputsAreWhitelisted catches a missing or partial whitelist', () => {
    expect(inputsAreWhitelisted(['-i', '/a'])).toBe(false);
    expect(inputsAreWhitelisted(['-protocol_whitelist', 'file,pipe', '-i', '/a'])).toBe(false);
    expect(inputsAreWhitelisted(['-format_whitelist', 'mov', '-i', '/a'])).toBe(false);
    expect(
      inputsAreWhitelisted([
        '-protocol_whitelist',
        'file,http',
        '-format_whitelist',
        'mov',
        '-i',
        '/a',
      ]),
    ).toBe(false);
    // A second input does not inherit the first one's whitelist.
    expect(inputsAreWhitelisted([...inputArgs('/a', 'mov'), '-i', '/b'])).toBe(false);
    expect(inputsAreWhitelisted([...inputArgs('/a', 'mov'), ...inputArgs('/b', 'wav')])).toBe(true);
  });

  test('inputsAreWhitelisted needs a known whitelist and a forced demuxer inside it', () => {
    const P = ['-protocol_whitelist', 'file,pipe'];
    // no -f
    expect(
      inputsAreWhitelisted([...P, '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2', '-i', '/a']),
    ).toBe(false);
    // a whitelist that is not one of ours
    expect(
      inputsAreWhitelisted([...P, '-format_whitelist', 'concat', '-f', 'concat', '-i', '/a']),
    ).toBe(false);
    // a forced demuxer outside the whitelist
    expect(
      inputsAreWhitelisted([...P, '-format_whitelist', 'wav', '-f', 'lavfi', '-i', '/a']),
    ).toBe(false);
    // a filter that opens files
    expect(inputsAreWhitelisted([...inputArgs('/a', 'wav'), '-vf', 'movie=/etc/passwd'])).toBe(
      false,
    );
    expect(inputsAreWhitelisted([...inputArgs('/a', 'wav'), '-af', 'anull,amovie=/x.wav'])).toBe(
      false,
    );
  });

  test.each(['relative/a.mp4', 'a.mp4', '-i', '/m/a\0.mp4', ''])(
    'path %j is refused (VALIDATION)',
    (p) => {
      expect(codeOf(() => inputArgs(p, 'mov'))).toBe('VALIDATION');
    },
  );
});

describe('ffprobe with the whitelist refuses playlist-style files (S5, second layer)', () => {
  test('a concat list disguised as .mp4 opens another file without the whitelist, not with it', async () => {
    copyFileSync(fixture('assets/media/talking-head-20s.mp4'), join(dir, 'other.mp4'));
    const list = join(dir, 'clip.mp4');
    writeFileSync(list, 'ffconcat version 1.0\nfile other.mp4\n');
    // Control: plain ffprobe auto-detects the concat demuxer and reads the other file.
    const plain = await runTool('ffprobe', ['-v', 'error', '-of', 'json', '-show_format', list]);
    expect(JSON.parse(plain.stdout).format.format_name).toBe('concat');
    // Engine argv: refused.
    expect(await codeOfAsync(runTool('ffprobe', ffprobeStreamsArgs(list, 'mov')))).toBe(
      'TOOL_FAILED',
    );
  });

  test('an HLS playlist (even named .m3u8) is refused under the mp4 whitelist', async () => {
    copyFileSync(fixture('assets/media/talking-head-20s.mp4'), join(dir, 'seg.mp4'));
    for (const name of ['hls.mp4', 'hls.m3u8']) {
      const p = join(dir, name);
      writeFileSync(p, '#EXTM3U\n#EXT-X-TARGETDURATION:20\n#EXTINF:20,\nseg.mp4\n#EXT-X-ENDLIST\n');
      expect(await codeOfAsync(runTool('ffprobe', ffprobeStreamsArgs(p, 'mov')))).toBe(
        'TOOL_FAILED',
      );
    }
  });

  test('a real MP4 probes fine under its whitelist', async () => {
    const r = await runTool(
      'ffprobe',
      ffprobeStreamsArgs(fixture('assets/media/talking-head-20s.mp4'), 'mov'),
    );
    expect(JSON.parse(r.stdout).format.format_name).toBe(FORMAT_WHITELIST.mov);
  });

  test('a WebM under the mp4 whitelist is refused (whitelist matches the sniffed type only)', async () => {
    const p = fixture('assets/media/talking-head-20s.webm');
    expect(await codeOfAsync(runTool('ffprobe', ffprobeStreamsArgs(p, 'mov')))).toBe('TOOL_FAILED');
    expect(await codeOfAsync(runTool('ffprobe', ffprobeStreamsArgs(p, 'matroska')))).toBe('OK');
  });
});
