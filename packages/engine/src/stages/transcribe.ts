// Transcribe (engine spec "Speech gate and word kinds", "Transcripts"; D-15, D-21): `vox_py.transcribe`
// (Silero VAD gate, then mlx-whisper with the filler prompt), then `computeWordKinds`, then
// `transcripts/<mediaId>.json`. The raw tool result is cached by (media hash, model revision,
// fillers, language), so a rerun never starts Python.
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { VoxError } from '../errors.ts';
import { writeAtomic } from '../history/files.ts';
import { TranscriptSchema, type MediaItem, type Transcript } from '../model/schema.ts';
import { resolveProjectPath } from '../paths.ts';
import { FILLERS, computeWordKinds } from '../text/fillers.ts';
import { FORMAT_WHITELIST } from './media/ffargs.ts';
import { sniffFile } from './media/sniff.ts';

/** mlx-whisper model pin (R5; mirrors `MODEL_REPO`/`MODEL_REVISION` in `py/vox_py/transcribe.py`). */
export const WHISPER_REPO = 'mlx-community/whisper-large-v3-turbo';
export const WHISPER_REVISION = 'a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb';
/** Folder name of the Whisper model under the tools `models/` folder (used when present). */
export const WHISPER_DIR = 'whisper-large-v3-turbo';
export const TRANSCRIBE_VERSION = 1;

const ms = z.int().nonnegative();
export const TranscribeToolResultSchema = z.strictObject({
  language: z.string().min(1),
  words: z.array(z.strictObject({ text: z.string().min(1), startMs: ms, endMs: ms })),
  speechRegions: z.array(z.strictObject({ startMs: ms, endMs: ms })),
  dropped: z.strictObject({ segments: ms, words: ms }),
  model: z.strictObject({ repo: z.string().min(1), revision: z.string().regex(/^[0-9a-f]{40}$/) }),
});
export type TranscribeToolResult = z.infer<typeof TranscribeToolResultSchema>;

export const TranscribeToolRequestSchema = z.strictObject({
  audioPath: z.string().min(1),
  language: z.string().min(1).nullable().optional(),
  fillers: z.array(z.string().min(1)).optional(),
  modelPath: z.string().min(1).optional(),
  ffmpeg: z.string().min(1).optional(),
  formatWhitelist: z.string().min(1).optional(),
});
export type TranscribeToolRequest = z.infer<typeof TranscribeToolRequestSchema>;

export interface TranscribeEnv {
  projectDir: string;
  tools: Readonly<Record<string, string | undefined>>;
  runTool: (request: TranscribeToolRequest) => Promise<TranscribeToolResult>;
  /** Content hash of the media file (ingest's index), else hashed now. */
  mediaHash: (media: MediaItem) => Promise<string>;
}

export interface TranscribeOutcome {
  mediaId: string;
  transcript: Transcript;
  transcriptPath: string;
  transcriptRev: string;
  /** Read from the cache (no Python run). */
  cached: boolean;
  /** True when the media already points at this transcript (no model change needed). */
  unchanged: boolean;
  dropped: { segments: number; words: number };
}

/** The engine-side transcript: word kinds and pause pseudo-words (02's `computeWordKinds`). */
export function toTranscript(raw: TranscribeToolResult): Transcript {
  return TranscriptSchema.parse({
    language: raw.language,
    words: computeWordKinds(raw.words, { language: raw.language }),
    speechRegions: raw.speechRegions,
  });
}

export function transcribeCacheKey(mediaHash: string, language: string | undefined): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'transcribe',
        TRANSCRIBE_VERSION,
        mediaHash,
        WHISPER_REPO,
        WHISPER_REVISION,
        FILLERS['en'],
        language ?? null,
      ]),
    )
    .digest('hex');
}

export async function transcribeMedia(
  env: TranscribeEnv,
  media: MediaItem,
  opts: { language?: string } = {},
): Promise<TranscribeOutcome> {
  if (media.kind !== 'video' && media.kind !== 'audio') {
    throw new VoxError(
      'VALIDATION',
      `Media ${media.id} is a ${media.kind}, not audio or video.`,
      'Transcribe a video or audio item.',
    );
  }
  if (media.hasAudio === false) {
    throw new VoxError(
      'VALIDATION',
      `This ${media.kind} has no sound.`,
      'Quick clips and captions follow the speech: pick a video with sound, or edit this one by hand.',
      {
        details: { mediaId: media.id },
      },
    );
  }
  const dir = env.projectDir;
  const key = transcribeCacheKey(await env.mediaHash(media), opts.language);
  const rev = key.slice(0, 16);
  const cacheFile = join(dir, 'cache', 'transcribe', `${key}.json`);
  let raw: TranscribeToolResult | undefined;
  try {
    raw = TranscribeToolResultSchema.parse(JSON.parse(await readFile(cacheFile, 'utf8')));
  } catch {
    raw = undefined;
  }
  const cached = raw !== undefined;
  if (!raw) {
    const input = await resolveProjectPath(dir, media.audioPath ?? media.path);
    const sniffed = await sniffFile(input);
    if (sniffed.kind === 'document' || sniffed.kind === 'image') {
      throw new VoxError(
        'MEDIA_UNSUPPORTED',
        `This ${media.kind} has no sound to transcribe.`,
        'Quick clips and captions follow the speech: pick a video with sound, or edit this one by hand.',
        { details: { mediaId: media.id } },
      );
    }
    const models = env.tools['models'];
    const modelDir = models ? join(models, WHISPER_DIR) : undefined;
    const hasModel = modelDir
      ? await stat(join(modelDir, 'weights.safetensors')).then(
          () => true,
          () => false,
        )
      : false;
    raw = await env.runTool({
      audioPath: input,
      fillers: [...(FILLERS['en'] ?? [])],
      ...(opts.language ? { language: opts.language } : {}),
      ...(hasModel && modelDir ? { modelPath: modelDir } : {}),
      ...(env.tools['ffmpeg'] ? { ffmpeg: env.tools['ffmpeg'] } : {}),
      formatWhitelist: FORMAT_WHITELIST[sniffed.format],
    });
    await mkdir(join(dir, 'cache', 'transcribe'), { recursive: true, mode: 0o700 });
    await writeAtomic(cacheFile, JSON.stringify(raw));
  }
  const transcript = toTranscript(raw);
  const transcriptPath = `transcripts/${media.id}.json`;
  await mkdir(join(dir, 'transcripts'), { recursive: true, mode: 0o700 });
  const file = join(dir, transcriptPath);
  const body = `${JSON.stringify(transcript, null, 1)}\n`;
  const same = await readFile(file, 'utf8').then(
    (t) => t === body,
    () => false,
  );
  if (!same) await writeAtomic(file, body);
  return {
    mediaId: media.id,
    transcript,
    transcriptPath,
    transcriptRev: rev,
    cached,
    unchanged: same && media.transcriptPath === transcriptPath && media.transcriptRev === rev,
    dropped: raw.dropped,
  };
}
