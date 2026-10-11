// The agent in the engine host (app spec "Engine-host API" → Agent; agent spec "Agent loop"; plan
// phase 13, D-15). `agent.run` starts a workflow run in the background and returns its runId; the
// loop's events go to the renderer as `agent.event` (and `agent.todos`), already redacted by the run.
// A pause waits here until `agent.decide` (or `agent.stop`) answers it; the `agent.paused` event the
// renderer gets carries the whole pause (the ClipPlan of a `plan` pause, the ranges of a `pauses`
// pause, the raised cap of a `budget` pause). `agent.runs` builds the activity log from the run
// records (`runs/<runId>.jsonl`) plus the run's history entries; on the first read of a project in
// this host it closes runs left unfinished when the app quit (restart rule, D-15).
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildEmbedder,
  buildRunModels,
  CLIPPER_DEFAULTS,
  closeUnfinishedRuns,
  costFromReported,
  createLlmScorer,
  exceedsBudget,
  createLanguageModel,
  loadAgentConfig,
  readRunRecord,
  runRecordPath,
  runsDir,
  runWorkflow,
  RUN_ID,
  RunStopped,
  stepUpperBoundUsd,
  sourceIn,
  type AgentConfigDeps,
  type AgentEvent,
  type AgentMode,
  type AppleModelOptions,
  type PauseDecision,
  type PauseInfo,
  type RunDeps,
  type RunModels,
  type WorkflowName,
  type WorkflowRequest,
} from '@vox/agent';
import { VoxError, type Engine, type HistoryEntry, type QuickClipScorer } from '@vox/engine';
import type { AgentPauseData, AgentRunData, EventName, MethodArgs } from '../shared/api.ts';

type RunArgs = MethodArgs<'agent.run'>[0];
type Decision = MethodArgs<'agent.decide'>[1];

export interface AgentHostDeps {
  engine: Engine;
  cfg: AgentConfigDeps;
  apple?: AppleModelOptions;
  fetch?: typeof fetch;
  emit: (name: EventName, payload: unknown) => void;
  /** The run's role models (default: the config roles). Test builds: scripted models. */
  models?: () => Promise<{ models: Partial<RunModels>; mode?: AgentMode }>;
  /** Engine jobs for the run (test builds: seeded analysis jobs). */
  runJob?: RunDeps['runJob'];
  newRunId?: () => string;
}

interface Active {
  projectId: string;
  abort: AbortController;
  pending?: { info: AgentPauseData; resolve: (d: PauseDecision) => void };
  done: Promise<void>;
}

/** "make 3 clips …" → 3 (1–20). */
export function countIn(message: string): number | undefined {
  const m = /\b(\d{1,2})\s+(?:[a-z-]+\s+){0,2}(?:clips?|shorts?|reels?)\b/i.exec(message);
  const n = m ? Number(m[1]) : undefined;
  return n !== undefined && n >= 1 && n <= 20 ? n : undefined;
}

/** "… of 30-60 s" / "4–8 seconds" → [ms, ms]; the clip length the message asks for. */
export function lengthIn(message: string): [number, number] | undefined {
  const m = /\b(\d{1,3})\s*(?:-|–|to)\s*(\d{1,3})\s*(?:s|sec|secs|seconds)\b/i.exec(message);
  if (!m) return undefined;
  const a = Number(m[1]) * 1000;
  const b = Number(m[2]) * 1000;
  return a >= 1000 && b > a ? [a, b] : undefined;
}

const notFound = (runId: string) =>
  new VoxError('VALIDATION', `no run ${runId} in this session`, 'Open the run’s project first.');

export class AgentHost {
  readonly #d: AgentHostDeps;
  readonly #active = new Map<string, Active>();
  readonly #projectOf = new Map<string, string>();
  /** Projects whose unfinished runs were closed in this host (once per project). */
  readonly #closed = new Set<string>();

  constructor(deps: AgentHostDeps) {
    this.#d = deps;
  }

