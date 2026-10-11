import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

// Slow: runs make.sh (about 25 s) and checks every generated fixture with ffprobe.
// Tolerances only: never exact bytes or exact `say` timings (D-16).
const fx = new URL('./fixtures/', import.meta.url).pathname;
const out = (n: string) => `${fx}out/${n}`;

interface Probe {
  format: { duration: string };
  streams: {
    codec_type: string;
    channels?: number;
    sample_rate?: string;
    width?: number;
    height?: number;
    r_frame_rate: string;
    avg_frame_rate: string;
  }[];
}
const probe = (f: string): Probe =>
  JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=codec_type,channels,sample_rate,width,height,r_frame_rate,avg_frame_rate',
        '-of',
        'json',
        f,
      ],
      {
        encoding: 'utf8',
      },
    ),
  ) as Probe;
const video = (p: Probe) => p.streams.filter((s) => s.codec_type === 'video');
const audio = (p: Probe) => p.streams.filter((s) => s.codec_type === 'audio');

/** Decode the 16-bit barcode frame counter of frame `n` (a fresh ffmpeg per call). */
function decodeCounter(file: string, n: number): number {
  const raw = execFileSync(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `select=eq(n\\,${n}),crop=640:40:40:40,scale=16:1:flags=area,format=gray`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-',
    ],
    { maxBuffer: 1 << 20 },
  );
  return [...raw].reduce((acc, b) => acc * 2 + (b > 127 ? 1 : 0), 0);
}

function packetTimes(file: string): number[] {
  return execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v',
      '-show_entries',
      'packet=pts_time',
      '-of',
      'csv=p=0',
      file,
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .map(Number)
    .sort((a, b) => a - b);
}

