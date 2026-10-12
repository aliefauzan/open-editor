// Plan-mode speech sync (D-92). A weak editor model picks scene beat times that do not match when
// the words on the scene are spoken (live run 2026-10-12: a label 9 s early). Before a ClipPlan is
// applied, each scene's display text is matched to the sequence's transcript words (sequence time);
// a scene with a confident match that starts more than SPEECH_SYNC_TOLERANCE_MS away from it is moved
// to start SPEECH_LEAD_MS before the first matched word. Deterministic: no model call.
import type { TemplateInfo, TemplateLookup } from '@vox/engine';

/** A moved scene starts this long before its first matched word. */
export const SPEECH_LEAD_MS = 200;
/** A scene closer than this to its words (after the lead) is left where it is. */
export const SPEECH_SYNC_TOLERANCE_MS = 400;
/** Share of the text's word weight that must be matched, in order, for a confident match. */
export const SPEECH_MATCH_MIN_RATIO = 0.6;
/**
 * Rare-word match (D-94): a short text (a label, at most RARE_WORD_MAX_TEXT_WORDS words) that
 * paraphrases the speech matches on one of its words of RARE_WORD_MIN_LETTERS+ letters (not a common
 * word) that holds at least RARE_WORD_MIN_SHARE of the text's letters, when that word is spoken
 * exactly once in the clip, or exactly once within RARE_WORD_NEAR_MS of the planned time. Tried only
 * when no text of the scene matches a run. "Kesempatan Baru" matches "kesempatan" (10 of 14 letters);
 * "of jobs change" does not match "change" (6 letters).
 */
export const RARE_WORD_MIN_LETTERS = 7;
export const RARE_WORD_MIN_SHARE = 0.5;
export const RARE_WORD_MAX_TEXT_WORDS = 6;
export const RARE_WORD_NEAR_MS = 8000;

/** Common words of 7+ letters that say nothing about where a scene belongs (Indonesian, English). */
const COMMON_WORDS = new Set([
  'bakalan',
  'sebenarnya',
  'sekarang',
  'seperti',
  'setelah',
  'sebelum',
  'sebelumnya',
  'akhirnya',
  'because',
  'something',
  'nothing',
  'another',
  'through',
  'actually',
]);

/** A spoken word in sequence time. */
export interface SpokenWord {
  text: string;
  startMs: number;
}

/**
 * Spelling variants of informal speech written two ways (transcript vs model text), mapped to one
 * form. Indonesian first (the owner's demo language); the generic edit-distance check covers more.
 */
const VARIANTS: Readonly<Record<string, string>> = {
  nggak: 'gak',
  ngga: 'gak',
  nggk: 'gak',
  enggak: 'gak',
  engga: 'gak',
  ga: 'gak',
  gk: 'gak',
  tau: 'tahu',
  aja: 'saja',
  udah: 'sudah',
  udh: 'sudah',
  gua: 'gue',
  gw: 'gue',
  kalo: 'kalau',
  emang: 'memang',
  yg: 'yang',
  dgn: 'dengan',
};

/** Lower-case word tokens without punctuation or accents; hyphens split ("tiba-tiba" = "tiba -tiba"). */
export function speechTokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '')
    .map((w) => VARIANTS[w] ?? w);
}

/** Edit distance of at most one (one insert, delete or substitution). */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Same word: equal after normalising, or one edit apart when both are long (spelling variants). */
function sameWord(a: string, b: string): boolean {
  return a === b || (a.length >= 5 && b.length >= 5 && withinOneEdit(a, b));
}

/** Short words ("di", "80") count half: they match by chance more often. */
const weightOf = (w: string) => (w.length >= 3 ? 1 : 0.5);

export interface SpeechMatch {
  /** Sequence ms of the first matched word. */
  startMs: number;
  /** Matched words, in order. */
  matched: number;
  /** Matched share of the text's word weight (0-1). */
  ratio: number;
  /** Set for a rare-word match: the one word that placed the text. */
  word?: string;
}