  async #models(): Promise<{ models: Partial<RunModels>; mode?: AgentMode }> {
    if (this.#d.models) return this.#d.models();
    const cfg = this.#d.cfg;
    const conf = await loadAgentConfig(cfg);
    return buildRunModels(conf, cfg, {
      createModel: (entry, modelId, apiKey) =>
        createLanguageModel(entry, modelId, {
          apiKey,
          ...(this.#d.fetch !== undefined && { fetch: this.#d.fetch }),
          ...(this.#d.apple !== undefined && { apple: this.#d.apple }),
        }),
      ...(this.#d.fetch !== undefined && { fetch: this.#d.fetch }),
      ...(this.#d.apple !== undefined && { apple: this.#d.apple }),
    });
  }

  /** Starts a run; resolves with its runId once it started (errors before the start reject). */
  async run(a: RunArgs): Promise<{ runId: string; workflow: WorkflowName; mode: AgentMode }> {
    const engine = this.#d.engine;
    const project = await engine.getProject(a.projectId);
    const seqIds = a.selection.filter((id) => id.startsWith('seq_'));
    const itemIds = a.selection.filter((id) => !id.startsWith('seq_'));
    const attachments = (a.attachments ?? []).filter((id) =>
      project.media.some((m) => m.id === id),
    );
    const source = sourceIn(a.message);
    const mediaOf = (id: string) => project.media.find((m) => m.id === id);
    // 14b: an attached screenplay document and the footage attached with it
    const attachedDoc = attachments.find((id) => mediaOf(id)?.kind === 'document');
    const attachedVideos = attachments.filter((id) => mediaOf(id)?.kind === 'video');
    const workflow: WorkflowName =
      (a.workflow as WorkflowName | undefined) ??
      (attachedDoc !== undefined && /\b(screenplay|script|scenes?)\b/i.test(a.message)
        ? 'screenplay'
        : source !== undefined || (attachments.length > 0 && /\bclips?\b/i.test(a.message))
          ? 'clipper'
          : 'edit');
    const built = await this.#models();
    if (!built.models.editor) {
      throw new VoxError(
        'ROLE_MISSING',
        'no editor model is set',
        'Open Settings, add a provider, press Test on a model and use it as the editor.',
        { details: { role: 'editor' } },
      );
    }
    const mode: AgentMode = (a.mode as AgentMode | undefined) ?? built.mode ?? 'tools';
    const runId = this.#d.newRunId?.() ?? `run_${randomBytes(9).toString('base64url')}`;
    const abort = new AbortController();
    const conf = await loadAgentConfig(this.#d.cfg);
    // screenplay match: the `embed` role, when one is set and usable (else the workflow ranks with the language model)
    const embed =
      workflow === 'screenplay' && !this.#d.models
        ? await buildEmbedder(
            conf,
            this.#d.cfg,
            this.#d.fetch !== undefined ? { fetch: this.#d.fetch } : {},
          ).catch(() => undefined)
        : undefined;
    const len = lengthIn(a.message);
    const attachedVideo = attachments.find((id) =>
      /\.(mp4|mov|m4v|webm|mkv)$/i.test(project.media.find((m) => m.id === id)?.path ?? ''),
    );
    const req: WorkflowRequest = {
      projectId: a.projectId,
      workflow,
      message: a.message,
      mode,
      signal: abort.signal,
      ...(a.confirmPlan === true && { confirmPlan: true }),
      ...(workflow === 'clipper' && {
        count: countIn(a.message) ?? CLIPPER_DEFAULTS.count,
        ...(len && { minMs: len[0], maxMs: len[1] }),
        ...(source === undefined && attachedVideo !== undefined && { mediaId: attachedVideo }),
        tighten: 'ask' as const,
      }),
      ...(workflow === 'stylize' && { sequenceIds: seqIds }),
      ...(workflow === 'screenplay' && {
        ...(attachedDoc !== undefined && { screenplay: attachedDoc }),
        ...(attachedVideos.length > 0 && { mediaIds: attachedVideos }),
      }),
      ...(workflow === 'edit' &&
        seqIds[0] !== undefined && {
          selection: { sequenceId: seqIds[0], ...(itemIds.length > 0 && { itemIds }) },
        }),
    };
    const entry: Active = { projectId: a.projectId, abort, done: Promise.resolve() };
    this.#active.set(runId, entry);
    this.#projectOf.set(runId, a.projectId);
    const started = new Promise<void>((resolve) => {
      entry.done = runWorkflow(
        {
          engine,
          redactor: engine.redactor,
          models: built.models,
          limits: conf.limits,
          newRunId: () => runId,
          emit: (e) => {
            if (e.type === 'agent.started') resolve();
            // the host sends its own `agent.paused` with the whole pause (below)
            if (e.type === 'agent.paused') return;
            this.#emit(e);
          },
          onPause: (info) => this.#pause(runId, info, conf.limits.maxUsdPerRun),
          ...(this.#d.runJob && { runJob: this.#d.runJob }),
          ...(embed && { embed }),
        },
        req,
      )
        .then((r) => {
          r.run.record.write({
            type: 'report',
            sequenceIds: r.sequenceIds,
            clips: r.clips,
            checkpoints: r.checkpoints,
          });
          this.#d.emit('agent.event', {
            type: 'agent.report',
            payload: { runId, sequenceIds: r.sequenceIds },
          });
        })
        .catch((err: unknown) => {
          // runWorkflow ends a started run itself; this is an error before the start
          this.#d.emit('agent.event', {
            type: 'agent.done',
            payload: {
              runId,
              status: 'failed',
              summary: err instanceof Error ? err.message : String(err),
              costUsd: 0,
              versions: [],
              error: engine.redactor.redact(
                err instanceof VoxError
                  ? { code: err.code, message: err.message, hint: err.hint }
                  : { code: 'INTERNAL', message: String(err), hint: 'See the log.' },
              ),
            },
          });
          resolve();
        })
        .finally(() => {
          this.#active.delete(runId);
        });
    });
    await started;
    return { runId, workflow, mode };
  }

  #emit(e: AgentEvent): void {
    this.#d.emit('agent.event', e);
    if (e.type === 'agent.todos') this.#d.emit('agent.todos', e.payload);
  }

  #pause(runId: string, info: PauseInfo, baseCap: number): Promise<PauseDecision> {
    const a = this.#active.get(runId);
    if (!a || a.abort.signal.aborted) return Promise.resolve({ action: 'stop' });
    const spentLine = /spent \$([0-9.]+) of its \$([0-9.]+) cap/.exec(info.detail);
    const cap = spentLine ? Number(spentLine[2]) : baseCap;
    const data: AgentPauseData = this.#d.engine.redactor.redact({
      runId,
      reason: info.reason,
      ...(info.kind !== undefined && { kind: info.kind }),
      detail: info.detail,
      ...(info.sources && { sources: info.sources }),
      ...(info.ranges && { ranges: info.ranges }),
      ...(info.sequenceId !== undefined && { sequenceId: info.sequenceId }),
      ...(info.plan !== undefined && { plan: info.plan }),
      // "Continue with $X": one more default budget on top of the current cap
      ...(info.reason === 'budget' && { continueUsd: Number((cap + baseCap).toFixed(2)) }),
    });
    return new Promise<PauseDecision>((resolve) => {
      a.pending = {
        info: data,
        resolve: (d) => {
          delete a.pending;
          resolve(d);
        },
      };
      this.#d.emit('agent.event', { type: 'agent.paused', payload: data });
    });
  }

  async decide(runId: string, d: Decision): Promise<{ ok: true }> {
    const a = this.#active.get(runId);
    const p = a?.pending;
    if (!a || !p) {
      throw new VoxError(
        'VALIDATION',
        `run ${runId} is not waiting for a decision`,
        'The run already went on or ended; refresh the agent panel.',
      );
    }
    const approve = 'approve' in d ? d.approve : d.choice === 'continue';
    if (!approve) {
      p.resolve({ action: 'stop' });
      return { ok: true };
    }
    if (p.info.kind === 'pauses' && 'wordKeys' in d && d.wordKeys !== undefined) {
      const known = new Set((p.info.ranges ?? []).map((r) => r.wordKey));
      p.resolve({ action: 'continue', wordKeys: d.wordKeys.filter((k) => known.has(k)) });
    } else if (p.info.reason === 'budget' && p.info.continueUsd !== undefined) {
      p.resolve({ action: 'continue', maxUsdPerRun: p.info.continueUsd });
    } else p.resolve({ action: 'continue' });
    return { ok: true };
  }

  async stop(runId: string): Promise<{ ok: true }> {
    const a = this.#active.get(runId);
    if (!a) throw notFound(runId);
    a.abort.abort();
    a.pending?.resolve({ action: 'stop' });
    return { ok: true };
  }

  async undoRun(runId: string): Promise<unknown> {
    if (!RUN_ID.test(runId)) throw notFound(runId);
    const projectId = this.#projectOf.get(runId);
    if (projectId === undefined) throw notFound(runId);
    if (this.#active.has(runId)) {
      throw new VoxError(
        'VALIDATION',
        'the run is still going',
        'Stop the run first, then undo it.',
      );
    }
    return this.#d.engine.undoRun(projectId, runId, { actor: 'user' });
  }

  /**
   * The quick-clips LLM scorer: the `fast` model of Settings under the per-run cap (one "run" per
   * Make clips). None without a fast model. Over the cap the scorer stops and the engine's heuristic
   * picks the rest (the engine falls back on any scorer error).
   */
  async quickScorer(): Promise<QuickClipScorer | undefined> {
    const built = await this.#models().catch(() => undefined);
    const fast = built?.models.fast;
    if (!fast) return undefined;
    const cap = (await loadAgentConfig(this.#d.cfg)).limits.maxUsdPerRun;
    let spent = 0;
    const host: Parameters<typeof createLlmScorer>[0] = {
      ensureBudget: (role, inputTokens) =>
        exceedsBudget(spent, stepUpperBoundUsd(role.price, inputTokens, role.maxOutputTokens), cap)
          ? Promise.reject(new RunStopped())
          : Promise.resolve(),
      addCost: (role, usage, meta) => {
        const reported = (meta as { openrouter?: { usage?: { cost?: unknown } } } | undefined)
          ?.openrouter?.usage?.cost;
        const usd =
          costFromReported(typeof reported === 'number' ? reported : null, role.price, usage) ?? 0;
        spent += usd;
        return usd;
      },
      record: { write: () => undefined },
    };
    return createLlmScorer(host, fast);
  }

  /** Waits for every active run (tests, quit). */
  async idle(): Promise<void> {
    await Promise.all([...this.#active.values()].map((a) => a.done));
  }

  /** The activity log of every run in the project, oldest first. */
  async runs(projectId: string): Promise<AgentRunData[]> {
    const engine = this.#d.engine;
    await engine.getProject(projectId); // validates the id, and that the project exists
    const busy = [...this.#active.values()].some((a) => a.projectId === projectId);
    if (!busy && !this.#closed.has(projectId)) {
      this.#closed.add(projectId);
      closeUnfinishedRuns({
        projectsDir: engine.projectsDir,
        projectId,
        redactor: engine.redactor,
      });
    }
    const dir = runsDir(engine.projectsDir, projectId);
    if (!existsSync(dir)) return [];
    const history = (await engine.history(projectId, {})) as HistoryEntry[];
    const out: AgentRunData[] = [];
    for (const f of readdirSync(dir)) {
      const runId = f.replace(/\.jsonl$/, '');
      if (!f.endsWith('.jsonl') || !RUN_ID.test(runId)) continue;
      this.#projectOf.set(runId, projectId);
      const lines = readRunRecord(runRecordPath(engine.projectsDir, projectId, runId));
      const data = runData(runId, projectId, lines, history);
      if (!data) continue;
      const a = this.#active.get(runId);
      if (a && data.status !== 'completed' && data.status !== 'failed') {
        data.status = a.pending ? 'paused' : 'running';
        if (a.pending) data.pause = a.pending.info;
      }
      out.push(data);
    }
    return out.sort((x, y) => x.startedAt.localeCompare(y.startedAt));
  }
}

type Line = { type: string; ts?: string } & Record<string, unknown>;

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** One run's activity log from its record lines and its history entries. */
export function runData(
  runId: string,
  projectId: string,
  lines: readonly Line[],
  history: readonly HistoryEntry[],
): AgentRunData | null {
  const started = lines.find((l) => l.type === 'started');
  if (!started) return null;
  const done = [...lines].reverse().find((l) => l.type === 'done');
  const report = [...lines].reverse().find((l) => l.type === 'report');
  let spent = 0;
  let todos: AgentRunData['todos'] = [];
  let scope: string[] = [];
  const steps: AgentRunData['steps'] = [];
  const tools: AgentRunData['tools'] = [];
  let notes: string[] = [];
  for (const l of lines) {
    if (l.type === 'changeNote' && Array.isArray(l['lines']))
      notes = [...notes, ...(l['lines'] as unknown[]).map((x) => str(x))].slice(0, 20);
    if (typeof l['spentUsd'] === 'number') spent = Math.max(spent, l['spentUsd']);
    if (l.type === 'todos' && Array.isArray(l['items']))
      todos = l['items'] as AgentRunData['todos'];
    if (l.type === 'step') {
      scope = Array.isArray(l['scope']) ? (l['scope'] as string[]) : scope;
      steps.push({
        step: num(l['step']),
        ...(typeof l['subRun'] === 'number' && { subRun: l['subRun'] }),
        scope,
        text: str(l['text']).slice(0, 2_000),
        ...(notes.length > 0 && { notes }),
      });
      notes = [];
    }
    if (l.type === 'tool') {
      tools.push({
        tool: str(l['tool']),
        status: l['error'] ? 'failed' : 'done',
        ...(l['by'] === 'workflow' && { byWorkflow: true }),
        ...(l['error'] !== undefined && {
          error: str((l['error'] as { message?: unknown }).message),
        }),
      });
    }
  }
  // the run's own entries that are still in effect (a coalesced entry is replaced by its newer one)
  const replaced = new Set(history.flatMap((h) => (h.replaces !== undefined ? [h.replaces] : [])));
  const undone = new Set(history.filter((h) => h.kind === 'undo').flatMap((h) => h.targets ?? []));
  const changes: AgentRunData['changes'] = history
    .filter((h) => h.runId === runId && h.kind === 'op' && !replaced.has(h.version))
    .map((h) => {
      const itemIds: string[] = [];
      const sequenceIds = new Set<string>();
      for (const c of h.changes) {
        if (c.key.startsWith('item:')) {
          const rest = c.key.slice(5);
          const i = rest.indexOf('/');
          sequenceIds.add(rest.slice(0, i));
          itemIds.push(rest.slice(i + 1));
        } else if (c.key.startsWith('sequence:')) sequenceIds.add(c.key.slice(9));
      }
      return {
        version: h.version,
        op: str(h.op, h.jobId ? 'job' : 'edit'),
        itemIds: [...new Set(itemIds)],
        sequenceIds: [...sequenceIds],
        undone: undone.has(h.version),
      };
    });
  const clips = Array.isArray(report?.['clips']) ? (report['clips'] as AgentRunData['clips']) : [];
  const status = done ? (str(done['status'], 'stopped') as AgentRunData['status']) : 'running';
  return {
    runId,
    projectId,
    workflow: str(started['workflow']),
    mode: str(started['mode'], 'tools') as AgentMode,
    message: str(started['message']),
    models: (started['models'] as Record<string, string> | undefined) ?? {},
    startedAt: str(started.ts),
    status,
    summary: done ? str(done['summary']) : '',
    costUsd: done ? num(done['costUsd'], spent) : spent,
    steps,
    tools,
    todos,
    scope,
    changes,
    clips,
    sequenceIds: Array.isArray(report?.['sequenceIds']) ? (report['sequenceIds'] as string[]) : [],
    ...(done?.['error'] !== undefined && { error: done['error'] as AgentRunData['error'] }),
  };
}

/** Run ids in a project folder (tests). */
export function runIds(projectsDir: string, projectId: string): string[] {
  const dir = runsDir(projectsDir, projectId);
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => join(f).replace(/\.jsonl$/, ''))
    : [];
}
