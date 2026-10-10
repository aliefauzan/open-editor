// Ingest analysis (D-15), fast tier: rational parsing, fixed-set snapping, VFR rule, ebur128 parsing,
// and a real probe + loudness of the checked-in seed media. The make.sh fixtures (VFR phone clip,
// NTSC clip) are in analyze.slow.test.ts.

import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import type { VoxError } from '../../src/errors.pending.ts';
import {
  SILENCE_DB,
  analyzeMedia,
  detectVfr,
  nearestFixedFps,
  parseEbur128,
  parseProbeJson,
  parseRational,
  planFrameRate,
  ptsDeltaSpread,
} from '../../src/stages/media/analyze.ts';
import { sniffFile, type SniffedMedia } from '../../src/stages/media/sniff.ts';
import { codeOf, codeOfAsync, fixture, removeDir, tempDir } from './helpers.ts';

const r = (num: number, den = 1) => ({ num, den });

describe('parseRational', () => {
  test.each([
    ['30000/1001', r(30000, 1001)],
    ['30/1', r(30)],
    ['60/2', r(30)],
    ['90000/1', r(90000)],
  ])('%s', (s, want) => expect(parseRational(s)).toEqual(want));
  test.each(['0/0', '0/1', '30/0', '', 'abc', '30', '-30/1', '1.5/1', undefined])(
    '%j → undefined',
    (s) => {
      expect(parseRational(s)).toBeUndefined();
    },
  );
});

describe('nearestFixedFps', () => {
  test.each([
    [29.97, r(30000, 1001)],
    [30, r(30)],
    [29.99, r(30)],
    [1125000 / 37549, r(30000, 1001)], // phone-vfr-20s average (29.96)
    [23.9, r(24000, 1001)],
    [25.1, r(25)],
    [50, r(60000, 1001)],
    [120, r(60)],
    [5, r(24000, 1001)],
  ])('%f → all-rates %o', (rate, want) => expect(nearestFixedFps(rate)).toEqual(want));
  test.each([
    [29.97, r(30)],
    [23.976, r(24)],
    [59.94, r(60)],
    [1125000 / 37549, r(30)],
  ])('%f → integer-only %o (GATE 1 NTSC fallback)', (rate, want) => {
    expect(nearestFixedFps(rate, 'integer')).toEqual(want);
  });
});

describe('VFR rule (D-15)', () => {
  const cfrPts = (fps: number, n: number) => Array.from({ length: n }, (_, i) => i / fps);

  test('r_frame_rate ≠ avg_frame_rate → VFR without looking at pts', () => {
    expect(detectVfr({ rFrameRate: r(90000), avgFrameRate: r(1125000, 37549) })).toBe(true);
  });
  test('equal rates and constant pts → not VFR', () => {
    expect(detectVfr({ rFrameRate: r(30), avgFrameRate: r(30), pts: cfrPts(30, 300) })).toBe(false);
  });
  test('ms-rounded pts of a 30 fps WebM (33/34 ms) → not VFR', () => {
    const pts = cfrPts(30, 300).map((t) => Math.round(t * 1000) / 1000);
    expect(detectVfr({ rFrameRate: r(30), avgFrameRate: r(30), pts })).toBe(false);
  });
  test('equal rates but pts deltas spread over more than 1 frame → VFR', () => {
    const pts = cfrPts(30, 100);
    pts.splice(50, 1); // one dropped frame: a 2-frame gap, spread exactly 1 frame
    expect(detectVfr({ rFrameRate: r(30), avgFrameRate: r(30), pts })).toBe(false);
    pts.splice(50, 1); // a 3-frame gap: spread 2 frames
    expect(detectVfr({ rFrameRate: r(30), avgFrameRate: r(30), pts })).toBe(true);
  });
  test('pts in decode order (B-frames) are sorted first', () => {
    const pts = cfrPts(30, 60);
    for (let i = 1; i + 1 < pts.length; i += 3)
      [pts[i], pts[i + 1]] = [pts[i + 1] as number, pts[i] as number];
    expect(detectVfr({ rFrameRate: r(30), avgFrameRate: r(30), pts })).toBe(false);
  });
  test('ptsDeltaSpread needs 3 pts', () => {
    expect(ptsDeltaSpread([0, 1])).toBeUndefined();
    expect(ptsDeltaSpread([0, 1, 3])).toBe(1);
  });
});

