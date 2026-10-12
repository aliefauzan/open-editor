// GATE 8 A/B set (phase 15 step 7): the offline talking-head clip rendered twice, once in `vox` and
// once in an extracted style, with the same scenes (map, stat, kinetic text, end title) and each
// style's own default caption preset. The two renders get random names (`clip-1.mp4`, `clip-2.mp4`);
// which is which goes to a separate key file, so the judge sees only the clips and the reference.
//
// The script also measures the reference and both clips with the extraction's own measurements
// (palette, caption case/position/length, shot lengths; no LLM) and writes how close each clip is
// to the reference (`metrics.json`, clips by their random names only), plus a contact sheet of the
// clips at the scene times (`clips-sheet.jpg`) and one with reference frames on top
// (`--ref-out`; keep it out of git: it holds frames of someone else's video).
//
//   node scripts/style-ab.ts --projects-dir <dir> --user-styles <dir> --style <id>
//     --reference <video> --out <dir> --key <file> --ref-out <dir> [--seed <n>]
import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  measureReference,
  openEngine,
  type Engine,
  type Measurements,
} from '../packages/engine/src/api.ts';
import type { JobInfo } from '../packages/engine/src/jobs.ts';
import { makeOfflineProject } from './make-offline-project.ts';

const REPO = new URL('../', import.meta.url).pathname;

async function job<T>(e: Engine, name: string, args: unknown): Promise<T> {
  const info = (await e.jobs.wait(e.jobs.start(name as never, args as never))) as JobInfo<T>;
  if (info.status !== 'done') throw new Error(`${name} failed: ${JSON.stringify(info.error)}`);
  return info.result!;
}

/** The same 20 s edit in any style: start, duration, template, variables. */
const SCENES: [number, number, string, Record<string, unknown>][] = [
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
  ],
  [6200, 2800, 'vox/stat', { value: '2 billion cups.', line2: 'Every single day.' }],
  [14000, 2600, 'vox/kinetic-serif', { text: 'without a single frame', emphasis: ['single'] }],
  [17600, 2400, 'base/title', { title: 'Vox Studio', subtitle: 'style A/B' }],
];

/** Frame times shown on the sheets: speaker + caption, map, stat, speaker + caption, kinetic text. */
const SHEET_MS = [1000, 3800, 7600, 11000, 15000];

async function renderIn(e: Engine, styleId: string, file: string): Promise<void> {
  const { projectId, sequenceId } = await makeOfflineProject(e, `A/B ${styleId}`);
  const op = async (o: unknown) => {
    const r = await e.applyOp(projectId, o as never, { actor: 'cli' });
    const bad = r.results.find((x) => x.status !== 'succeeded');
    if (bad) throw new Error(`A/B op failed: ${JSON.stringify(bad)}`);
  };
  // each style with its own default caption preset at the preset's position (a sequence keeps its own
  // caption position otherwise: 75 %)
  const resolved = e.styles.get(styleId);
  const preset = resolved.style.captions.default;
  const position = resolved.captionPresets[preset]?.position;
  await op({ op: 'updateSequence', args: { sequenceId, styleId } });
  await op({
    op: 'setCaptions',
    args: { sequenceId, enabled: true, preset, autoEmphasis: true, ...(position && { position }) },
  });
  for (const [startMs, durationMs, template, variables] of SCENES) {
    await op({
      op: 'addScene',
      args: { sequenceId, trackId: 'V2', startMs, durationMs, template, variables },
    });
  }
  await job(e, 'render', {
    projectId,
    sequenceId,
    target: { file },
    overwrite: true,
    quality: 'standard',
  });
}

// ---- similarity to the reference (lower distance = closer) ----

