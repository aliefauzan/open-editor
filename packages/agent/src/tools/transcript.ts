// get_transcript and search_transcript (agent spec "Read tools", "Time frames"; plan D-15).
// Words carry `srcMs` (source time), their `kind` and, with a sequence, the paired `seqMs` (`null`
// when that source time is not placed). One call returns at most about 4k tokens and a cursor.
import {
  TranscriptSchema,
  mapWordsToTimeline,
  projectDirFor,
  resolveProjectPath,
  type MediaItem,
  type Project,
  type Transcript,
} from '@vox/engine';
import { readFile } from 'node:fs/promises';
import { VoxError } from '../errors.ts';
import { estimateTokens } from '../providers/tool-cost.ts';
import type { AgentEngine } from './types.ts';

/** Agent spec: max 4k tokens per call (estimated at 3 UTF-16 units per token, D-38). */
export const TRANSCRIPT_PAGE_TOKENS = 4_000;

export interface TranscriptWordOut {
  key: string;
  text: string;
  kind: string;
  srcMs: number;
  srcEndMs: number;
  seqMs?: number | null;
  seqEndMs?: number | null;
}

export interface TranscriptPage {
  mediaId: string;
  language: string;
  words: TranscriptWordOut[];
  /** Pass as `cursor` for the next page; null at the end of the range. */
  nextCursor: number | null;
  totalWords: number;
}

export async function loadTranscript(
  engine: Pick<AgentEngine, 'projectsDir'>,
  projectId: string,
  media: MediaItem,
): Promise<Transcript> {
  if (media.transcriptPath === undefined) {
    throw new VoxError(
      'NOT_FOUND',
      `media ${media.id} has no transcript`,
      'Run the transcribe tool on it first.',
      { details: { mediaId: media.id } },
    );
  }
  const dir = projectDirFor(engine.projectsDir, projectId);
  const path = await resolveProjectPath(dir, media.transcriptPath);
  const parsed = TranscriptSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
  if (!parsed.success) {
    throw new VoxError(
      'VALIDATION',
      `the transcript of ${media.id} is not valid`,
      'Transcribe the media again.',
    );
  }
  return parsed.data;
}

function findMedia(p: Project, mediaId: string): MediaItem {
  const m = p.media.find((x) => x.id === mediaId);
  if (!m)
    throw new VoxError(
      'NOT_FOUND',
      `no media ${mediaId}`,
      'Use a media id from get_project_summary.',
    );
  return m;
}

export interface TranscriptQuery {
  mediaId: string;
  fromSrcMs?: number | undefined;
  toSrcMs?: number | undefined;
  sequenceId?: string | undefined;
  cursor?: number | undefined;
}

/** One page of words; `budgetTokens` defaults to the 4k cap. */
export async function transcriptPage(
  engine: Pick<AgentEngine, 'projectsDir' | 'getProject'>,
  projectId: string,
  q: TranscriptQuery,
  budgetTokens = TRANSCRIPT_PAGE_TOKENS,
): Promise<TranscriptPage> {
  const p = await engine.getProject(projectId);
  const media = findMedia(p, q.mediaId);
  const t = await loadTranscript(engine, projectId, media);
  const rev = media.transcriptRev ?? '0';
  let seqOf: Map<string, { startMs: number; endMs: number }> | undefined;
  if (q.sequenceId !== undefined) {
    const s = p.sequences.find((x) => x.id === q.sequenceId);
    if (!s)
      throw new VoxError(
        'NOT_FOUND',
        `no sequence ${q.sequenceId}`,
        'Use a sequence id from get_project_summary.',
      );
    seqOf = new Map();
    const tracks = [...s.audioTracks, ...s.videoTracks].map((x) => x.id);
    for (const w of mapWordsToTimeline(p, s, (m) => (m.id === media.id ? t : undefined), tracks)) {
      if (!seqOf.has(w.key)) seqOf.set(w.key, { startMs: w.startMs, endMs: w.endMs });
    }
  }
  const from = q.fromSrcMs ?? 0;
  const to = q.toSrcMs ?? Number.POSITIVE_INFINITY;
  const words: TranscriptWordOut[] = [];
  let used =
    estimateTokens('{"mediaId":"","language":"","words":[],"nextCursor":null,"totalWords":0}') + 20;
  let next: number | null = null;
  for (let i = q.cursor ?? 0; i < t.words.length; i++) {
    const w = t.words[i]!;
    if (w.endMs <= from && w.startMs < from) continue;
    if (w.startMs >= to) break;
    const key = `${media.id}:${rev}:${String(i)}`;
    const out: TranscriptWordOut = {
      key,
      text: w.text,
      kind: w.kind,
      srcMs: w.startMs,
      srcEndMs: w.endMs,
    };
    if (seqOf) {
      const s = seqOf.get(key);
      out.seqMs = s?.startMs ?? null;
      out.seqEndMs = s?.endMs ?? null;
    }
    const cost = estimateTokens(JSON.stringify(out)) + 1;
    if (used + cost > budgetTokens && words.length > 0) {
      next = i;
      break;
    }
    used += cost;
    words.push(out);
  }
  return {
    mediaId: media.id,
    language: t.language,
    words,
    nextCursor: next,
    totalWords: t.words.length,
  };
}

