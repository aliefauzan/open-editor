// Quick clips selection (engine spec "Quick clips", plan D-11, D-15): transcript → sentence units →
// candidate ranges within [minMs, maxMs] → scores (built-in heuristic or a registered scorer) → the
// top `count` ranges that do not overlap. Pure functions; the job (quick-api.ts) reads the files and
// writes the sequences.
import type { Fps } from '../model/fps.ts';
import { frameMs } from '../model/fps.ts';
import type { Transcript, TranscriptWord } from '../model/schema.ts';
import { VoxError } from '../errors.ts';
import type { Detections } from './facetrack.ts';
import type { Highlights } from './highlights.ts';
import type { Shot } from './shots.ts';
import { REACTION_CLASSES, type Sounds } from './sounds.ts';

/** A gap of at least this long between two spoken words ends a sentence unit. */
export const SENTENCE_PAUSE_MS = 700;
/** A clip starts this long before its first word (never inside the previous word). */
export const LEAD_IN_MS = 120;
/** A start this many source frames (or fewer) before a shot cut moves to the cut. */
export const SHOT_SNAP_FRAMES = 2;
/** Each internal pause longer than this costs 0.5 in the heuristic. */
export const LONG_PAUSE_MS = 1500;
/** Short-term loudness window and step over the 100-per-second peaks (energy signal). */
export const ENERGY_WINDOW_MS = 400;
export const ENERGY_STEP_MS = 100;
/** dB floor for silent windows in the energy signal. */
const ENERGY_FLOOR_DB = -60;
/**
 * Weight of the video-highlights signal (D-75; macOS 27 MediaIntelligence) in the heuristic: the
 * same as each of the other four signals. Without highlights the signal is 0 for every candidate,
 * so the pick is exactly the one without it.
 */
export const HIGHLIGHT_WEIGHT = 1;
/**
 * Weight of the audience-reaction signal (D-83; SoundAnalysis laughter, applause and cheering,
 * REACTION_CLASSES): the same as each other signal, added to the sum like HIGHLIGHT_WEIGHT. The
 * signal is absolute, not min-max scaled: reactions are rare, and scaling would give one faint
 * laugh in a talk a full point. Without sound tags, or with no reaction inside any candidate, it is
 * 0 for every candidate and the pick is exactly the one without it.
 */
export const REACTION_WEIGHT = 1;
/**
 * Confidence-weighted reaction time that gives the full signal: 3 s, e.g. two 1.5 s windows of
 * sure applause. One faint laugh window (1.5 s at 0.35) gives 0.175.
 */
export const REACTION_FULL_MS = 3000;
/**
 * A registered scorer (the agent's `fast` model) gets at most max(this, 2 × count) candidates: the
 * best by heuristic score (highlights included). 30 is the agent's SCORE_BATCH, so one request
 * usually covers them (D-75).
 */
export const SCORER_MIN_CANDIDATES = 30;

/** Words ending a sentence: `.`, `?`, `!`, `…` and the CJK/Arabic/Hindi equivalents, before closing quotes. */
const SENTENCE_END = /[.?!…。？！؟।]["'”’)\]]*$/u;
/** The hook signal: a question, or a number (digits or a cardinal word). */
const NUMBER_WORD =
  /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen|half)\b/i;

export interface SentenceUnit {
  startMs: number;
  endMs: number;
  text: string;
  /** Index into the transcript's `words` of the first and last spoken word. */
  first: number;
  last: number;
}

export interface Candidate {
  startMs: number;
  endMs: number;
  text: string;
  /** Text of the first sentence unit (hook signal). */
  firstSentence: string;
  firstUnit: number;
  lastUnit: number;
}

const spoken = (w: TranscriptWord): boolean => w.kind !== 'pause';
const join = (ws: readonly TranscriptWord[]): string =>
  ws
    .map((w) => w.text.trim())
    .filter(Boolean)
    .join(' ');