describe('make.sh', () => {
  test('generates every fixture offline in under 2 minutes', () => {
    const t0 = Date.now();
    execFileSync('bash', [`${fx}make.sh`], { stdio: 'pipe' });
    expect(Date.now() - t0).toBeLessThan(120_000);
  });

  test('spike-source-1080p.mp4 is 90 s 1920x1080 30 fps with audio', () => {
    const p = probe(out('spike-source-1080p.mp4'));
    expect(Number(p.format.duration)).toBeCloseTo(90, 0);
    expect(video(p)[0]).toMatchObject({ width: 1920, height: 1080, r_frame_rate: '30/1' });
    expect(audio(p)).toHaveLength(1);
  });

  test('spike-source-1080p.mp4 burns the frame number into every frame', () => {
    for (const n of [0, 1, 1234, 2699])
      expect(decodeCounter(out('spike-source-1080p.mp4'), n)).toBe(n);
  });

  test('face-2people.mp4 is 1080p video only', () => {
    const p = probe(out('face-2people.mp4'));
    expect(video(p)[0]).toMatchObject({ width: 1920, height: 1080 });
    expect(audio(p)).toHaveLength(0);
  });

  test('phone-vfr-20s.mp4 is 1080x1920 20 s with really uneven pts deltas', () => {
    const f = out('phone-vfr-20s.mp4');
    const p = probe(f);
    expect(video(p)[0]).toMatchObject({ width: 1080, height: 1920 });
    expect(Number(p.format.duration)).toBeCloseTo(20, 0);
    expect(audio(p)).toHaveLength(1);
    const t = packetTimes(f);
    const deltas = t.slice(1).map((x, i) => x - t[i]!);
    expect(Math.max(...deltas) - Math.min(...deltas)).toBeGreaterThan(0.005);
    expect(video(p)[0]!.r_frame_rate).not.toBe(video(p)[0]!.avg_frame_rate);
    expect(decodeCounter(f, 300)).toBe(300);
  });

  test('ntsc-2997-20s.mp4 runs at 30000/1001 with video and audio', () => {
    const p = probe(out('ntsc-2997-20s.mp4'));
    expect(video(p)[0]).toMatchObject({ width: 1920, height: 1080, r_frame_rate: '30000/1001' });
    expect(Number(p.format.duration)).toBeCloseTo(20, 0);
    expect(audio(p)).toHaveLength(1);
    expect(decodeCounter(out('ntsc-2997-20s.mp4'), 598)).toBe(598);
  });

  test('cuts-2shot.mp4 is 9 s and cuts.json lists the hard cuts', () => {
    const p = probe(out('cuts-2shot.mp4'));
    expect(Number(p.format.duration)).toBeCloseTo(9, 0);
    const cuts = JSON.parse(readFileSync(out('cuts-2shot.cuts.json'), 'utf8')) as {
      cutFrames: number[];
      cutsMs: number[];
    };
    expect(cuts.cutFrames).toEqual([90, 180]);
    expect(cuts.cutsMs).toEqual([3000, 6000]);
  });

  test('cuts-2shot.mp4 third shot has a moving box and the cut frames differ', () => {
    const md5 = (n: number) =>
      execFileSync(
        'ffmpeg',
        [
          '-nostdin',
          '-v',
          'error',
          '-i',
          out('cuts-2shot.mp4'),
          '-vf',
          `select=eq(n\\,${n}),crop=1920:300:0:400`,
          '-frames:v',
          '1',
          '-f',
          'md5',
          '-',
        ],
        { encoding: 'utf8' },
      );
    expect(md5(200)).not.toBe(md5(260));
    expect(md5(89)).not.toBe(md5(90));
    expect(md5(179)).not.toBe(md5(180));
  });

  test('style-extract-10s.mp4 is 10 s 1080x1920 with its truth file (phase 15)', () => {
    const p = probe(out('style-extract-10s.mp4'));
    expect(video(p)[0]).toMatchObject({ width: 1080, height: 1920, r_frame_rate: '30/1' });
    expect(audio(p)).toHaveLength(0);
    expect(Number(p.format.duration)).toBeCloseTo(10, 0);
    const truth = JSON.parse(readFileSync(out('style-extract-10s.truth.json'), 'utf8')) as {
      cutsMs: number[];
      captions: { text: string }[];
    };
    expect(truth.cutsMs).toEqual([2000, 4500, 7000]);
    expect(truth.captions.map((c) => c.text)).toEqual([
      'EMPIRES RISE FAST',
      'BORDERS MOVE TOO',
      'MAPS TELL STORIES',
    ]);
  });

  test('style-extract-10s.mp4 shows each flat shot colour and a caption box at 75 % height', () => {
    // one pixel at (40, 40) in the middle of each shot, and the caption box centre at 1 s
    const px = (t: number, x: number, y: number) =>
      [
        ...execFileSync('ffmpeg', [
          '-nostdin',
          '-v',
          'error',
          '-ss',
          String(t),
          '-i',
          out('style-extract-10s.mp4'),
          '-vf',
          `crop=1:1:${x}:${y},format=rgb24`,
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-',
        ]),
      ];
    const near = (a: number[], hex: string) => {
      const b = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return a.every((v, i) => Math.abs(v - b[i]!) <= 12);
    };
    expect(near(px(1, 40, 40), '#D7261E')).toBe(true);
    expect(near(px(3.2, 40, 40), '#1D4FA0')).toBe(true);
    expect(near(px(5.7, 40, 40), '#F5C518')).toBe(true);
    expect(near(px(8.5, 40, 40), '#EDE8DF')).toBe(true);
    // the box edge (left of the text), dark grey
    expect(Math.max(...px(1, 80, 1440))).toBeLessThan(60);
    // between captions (3.2 s) the box is gone
    expect(near(px(3.2, 80, 1440), '#1D4FA0')).toBe(true);
  });

  test('podcast-2face.mp4 is 12 s of 1080p', () => {
    const p = probe(out('podcast-2face.mp4'));
    expect(video(p)[0]).toMatchObject({ width: 1920, height: 1080 });
    expect(Number(p.format.duration)).toBeCloseTo(12, 0);
  });

  test('speech-fillers.wav is 12 s mono 48 kHz speech', () => {
    const p = probe(out('speech-fillers.wav'));
    expect(Number(p.format.duration)).toBeCloseTo(12, 0);
    expect(audio(p)).toHaveLength(1);
  });

  test('music-silence.wav is about 14 s: music, 4 s silence, a sentence', () => {
    const p = probe(out('music-silence.wav'));
    expect(Number(p.format.duration)).toBeGreaterThan(13);
    expect(Number(p.format.duration)).toBeLessThan(17);
  });

  // Audio QA set (plan 05 step 8d0, D-14): duration, channel count and sample rate only.
  describe('audio QA set', () => {
    const cases = [
      'good',
      'bad-late',
      'bad-double-hit',
      'bad-close-cues',
      'bad-sfx-over-speech',
      'bad-clipped',
    ];

    test.each(cases)('%s: 13 s stereo mix, mono sfx and speech stems, cues file', (name) => {
      const mix = probe(out(`audio/${name}.wav`));
      expect(Number(mix.format.duration)).toBeCloseTo(13, 1);
      expect(audio(mix)[0]).toMatchObject({ channels: 2, sample_rate: '48000' });
      for (const stem of ['sfx', 'speech']) {
        const p = probe(out(`audio/${name}.${stem}.wav`));
        expect(Number(p.format.duration)).toBeCloseTo(13, 1);
        expect(audio(p)[0]).toMatchObject({ channels: 1, sample_rate: '48000' });
      }
      const cues = JSON.parse(readFileSync(out(`audio/${name}.cues.json`), 'utf8')) as {
        fps: number;
        target: number;
        cues: { atMs: number; type: string; hero: boolean }[];
      };
      expect(cues.fps).toBe(30);
      expect(cues.target).toBe(-14);
      expect(cues.cues.length).toBe(name === 'bad-close-cues' ? 7 : 6);
      expect(cues.cues.filter((c) => c.hero)).toHaveLength(2);
    });

    test.each([
      ['kit-beep', 0.3],
      ['kit-noise-bed', 2],
      ['kit-click-start', 0.18],
      ['kit-double-hit', 0.45],
    ])('%s is a mono 48 kHz sample of about %s s', (name, seconds) => {
      const p = probe(out(`audio/${name}.wav`));
      expect(Number(p.format.duration)).toBeCloseTo(seconds, 1);
      expect(audio(p)[0]).toMatchObject({ channels: 1, sample_rate: '48000' });
    });
  });
});