describe('planFrameRate', () => {
  test('VFR → CFR copy at the fixed-set rate nearest the average', () => {
    expect(planFrameRate({ rFrameRate: r(90000), avgFrameRate: r(1125000, 37549) })).toEqual({
      fps: r(30000, 1001),
      vfr: true,
      cfr: { fps: r(30000, 1001), reason: 'vfr' },
    });
    expect(
      planFrameRate({ rFrameRate: r(90000), avgFrameRate: r(1125000, 37549) }, 'integer')?.cfr,
    ).toEqual({
      fps: r(30),
      reason: 'vfr',
    });
  });
  test('CFR NTSC keeps 30000/1001 and gets no copy, unless the integer fallback is on', () => {
    const ntsc = { rFrameRate: r(30000, 1001), avgFrameRate: r(30000, 1001) };
    expect(planFrameRate(ntsc)).toEqual({ fps: r(30000, 1001), vfr: false });
    expect(planFrameRate(ntsc, 'integer')).toEqual({
      fps: r(30),
      vfr: false,
      cfr: { fps: r(30), reason: 'integer-rate' },
    });
  });
  test('a CFR rate outside the fixed set is stored as is, no copy', () => {
    expect(planFrameRate({ rFrameRate: r(50), avgFrameRate: r(50) })).toEqual({
      fps: r(50),
      vfr: false,
    });
  });
  test('no rate at all → undefined', () => {
    expect(planFrameRate({})).toBeUndefined();
  });
});

describe('parseEbur128', () => {
  const summary = (i: string, p: string) =>
    `[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         ${i} LUFS\n    Threshold: -26.8 LUFS\n\n` +
    `  Loudness range:\n    LRA:         1.5 LU\n\n  True peak:\n    Peak:       ${p} dBFS\n`;
  test('reads integrated loudness and true peak', () => {
    expect(parseEbur128(`noise\n${summary('-16.4', '-1.1')}`)).toEqual({
      integratedLufs: -16.4,
      truePeakDb: -1.1,
    });
  });
  test('uses the last summary', () => {
    expect(parseEbur128(summary('-30.0', '-9.0') + summary('-14.0', '0.5'))).toEqual({
      integratedLufs: -14,
      truePeakDb: 0.5,
    });
  });
  test('-inf (digital silence) becomes a finite floor', () => {
    expect(parseEbur128(summary('-70.0', '-inf'))).toEqual({
      integratedLufs: -70,
      truePeakDb: SILENCE_DB,
    });
  });
  test('no summary → TOOL_FAILED', () => {
    expect(codeOf(() => parseEbur128('nothing here'))).toBe('TOOL_FAILED');
  });
});

