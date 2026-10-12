// Render and export on the engine (engine spec "Stages": render, frames, export-captions,
// export-timeline, credits, preview, audio-qa; "Encoding"; "Export targets" (D-13, S32);
// "Audio QA" (D-14, D-15)). The picture comes from a silent HyperFrames render (`--quality` always
// passed); the sound is the engine's own mix; ffmpeg muxes them with `-c:v copy` + AAC into the
// export target's temp file, so a failed or cancelled render never leaves a half file.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { z } from 'zod';
import type { MixRequest } from './api.ts';
import type { MixResult } from './audio/graph.ts';
import { LOUDNESS_TARGETS, type LoudnessPreset } from './audio/graph.ts';
import type { BuildResult, CompileOptions } from './compile/compile.ts';
import type { Config } from './config.ts';
import { buildDirFor, writeBuildTo } from './compile/write.ts';
import { VoxError } from './errors.ts';
import { prepareExport, writeExport, type ExportTarget } from './export/target.ts';
import type { JobContext, JobRunner } from './jobs.ts';
import { captionsToSrt, captionsToVtt, type CaptionChunk } from './model/captions.ts';
import { blendHalf, frame, snap, type Fps } from './model/fps.ts';
import type { MediaClip, MediaItem, Project, Sequence } from './model/schema.ts';
import { findSeq } from './ops/core.ts';
import type { ProjectStore } from './history/store.ts';
import { speedOf } from './model/speed.ts';
import { repoPyProject, runPyTool } from './py.ts';
import type { Redactor } from './redact.ts';
import { fpsArg, hyperframesBin } from './render/layers.ts';
import type { ResolvedStyle } from './styles/registry.ts';
import { runTool } from './stages/media/run.ts';

export const RENDER_QUALITIES = ['draft', 'standard', 'high'] as const;
export type RenderQuality = (typeof RENDER_QUALITIES)[number];
const LOUDNESS = z.enum(['youtube', 'tiktok', 'broadcast']);

// ---- HyperFrames runs ----

/**
 * Env keys a HyperFrames child may see: no API keys (e.g. `snapshot --describe` reads one).
 * `ELECTRON_RUN_AS_NODE` stays: the app's engine host starts the CLI with its own Electron binary
 * (`process.execPath`), which runs as Chromium without it (phase 10b).
 */
const ENV_KEEP =
  /^(ELECTRON_RUN_AS_NODE|PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_[A-Z]+|TZ|PUPPETEER_[A-Z_]+|PRODUCER_[A-Z_]+|HYPERFRAMES_[A-Z_]+|CHROME_PATH|XDG_[A-Z_]+)$/;

export function hyperframesEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (ENV_KEEP.test(k) && v !== undefined) out[k] = v;
  return { ...out, HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', NO_COLOR: '1' };
}

export type HyperframesRun = (args: string[], o: { signal?: AbortSignal }) => Promise<void>;