/** A transcript read scoped to a clip, a sequence or a source range (D-81). */
export interface TranscriptLinesQuery {
  mediaId?: string | undefined;
  fromSrcMs?: number | undefined;
  toSrcMs?: number | undefined;
  sequenceId?: string | undefined;
  /** A media clip: its media, the source span it plays and its sequence. */
  clipId?: string | undefined;
  cursor?: number | undefined;
}

/**
 * The compact page (D-81): one line per sentence or pause-bounded phrase, `[startMs-endMs] text`.
 * Times are sequence ms when a sequence is in scope (words not placed there are left out and
 * counted), else source ms.
 */
export interface TranscriptLines {
  mediaId: string;
  language: string;
  times: 'seqMs' | 'srcMs';
  /** The source span read (absent: the whole transcript). */
  fromSrcMs?: number;
  toSrcMs?: number;
  lines: string;
  unplacedWords?: number;
  nextCursor: number | null;
  totalWords: number;
}

/** What a page covered, for the read label: first/last source time and word count. */
export interface TranscriptLinesInfo {
  page: TranscriptLines;
  words: number;
  firstSrcMs: number | undefined;
  lastSrcEndMs: number | undefined;
}

/** A line ends at a pause, a sentence end, a cut (sequence mode) or this many words. */
const MAX_LINE_WORDS = 40;

export interface TranscriptScope {
  media: MediaItem;
  sequenceId?: string;
  from?: number;
  to?: number;
}

