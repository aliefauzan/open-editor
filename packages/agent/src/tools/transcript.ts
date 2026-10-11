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
