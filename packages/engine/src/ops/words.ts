// Word → timeline mapping and the text-based cutting ops removePauses / removeWords (engine spec
// "Edit operations", "Captions"; plan D-15). Phase 03's deriveCaptions reuses mapWordsToTimeline.
import { z } from 'zod';
import {
  SequenceIdSchema,
  WordKeySchema,
  type MediaItem,
  type Project,
  type Sequence,
  type Transcript,
  type WordKind,
} from '../model/schema.ts';
import { endOf, fail, findSeq, findTrack, snapT, type OpContext } from './core.ts';
import { rippleRange } from './items.ts';

export interface TimelineWord {
  /** `<mediaId>:<transcriptRev>:<wordIndex>` */
  key: string;
  text: string;
  kind: WordKind;
  /** Timeline ms, clamped to the clip. */
  startMs: number;
  endMs: number;
  mediaId: string;
  index: number;
  trackId: string;
  itemId: string;
}

/** Audio tracks whose clips provide the spoken words: the caption source tracks, `A1` when captions are off. */
export function wordSourceTracks(s: Sequence): string[] {
  const ids = s.captions?.enabled ? s.captions.sourceTrackIds : ['A1'];
  return ids.filter((id) => s.audioTracks.some((t) => t.id === id));
}

/**
 * Every transcript word of the clips on the source tracks whose midpoint lies in
 * `[inMs, inMs + durationMs)`, shifted to timeline time and clamped to the clip; sorted by start.
 */
export function mapWordsToTimeline(
  p: Project,
  s: Sequence,
  transcriptOf: (media: MediaItem) => Transcript | undefined,
  trackIds: readonly string[] = wordSourceTracks(s),
): TimelineWord[] {
  const out: TimelineWord[] = [];
  const cache = new Map<string, Transcript | undefined>();
  for (const trackId of trackIds) {
    const track = s.audioTracks.find((t) => t.id === trackId);
    if (!track) continue;
    for (const it of track.items) {
      if (it.type !== 'media') continue;
      const media = p.media.find((m) => m.id === it.mediaId);
      if (!media?.transcriptRev) continue;
      if (!cache.has(media.id)) cache.set(media.id, transcriptOf(media));
      const tr = cache.get(media.id);
      if (!tr) continue;
      const inEnd = it.inMs + it.durationMs;
      tr.words.forEach((w, index) => {
        const mid = (w.startMs + w.endMs) / 2;
        if (mid < it.inMs || mid >= inEnd) return;
        const clamp = (t: number) => Math.min(endOf(it), Math.max(it.startMs, t));
        out.push({
          key: `${media.id}:${media.transcriptRev}:${index}`,
          text: w.text,
          kind: w.kind,
          startMs: clamp(it.startMs + w.startMs - it.inMs),
          endMs: clamp(it.startMs + w.endMs - it.inMs),
          mediaId: media.id,
          index,
          trackId,
          itemId: it.id,
        });
      });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.trackId.localeCompare(b.trackId));
}

export interface CutRange {
  startMs: number;
  endMs: number;
  kind: WordKind;
  wordKeys: string[];
}

interface RawRange extends CutRange {
  trackId: string;
}

const KindsSchema = z.array(z.enum(['pause', 'filler', 'repeat'])).min(1);

export const removePausesArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  minPauseMs: z.int().min(0).default(350),
  keepMs: z.int().min(0).default(80),
  kinds: KindsSchema.default(['pause']),
  wordKeys: z.array(WordKeySchema).optional(),
  dryRun: z.boolean().optional(),
});

export const removeWordsArgs = z.strictObject({
  sequenceId: SequenceIdSchema,
  wordKeys: z.array(WordKeySchema).min(1),
  dryRun: z.boolean().optional(),
});

/** Snap, drop empty ranges, sort and merge ranges that touch (kind of the first, keys concatenated). */
function mergeRanges(s: Sequence, raw: RawRange[]): RawRange[] {
  const snapped = raw
    .map((r) => ({ ...r, startMs: snapT(s, r.startMs), endMs: snapT(s, r.endMs) }))
    .filter((r) => r.endMs > r.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out: RawRange[] = [];
  for (const r of snapped) {
    const last = out[out.length - 1];
    if (last && r.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, r.endMs);
      last.wordKeys.push(...r.wordKeys);
    } else out.push({ ...r, wordKeys: [...r.wordKeys] });
  }
  return out;
}

function applyRanges(
  p: Project,
  s: Sequence,
  ranges: RawRange[],
  dryRun: boolean | undefined,
  ctx: OpContext,
) {
  if (!dryRun) {
    for (const r of [...ranges].reverse())
      rippleRange(p, s, findTrack(s, r.trackId), r.startMs, r.endMs, ctx);
  }
  return {
    ranges: ranges.map(({ startMs, endMs, kind, wordKeys }) => ({
      startMs,
      endMs,
      kind,
      wordKeys,
    })),
  };
}

export function removePauses(
  p: Project,
  a: z.infer<typeof removePausesArgs>,
  ctx: OpContext,
): { ranges: CutRange[] } {
  const s = findSeq(p, a.sequenceId);
  const only = a.wordKeys ? new Set(a.wordKeys) : undefined;
  const half = a.keepMs / 2;
  const raw: RawRange[] = [];
  for (const w of mapWordsToTimeline(p, s, (m) => ctx.transcript(m))) {
    if (!(a.kinds as string[]).includes(w.kind)) continue;
    if (only && !only.has(w.key)) continue;
    const base = { kind: w.kind, wordKeys: [w.key], trackId: w.trackId };
    if (w.kind === 'pause') {
      if (w.endMs - w.startMs < a.minPauseMs) continue;
      raw.push({ ...base, startMs: w.startMs + half, endMs: w.endMs - half });
    } else raw.push({ ...base, startMs: w.startMs, endMs: w.endMs });
  }
  return applyRanges(p, s, mergeRanges(s, raw), a.dryRun, ctx);
}

export function removeWords(
  p: Project,
  a: z.infer<typeof removeWordsArgs>,
  ctx: OpContext,
): { ranges: CutRange[] } {
  const s = findSeq(p, a.sequenceId);
  const words = new Map(mapWordsToTimeline(p, s, (m) => ctx.transcript(m)).map((w) => [w.key, w]));
  const missing = a.wordKeys.filter((k) => !words.has(k));
  if (missing.length > 0) {
    fail(
      'NOT_FOUND',
      `Words not on the timeline: ${missing.join(', ')}`,
      'Use word keys from the current transcript of clips in the sequence',
      {
        wordKeys: missing,
      },
    );
  }
  const raw = [...new Set(a.wordKeys)].map((k) => {
    const w = words.get(k)!;
    return { startMs: w.startMs, endMs: w.endMs, kind: w.kind, wordKeys: [k], trackId: w.trackId };
  });
  return applyRanges(p, s, mergeRanges(s, raw), a.dryRun, ctx);
}