function lab(rgb: readonly number[]): [number, number, number] {
  const lin = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const x = (0.4124 * lin[0] + 0.3576 * lin[1] + 0.1805 * lin[2]) / 0.95047;
  const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  const z = (0.0193 * lin[0] + 0.1192 * lin[1] + 0.9505 * lin[2]) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** Share-weighted mean distance (CIE76 ΔE) from each colour of `a` to its nearest colour in `b`. */
function paletteDistance(a: Measurements['palette'], b: Measurements['palette']): number {
  const lb = b.map((c) => lab(c.rgb));
  let sum = 0;
  let w = 0;
  for (const c of a) {
    const la = lab(c.rgb);
    const d = Math.min(...lb.map((x) => Math.hypot(x[0] - la[0], x[1] - la[1], x[2] - la[2])));
    sum += d * c.share;
    w += c.share;
  }
  return w > 0 ? sum / w : 0;
}

function compare(ref: Measurements, clip: Measurements) {
  const rc = ref.captions.summary;
  const cc = clip.captions.summary;
  // symmetric: the reference's colours in the clip, and the clip's colours in the reference
  const palette =
    (paletteDistance(ref.palette, clip.palette) + paletteDistance(clip.palette, ref.palette)) / 2;
  return {
    paletteDeltaE: Math.round(palette * 10) / 10,
    captionDetected: cc.detected,
    ...(rc.detected && cc.detected
      ? {
          captionCaseMatch: rc.case === cc.case,
          captionCase: cc.case,
          captionYPctDiff: Math.abs(rc.yPct - cc.yPct),
          wordsPerCaptionDiff:
            Math.round(Math.abs(rc.wordsPerCaption - cc.wordsPerCaption) * 10) / 10,
        }
      : {}),
    medianShotRatio:
      Math.round(
        (Math.max(ref.shotStats.medianMs, clip.shotStats.medianMs) /
          Math.max(1, Math.min(ref.shotStats.medianMs, clip.shotStats.medianMs))) *
          100,
      ) / 100,
    palette: clip.palette.slice(0, 5).map((c) => c.hex),
  };
}

function sheet(rows: { file: string; ms: number[] }[], out: string): void {
  const fit =
    'scale=270:480:force_original_aspect_ratio=decrease,pad=270:480:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1';
  const args: string[] = ['-v', 'error', '-y'];
  const cols = rows[0]!.ms.length;
  for (const r of rows) for (const ms of r.ms) args.push('-ss', String(ms / 1000), '-i', r.file);
  const n = rows.length * cols;
  const f = [...Array(n).keys()].map((i) => `[${i}:v]${fit},trim=end_frame=1[v${i}]`);
  const layout = [...Array(n).keys()]
    .map((i) => `${(i % cols) * 270}_${Math.floor(i / cols) * 480}`)
    .join('|');
  f.push(
    `${[...Array(n).keys()].map((i) => `[v${i}]`).join('')}xstack=inputs=${n}:layout=${layout}`,
  );
  args.push('-filter_complex', f.join(';'), '-frames:v', '1', '-q:v', '3', out);
  execFileSync('ffmpeg', args);
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'projects-dir': { type: 'string' },
      'user-styles': { type: 'string' },
      style: { type: 'string' },
      reference: { type: 'string' },
      out: { type: 'string' },
      key: { type: 'string' },
      'ref-out': { type: 'string' },
      'ref-ms': { type: 'string' },
      seed: { type: 'string' },
    },
    strict: true,
  });
  const need = [
    'projects-dir',
    'user-styles',
    'style',
    'reference',
    'out',
    'key',
    'ref-out',
  ] as const;
  for (const k of need) {
    if (!values[k]) throw new Error(`Usage: style-ab.ts --${need.join(' <…> --')} <…> [--seed n]`);
  }
  const e = openEngine({
    projectsDir: values['projects-dir']!,
    stylesDirs: [join(REPO, 'styles'), values['user-styles']!],
    config: async () => ({}),
  });
  const work = await mkdtemp(join(tmpdir(), 'vox-ab-'));
  const styles = ['vox', values.style!];
  const files: Record<string, string> = {};
  for (const s of styles) {
    files[s] = join(work, `${s}.mp4`);
    await renderIn(e, s, files[s]);
  }

  // blind names: the order is random unless --seed picks it (0: vox first, 1: extracted first)
  const flip = values.seed === undefined ? randomInt(2) === 1 : Number(values.seed) % 2 === 1;
  const order = flip ? [styles[1]!, styles[0]!] : styles;
  const out = values.out!;
  await mkdir(out, { recursive: true });
  const clips = order.map((s, i) => ({ name: `clip-${i + 1}`, style: s }));
  for (const c of clips) await copyFile(files[c.style]!, join(out, `${c.name}.mp4`));
  await writeFile(
    values.key!,
    `${JSON.stringify({ clips: Object.fromEntries(clips.map((c) => [c.name, c.style])) }, null, 2)}\n`,
  );

  // measurements of the reference and both clips, by the extraction's own measure step
  const scratch = await e.createProject('A/B measure');
  const ing = await job<{ media: { mediaId: string }[] }>(e, 'ingest', {
    projectId: scratch.id,
    inputs: [values.reference!, ...clips.map((c) => join(out, `${c.name}.mp4`))],
    proxies: false,
    actor: 'cli',
  });
  const m: Measurements[] = [];
  for (const [i, x] of ing.media.entries()) {
    m.push(
      await measureReference(e, {
        projectId: scratch.id,
        mediaId: x.mediaId,
        workDir: join(work, `measure-${i}`),
      }),
    );
  }
  const ref = m[0]!;
  const metrics = {
    reference: {
      palette: ref.palette.slice(0, 5).map((c) => c.hex),
      captions: ref.captions.summary,
      medianShotMs: ref.shotStats.medianMs,
    },
    clips: Object.fromEntries(clips.map((c, i) => [c.name, compare(ref, m[i + 1]!)])),
  };
  await writeFile(join(out, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);

  const clipRows = clips.map((c) => ({ file: join(out, `${c.name}.mp4`), ms: SHEET_MS }));
  sheet(clipRows, join(out, 'clips-sheet.jpg'));
  const refMs = (values['ref-ms'] ?? '9000,23500,35500,51500,56500').split(',').map(Number);
  await mkdir(values['ref-out']!, { recursive: true });
  sheet(
    [{ file: values.reference!, ms: refMs }, ...clipRows],
    join(values['ref-out']!, 'ab-sheet.jpg'),
  );
  process.stdout.write(`${JSON.stringify({ out, metrics }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  });
}
