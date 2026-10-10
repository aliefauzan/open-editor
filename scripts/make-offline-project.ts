// Offline fixture project (phase 05 step 10, R7 "offline project"): the checked-in
// `talking-head-20s.mp4` ingested from disk, with its checked-in transcript, shots and facetracks
// seeded into the project, so quick clips, `auto` framing and shot snapping work with no network,
// no mlx-whisper and no Python facetrack. The project is ready to edit: one 9:16 `base` sequence
// "Main" with a linked V1/A1 pair over the whole clip (framing `auto`) and captions on.
//
//   node scripts/make-offline-project.ts --projects-dir <dir> [--name <project name>]
//
// prints `{ projectId, dir, mediaId, sequenceId }` as JSON.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openEngine, type Engine } from '../packages/engine/src/api.ts';
import type { JobInfo } from '../packages/engine/src/jobs.ts';

const REPO = new URL('../', import.meta.url).pathname;
const FX = join(REPO, 'packages', 'engine', 'test', 'fixtures');
export const OFFLINE_MEDIA = join(FX, 'assets', 'media', 'talking-head-20s.mp4');
const SEEDS = { transcripts: 'transcriptPath', shots: 'shotsPath', facetracks: 'facetrackPath' } as const;

export interface OfflineProject {
  projectId: string;
  dir: string;
  mediaId: string;
  sequenceId: string;
}

export async function makeOfflineProject(e: Engine, name = 'Offline'): Promise<OfflineProject> {
  const p = await e.createProject(name);
  const dir = join(e.projectsDir, p.id);
  const ing = (await e.jobs.wait(
    e.jobs.start('ingest', { projectId: p.id, inputs: [OFFLINE_MEDIA], actor: 'cli' }),
  )) as JobInfo<{ media: { mediaId: string }[] }>;
  if (ing.status !== 'done') throw new Error(`ingest failed: ${JSON.stringify(ing.error)}`);
  const mediaId = ing.result!.media[0]!.mediaId;

  const patch: Record<string, string> = {};
  for (const [folder, field] of Object.entries(SEEDS)) {
    const src = join(FX, folder, 'talking-head-20s.json');
    const rel = `${folder}/${mediaId}.json`;
    await mkdir(join(dir, folder), { recursive: true });
    await copyFile(src, join(dir, rel));
    patch[field] = rel;
    if (folder === 'transcripts') {
      patch['transcriptRev'] = createHash('sha256').update(await readFile(src)).digest('hex').slice(0, 16);
    }
  }
  const op = async (o: unknown) => {
    const r = await e.applyOp(p.id, o as never, { actor: 'cli' });
    const bad = r.results.find((x) => x.status !== 'succeeded');
    if (bad) throw new Error(`offline project op failed: ${JSON.stringify(bad)}`);
    return r;
  };
  await op({ op: 'updateMedia', args: { mediaId, patch } });
  const media = (await e.getProject(p.id)).media.find((m) => m.id === mediaId)!;
  const sequenceId = 'seq_main';
  await op({ op: 'addSequence', args: { name: 'Main', id: sequenceId, styleId: 'base' } });
  await op({
    op: 'placeClip',
    args: {
      sequenceId,
      trackId: 'V1',
      mediaId,
      startMs: 0,
      inMs: 0,
      durationMs: media.durationMs,
      withAudio: true,
      frame: { mode: 'auto' },
    },
  });
  await op({ op: 'setCaptions', args: { sequenceId, enabled: true } });
  return { projectId: p.id, dir, mediaId, sequenceId };
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { 'projects-dir': { type: 'string' }, name: { type: 'string' } },
    strict: true,
  });
  const projectsDir = values['projects-dir'];
  if (!projectsDir) throw new Error('Usage: make-offline-project.ts --projects-dir <dir> [--name <name>]');
  const e = openEngine({ projectsDir, stylesDirs: [join(REPO, 'styles')], config: async () => ({}) });
  process.stdout.write(`${JSON.stringify(await makeOfflineProject(e, values.name))}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