describe('parseProbeJson', () => {
  const probe = (streams: unknown[], format = 'mov,mp4,m4a,3gp,3g2,mj2') =>
    JSON.stringify({ format: { format_name: format, duration: '2.5005' }, streams });

  test('display size swaps for a 90° rotation; attached pictures are not video', () => {
    const info = parseProbeJson(
      probe([
        {
          codec_type: 'video',
          codec_name: 'mjpeg',
          width: 10,
          height: 10,
          disposition: { attached_pic: 1 },
        },
        {
          codec_type: 'video',
          codec_name: 'hevc',
          width: 1920,
          height: 1080,
          r_frame_rate: '30/1',
          avg_frame_rate: '30/1',
          side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
        },
        { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
      ]),
      'mov',
    );
    expect(info.video).toMatchObject({ codec: 'hevc', width: 1080, height: 1920, rotation: -90 });
    expect(info.audio).toEqual({ codec: 'aac', sampleRate: 48000, channels: 2 });
    expect(info.durationMs).toBe(2501);
  });

  test('a demuxer other than the sniffed one → MEDIA_UNSUPPORTED', () => {
    expect(codeOf(() => parseProbeJson(probe([], 'concat'), 'mov'))).toBe('MEDIA_UNSUPPORTED');
    expect(codeOf(() => parseProbeJson('{oops', 'mov'))).toBe('TOOL_FAILED');
  });
});

describe('analyzeMedia on the checked-in seed media', () => {
  test.each(['talking-head-20s.mp4', 'talking-head-20s.mov', 'talking-head-20s.webm'])(
    '%s: 30 fps, not VFR, no CFR copy, loudness measured',
    async (name) => {
      const path = fixture(`assets/media/${name}`);
      const a = await analyzeMedia(path, (await sniffFile(path)) as SniffedMedia);
      expect(a).toMatchObject({
        kind: 'video',
        width: 1920,
        height: 1080,
        fps: r(30),
        vfr: false,
        cfr: undefined,
        hasAudio: true,
      });
      expect(typeof a.audioCodec).toBe('string');
      expect(Math.abs((a.durationMs ?? 0) - 20000)).toBeLessThanOrEqual(50);
      expect(a.loudness?.integratedLufs).toBeGreaterThan(-30);
      expect(a.loudness?.integratedLufs).toBeLessThan(-5);
      expect(a.loudness?.truePeakDb).toBeLessThanOrEqual(0.5);
    },
  );

  test('the checked-in CC0 tap.wav is audio with loudness and no fps', async () => {
    const path = fixture('assets/sfx/tap.wav');
    const a = await analyzeMedia(path, (await sniffFile(path)) as SniffedMedia);
    expect(a).toMatchObject({ kind: 'audio', fps: undefined, vfr: false, hasAudio: true });
    expect(Number.isFinite(a.loudness?.integratedLufs)).toBe(true);
  });

  test('a JPEG portrait is an image with its size and nothing else', async () => {
    const path = fixture('assets/faces/face-a.jpg');
    const a = await analyzeMedia(path, (await sniffFile(path)) as SniffedMedia);
    expect(a.kind).toBe('image');
    expect(a.width).toBeGreaterThan(0);
    expect(a).toMatchObject({ fps: undefined, hasAudio: false, loudness: undefined });
  });
});

describe('probe edge cases', () => {
  const probeJson = (format: object, streams: object[]) => JSON.stringify({ format, streams });

  test('durationMs falls back to the longest stream when the container has none', () => {
    const p = parseProbeJson(
      probeJson({ format_name: 'matroska,webm' }, [
        { codec_type: 'video', width: 64, height: 48, duration: '1.5' },
        { codec_type: 'audio', codec_name: 'opus', duration: '2.25' },
      ]),
      'matroska',
    );
    expect(p.durationMs).toBe(2250);
  });
});

describe('analyzeMedia refuses what it cannot handle (fake ffprobe)', () => {
  // A stand-in ffprobe that prints fixed JSON for the stream probe and nothing for the pts scan.
  const made: string[] = [];
  afterAll(async () => {
    for (const d of made) await removeDir(d);
  });
  const fakeProbe = (json: string): string => {
    const dir = tempDir('vox-fakeprobe-');
    made.push(dir);
    const bin = join(dir, 'ffprobe');
    const quoted = json.replaceAll("'", "'\\''");
    writeFileSync(
      bin,
      `#!/bin/sh\ncase "$*" in *show_streams*) printf '%s' '${quoted}' ;; esac\nexit 0\n`,
    );
    chmodSync(bin, 0o755);
    return bin;
  };
  const video: SniffedMedia = { kind: 'video', format: 'mov', ext: 'mp4' };

  test('a picture larger than 8192×8192 → MEDIA_UNSUPPORTED before any decode', async () => {
    const ffprobe = fakeProbe(
      JSON.stringify({
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1' },
        streams: [
          {
            codec_type: 'video',
            width: 9000,
            height: 9000,
            r_frame_rate: '30/1',
            avg_frame_rate: '30/1',
          },
        ],
      }),
    );
    const err = (await analyzeMedia('/x/a.mp4', video, { tools: { ffprobe } }).catch(
      (e: unknown) => e,
    )) as VoxError;
    expect(err.code).toBe('MEDIA_UNSUPPORTED');
    expect(err.details).toMatchObject({ detected: '9000x9000' });
  });

  test('a video with no readable frame rate → MEDIA_UNSUPPORTED', async () => {
    const ffprobe = fakeProbe(
      JSON.stringify({
        format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1' },
        streams: [
          {
            codec_type: 'video',
            width: 64,
            height: 48,
            r_frame_rate: '0/0',
            avg_frame_rate: '0/0',
          },
        ],
      }),
    );
    expect(await codeOfAsync(analyzeMedia('/x/a.mp4', video, { tools: { ffprobe } }))).toBe(
      'MEDIA_UNSUPPORTED',
    );
  });
});
