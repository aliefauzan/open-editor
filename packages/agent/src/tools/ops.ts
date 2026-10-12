// One write tool per engine op (agent spec "Tools" → "Write tools"), generated from OP_ARGS so the
// tools follow the engine. Each write runs with actor `agent`, the run's `runId` and the version the
// run last saw as `baseVersion`; a STALE result re-reads and retries once (agent spec "Error
// handling"). The model gets `{ version, results }` with aliases; `changes` go to the run record.
import { OP_ARGS, OP_NAMES, type ApplyResult, type OpName } from '@vox/engine';
import { VoxError } from '../errors.ts';
import type { AgentTool, ToolContext, ToolOutput } from './types.ts';

/** `addScene` → `add_scene`. */
export function toolNameOf(op: string): string {
  return op.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

const TIME_NOTE =
  'Times are integer ms: startMs, endMs and durationMs are sequence (timeline) time; inMs is source time. A clip with speed s plays durationMs × s of source.';

const OP_DESCRIPTIONS: Readonly<Record<OpName, string>> = {
  addMedia: 'Register a media item that already exists in the project folder.',
  updateMedia: 'Change a media item’s tags, description or other metadata.',
  removeMedia: 'Remove an unused media item from the project (the file stays on disk).',
  replaceMedia: 'Point every clip of one media item at another media item.',
  addSequence: 'Add an empty sequence (9:16 by default).',
  updateSequence: 'Rename a sequence or change its canvas, style, sfx, overlays or source range.',
  duplicateSequence: 'Copy a sequence with all its tracks and items.',
  removeSequence: 'Remove a sequence.',
  addTrack: 'Add a video (V) or audio (A) track to a sequence.',
  updateTrack:
    'Lock, hide, mute or rename a track; duck: true lowers an audio track under the speech tracks.',
  removeTrack: 'Remove an empty track.',
  reorderTracks: 'Reorder the video or audio tracks of a sequence.',
  placeClip: 'Place a media clip on a track (with its linked audio when withAudio).',
  updateClip: 'Change a media clip’s framing, volume, denoise, motion or other settings.',
  addScene: 'Add a template scene (collage beat, title, map…) on a video track.',
  updateScene: 'Change a scene’s template, variables or muted sfx cues (sfxOff).',
  moveItem: 'Move an item (and its linked items) to a new start time or track.',
  trimItem: 'Trim an item’s start or end.',
  splitItem: 'Split an item in two at a sequence time.',
  setClipSpeed:
    'Set a media clip’s speed (0.25–4 picture, 0.5–2 with sound; 1 = normal); the source range stays, so the clip gets shorter or longer. onOverlap: "ripple" shifts later items.',
  removeItem: 'Remove an item (and its linked items unless unlinked).',
  rippleDelete: 'Cut a time range out of a track and close the gap.',
  link: 'Link items so they move and trim together.',
  unlink: 'Unlink items.',
  setTransition: 'Set or clear the transition into an item.',
  setCaptions: 'Turn captions on or off and change caption settings or word overrides.',
  removePauses:
    'Cut pauses (and optionally fillers and repeats) as one undo entry. dryRun: true returns the ranges (the review list) and changes nothing; wordKeys limits the cut to listed ranges.',
  removeWords:
    'Cut the listed words (text-based cutting) as one undo entry; dryRun: true only lists the ranges.',
  pasteItems: 'Paste copied items at a sequence time.',
  restoreSnapshot: 'Restore a named project snapshot (one undo entry).',
  batch:
    'Apply several ops (engine op names such as moveItem, args as for their tools) as one undo entry.',
};

function writeResult(ctx: ToolContext, r: ApplyResult, note?: string): ToolOutput {
  const changed = r.changes.length > 0;
  if (changed || r.version > ctx.seenVersion) ctx.seenVersion = r.version;
  return {
    result: ctx.aliases.toModel({
      version: r.version,
      results: r.results.map((x) => ({
        op: x.op,
        status: x.status,
        ...(x.error && {
          error: { code: x.error.code, message: x.error.message, hint: x.error.hint },
        }),
        ...(x.items && { items: x.items }),
        ...(x.report !== undefined && { report: x.report }),
      })),
      ...(note !== undefined && { note }),
    }),
    ...(changed && { versions: [r.version], changes: r.changes }),
  };
}

const isStale = (r: ApplyResult) =>
  r.results.some((x) => x.status === 'conflicted' && x.error?.code === 'STALE');

/** Applies one op as the agent; on STALE re-reads (updates the seen version) and retries once. */
export async function applyAsAgent(
  ctx: ToolContext,
  op: string,
  args: unknown,
): Promise<ToolOutput> {
  const call = { op, args };
  const opts = (baseVersion: number) => ({
    actor: 'agent' as const,
    runId: ctx.runId,
    baseVersion,
  });
  let r = await ctx.engine.applyOp(ctx.projectId, call, opts(ctx.seenVersion));
  if (!isStale(r)) return writeResult(ctx, r);
  const from = ctx.seenVersion;
  const since = await ctx.engine.history(ctx.projectId, { sinceVersion: from });
  const now = since.at(-1)?.version ?? r.version;
  ctx.seenVersion = now;
  r = await ctx.engine.applyOp(ctx.projectId, call, opts(now));
  return writeResult(
    ctx,
    r,
    `The project changed since version ${String(from)} (${String(since.length)} edit(s) by someone else); re-read at version ${String(now)} and retried once.`,
  );
}

export function opTools(): AgentTool[] {
  return OP_NAMES.map((op) => {
    if (!Object.hasOwn(OP_DESCRIPTIONS, op)) {
      throw new VoxError(
        'VALIDATION',
        `op ${op} has no tool description`,
        'Add one to tools/ops.ts',
      );
    }
    return {
      name: toolNameOf(op),
      kind: 'write' as const,
      description: `${OP_DESCRIPTIONS[op]} ${TIME_NOTE}`,
      input: OP_ARGS[op],
      run: (ctx: ToolContext, args: unknown) => applyAsAgent(ctx, op, args),
    };
  });
}