interface Token {
  w: string;
  startMs: number;
}

/** Transcript words split into tokens (a word with a hyphen gives two tokens at its start). */
function tokensOfWords(words: readonly SpokenWord[]): Token[] {
  return words.flatMap((x) => speechTokens(x.text).map((w) => ({ w, startMs: x.startMs })));
}

/**
 * The best in-order match of `text` in the spoken words: the run of words that holds the most of
 * the text's words (weighted), starting at a matched word and at most twice the text's length plus
 * three words long. Ties go to the run nearest `nearMs`. No confident run (under
 * SPEECH_MATCH_MIN_RATIO of the text, or one matched word of a longer text, or one short word): the
 * rare-word match (D-94), else undefined.
 */
export function matchSpeech(
  text: string,
  spoken: readonly SpokenWord[],
  nearMs: number,
): SpeechMatch | undefined {
  const toks = tokensOfWords(spoken);
  return matchTokens(text, toks, nearMs) ?? matchRareWord(text, toks, nearMs);
}

/**
 * A short text placed by one rare word (D-94): its words of RARE_WORD_MIN_LETTERS+ letters that are
 * not common words and hold RARE_WORD_MIN_SHARE of the text's letters, each spoken exactly once in the clip, or else exactly once within
 * RARE_WORD_NEAR_MS of `nearMs`. The longest such word wins (ties: nearest `nearMs`). Undefined for a
 * text over RARE_WORD_MAX_TEXT_WORDS words or when no word qualifies.
 */
function matchRareWord(
  text: string,
  toks: readonly Token[],
  nearMs: number,
): SpeechMatch | undefined {
  const want = speechTokens(text);
  if (want.length === 0 || want.length > RARE_WORD_MAX_TEXT_WORDS) return undefined;
  const total = want.map(weightOf).reduce((a, b) => a + b, 0);
  const letters = want.reduce((n, w) => n + w.length, 0);
  let best: { w: string; startMs: number } | undefined;
  for (const w of new Set(want)) {
    if (w.length < RARE_WORD_MIN_LETTERS || COMMON_WORDS.has(w)) continue;
    if (w.length < letters * RARE_WORD_MIN_SHARE) continue;
    const said = toks.filter((t) => sameWord(w, t.w));
    const near = said.filter((t) => Math.abs(t.startMs - nearMs) <= RARE_WORD_NEAR_MS);
    const hit = said.length === 1 ? said[0] : near.length === 1 ? near[0] : undefined;
    if (!hit) continue;
    const better =
      !best ||
      w.length > best.w.length ||
      (w.length === best.w.length &&
        Math.abs(hit.startMs - nearMs) < Math.abs(best.startMs - nearMs));
    if (better) best = { w, startMs: hit.startMs };
  }
  if (!best) return undefined;
  return { startMs: best.startMs, matched: 1, ratio: weightOf(best.w) / total, word: best.w };
}

