// Filler lists per language and word kinds (engine spec "Transcripts", plan D-15).
// Phase 04 calls computeWordKinds after Whisper; kinds are never taken from Whisper.
import type { TranscriptWord } from '../model/schema.ts';

/** Single-word hesitation sounds only: words that are also real words (e.g. "like") are left out. */
export const FILLERS: Readonly<Record<string, readonly string[]>> = {
  en: ['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'hmm', 'hm', 'mm', 'mhm'],
  es: ['eh', 'em', 'emm', 'este', 'mmm'],
  fr: ['euh', 'heu', 'bah', 'hum'],
  de: ['äh', 'ähm', 'öh', 'hm', 'hmm'],
  it: ['ehm', 'eh', 'uhm', 'mmm'],
  nl: ['eh', 'ehm', 'uh', 'uhm'],
  pt: ['hum', 'ahn'],
};

export const DEFAULT_MIN_PAUSE_MS = 350;

/** Lowercase and strip leading/trailing punctuation. */
export function normaliseToken(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '')
    .trim();
}

function baseLanguage(language: string): string {
  return language.toLowerCase().split(/[-_]/)[0] ?? '';
}

export function isFiller(text: string, language: string): boolean {
  const list = FILLERS[baseLanguage(language)];
  return list !== undefined && list.includes(normaliseToken(text));
}

export interface RawWord {
  text: string;
  startMs: number;
  endMs: number;
  kind?: TranscriptWord['kind'];
}

export interface WordKindOptions {
  language: string;
  minPauseMs?: number;
}

/**
 * Mark `filler`, `repeat` (a 1–3-word n-gram repeated back to back: the earlier copy) and `word`,
 * and insert `pause` pseudo-words (empty text) for gaps of at least `minPauseMs` between words.
 * Incoming pause pseudo-words are dropped and recomputed.
 */
export function computeWordKinds(
  input: readonly RawWord[],
  opts: WordKindOptions,
): TranscriptWord[] {
  const minPause = opts.minPauseMs ?? DEFAULT_MIN_PAUSE_MS;
  const words = input.filter((w) => !(w.kind === 'pause' || w.text === ''));
  const tokens = words.map((w) => normaliseToken(w.text));
  const kinds: TranscriptWord['kind'][] = words.map(() => 'word');

  const same = (a: number, b: number, n: number): boolean => {
    for (let k = 0; k < n; k++) {
      const x = tokens[a + k];
      if (!x || x !== tokens[b + k]) return false;
    }
    return true;
  };
  let i = 0;
  while (i < words.length) {
    let matched = 0;
    for (let n = 3; n >= 1; n--) {
      if (i + 2 * n <= words.length && same(i, i + n, n)) {
        matched = n;
        break;
      }
    }
    if (matched > 0) {
      for (let k = 0; k < matched; k++) kinds[i + k] = 'repeat';
      i += matched;
    } else {
      i += 1;
    }
  }
  words.forEach((w, k) => {
    if (isFiller(w.text, opts.language)) kinds[k] = 'filler';
  });

  const out: TranscriptWord[] = [];
  words.forEach((w, k) => {
    const prev = words[k - 1];
    if (prev && w.startMs - prev.endMs >= minPause) {
      out.push({ text: '', startMs: prev.endMs, endMs: w.startMs, kind: 'pause' });
    }
    out.push({ text: w.text, startMs: w.startMs, endMs: w.endMs, kind: kinds[k] ?? 'word' });
  });
  return out;
}
