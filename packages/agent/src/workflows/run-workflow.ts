// Runs a workflow end to end (agent spec "Workflows"; plan D-15): reads its frontmatter, fails at
// start without an `editor` model, notes the other missing roles, runs the workflow under one run
// (one `runId`, sub-runs per sequence) and fails the run at the end when a required checkpoint was
// missed. The CLI (`vox agent`) and the app (phase 13) call this.
import { VoxError, isVoxError, toVoxErrorJson } from '../errors.ts';
import { AgentRun, RunStopped } from '../loop/run.ts';
import type { RunDeps, RunModels } from '../loop/types.ts';
import type { AgentMode, Role } from '../providers/roles.ts';
import { Checkpoints, type CheckpointMark } from './checkpoints.ts';
import { clipperSteps } from './clipper.ts';
import { classifyIntent, type Intent } from './intent.ts';
import { loadWorkflow, type WorkflowName } from './load.ts';
import { stylizeSequences, type ClipReport, type Layout } from './stylize.ts';

export interface Selection {
  sequenceId: string;
  itemIds?: string[];
  playheadMs?: number;
}

export interface WorkflowRequest {
  projectId: string;
  workflow: WorkflowName;
  /** The user's instruction (its sources count for the ingest rule). */
  message: string;
  attachments?: string[];
  mode: AgentMode;
  /** Clipper: the video (default: the first link or path in the message or attachments). */
  source?: string;
  /** Clipper: clip a media item already in the project. */
  mediaId?: string;
  count?: number;
  minMs?: number;
  maxMs?: number;
  /** Clipper: `all` applies the whole tighten list (`--yes`); default `ask` (a `pauses` pause). */
  tighten?: 'all' | 'ask';
  /** Stylize: the sequences to style. */
  sequenceIds?: string[];
  /** Default: the engine's default style (`vox` when installed). */
  styleId?: string;
  layout?: Layout;
  /** Free-form: the UI selection. */
  selection?: Selection;
  confirmPlan?: boolean;
  signal?: AbortSignal;
}

export interface WorkflowDeps extends Omit<RunDeps, 'models'> {
  models: Partial<RunModels>;
}

export interface WorkflowResult {
  run: AgentRun;
  done: ReturnType<AgentRun['finish']>;
  sequenceIds: string[];
  checkpoints: CheckpointMark[];
  clips: ClipReport[];
  intent?: Intent;
}

const ROLE_NOTES: Partial<Record<Role, string>> = {
  fast: 'No fast model: the heuristic scorer picks moments and every free-form turn is an edit.',
  vision: 'No vision model: frames and qa.png are checked by numbers and flags only.',
};

/** Clipper defaults (agent spec "Clipper"): 3 clips of 30–60 s. */
export const CLIPPER_DEFAULTS = { count: 3, minMs: 30_000, maxMs: 60_000 } as const;

function selectionText(run: AgentRun, sel: Selection | undefined): string {
  if (!sel) return '';
  const parts = [`sequence ${run.aliases.aliasOf(sel.sequenceId)}`];
  if (sel.itemIds?.length)
    parts.push(`selected item(s) ${sel.itemIds.map((i) => run.aliases.aliasOf(i)).join(', ')}`);
  if (sel.playheadMs !== undefined) parts.push(`playhead ${String(sel.playheadMs)} ms`);
  return parts.join(', ');
}

