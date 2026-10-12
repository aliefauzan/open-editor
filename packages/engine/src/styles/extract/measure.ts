// Styles Part C step 2, "Measure" (no LLM; styles spec "Part C", plan phase 15, D-15): on a media
// item of a scratch project (ingested with `{ proxies: false }`), run the engine `shots` stage (no
// scene detection of its own), `facetrack` for the speaker share, pick keyframes (one per shot plus
// one per 2 s), write contact sheets, and run the Python `palette` (k-means, k = 8) and `ocr`
// (Apple Vision, 4 fps) tools, then `fontmatch` (caption fonts and look per tier). Keyframes and sheets go to `workDir` (the caller decides where; the
// reference is never copied into a style's assets).
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Engine } from '../../api.ts';
import { VoxError, isVoxError } from '../../errors.ts';
import { projectDirFor, resolveProjectPath } from '../../paths.ts';
import { repoPyProject, runPyTool, type PyBridgeOptions } from '../../py.ts';
import { DetectionsSchema } from '../../stages/facetrack.ts';
import { FORMAT_WHITELIST } from '../../stages/media/ffargs.ts';
import { runTool } from '../../stages/media/run.ts';
import { sniffFile } from '../../stages/media/sniff.ts';
import { ShotListSchema, type Shot } from '../../stages/shots.ts';
import { loadFontCatalogue, type FontCatalogue } from './catalogue.ts';
import {
  captionFonts,
  CaptionFontsSchema,
  fontCandidates,
  FontMatchResultSchema,
  fontSamples,
  occlusionSamples,
  trackingReveals,
  type CaptionFonts,
} from './fontmatch.ts';

/** One keyframe every this many ms, besides one per shot. */
export const KEYFRAME_EVERY_MS = 2000;
/** `mediaFrames` takes at most 100 times. */
export const MAX_KEYFRAMES = 100;
/** Frames per contact sheet (6 × 2) and sheets sent to the vision model. */
export const SHEET_COLS = 6;
export const SHEET_ROWS = 2;
export const MAX_SHEETS = 4;
/** OCR sampling rate (styles spec: 4 fps). */
export const OCR_FPS = 4;
export const PALETTE_K = 8;

const hex = z.string().regex(/^#[0-9A-F]{6}$/);
const Box = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});
const Case = z.enum(['upper', 'lower', 'asis']);

// ---- Python tool results (py/tests/schemas/palette.result.json, ocr.result.json) ----

export const PaletteColorSchema = z.strictObject({
  hex,
  rgb: z.tuple([z.int().min(0).max(255), z.int().min(0).max(255), z.int().min(0).max(255)]),
  share: z.number().gt(0).max(1),
  lightness: z.number().min(0).max(1),
  saturation: z.number().min(0).max(1),
});
export type PaletteColor = z.infer<typeof PaletteColorSchema>;

export const PaletteResultSchema = z.strictObject({
  colors: z.array(PaletteColorSchema).min(1).max(16),
  frames: z.int().min(1),
  k: z.int().min(2).max(16),
});

const OcrCaptionSchema = z.strictObject({
  text: z.string().min(1),
  box: Box,
  startMs: z.int().nonnegative(),
  endMs: z.int().nonnegative(),
  reveal: z.boolean(),
  words: z.int().nonnegative(),
  case: Case,
});

export const CaptionSummarySchema = z.union([
  z.strictObject({ detected: z.literal(false), captionCount: z.literal(0) }),
  z.strictObject({
    detected: z.literal(true),
    captionCount: z.int().min(1),
    wordsPerCaption: z.number().nonnegative(),
    yPct: z.number().min(0).max(100),
    case: Case,
    revealShare: z.number().min(0).max(1),
    medianCaptionMs: z.int().nonnegative(),
  }),
]);
export type CaptionSummary = z.infer<typeof CaptionSummarySchema>;

export const OcrResultSchema = z.strictObject({
  fps: z.number().positive(),
  width: z.int().positive(),
  height: z.int().positive(),
  durationMs: z.int().nonnegative(),
  frames: z.array(
    z.strictObject({
      atMs: z.int().nonnegative(),
      lines: z.array(
        z.strictObject({ text: z.string(), box: Box, confidence: z.number().min(0).max(1) }),
      ),
    }),
  ),
  static: z.array(z.string()),
  captions: z.array(OcrCaptionSchema),
  summary: CaptionSummarySchema,
});

// ---- measurements ----

