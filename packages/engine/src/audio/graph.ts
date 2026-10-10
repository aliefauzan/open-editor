// The final audio mix (engine spec "Audio"; plan D-14, D-15). Final audio never goes through
// HyperFrames: one ffmpeg filter graph is built from the model. Each audio-track clip is trimmed at
// `inMs`, denoised when `denoise` is `light` or `strong`, gained to the loudness target when its media
// has `loudness`, scaled by `volume`, faded, and delayed to `startMs`; SFX cues are delayed to their
// times; muted tracks are left out. Everything goes through `amix` (normalisation off) and a limiter,
// then a two-pass `loudnorm` to the export target and -1 dBTP. Stems (speech = the captions source
// tracks, other audio tracks, SFX) use the same chains, without the limiter and `loudnorm`.
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { VoxError } from '../errors.ts';
import type { MediaItem, Sequence } from '../model/schema.ts';
import type { Cue } from './cues.ts';

const run = promisify(execFile);

export type LoudnessPreset = 'youtube' | 'tiktok' | 'broadcast';
/** Export loudness targets, integrated LUFS (`render --loudness`; youtube is the default). */
export const LOUDNESS_TARGETS: Record<LoudnessPreset, number> = {
  youtube: -14,
  tiktok: -12,
  broadcast: -23,
};
export const TRUE_PEAK_DBTP = -1;
export const LOUDNESS_RANGE_LU = 11;
export const SAMPLE_RATE = 48000;
/** The two fixed `afftdn` strengths (ffmpeg built in; no RNNoise model files in v1). */
export const DENOISE_FILTERS = {
  light: 'afftdn=nr=12:nf=-40',
  strong: 'afftdn=nr=24:nf=-30',
} as const;
/** -1 dBFS sample-peak limiter before `loudnorm`; delay compensated, no auto level. */
export const LIMITER = 'alimiter=limit=0.891251:attack=5:release=50:level=0:latency=1';

export type StemKind = 'speech' | 'other' | 'sfx';
export const STEMS: readonly StemKind[] = ['speech', 'other', 'sfx'];

export interface MixInput {
  /** The sequence as rendered (already cut to a range, if any). */
  seq: Sequence;
  media: readonly MediaItem[];
  /** Media paths are project-relative. */
  projectDir: string;
  /** Kept cues (`cueList(...).cues`). */
  cues: readonly Cue[];
  /** Absolute SFX file per sfx name (the sequence style's `files.sfx`). */
  sfxFiles: Readonly<Record<string, string>>;
  durationMs: number;
  preset: LoudnessPreset;
}

export interface MixGraph {
  /** Absolute input files, in `-i` order. */
  inputs: string[];
  /** `-filter_complex` text; its output pad is `[mix]` (before `loudnorm`). */
  filter: string;
  durationMs: number;
  /** Sources per stem kind (clip and cue ids), for reports. */
  sources: Record<StemKind, string[]>;
}

