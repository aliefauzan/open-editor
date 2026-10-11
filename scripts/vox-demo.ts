// GATE 3 demo (phase 07 step 12): the offline talking-head project re-styled as `vox`, with all four
// v1 templates on V2 over the speaker (the collage as a black-and-white newspaper clipping with a
// highlighter, GATE 3 round 2), hard cuts as in the documentary references, a `base/title` end card
// (a mixed sequence, styles done-when 2), captions with emphasis, and accent SFX on about one cut in
// three (the stat number and the kinetic reveal; the other scene cues are switched off with
// `sfxOff`). Renders the MP4 and runs the audio QA (`qa.json`, `qa.png`, `LISTEN.md`) into the
// evidence folder.
//
//   node scripts/vox-demo.ts --projects-dir <dir> --evidence-dir <dir> [--preset vox/mono-box]
//     [--overlays film-look,...] (default: the style's default overlays)
//
// The cutouts are generated from the checked-in test faces (an ellipse alpha), never from the
// reference reel.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openEngine, type Engine } from '../packages/engine/src/api.ts';
import type { JobInfo } from '../packages/engine/src/jobs.ts';
import { makeOfflineProject } from './make-offline-project.ts';

const REPO = new URL('../', import.meta.url).pathname;
const FACES = join(REPO, 'packages', 'engine', 'test', 'fixtures', 'assets', 'faces');

async function job<T>(e: Engine, name: string, args: unknown): Promise<T> {
  const info = (await e.jobs.wait(e.jobs.start(name as never, args as never))) as JobInfo<T>;
  if (info.status !== 'done') throw new Error(`${name} failed: ${JSON.stringify(info.error)}`);
  return info.result!;
}