/** The media, sequence and source span a scoped read covers (clipId, sequenceId, range). */
export function resolveTranscriptScope(p: Project, q: TranscriptLinesQuery): TranscriptScope {
  let sequenceId = q.sequenceId;
  let mediaId = q.mediaId;
  let from: number | undefined;
  let to: number | undefined;
  if (q.clipId !== undefined) {
    let found:
      | { seq: string; item: Project['sequences'][number]['videoTracks'][number]['items'][number] }
      | undefined;
    for (const s of p.sequences) {
      if (sequenceId !== undefined && s.id !== sequenceId) continue;
      for (const t of [...s.videoTracks, ...s.audioTracks]) {
        const it = t.items.find((x) => x.id === q.clipId);
        if (it) found ??= { seq: s.id, item: it };
      }
    }
    if (!found)
      throw new VoxError(
        'NOT_FOUND',
        `no clip ${q.clipId}`,
        'Use an item id from get_sequence (a V1 or A1 media clip).',
      );
    const it = found.item;
    if (it.type !== 'media')
      throw new VoxError(
        'VALIDATION',
        `clip ${q.clipId} is a scene; it has no transcript`,
        'Pass the id of a media clip (V1 or A1).',
      );
    if (mediaId !== undefined && mediaId !== it.mediaId)
      throw new VoxError(
        'VALIDATION',
        `clip ${q.clipId} plays media ${it.mediaId}, not ${mediaId}`,
        'Leave mediaId out when you pass clipId.',
      );
    mediaId = it.mediaId;
    sequenceId = found.seq;
    from = it.inMs;
    to = it.inMs + Math.round(it.durationMs * (it.speed ?? 1));
  } else if (sequenceId !== undefined) {
    const s = p.sequences.find((x) => x.id === sequenceId);
    if (!s)
      throw new VoxError(
        'NOT_FOUND',
        `no sequence ${sequenceId}`,
        'Use a sequence id from get_project_summary.',
      );
    // the sequence's media clips (all of one media item) give the default media and span
    const clips = [...s.videoTracks, ...s.audioTracks]
      .flatMap((t) => t.items)
      .filter((x) => x.type === 'media')
      .filter((x) => mediaId === undefined || x.mediaId === mediaId);
    mediaId ??= s.sourceRange?.mediaId ?? clips[0]?.mediaId;
    const own = clips.filter((x) => x.mediaId === mediaId);
    if (own.length > 0) {
      from = Math.min(...own.map((x) => x.inMs));
      to = Math.max(...own.map((x) => x.inMs + Math.round(x.durationMs * (x.speed ?? 1))));
    }
  }
  if (mediaId === undefined)
    throw new VoxError(
      'VALIDATION',
      'get_transcript needs a mediaId, a clipId or a sequence with a media clip',
      'Pass mediaId (from get_project_summary) or clipId (from get_sequence).',
    );
  // an explicit range narrows the scope
  if (q.fromSrcMs !== undefined) from = Math.max(from ?? 0, q.fromSrcMs);
  if (q.toSrcMs !== undefined) to = Math.min(to ?? Number.POSITIVE_INFINITY, q.toSrcMs);
  return {
    media: findMedia(p, mediaId),
    ...(sequenceId !== undefined && { sequenceId }),
    ...(from !== undefined && { from }),
    ...(to !== undefined && { to }),
  };
}

/** One compact page of transcript lines; `budgetTokens` defaults to the 4k cap. */
export async function transcriptLines(
  engine: Pick<AgentEngine, 'projectsDir' | 'getProject'>,
  projectId: string,
  q: TranscriptLinesQuery,
  budgetTokens = TRANSCRIPT_PAGE_TOKENS,
): Promise<TranscriptLinesInfo> {
  const p = await engine.getProject(projectId);
  const scope = resolveTranscriptScope(p, q);
  const { media } = scope;
  const t = await loadTranscript(engine, projectId, media);
  const rev = media.transcriptRev ?? '0';
  let seqOf: Map<string, { startMs: number; endMs: number; itemId: string }> | undefined;
  if (scope.sequenceId !== undefined) {
    const s = p.sequences.find((x) => x.id === scope.sequenceId)!;
    seqOf = new Map();
    const tracks = [...s.audioTracks, ...s.videoTracks].map((x) => x.id);
    for (const w of mapWordsToTimeline(p, s, (m) => (m.id === media.id ? t : undefined), tracks)) {
      if (!seqOf.has(w.key))
        seqOf.set(w.key, { startMs: w.startMs, endMs: w.endMs, itemId: w.itemId });
    }
  }
  const from = scope.from ?? 0;
  const to = scope.to ?? Number.POSITIVE_INFINITY;
  const lines: string[] = [];
  let used =
    estimateTokens(
      '{"mediaId":"","language":"","times":"seqMs","fromSrcMs":0,"toSrcMs":0,"lines":"","unplacedWords":0,"nextCursor":null,"totalWords":0}',
    ) + 20;
  let next: number | null = null;
  let unplaced = 0;
  let count = 0;
  let firstSrc: number | undefined;
  let lastSrc: number | undefined;
  interface Line {
    first: number;
    text: string[];
    start: number;
    end: number;
    srcStart: number;
    srcEnd: number;
  }
  let cur: Line | null = null;
  /** The clip the line's last word plays in (sequence mode). */
  let prevItem: string | undefined;
  /** Adds the open line; false when it does not fit (it then starts the next page). */
  const flush = (): boolean => {
    const c = cur;
    if (!c) return true;
    const line = `[${String(c.start)}-${String(c.end)}] ${c.text.join(' ')}`;
    const cost = estimateTokens(line) + 1;
    if (used + cost > budgetTokens && lines.length > 0) {
      next = c.first;
      return false;
    }
    used += cost;
    lines.push(line);
    count += c.text.length;
    firstSrc ??= c.srcStart;
    lastSrc = c.srcEnd;
    cur = null;
    prevItem = undefined;
    return true;
  };
  let stopped = false;
  for (let i = q.cursor ?? 0; i < t.words.length; i++) {
    const w = t.words[i]!;
    if (w.endMs <= from && w.startMs < from) continue;
    if (w.startMs >= to) break;
    let start = w.startMs;
    let end = w.endMs;
    let cut = w.kind === 'pause';
    let placed = true;
    let clipOf: string | undefined;
    if (seqOf && !cut) {
      const s = seqOf.get(`${media.id}:${rev}:${String(i)}`);
      if (s) {
        // a cut (the next word plays in another clip) ends the line
        if (prevItem !== undefined && s.itemId !== prevItem) cut = true;
        clipOf = s.itemId;
        start = s.startMs;
        end = s.endMs;
      } else {
        cut = true;
        placed = false;
      }
    }
    if (cut && !flush()) {
      stopped = true;
      break;
    }
    if (w.kind === 'pause') continue;
    if (!placed) {
      unplaced++;
      continue;
    }
    cur ??= { first: i, text: [], start, end, srcStart: w.startMs, srcEnd: w.endMs };
    cur.text.push(w.text);
    cur.end = end;
    cur.srcEnd = w.endMs;
    prevItem = clipOf;
    if ((/[.!?]$/.test(w.text) || cur.text.length >= MAX_LINE_WORDS) && !flush()) {
      stopped = true;
      break;
    }
  }
  if (!stopped) flush();
  const page: TranscriptLines = {
    mediaId: media.id,
    language: t.language,
    times: seqOf ? 'seqMs' : 'srcMs',
    ...(scope.from !== undefined && { fromSrcMs: scope.from }),
    ...(scope.to !== undefined && Number.isFinite(scope.to) && { toSrcMs: scope.to }),
    lines: lines.join('\n'),
    ...(unplaced > 0 && { unplacedWords: unplaced }),
    nextCursor: next,
    totalWords: t.words.length,
  };
  return { page, words: count, firstSrcMs: firstSrc, lastSrcEndMs: lastSrc };
}