/** Step 1: sentence units at sentence-ending words or at pauses ≥ 700 ms between spoken words. */
export function sentenceUnits(words: readonly TranscriptWord[]): SentenceUnit[] {
  const idx = words.flatMap((w, i) => (spoken(w) ? [i] : []));
  const units: SentenceUnit[] = [];
  let start = 0;
  for (let k = 0; k < idx.length; k++) {
    const w = words[idx[k]!]!;
    const next = k + 1 < idx.length ? words[idx[k + 1]!]! : undefined;
    const ends =
      next === undefined ||
      SENTENCE_END.test(w.text.trim()) ||
      next.startMs - w.endMs >= SENTENCE_PAUSE_MS;
    if (!ends) continue;
    const ws = idx.slice(start, k + 1).map((i) => words[i]!);
    units.push({
      startMs: ws[0]!.startMs,
      endMs: w.endMs,
      text: join(ws),
      first: idx[start]!,
      last: idx[k]!,
    });
    start = k + 1;
  }
  return units;
}

/**
 * A clip's start for a unit (D-15): 120 ms before its first word, never inside the previous spoken
 * word, never before 0; a start within 2 source frames before a shot cut (and not after the first
 * word) moves to the cut.
 */
export function clipStart(
  words: readonly TranscriptWord[],
  unit: SentenceUnit,
  cutsMs: readonly number[],
  sourceFps: Fps,
): number {
  let prevEnd = 0;
  for (let i = unit.first - 1; i >= 0; i--) {
    if (spoken(words[i]!)) {
      prevEnd = words[i]!.endMs;
      break;
    }
  }
  let start = Math.max(0, prevEnd, unit.startMs - LEAD_IN_MS);
  const snapMs = SHOT_SNAP_FRAMES * frameMs(sourceFps);
  const cut = cutsMs.find((c) => c > start && c - start <= snapMs && c <= unit.startMs);
  if (cut !== undefined) start = cut;
  return Math.round(start);
}

/** Step 2: runs of whole units whose length (lead-in to the last word's end) is within the bounds. */
export function quickCandidates(
  t: Transcript,
  o: { minMs: number; maxMs: number; shots?: readonly Shot[]; sourceFps: Fps },
): Candidate[] {
  const units = sentenceUnits(t.words);
  const cuts = (o.shots ?? []).slice(1).map((s) => s.startMs);
  const out: Candidate[] = [];
  for (let i = 0; i < units.length; i++) {
    const startMs = clipStart(t.words, units[i]!, cuts, o.sourceFps);
    for (let j = i; j < units.length; j++) {
      const endMs = units[j]!.endMs;
      const len = endMs - startMs;
      if (len > o.maxMs) break;
      if (len < o.minMs) continue;
      out.push({
        startMs,
        endMs,
        text: units
          .slice(i, j + 1)
          .map((u) => u.text)
          .join(' '),
        firstSentence: units[i]!.text,
        firstUnit: i,
        lastUnit: j,
      });
    }
  }
  return out;
}

export interface QuickSignals {
  /** Speech ratio minus 0.5 per internal pause over 1.5 s. */
  speech: number;
  /** Variance of short-term loudness, scaled 0..1 over the candidate set. */
  energy: number;
  /** 1 when the first sentence is a question or holds a number. */
  hook: number;
  /** Share of the candidate with a face on screen (facetrack samples). */
  coverage: number;
  /**
   * Video highlights (D-75): mean level plus the share inside highlight ranges, scaled 0..1 over
   * the candidate set; 0 without highlights.
   */
  highlight: number;
  /**
   * Audience reaction (D-83): confidence-weighted laughter/applause/cheering time inside the
   * candidate ÷ REACTION_FULL_MS, at most 1; 0 without sound tags.
   */
  reaction: number;
}

export interface Peaks {
  peaksPerSecond: number;
  peaks: readonly number[];
}

function overlapMs(regions: Transcript['speechRegions'], s: number, e: number): number {
  let sum = 0;
  for (const r of regions) sum += Math.max(0, Math.min(e, r.endMs) - Math.max(s, r.startMs));
  return sum;
}

function longPauses(words: readonly TranscriptWord[], s: number, e: number): number {
  const ws = words.filter((w) => spoken(w) && w.startMs >= s && w.endMs <= e);
  let n = 0;
  for (let i = 1; i < ws.length; i++) if (ws[i]!.startMs - ws[i - 1]!.endMs > LONG_PAUSE_MS) n++;
  return n;
}