export const MeasurementsSchema = z.strictObject({
  durationMs: z.int().positive(),
  width: z.int().positive(),
  height: z.int().positive(),
  shots: z.array(
    z.strictObject({
      startMs: z.int().nonnegative(),
      endMs: z.int().positive(),
      /** A face in at least half of the shot's facetrack samples; null without facetrack. */
      speaker: z.boolean().nullable(),
    }),
  ),
  shotStats: z.strictObject({
    count: z.int().min(1),
    meanMs: z.int().positive(),
    medianMs: z.int().positive(),
    p10Ms: z.int().positive(),
    p90Ms: z.int().positive(),
  }),
  keyframes: z.array(
    z.strictObject({
      atMs: z.int().nonnegative(),
      kind: z.enum(['shot', 'interval']),
      /** Absolute path of the JPEG in `workDir`. */
      file: z.string(),
    }),
  ),
  /** Absolute paths of the contact sheets (JPEG, 6 × 2 keyframes each). */
  sheets: z.array(z.string()),
  palette: z.array(PaletteColorSchema),
  /** Share of the duration in shots with a speaker; null when facetrack could not run. */
  speakerRatio: z.number().min(0).max(1).nullable(),
  captions: z.strictObject({
    summary: CaptionSummarySchema,
    events: z.array(
      z.strictObject({
        text: z.string(),
        startMs: z.int().nonnegative(),
        endMs: z.int().nonnegative(),
        words: z.int().nonnegative(),
        case: Case,
        yPct: z.number().min(0).max(100),
        reveal: z.boolean(),
      }),
    ),
    staticText: z.array(z.string()),
  }),
  /**
   * Measured caption fonts and look per caption tier (GATE 8 round 3); absent when no
   * caption line could be measured.
   */
  fonts: CaptionFontsSchema.optional(),
  notes: z.array(z.string()),
});
export type Measurements = z.infer<typeof MeasurementsSchema>;

// ---- pure helpers ----

/** Keyframe times: the middle of each shot plus every 2 s; close times (< 250 ms) merge; ≤ 100. */
export function keyframeTimes(
  shots: readonly Shot[],
  durationMs: number,
): { atMs: number; kind: 'shot' | 'interval' }[] {
  const all: { atMs: number; kind: 'shot' | 'interval' }[] = [
    ...shots.map((s) => ({ atMs: Math.floor((s.startMs + s.endMs) / 2), kind: 'shot' as const })),
  ];
  for (let t = 0; t < durationMs; t += KEYFRAME_EVERY_MS) all.push({ atMs: t, kind: 'interval' });
  all.sort((a, b) => a.atMs - b.atMs || (a.kind === 'shot' ? -1 : 1));
  const out: typeof all = [];
  for (const k of all) {
    const prev = out.at(-1);
    if (prev && k.atMs - prev.atMs < 250) continue;
    out.push({ atMs: Math.min(k.atMs, Math.max(0, durationMs - 1)), kind: k.kind });
  }
  if (out.length <= MAX_KEYFRAMES) return out;
  // keep every shot keyframe first, then thin the interval ones evenly
  const shotsOnly = out.filter((k) => k.kind === 'shot').slice(0, MAX_KEYFRAMES);
  const room = MAX_KEYFRAMES - shotsOnly.length;
  const intervals = out.filter((k) => k.kind === 'interval');
  const step = intervals.length / Math.max(1, room);
  const picked =
    room > 0 ? Array.from({ length: room }, (_, i) => intervals[Math.floor(i * step)]!) : [];
  return [...shotsOnly, ...picked].sort((a, b) => a.atMs - b.atMs);
}

function quantile(sorted: readonly number[], q: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i]!;
}

export function shotStats(shots: readonly Shot[]): Measurements['shotStats'] {
  const lens = shots.map((s) => s.endMs - s.startMs).sort((a, b) => a - b);
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  return {
    count: lens.length,
    meanMs: Math.max(1, Math.round(mean)),
    medianMs: Math.max(1, quantile(lens, 0.5)),
    p10Ms: Math.max(1, quantile(lens, 0.1)),
    p90Ms: Math.max(1, quantile(lens, 0.9)),
  };
}

/** Per shot: a face in at least half of its samples. Ratio: the duration share of those shots. */
export function speakerShots(
  shots: readonly Shot[],
  samples: readonly { atMs: number; faces: readonly unknown[] }[],
): { speaker: boolean[]; ratio: number } {
  const speaker = shots.map((s) => {
    const inShot = samples.filter((x) => x.atMs >= s.startMs && x.atMs < s.endMs);
    if (inShot.length === 0) return false;
    return inShot.filter((x) => x.faces.length > 0).length * 2 >= inShot.length;
  });
  const total = shots.reduce((a, s) => a + (s.endMs - s.startMs), 0);
  const withFace = shots.reduce((a, s, i) => a + (speaker[i] ? s.endMs - s.startMs : 0), 0);
  return { speaker, ratio: total > 0 ? Number((withFace / total).toFixed(4)) : 0 };
}

