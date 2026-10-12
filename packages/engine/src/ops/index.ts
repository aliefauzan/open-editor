// Op registry and runner (engine spec "Edit operations"; plan D-18). Each op's exported zod schema
// `<opName>Args` is the contract; phase 11 generates agent tools from OP_ARGS.
import { z } from 'zod';
import { isVoxError, VoxError } from '../errors.ts';
import { diffProjects, type Change } from '../model/diff.ts';
import { formatIssues, type Project } from '../model/schema.ts';
import { sortProject, type OpContext } from './core.ts';
import { checkInvariants } from './invariants.ts';
import { setClipSpeed, setClipSpeedArgs } from './speed.ts';
import { setCaptions, setCaptionsArgs } from './captions.ts';
import {
  link,
  linkArgs,
  moveItem,
  moveItemArgs,
  pasteItems,
  pasteItemsArgs,
  placeClip,
  placeClipArgs,
  removeItem,
  removeItemArgs,
  rippleDelete,
  rippleDeleteArgs,
  splitItem,
  splitItemArgs,
  trimItem,
  trimItemArgs,
  unlink,
  unlinkArgs,
  updateClip,
  updateClipArgs,
} from './items.ts';
import {
  addMedia,
  addMediaArgs,
  removeMedia,
  removeMediaArgs,
  replaceMedia,
  replaceMediaArgs,
  updateMedia,
  updateMediaArgs,
} from './library.ts';
import { restoreSnapshot, restoreSnapshotArgs } from './project.ts';
import {
  addScene,
  addSceneArgs,
  setTransition,
  setTransitionArgs,
  updateScene,
  updateSceneArgs,
} from './scenes.ts';
import {
  addSequence,
  addSequenceArgs,
  addTrack,
  addTrackArgs,
  duplicateSequence,
  duplicateSequenceArgs,
  removeSequence,
  removeSequenceArgs,
  removeTrack,
  removeTrackArgs,
  reorderTracks,
  reorderTracksArgs,
  updateSequence,
  updateSequenceArgs,
  updateTrack,
  updateTrackArgs,
} from './sequences.ts';
import { removePauses, removePausesArgs, removeWords, removeWordsArgs } from './words.ts';

export type { OpContext } from './core.ts';
export * from './templates.ts';
export { mapWordsToTimeline, wordSourceTracks, type TimelineWord, type CutRange } from './words.ts';
export { CAPTION_DEFAULTS, parseWordKey } from './captions.ts';
export { SnapshotNameSchema } from './project.ts';
export {
  addMediaArgs,
  updateMediaArgs,
  removeMediaArgs,
  replaceMediaArgs,
  addSequenceArgs,
  updateSequenceArgs,
  duplicateSequenceArgs,
  removeSequenceArgs,
  addTrackArgs,
  updateTrackArgs,
  removeTrackArgs,
  reorderTracksArgs,
  placeClipArgs,
  updateClipArgs,
  addSceneArgs,
  updateSceneArgs,
  moveItemArgs,
  trimItemArgs,
  splitItemArgs,
  removeItemArgs,
  rippleDeleteArgs,
  linkArgs,
  unlinkArgs,
  setTransitionArgs,
  setCaptionsArgs,
  removePausesArgs,
  removeWordsArgs,
  pasteItemsArgs,
  restoreSnapshotArgs,
  setClipSpeedArgs,
};

interface OpDef<S extends z.ZodType> {
  args: S;
  run(p: Project, args: z.infer<S>, ctx: OpContext): unknown;
}
const def = <S extends z.ZodType>(args: S, run: OpDef<S>['run']): OpDef<S> => ({ args, run });

const OPS = {
  addMedia: def(addMediaArgs, addMedia),
  updateMedia: def(updateMediaArgs, updateMedia),
  removeMedia: def(removeMediaArgs, removeMedia),
  replaceMedia: def(replaceMediaArgs, replaceMedia),
  addSequence: def(addSequenceArgs, addSequence),
  updateSequence: def(updateSequenceArgs, updateSequence),
  duplicateSequence: def(duplicateSequenceArgs, duplicateSequence),
  removeSequence: def(removeSequenceArgs, removeSequence),
  addTrack: def(addTrackArgs, addTrack),
  updateTrack: def(updateTrackArgs, updateTrack),
  removeTrack: def(removeTrackArgs, removeTrack),
  reorderTracks: def(reorderTracksArgs, reorderTracks),
  placeClip: def(placeClipArgs, placeClip),
  updateClip: def(updateClipArgs, updateClip),
  addScene: def(addSceneArgs, addScene),
  updateScene: def(updateSceneArgs, updateScene),
  moveItem: def(moveItemArgs, moveItem),
  trimItem: def(trimItemArgs, trimItem),
  splitItem: def(splitItemArgs, splitItem),
  removeItem: def(removeItemArgs, removeItem),
  rippleDelete: def(rippleDeleteArgs, rippleDelete),
  link: def(linkArgs, link),
  unlink: def(unlinkArgs, unlink),
  setTransition: def(setTransitionArgs, setTransition),
  setCaptions: def(setCaptionsArgs, setCaptions),
  removePauses: def(removePausesArgs, removePauses),
  removeWords: def(removeWordsArgs, removeWords),
  pasteItems: def(pasteItemsArgs, pasteItems),
  restoreSnapshot: def(restoreSnapshotArgs, restoreSnapshot),
  setClipSpeed: def(setClipSpeedArgs, setClipSpeed),
} as const;

