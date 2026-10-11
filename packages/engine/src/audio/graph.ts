// The final audio mix (engine spec "Audio"; plan D-14, D-15). Final audio never goes through
// HyperFrames: one ffmpeg filter graph is built from the model. Each audio-track clip is trimmed at
// `inMs`, denoised when `denoise` is `light` or `strong`, gained to the loudness target when its media
// has `loudness`, scaled by `volume`, faded, and delayed to `startMs`; SFX cues are delayed to their
// times; muted tracks are left out. Everything goes through `amix` (normalisation off) and a limiter,
// then a two-pass `loudnorm` to the export target, aiming at -1.5 dBTP so the file stays under -1 dBTP. Stems (speech = the captions source
// tracks, other audio tracks, SFX) use the same chains, without the limiter and `loudnorm`.
// Ducking (v1.1, plan 14f): a track with `duck: true` that is not a captions source has its clips mixed
// into one bus, which `sidechaincompress` lowers whenever the speech bus (every speech clip, after its
// gain-to-target, volume and fades) is loud. This sits after each clip's gain-to-target and before the
// final `amix`, so it ducks level-matched sources. Speech and SFX are never ducked; with no speech clip
// the flag does nothing. The stems keep the same ducking, so `other` is what the mix hears.
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { VoxError } from '../errors.ts';
import type { MediaClip, MediaItem, Sequence } from '../model/schema.ts';
import { spanMs, speedOf } from '../model/speed.ts';
import type { Cue } from './cues.ts';

const run = promisify(execFile);

export type LoudnessPreset = 'youtube' | 'tiktok' | 'broadcast';
/** Export loudness targets, integrated LUFS (`render --loudness`; youtube is the default). */
export const LOUDNESS_TARGETS: Record<LoudnessPreset, number> = {
  youtube: -14,
  tiktok: -12,
  broadcast: -23,
};
/** The true-peak ceiling every export meets (audio QA checks it). */
export const TRUE_PEAK_DBTP = -1;
/**
 * The true peak `loudnorm` aims at: 0.5 dB under the ceiling, so the 48 kHz resample after
 * `loudnorm` and the AAC encode cannot push a loud (tiktok) mix over -1 dBTP (D-32).
 */
export const MIX_TRUE_PEAK_DBTP = -1.5;
export const LOUDNESS_RANGE_LU = 11;
export const SAMPLE_RATE = 48000;
/** The two fixed `afftdn` strengths (ffmpeg built in; no RNNoise model files in v1). */
export const DENOISE_FILTERS = {
  light: 'afftdn=nr=12:nf=-40',
  strong: 'afftdn=nr=24:nf=-30',
} as const;
/** -1 dBFS sample-peak limiter before `loudnorm`; delay compensated, no auto level. */
export const LIMITER = 'alimiter=limit=0.891251:attack=5:release=50:level=0:latency=1';

/**
 * The ducking compressor: music under speech drops while someone talks (the detector is the
 * level-matched speech bus) and comes back over 400 ms, so short gaps between words do not pump.
 */
export const DUCK_FILTER =
  'sidechaincompress=threshold=0.04:ratio=5:attack=20:release=400:makeup=1:link=average:detection=rms';

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

/**
 * Samples (at 48 kHz) that ffmpeg's `atempo` drops at the start of its output. A sped clip's trim
 * starts this much earlier, so its sound lands on time (engine spec "Clip speed", plan D-62; the
 * phase 14e spike measured 33 ms early at 0.5× without it, 9 ms with it).
 */
export const ATEMPO_PREROLL_SAMPLES = 1024;

/** The clip's source trim, resampled: its source span, with the `atempo` preroll when sped. */
function speedChain(it: MediaClip): string[] {
  const end = sec(it.inMs + spanMs(it));
  if (speedOf(it) === 1) {
    return [`atrim=start=${sec(it.inMs)}:end=${end}`, 'asetpts=PTS-STARTPTS', FORMAT];
  }
  // seconds, not samples: the source may not be 48 kHz before the resample
  const pre = Math.min(ATEMPO_PREROLL_SAMPLES, samples(it.inMs));
  const chain = [
    `atrim=start=${sec(it.inMs - (pre * 1000) / SAMPLE_RATE)}:end=${end}`,
    'asetpts=PTS-STARTPTS',
    FORMAT,
  ];
  // a clip that starts less than the preroll into its source gets silence in front instead
  if (pre < ATEMPO_PREROLL_SAMPLES) {
    chain.push(`adelay=delays=${ATEMPO_PREROLL_SAMPLES - pre}S:all=1`);
  }
  return chain;
}

