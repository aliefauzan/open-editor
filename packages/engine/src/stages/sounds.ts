// Sound tags (plan D-83): SoundAnalysis' built-in classifier (macOS 12+, 303 classes) labels the
// media's extracted audio in 1.5 s windows, from `vox-apple-llm --sounds` (the one native helper,
// D-16). The engine asks only for the audience-reaction classes (laughter, applause, cheering) that
// quick clips score. Optional: without the helper (`pnpm dist:no-apple`) or with a helper older than
// D-83 the stage reports "not available" and nothing else changes.
import { z } from 'zod';
import { VoxError } from '../errors.ts';
import { runHelper, type NativeHelper } from './highlights.ts';

/**
 * Classes asked for: the classifier's laughter and applause families. `crowd` (murmur, often room
 * noise), `music` and `speech` are no reaction and are not asked for.
 */
export const REACTION_CLASSES = [
  'laughter',
  'giggling',
  'snicker',
  'belly_laugh',
  'chuckle_chortle',
  'applause',
  'clapping',
  'cheering',
] as const;
/** Window length sent to the helper (the classifier takes 0.5–15 s). */
export const SOUND_WINDOW_SEC = 1.5;
/**
 * Lowest confidence kept. On a 240 s talk with real laughter the best laughter window scored 0.35
 * (nothing reached the helper's default 0.5); below 0.3 the hits were scattered single windows.
 */
export const SOUND_MIN_CONFIDENCE = 0.3;

const ms = z.int().min(0);

/** The helper's answer. */
export const SoundsAnswerSchema = z.strictObject({
  windows: z.array(
    z.strictObject({
      startMs: ms,
      endMs: ms,
      labels: z.array(z.strictObject({ id: z.string(), confidence: z.number().min(0).max(1) })),
    }),
  ),
  windowMs: ms,
});

/**
 * The stored `cache/sounds/<mediaId>.json`: the answer and what was asked, so a file asked with
 * other classes or another bar is recomputed, not reused.
 */
export const SoundsSchema = SoundsAnswerSchema.extend({
  classes: z.array(z.string()),
  minConfidence: z.number(),
});
export type Sounds = z.infer<typeof SoundsSchema>;

const HelperErrorSchema = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string() }),
});

export type SoundsRun = { available: true; sounds: Sounds } | { available: false; reason: string };

/** Fixed part of the time limit; the rest scales with the audio (240 s took 0.5–2 s on an M5). */
const BASE_TIMEOUT_MS = 60_000;

/** Time limit for audio of `durationMs`: 1 min plus a tenth of its length. */
export const soundsTimeoutMs = (durationMs: number): number =>
  BASE_TIMEOUT_MS + Math.max(0, durationMs) / 10;

/** True when `s` was asked the way this engine asks (same classes, same bar). */
export const soundsMatchRequest = (s: Sounds): boolean =>
  s.minConfidence === SOUND_MIN_CONFIDENCE &&
  s.classes.length === REACTION_CLASSES.length &&
  REACTION_CLASSES.every((c, i) => s.classes[i] === c);

const unavailable = (reason: string): SoundsRun => ({ available: false, reason });

/**
 * Runs the helper on one audio file. "Not available" (no helper, an old helper, `unavailable` from
 * the helper) is a value; a failed analysis, a crash, a timeout or a bad answer throws TOOL_FAILED;
 * an abort throws CANCELLED.
 */
export async function runSounds(
  helper: NativeHelper | undefined,
  audioPath: string,
  o: { signal?: AbortSignal; timeoutMs: number; redact?: (s: string) => string },
): Promise<SoundsRun> {
  if (!helper) return unavailable('this build has no native helper');
  const redact = o.redact ?? ((s: string) => s);
  const classes = [...REACTION_CLASSES];
  const out = await runHelper(helper, ['--sounds'], {
    ...o,
    input: `${JSON.stringify({
      audioPath,
      classes,
      windowSec: SOUND_WINDOW_SEC,
      minConfidence: SOUND_MIN_CONFIDENCE,
    })}\n`,
  });
  if (out.spawnError) return unavailable(`the native helper did not start (${out.spawnError})`);
  if (out.cancelled)
    throw new VoxError('CANCELLED', 'Sound tags were cancelled.', 'Run it again when ready.');
  if (out.timedOut) {
    throw new VoxError(
      'TOOL_FAILED',
      `Sound tags took longer than ${Math.round(o.timeoutMs / 1000)} s.`,
      'Quick clips go on without them.',
    );
  }
  const line = out.stdout.trim().split('\n').at(-1) ?? '';
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    // a helper older than D-83 exits 2 with its usage on stderr
    if (out.code === 2 && /usage/i.test(out.stderr))
      return unavailable('the native helper is older than sound tags');
    throw new VoxError(
      'TOOL_FAILED',
      `The native helper sent no sound tags (exit ${out.code}): ${redact(out.stderr.trim().slice(0, 300))}`,
      'Quick clips go on without them.',
    );
  }
  const err = HelperErrorSchema.safeParse(raw);
  if (err.success) {
    if (err.data.error.code === 'unavailable') return unavailable(err.data.error.message);
    throw new VoxError(
      'TOOL_FAILED',
      `Sound tags failed: ${redact(err.data.error.message)}`,
      'Quick clips go on without them.',
      { details: { code: err.data.error.code } },
    );
  }
  const ok = SoundsAnswerSchema.safeParse(raw);
  if (!ok.success || out.code !== 0) {
    throw new VoxError(
      'TOOL_FAILED',
      `The native helper sent an invalid sound-tags answer (exit ${out.code}).`,
      'Quick clips go on without them.',
    );
  }
  return {
    available: true,
    sounds: { ...ok.data, classes, minConfidence: SOUND_MIN_CONFIDENCE },
  };
}
