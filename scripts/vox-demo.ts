// GATE 3 demo (phase 07 step 12): the offline talking-head project re-styled as `vox`, with all four
// v1 templates on V2 over the speaker, both vox transitions, a `base/title` end card (a mixed
// sequence, styles done-when 2), `vox/mono-box` captions with emphasis, and the SFX cues. Renders the
// MP4 and runs the audio QA (`qa.json`, `qa.png`, `LISTEN.md`) into the evidence folder.
//
//   node scripts/vox-demo.ts --projects-dir <dir> --evidence-dir <dir> [--preset vox/mono-box]
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

  // pictures: two face cutouts and a test-pattern cutout, plus a photo for the stat background
  const work = join(dir, 'demo-src');
  await mkdir(work, { recursive: true });
  cutout(join(FACES, 'face-a.jpg'), join(work, 'cut-a.png'), 'crop=min(iw\\,ih):min(iw\\,ih)');
  cutout(join(FACES, 'face-b.jpg'), join(work, 'cut-b.png'), 'crop=min(iw\\,ih):min(iw\\,ih)');
  execFileSync('ffmpeg', [
    ...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=600x600:duration=1'],
    ...['-frames:v', '1', join(work, 'pattern.png')],
  ]);
  cutout(join(work, 'pattern.png'), join(work, 'cut-c.png'), 'null');
  await copyFile(join(FACES, 'face-a.jpg'), join(work, 'photo.jpg'));
  const ing = await job<{ media: { mediaId: string; path?: string }[] }>(e, 'ingest', {
    projectId,
    inputs: ['cut-a.png', 'cut-b.png', 'cut-c.png', 'photo.jpg'].map((f) => join(work, f)),
    actor: 'cli',
  });
  const [cutA, cutB, cutC, photo] = ing.media.map((m) => m.mediaId) as [
    string,
    string,
    string,
    string,
  ];

  await op({ op: 'updateSequence', args: { sequenceId, styleId: 'vox' } });
  await op({
    op: 'setCaptions',
    args: {
      sequenceId,
      enabled: true,
      preset,
      autoEmphasis: true,
      position: { yPct: preset === 'vox/mono-box' ? 50 : 78 },
    },
  });
  // addSequence creates V1 and V2; the speaker is on V1, the scenes go on V2
  const track = 'V2';

  // 20 s: speaker hook, then a scene every few seconds (speaker share inside 15–35 % is not the aim
  // here; the demo shows every template and transition once)
  const scenes: [number, number, string, Record<string, unknown>, string | null][] = [
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
      'vox/paper-tear',
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
      'vox/slide-paper',
    ],
    [
      10000,
      3000,
      'vox/paper-collage',
      {
        items: [
          { media: cutA, x: 30, y: 30, scale: 0.9, rotate: -8 },
          { media: cutC, x: 70, y: 42, scale: 0.8, rotate: 7 },
          { media: cutB, x: 40, y: 62, scale: 0.85, rotate: 4 },
        ],
        label: 'The footage',
        labelPos: 'top',
      },
      'vox/paper-tear',
    ],
    [
      14000,
      2600,
      'vox/kinetic-serif',
      { text: 'without animating a single frame', emphasis: ['single', 'frame'] },
      'vox/slide-paper',
    ],
    [
      17600,
      2400,
      'base/title',
      { title: 'Vox Studio', subtitle: 'paper collage, by agent' },
      'vox/paper-tear',
    ],
  ];
  for (const [startMs, durationMs, template, variables, tx] of scenes) {
    const r = await op({
      op: 'addScene',
      args: { sequenceId, trackId: track, startMs, durationMs, template, variables },
    });
    const itemId = r.results[0]?.items?.find((i) => i.type === 'scene')?.id;
    if (tx && itemId) {
      await op({
        op: 'setTransition',
        args: { sequenceId, itemId, transition: { template: tx, durationMs: 600 } },
      });
    }
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
