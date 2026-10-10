import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

const fx = new URL('./fixtures/', import.meta.url);
const path = (p: string) => new URL(p, fx).pathname;

describe('seed media (D-16)', () => {
  const seeds = JSON.parse(readFileSync(path('assets/media/SEEDS.json'), 'utf8')) as Record<
    string,
    { sha256: string; size: number }
  >;

  test('SEEDS.json lists the mp4, mov and webm', () => {
    expect(Object.keys(seeds).sort()).toEqual([
      'talking-head-20s.mov',
      'talking-head-20s.mp4',
      'talking-head-20s.webm',
    ]);
  });

  test.each(['talking-head-20s.mp4', 'talking-head-20s.mov', 'talking-head-20s.webm'])(
    '%s matches its SHA-256 and size in SEEDS.json and is at most 5 MB',
    (name) => {
      const file = path(`assets/media/${name}`);
      const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
      expect(sha).toBe(seeds[name]?.sha256);
      expect(statSync(file).size).toBe(seeds[name]?.size);
      expect(statSync(file).size).toBeLessThanOrEqual(5 * 1024 * 1024);
    },
  );
});

describe('checked-in assets (R7)', () => {
  test.each(['faces/face-a.jpg', 'faces/face-b.jpg'])('%s is at most 200 kB', (f) => {
    expect(statSync(path(`assets/${f}`)).size).toBeLessThanOrEqual(200 * 1024);
  });

  test('LICENSES.md records URL, author and CC0 for every checked-in third-party file', () => {
    const md = readFileSync(path('assets/LICENSES.md'), 'utf8');
    for (const f of ['face-a.jpg', 'face-b.jpg', 'tap.wav']) {
      const row = md.split('\n').find((l) => l.includes(f + '`'));
      expect(row, f).toBeDefined();
      expect(row).toMatch(/https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
      expect(row).toMatch(/CC0/);
    }
  });

  test('tap.wav is one short mono 48 kHz hit', () => {
    const out = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=channels,sample_rate,duration',
        '-of',
        'json',
        path('assets/sfx/tap.wav'),
      ],
      { encoding: 'utf8' },
    );
    const s = (
      JSON.parse(out) as { streams: { channels: number; sample_rate: string; duration: string }[] }
    ).streams[0];
    expect(s?.channels).toBe(1);
    expect(s?.sample_rate).toBe('48000');
    expect(Number(s?.duration)).toBeLessThan(0.5);
  });
});

describe('hand-written and generated transcripts', () => {
  type W = { text: string; startMs: number; endMs: number; kind: string };
  type T = { words: W[]; speechRegions: { startMs: number; endMs: number }[] };
  const load = (n: string) => JSON.parse(readFileSync(path(`transcripts/${n}`), 'utf8')) as T;

  test('speech-fillers.json has fillers, a repeat, a pause of 350 ms or more and speech regions', () => {
    const t = load('speech-fillers.json');
    const kinds = new Set(t.words.map((w) => w.kind));
    expect([...kinds].sort()).toEqual(['filler', 'pause', 'repeat', 'word']);
    expect(
      t.words.filter((w) => w.kind === 'filler').map((w) => w.text.replace(/\W/g, '')),
    ).toEqual(['um', 'uh']);
    for (const w of t.words.filter((x) => x.kind === 'pause')) {
      expect(w.text).toBe('');
      expect(w.endMs - w.startMs).toBeGreaterThanOrEqual(350);
    }
    expect(t.speechRegions.length).toBeGreaterThan(1);
  });

  test.each(['speech-fillers.json', 'spike-90s.json'])(
    '%s words are in time order without overlap',
    (n) => {
      const w = load(n).words;
      for (let i = 0; i < w.length; i++) {
        const cur = w[i]!;
        expect(cur.endMs).toBeGreaterThan(cur.startMs);
        if (i > 0) expect(cur.startMs).toBeGreaterThanOrEqual(w[i - 1]!.endMs);
      }
    },
  );

  test('spike-90s.json spans the 90 s fixture', () => {
    const w = load('spike-90s.json').words;
    expect(w[0]!.startMs).toBeLessThan(2000);
    expect(w.at(-1)!.endMs).toBeGreaterThan(85_000);
    expect(w.at(-1)!.endMs).toBeLessThanOrEqual(90_000);
  });
});
