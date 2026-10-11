// Pure helpers of the Subtitles panel (app spec "Subtitles panel"; plan D-11, D-15): every edit is one
// op, built here — word overrides (`setCaptions`), word removal (`removeWords`) and pause/filler
// removal (`removePauses`). Override times are source-media ms (engine spec "Captions").
import type { CaptionChunk, CaptionWord, MediaClip, Project, Sequence } from '../../shared/project.ts';
import type { OpCall } from './store.ts';

export interface PanelWord extends CaptionWord {
  chunk: number;
  /** Last part of a multi-word override (the parts share one key). */
  last: boolean;
}

/** Words in order with their chunk index; parts of one override (same key) count once for actions. */
export function panelWords(chunks: readonly CaptionChunk[]): PanelWord[] {
  const out: PanelWord[] = [];
  chunks.forEach((c, chunk) => {
    const words = c.lines.flatMap((l) => l.words);
    words.forEach((w, i) => out.push({ ...w, chunk, last: words[i + 1]?.key !== w.key }));
  });
  return out;
}

export const setCaptions = (sequenceId: string, args: Record<string, unknown>): OpCall => ({
  op: 'setCaptions',
  args: { sequenceId, ...args },
});

/** One word's override (text, emphasis, breakAfter, startMs, endMs, or `text: null` to hide). */
export function overrideOp(
  sequenceId: string,
  wordKey: string,
  patch: Record<string, unknown>,
): OpCall {
  return setCaptions(sequenceId, { overrides: [{ wordKey, ...patch }] });
}

/** Find and replace across the sequence (case-insensitive): one op with every changed word. */
export function findReplaceOp(
  sequenceId: string,
  chunks: readonly CaptionChunk[],
  find: string,
  replace: string,
): OpCall | null {
  const needle = find.trim();
  if (!needle) return null;
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const byKey = new Map<string, string[]>();
  for (const w of panelWords(chunks)) {
    const parts = byKey.get(w.key) ?? [];
    parts.push(w.text);
    byKey.set(w.key, parts);
  }
  const overrides: { wordKey: string; text: string | null }[] = [];
  for (const [wordKey, parts] of byKey) {
    const text = parts.join(' ');
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const next = text.replace(re, replace).trim();
    overrides.push({ wordKey, text: next === '' ? null : next });
  }
  return overrides.length ? setCaptions(sequenceId, { overrides }) : null;
}

/** "Reset to transcript": removes the overrides of these words (all words → every override). */
export function resetOp(sequenceId: string, keys: readonly string[]): OpCall | null {
  const uniq = [...new Set(keys)];
  return uniq.length ? setCaptions(sequenceId, { resetWords: uniq }) : null;
}

export function frameMs(seq: Sequence): number {
  const { num, den } = seq.canvas.fps;
  return (1000 * den) / num;
}

/** Media clips on the caption source tracks (A1 by default). */
function sourceClips(seq: Sequence): MediaClip[] {
  const ids = seq.captions?.sourceTrackIds ?? ['A1'];
  return seq.audioTracks
    .filter((t) => ids.includes(t.id))
    .flatMap((t) => t.items)
    .filter((i): i is MediaClip => i.type === 'media');
}

/** Timeline ms of a word → its source-media ms, through the clip that plays it. */
export function toSourceMs(seq: Sequence, wordKey: string, timelineMs: number): number | null {
  const mediaId = wordKey.split(':')[0];
  const clip = sourceClips(seq).find(
    (c) =>
      c.mediaId === mediaId &&
      timelineMs >= c.startMs - 1 &&
      timelineMs <= c.startMs + c.durationMs + 1,
  );
  return clip ? Math.max(0, Math.round(timelineMs - clip.startMs + clip.inMs)) : null;
}

/**
 * Nudge a word's start or end by `frames` (±) of the sequence's frame rate: one override with the new
 * source time. Returns null when the word cannot be placed or the times would cross.
 */
export function nudgeOp(
  seq: Sequence,
  word: { key: string; startMs: number; endMs: number },
  edge: 'start' | 'end',
  frames: number,
): OpCall | null {
  const o = seq.captions?.overrides.find((x) => x.wordKey === word.key);
  const start = o?.startMs ?? toSourceMs(seq, word.key, word.startMs);
  const end = o?.endMs ?? toSourceMs(seq, word.key, word.endMs);
  if (start === null || end === null) return null;
  const d = Math.round(frames * frameMs(seq));
  const next = edge === 'start' ? { startMs: start + d, endMs: end } : { startMs: start, endMs: end + d };
  if (next.startMs < 0 || next.startMs >= next.endMs) return null;
  return overrideOp(seq.id, word.key, edge === 'start' ? { startMs: next.startMs } : { endMs: next.endMs });
}

/** Split after this word (`breakAfter: true`), or merge with the next chunk (drop that break). */
export function breakOp(sequenceId: string, wordKey: string, on: boolean): OpCall {
  return overrideOp(sequenceId, wordKey, { breakAfter: on });
}

/** Delete word (D-15): cuts the words' time from the linked video and audio, one undo entry. */
export function removeWordsOp(sequenceId: string, keys: readonly string[]): OpCall | null {
  const uniq = [...new Set(keys)];
  return uniq.length ? { op: 'removeWords', args: { sequenceId, wordKeys: uniq } } : null;
}

export type PauseKind = 'pause' | 'filler' | 'repeat';

export interface PauseRange {
  startMs: number;
  endMs: number;
  kind: PauseKind;
  wordKeys: string[];
}

export interface PauseQuery {
  sequenceId: string;
  minPauseMs: number;
  kinds: PauseKind[];
}

export function removePausesOp(
  q: PauseQuery,
  o: { dryRun?: boolean; wordKeys?: string[] } = {},
): OpCall {
  return {
    op: 'removePauses',
    args: {
      sequenceId: q.sequenceId,
      minPauseMs: q.minPauseMs,
      kinds: q.kinds,
      ...(o.wordKeys ? { wordKeys: o.wordKeys } : {}),
      ...(o.dryRun ? { dryRun: true } : {}),
    },
  };
}

/** "Apply": the full list as one op, or the ticked subset by `wordKeys` (each range keeps `keepMs`). */
export function applyPausesOp(
  q: PauseQuery,
  ranges: readonly PauseRange[],
  ticked: ReadonlySet<number>,
): OpCall | null {
  if (ticked.size === 0) return null;
  if (ticked.size === ranges.length) return removePausesOp(q);
  const wordKeys = ranges.filter((_, i) => ticked.has(i)).flatMap((r) => r.wordKeys);
  return removePausesOp(q, { wordKeys });
}

/** `m:ss.cc` for the list. */
export function clock(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

export function hiddenWords(seq: Sequence | undefined): string[] {
  return (seq?.captions?.overrides ?? []).filter((o) => o.text === null).map((o) => o.wordKey);
}

/** True when the chunk ends at a break the user set (only those can be merged; D-NN 10b). */
export function userBreakAfter(seq: Sequence | undefined, wordKey: string): boolean {
  return (seq?.captions?.overrides ?? []).some((o) => o.wordKey === wordKey && o.breakAfter === true);
}

export function findSeq(p: Project | null, id: string | null): Sequence | undefined {
  return p?.sequences.find((s) => s.id === id);
}
