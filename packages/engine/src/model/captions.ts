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
/** A phrase ends at a sentence end or a clause mark (two-tier key words, D-93). */
const CLAUSE_END = /[.!?…。！？,;:，、；：–—]["')\]]*$/u;

/**
 * How the caption preset lays chunks out (styles spec "Caption presets", D-93). `tiered`: auto
 * emphasis also marks each phrase's closing key word, and an emphasis run takes its own line after
 * the plain words and ends the chunk.
 */
export interface CaptionLayout {
  tiered?: boolean;
}

/**
 * Words that never close a phrase as its key word (English and Indonesian function words and
 * particles of 4+ letters; shorter words never count). Lower case, no punctuation.
 */
const NOT_KEY = new Set(
  (
    'this that these those with have from they them then than what when were been into your ' +
    'just like also very some there their about would could should because which where while ' +
    'really going gonna wanna thing things something anything everything here does doing done ' +
    'yang juga gitu kita kami kalian mereka saya kamu nggak enggak ngga tidak bukan tapi jadi ' +
    'kalau karena dari pada untuk sama dengan atau bisa akan udah sudah lagi saja banget dong ' +
    'kayak kaya emang memang masih harus pernah tahu bahwa punya semua para oleh agar supaya ' +
    'biar terus trus lalu kemudian setelah sebelum sambil begitu gimana bagaimana kenapa mengapa ' +
    'siapa dimana kapan banyak sangat lebih paling cuma hanya yaitu yakni adalah ialah nanti ' +
    'sekarang tadi pasti mungkin bahkan sebenarnya benar bakal bakalan mana buat dalam seperti ' +
    'kita-kita dirinya sendiri gini begini sini situ yaudah okay oke'
  ).split(' '),
);

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

const core = (t: string) => t.toLowerCase().replace(/^[^\p{L}\p{Nd}]+|[^\p{L}\p{Nd}]+$/gu, '');
const isNumber = (t: string) => /\p{Nd}/u.test(t);
/** A content word: 4+ letters and not a function word. */
const isKey = (t: string) => {
  const c = core(t);
  return !isNumber(c) && [...c.replace(/[^\p{L}]/gu, '')].length >= 4 && !NOT_KEY.has(c);
};

/** Phrase ends: a pause over CHUNK_PAUSE_MS, a clip change, a manual break or a clause mark. */
function phraseEnds(units: Unit[]): boolean[] {
  return units.map((u, i) => {
    const next = units[i + 1];
    return (
      next === undefined ||
      next.startMs - u.endMs > CHUNK_PAUSE_MS ||
      next.itemId !== u.itemId ||
      u.breakAfter ||
      CLAUSE_END.test(u.text)
    );
  });
}

function emphasise(units: Unit[], auto: boolean, tiered: boolean): boolean[] {
  const rule = units.map((u, i) => {
    if (!auto) return false;
    if (isNumber(u.text)) return true;
    const first = i === 0 || SENTENCE_END.test(units[i - 1]!.text);
    return !first && /^\p{Lu}/u.test(u.text.replace(/^["'([¿¡]+/u, ''));
  });
  if (auto && tiered) {
    // two tiers (D-93): each phrase's closing key word, and the word after a number in the same
    // phrase (its unit: "80 ribu", "20 percent")
    const ends = phraseEnds(units);
    units.forEach((u, i) => {
      if (ends[i] && isKey(u.text)) rule[i] = true;
      if (i > 0 && !ends[i - 1] && isNumber(units[i - 1]!.text) && isKey(u.text)) rule[i] = true;
    });
  }
  return units.map((u, i) => u.emphasis ?? rule[i]!);
}

/**
 * The caption chunks of a sequence (timeline ms). Empty when the sequence has no caption track or
 * it is disabled.
 */
export function deriveCaptions(
  p: Project,
  sequenceId: string,
  transcriptOf: TranscriptOf,
  layout: CaptionLayout = {},
): CaptionChunk[] {
  const s = p.sequences.find((x) => x.id === sequenceId);
  const cap = s?.captions;
  if (!s || !cap?.enabled) return [];
  const us = units(p, s, cap, transcriptOf);
  const tiered = layout.tiered === true;
  const emph = emphasise(us, cap.autoEmphasis === true, tiered);

  type Line = { words: CaptionWord[]; chars: number; full: boolean };
  const chunks: { lines: Line[]; count: number; chars: number; emph: number }[] = [];
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
    // two tiers: plain words and the emphasis run count apart; a plain word after the run starts
    // a new chunk
    const counted = cur
      ? tiered
        ? word.emphasis
          ? cur.emph
          : cur.count - cur.emph
        : cur.count
      : 0;
    const limitHit = cur
      ? u.noSpace
        ? cur.chars + len > cap.maxWords * 4
        : counted >= cap.maxWords
      : false;
    const newChunk =
      !cur ||
      limitHit ||
      (tiered && !word.emphasis && cur.emph > 0) ||
      (prev !== undefined &&
        (u.startMs - prev.endMs > CHUNK_PAUSE_MS || u.itemId !== prev.itemId || prev.breakAfter));
    const place = (c: NonNullable<typeof cur>): boolean => {
      const line = c.lines[c.lines.length - 1];
      const sep = u.noSpace ? 0 : 1;
      if (tiered && line && line.words[line.words.length - 1]!.emphasis !== word.emphasis) {
        // the emphasis run takes its own line
        if (c.lines.length >= cap.maxLines) return false;
        c.lines.push({ words: [word], chars: len, full: len >= cap.maxCharsPerLine });
        return true;
      }
      if (line && !line.full && line.chars + sep + len <= cap.maxCharsPerLine) {
        line.words.push(word);
        line.chars += sep + len;
        return true;
      }
      // two tiers: one line a tier; a full line starts a new chunk
      if (line && (tiered || c.lines.length >= cap.maxLines)) return false;
      c.lines.push({ words: [word], chars: len, full: len >= cap.maxCharsPerLine });
      return true;
    };
    if (newChunk || !place(cur!)) {
      cur = { lines: [], count: 0, chars: 0, emph: 0 };
      chunks.push(cur);
      place(cur);
    }
    cur!.count++;
    if (word.emphasis) cur!.emph++;
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

/** A scene's on-screen text over its time (sequence ms), for `withoutSceneEchoes`. */
export interface SceneText {
  startMs: number;
  endMs: number;
  texts: string[];
}

/** Share of a chunk's words a scene must show for the chunk to be an echo (D-99). */
export const ECHO_SHARE = 0.6;

const echoWords = (t: string) =>
  t
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{Nd}]+/u)
    .filter((w) => w !== '');

/**
 * Burned-in chunks without the ones a scene already shows (D-99): while a scene covers at least half
 * of a chunk's time and its text holds ECHO_SHARE of the chunk's words (two words or more, or one word
 * of 4+ letters), the caption would repeat the scene's words at the same time, so the chunk is left
 * out. Captions files (SRT/VTT) are not affected.
 */
export function withoutSceneEchoes(
  chunks: readonly CaptionChunk[],
  scenes: readonly SceneText[],
): CaptionChunk[] {
  if (scenes.length === 0) return [...chunks];
  const sets = scenes.map((s) => ({ ...s, words: new Set(s.texts.flatMap(echoWords)) }));
  return chunks.filter((c) => {
    const words = c.lines.flatMap((l) => l.words.flatMap((w) => echoWords(w.text)));
    if (words.length === 0) return true;
    if (words.length === 1 && [...words[0]!].length < 4) return true;
    const span = Math.max(1, c.endMs - c.startMs);
    return !sets.some((s) => {
      const over = Math.min(c.endMs, s.endMs) - Math.max(c.startMs, s.startMs);
      if (over < span / 2) return false;
      const hit = words.filter((w) => s.words.has(w)).length;
      return hit / words.length >= ECHO_SHARE;
    });
  });
}

/** Every string inside a scene's variables (its on-screen text, nested panels and items too). */
export function sceneStrings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) sceneStrings(x, out, depth + 1);
  else if (v !== null && typeof v === 'object')
    for (const x of Object.values(v as Record<string, unknown>)) sceneStrings(x, out, depth + 1);
  return out;
}