/** Variance (dB²) of the short-term loudness of the peaks inside [s, e). */
export function loudnessVariance(p: Peaks, s: number, e: number): number {
  const per = 1000 / p.peaksPerSecond;
  const win = Math.max(1, Math.round(ENERGY_WINDOW_MS / per));
  const step = Math.max(1, Math.round(ENERGY_STEP_MS / per));
  const i0 = Math.max(0, Math.floor(s / per));
  const i1 = Math.min(p.peaks.length, Math.ceil(e / per));
  const db: number[] = [];
  for (let i = i0; i + win <= i1; i += step) {
    let sq = 0;
    for (let k = i; k < i + win; k++) sq += p.peaks[k]! ** 2;
    const rms = Math.sqrt(sq / win);
    db.push(rms > 0 ? Math.max(ENERGY_FLOOR_DB, 20 * Math.log10(rms)) : ENERGY_FLOOR_DB);
  }
  if (db.length < 2) return 0;
  const mean = db.reduce((a, b) => a + b, 0) / db.length;
  return db.reduce((a, b) => a + (b - mean) ** 2, 0) / db.length;
}

function faceCoverage(d: Detections, s: number, e: number): number {
  const inside = d.samples.filter((x) => x.atMs >= s && x.atMs < e);
  if (inside.length === 0) return 0;
  return inside.filter((x) => x.faces.length > 0).length / inside.length;
}

/**
 * Raw highlight signal of [s, e), 0..2: the time-weighted mean of the level steps it overlaps
 * (÷ the video's highest level) plus the share of it inside the framework's highlight ranges.
 */
export function highlightLevel(h: Highlights, s: number, e: number): number {
  const len = e - s;
  if (len <= 0) return 0;
  let level = 0;
  const top = Math.max(0, ...h.levels.map((l) => l.level));
  if (top > 0) {
    let sum = 0;
    let covered = 0;
    for (const l of h.levels) {
      const o = Math.max(0, Math.min(e, l.endMs) - Math.max(s, l.startMs));
      sum += o * l.level;
      covered += o;
    }
    level = covered > 0 ? sum / covered / top : 0;
  }
  let inside = 0;
  for (const r of h.highlights)
    inside += Math.max(0, Math.min(e, r.endMs) - Math.max(s, r.startMs));
  return level + Math.min(1, inside / len);
}

const REACTION = new Set<string>(REACTION_CLASSES);

/**
 * Reaction signal of [s, e), 0..1: for each tagged window, the part of it inside the range times
 * its best reaction-class confidence, summed, ÷ REACTION_FULL_MS.
 */
export function reactionLevel(snd: Sounds, s: number, e: number): number {
  if (e <= s) return 0;
  let sum = 0;
  for (const w of snd.windows) {
    const o = Math.max(0, Math.min(e, w.endMs) - Math.max(s, w.startMs));
    if (o === 0) continue;
    const best = Math.max(
      0,
      ...w.labels.filter((l) => REACTION.has(l.id)).map((l) => l.confidence),
    );
    sum += o * best;
  }
  return Math.min(1, sum / REACTION_FULL_MS);
}

/** `xs` scaled to 0..1 by the set's min and max; all 0 when they are equal. */
function minMax(xs: readonly number[]): number[] {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return xs.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 0));
}