/** Seconds with at most 6 decimals, no trailing zeros. */
const sec = (msValue: number) => String(Number((msValue / 1000).toFixed(6)));
const samples = (msValue: number) => Math.round((msValue * SAMPLE_RATE) / 1000);
const FORMAT = `aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;

interface Source {
  id: string;
  kind: StemKind;
  file: string;
  chain: string[];
}

function sources(input: MixInput): Source[] {
  const { seq } = input;
  const speech = new Set(seq.captions?.sourceTrackIds ?? []);
  const target = LOUDNESS_TARGETS[input.preset];
  const abs = (p: string) => (isAbsolute(p) ? p : join(input.projectDir, p));
  const out: Source[] = [];
  for (const track of seq.audioTracks) {
    if (track.muted) continue;
    const kind: StemKind = speech.has(track.id) ? 'speech' : 'other';
    const items = [...track.items].sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));
    for (const it of items) {
      if (it.type !== 'media') continue;
      const m = input.media.find((x) => x.id === it.mediaId);
      if (!m) {
        throw new VoxError(
          'MEDIA_MISSING',
          `${it.id} uses media ${it.mediaId}, which is not in the project`,
          'Relink or remove the clip',
          { details: { itemId: it.id, mediaId: it.mediaId } },
        );
      }
      if (m.kind === 'image' || m.hasAudio === false) continue;
      const chain = [
        `atrim=start=${sec(it.inMs)}:end=${sec(it.inMs + it.durationMs)}`,
        'asetpts=PTS-STARTPTS',
        FORMAT,
      ];
      if (it.denoise && it.denoise !== 'off') chain.push(DENOISE_FILTERS[it.denoise]);
      if (m.loudness) {
        const gain = Number((target - m.loudness.integratedLufs).toFixed(2));
        if (gain !== 0) chain.push(`volume=${gain}dB`);
      }
      if (it.volume !== undefined && it.volume !== 1) chain.push(`volume=${it.volume}`);
      const fadeIn = Math.min(it.fadeInMs ?? 0, it.durationMs);
      const fadeOut = Math.min(it.fadeOutMs ?? 0, it.durationMs);
      if (fadeIn > 0) chain.push(`afade=t=in:st=0:d=${sec(fadeIn)}`);
      if (fadeOut > 0) {
        chain.push(`afade=t=out:st=${sec(it.durationMs - fadeOut)}:d=${sec(fadeOut)}`);
      }
      chain.push(`adelay=delays=${samples(it.startMs)}S:all=1`);
      out.push({ id: it.id, kind, file: abs(m.audioPath ?? m.path), chain });
    }
  }
  if (seq.sfx) {
    input.cues.forEach((c, i) => {
      const file = input.sfxFiles[c.sfx];
      if (!file) return; // compile warns about an sfx name the style does not have
      out.push({
        id: `${c.itemId}:${c.cueName}:${i}`,
        kind: 'sfx',
        file,
        chain: [FORMAT, `adelay=delays=${samples(c.atMs)}S:all=1`],
      });
    });
  }
  return out;
}

/**
 * The filter graph of the mix (`stem` omitted: every source, then the limiter) or of one stem (its
 * sources only, no limiter). Both end at `[mix]`, exactly `durationMs` long.
 */
export function mixGraph(input: MixInput, stem?: StemKind): MixGraph {
  if (!(input.durationMs > 0)) {
    throw new VoxError(
      'VALIDATION',
      `Bad mix duration ${input.durationMs}`,
      'Mix a sequence with content',
    );
  }
  const all = sources(input);
  const picked = stem ? all.filter((s) => s.kind === stem) : all;
  const inputs: string[] = [];
  const lines: string[] = [];
  const pads: string[] = [];
  for (const [n, s] of picked.entries()) {
    let k = inputs.indexOf(s.file);
    if (k < 0) k = inputs.push(s.file) - 1;
    lines.push(`[${k}:a]${s.chain.join(',')}[s${n}]`);
    pads.push(`[s${n}]`);
  }
  const len = samples(input.durationMs);
  const end = `apad=whole_len=${len},atrim=end_sample=${len}`;
  const tail = stem ? end : `${end},${LIMITER}`;
  if (pads.length === 0) {
    lines.push(`anullsrc=r=${SAMPLE_RATE}:cl=stereo,${FORMAT},atrim=end_sample=${len}[mix]`);
  } else {
    lines.push(
      `${pads.join('')}amix=inputs=${pads.length}:normalize=0:duration=longest:dropout_transition=0,${tail}[mix]`,
    );
  }
  const by = (k: StemKind) => all.filter((s) => s.kind === k).map((s) => s.id);
  return {
    inputs,
    filter: lines.join(';\n'),
    durationMs: input.durationMs,
    sources: { speech: by('speech'), other: by('other'), sfx: by('sfx') },
  };
}

export interface LoudnormMeasure {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/** Pass 1 of `loudnorm`: measure only. */
export function loudnormPass1(preset: LoudnessPreset): string {
  return `loudnorm=I=${LOUDNESS_TARGETS[preset]}:TP=${TRUE_PEAK_DBTP}:LRA=${LOUDNESS_RANGE_LU}:print_format=json`;
}

/** Pass 2 of `loudnorm`: the measured values, linear normalisation, back to 48 kHz. */
export function loudnormPass2(preset: LoudnessPreset, m: LoudnormMeasure): string {
  return (
    `loudnorm=I=${LOUDNESS_TARGETS[preset]}:TP=${TRUE_PEAK_DBTP}:LRA=${LOUDNESS_RANGE_LU}` +
    `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
    `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=json` +
    `,aresample=${SAMPLE_RATE}`
  );
}