/** A PNG cutout: the picture inside an ellipse, transparent around it. */
function cutout(src: string, out: string, crop: string): void {
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    src,
    '-vf',
    `${crop},scale=600:600,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(pow((X-300)/290,2)+pow((Y-300)/290,2),1),255,0)'`,
    '-frames:v',
    '1',
    out,
  ]);
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'projects-dir': { type: 'string' },
      'evidence-dir': { type: 'string' },
      preset: { type: 'string' },
      overlays: { type: 'string' },
    },
    strict: true,
  });
  const projectsDir = values['projects-dir'];
  const evidence = values['evidence-dir'];
  if (!projectsDir || !evidence) {
    throw new Error('Usage: vox-demo.ts --projects-dir <dir> --evidence-dir <dir> [--preset id]');
  }
  const preset = values.preset ?? 'vox/mono-box';
  const e = openEngine({
    projectsDir,
    stylesDirs: [join(REPO, 'styles')],
    config: async () => ({}),
  });
  const { projectId, dir, sequenceId } = await makeOfflineProject(e, 'Vox demo');
  const op = async (o: unknown) => {
    const r = await e.applyOp(projectId, o as never, { actor: 'cli' });
    const bad = r.results.find((x) => x.status !== 'succeeded');
    if (bad) throw new Error(`demo op failed: ${JSON.stringify(bad)}`);
    return r;
  };

  // pictures: two face cutouts, plus a photo for the stat background
  const work = join(dir, 'demo-src');
  await mkdir(work, { recursive: true });
  cutout(join(FACES, 'face-a.jpg'), join(work, 'cut-a.png'), 'crop=min(iw\\,ih):min(iw\\,ih)');
  cutout(join(FACES, 'face-b.jpg'), join(work, 'cut-b.png'), 'crop=min(iw\\,ih):min(iw\\,ih)');
  await copyFile(join(FACES, 'face-a.jpg'), join(work, 'photo.jpg'));
  const ing = await job<{ media: { mediaId: string; path?: string }[] }>(e, 'ingest', {
    projectId,
    inputs: ['cut-a.png', 'cut-b.png', 'photo.jpg'].map((f) => join(work, f)),
    actor: 'cli',
  });
  const [cutA, cutB, photo] = ing.media.map((m) => m.mediaId) as [string, string, string];

  await op({ op: 'updateSequence', args: { sequenceId, styleId: 'vox' } });
  if (values.overlays) {
    await op({
      op: 'updateSequence',
      args: { sequenceId, overlays: values.overlays.split(',').filter(Boolean) },
    });
  }
  await op({
    op: 'setCaptions',
    args: {
      sequenceId,
      enabled: true,
      preset,
      autoEmphasis: true,
      position: { yPct: preset === 'vox/serif-lower' ? 78 : 50 },
    },
  });
  // addSequence creates V1 and V2; the speaker is on V1, the scenes go on V2
  const track = 'V2';

  // 20 s: speaker hook, then a scene every few seconds (speaker share inside 15–35 % is not the aim
  // here; the demo shows every template once). Each row: start, duration, template, variables, the
  // scene's cues kept on (accent rule: about one cut in three to five gets a sound).
  const scenes: [number, number, string, Record<string, unknown>, boolean][] = [
    [
      2000,
      3200,
      'vox/map-route',
      {
        places: [
          { name: 'Rotterdam', lat: 51.92, lon: 4.48 },
          { name: 'Mumbai', lat: 19.08, lon: 72.88 },
        ],
        route: true,
        zoom: 'world',
      },
      false,
    ],
    [
      6200,
      2800,
      'vox/stat',
      {
        value: '2 billion cups.',
        line2: 'Every single day.',
        tag: "The world's coffee habit",
        bgPhoto: photo,
      },
      true,
    ],
    [
      10000,
      3000,
      'vox/paper-collage',
      {
        items: [
          { media: cutA, x: 28, y: 70, scale: 0.75, rotate: -8 },
          { media: cutB, x: 72, y: 66, scale: 0.7, rotate: 6 },
        ],
        clipping: {
          kicker: 'The Daily Ledger, 1952',
          headline: 'City council bans coffee carts from the old market',
          body: 'The vote came late on Tuesday after three hours of debate. Vendors say the rule will end a trade their families have run for decades.',
          highlight: 'bans coffee carts',
          y: 32,
        },
        grade: 'bw',
      },
      false,
    ],
    [
      14000,
      2600,
      'vox/kinetic-serif',
      { text: 'without animating a single frame', emphasis: ['single', 'frame'] },
      true,
    ],
    [
      17600,
      2400,
      'base/title',
      { title: 'Vox Studio', subtitle: 'paper collage, by agent' },
      false,
    ],
  ];
  const cueNames: Record<string, string[]> = {
    'vox/map-route': ['map-in'],
    'vox/stat': ['reveal'],
    'vox/paper-collage': ['first-pop'],
    'vox/kinetic-serif': ['reveal'],
  };
  for (const [startMs, durationMs, template, variables, sound] of scenes) {
    const off = sound ? [] : (cueNames[template] ?? []);
    await op({
      op: 'addScene',
      args: {
        sequenceId,
        trackId: track,
        startMs,
        durationMs,
        template,
        variables,
        ...(off.length ? { sfxOff: off } : {}),
      },
    });
  }

  await mkdir(evidence, { recursive: true });
  const mp4 = join(evidence, 'demo.mp4');
  await job(e, 'render', {
    projectId,
    sequenceId,
    target: { file: mp4 },
    overwrite: true,
    quality: 'standard',
  });
  const qa = await job<{ pass: boolean; outDir: string; png: string }>(e, 'audioQa', {
    projectId,
    sequenceId,
  });
  for (const f of ['qa.json', 'qa.png', 'LISTEN.md']) {
    await copyFile(join(qa.outDir, f), join(evidence, f));
  }
  process.stdout.write(
    `${JSON.stringify({ projectId, dir, mp4, qaPass: qa.pass, qaDir: qa.outDir })}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  });
}
