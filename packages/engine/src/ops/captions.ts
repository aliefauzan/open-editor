// setCaptions (engine spec "Captions", plan D-11, D-15, D-18). Overrides upsert by wordKey with field
// merge; resetWords removes them; overrides whose transcriptRev no longer matches are dropped.
import { z } from 'zod';
import { compareWordKeys } from '../model/normalise.ts';
import {
  AudioTrackIdSchema,
  CaptionOverrideSchema,
  SequenceIdSchema,
  TemplateIdSchema,
  WordKeySchema,
  type CaptionOverride,
  type CaptionTrack,
  type Project,
} from '../model/schema.ts';
import { fail, findSeq } from './core.ts';

export const setCaptionsArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  enabled: z.boolean().optional(),
  sourceTrackIds: z.array(AudioTrackIdSchema).optional(),
  preset: TemplateIdSchema.optional(),
  maxWords: z.int().min(1).max(20).optional(),
  maxLines: z.int().min(1).max(4).optional(),
  maxCharsPerLine: z.int().min(1).max(200).optional(),
  gapFillMs: z.int().min(0).max(10000).optional(),
  autoEmphasis: z.boolean().optional(),
  position: z.strictObject({ yPct: z.number().min(0).max(100) }).optional(),
  overrides: z.array(CaptionOverrideSchema).optional(),
  resetWords: z.array(WordKeySchema).optional(),
});

export const CAPTION_DEFAULTS: Omit<CaptionTrack, 'overrides'> = {
  enabled: true,
  sourceTrackIds: ['A1'],
  preset: 'base/plain',
  maxWords: 3,
  maxLines: 1,
  maxCharsPerLine: 18,
  gapFillMs: 400,
  autoEmphasis: false,
  position: { yPct: 75 },
};

/** `<mediaId>:<transcriptRev>:<wordIndex>` → parts. */
export function parseWordKey(key: string): { mediaId: string; rev: string; index: number } {
  const [mediaId = '', rev = '', index = '0'] = key.split(':');
  return { mediaId, rev, index: Number(index) };
}

function isLive(p: Project, key: string): boolean {
  const { mediaId, rev } = parseWordKey(key);
  const m = p.media.find((x) => x.id === mediaId);
  return m !== undefined && m.transcriptRev === rev;
}

export function setCaptions(p: Project, a: z.infer<typeof setCaptionsArgs>): void {
  const s = findSeq(p, a.sequenceId);
  const c: CaptionTrack = s.captions ?? { ...structuredClone(CAPTION_DEFAULTS), overrides: [] };
  const fields = [
    'enabled',
    'sourceTrackIds',
    'preset',
    'maxWords',
    'maxLines',
    'maxCharsPerLine',
    'gapFillMs',
    'autoEmphasis',
    'position',
  ] as const;
  for (const k of fields) {
    const v = a[k];
    if (v !== undefined) (c as Record<string, unknown>)[k] = structuredClone(v);
  }
  const byKey = new Map(c.overrides.map((o) => [o.wordKey, o]));
  for (const key of a.resetWords ?? []) byKey.delete(key);
  for (const patch of a.overrides ?? []) {
    if (!isLive(p, patch.wordKey)) {
      fail(
        'VALIDATION',
        `Word ${patch.wordKey} does not match a current transcript`,
        'Use word keys from the current transcript (media transcriptRev)',
        {
          wordKey: patch.wordKey,
        },
      );
    }
    const merged: CaptionOverride = { ...byKey.get(patch.wordKey), ...patch };
    const media = p.media.find((m) => m.id === parseWordKey(patch.wordKey).mediaId)!;
    const limit = media.durationMs ?? Infinity;
    for (const t of [merged.startMs, merged.endMs]) {
      if (t !== undefined && t > limit) {
        fail(
          'VALIDATION',
          `Override time ${t} ms is past the end of ${media.id}`,
          'Use source-media times inside the media',
          { wordKey: patch.wordKey },
        );
      }
    }
    if (
      merged.startMs !== undefined &&
      merged.endMs !== undefined &&
      merged.startMs >= merged.endMs
    ) {
      fail(
        'VALIDATION',
        `Override ${patch.wordKey}: startMs must be before endMs`,
        'Fix the word timing',
        { wordKey: patch.wordKey },
      );
    }
    byKey.set(patch.wordKey, merged);
  }
  c.overrides = [...byKey.values()]
    .filter((o) => isLive(p, o.wordKey))
    .sort((x, y) => compareWordKeys(x.wordKey, y.wordKey));
  s.captions = c;
}