function matchTokens(
  text: string,
  toks: readonly Token[],
  nearMs: number,
): SpeechMatch | undefined {
  const want = speechTokens(text);
  if (want.length === 0) return undefined;
  const weights = want.map(weightOf);
  const total = weights.reduce((a, b) => a + b, 0);
  const span = want.length * 2 + 3;
  let best: (SpeechMatch & { score: number }) | undefined;
  for (let i = 0; i < toks.length; i++) {
    const first = toks[i]!;
    for (let j = 0; j < want.length; j++) {
      if (!sameWord(want[j]!, first.w)) continue;
      // weighted in-order matches of want[j+1..] in toks[i+1 .. i+span)
      const rest = want.slice(j + 1);
      const window = toks.slice(i + 1, i + span);
      const dp: { s: number; n: number }[][] = Array.from({ length: rest.length + 1 }, () =>
        Array.from({ length: window.length + 1 }, () => ({ s: 0, n: 0 })),
      );
      for (let a = 1; a <= rest.length; a++) {
        for (let b = 1; b <= window.length; b++) {
          const up = dp[a - 1]![b]!;
          const left = dp[a]![b - 1]!;
          let cell = up.s >= left.s ? up : left;
          if (sameWord(rest[a - 1]!, window[b - 1]!.w)) {
            const diag = dp[a - 1]![b - 1]!;
            const s = diag.s + weights[j + a]!;
            if (s > cell.s) cell = { s, n: diag.n + 1 };
          }
          dp[a]![b] = cell;
        }
      }
      const tail = dp[rest.length]![window.length]!;
      const score = weights[j]! + tail.s;
      const matched = 1 + tail.n;
      const better =
        !best ||
        score > best.score ||
        (score === best.score &&
          Math.abs(first.startMs - nearMs) < Math.abs(best.startMs - nearMs));
      if (better) best = { startMs: first.startMs, matched, ratio: score / total, score };
    }
  }
  if (!best || best.ratio < SPEECH_MATCH_MIN_RATIO) return undefined;
  if (best.matched < 2 && (want.length > 1 || (want[0]?.length ?? 0) < 4)) return undefined;
  return { startMs: best.startMs, matched: best.matched, ratio: best.ratio };
}

interface StringSchema {
  type?: unknown;
  enum?: unknown;
  pattern?: unknown;
  format?: unknown;
  properties?: Record<string, StringSchema | undefined>;
  items?: StringSchema;
}

/** Text keys a weak model writes on array items without the schema declaring them (D-90 run 3). */
const ITEM_TEXT_KEYS = ['label', 'title', 'text', 'caption'];

const isFreeText = (s: StringSchema | undefined) =>
  s?.type === 'string' && s.enum === undefined && s.pattern === undefined && s.format === undefined;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Free-text strings of an object, in schema order: its own strings first, then those of its object
 * and array-of-object variables (collage `items/*`, a `clipping`), one level deep. Keys in `skip`
 * (picture slots) are left out; array items also give their undeclared `label`-like strings (D-94).
 */
function objectTexts(
  props: Record<string, StringSchema | undefined>,
  value: Record<string, unknown>,
  skip: (key: string) => boolean,
  nested: boolean,
  extraKeys: readonly string[] = [],
): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim() !== '') out.push(v.trim());
  };
  for (const [key, schema] of Object.entries(props)) {
    if (isFreeText(schema) && !skip(key)) push(value[key]);
  }
  for (const key of extraKeys) if (props[key] === undefined) push(value[key]);
  if (!nested) return out;
  for (const [key, schema] of Object.entries(props)) {
    const v = value[key];
    const inner = (s: StringSchema | undefined) => s?.properties ?? {};
    if (isObject(v) && schema?.properties)
      out.push(...objectTexts(inner(schema), v, (k) => skip(`${key}/${k}`), false));
    if (Array.isArray(v) && schema?.items && !skip(`${key}/*`))
      for (const el of v)
        if (isObject(el))
          out.push(
            ...objectTexts(
              inner(schema.items),
              el,
              (k) => skip(`${key}/*/${k}`),
              false,
              ITEM_TEXT_KEYS,
            ),
          );
  }
  return out;
}

/**
 * Display text of a scene in reading order: the template's free-text string variables (schema
 * order; picture slots, enums and patterned codes such as a language left out), then the texts inside
 * its objects and arrays (collage item labels, a clipping; D-94), then the same for each panel of a
 * `template` slot (stack `panels/*`), in panel order.
 */
