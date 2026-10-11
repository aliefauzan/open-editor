// Clipper steps 1–2 (agent spec "Workflows" 1; plan D-11, D-15): the job chain, quick clips with
// the agent's LLM scorer, the ranges checkpoint and Tighten. Stylize then runs on the new sequences.
// Every job and write carries the run's `runId` (D-50), so "Undo this run" covers the whole run.
import type { QuickClipsResult } from '@vox/engine';
import { VoxError } from '../errors.ts';
import { RunStopped, type AgentRun } from '../loop/run.ts';
import type { TightenRange } from '../loop/types.ts';
import { createLlmScorer, LLM_SCORER_ID, llmScorerSlot } from '../quickScorer.ts';
import { runEngineJob } from '../tools/jobs.ts';
import type { Checkpoints } from './checkpoints.ts';

export interface ClipperOptions {
  /** A link or file path the user named; ingested first. */
  source?: string;
  /** Clip a media item already in the project instead (no ingest). */
  mediaId?: string;
  count: number;
  minMs: number;
  maxMs: number;
  /** `all`: apply the whole tighten list (`--yes`); `ask`: pause with kind `pauses`. */
  tighten: 'all' | 'ask';
}

export interface ClipperSteps {
  mediaId: string;
  sequenceIds: string[];
  scorer: string;
  notes: string[];
}

/** Runs an engine job as the agent with the run's id (job tools' rules, D-50). */
async function workflowJob<T>(run: AgentRun, kind: string, args: Record<string, unknown>) {
  const full = { projectId: run.ctx.projectId, ...args, actor: 'agent', runId: run.runId };
  const result = (await (run.ctx.runJob
    ? run.ctx.runJob(kind, full)
    : runEngineJob(run.ctx.engine, kind, full, run.ctx.signal))) as T;
  const version = (await run.ctx.engine.getProject(run.ctx.projectId)).version;
  if (version > run.ctx.seenVersion) {
    run.ctx.seenVersion = version;
    run.versions.push(version);
  }
  run.record.write({ type: 'tool', tool: kind, by: 'workflow', args: full, result });
  return result;
}

const pauseText = (r: { kind: string; startMs: number; endMs: number }) =>
  r.kind === 'pause'
    ? `(pause ${String(r.endMs - r.startMs)} ms)`
    : `(${r.kind} ${String(r.endMs - r.startMs)} ms)`;

/** Tighten (plan D-15): the review list, then one `remove_pauses` per sequence (or none). */
async function tighten(
  run: AgentRun,
  cp: Checkpoints,
  sequenceId: string,
  mode: ClipperOptions['tighten'],
): Promise<string> {
  const dry = await run.workflowCall('remove_pauses', { sequenceId, dryRun: true });
  const res = run.aliases.fromModel(dry.result) as {
    results: {
      report?: {
        ranges?: {
          startMs: number;
          endMs: number;
          kind: TightenRange['kind'];
          wordKeys: string[];
        }[];
      };
    }[];
  };
  const raw = res.results[0]?.report?.ranges ?? [];
  const alias = run.aliases.aliasOf(sequenceId);
  if (raw.length === 0) {
    cp.met('tighten', sequenceId, 'no pauses to cut');
    return `Tighten ${alias}: no pauses to cut.`;
  }
  const ranges: TightenRange[] = raw.map((r) => ({
    wordKey: r.wordKeys[0]!,
    kind: r.kind,
    seqStartMs: r.startMs,
    seqEndMs: r.endMs,
    text: pauseText(r),
  }));
  run.record.write({ type: 'tighten', sequenceId, ranges });
  let keys: string[] | undefined;
  if (mode === 'ask') {
    const d = await run.pause({
      reason: 'approval',
      kind: 'pauses',
      detail: `${String(ranges.length)} pause(s) in ${alias} can be cut (${String(ranges.reduce((n, r) => n + r.seqEndMs - r.seqStartMs, 0))} ms).`,
      ranges,
    });
    if (d.action === 'stop') throw new RunStopped();
    keys = d.wordKeys;
  }
  if (keys !== undefined && keys.length === 0) {
    cp.skipped('tighten', sequenceId, 'skipped by the user');
    return `Tighten ${alias}: skipped by the user.`;
  }
  const ticked = keys === undefined ? raw : raw.filter((r) => keys.includes(r.wordKeys[0]!));
  const args =
    ticked.length === raw.length
      ? { sequenceId }
      : { sequenceId, wordKeys: ticked.flatMap((r) => r.wordKeys) };
  const out = await run.workflowCall('remove_pauses', args);
  const ok = (out.result as { results: { status: string }[] }).results.every(
    (x) => x.status === 'succeeded',
  );
  if (!ok) {
    cp.missed('tighten', sequenceId, 'remove_pauses did not apply');
    return `Tighten ${alias}: the cut did not apply.`;
  }
  cp.met('tighten', sequenceId, `${String(ticked.length)} of ${String(raw.length)} cut`);
  return `Tighten ${alias}: cut ${String(ticked.length)} of ${String(raw.length)} pause(s)${mode === 'all' ? ' (--yes)' : ''}.`;
}

