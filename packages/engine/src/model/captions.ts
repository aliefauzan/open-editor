// Captions derived from transcripts (engine spec "Captions"; plan D-11, D-15). Pure: the caller
// passes the transcripts. Used by compile, the SRT/VTT exporter and `engine.captions()`.
import { mapWordsToTimeline } from '../ops/words.ts';
import { frame, ms } from './fps.ts';
import type {
  CaptionOverride,
  CaptionTrack,
  MediaItem,
  Project,
  Sequence,
  Transcript,
} from './schema.ts';

export interface CaptionWord {
  /** `<mediaId>:<transcriptRev>:<wordIndex>`; the parts of a multi-word override share it. */
  key: string;
  text: string;
  /** Timeline ms. */
  startMs: number;
  endMs: number;
  emphasis: boolean;
}

export interface CaptionChunk {
  startMs: number;
  endMs: number;
  lines: { words: CaptionWord[] }[];
}

export type TranscriptOf = (media: MediaItem) => Transcript | undefined;

/** Chunks end at a pause longer than this (engine spec "Captions"). */
export const CHUNK_PAUSE_MS = 300;
/** Languages written without spaces: chunked by character count (`maxWords × 4`). */
const NO_SPACE = new Set(['ja', 'zh', 'yue', 'th', 'lo', 'km', 'my', 'bo']);
const SENTENCE_END = /[.!?…。！？]["')\]]*$/u;

export function isNoSpaceLanguage(language: string): boolean {
  return NO_SPACE.has(language.toLowerCase().split(/[-_]/)[0] ?? '');
}

interface Unit {
  key: string;
  text: string;
  startMs: number;
  endMs: number;
  itemId: string;
  breakAfter: boolean;
  emphasis?: boolean;
  noSpace: boolean;
}

const trackNo = (id: string): number => Number(id.slice(1));

/** Transcript with the overrides' `startMs`/`endMs` applied (source time), cached per media. */
function retimed(
  transcriptOf: TranscriptOf,
  overrides: ReadonlyMap<string, CaptionOverride>,
): TranscriptOf {
  return (media) => {
    const tr = transcriptOf(media);
    if (!tr) return undefined;
    let words = tr.words;
    tr.words.forEach((w, i) => {
      const o = overrides.get(`${media.id}:${media.transcriptRev}:${i}`);
      if (!o || (o.startMs === undefined && o.endMs === undefined)) return;
      if (words === tr.words) words = [...tr.words];
      const startMs = o.startMs ?? w.startMs;
      words[i] = { ...w, startMs, endMs: Math.max(startMs, o.endMs ?? w.endMs) };
    });
    return words === tr.words ? tr : { ...tr, words };
  };
}

/** Word units on the timeline: overrides applied, snapped, overlaps trimmed, multi-word text split. */
function units(p: Project, s: Sequence, cap: CaptionTrack, transcriptOf: TranscriptOf): Unit[] {
  const fps = s.canvas.fps;
  const f1 = (t: number) => ms(frame(t, fps) + 1, fps);
  const overrides = new Map(cap.overrides.map((o) => [o.wordKey, o]));
  const languages = new Map<string, string>();
  const tOf: TranscriptOf = (m) => {
    const tr = transcriptOf(m);
    if (tr) languages.set(m.id, tr.language);
    return tr;
  };
  const sources = cap.sourceTrackIds.filter((id) => s.audioTracks.some((t) => t.id === id));
  const words = mapWordsToTimeline(p, s, retimed(tOf, overrides), sources);

  // Lower track index wins where source tracks overlap in time: a word is dropped when a clip of
  // a lower-numbered source track covers its midpoint.
  const clipsOf = (trackId: string) =>
    (s.audioTracks.find((t) => t.id === trackId)?.items ?? []).map((i) => [
      i.startMs,
      i.startMs + i.durationMs,
    ]);
  const covered = (trackId: string, mid: number) =>
    sources.some(
      (other) =>
        trackNo(other) < trackNo(trackId) && clipsOf(other).some(([a, b]) => mid >= a! && mid < b!),
    );

  const out: Unit[] = [];
  for (const w of words) {
    if (w.kind === 'pause') continue;
    const o = overrides.get(w.key);
    if (o?.text === null) continue;
    if (covered(w.trackId, (w.startMs + w.endMs) / 2)) continue;
    const item = s.audioTracks
      .find((t) => t.id === w.trackId)
      ?.items.find((i) => i.id === w.itemId);
    const clipEnd = item ? item.startMs + item.durationMs : Number.POSITIVE_INFINITY;
    let start = ms(frame(w.startMs, fps), fps);
    let end = ms(frame(w.endMs, fps), fps);
    if (end <= start) {
      // zero-length (or snapped to zero) words get one frame, inside the clip
      if (f1(start) > clipEnd) start = ms(frame(clipEnd, fps) - 1, fps);
      end = f1(start);
    }
    out.push({
      key: w.key,
      text: o?.text ?? w.text,
      startMs: start,
      endMs: end,
      itemId: w.itemId,
      breakAfter: o?.breakAfter === true,
      ...(o?.emphasis === undefined ? {} : { emphasis: o.emphasis }),
      noSpace: isNoSpaceLanguage(languages.get(w.mediaId) ?? ''),
    });
  }
  out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  // Overlapping words are trimmed to the next word's start.
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i]!;
    const b = out[i + 1]!;
    if (a.endMs <= b.startMs) continue;
    if (b.startMs > a.startMs) a.endMs = b.startMs;
    else {
      // same start: the later word moves one frame on
      b.startMs = f1(a.startMs);
      a.endMs = b.startMs;
      if (b.endMs <= b.startMs) b.endMs = f1(b.startMs);
    }
  }

  // A multi-word override text counts as separate words sharing the word's time evenly.
  const split: Unit[] = [];
  for (const u of out) {
    const parts = u.noSpace ? [u.text.trim()] : u.text.trim().split(/\s+/u);
    const texts = parts.filter((t) => t !== '');
    if (texts.length === 0) continue;
    if (texts.length === 1) {
      split.push({ ...u, text: texts[0]! });
      continue;
    }
    const n = texts.length;
    const at = (k: number) =>
      k === n ? u.endMs : ms(frame(u.startMs + ((u.endMs - u.startMs) * k) / n, fps), fps);
    texts.forEach((text, k) => {
      split.push({
        ...u,
        text,
        startMs: at(k),
        endMs: Math.max(at(k + 1), at(k)),
        breakAfter: k === n - 1 ? u.breakAfter : false,
      });
    });
  }
  return split;
}