/** Runs the pinned HyperFrames CLI; the signal kills it; failures are TOOL_FAILED with the tail. */
export const runHyperframes: HyperframesRun = (args, o) =>
  new Promise((resolve, reject) => {
    if (o.signal?.aborted) {
      reject(new VoxError('CANCELLED', 'The render was cancelled.', 'Render again when ready.'));
      return;
    }
    const child = spawn(process.execPath, [hyperframesBin(), ...args], {
      env: hyperframesEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const keep = (d: Buffer) => {
      tail = (tail + d.toString('utf8')).slice(-4000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const onAbort = () => child.kill('SIGTERM');
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      o.signal?.removeEventListener('abort', onAbort);
      reject(
        new VoxError('TOOL_MISSING', `HyperFrames did not start: ${e.message}`, 'Run vox doctor.'),
      );
    });
    child.on('close', (code) => {
      o.signal?.removeEventListener('abort', onAbort);
      if (o.signal?.aborted) {
        reject(new VoxError('CANCELLED', 'The render was cancelled.', 'Render again when ready.'));
      } else if (code === 0) resolve();
      else {
        reject(
          new VoxError(
            'TOOL_FAILED',
            `hyperframes ${args[0]} failed (exit ${code}): ${tail.slice(-800)}`,
            'Check the build with `vox compile` and `npx hyperframes lint`, then try again.',
            { details: { tool: 'hyperframes' } },
          ),
        );
      }
    });
  });

// ---- final-render encoder (D-78) ----

/** `videotoolbox`: HyperFrames `--gpu` (h264_videotoolbox); `software`: libx264 (its default). */
export type RenderEncoder = 'videotoolbox' | 'software';

/**
 * VideoToolbox target bits per pixel per frame by quality (D-78). HyperFrames' own `--gpu`
 * default (0.16 at standard, about 10 Mb/s for 1080×1920 at 30 fps) made files about 2.4× libx264
 * crf 18. 0.09 (5.6 Mb/s) keeps quick clips at about 1.1× the libx264 size with the same look
 * (measured in D-78); draft and high keep HyperFrames' own 1 : 2 : 3 ratio.
 */
export const VT_BITS_PER_PIXEL: Readonly<Record<RenderQuality, number>> = {
  draft: 0.045,
  standard: 0.09,
  high: 0.135,
};

/** The `--video-bitrate` for a VideoToolbox render, in kbit/s (e.g. `5599k`). */
export function videotoolboxBitrate(
  width: number,
  height: number,
  fps: Fps,
  quality: RenderQuality,
): string {
  const bps = width * height * (fps.num / fps.den) * VT_BITS_PER_PIXEL[quality];
  return `${Math.max(500, Math.round(bps / 1000))}k`;
}

/** Where the render runs: platform, arch and env (`VOX_RENDER_ENCODER`). */
export interface RenderHost {
  platform: string;
  arch: string;
  env: Readonly<Record<string, string | undefined>>;
}

export interface EncoderChoice extends RenderHost {
  /** `render.encoder` from the user's config. */
  setting?: 'auto' | 'software' | undefined;
}

/** VideoToolbox on Apple silicon unless config or `VOX_RENDER_ENCODER=software` forces libx264. */
export function pickRenderEncoder(o: EncoderChoice): RenderEncoder {
  if (o.env['VOX_RENDER_ENCODER'] === 'software' || o.setting === 'software') return 'software';
  return o.platform === 'darwin' && o.arch === 'arm64' ? 'videotoolbox' : 'software';
}

/** `hyperframes render` arguments for the silent picture (MP4, quality always explicit). */
export function pictureRenderArgs(
  buildDir: string,
  out: string,
  fps: Fps,
  quality: RenderQuality,
  hardware?: { bitrate: string },
): string[] {
  return [
    'render',
    buildDir,
    '-o',
    out,
    '--format',
    'mp4',
    '--quality',
    quality,
    '--fps',
    fpsArg(fps),
    '--strict-all',
    '--frames-cache-dir',
    'off',
    ...(hardware ? ['--gpu', '--video-bitrate', hardware.bitrate] : []),
  ];
}

/** ffmpeg mux (engine spec "Encoding"): picture stream copied, the mix encoded to AAC. */
export function muxArgs(picture: string, mix: string, out: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    picture,
    '-i',
    mix,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-map_metadata',
    '-1',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    out,
  ];
}

// ---- args ----

const TargetSchema = z.union([
  z.strictObject({ file: z.string().min(1) }),
  z.strictObject({ dir: z.string().min(1) }),
]);
const RangeSchema = z
  .strictObject({ startMs: z.int().min(0), endMs: z.int().positive() })
  .refine((r) => r.endMs > r.startMs, 'endMs must be after startMs');
const exportBase = {
  projectId: z.string(),
  sequenceId: z.string().min(1).optional(),
  target: TargetSchema.optional(),
  overwrite: z.boolean().optional(),
};

export const RenderJobArgsSchema = z
  .strictObject({
    ...exportBase,
    all: z.boolean().optional(),
    range: RangeSchema.optional(),
    quality: z.enum(RENDER_QUALITIES).default('standard'),
    captions: z.enum(['burn', 'none']).default('burn'),
    loudness: LOUDNESS.default('youtube'),
  })
  .refine((a) => !(a.all && a.sequenceId), 'pass sequenceId or all, not both')
  .refine(
    (a) => !(a.all && a.target && 'file' in a.target),
    '--all writes into a folder (--out-dir)',
  )
  .refine((a) => !(a.all && a.range), '--range-ms takes one sequence');
export type RenderJobArgs = z.input<typeof RenderJobArgsSchema>;

export const FramesJobArgsSchema = z.strictObject({
  projectId: z.string(),
  sequenceId: z.string().min(1).optional(),
  atMs: z.array(z.int().min(0)).min(1).max(50),
});
export const ExportCaptionsJobArgsSchema = z.strictObject({
  ...exportBase,
  format: z.enum(['srt', 'vtt']).default('srt'),
});
export const ExportTimelineJobArgsSchema = z.strictObject({
  ...exportBase,
  /** `otio` (default) or `fcpxml` (Final Cut Pro, via otio-fcpx-xml-adapter); the layer MOVs are the same. */
  format: z.enum(['otio', 'fcpxml']).default('otio'),
});
export const AudioQaJobArgsSchema = z
  .strictObject({
    projectId: z.string(),
    sequenceId: z.string().min(1).optional(),
    loudness: LOUDNESS.default('youtube'),
    kit: z.string().min(1).max(64).optional(),
  })
  .refine((a) => !(a.kit && a.sequenceId), 'pass a sequence or --kit, not both');

export interface RenderedFile {
  sequenceId: string;
  path: string;
  durationMs: number;
  /** The picture's encoder (D-78). */
  encoder?: RenderEncoder;
  /** Why the VideoToolbox render failed when it fell back to software (redacted, short). */
  encoderFallback?: string;
}
export interface RenderJobResult {
  files: RenderedFile[];
  loudness: LoudnessPreset;
  quality: RenderQuality;
  captions: 'burn' | 'none';
}
export interface CreditLine {
  mediaId: string;
  title: string;
  author: string;
  license: string;
  licenseUrl?: string;
  url?: string;
  attribution: string;
  sequenceIds: string[];
}

// ---- deps ----

export interface ExportApiDeps {
  tools: Readonly<Record<string, string | undefined>>;
  redactor: Redactor;
  store(projectId: string): Promise<ProjectStore>;
  dirOf(projectId: string): string;
  compile(projectId: string, sequenceId: string, opts: CompileOptions): Promise<BuildResult>;
  mix(projectId: string, sequenceId: string, opts: MixRequest): Promise<MixResult>;
  captions(projectId: string, sequenceId: string): Promise<CaptionChunk[]>;
  style(styleId: string): ResolvedStyle;
  /** Test seam: the HyperFrames CLI runner. */
  hyperframes?: HyperframesRun;
  /** User config reader (`render.encoder`, D-78); absent = `auto`. */
  config?: () => Promise<Config>;
  /** Test seam: platform, arch and env for the encoder pick; default this process. */
  host?: RenderHost;
}

export interface ExportApi {
  frames(projectId: string, sequenceId: string | undefined, atMs: number[]): Promise<string[]>;
  credits(projectId: string): Promise<CreditLine[]>;
  /** The `npx hyperframes play <buildDir>` call for `vox preview` (compiles and writes the build). */
  preview(
    projectId: string,
    sequenceId?: string,
  ): Promise<{ command: string; args: string[]; buildDir: string; sequenceId: string }>;
}

const workDir = async (projectDir: string, kind: string): Promise<string> => {
  const d = join(projectDir, 'cache', kind, `${process.pid}-${randomBytes(6).toString('hex')}`);
  await mkdir(d, { recursive: true, mode: 0o700 });
  return d;
};

/** The sequence a command means: the given one, else the project's first. */
export function pickSequence(p: Project, sequenceId?: string): Sequence {
  if (sequenceId) return findSeq(p, sequenceId);
  const s = p.sequences[0];
  if (!s) {
    throw new VoxError(
      'NOT_FOUND',
      `Project ${p.id} has no sequence`,
      'Add one with `vox op addSequence`',
    );
  }
  return s;
}

const stemOf = (p: Project, s: Sequence): string => `${p.name}-${s.name}`;

function seqEndMs(s: Sequence): number {
  let end = 0;
  for (const t of [...s.videoTracks, ...s.audioTracks])
    for (const i of t.items) end = Math.max(end, i.startMs + i.durationMs);
  return end;
}

/** Media ids a sequence uses: its clips and any media id inside scene variables. */
function mediaUsedBy(s: Sequence, media: readonly MediaItem[]): Set<string> {
  const used = new Set<string>();
  const text = JSON.stringify([s.videoTracks, s.audioTracks]);
  for (const m of media) if (text.includes(`"${m.id}"`)) used.add(m.id);
  return used;
}

export function registerExportJobs(runner: JobRunner, deps: ExportApiDeps): ExportApi {
  const hf = deps.hyperframes ?? runHyperframes;
  // read at use: setup may find ffmpeg after the engine opened (a Homebrew prefix not on PATH)
  const ffTools = () => (deps.tools['ffmpeg'] ? { ffmpeg: deps.tools['ffmpeg'] } : {});
  const redact = (s: string): string => deps.redactor.redact(s);
  const read = async (projectId: string) => (await deps.store(projectId)).read();
  const encoderPick = async (): Promise<RenderEncoder> =>
    pickRenderEncoder({
      ...(deps.host ?? { platform: process.platform, arch: process.arch, env: process.env }),
      setting: deps.config ? (await deps.config()).render?.encoder : undefined,
    });

  async function renderOne(
    args: z.output<typeof RenderJobArgsSchema>,
    p: Project,
    s: Sequence,
    ctx: JobContext,
    share: { at: number; of: number },
  ): Promise<RenderedFile> {
    const dir = deps.dirOf(p.id);
    const step = (x: number, m: string) => ctx.progress((share.at + x) / share.of, m);
    const work = await workDir(dir, 'render');
    try {
      step(0.02, `compiling ${s.name}`);
      const build = await deps.compile(p.id, s.id, {
        mode: 'render',
        ...(args.range ? { range: args.range } : {}),
        captions: args.captions === 'burn',
      });
      const buildDir = writeBuildTo(build, buildDirFor(dir, `${s.id}-render`));
      const picture = join(work, 'picture.mp4');
      step(0.1, 'rendering picture');
      const software = pictureRenderArgs(buildDir, picture, build.fps, args.quality);
      let encoder = await encoderPick();
      let encoderFallback: string | undefined;
      if (encoder === 'videotoolbox') {
        const bitrate = videotoolboxBitrate(
          s.canvas.width,
          s.canvas.height,
          build.fps,
          args.quality,
        );
        try {
          await hf(pictureRenderArgs(buildDir, picture, build.fps, args.quality, { bitrate }), {
            signal: ctx.signal,
          });
        } catch (e) {
          // one software rerun when the hardware render fails (D-78); a cancel stays a cancel
          if (ctx.signal.aborted || !(e instanceof VoxError) || e.code !== 'TOOL_FAILED') throw e;
          encoder = 'software';
          encoderFallback = redact(e.message).slice(0, 300);
          step(0.1, 'rendering picture (software encoder)');
          await rm(picture, { force: true });
          await hf(software, { signal: ctx.signal });
        }
      } else {
        await hf(software, { signal: ctx.signal });
      }
      if (ctx.signal.aborted) throw cancelled();
      step(0.8, 'mixing audio');
      const mixWav = join(work, 'mix.wav');
      await deps.mix(p.id, s.id, {
        out: mixWav,
        preset: args.loudness,
        ...(args.range ? { range: args.range } : {}),
      });
      step(0.92, 'muxing');
      const path = await writeExport(
        {
          target: args.target as ExportTarget | undefined,
          defaultDir: join(dir, 'renders'),
          stem: stemOf(p, s),
          ext: 'mp4',
          overwrite: args.overwrite,
        },
        async (tmp, signal) => {
          await runTool('ffmpeg', muxArgs(picture, mixWav, tmp), {
            tools: ffTools(),
            redact,
            ...(signal ? { signal } : {}),
          });
        },
        { signal: ctx.signal },
      );
      return {
        sequenceId: s.id,
        path,
        durationMs: build.durationMs,
        encoder,
        ...(encoderFallback ? { encoderFallback } : {}),
      };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  runner.register<z.output<typeof RenderJobArgsSchema>, RenderJobResult>('render', {
    args: RenderJobArgsSchema as unknown as z.ZodType<z.output<typeof RenderJobArgsSchema>>,
    async run(args, ctx) {
      const p = await read(args.projectId);
      const seqs = args.all
        ? p.sequences.filter((s) => seqEndMs(s) > 0)
        : [pickSequence(p, args.sequenceId)];
      if (seqs.length === 0) {
        throw new VoxError('VALIDATION', 'No sequence has content to render', 'Add clips first');
      }
      const files: RenderedFile[] = [];
      for (const [i, s] of seqs.entries()) {
        files.push(await renderOne(args, p, s, ctx, { at: i, of: seqs.length }));
      }
      return { files, loudness: args.loudness, quality: args.quality, captions: args.captions };
    },
  });

  // ---- frames (compiled stills at canvas size, cached by build hash and time) ----

  async function frames(
    projectId: string,
    sequenceId: string | undefined,
    atMs: number[],
    signal?: AbortSignal,
  ) {
    const p = await read(projectId);
    const s = pickSequence(p, sequenceId);
    const dir = deps.dirOf(projectId);
    const build = await deps.compile(projectId, s.id, { mode: 'render' });
    const { createHash } = await import('node:crypto');
    const h = createHash('sha256');
    for (const [k, v] of [...build.files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
      h.update(k)
        .update('\0')
        .update(typeof v === 'string' ? v : Buffer.from(v as Uint8Array));
    for (const [k, v] of [...build.links.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
      h.update(k).update('\0').update(String(v));
    const key = h.digest('hex').slice(0, 24);
    const cacheDir = join(dir, 'cache', 'frames', s.id, key);
    const times = atMs.map((t) =>
      Math.min(snap(t, s.canvas.fps), Math.max(0, build.durationMs - 1)),
    );
    const want = times.map((t) => join(cacheDir, `${t}.png`));
    const missing = times.filter((_, i) => !existsSync(want[i]!));
    if (missing.length) {
      const buildDir = writeBuildTo(build, buildDirFor(dir, `${s.id}-frames`));
      const out = await workDir(dir, 'frames-tmp');
      try {
        await hf(
          [
            'snapshot',
            buildDir,
            '-o',
            out,
            '--at',
            missing.map((t) => (t / 1000).toFixed(3)).join(','),
            '--no-end',
          ],
          signal ? { signal } : {},
        );
        const pngs = (await readdir(out)).filter((n) => n.endsWith('.png')).sort(byNumber);
        if (pngs.length !== missing.length) {
          throw new VoxError(
            'TOOL_FAILED',
            `hyperframes snapshot wrote ${pngs.length} stills for ${missing.length} times`,
            'Try again; check the build with `vox compile`.',
          );
        }
        await mkdir(cacheDir, { recursive: true });
        for (const [i, n] of pngs.entries()) {
          await rename(join(out, n), join(cacheDir, `${missing[i]}.png`));
        }
      } finally {
        await rm(out, { recursive: true, force: true });
      }
    }
    return want;
  }

  runner.register<z.infer<typeof FramesJobArgsSchema>, { paths: string[] }>('frames', {
    args: FramesJobArgsSchema,
    async run(args, ctx) {
      return { paths: await frames(args.projectId, args.sequenceId, args.atMs, ctx.signal) };
    },
  });

  // ---- captions export ----

  runner.register<
    z.infer<typeof ExportCaptionsJobArgsSchema>,
    { path: string; chunks: number; sequenceId: string }
  >('exportCaptions', {
    args: ExportCaptionsJobArgsSchema,
    async run(args, ctx) {
      const p = await read(args.projectId);
      const s = pickSequence(p, args.sequenceId);
      const chunks = await deps.captions(p.id, s.id);
      if (!s.captions?.enabled) {
        throw new VoxError(
          'VALIDATION',
          `Captions are off in sequence ${s.id}`,
          'Turn them on with `vox op <project> setCaptions`',
        );
      }
      const body = args.format === 'srt' ? captionsToSrt(chunks) : captionsToVtt(chunks);
      const path = await writeExport(
        {
          target: args.target as ExportTarget | undefined,
          defaultDir: join(deps.dirOf(p.id), 'renders'),
          stem: stemOf(p, s),
          ext: args.format,
          overwrite: args.overwrite,
        },
        async (tmp) => writeFile(tmp, body, 'utf8'),
        { signal: ctx.signal },
      );
      return { path, chunks: chunks.length, sequenceId: s.id };
    },
  });

  // ---- timeline export (OTIO + layer MOVs) ----

  runner.register<z.infer<typeof ExportTimelineJobArgsSchema>, TimelineResult>('exportTimeline', {
    args: ExportTimelineJobArgsSchema,
    async run(args, ctx) {
      const p = await read(args.projectId);
      const s = pickSequence(p, args.sequenceId);
      return exportTimeline(deps, hf, p, s, args, ctx);
    },
  });

  // ---- audio QA ----

  runner.register<z.output<typeof AudioQaJobArgsSchema>, AudioQaResult>('audioQa', {
    args: AudioQaJobArgsSchema as unknown as z.ZodType<z.output<typeof AudioQaJobArgsSchema>>,
    async run(args, ctx) {
      const p = await read(args.projectId);
      const dir = deps.dirOf(p.id);
      const pyOpts = {
        pyProject: deps.tools['py'] ?? repoPyProject(),
        ...(deps.tools['uv'] ? { uv: deps.tools['uv'] } : {}),
        ...(deps.tools['pyEnv'] && deps.tools['dir'] ? { toolsDir: deps.tools['dir'] } : {}),
        signal: ctx.signal,
        onProgress: (x: number, m?: string) => ctx.progress(0.5 + x * 0.5, m),
        redactor: deps.redactor,
      };
      const ff = deps.tools['ffmpeg'] ? { ffmpeg: deps.tools['ffmpeg'] } : {};
      if (args.kit) {
        const st = deps.style(args.kit);
        const files = Object.entries(st.files.sfx).map(([name, path]) => ({
          path,
          type: st.style.sfx?.[name]?.type ?? 'cut',
        }));
        if (files.length === 0) {
          throw new VoxError(
            'VALIDATION',
            `Style ${args.kit} has no SFX`,
            'Pick a style with an sfx kit',
          );
        }
        const outDir = join(dir, 'renders', 'qa');
        await mkdir(outDir, { recursive: true });
        const r = await runPyTool(
          'audioqa',
          { mode: 'kit', styleId: st.id, files, outDir, ...ff },
          z.looseObject({ mode: z.literal('kit'), pass: z.boolean() }),
          pyOpts,
        );
        return { ...r, outDir, png: join(outDir, `kit-${st.id}.png`) } as AudioQaResult;
      }
      const s = pickSequence(p, args.sequenceId);
      const outDir = join(dir, 'renders', 'qa', s.id);
      await mkdir(outDir, { recursive: true });
      const work = await workDir(dir, 'audioqa');
      try {
        ctx.progress(0.05, 'mixing stems');
        const mixWav = join(work, 'mix.wav');
        const r = await deps.mix(p.id, s.id, {
          out: mixWav,
          preset: args.loudness,
          stemsDir: work,
        });
        const build = await deps.compile(p.id, s.id, { mode: 'render' });
        const fps = s.canvas.fps.num / s.canvas.fps.den;
        const res = await runPyTool(
          'audioqa',
          {
            mix: r.out,
            stems: { sfx: r.stems!.sfx, speech: r.stems!.speech },
            cues: build.cues.cues.map((c) => ({
              atMs: c.atMs,
              type: c.type,
              hero: c.type === 'hero',
            })),
            fps,
            target: LOUDNESS_TARGETS[args.loudness],
            outDir,
            ...ff,
          },
          z.looseObject({ mode: z.literal('mix'), pass: z.boolean() }),
          pyOpts,
        );
        // the gain each cue was mixed at under the speech it lands on (D-89), for reports
        const sfxGains = build.cues.cues.map((c, i) => ({
          atMs: c.atMs,
          sfx: c.sfx,
          gainDb: r.sfxGainsDb?.[i] ?? 0,
        }));
        return { ...res, sfxGains, outDir, png: join(outDir, 'qa.png') } as AudioQaResult;
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  });

  return {
    frames: (projectId, sequenceId, atMs) => frames(projectId, sequenceId, atMs),
    async credits(projectId) {
      const p = await read(projectId);
      const lines = new Map<string, CreditLine>();
      for (const s of p.sequences) {
        for (const id of mediaUsedBy(s, p.media)) {
          const m = p.media.find((x) => x.id === id)!;
          if (m.origin.type !== 'archive') continue;
          const prev = lines.get(id);
          if (prev) {
            prev.sequenceIds.push(s.id);
            continue;
          }
          lines.set(id, {
            mediaId: id,
            title: m.description ?? basename(m.path),
            author: m.origin.author ?? 'Unknown',
            license: m.origin.license ?? 'unknown',
            ...(m.origin.licenseUrl ? { licenseUrl: m.origin.licenseUrl } : {}),
            ...(m.origin.url ? { url: m.origin.url } : {}),
            attribution:
              m.origin.attribution ?? `${m.origin.author ?? 'Unknown'}, ${m.origin.license ?? ''}`,
            sequenceIds: [s.id],
          });
        }
      }
      return [...lines.values()];
    },
    async preview(projectId, sequenceId) {
      const p = await read(projectId);
      const s = pickSequence(p, sequenceId);
      const build = await deps.compile(projectId, s.id, { mode: 'preview' });
      const buildDir = writeBuildTo(build, buildDirFor(deps.dirOf(projectId), s.id));
      return {
        command: 'npx',
        args: ['hyperframes', 'play', buildDir],
        buildDir,
        sequenceId: s.id,
      };
    },
  };
}

const cancelled = (): VoxError =>
  new VoxError(
    'CANCELLED',
    'The render was cancelled.',
    'Nothing was written; render again when ready.',
  );

const byNumber = (a: string, b: string): number => {
  const n = (x: string) => Number(/(\d+(?:\.\d+)?)/.exec(x)?.[1] ?? 0);
  return n(a) - n(b) || (a < b ? -1 : 1);
};

export type AudioQaResult = {
  mode: 'mix' | 'kit';
  pass: boolean;
  outDir: string;
  png: string;
} & Record<string, unknown>;

// ---- OTIO ----

export interface TimelineResult {
  path: string;
  layersDir: string;
  sequenceId: string;
  clips: number;
  layers: string[];
}

interface OtioClip {
  name: string;
  path: string;
  startFrame: number;
  durationFrames: number;
  sourceFrame: number;
  sourceDurationFrames?: number;
  /** Whole source file length in `mediaRate` frames (FCPXML assets). */
  mediaDurationFrames?: number;
  mediaRate?: { num: number; den: number };
  /** Clip speed (plan D-62): the OTIO `LinearTimeWarp` scalar; the source range keeps the timeline length. */
  timeScalar?: number;
}
interface OtioTrack {
  kind: 'video' | 'audio';
  name: string;
  clips: OtioClip[];
}

/** `timeScalar` for a sped clip (none at 1×). */
const timeScalar = (it: MediaClip): { timeScalar?: number } =>
  speedOf(it) === 1 ? {} : { timeScalar: speedOf(it) };

const TimelineToolResultSchema = z.strictObject({
  output: z.string(),
  tracks: z.int(),
  clips: z.int(),
});

/** Layer MOVs a sequence needs: scenes, transitions, overlays (whole length) and captions. */
function layerPlan(
  s: Sequence,
  hasCaptions: boolean,
  overlays: string[],
): { id: string; startMs: number; durationMs: number; track: string }[] {
  const out: { id: string; startMs: number; durationMs: number; track: string }[] = [];
  const end = seqEndMs(s);
  for (const t of s.videoTracks) {
    if (t.hidden) continue;
    for (const it of t.items) {
      if (it.type === 'scene')
        out.push({
          id: it.id,
          startMs: it.startMs,
          durationMs: it.durationMs,
          track: `Scenes ${t.id}`,
        });
      if (it.transitionIn) {
        const { before } = blendHalf(it.startMs, it.transitionIn.durationMs, s.canvas.fps);
        const start = Math.max(0, it.startMs - before);
        out.push({
          id: `${it.id}-tx`,
          startMs: start,
          durationMs: it.transitionIn.durationMs,
          track: `Transitions ${t.id}`,
        });
      }
    }
  }
  for (const o of overlays) out.push({ id: o, startMs: 0, durationMs: end, track: 'Overlays' });
  if (hasCaptions) out.push({ id: 'captions', startMs: 0, durationMs: end, track: 'Captions' });
  return out;
}

async function exportTimeline(
  deps: ExportApiDeps,
  hf: HyperframesRun,
  p: Project,
  s: Sequence,
  args: z.infer<typeof ExportTimelineJobArgsSchema>,
  ctx: JobContext,
): Promise<TimelineResult> {
  const dir = deps.dirOf(p.id);
  const fps = s.canvas.fps;
  const f = (t: number) => frame(t, fps);
  const chunks = s.captions?.enabled ? await deps.captions(p.id, s.id) : [];
  const style = deps.style(s.styleId);
  const overlays = style.overlays.map((o) => `overlay-${o.name}`);
  const plan = layerPlan(s, chunks.length > 0, overlays);

  const prepared = await prepareExport({
    target: args.target as ExportTarget | undefined,
    defaultDir: join(dir, 'renders'),
    stem: stemOf(p, s),
    ext: args.format,
    overwrite: args.overwrite,
  });
  // The FCPXML export keeps its own layer folder, so both formats can go to the same folder.
  const layersFor = (file: string) =>
    join(
      dirname(file),
      `${basename(file, extname(file))}${args.format === 'fcpxml' ? '-fcpxml' : ''}-layers`,
    );
  const plannedLayers = layersFor(prepared.finalPath);
  const tmpLayers = join(
    dirname(prepared.finalPath),
    `.vox-layers-${randomBytes(6).toString('hex')}`,
  );
  try {
    if (existsSync(plannedLayers) && !args.overwrite) {
      throw new VoxError(
        'EXPORT_PATH',
        `${basename(plannedLayers)} already exists next to the timeline`,
        'Pick another name or folder, or pass --overwrite',
        { details: { path: plannedLayers } },
      );
    }
    await mkdir(tmpLayers, { recursive: true });
    const media = new Map(p.media.map((m) => [m.id, m] as const));
    const tracks: OtioTrack[] = [];
    const abs = (m: MediaItem) => join(dir, m.path);
    for (const t of s.videoTracks) {
      const clips: OtioClip[] = [];
      for (const it of [...t.items].sort((a, b) => a.startMs - b.startMs)) {
        if (it.type !== 'media') continue;
        const m = media.get(it.mediaId)!;
        const rate = m.fps ?? fps;
        clips.push({
          name: `${it.id} ${basename(m.path)}`,
          path: abs(m),
          startFrame: f(it.startMs),
          durationFrames: Math.max(1, f(it.startMs + it.durationMs) - f(it.startMs)),
          sourceFrame: frame(it.inMs, rate),
          sourceDurationFrames: Math.max(
            1,
            Math.round((it.durationMs * rate.num) / rate.den / 1000),
          ),
          mediaRate: { num: rate.num, den: rate.den },
          ...timeScalar(it),
          ...(m.durationMs
            ? {
                mediaDurationFrames: Math.max(
                  1,
                  Math.round((m.durationMs * rate.num) / rate.den / 1000),
                ),
              }
            : {}),
        });
      }
      if (clips.length) tracks.push({ kind: 'video', name: t.id, clips });
    }
    const layerTracks = new Map<string, OtioClip[]>();
    for (const [i, l] of plan.entries()) {
      ctx.progress(0.05 + (0.85 * i) / Math.max(1, plan.length), `layer ${l.id}`);
      const file = `${String(i + 1).padStart(3, '0')}-${l.id}.mov`;
      const build = await deps.compile(p.id, s.id, {
        mode: 'render',
        layers: [l.id],
        range: { startMs: l.startMs, endMs: l.startMs + l.durationMs },
      });
      const bdir = writeBuildTo(build, buildDirFor(dir, `${s.id}-layers`));
      await hf(
        [
          'render',
          bdir,
          '-o',
          join(tmpLayers, file),
          '--format',
          'mov',
          '--fps',
          fpsArg(fps),
          '--strict-all',
          '--frames-cache-dir',
          'off',
        ],
        { signal: ctx.signal },
      );
      const list = layerTracks.get(l.track) ?? [];
      list.push({
        name: l.id,
        path: join(plannedLayers, file),
        startFrame: f(l.startMs),
        durationFrames: Math.max(1, f(l.startMs + l.durationMs) - f(l.startMs)),
        sourceFrame: 0,
      });
      layerTracks.set(l.track, list);
    }
    for (const [name, clips] of layerTracks) tracks.push({ kind: 'video', name, clips });
    for (const t of s.audioTracks) {
      if (t.muted) continue;
      const clips: OtioClip[] = [];
      for (const it of [...t.items].sort((a, b) => a.startMs - b.startMs)) {
        if (it.type !== 'media') continue;
        const m = media.get(it.mediaId)!;
        const rate = m.fps ?? fps;
        clips.push({
          name: `${it.id} ${basename(m.path)}`,
          path: abs(m),
          startFrame: f(it.startMs),
          durationFrames: Math.max(1, f(it.startMs + it.durationMs) - f(it.startMs)),
          sourceFrame: frame(it.inMs, rate),
          sourceDurationFrames: Math.max(
            1,
            Math.round((it.durationMs * rate.num) / rate.den / 1000),
          ),
          mediaRate: { num: rate.num, den: rate.den },
          ...timeScalar(it),
          ...(m.durationMs
            ? {
                mediaDurationFrames: Math.max(
                  1,
                  Math.round((m.durationMs * rate.num) / rate.den / 1000),
                ),
              }
            : {}),
        });
      }
      if (clips.length) tracks.push({ kind: 'audio', name: t.id, clips });
    }
    ctx.progress(0.92, 'writing timeline');
    const writeOtio = async (out: string, layersDir: string) => {
      const fix = (c: OtioClip) =>
        c.path.startsWith(plannedLayers) ? { ...c, path: join(layersDir, basename(c.path)) } : c;
      const tmpOut = join(
        dirname(prepared.tempPath),
        `.vox-timeline-${randomBytes(6).toString('hex')}.${args.format}`,
      );
      try {
        await runPyTool(
          'timeline',
          {
            mode: 'write',
            format: args.format,
            width: s.canvas.width,
            height: s.canvas.height,
            output: tmpOut,
            name: `${p.name} – ${s.name}`,
            rate: { num: fps.num, den: fps.den },
            tracks: tracks.map((t) => ({ ...t, clips: t.clips.map(fix) })),
          },
          TimelineToolResultSchema,
          {
            pyProject: deps.tools['py'] ?? repoPyProject(),
            ...(deps.tools['uv'] ? { uv: deps.tools['uv'] } : {}),
            ...(deps.tools['pyEnv'] && deps.tools['dir'] ? { toolsDir: deps.tools['dir'] } : {}),
            signal: ctx.signal,
            redactor: deps.redactor,
          },
        );
        // Content into `out` in place: the export temp is checked by identity, so never renamed over.
        await writeFile(out, await readFile(tmpOut));
      } finally {
        await rm(tmpOut, { force: true });
      }
    };
    await writeOtio(prepared.tempPath, plannedLayers);
    const written = await prepared.commit();
    const layersDir = layersFor(written);
    if (written !== prepared.finalPath) {
      // The planned name was taken meanwhile (folder mode moved on): point the file at its own folder.
      await writeOtio(written, layersDir);
    }
    if (existsSync(layersDir)) {
      if (!args.overwrite) {
        await rm(written, { force: true });
        throw new VoxError(
          'EXPORT_PATH',
          `${basename(layersDir)} appeared next to the timeline during the export`,
          'Export again',
          { details: { path: layersDir } },
        );
      }
      // --overwrite replaces the timeline and the layer folder this export made before.
      await rm(layersDir, { recursive: true, force: true });
    }
    await rename(tmpLayers, layersDir);
    const clipCount = tracks.reduce((n, t) => n + t.clips.length, 0);
    return {
      path: written,
      layersDir,
      sequenceId: s.id,
      clips: clipCount,
      layers: plan.map((l) => l.id),
    };
  } catch (e) {
    await prepared.discard();
    throw e;
  } finally {
    await rm(tmpLayers, { recursive: true, force: true });
  }
}
