// GATE 8 A/B set (phase 15; round 3): the offline talking-head clip rendered twice, once in `vox`
// and once in an extracted style. Both clips have the same edit: the same cuts, the same punch-ins
// and the same caption chunks and emphasis words, with captions over the footage only (no scene
// templates), so the judge compares the caption look. Each style uses its own default caption
// preset at the preset's position. The two renders get random names (`<prefix>clip-1.mp4`,
// `<prefix>clip-2.mp4`); which is which goes to a separate key file, so the judge sees only the
// clips and the reference.
//
// The script also measures the reference and both clips with the extraction's own measurements
// (palette, caption case/position/length, shot lengths; no LLM) and writes how close each clip is
// to the reference (`<prefix>metrics.json`, clips by their random names only), a contact sheet of
// the clips at the same beats (`<prefix>clips-sheet.jpg`), and the judge's sheet (`--sheet`):
// reference caption frames on top, both clips at the matching beats below (two-tier, single-tier,
// a beat behind the subject, a tracking reveal), and a font strip (reference crop | its mask |
// the chosen font) from `scripts/font-strip.py`. The judge's sheet holds frames of someone else's
// video: keep it out of git.
//
//   node scripts/style-ab.ts --projects-dir <dir> --user-styles <dir> --style <id>
//     --reference <video> --out <dir> --key <file> --sheet <jpg> [--prefix <p>] [--seed <n>]
//     [--ref-ms <ms,...>] [--strip-ms <ms,...>]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  measureReference,
  openEngine,
  type Engine,
  type Measurements,
} from '../packages/engine/src/api.ts';
import type { RenderJobResult } from '../packages/engine/src/export-api.ts';
import type { JobInfo } from '../packages/engine/src/jobs.ts';
import { makeOfflineProject } from './make-offline-project.ts';

const REPO = new URL('../', import.meta.url).pathname;

async function job<T>(e: Engine, name: string, args: unknown): Promise<T> {
  const info = (await e.jobs.wait(e.jobs.start(name as never, args as never))) as JobInfo<T>;
  if (info.status !== 'done') throw new Error(`${name} failed: ${JSON.stringify(info.error)}`);
  return info.result!;
}

/** Cuts on V1 at the speaker's pauses (sequence ms); every second segment gets a punch-in. */
const CUTS = [5420, 11180, 14740];
const PUNCH_IN_SCALE = 1.15;
const PUNCH_IN_SHIFT = 0.09;
const FACETRACK = join(REPO, 'packages/engine/test/fixtures/facetracks/talking-head-20s.json');

/**
 * A fixed punch-in on the speaker, framed off centre: the crop centre sits PUNCH_IN_SHIFT (source
 * widths) left of the mean face centre of the fixture's facetrack in the item, so the face is on
 * the right and part of a centred caption runs over the speaker (where captions can go behind).
 */
function punchIn(startMs: number, endMs: number) {
  const ft = JSON.parse(readFileSync(FACETRACK, 'utf8')) as {
    samples: { atMs: number; faces: { x: number; y: number; w: number; h: number }[] }[];
  };
  const c = ft.samples
    .filter((s) => s.atMs >= startMs && s.atMs < endMs && s.faces.length > 0)
    .map((s) => s.faces[0]!);
  const mean = (f: (b: (typeof c)[number]) => number) =>
    Math.round((c.reduce((a, b) => a + f(b), 0) / Math.max(1, c.length)) * 1e4) / 1e4;
  return {
    mode: 'manual',
    x: (c.length ? mean((b) => b.x + b.w / 2) : 0.5) - PUNCH_IN_SHIFT,
    y: c.length ? mean((b) => b.y + b.h / 2) : 0.4,
    scale: PUNCH_IN_SCALE,
  } as const;
}

/**
 * Caption edit of the fixture transcript (word index in its `words` array): emphasis on key words,
 * and chunk breaks with 11 characters a line so that two-tier beats (a plain line above a boxed
 * line: "into a / SHORT CLIP.", "the best / MOMENTS", "a few sound / EFFECTS.", "a vertical /
 * VIDEO", "this quick / TEST."), plain beats and single-word beats ("Hello,", "First,",
 * "Finally,") all occur.
 */
const EMPHASIS = [6, 7, 18, 19, 26, 39, 45, 56, 67];
const BREAK_AFTER = [0, 5, 12, 15, 21, 23, 26, 33, 35, 48, 50, 53, 56];

/** Beat times on the clip sheets (sequence ms): two-tier, plain, behind the subject, reveal. */
const BEAT_MS = { twoTier: 5150, plain: 3500, behind: 7650, reveal: 14440 };