function emphasise(units: Unit[], auto: boolean): boolean[] {
  return units.map((u, i) => {
    if (u.emphasis !== undefined) return u.emphasis;
    if (!auto) return false;
    if (/\p{Nd}/u.test(u.text)) return true;
    const first = i === 0 || SENTENCE_END.test(units[i - 1]!.text);
    return !first && /^\p{Lu}/u.test(u.text.replace(/^["'(\[¿¡]+/u, ''));
  });
}

/**
 * The caption chunks of a sequence (timeline ms). Empty when the sequence has no caption track or
 * it is disabled.
 */
export function deriveCaptions(
  p: Project,
  sequenceId: string,
  transcriptOf: TranscriptOf,
): CaptionChunk[] {
  const s = p.sequences.find((x) => x.id === sequenceId);
  const cap = s?.captions;
  if (!s || !cap?.enabled) return [];
  const us = units(p, s, cap, transcriptOf);
  const emph = emphasise(us, cap.autoEmphasis === true);

  type Line = { words: CaptionWord[]; chars: number; full: boolean };
  const chunks: { lines: Line[]; count: number; chars: number }[] = [];
  let cur: (typeof chunks)[number] | undefined;
  let prev: Unit | undefined;
  for (let i = 0; i < us.length; i++) {
    const u = us[i]!;
    const word: CaptionWord = {
      key: u.key,
      text: u.text,
      startMs: u.startMs,
      endMs: u.endMs,
      emphasis: emph[i]!,
    };
    const len = [...u.text].length;
    const limitHit = cur
      ? u.noSpace
        ? cur.chars + len > cap.maxWords * 4
        : cur.count >= cap.maxWords
      : false;
    const newChunk =
      !cur ||
      limitHit ||
      (prev !== undefined &&
        (u.startMs - prev.endMs > CHUNK_PAUSE_MS || u.itemId !== prev.itemId || prev.breakAfter));
    const place = (c: NonNullable<typeof cur>): boolean => {
      const line = c.lines[c.lines.length - 1];
      const sep = u.noSpace ? 0 : 1;
      if (line && !line.full && line.chars + sep + len <= cap.maxCharsPerLine) {
        line.words.push(word);
        line.chars += sep + len;
        return true;
      }
      if (line && c.lines.length >= cap.maxLines) return false;
      c.lines.push({ words: [word], chars: len, full: len >= cap.maxCharsPerLine });
      return true;
    };
    if (newChunk || !place(cur!)) {
      cur = { lines: [], count: 0, chars: 0 };
      chunks.push(cur);
      place(cur);
    }
    cur!.count++;
    cur!.chars += len;
    prev = u;
  }

  const out: CaptionChunk[] = chunks.map((c) => {
    const words = c.lines.flatMap((l) => l.words);
    // inside a chunk each word lasts until the next word starts
    for (let k = 0; k + 1 < words.length; k++) {
      const next = words[k + 1]!;
      if (next.startMs > words[k]!.endMs) words[k]!.endMs = next.startMs;
    }
    return {
      startMs: words[0]!.startMs,
      endMs: words[words.length - 1]!.endMs,
      lines: c.lines.map((l) => ({ words: l.words })),
    };
  });
  for (let k = 0; k + 1 < out.length; k++) {
    const gap = out[k + 1]!.startMs - out[k]!.endMs;
    if (gap > 0 && gap < cap.gapFillMs) out[k]!.endMs = out[k + 1]!.startMs;
  }
  return out;
}

/** Chunk text: lines joined by a space (the compact view and SRT/VTT use one line per chunk line). */
export function chunkLines(c: CaptionChunk): string[] {
  return c.lines.map((l) => l.words.map((w) => w.text).join(' '));
}

function stamp(t: number, sep: ',' | '.'): string {
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(t % 1000, 3)}`;
}

/** SRT: one cue per chunk, one text line per chunk line; preset case/punctuation never apply. */
export function captionsToSrt(chunks: readonly CaptionChunk[]): string {
  return chunks
    .map(
      (c, i) =>
        `${i + 1}\n${stamp(c.startMs, ',')} --> ${stamp(c.endMs, ',')}\n${chunkLines(c).join('\n')}\n`,
    )
    .join('\n');
}

/** WebVTT: one cue per chunk, one text line per chunk line. */
export function captionsToVtt(chunks: readonly CaptionChunk[]): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cues = chunks.map(
    (c) =>
      `${stamp(c.startMs, '.')} --> ${stamp(c.endMs, '.')}\n${chunkLines(c).map(esc).join('\n')}\n`,
  );
  return `WEBVTT\n\n${cues.join('\n')}`;
}
