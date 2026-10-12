// GATE 6 round 3 (phase 14a, D-67 / D-71): renders stills of the four v1.1 vox templates with real
// public-domain pictures (docs/evidence/phase-14a/r3-inputs/, see SOURCES.md there) in a 1080x1920
// sequence, for scripts/vox-side-by-side-v11.sh. Writes into <out>:
//   year-card.png, framed-portrait.png (painting in the frame), framed-portrait-gone.png (stamp),
//   newspaper.png, stack.png (year-card, stat, newspaper: reel 9.6 s), stack-portrait.png (year-card,
//   stat, framed-portrait: reel 8.6 s), each 1080x1920.
//
//   node scripts/vox-gate6-r3.ts --projects-dir <dir> --out <dir>
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openEngine, type Engine } from '../packages/engine/src/api.ts';
import type { JobInfo } from '../packages/engine/src/jobs.ts';

const REPO = new URL('../', import.meta.url).pathname;
const PICS = join(REPO, 'docs', 'evidence', 'phase-14a', 'r3-inputs');

async function ingest(e: Engine, projectId: string, files: string[]): Promise<string[]> {
  const j = (await e.jobs.wait(
    e.jobs.start('ingest', { projectId, inputs: files.map((f) => join(PICS, f)), actor: 'cli' }),
  )) as JobInfo<{ media: { mediaId: string }[] }>;
  if (j.status !== 'done') throw new Error(`ingest failed: ${JSON.stringify(j.error)}`);
  return j.result!.media.map((m) => m.mediaId);
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { 'projects-dir': { type: 'string' }, out: { type: 'string' } },
    strict: true,
  });
  const projectsDir = values['projects-dir'];
  const out = values.out;
  if (!projectsDir || !out)
    throw new Error('Usage: vox-gate6-r3.ts --projects-dir <dir> --out <dir>');
  const e = openEngine({
    projectsDir,
    stylesDirs: [join(REPO, 'styles')],
    config: async () => ({}),
  });
  const p = await e.createProject('GATE 6 round 3');
  const projectId = p.id;
  const op = async (o: unknown) => {
    const r = await e.applyOp(projectId, o as never, { actor: 'cli' });
    const bad = r.results.find((x) => x.status !== 'succeeded');
    if (bad) throw new Error(`op failed: ${JSON.stringify(bad)}`);
  };
  const [comet, lines, mona, coffee] = (await ingest(e, projectId, [
    'comet.jpg',
    'comet-lines.png',
    'mona.jpg',
    'coffee-house.jpg',
  ])) as [string, string, string, string];
  const sequenceId = 'seq_g6';
  await op({ op: 'addSequence', args: { name: 'GATE 6', id: sequenceId, styleId: 'vox' } });

  const year = { year: '1952', tag: 'De Havilland Comet', photo: comet, blueprint: lines };
  const frame = {
    media: mona,
    frame: 'gold',
    stamp: 'GONE',
    empty: true,
    tag: 'The Louvre · August 21, 1911',
  };
  const news = {
    headline: 'La Joconde a disparu',
    subhead: "Le chef-d'oeuvre de Léonard volé au Louvre",
    photo: mona,
    date: '23 août 1911',
    language: 'fr',
  };
  const stat = {
    value: '2 billion cups.',
    line2: 'Every single day.',
    bgPhoto: coffee,
    tag: "The world's coffee habit",
    bg: 'paper',
  };
  // start, duration, template, variables; stills: [name, ms after the scene start]
  const scenes: [number, number, string, Record<string, unknown>, [string, number][]][] = [
    [0, 3000, 'vox/year-card', year, [['year-card', 2400]]],
    [
      3000,
      3200,
      'vox/framed-portrait',
      frame,
      [
        ['framed-portrait', 900],
        ['framed-portrait-gone', 2900],
      ],
    ],
    [6200, 3000, 'vox/newspaper', news, [['newspaper', 2400]]],
    [
      9200,
      3200,
      'vox/stack',
      {
        panels: [
          { template: 'vox/year-card', variables: year },
          { template: 'vox/stat', variables: stat },
          { template: 'vox/newspaper', variables: news },
        ],
      },
      [['stack', 2900]],
    ],
    [
      12400,
      3200,
      'vox/stack',
      {
        panels: [
          { template: 'vox/year-card', variables: year },
          { template: 'vox/stat', variables: stat },
          { template: 'vox/framed-portrait', variables: frame },
        ],
      },
      [
        ['stack-portrait', 900],
        ['stack-portrait-gone', 2900],
      ],
    ],
  ];
  const shots: [string, number][] = [];
  for (const [startMs, durationMs, template, variables, stills] of scenes) {
    await op({
      op: 'addScene',
      args: { sequenceId, trackId: 'V1', startMs, durationMs, template, variables },
    });
    for (const [name, at] of stills) shots.push([name, startMs + at]);
  }
  const files = await e.frames(
    projectId,
    sequenceId,
    shots.map(([, at]) => at),
  );
  await mkdir(out, { recursive: true });
  for (let i = 0; i < shots.length; i++) {
    await copyFile(files[i]!, join(out, `${shots[i]![0]}.png`));
  }
  process.stdout.write(`${JSON.stringify({ projectId, stills: shots.map(([n]) => n) })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  });
}