export const hasHook = (sentence: string): boolean =>
  /\?["'”’)\]]*$/u.test(sentence.trim()) || /\d/.test(sentence) || NUMBER_WORD.test(sentence);

/**
 * Step 3, the built-in scorer: speech + energy + hook + coverage (equal weights, D-15) + highlight
 * × HIGHLIGHT_WEIGHT (D-75) + reaction × REACTION_WEIGHT (D-83).
 */
export function heuristicScores(
  cands: readonly Candidate[],
  t: Transcript,
  extra: {
    peaks?: Peaks | undefined;
    detections?: Detections | undefined;
    highlights?: Highlights | undefined;
    sounds?: Sounds | undefined;
  } = {},
): { scores: number[]; signals: QuickSignals[] } {
  const variances = cands.map((c) =>
    extra.peaks ? loudnessVariance(extra.peaks, c.startMs, c.endMs) : 0,
  );
  const lo = Math.min(...variances);
  const hi = Math.max(...variances);
  const h = extra.highlights;
  const levels = minMax(cands.map((c) => (h ? highlightLevel(h, c.startMs, c.endMs) : 0)));
  const signals = cands.map((c, i): QuickSignals => {
    const len = c.endMs - c.startMs;
    return {
      speech:
        overlapMs(t.speechRegions, c.startMs, c.endMs) / len -
        0.5 * longPauses(t.words, c.startMs, c.endMs),
      energy: hi > lo ? (variances[i]! - lo) / (hi - lo) : 0,
      hook: hasHook(c.firstSentence) ? 1 : 0,
      coverage: extra.detections ? faceCoverage(extra.detections, c.startMs, c.endMs) : 0,
      highlight: levels[i]!,
      reaction: extra.sounds ? reactionLevel(extra.sounds, c.startMs, c.endMs) : 0,
    };
  });
  return {
    scores: signals.map(
      (g) =>
        g.speech +
        g.energy +
        g.hook +
        g.coverage +
        HIGHLIGHT_WEIGHT * g.highlight +
        REACTION_WEIGHT * g.reaction,
    ),
    signals,
  };
}

/** Candidate indices, best score first (ties: earlier start, then earlier end). */
function ranked(
  cands: readonly Candidate[],
  scores: readonly number[],
  among: readonly number[] = cands.map((_, i) => i),
): number[] {
  return [...among].sort(
    (a, b) =>
      scores[b]! - scores[a]! ||
      cands[a]!.startMs - cands[b]!.startMs ||
      cands[a]!.endMs - cands[b]!.endMs,
  );
}

/**
 * What a registered scorer gets (D-75): the `cap` best candidates by `scores` (the heuristic), in
 * candidate order. All of them when there are no more than `cap`.
 */
export function scorerShortlist(
  cands: readonly Candidate[],
  scores: readonly number[],
  cap: number,
): number[] {
  if (cands.length <= cap) return cands.map((_, i) => i);
  return ranked(cands, scores)
    .slice(0, cap)
    .sort((a, b) => a - b);
}

/**
 * Step 4: best score first (ties: earlier start), skipping overlaps, up to `count`. `among` limits
 * the pick to those indices; `taken` are picks made before (kept, and nothing may overlap them).
 */
export function pickClips(
  cands: readonly Candidate[],
  scores: readonly number[],
  count: number,
  o: { among?: readonly number[]; taken?: readonly number[] } = {},
): number[] {
  const order = ranked(cands, scores, o.among);
  const picked: number[] = [...(o.taken ?? [])];
  for (const i of order) {
    if (picked.length >= count) break;
    const c = cands[i]!;
    if (picked.some((k) => c.startMs < cands[k]!.endMs && cands[k]!.startMs < c.endMs)) continue;
    picked.push(i);
  }
  return picked;
}

/** What a registered scorer gets (spec 3: the agent's LLM scorer). */
export interface ScorerInput {
  mediaId: string;
  prompt?: string;
  /** The agent run that started the job (absent for a job outside a run). */
  runId?: string;
  candidates: { index: number; startMs: number; endMs: number; text: string }[];
}

/** Returns one score per candidate, in order; higher is better. */
export type QuickClipScorer = (
  input: ScorerInput,
  ctx: { signal: AbortSignal },
) => readonly number[] | Promise<readonly number[]>;

export interface QuickClipScorers {
  registerScorer(id: string, fn: QuickClipScorer): void;
  /** Registered scorer ids, in registration order. */
  scorers(): string[];
}

export const HEURISTIC = 'heuristic';
const SCORER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function createQuickClipScorers(): QuickClipScorers & {
  /** `id` omitted → the most recently registered scorer, else undefined (the heuristic). */
  resolve(id?: string): { id: string; fn: QuickClipScorer } | undefined;
} {
  const fns = new Map<string, QuickClipScorer>();
  return {
    registerScorer(id, fn) {
      if (!SCORER_ID.test(id) || id === HEURISTIC) {
        throw new VoxError(
          'VALIDATION',
          `Invalid scorer id ${JSON.stringify(id)}`,
          'Use lowercase letters, digits, ".", "_" or "-".',
        );
      }
      if (fns.has(id))
        throw new VoxError(
          'VALIDATION',
          `A scorer named ${id} is already registered`,
          'Register each scorer once, under its own id.',
        );
      fns.set(id, fn);
    },
    scorers: () => [...fns.keys()],
    resolve(id) {
      if (id === HEURISTIC) return undefined;
      if (id === undefined) {
        const last = [...fns.keys()].at(-1);
        return last === undefined ? undefined : { id: last, fn: fns.get(last)! };
      }
      const fn = fns.get(id);
      if (!fn) {
        throw new VoxError(
          'NOT_FOUND',
          `No quick clips scorer named ${id}`,
          `Use "${HEURISTIC}" or one of: ${[...fns.keys()].join(', ') || '(none registered)'}.`,
        );
      }
      return { id, fn };
    },
  };
}
