// Proxy / CFR copy / image re-encode argv (engine spec "Encoding", D-15, S6). The argv snapshot is
// the contract phase 04 wires; real encodes of the make.sh fixtures are in analyze.slow.test.ts.

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  cfrCopyArgs,
  imageReencodeArgs,
  keyframeInterval,
  proxyArgs,
} from '../../src/stages/media/proxy.ts';
import { runTool } from '../../src/stages/media/run.ts';
import { sniffFile } from '../../src/stages/media/sniff.ts';
import { codeOf, removeDir, tempDir } from './helpers.ts';

let dir = '';
beforeAll(() => {
  dir = tempDir('vox-proxy-');
});
afterAll(() => removeDir(dir));

const r = (num: number, den = 1) => ({ num, den });
const IN = [
  '-protocol_whitelist',
  'file,pipe',
  '-format_whitelist',
  'mov,mp4,m4a,3gp,3g2,mj2',
  '-f',
  'mov',
  '-i',
];

describe('keyframeInterval: a keyframe every 0.5 s', () => {
  test.each([
    [r(30), 15],
    [r(30000, 1001), 15],
    [r(24), 12],
    [r(24000, 1001), 12],
    [r(25), 13],
    [r(60), 30],
    [r(60000, 1001), 30],
    [r(1), 1],
  ])('%o → %i', (fps, g) => expect(keyframeInterval(fps)).toBe(g));
  test('a bad rate → VALIDATION', () => {
    expect(codeOf(() => keyframeInterval(r(0)))).toBe('VALIDATION');
    expect(codeOf(() => keyframeInterval(r(30, 0)))).toBe('VALIDATION');
  });
});

describe('argv snapshots', () => {
  test('proxyArgs: 540p libx264 crf 23, keyframe every 0.5 s, video only', () => {
    expect(
      proxyArgs({
        input: '/p/media/m_1.cfr.mp4',
        format: 'mov',
        output: '/p/proxies/m_1.mp4',
        fps: r(30000, 1001),
      }),
    ).toEqual([
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      ...IN,
      '/p/media/m_1.cfr.mp4',
      '-map',
      '0:v:0',
      '-an',
      '-sn',
      '-dn',
      '-map_metadata',
      '-1',
      '-vf',
      "scale=w='if(gte(iw,ih),-2,trunc(min(540,iw)/2)*2)':h='if(gte(iw,ih),trunc(min(540,ih)/2)*2,-2)'",
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '15',
      '-keyint_min',
      '15',
      '-sc_threshold',
      '0',
      '-movflags',
      '+faststart',
      '/p/proxies/m_1.mp4',
    ]);
  });

  test('cfrCopyArgs: libx264 crf 18 at a constant rate, first audio copied', () => {
    expect(
      cfrCopyArgs({
        input: '/p/media/m_1.mp4',
        format: 'mov',
        output: '/p/media/m_1.cfr.mp4',
        fps: r(30000, 1001),
      }),
    ).toEqual([
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      ...IN,
      '/p/media/m_1.mp4',
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-fps_mode',
      'cfr',
      '-r',
      '30000/1001',
      '-c:a',
      'copy',
      '-movflags',
      '+faststart',
      '/p/media/m_1.cfr.mp4',
    ]);
  });

  test('the CFR rate is a parameter (GATE 1 integer fallback → 30/1)', () => {
    const argv = cfrCopyArgs({ input: '/a.mp4', format: 'mov', output: '/b.mp4', fps: r(30) });
    expect(argv[argv.indexOf('-r') + 1]).toBe('30/1');
  });

  test('relative output paths are refused', () => {
    expect(
      codeOf(() => proxyArgs({ input: '/a.mp4', format: 'mov', output: 'b.mp4', fps: r(30) })),
    ).toBe('VALIDATION');
  });
});

describe('image re-encode (S6)', () => {
  test('a PNG with an HTML payload after IEND comes out as a clean PNG', async () => {
    const src = join(dir, 'poly.png');
    const g = spawnSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=s=64x48:d=1',
      '-frames:v',
      '1',
      src,
    ]);
    expect(g.status).toBe(0);
    appendFileSync(src, '<html><script>alert(1)</script></html>');
    const out = join(dir, 'clean.png');
    await runTool('ffmpeg', imageReencodeArgs({ input: src, format: 'png', output: out }));
    expect(await sniffFile(out)).toMatchObject({ kind: 'image', format: 'png' });
    expect(readFileSync(out).includes('<script>')).toBe(false);
  });

  test('a JPEG with EXIF-like trailing data comes out as a clean JPEG', async () => {
    const src = join(dir, 'in.jpg');
    const g = spawnSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=s=64x48:d=1',
      '-frames:v',
      '1',
      src,
    ]);
    expect(g.status).toBe(0);
    appendFileSync(src, 'TRAILING-PAYLOAD');
    const out = join(dir, 'clean.jpg');
    await runTool('ffmpeg', imageReencodeArgs({ input: src, format: 'jpeg', output: out }));
    expect(await sniffFile(out)).toMatchObject({ kind: 'image', format: 'jpeg' });
    expect(readFileSync(out).includes('TRAILING-PAYLOAD')).toBe(false);
  });
});