/** `atempo` at the clip's speed (0.5–2 for sound, one stage), cut to the timeline length. */
function tempoChain(it: MediaClip): string[] {
  return [
    `atempo=${speedOf(it)}`,
    `atrim=end_sample=${samples(it.durationMs)}`,
    'asetpts=PTS-STARTPTS',
  ];
}
const FORMAT = `aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;

interface Source {
  id: string;
  kind: StemKind;
  file: string;
  chain: string[];
  /** The id of the ducked track (`duck: true` on a non-speech audio track). */
  duckTrack?: string;
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
      const chain = speedChain(it);
      if (it.denoise && it.denoise !== 'off') chain.push(DENOISE_FILTERS[it.denoise]);
      if (speedOf(it) !== 1) chain.push(...tempoChain(it));
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
      out.push({
        id: it.id,
        kind,
        file: abs(m.audioPath ?? m.path),
        chain,
        ...(track.duck && kind === 'other' ? { duckTrack: track.id } : {}),
      });
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
  const ducked = picked.filter((s) => s.duckTrack);
  // the speech clips are the detector of every ducked track, also in the `other` stem
  const keys = ducked.length > 0 ? all.filter((s) => s.kind === 'speech') : [];
  const duckTracks = keys.length > 0 ? [...new Set(ducked.map((s) => s.duckTrack!))] : [];
  const isDucked = (s: Source) => duckTracks.includes(s.duckTrack ?? '');
  const needed = all.filter((s) => picked.includes(s) || keys.includes(s));
  const len = samples(input.durationMs);
  const end = `apad=whole_len=${len},atrim=end_sample=${len}`;
  const inputs: string[] = [];
  const lines: string[] = [];
  const pad = new Map<Source, string>();
  const keyCopy = new Map<Source, string>();
  for (const [n, s] of needed.entries()) {
    let k = inputs.indexOf(s.file);
    if (k < 0) k = inputs.push(s.file) - 1;
    const out = `[s${n}]`;
    if (keys.includes(s) && picked.includes(s)) {
      // a speech clip feeds both the mix and the detector
      lines.push(`[${k}:a]${s.chain.join(',')},asplit=2[s${n}m][s${n}k]`);
      pad.set(s, `[s${n}m]`);
      keyCopy.set(s, `[s${n}k]`);
    } else {
      lines.push(`[${k}:a]${s.chain.join(',')}${out}`);
      pad.set(s, out);
      if (keys.includes(s)) keyCopy.set(s, out);
    }
  }
  const pads: string[] = [];
  const mixOf = (list: string[], name: string) => {
    if (list.length === 1) return list[0]!;
    lines.push(
      `${list.join('')}amix=inputs=${list.length}:normalize=0:duration=longest:dropout_transition=0${name}`,
    );
    return name;
  };
  if (duckTracks.length > 0) {
    const speech = mixOf(
      keys.map((s) => keyCopy.get(s)!),
      '[spk]',
    );
    const copies = duckTracks.map((_, d) => `[dk${d}]`);
    lines.push(
      duckTracks.length === 1
        ? `${speech}${end}${copies[0]}`
        : `${speech}${end},asplit=${duckTracks.length}${copies.join('')}`,
    );
    for (const [d, t] of duckTracks.entries()) {
      const bus = mixOf(
        picked.filter((s) => s.duckTrack === t).map((s) => pad.get(s)!),
        `[bus${d}]`,
      );
      lines.push(`${bus}${end}[bp${d}]`);
      lines.push(`[bp${d}]${copies[d]}${DUCK_FILTER}[duck${d}]`);
      pads.push(`[duck${d}]`);
    }
  }
  for (const s of picked) if (!isDucked(s)) pads.push(pad.get(s)!);
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
  return `loudnorm=I=${LOUDNESS_TARGETS[preset]}:TP=${MIX_TRUE_PEAK_DBTP}:LRA=${LOUDNESS_RANGE_LU}:print_format=json`;
}

/** Pass 2 of `loudnorm`: the measured values, linear normalisation, back to 48 kHz. */
export function loudnormPass2(preset: LoudnessPreset, m: LoudnormMeasure): string {
  return (
    `loudnorm=I=${LOUDNESS_TARGETS[preset]}:TP=${MIX_TRUE_PEAK_DBTP}:LRA=${LOUDNESS_RANGE_LU}` +
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

async function ffmpeg(args: string[], bin = 'ffmpeg'): Promise<string> {
  try {
    const r = await run(bin, args, { maxBuffer: 64 * 1024 * 1024 });
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
  /** The resolved ffmpeg (engine tool map); default `ffmpeg` on PATH. */
  ffmpeg?: string;
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
  const ff = (args: string[]) => ffmpeg(args, opts.ffmpeg);
  let measured: LoudnormMeasure | undefined;
  if (opts.normalize === false) {
    await ff(ffArgs(graph, null, [...WAV, opts.out]));
  } else {
    measured = lastJson(await ff(ffArgs(graph, loudnormPass1(input.preset), ['-f', 'null', '-'])));
    // silence (no audio, or every source muted) has no integrated loudness: nothing to normalise
    const silent = !Number.isFinite(Number(measured.input_i));
    const post = silent ? null : loudnormPass2(input.preset, measured);
    await ff(ffArgs(graph, post, [...WAV, opts.out]));
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
    for (const k of STEMS) await ff(ffArgs(mixGraph(input, k), null, [...WAV, stems[k]]));
  }
  return { out: opts.out, graph, ...(measured ? { measured } : {}), ...(stems ? { stems } : {}) };
}
