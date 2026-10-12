// D-81: compact transcript lines and clip-scoped reads. The default get_transcript result is one
// `[startMs-endMs] text` line per sentence or phrase; clipId / sequenceId / a source range limit
// the read to that span; `words: true` keeps the per-word JSON page.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { estimateTokens } from '../../src/providers/tool-cost.ts';
import { buildRegistry, invokeTool } from '../../src/tools/registry.ts';
import { TRANSCRIPT_PAGE_TOKENS } from '../../src/tools/transcript.ts';
import type { ToolContext } from '../../src/tools/types.ts';
import {
  ENGINE_FIXTURES,
  fixtureProject,
  longTranscriptFile,
  toolContext,
  type Fixture,
} from '../helpers/project.ts';

const r = buildRegistry({ imageProviders: { list: () => [], register: () => undefined } });
const run = (ctx: ToolContext, name: string, args: unknown) => invokeTool(ctx, r, name, args);

interface Lines {
  mediaId: string;
  times: 'seqMs' | 'srcMs';
  fromSrcMs?: number;
  toSrcMs?: number;
  lines: string;
  unplacedWords?: number;
  nextCursor: number | null;
  totalWords: number;
}

const LINE = /^\[(\d+)-(\d+)\] (.+)$/;
const parse = (text: string) =>
  text === ''
    ? []
    : text.split('\n').map((l) => {
        const m = LINE.exec(l);
        expect(m, l).not.toBeNull();
        return { start: Number(m![1]), end: Number(m![2]), text: m![3]! };
      });

async function trimmedClip(f: Fixture, fromMs: number, toMs: number) {
  const apply = (op: string, args: Record<string, unknown>) =>
    f.engine.applyOp(f.projectId, { op, args: { sequenceId: f.sequenceId, ...args } } as never, {
      actor: 'user',
    });
  await apply('trimItem', { itemId: f.v1, edge: 'end', toMs });
  await apply('trimItem', { itemId: f.v1, edge: 'start', toMs: fromMs });
  await apply('moveItem', { itemId: f.v1, startMs: 0 });
}

