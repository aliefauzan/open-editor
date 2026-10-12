// Screenplay fixture set (plan 14b, R7): a short `.fountain` file with 6 scenes, 6 generated clips
// and a tags file, made offline and deterministically.
//
//   node scripts/make-screenplay-set.ts [--out <dir>]     (from the repo root; default
//                                                          packages/engine/test/fixtures/out/screenplay)
//
// Output: `screenplay.fountain`, `clips/take-a.mp4` … `take-f.mp4`, `tags.json` (what a vision model
// would say about each clip: description + tags + the spoken line) and `expected.json` (the clip file
// that belongs to each scene, in screenplay order).
//
// The clips are NOT in scene order, so a test that finds them in screenplay order proves the matching.
// Each clip is `testsrc2` with a seven-segment digit (its scene number) and a colour band for the
// scene, plus a `say` line that describes the scene. The Homebrew ffmpeg has no `drawtext` (no
// libfreetype, D-17), so the label is drawn with `drawbox`, not text. Same settings as `make.sh`
// (bitexact encoders, no metadata): two runs on the same machine give byte-identical files.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = join(HERE, '../packages/engine/test/fixtures/out/screenplay');
const VOICE = 'Samantha';
export const CLIP_MS = 3000;

export interface SceneFixture {
  /** Scene heading as written in the screenplay. */
  heading: string;
  action: string;
  /** [character, line] */
  dialogue: [string, string][];
  /** The clip file (without `.mp4`) that belongs to this scene. */
  clip: string;
  /** What the clip shows (the expected vision description) and its tags. */
  description: string;
  tags: string[];
  /** The line the clip's speaker says. */
  say: string;
  /** Band colour of the clip picture (hex without `#`). */
  color: string;
}

/** Screenplay order. The `clip` names are deliberately shuffled against it. */
export const SCENES: readonly SceneFixture[] = [
  {
    heading: 'INT. LIGHTHOUSE KITCHEN - NIGHT',
    action: 'Mara pours hot tea beside a rain-streaked window. The kettle whistles.',
    dialogue: [['MARA', 'The storm will not stop before dawn.']],
    clip: 'take-d',
    description: 'A woman pours tea in a small kitchen at night, rain running down the window.',
    tags: ['kitchen', 'tea', 'rain', 'window', 'night', 'woman'],
    say: 'The storm will not stop before dawn.',
    color: '2255aa',
  },
  {
    heading: 'EXT. HARBOR DOCK - DAWN',
    action: 'Gulls circle a fishing boat. Tom coils a wet rope on the pier.',
    dialogue: [['TOM', 'The boat leaves in ten minutes.']],
    clip: 'take-a',
    description: 'A man coils a rope on a harbor pier next to a fishing boat, gulls overhead.',
    tags: ['harbor', 'dock', 'fishing boat', 'rope', 'gulls', 'dawn'],
    say: 'The boat leaves in ten minutes.',
    color: 'aa7722',
  },
  {
    heading: 'INT. FERRY ENGINE ROOM - DAY',
    action: 'Steam hisses from the pipes. An engineer tightens a bolt with a heavy wrench.',
    dialogue: [['ENGINEER', 'One more turn and the pressure holds.']],
    clip: 'take-f',
    description: 'An engineer with a wrench works among steaming pipes in a ferry engine room.',
    tags: ['engine room', 'engineer', 'wrench', 'steam', 'pipes', 'machinery'],
    say: 'One more turn and the pressure holds.',
    color: '888888',
  },
  {
    heading: 'EXT. CLIFF ROAD - SUNSET',
    action: 'A cyclist on a red bicycle rides along the cliff, the ocean glowing below.',
    dialogue: [['LENA', 'I can see the whole ocean from here.']],
    clip: 'take-c',
    description: 'A cyclist on a red bicycle rides a cliff road at sunset above the ocean.',
    tags: ['cliff', 'road', 'cyclist', 'red bicycle', 'sunset', 'ocean'],
    say: 'I can see the whole ocean from here.',
    color: 'cc3333',
  },
  {
    heading: 'INT. TOWN LIBRARY - DAY',
    action:
      'Dust floats in the light. A librarian climbs a ladder between tall shelves of old books.',
    dialogue: [['LIBRARIAN', 'That book has been missing for years.']],
    clip: 'take-b',
    description: 'A librarian climbs a wooden ladder between shelves of old books in a library.',
    tags: ['library', 'librarian', 'ladder', 'old books', 'shelves', 'dust'],
    say: 'That book has been missing for years.',
    color: '775533',
  },
  {
    heading: 'EXT. ROOFTOP GARDEN - NIGHT',
    action: 'Paper lanterns glow over tomato plants. City lights flicker far away.',
    dialogue: [['NOA', 'We can stay up here until morning.']],
    clip: 'take-e',
    description:
      'Paper lanterns above tomato plants on a rooftop garden at night, city lights behind.',
    tags: ['rooftop', 'garden', 'lanterns', 'tomato plants', 'city lights', 'night'],
    say: 'We can stay up here until morning.',
    color: '33aa66',
  },
];

