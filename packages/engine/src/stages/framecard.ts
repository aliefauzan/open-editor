// Frame cards (plan D-73): a short Apple Vision description of a still (labels, on-screen text,
// faces, saliency, aesthetics) from the Python `framecard` tool, so the agent reads about 100 tokens
// of text per still instead of an image. Cards are cached per still content and card version under
// `<project>/cache/cards/`; a repeat call for the same still runs no Vision request.
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { VoxError } from '../errors.ts';
import { writeAtomic } from '../history/files.ts';
import { resolveProjectPath } from '../paths.ts';
import { runPyTool, type PyBridgeOptions } from '../py.ts';

/** Must equal `CARD_VERSION` in `py/vox_py/framecard.py`; part of the cache key. */
export const FRAME_CARD_VERSION = 1;
/** At most this many stills per call (the tool's own limit). */
export const MAX_FRAME_CARDS = 100;

const unit = z.number().min(0).max(1);
const Box = z.strictObject({ x: unit, y: unit, w: unit, h: unit });
const ScoredBox = Box.extend({ score: unit });

// ---- Python tool result (py/tests/schemas/framecard.result.json) ----

export const FrameCardBodySchema = z.strictObject({
  width: z.int().min(1),
  height: z.int().min(1),
  labels: z
    .array(z.strictObject({ label: z.string().min(1), confidence: z.number().gt(0.3).max(1) }))
    .max(6),
  text: z.array(z.strictObject({ text: z.string(), box: Box, confidence: unit })),
  faces: z.strictObject({ count: z.int().min(0), boxes: z.array(ScoredBox) }),
  saliency: ScoredBox.nullable(),
  /** macOS 15+ only. */
  aesthetics: z
    .strictObject({ overall: z.number().min(-1).max(1), utility: z.boolean() })
    .optional(),
  ms: z.int().min(0),
});
export type FrameCardBody = z.infer<typeof FrameCardBodySchema>;

const FrameCardErrorSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  message: z.string().min(1),
});

export const FrameCardResultSchema = z.strictObject({
  version: z.literal(FRAME_CARD_VERSION),
  textLevel: z.enum(['fast', 'accurate']),
  cards: z
    .array(
      z.union([
        FrameCardBodySchema.extend({ path: z.string().min(1) }),
        z.strictObject({ path: z.string().min(1), error: FrameCardErrorSchema }),
      ]),
    )
    .min(1)
    .max(MAX_FRAME_CARDS),
});

/** One still's card, or why it has none (an unreadable or empty still). */
export type FrameCard =
  | ({ path: string; cached: boolean } & FrameCardBody)
  | { path: string; error: z.infer<typeof FrameCardErrorSchema> };

export interface FrameCardEnv {
  projectDir: string;
  py: PyBridgeOptions;
  /** Defaults to `process.platform` (tests). */
  platform?: NodeJS.Platform;
}

/**
 * Cards for stills inside the project folder, in order. Off macOS this fails with
 * APPLE_UNAVAILABLE before any process starts; the caller falls back to pixels.
 */
export async function frameCards(
  env: FrameCardEnv,
  paths: readonly string[],
): Promise<FrameCard[]> {
  if ((env.platform ?? process.platform) !== 'darwin') {
    throw new VoxError(
      'APPLE_UNAVAILABLE',
      'Frame cards need Apple Vision (macOS).',
      'Look at the stills as images instead (detail "pixels").',
    );
  }
  if (paths.length === 0 || paths.length > MAX_FRAME_CARDS) {
    throw new VoxError(
      'VALIDATION',
      `Pass 1 to ${String(MAX_FRAME_CARDS)} stills.`,
      'Ask for fewer stills.',
    );
  }
  const cacheDir = join(env.projectDir, 'cache', 'cards');
  const out: (FrameCard | undefined)[] = [];
  const todo: { i: number; path: string; cacheFile: string }[] = [];
  for (const [i, p] of paths.entries()) {
    // Only stills inside the project (engine stills and project media), never any other file.
    const real = await resolveProjectPath(env.projectDir, relative(env.projectDir, p));
    const key = createHash('sha256')
      .update(`framecard v${String(FRAME_CARD_VERSION)}\0`)
      .update(await readFile(real))
      .digest('hex');
    const cacheFile = join(cacheDir, `${key}.json`);
    const hit = await readFile(cacheFile, 'utf8')
      .then((t) => FrameCardBodySchema.safeParse(JSON.parse(t)))
      .catch(() => null);
    // A damaged cache file is rebuilt, not returned.
    if (hit?.success) out[i] = { path: p, cached: true, ...hit.data };
    else todo.push({ i, path: real, cacheFile });
  }
  if (todo.length > 0) {
    const r = await runPyTool(
      'framecard',
      { images: todo.map((t) => t.path) },
      FrameCardResultSchema,
      env.py,
    );
    if (r.cards.length !== todo.length) {
      throw new VoxError(
        'PY_OUTPUT_INVALID',
        `framecard returned ${String(r.cards.length)} cards for ${String(todo.length)} stills`,
        'Try again; run vox doctor if it keeps failing.',
      );
    }
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    for (const [j, t] of todo.entries()) {
      const c = r.cards[j]!;
      const p = paths[t.i]!;
      if ('error' in c) {
        out[t.i] = { path: p, error: c.error };
        continue;
      }
      const body: FrameCardBody = { ...c };
      delete (body as { path?: string }).path;
      await writeAtomic(t.cacheFile, JSON.stringify(body));
      out[t.i] = { path: p, cached: false, ...body };
    }
  }
  return out as FrameCard[];
}