export interface TranscriptHit {
  mediaId: string;
  srcMs: number;
  srcEndMs: number;
  text: string;
  score: number;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim();

function editDistanceAtMost1(a: string, b: string): boolean {
  if (a === b) return true;
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

/** Segments split at pauses and sentence ends, scored by keyword and fuzzy (1 edit) word matches. */
export async function searchTranscripts(
  engine: Pick<AgentEngine, 'projectsDir' | 'getProject'>,
  projectId: string,
  query: string,
  mediaIds?: readonly string[],
  limit = 10,
): Promise<TranscriptHit[]> {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const p = await engine.getProject(projectId);
  const hits: TranscriptHit[] = [];
  for (const m of p.media) {
    if (mediaIds && !mediaIds.includes(m.id)) continue;
    if (m.transcriptPath === undefined) continue;
    const t = await loadTranscript(engine, projectId, m);
    let seg: { text: string[]; start: number; end: number } | null = null;
    const flush = () => {
      if (!seg || seg.text.length === 0) return;
      const words = seg.text.map(norm);
      let score = 0;
      for (const term of terms) {
        if (words.includes(term)) score += 2;
        else if (
          term.length >= 4 &&
          words.some((w) => w.length >= 4 && editDistanceAtMost1(w, term))
        )
          score += 1;
      }
      if (score > 0)
        hits.push({
          mediaId: m.id,
          srcMs: seg.start,
          srcEndMs: seg.end,
          text: seg.text.join(' '),
          score,
        });
    };
    for (const w of t.words) {
      if (w.kind === 'pause') {
        flush();
        seg = null;
        continue;
      }
      seg ??= { text: [], start: w.startMs, end: w.endMs };
      seg.text.push(w.text);
      seg.end = w.endMs;
      if (/[.!?]$/.test(w.text)) {
        flush();
        seg = null;
      }
    }
    flush();
  }
  return hits.sort((a, b) => b.score - a.score || a.srcMs - b.srcMs).slice(0, limit);
}