/** An error the abort itself caused: the DOM AbortError (model calls) or a cancelled job. */
function isAbortError(err: unknown): boolean {
  if (isVoxError(err)) return err.code === 'CANCELLED';
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

export async function runWorkflow(
  deps: WorkflowDeps,
  req: WorkflowRequest,
): Promise<WorkflowResult> {
  const w = loadWorkflow(req.workflow);
  if (w.name === 'style-extract') {
    throw new VoxError(
      'VALIDATION',
      'the style-extract workflow is code-driven and runs through runStyleExtractWorkflow',
      'Use vox agent --workflow style-extract <link or file> --name <name>.',
    );
  }
  if (!deps.models.editor) {
    throw new VoxError(
      'ROLE_MISSING',
      `the ${w.name} workflow needs an editor model, and none is set`,
      'Set one: vox config roles set editor <provider>:<model> (or in Settings).',
      { details: { role: 'editor', workflow: w.name } },
    );
  }
  const models = deps.models as RunModels;
  const styleId = req.styleId ?? deps.engine.styles.defaultId();
  const style = deps.engine.styles.get(styleId);
  const workflowPrompt =
    w.name === 'clipper' ? `${w.prompt}\n\n${loadWorkflow('stylize').prompt}` : w.prompt;
  const run = await AgentRun.start(
    { ...deps, models },
    {
      projectId: req.projectId,
      workflow: w.name,
      message: req.message,
      ...(req.attachments && { attachments: req.attachments }),
      allowedTools: w.allowedTools,
      mode: req.mode,
      workflowPrompt,
      styleGuide: style.guide,
      styleGuideTrusted: style.style.trusted && style.style.source.type !== 'extracted',
      planKind: w.name === 'edit' ? 'ops' : 'clip',
      ...(req.confirmPlan && { confirmPlan: true }),
      ...(req.signal && { signal: req.signal }),
    },
  );
  for (const role of w.roles) {
    if (role !== 'editor' && !models[role as keyof RunModels] && ROLE_NOTES[role])
      run.addSummary(ROLE_NOTES[role]);
  }
  const cp = new Checkpoints(w.checkpoints);
  let sequenceIds: string[] = [];
  let clips: ClipReport[] = [];
  let intent: Intent | undefined;
  const result = (done: WorkflowResult['done']): WorkflowResult => ({
    run,
    done,
    sequenceIds,
    checkpoints: cp.marks,
    clips,
    ...(intent && { intent }),
  });
  try {
    const layout = req.layout ?? 'full-collage';
    if (w.name === 'clipper') {
      const steps = await clipperSteps(run, cp, {
        ...(req.source !== undefined && { source: req.source }),
        ...(req.mediaId !== undefined && { mediaId: req.mediaId }),
        count: req.count ?? CLIPPER_DEFAULTS.count,
        minMs: req.minMs ?? CLIPPER_DEFAULTS.minMs,
        maxMs: req.maxMs ?? CLIPPER_DEFAULTS.maxMs,
        tighten: req.tighten ?? 'ask',
      });
      sequenceIds = steps.sequenceIds;
      for (const n of steps.notes) run.addSummary(n);
      clips = await stylizeSequences(run, cp, sequenceIds, {
        styleId: style.id,
        layout,
        instruction: req.message,
      });
    } else if (w.name === 'stylize') {
      const p = await deps.engine.getProject(req.projectId);
      sequenceIds = [...new Set(req.sequenceIds ?? [])];
      const unknown = sequenceIds.filter((id) => !p.sequences.some((s) => s.id === id));
      if (sequenceIds.length === 0 || unknown.length > 0) {
        throw new VoxError(
          'VALIDATION',
          sequenceIds.length === 0
            ? 'Stylize needs at least one sequence'
            : `no sequence ${unknown.join(', ')} in the project`,
          'Pass the clips to style: --seq <id> (repeatable).',
        );
      }
      clips = await stylizeSequences(run, cp, sequenceIds, {
        styleId: style.id,
        layout,
        instruction: req.message || 'Add the style beats to these clips.',
      });
    } else {
      const sel = req.selection;
      if (sel) sequenceIds = [sel.sequenceId];
      const where = selectionText(run, sel);
      if (models.fast) {
        const r = await classifyIntent(run, models.fast, req.message, where, req.signal);
        intent = r.intent;
        run.record.write({ type: 'intent', intent: r.intent, ...(r.error && { error: r.error }) });
      } else intent = 'edit';
      run.ctx.question = intent === 'question';
      const t = await run.turn({
        scope: sequenceIds,
        instruction: where ? `${req.message}\n\nSelection: ${where}.` : req.message,
      });
      const status =
        t.status === 'completed' ? 'completed' : t.status === 'failed' ? 'failed' : 'stopped';
      return result(run.finish(status, t.summary, t.error));
    }
    const open = cp.open(sequenceIds);
    if (open.length > 0) {
      const e = cp.error(open, (id) => run.aliases.aliasOf(id));
      return result(
        run.finish('failed', `${e.message}. ${e.hint}`, deps.redactor.redact(toVoxErrorJson(e))),
      );
    }
    const n = sequenceIds.length;
    return result(
      run.finish('completed', `${w.name === 'clipper' ? 'Made' : 'Styled'} ${String(n)} clip(s).`),
    );
  } catch (err) {
    // a stop is RunStopped, or an abort the Stop caused; any other error is a failure
    if (err instanceof RunStopped || (req.signal?.aborted && isAbortError(err)))
      return result(
        run.finish(
          'stopped',
          'Stopped by the user; the edits so far stay (undo the run to remove them).',
        ),
      );
    const e = deps.redactor.redact(
      toVoxErrorJson(
        isVoxError(err)
          ? err
          : new VoxError('TOOL_FAILED', `the ${w.name} workflow failed`, 'See the run record.', {
              cause: err,
            }),
      ),
    );
    return result(run.finish('failed', `${e.message}. ${e.hint}`, e));
  }
}