// ---- the measure step ----

export interface MeasureOptions {
  projectId: string;
  mediaId: string;
  /** Folder for keyframes and contact sheets (created; replaced when it exists). */
  workDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: number, message: string) => void;
  /** Run as a sub-step of this agent run (job records). */
  runId?: string;
  actor?: 'user' | 'agent';
  /** Candidate fonts for the caption font match; default the bundled catalogue. */
  catalogue?: FontCatalogue;
}

async function waitJob(
  engine: Pick<Engine, 'jobs'>,
  kind: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const id = engine.jobs.start(kind, args);
  const onAbort = () => engine.jobs.cancel(id);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const info = await engine.jobs.wait(id);
    if (info.status === 'done') return info.result;
    const e = info.error;
    throw new VoxError(
      e?.code ?? (info.status === 'cancelled' ? 'CANCELLED' : 'JOB_FAILED'),
      e?.message ?? `job ${kind} ${info.status}`,
      e?.hint ?? 'Try again.',
    );
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function pyOptions(engine: Pick<Engine, 'tools' | 'redactor'>, o: MeasureOptions): PyBridgeOptions {
  const tools = engine.tools;
  return {
    pyProject: tools['py'] ?? repoPyProject(),
    ...(tools['uv'] ? { uv: tools['uv'] } : {}),
    ...(tools['pyEnv'] && tools['dir'] ? { toolsDir: tools['dir'] } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
    redactor: engine.redactor,
  };
}

const p2 = (n: number) => String(n).padStart(3, '0');

/**
 * Measures a reference video already ingested in `projectId` (styles spec Part C step 2). Facetrack
 * failing (no face model offline) leaves `speakerRatio` null with a note; every other step must work.
 */
export async function measureReference(
  engine: Pick<
    Engine,
    'jobs' | 'tools' | 'redactor' | 'getProject' | 'mediaFrames' | 'projectsDir'
  >,
  o: MeasureOptions,
): Promise<Measurements> {
  const progress = o.onProgress ?? (() => undefined);
  const notes: string[] = [];
  const jobArgs = {
    projectId: o.projectId,
    mediaId: o.mediaId,
    ...(o.actor ? { actor: o.actor } : {}),
    ...(o.runId ? { runId: o.runId } : {}),
  };
  const dir = projectDirFor(engine.projectsDir, o.projectId);
  const project = await engine.getProject(o.projectId);
  const media = project.media.find((m) => m.id === o.mediaId);
  if (!media || media.kind !== 'video' || !media.durationMs) {
    throw new VoxError(
      'MEDIA_UNSUPPORTED',
      `Media ${o.mediaId} is not a video`,
      'Give a video file or a link to a video as the reference.',
      { details: { mediaId: o.mediaId } },
    );
  }
  const durationMs = media.durationMs;

  progress(0.02, 'detecting shots');
  await waitJob(engine, 'shots', jobArgs, o.signal);
  const shotsFile = await resolveProjectPath(dir, `shots/${media.id}.json`);
  const shots = ShotListSchema.parse(JSON.parse(await readFile(shotsFile, 'utf8')));

  progress(0.15, 'finding speakers');
  let speaker: (boolean | null)[] = shots.map(() => null);
  let speakerRatio: number | null = null;
  try {
    await waitJob(engine, 'facetrack', jobArgs, o.signal);
    const det = DetectionsSchema.parse(
      JSON.parse(
        await readFile(await resolveProjectPath(dir, `facetracks/${media.id}.json`), 'utf8'),
      ),
    );
    const s = speakerShots(shots, det.samples);
    speaker = s.speaker;
    speakerRatio = s.ratio;
  } catch (e) {
    if (o.signal?.aborted) throw e;
    notes.push(
      `Speaker share not measured (facetrack failed: ${isVoxError(e) ? e.code : 'error'}); the draft keeps the parent's speaker ratio.`,
    );
  }

  progress(0.3, 'keyframes');
  const times = keyframeTimes(shots, durationMs);
  const stills = await engine.mediaFrames(
    o.projectId,
    media.id,
    times.map((t) => t.atMs),
  );
  await rm(o.workDir, { recursive: true, force: true });
  await mkdir(o.workDir, { recursive: true, mode: 0o700 });
  const ff = engine.tools['ffmpeg'] ? { ffmpeg: engine.tools['ffmpeg'] } : {};
  const run = (args: string[]) =>
    runTool('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], {
      tools: ff,
      ...(o.signal ? { signal: o.signal } : {}),
      redact: (s) => engine.redactor.redact(s),
    });
  const keyframes: Measurements['keyframes'] = [];
  const width = media.width ?? 1080;
  const height = media.height ?? 1920;
  // 360 px on the short side for the report and the sheets
  const scale = width <= height ? 'scale=360:-2' : 'scale=-2:360';
  for (const [i, t] of times.entries()) {
    const png = stills[i]!;
    const file = join(o.workDir, `ref-${p2(i + 1)}.jpg`);
    await run([
      '-f',
      'image2',
      '-c:v',
      'png',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      `file:${png}`,
      '-vf',
      scale,
      '-q:v',
      '4',
      `file:${file}`,
    ]);
    keyframes.push({ atMs: t.atMs, kind: t.kind, file });
  }
  progress(0.4, 'contact sheets');
  const per = SHEET_COLS * SHEET_ROWS;
  const sheets: string[] = [];
  const sheetScale = width <= height ? 'scale=270:-2' : 'scale=-2:270';
  for (let s = 0; s * per < keyframes.length; s++) {
    const out = join(o.workDir, `sheet-${p2(s + 1)}.jpg`);
    await run([
      '-f',
      'image2',
      '-framerate',
      '1',
      '-start_number',
      String(s * per + 1),
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      `file:${join(o.workDir, 'ref-%03d.jpg')}`,
      '-vf',
      `${sheetScale},tile=${SHEET_COLS}x${SHEET_ROWS}:padding=4:color=white`,
      '-frames:v',
      '1',
      '-q:v',
      '4',
      `file:${out}`,
    ]);
    sheets.push(out);
  }

  const src = await resolveProjectPath(dir, media.cfrPath ?? media.path);
  const sniffed = await sniffFile(src);
  if (sniffed.kind !== 'video') {
    throw new VoxError(
      'MEDIA_UNSUPPORTED',
      `Media ${media.id} has no video stream`,
      'Ingest a video.',
    );
  }
  const pyTools = {
    ...(engine.tools['ffmpeg'] ? { ffmpeg: engine.tools['ffmpeg'] } : {}),
    ...(engine.tools['ffprobe'] ? { ffprobe: engine.tools['ffprobe'] } : {}),
    formatWhitelist: FORMAT_WHITELIST[sniffed.format],
  };
  progress(0.5, 'palette');
  const palette = await runPyTool(
    'palette',
    { videoPath: src, atMs: times.map((t) => t.atMs), k: PALETTE_K, ...pyTools },
    PaletteResultSchema,
    pyOptions(engine, o),
  );
  progress(0.6, 'reading on-screen text');
  const ocr = await runPyTool(
    'ocr',
    { videoPath: src, fps: OCR_FPS, ...pyTools },
    OcrResultSchema,
    {
      ...pyOptions(engine, o),
      onProgress: (p) => progress(0.6 + 0.35 * p, 'reading on-screen text'),
    },
  );
  if (!ocr.summary.detected)
    notes.push('Caption style not detected: the draft keeps the parent caption preset.');
  let fonts: CaptionFonts | null = null;
  const samples = ocr.summary.detected ? fontSamples(ocr.frames) : [];
  if (samples.length > 0) {
    progress(0.95, 'matching caption fonts');
    const cat = o.catalogue ?? loadFontCatalogue();
    try {
      const fm = await runPyTool(
        'fontmatch',
        {
          videoPath: src,
          samples,
          fonts: fontCandidates(cat),
          occlusion: occlusionSamples(ocr.frames),
          ...pyTools,
        },
        FontMatchResultSchema,
        pyOptions(engine, o),
      );
      fonts = captionFonts(fm, cat, trackingReveals(ocr.frames));
      if (!fonts) notes.push('Caption fonts not matched: no caption line could be measured.');
    } catch (e) {
      if (o.signal?.aborted) throw e;
      notes.push(
        `Caption fonts not matched (${isVoxError(e) ? e.code : 'error'}): the draft picks fonts from the description.`,
      );
    }
  }
  progress(0.97, 'measured');
  return MeasurementsSchema.parse({
    durationMs,
    width,
    height,
    shots: shots.map((s, i) => ({ ...s, speaker: speaker[i] ?? null })),
    shotStats: shotStats(shots),
    keyframes,
    sheets,
    palette: palette.colors,
    speakerRatio,
    captions: {
      summary: ocr.summary,
      events: ocr.captions.slice(0, 200).map((c) => ({
        text: c.text.slice(0, 300),
        startMs: c.startMs,
        endMs: c.endMs,
        words: c.words,
        case: c.case,
        yPct: Math.round(1000 * (c.box.y + c.box.h / 2)) / 10,
        reveal: c.reveal,
      })),
      staticText: ocr.static.slice(0, 20).map((t) => t.slice(0, 200)),
    },
    ...(fonts ? { fonts } : {}),
    notes,
  });
}