/** The first link or path in the message or attachments (the clipper's input). */
export function sourceIn(message: string, attachments: readonly string[] = []): string | undefined {
  if (attachments[0]) return attachments[0];
  const url = /\bhttps?:\/\/[^\s"'<>]+/.exec(message)?.[0]?.replace(/[.,;:!?)]+$/, '');
  if (url) return url;
  return /(?:^|\s)((?:~|\.{0,2})?\/[^\s"'<>]+\.[A-Za-z0-9]{2,5})(?=\s|$)/.exec(message)?.[1];
}

/** Steps 1–2 and Tighten. Returns the new sequences in pick order. */
export async function clipperSteps(
  run: AgentRun,
  cp: Checkpoints,
  opts: ClipperOptions,
): Promise<ClipperSteps> {
  const notes: string[] = [];
  let mediaId = opts.mediaId;
  const source = opts.source ?? sourceIn(run.request.message, run.request.attachments);
  if (!mediaId && !source) {
    // no link or file named: clip the project's own video (the first one), if it has one
    const p = await run.ctx.engine.getProject(run.ctx.projectId);
    mediaId = p.media.find((m) => m.kind === 'video')?.id;
    if (mediaId)
      notes.push(
        `No link or file named: clipped ${run.aliases.aliasOf(mediaId)}, the project's video.`,
      );
  }
  if (!mediaId) {
    if (!source)
      throw new VoxError(
        'VALIDATION',
        'the clipper needs a video: no link or file in the message',
        'Name a link or a file, e.g. "make 3 clips from https://…".',
      );
    const ing = await run.workflowCall('ingest', { source });
    const media = run.aliases.fromModel(ing.result) as {
      result?: { media?: { mediaId: string; kind?: string }[] };
    };
    mediaId = media.result?.media?.find((m) => m.kind === undefined || m.kind === 'video')?.mediaId;
    if (!mediaId)
      throw new VoxError(
        'MEDIA_UNSUPPORTED',
        `${source} gave no video`,
        'Pass a video link or file.',
      );
  }
  // the job chain; a step whose output the media item already has is not run again
  const have = (await run.ctx.engine.getProject(run.ctx.projectId)).media.find(
    (m) => m.id === mediaId,
  );
  if (!have?.shotsPath) await run.workflowCall('shots', { mediaId });
  if (!have?.transcriptPath) await run.workflowCall('transcribe', { mediaIds: [mediaId] });
  if (!have?.facetrackPath) await run.workflowCall('facetrack', { mediaId });

  const fast = run.deps.models.fast;
  const slot = llmScorerSlot(run.ctx.engine);
  if (fast) slot.current = createLlmScorer(run, fast);
  let q: QuickClipsResult;
  try {
    q = await workflowJob<QuickClipsResult>(run, 'quickClips', {
      mediaId,
      count: opts.count,
      minMs: opts.minMs,
      maxMs: opts.maxMs,
      scorer: fast ? LLM_SCORER_ID : 'heuristic',
      prompt: run.request.message.slice(0, 2000),
    });
  } finally {
    delete slot.current;
  }
  if (!fast) notes.push('No fast model: the heuristic scorer picked the moments.');
  if (q.scorerError)
    notes.push(
      `The LLM scorer failed (${q.scorerError.message}); the heuristic scorer picked the moments.`,
    );
  if (q.note) notes.push(q.note);

  const p = await run.ctx.engine.getProject(run.ctx.projectId);
  for (const sequenceId of q.sequenceIds) {
    const s = p.sequences.find((x) => x.id === sequenceId);
    if (!s?.sourceRange) cp.missed('ranges', sequenceId, 'no sourceRange saved');
    else if (!s.captions?.enabled) cp.missed('ranges', sequenceId, 'captions are off');
    else
      cp.met(
        'ranges',
        sequenceId,
        `${String(s.sourceRange.inMs)}–${String(s.sourceRange.outMs)} srcMs`,
      );
  }
  const open = cp.open(q.sequenceIds).filter((m) => m.checkpoint === 'ranges');
  if (open.length > 0) throw cp.error(open, (id) => run.aliases.aliasOf(id));
  if (q.sequenceIds.length === 0)
    throw new VoxError(
      'VALIDATION',
      'quick clips found no range of whole sentences that fits the length',
      'Try another length (e.g. 20–60 s) or a longer video.',
    );

  for (const sequenceId of q.sequenceIds)
    notes.push(await tighten(run, cp, sequenceId, opts.tighten));
  return { mediaId, sequenceIds: q.sequenceIds, scorer: q.scorer, notes };
}