export async function renderIn(e: Engine, styleId: string, file: string): Promise<RenderJobResult> {
  const { projectId, sequenceId, mediaId } = await makeOfflineProject(e, `A/B ${styleId}`);
  const op = async (o: unknown) => {
    const r = await e.applyOp(projectId, o as never, { actor: 'cli' });
    const bad = r.results.find((x) => x.status !== 'succeeded');
    if (bad) throw new Error(`A/B op failed: ${JSON.stringify(bad)}`);
  };
  await op({ op: 'updateSequence', args: { sequenceId, styleId } });

  // the same cuts and punch-ins in both clips
  const v1 = () =>
    e
      .getProject(projectId)
      .then((p) =>
        [
          ...p.sequences.find((s) => s.id === sequenceId)!.videoTracks.find((t) => t.id === 'V1')!
            .items,
        ].sort((a, b) => a.startMs - b.startMs),
      );
  for (const atMs of CUTS) {
    const item = (await v1()).find((i) => i.startMs < atMs && i.startMs + i.durationMs > atMs)!;
    await op({ op: 'splitItem', args: { sequenceId, itemId: item.id, atMs } });
  }
  for (const [n, item] of (await v1()).entries()) {
    if (n % 2 === 1 && item.type === 'media') {
      await op({
        op: 'updateClip',
        args: {
          sequenceId,
          itemId: item.id,
          frame: punchIn(item.inMs, item.inMs + item.durationMs),
        },
      });
    }
  }

  // each style with its own default caption preset at the preset's position (a sequence keeps its
  // own caption position otherwise: 75 %); the same chunks and emphasis words in both
  const media = (await e.getProject(projectId)).media.find((m) => m.id === mediaId)!;
  const key = (i: number) => `${mediaId}:${media.transcriptRev}:${i}`;
  const overrides = [...new Set([...EMPHASIS, ...BREAK_AFTER])].map((i) => ({
    wordKey: key(i),
    ...(EMPHASIS.includes(i) ? { emphasis: true } : {}),
    ...(BREAK_AFTER.includes(i) ? { breakAfter: true } : {}),
  }));
  const resolved = e.styles.get(styleId);
  const preset = resolved.style.captions.default;
  const position = resolved.captionPresets[preset]?.position;
  await op({
    op: 'setCaptions',
    args: {
      sequenceId,
      enabled: true,
      preset,
      autoEmphasis: false,
      maxWords: 4,
      maxCharsPerLine: 11,
      maxLines: 2,
      overrides,
      ...(position && { position }),
    },
  });
  return job<RenderJobResult>(e, 'render', {
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

const TILE =
  'scale=270:480:force_original_aspect_ratio=decrease,pad=270:480:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1';

/** A grid of single frames: one row per file, one column per time, 270×480 tiles. */
function sheet(rows: { file: string; ms: number[] }[], out: string): void {
  const args: string[] = ['-v', 'error', '-y'];
  const cols = Math.max(...rows.map((r) => r.ms.length));
  const n = rows.length * cols;
  const f: string[] = [];
  let input = 0;
  rows.forEach((r, row) => {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const ms = r.ms[col];
      if (ms === undefined) {
        f.push(`color=c=black:s=270x480:d=1,trim=end_frame=1[v${i}]`);
        continue;
      }
      args.push('-ss', String(ms / 1000), '-i', r.file);
      f.push(`[${input++}:v]${TILE},trim=end_frame=1[v${i}]`);
    }
  });
  const layout = [...Array(n).keys()]
    .map((i) => `${(i % cols) * 270}_${Math.floor(i / cols) * 480}`)
    .join('|');
  f.push(
    `${[...Array(n).keys()].map((i) => `[v${i}]`).join('')}xstack=inputs=${n}:layout=${layout}`,
  );
  args.push('-filter_complex', f.join(';'), '-frames:v', '1', '-q:v', '3', out);
  execFileSync('ffmpeg', args);
}

/** `top` above `bottom`, the bottom image scaled to the top's width. */
function stack(top: string, bottom: string, width: number, out: string): void {
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    top,
    '-i',
    bottom,
    '-filter_complex',
    `[1:v]scale=${width}:-2,setsar=1[b];[0:v]setsar=1[a];[a][b]vstack=inputs=2`,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    out,
  ]);
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
      sheet: { type: 'string' },
      prefix: { type: 'string' },
      'ref-ms': { type: 'string' },
      'strip-ms': { type: 'string' },
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
    'sheet',
  ] as const;
  for (const k of need) {
    if (!values[k]) throw new Error(`Usage: style-ab.ts --${need.join(' <…> --')} <…> [--seed n]`);
  }
  const prefix = values.prefix ?? 'ab-round3-';
  const e = openEngine({
    projectsDir: values['projects-dir']!,
    stylesDirs: [join(REPO, 'styles'), values['user-styles']!],
    config: async () => ({}),
  });
  const work = await mkdtemp(join(tmpdir(), 'vox-ab-'));
  const styles = ['vox', values.style!];
  const files: Record<string, string> = {};
  const rendered: Record<string, RenderJobResult> = {};
  for (const s of styles) {
    files[s] = join(work, `${s}.mp4`);
    rendered[s] = await renderIn(e, s, files[s]);
  }
  // the extracted style must have put captions behind the subject somewhere, or the A/B misses it
  const behind = rendered[values.style!]!.files[0]?.behindSubject;
  if (!behind || 'skipped' in behind) {
    throw new Error(`behind-subject step did not run: ${JSON.stringify(behind ?? null)}`);
  }
  // the behind column: "the best / MOMENTS" when that beat went behind, else the first such beat
  const near = behind.atMs.some((t) => Math.abs(t - BEAT_MS.behind) <= 500);
  const behindMs = near ? BEAT_MS.behind : (behind.atMs[0] ?? BEAT_MS.behind);

  // blind names: the order is random unless --seed picks it (0: vox first, 1: extracted first)
  const flip = values.seed === undefined ? randomInt(2) === 1 : Number(values.seed) % 2 === 1;
  const order = flip ? [styles[1]!, styles[0]!] : styles;
  const out = values.out!;
  await mkdir(out, { recursive: true });
  const clips = order.map((s, i) => ({ name: `clip-${i + 1}`, style: s }));
  const clipFile = (name: string) => join(out, `${prefix}${name}.mp4`);
  for (const c of clips) await copyFile(files[c.style]!, clipFile(c.name));
  await writeFile(
    values.key!,
    `${JSON.stringify({ clips: Object.fromEntries(clips.map((c) => [c.name, c.style])) }, null, 2)}\n`,
  );

  // measurements of the reference and both clips, by the extraction's own measure step
  const scratch = await e.createProject('A/B measure');
  const ing = await job<{ media: { mediaId: string }[] }>(e, 'ingest', {
    projectId: scratch.id,
    inputs: [values.reference!, ...clips.map((c) => clipFile(c.name))],
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
  const beats = { ...BEAT_MS, behind: behindMs };
  const metrics = {
    reference: {
      palette: ref.palette.slice(0, 5).map((c) => c.hex),
      captions: ref.captions.summary,
      medianShotMs: ref.shotStats.medianMs,
    },
    clips: Object.fromEntries(clips.map((c, i) => [c.name, compare(ref, m[i + 1]!)])),
    beatsMs: beats,
    behindSubject: { beats: behind.beats, of: behind.of, atMs: behind.atMs },
  };
  await writeFile(join(out, `${prefix}metrics.json`), `${JSON.stringify(metrics, null, 2)}\n`);

  // sheets: the clips alone (safe to commit), and the judge's sheet with the reference on top
  const beatMs = [beats.twoTier, beats.plain, beats.behind, beats.reveal];
  const clipRows = clips.map((c) => ({ file: clipFile(c.name), ms: beatMs }));
  sheet(clipRows, join(out, `${prefix}clips-sheet.jpg`));
  // reference: two-tier "it was a MASTERCLASS", the single word "Bad" tracking in over a framed
  // photo, "wasn't" behind the microphone, "artist" under the chain pendant
  const refMs = (values['ref-ms'] ?? '9000,3400,12200,26300').split(',').map(Number);
  const grid = join(work, 'grid.jpg');
  sheet([{ file: values.reference!, ms: refMs }, ...clipRows], grid);
  const strip = join(work, 'strip.jpg');
  const fonts = await fontArgs(e, values.style!);
  execFileSync(
    'uv',
    [
      'run',
      '--project',
      join(REPO, 'py'),
      'python',
      '-I',
      join(REPO, 'scripts', 'font-strip.py'),
      '--video',
      values.reference!,
      '--ms',
      values['strip-ms'] ?? '9000,33750',
      '--tier1',
      fonts.tier1,
      '--tier2',
      fonts.tier2,
      '--out',
      strip,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  await mkdir(dirname(values.sheet!), { recursive: true });
  stack(grid, strip, Math.max(...[refMs, beatMs].map((r) => r.length)) * 270, values.sheet!);
  process.stdout.write(`${JSON.stringify({ out, metrics, sheet: values.sheet }, null, 2)}\n`);
}

/**
 * The font strip's fonts from the extracted style: the tier 1 face (its italic file when the
 * preset sets tier 1 in italic) and the tier 2 caption font, with the preset's tracking and stretch.
 */
async function fontArgs(e: Engine, styleId: string): Promise<{ tier1: string; tier2: string }> {
  const r = e.styles.get(styleId);
  const preset = r.captionPresets[r.style.captions.default];
  const html = preset ? await readFile(preset.htmlPath, 'utf8') : '';
  const look = (name: string) =>
    /\{([^}]*)\}/.exec(new RegExp(`var ${name} = \\{[^}]*\\}`).exec(html)?.[0] ?? '')?.[1] ?? '';
  const num = (obj: string, key: string, dflt: string) =>
    new RegExp(`${key}:\\s*(-?[\\d.]+)`).exec(obj)?.[1] ?? dflt;
  const t1 = look('T1');
  const t2 = look('T2');
  const body = r.files.fonts.body;
  const italic = body.replace(/-Regular(\.\w+)$/, '-Italic$1');
  const useItalic = /font-style:\s*italic/.test(html) && italic !== body && existsSync(italic);
  return {
    tier1: `${useItalic ? italic : body}:${num(t1, 'track', '0')}`,
    tier2: `${r.files.fonts.caption}:${num(t2, 'track', '0')}:${num(t2, 'stretch', '1')}`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  });
}
