// get_transcript (agent spec "Read tools"; plan D-15, D-81). By default one compact line per
// sentence or pause-bounded phrase, `[startMs-endMs] text`, scoped to a clip, a sequence's media
// span or a source range; `words: true` gives the per-word JSON page (keys, kinds, srcMs and seqMs).
import { z } from 'zod';
import { resolveTranscriptScope, transcriptLines, transcriptPage } from './transcript.ts';
import type { AgentTool, ToolContext, ToolOutput } from './types.ts';

const id = z.string().min(1);
const ms = z.int().min(0);

export const GET_TRANSCRIPT_DESCRIPTION =
  'Transcript lines "[startMs-endMs] text", one per sentence: sequence ms with clipId (only the span that clip plays) ' +
  'or sequenceId (its media clips’ span), else source ms; fromSrcMs/toSrcMs narrow it. Max ~4k tokens; pass nextCursor ' +
  'as cursor. words: true gives per-word key, kind, srcMs and seqMs instead (only when you need them).';

const input = z.strictObject({
  mediaId: id.optional(),
  clipId: id.optional(),
  sequenceId: id.optional(),
  fromSrcMs: ms.optional(),
  toSrcMs: ms.optional(),
  cursor: z.int().min(0).optional(),
  words: z.boolean().optional(),
});

async function run(ctx: ToolContext, a: z.infer<typeof input>): Promise<ToolOutput> {
  const p = await ctx.engine.getProject(ctx.projectId);
  if (p.version > ctx.seenVersion) ctx.seenVersion = p.version;
  const label = (mediaId: string, first: number, last: number, n: number) =>
    `get_transcript ${ctx.aliases.aliasOf(mediaId)} ${String(first)}–${String(last)} srcMs, ${String(n)} words`;
  if (a.words === true) {
    const scope = resolveTranscriptScope(p, a);
    const page = await transcriptPage(ctx.engine, ctx.projectId, {
      mediaId: scope.media.id,
      fromSrcMs: scope.from,
      toSrcMs: scope.to,
      sequenceId: scope.sequenceId,
      cursor: a.cursor,
    });
    const first = page.words[0]?.srcMs ?? scope.from ?? 0;
    const last = page.words.at(-1)?.srcEndMs ?? first;
    return {
      untrusted: 'transcript',
      read: { version: p.version, label: label(page.mediaId, first, last, page.words.length) },
      result: ctx.aliases.toModel(page),
    };
  }
  const r = await transcriptLines(ctx.engine, ctx.projectId, a);
  const first = r.firstSrcMs ?? r.page.fromSrcMs ?? a.fromSrcMs ?? 0;
  const last = r.lastSrcEndMs ?? first;
  return {
    untrusted: 'transcript',
    read: { version: p.version, label: label(r.page.mediaId, first, last, r.words) },
    result: ctx.aliases.toModel(r.page),
  };
}

export function transcriptTool(): AgentTool {
  return {
    name: 'get_transcript',
    kind: 'read',
    description: GET_TRANSCRIPT_DESCRIPTION,
    input,
    run: (ctx, args) => run(ctx, args as z.infer<typeof input>),
  };
}