export function sceneTexts(
  t: TemplateInfo,
  variables: Record<string, unknown>,
  templates: TemplateLookup,
  depth = 0,
): string[] {
  const props = (t.variables['properties'] ?? {}) as Record<string, StringSchema | undefined>;
  const out = objectTexts(props, variables, (k) => t.slots[k] !== undefined, true);
  if (depth > 0) return out;
  for (const [path, kind] of Object.entries(t.slots)) {
    const m = /^([A-Za-z0-9_]+)\/\*$/.exec(path);
    if (!m || kind !== 'template') continue;
    const list = variables[m[1]!];
    if (!Array.isArray(list)) continue;
    for (const el of list) {
      const panel = el as { template?: unknown; variables?: unknown } | null;
      const inner = typeof panel?.template === 'string' ? templates.get(panel.template) : undefined;
      if (!inner || inner.kind !== 'scene') continue;
      const vars =
        typeof panel?.variables === 'object' && panel.variables !== null
          ? (panel.variables as Record<string, unknown>)
          : {};
      out.push(...sceneTexts(inner, vars, templates, depth + 1));
    }
  }
  return out;
}

/** A scene beat as the sync sees it: planned start, duration after template clamps, texts. */
export interface SyncScene {
  startMs: number;
  durationMs: number;
  minMs: number;
  texts: readonly string[];
}

export interface SyncedScene {
  startMs: number;
  durationMs: number;
  /** Set when the scene was moved to its words: the text it matched. */
  matchedText?: string;
  /** Set when one rare word of the text placed it (D-94). */
  matchedWord?: string;
}

/**
 * New times for the scenes of one sequence track: each scene with a confident match for its first
 * matching text (reading order) that starts more than SPEECH_SYNC_TOLERANCE_MS from the lead point
 * is moved there, keeping its duration. Where a moved scene would run into the next scene (in start
 * order) the earlier one yields: it is shortened, and when that goes under its minimum it starts
 * earlier instead (not before the scene before it). A moved scene past `endMs` is shortened or
 * starts earlier the same way. Scenes that cannot be fitted are left to the caller's own repairs.
 * The result is in input order.
 */
export function syncScenesToSpeech(
  scenes: readonly SyncScene[],
  spoken: readonly SpokenWord[],
  endMs: number,
): SyncedScene[] {
  const toks = tokensOfWords(spoken);
  const out: (SyncedScene & { moved: boolean })[] = scenes.map((s) => {
    const keep = { startMs: s.startMs, durationMs: s.durationMs, moved: false };
    if (toks.length === 0) return keep;
    const near = s.startMs + SPEECH_LEAD_MS;
    // a run of words in any text first; only then one rare word of a short text (D-94)
    for (const match of [matchTokens, matchRareWord])
      for (const text of s.texts) {
        const m = match(text, toks, near);
        if (!m) continue;
        const target = Math.max(0, m.startMs - SPEECH_LEAD_MS);
        if (Math.abs(target - s.startMs) <= SPEECH_SYNC_TOLERANCE_MS) return keep;
        return {
          startMs: target,
          durationMs: s.durationMs,
          matchedText: text,
          ...(m.word !== undefined && { matchedWord: m.word }),
          moved: true,
        };
      }
    return keep;
  });
  if (!out.some((x) => x.moved)) return out.map(({ moved: _, ...x }) => x);
  const order = out.map((_, i) => i).sort((a, b) => out[a]!.startMs - out[b]!.startMs || a - b);
  let prevEnd = 0;
  for (const [k, i] of order.entries()) {
    const cur = out[i]!;
    const min = scenes[i]!.minMs;
    const next = k + 1 < order.length ? out[order[k + 1]!]! : undefined;
    // only a pair with a moved scene is resolved here; the caller pushes overlaps it planned itself
    const limit =
      next && (cur.moved || next.moved) && cur.startMs + cur.durationMs > next.startMs
        ? next.startMs
        : cur.moved && cur.startMs + cur.durationMs > endMs
          ? endMs
          : undefined;
    if (limit !== undefined) {
      const cap = Math.min(limit, endMs);
      if (cap - cur.startMs >= min) cur.durationMs = cap - cur.startMs;
      else if (cap - min >= prevEnd) {
        cur.startMs = cap - min;
        cur.durationMs = min;
      }
    }
    prevEnd = Math.max(prevEnd, cur.startMs + cur.durationMs);
  }
  return out.map(({ moved: _, ...x }) => x);
}