describe('get_transcript compact lines (D-81)', () => {
  test('default: one [startMs-endMs] line per sentence or phrase, source ms, no per-word JSON', async () => {
    const f = await fixtureProject();
    const ctx = toolContext(f);
    const out = await run(ctx, 'get_transcript', { mediaId: f.mediaId });
    expect(out.untrusted).toBe('transcript');
    const page = out.result as Lines & { words?: unknown };
    expect(page.words).toBeUndefined();
    expect(page).toMatchObject({ mediaId: 'm1', times: 'srcMs', nextCursor: null, totalWords: 68 });
    const lines = parse(page.lines);
    expect(lines[0]).toEqual({ start: 34, end: 260, text: 'Hello,' });
    expect(lines.at(-1)!.text.endsWith('test.')).toBe(true);
    expect(lines.at(-1)!.end).toBe(19100);
    // 60 words (8 pauses are line breaks, not text), in order, none twice
    expect(lines.flatMap((l) => l.text.split(' '))).toHaveLength(60);
    for (let i = 1; i < lines.length; i++)
      expect(lines[i]!.start).toBeGreaterThanOrEqual(lines[i - 1]!.end);
    expect(out.read?.label).toBe('get_transcript m1 34–19100 srcMs, 60 words');
    // the same read as per-word JSON is several times larger
    const words = await run(ctx, 'get_transcript', { mediaId: f.mediaId, words: true });
    expect(estimateTokens(JSON.stringify(words.result))).toBeGreaterThan(
      3 * estimateTokens(JSON.stringify(out.result)),
    );
  });

  test('a range at the start, at the end and past the end', async () => {
    const f = await fixtureProject();
    const ctx = toolContext(f);
    const head = (await run(ctx, 'get_transcript', { mediaId: f.mediaId, toSrcMs: 300 }))
      .result as Lines;
    expect(parse(head.lines)).toEqual([{ start: 34, end: 260, text: 'Hello,' }]);
    expect(head).toMatchObject({ toSrcMs: 300, nextCursor: null });
    expect(head.fromSrcMs).toBeUndefined();
    const tail = (
      await run(ctx, 'get_transcript', { mediaId: f.mediaId, fromSrcMs: 18300, toSrcMs: 60000 })
    ).result as Lines;
    expect(parse(tail.lines)).toEqual([{ start: 18300, end: 19100, text: 'this quick test.' }]);
    expect(tail.nextCursor).toBeNull();
  });

  test('an empty range: no lines, no cursor, a 0-word label', async () => {
    const f = await fixtureProject();
    const ctx = toolContext(f);
    const out = await run(ctx, 'get_transcript', { mediaId: f.mediaId, fromSrcMs: 19500 });
    expect(out.result).toMatchObject({ lines: '', nextCursor: null, fromSrcMs: 19500 });
    expect(out.read?.label).toBe('get_transcript m1 19500–19500 srcMs, 0 words');
  });

  test('clipId reads only the source span the clip plays, in sequence ms', async () => {
    const f = await fixtureProject();
    await trimmedClip(f, 5000, 8000);
    const ctx = toolContext(f);
    await run(ctx, 'get_sequence', { sequenceId: f.sequenceId });
    const clip = ctx.aliases.aliasOf(f.v1);
    const out = await run(ctx, 'get_transcript', { clipId: clip });
    const page = out.result as Lines;
    expect(page).toMatchObject({ mediaId: 'm1', times: 'seqMs', fromSrcMs: 5000, toSrcMs: 8000 });
    const lines = parse(page.lines);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.start >= 0 && l.end <= 3000)).toBe(true);
    // the source read over the same span has the same words, plus the ones cut at the clip's
    // edges (a word the clip starts or ends inside is not placed; it is counted, not shown)
    const src = (
      await run(ctx, 'get_transcript', { mediaId: f.mediaId, fromSrcMs: 5000, toSrcMs: 8000 })
    ).result as Lines;
    const text = (p: Lines) => parse(p.lines).flatMap((l) => l.text.split(' '));
    expect(text(src).filter((w) => text(page).includes(w))).toEqual(text(page));
    expect(text(src).length - text(page).length).toBe(page.unplacedWords ?? 0);
    // sequenceId alone scopes to the span of the sequence's media clips
    const seq = (await run(ctx, 'get_transcript', { sequenceId: f.sequenceId })).result as Lines;
    expect(seq).toMatchObject({ times: 'seqMs', fromSrcMs: 5000, toSrcMs: 8000 });
    expect(seq.lines).toBe(page.lines);
    // words: true keeps the clip scope
    const words = (await run(ctx, 'get_transcript', { clipId: clip, words: true })).result as {
      words: { text: string; kind: string; srcMs: number; seqMs: number | null }[];
    };
    expect(words.words.every((w) => w.srcMs < 8000 && w.srcMs > 4000)).toBe(true);
    expect(
      words.words.filter((w) => w.kind !== 'pause' && w.seqMs !== null).map((w) => w.text),
    ).toEqual(text(page));
  });

  test('words a cut removed are left out and counted; the cut ends a line', async () => {
    const f = await fixtureProject();
    const ctx = toolContext(f);
    const seqOp = (op: string, args: Record<string, unknown>) =>
      f.engine.applyOp(f.projectId, { op, args: { sequenceId: f.sequenceId, ...args } } as never, {
        actor: 'user',
      });
    await seqOp('splitItem', { itemId: f.v1, atMs: 4000 });
    await seqOp('splitItem', { itemId: f.v1, atMs: 2000 });
    const p = await f.engine.getProject(f.projectId);
    const v1 = p.sequences[0]!.videoTracks.find((t) => t.id === 'V1')!.items;
    const middle = v1.find((x) => x.startMs === 2000)!;
    await seqOp('removeItem', { itemId: middle.id });
    const page = (await run(ctx, 'get_transcript', { sequenceId: f.sequenceId })).result as Lines;
    expect(page.unplacedWords).toBeGreaterThan(0);
    const lines = parse(page.lines);
    expect(lines.some((l) => l.start < 2000 && l.end > 2000 + 100)).toBe(false);
    expect(lines.every((l) => l.end <= 2000 || l.start >= 4000)).toBe(true);
  });

  test('a sped-up clip keeps whole sentences per line; a split ends a line at the edit', async () => {
    const f = await fixtureProject();
    const ctx = toolContext(f);
    const plain = parse(
      ((await run(ctx, 'get_transcript', { sequenceId: f.sequenceId })).result as Lines).lines,
    );
    await f.engine.applyOp(
      f.projectId,
      {
        op: 'setClipSpeed',
        args: { sequenceId: f.sequenceId, itemId: f.v1, speed: 1.5 },
      } as never,
      { actor: 'user' },
    );
    const fast = parse(
      ((await run(ctx, 'get_transcript', { sequenceId: f.sequenceId })).result as Lines).lines,
    );
    expect(fast.map((l) => l.text)).toEqual(plain.map((l) => l.text));
    expect(fast.at(-1)!.end).toBeLessThan(plain.at(-1)!.end);
    // a split inside the second sentence: the same words, one more line
    const second = plain[1]!;
    await f.engine.applyOp(
      f.projectId,
      {
        op: 'splitItem',
        args: {
          sequenceId: f.sequenceId,
          itemId: f.v1,
          atMs: Math.round((fast[1]!.start + fast[1]!.end) / 2),
        },
      } as never,
      { actor: 'user' },
    );
    const split = parse(
      ((await run(ctx, 'get_transcript', { sequenceId: f.sequenceId })).result as Lines).lines,
    );
    expect(split).toHaveLength(plain.length + 1);
    expect(`${split[1]!.text} ${split[2]!.text}`).toBe(second.text);
  });

  test('clipId errors: a scene, an unknown clip, a different mediaId; no scope at all', async () => {
    const f = await fixtureProject();
    const ctx = toolContext(f);
    await expect(run(ctx, 'get_transcript', {})).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(run(ctx, 'get_transcript', { clipId: 'it_nope000000001' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await f.engine.applyOp(
      f.projectId,
      {
        op: 'addScene',
        args: {
          sequenceId: f.sequenceId,
          trackId: 'V2',
          template: 'base/title',
          startMs: 0,
          durationMs: 1000,
          variables: { title: 'Hi' },
        },
      } as never,
      { actor: 'user' },
    );
    const p = await f.engine.getProject(f.projectId);
    const scene = p.sequences[0]!.videoTracks.flatMap((t) => t.items).find(
      (x) => x.type === 'scene',
    );
    expect(scene).toBeDefined();
    await expect(run(ctx, 'get_transcript', { clipId: scene!.id })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  test('pages stay under 4k tokens; the cursor walks a long transcript by whole lines', async () => {
    const f = await fixtureProject({ transcript: longTranscriptFile(3000) });
    const ctx = toolContext(f);
    const seen: string[] = [];
    let cursor: number | null = 0;
    let pages = 0;
    let tokens = 0;
    while (cursor !== null) {
      const out = await run(ctx, 'get_transcript', {
        mediaId: f.mediaId,
        ...(cursor > 0 && { cursor }),
      });
      const page = out.result as Lines;
      const t = estimateTokens(JSON.stringify(page));
      expect(t).toBeLessThanOrEqual(TRANSCRIPT_PAGE_TOKENS);
      tokens += t;
      for (const l of parse(page.lines)) seen.push(...l.text.split(' '));
      cursor = page.nextCursor;
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen.map((w) => w.replace('.', ''))).toEqual(
      Array.from({ length: 3000 }, (_, i) => `word${String(i)}`),
    );
    expect(tokens).toBeGreaterThan(0);
  });
});

/** The 20 s fixture transcript repeated to `minutes` minutes (real words, pauses and sentences). */
function repeatedTranscript(minutes: number): string {
  const src = JSON.parse(
    readFileSync(join(ENGINE_FIXTURES, 'transcripts/talking-head-20s.json'), 'utf8'),
  ) as { language: string; words: { startMs: number; endMs: number }[] };
  const words = Array.from({ length: minutes * 3 }, (_, k) =>
    src.words.map((w) => ({ ...w, startMs: w.startMs + k * 20_000, endMs: w.endMs + k * 20_000 })),
  ).flat();
  const path = join(mkdtempSync(join(tmpdir(), 'vox-agent-t-')), 'long.json');
  writeFileSync(
    path,
    JSON.stringify({
      language: src.language,
      speechRegions: [{ startMs: 0, endMs: minutes * 60_000 }],
      words,
    }),
  );
  return path;
}

/** Tokens of every page of one read, walking the cursor. */
async function readTokens(ctx: ToolContext, args: Record<string, unknown>) {
  let tokens = 0;
  let pages = 0;
  let cursor: number | null = 0;
  while (cursor !== null) {
    const out = await run(ctx, 'get_transcript', { ...args, ...(cursor > 0 && { cursor }) });
    const page = out.result as { nextCursor: number | null };
    tokens += estimateTokens(JSON.stringify(page));
    cursor = page.nextCursor;
    pages++;
  }
  return { tokens, pages };
}

describe('transcript read size (D-81 measurement)', () => {
  test('20 s fixture and a 10-minute transcript: lines vs per-word JSON; a clip-scoped read', async () => {
    const short = await fixtureProject();
    const s = toolContext(short);
    const shortWords = await readTokens(s, { mediaId: short.mediaId, words: true });
    const shortLines = await readTokens(s, { mediaId: short.mediaId });
    const long = await fixtureProject({ transcript: repeatedTranscript(10) });
    const l = toolContext(long);
    const longWords = await readTokens(l, { mediaId: long.mediaId, words: true });
    const longLines = await readTokens(l, { mediaId: long.mediaId });
    // a 40 s quick clip from the middle of the 10-minute source
    await trimmedClip(long, 300_000, 340_000);
    await run(l, 'get_sequence', { sequenceId: long.sequenceId });
    const clip = await readTokens(l, { clipId: l.aliases.aliasOf(long.v1) });
    if (process.env['VOX_TRANSCRIPT_REPORT'] === '1')
      console.info(JSON.stringify({ shortWords, shortLines, longWords, longLines, clip }));
    expect(shortLines.tokens * 3).toBeLessThan(shortWords.tokens);
    expect(longLines.tokens * 3).toBeLessThan(longWords.tokens);
    expect(clip.tokens * 10).toBeLessThan(longLines.tokens);
  }, 60_000);
});