function ffArgs(g: MixGraph, post: string | null, out: string[]): string[] {
  const args = ['-hide_banner', '-nostdin', '-y'];
  for (const f of g.inputs) args.push('-i', f);
  const filter = post ? `${g.filter};\n[mix]${post}[out]` : g.filter;
  args.push('-filter_complex', filter, '-map', post ? '[out]' : '[mix]', ...out);
  return args;
}

async function ffmpeg(args: string[]): Promise<string> {
  try {
    const r = await run('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 });
    return r.stderr;
  } catch (e) {
    const err = e as { code?: unknown; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      throw new VoxError('TOOL_MISSING', 'ffmpeg is not installed', 'Install ffmpeg', {
        details: { tool: 'ffmpeg' },
      });
    }
    throw new VoxError(
      'TOOL_FAILED',
      `ffmpeg audio mix failed: ${(err.stderr ?? err.message ?? '').slice(-800)}`,
      'Check the media files and try again',
      { details: { tool: 'ffmpeg' }, cause: e },
    );
  }
}

/** The last JSON object ffmpeg printed (loudnorm's report). */
function lastJson(stderr: string): LoudnormMeasure {
  const b = stderr.lastIndexOf('}');
  const a = stderr.lastIndexOf('{', b);
  return JSON.parse(stderr.slice(a, b + 1)) as LoudnormMeasure;
}

const WAV = ['-c:a', 'pcm_f32le', '-ar', String(SAMPLE_RATE), '-f', 'wav'];

export interface MixOptions {
  /** Output WAV (32-bit float, 48 kHz stereo). */
  out: string;
  /** false: skip `loudnorm` (the limited mix, for audio QA). Default true. */
  normalize?: boolean;
  /** Write `speech.wav`, `other.wav` and `sfx.wav` here (no limiter, no `loudnorm`). */
  stemsDir?: string;
}

export interface MixResult {
  out: string;
  graph: MixGraph;
  /** Pass-1 measurement of the limited mix (absent when `normalize` is false). */
  measured?: LoudnormMeasure;
  stems?: Record<StemKind, string>;
}

/** Render the mix (two-pass `loudnorm` to the preset) and, optionally, the stems. */
export async function renderMix(input: MixInput, opts: MixOptions): Promise<MixResult> {
  const graph = mixGraph(input);
  mkdirSync(dirname(opts.out), { recursive: true });
  let measured: LoudnormMeasure | undefined;
  if (opts.normalize === false) {
    await ffmpeg(ffArgs(graph, null, [...WAV, opts.out]));
  } else {
    measured = lastJson(
      await ffmpeg(ffArgs(graph, loudnormPass1(input.preset), ['-f', 'null', '-'])),
    );
    // silence (no audio, or every source muted) has no integrated loudness: nothing to normalise
    const silent = !Number.isFinite(Number(measured.input_i));
    const post = silent ? null : loudnormPass2(input.preset, measured);
    await ffmpeg(ffArgs(graph, post, [...WAV, opts.out]));
  }
  let stems: Record<StemKind, string> | undefined;
  if (opts.stemsDir) {
    mkdirSync(opts.stemsDir, { recursive: true });
    const dir = opts.stemsDir;
    stems = {
      speech: join(dir, 'speech.wav'),
      other: join(dir, 'other.wav'),
      sfx: join(dir, 'sfx.wav'),
    };
    for (const k of STEMS) await ffmpeg(ffArgs(mixGraph(input, k), null, [...WAV, stems[k]]));
  }
  return { out: opts.out, graph, ...(measured ? { measured } : {}), ...(stems ? { stems } : {}) };
}