export type SingleOpName = keyof typeof OPS;
export type OpName = SingleOpName | 'batch';

export const OpCallSchema = z.strictObject({ op: z.string().min(1), args: z.unknown() });
export const batchArgs = z.strictObject({ ops: z.array(OpCallSchema).min(1).max(10000) });

/** Every op's argument schema by op name (agent tool generation, CLI help). */
export const OP_ARGS: { readonly [K in OpName]: z.ZodType } = {
  ...(Object.fromEntries(Object.entries(OPS).map(([k, v]) => [k, v.args])) as unknown as Record<
    SingleOpName,
    z.ZodType
  >),
  batch: batchArgs,
};

export const OP_NAMES = Object.keys(OP_ARGS) as OpName[];

export interface OpCall {
  op: string;
  args?: unknown;
}

export interface StepOutcome {
  op: string;
  report?: unknown;
  /** Entity changes of this step alone. */
  changes: Change[];
}

export interface OpOutcome {
  project: Project;
  /** The op's report (the last step's for a batch). */
  report?: unknown;
  /** True for `dryRun`: nothing changed and nothing may be written. */
  dryRun: boolean;
  /** One per op; one per op inside a batch. */
  steps: StepOutcome[];
}

export function isOpName(name: string): name is OpName {
  return Object.hasOwn(OP_ARGS, name);
}

function parseArgs<S extends z.ZodType>(op: string, schema: S, args: unknown): z.infer<S> {
  const r = schema.safeParse(args ?? {});
  if (!r.success) {
    throw new VoxError(
      'VALIDATION',
      `${op}: ${formatIssues(r.error)}`,
      `Check the ${op} arguments`,
      {
        details: {
          op,
          issues: r.error.issues
            .slice(0, 20)
            .map((i) => ({ path: i.path.map(String), message: i.message })),
        },
      },
    );
  }
  return r.data;
}

function runSingle(p: Project, call: OpCall, ctx: OpContext): OpOutcome {
  if (!Object.hasOwn(OPS, call.op)) {
    throw new VoxError(
      'VALIDATION',
      `Unknown op ${JSON.stringify(call.op)}`,
      `Use one of: ${OP_NAMES.join(', ')}`,
      {
        details: { op: call.op },
      },
    );
  }
  const d = OPS[call.op as SingleOpName] as OpDef<z.ZodType>;
  const args = parseArgs(call.op, d.args, call.args) as Record<string, unknown>;
  const draft = structuredClone(p);
  const report = d.run(draft, args, ctx);
  const withReport = (o: Omit<OpOutcome, 'report'>): OpOutcome =>
    report === undefined ? o : { ...o, report };
  if (args['dryRun'] === true) {
    return withReport({
      project: p,
      dryRun: true,
      steps: [{ op: call.op, ...(report === undefined ? {} : { report }), changes: [] }],
    });
  }
  sortProject(draft);
  const changes = diffProjects(p, draft);
  const after = checkInvariants(p, draft, changes, ctx.templates);
  return withReport({
    project: after,
    dryRun: false,
    steps: [{ op: call.op, ...(report === undefined ? {} : { report }), changes }],
  });
}

function runBatch(p: Project, rawArgs: unknown, ctx: OpContext): OpOutcome {
  const { ops } = parseArgs('batch', batchArgs, rawArgs);
  let cur = p;
  const steps: StepOutcome[] = [];
  let report: unknown;
  for (const [index, call] of ops.entries()) {
    try {
      if (call.op === 'batch') {
        throw new VoxError(
          'VALIDATION',
          'batch cannot contain another batch',
          'Flatten the op list',
        );
      }
      const a = call.args as { dryRun?: unknown } | undefined;
      if (a && typeof a === 'object' && a.dryRun !== undefined) {
        throw new VoxError(
          'VALIDATION',
          `${call.op}: dryRun is not allowed inside batch`,
          'Run the dry run on its own',
        );
      }
      const out = runSingle(cur, call, ctx);
      cur = out.project;
      report = out.report;
      steps.push(...out.steps);
    } catch (e) {
      if (!isVoxError(e)) throw e;
      throw new VoxError(e.code, `batch op ${index} (${call.op}): ${e.message}`, e.hint, {
        cause: e,
        details: { ...e.details, batchIndex: index, op: call.op },
      });
    }
  }
  const o: OpOutcome = { project: cur, dryRun: false, steps };
  return report === undefined ? o : { ...o, report };
}

/** Apply one op (or a batch) to a project. Pure: the input project is never mutated. */
export function runOp(p: Project, call: OpCall, ctx: OpContext): OpOutcome {
  return call.op === 'batch' ? runBatch(p, call.args, ctx) : runSingle(p, call, ctx);
}
