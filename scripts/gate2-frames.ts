// GATE 2 frame check (phase 05 step 14, engine done-when 10, plan D-15): the quick clips of a project
// made from a counter fixture (`ntsc-2997-20s.mp4`, `phone-vfr-20s.mp4`; make.sh burns a 16-bit
// barcode of the source frame index at 40,40 640×40) render with every frame showing the expected
// reference frame: the frame at the same index of the media's reference picture, which is the
// engine's CFR copy for a VFR source (ingest's fixed-rate conversion) and the source itself otherwise.
// The clip's framing is set to `contain` for the check (one batch, undone afterwards), so the counter
// stays on screen whatever the `auto` crop chose; timing is what is being checked.
//
//   node scripts/gate2-frames.ts --projects-dir <dir> --project <id> --out <report.json> [--work <dir>]
//
// Exit code 0 when every rendered frame decodes to its expected source frame.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { decodeBits, margin, CELLS } from '../spike/lib/barcode.ts';
import { grayStream, probeFrames } from '../spike/bench/lib.ts';
import { openEngine, type Engine } from '../packages/engine/src/api.ts';
import type { JobInfo } from '../packages/engine/src/jobs.ts';

const REPO = new URL('../', import.meta.url).pathname;

export interface ClipFrames {
  sequenceId: string;
  fps: string;
  inMs: number;
  /** The reference file the expected counters were read from (project-relative). */
  reference: string;
  firstSourceFrame: number;
  frames: number;
  checked: number;
  mismatches: { f: number; expected: number; got: number }[];
  minMargin: number;
}

/** The source counter box (40, 40, 640×40) framed `contain` on the canvas. */
function counterCrop(
  src: { width: number; height: number },
  canvas: { width: number; height: number },
) {
  const s = Math.min(canvas.width / src.width, canvas.height / src.height);
  const x0 = (canvas.width - src.width * s) / 2;
  const y0 = (canvas.height - src.height * s) / 2;
  return [
    Math.round(x0 + 40 * s),
    Math.round(y0 + 40 * s),
    Math.round(640 * s),
    Math.floor(40 * s),
  ] as const;
}

export async function checkQuickFrames(
  e: Engine,
  projectId: string,
  work: string,
): Promise<ClipFrames[]> {
  const p = await e.getProject(projectId);
  const clips = p.sequences.flatMap((s) => {
    const it = s.videoTracks[0]?.items[0];
    return it && it.type === 'media' ? [{ s, it }] : [];
  });
  const r = await e.applyOp(
    projectId,
    {
      op: 'batch',
      args: {
        ops: clips.map(({ s, it }) => ({
          op: 'updateClip',
          args: { sequenceId: s.id, itemId: it.id, frame: { mode: 'contain' } },
        })),
      },
    } as never,
    { actor: 'cli' },
  );
  if (r.results.some((x) => x.status !== 'succeeded'))
    throw new Error(`updateClip failed: ${JSON.stringify(r.results)}`);
  const out: ClipFrames[] = [];
  try {
    for (const { s, it } of clips) {
      const media = p.media.find((m) => m.id === it.mediaId)!;
      const file = join(work, `${s.id}.mp4`);
      const job = (await e.jobs.wait(
        e.jobs.start('render', {
          projectId,
          sequenceId: s.id,
          quality: 'draft',
          target: { file },
          overwrite: true,
        }),
      )) as JobInfo;
      if (job.status !== 'done') throw new Error(`render ${s.id}: ${JSON.stringify(job.error)}`);
      const { frames } = await probeFrames(file);
      const raw = await grayStream(
        file,
        counterCrop({ width: media.width!, height: media.height! }, s.canvas),
        CELLS,
        1,
      );
      const { num, den } = s.canvas.fps;
      const first = Math.round((it.inMs * num) / (den * 1000));
      const reference = media.cfrPath ?? media.path;
      const refRaw = await grayStream(
        join(e.projectsDir, projectId, reference),
        [40, 40, 640, 40],
        CELLS,
        1,
      );
      const expectedAt = (k: number) => decodeBits(refRaw.subarray(k * CELLS, (k + 1) * CELLS));
      const rep: ClipFrames = {
        sequenceId: s.id,
        fps: `${num}/${den}`,
        inMs: it.inMs,
        reference,
        firstSourceFrame: first,
        frames,
        checked: 0,
        mismatches: [],
        minMargin: 255,
      };
      for (let f = 0; f < frames; f++) {
        const cells = raw.subarray(f * CELLS, (f + 1) * CELLS);
        const got = decodeBits(cells);
        rep.checked++;
        rep.minMargin = Math.min(rep.minMargin, margin(cells));
        const expected = expectedAt(first + f);
        if (got !== expected) rep.mismatches.push({ f, expected, got });
      }
      out.push(rep);
    }
  } finally {
    await e.undo(projectId, { actor: 'cli' });
  }
  return out;
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'projects-dir': { type: 'string' },
      project: { type: 'string' },
      out: { type: 'string' },
      work: { type: 'string' },
    },
    strict: true,
  });
  const { 'projects-dir': projectsDir, project, out } = values;
  if (!projectsDir || !project || !out) {
    throw new Error(
      'Usage: gate2-frames.ts --projects-dir <dir> --project <id> --out <report.json> [--work <dir>]',
    );
  }
  const e = openEngine({
    projectsDir,
    stylesDirs: [join(REPO, 'styles')],
    config: async () => ({}),
  });
  const work = values.work ?? mkdtempSync(join(tmpdir(), 'vox-gate2-frames-'));
  mkdirSync(work, { recursive: true });
  const clips = await checkQuickFrames(e, project, work);
  const pass =
    clips.length > 0 && clips.every((c) => c.mismatches.length === 0 && c.checked === c.frames);
  writeFileSync(
    out,
    `${JSON.stringify({ projectId: project, pass, clips: clips.map((c) => ({ ...c, mismatches: c.mismatches.slice(0, 20) })) }, null, 2)}\n`,
  );
  return pass ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