export function fountainText(): string {
  const out = ['Title: The Last Ferry', 'Credit: Written by', 'Author: Vox Fixtures', ''];
  for (const s of SCENES) {
    out.push(s.heading, '', s.action, '');
    for (const [who, line] of s.dialogue) out.push(who, line, '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

// segments a b c d e f g of a seven-segment digit
const DIGITS: Record<number, string> = {
  1: 'bc',
  2: 'abged',
  3: 'abgcd',
  4: 'fgbc',
  5: 'afgcd',
  6: 'afgedc',
  7: 'abc',
};

/** ffmpeg filter graph: testsrc2, a black panel, the scene's colour band and its digit. */
export function clipFilter(sceneNo: number, color: string): string {
  const T = 14; // stroke
  const X = 85;
  const Y = 150;
  const W = 100;
  const H = 180;
  const half = Math.floor(H / 2);
  const seg: Record<string, [number, number, number, number]> = {
    a: [X, Y, W, T],
    b: [X + W - T, Y, T, half],
    c: [X + W - T, Y + half, T, half],
    d: [X, Y + H - T, W, T],
    e: [X, Y + half, T, half],
    f: [X, Y, T, half],
    g: [X, Y + half - T / 2, W, T],
  };
  const boxes = [
    `drawbox=x=60:y=120:w=150:h=240:color=black:t=fill`,
    `drawbox=x=0:y=0:w=270:h=60:color=0x${color}:t=fill`,
    ...[...(DIGITS[sceneNo] ?? '')].map((k) => {
      const [x, y, w, h] = seg[k]!;
      return `drawbox=x=${String(x)}:y=${String(y)}:w=${String(w)}:h=${String(h)}:color=white:t=fill`;
    }),
  ];
  return `testsrc2=s=270x480:r=15:d=${String(CLIP_MS / 1000)},format=yuv420p,${boxes.join(',')}`;
}

/** The files this script writes, relative to the output folder, in a fixed order. */
export const OUTPUT_FILES = [
  'screenplay.fountain',
  ...[...SCENES].map((s) => `clips/${s.clip}.mp4`).sort(),
  'tags.json',
  'expected.json',
];

export function makeScreenplaySet(outDir: string): void {
  mkdirSync(join(outDir, 'clips'), { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'vox-screenplay-'));
  const ff = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
  try {
    SCENES.forEach((s, i) => {
      const aiff = join(tmp, `${s.clip}.aiff`);
      execFileSync('say', ['-v', VOICE, '-r', '185', '-o', aiff, s.say]);
      const spoken = Number(
        execFileSync('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'csv=p=0',
          aiff,
        ])
          .toString()
          .trim(),
      );
      if (spoken > CLIP_MS / 1000)
        throw new Error(`${s.clip}: the spoken line is ${String(spoken)} s, longer than the clip`);
      execFileSync('ffmpeg', [
        ...ff,
        '-f',
        'lavfi',
        '-i',
        clipFilter(i + 1, s.color),
        '-i',
        aiff,
        '-af',
        'apad',
        '-t',
        String(CLIP_MS / 1000),
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
        '-flags:v',
        '+bitexact',
        '-fflags',
        '+bitexact',
        '-c:a',
        'aac',
        '-b:a',
        '96k',
        '-ar',
        '48000',
        '-ac',
        '1',
        '-flags:a',
        '+bitexact',
        '-map_metadata',
        '-1',
        '-movflags',
        '+faststart',
        join(outDir, 'clips', `${s.clip}.mp4`),
      ]);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  writeFileSync(join(outDir, 'screenplay.fountain'), fountainText());
  const byClip = [...SCENES].sort((a, b) => a.clip.localeCompare(b.clip));
  writeFileSync(
    join(outDir, 'tags.json'),
    `${JSON.stringify(
      byClip.map((s) => ({
        file: `clips/${s.clip}.mp4`,
        description: s.description,
        tags: s.tags,
        say: s.say,
      })),
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(outDir, 'expected.json'),
    `${JSON.stringify(
      SCENES.map((s, i) => ({ scene: i + 1, heading: s.heading, file: `clips/${s.clip}.mp4` })),
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  const out = values.out ?? DEFAULT_OUT;
  makeScreenplaySet(out);
  process.stdout.write(`screenplay set written to ${out}\n`);
}
