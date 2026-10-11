// The agent loop (agent spec "Agent loop", "Error handling"; plan D-15). One `streamText` request per
// model step, tools without `execute`: the loop runs each call itself (repair, aliases, rules,
// pauses), so it controls the step cap, the budget bound before every request, compaction, the
// fresh view and change note before every step, and the run record.
import type { Change, VoxErrorJson } from '@vox/engine';
import { randomBytes } from 'node:crypto';
import {
  generateText,
  Output,
  streamText,
  type ModelMessage,
  type ToolResultPart,
  type ToolSet,
} from 'ai';
import type { z } from 'zod';
import { VoxError, isVoxError, toVoxErrorJson } from '../errors.ts';
import { costFromReported, exceedsBudget, stepUpperBoundUsd } from '../providers/prices.ts';
import { estimateTokens } from '../providers/tool-cost.ts';
import { AliasTable } from '../tools/aliases.ts';
import { VISION_RULE, compactView } from '../tools/read.ts';
import {
  aiToolSet,
  buildRegistry,
  invokeTool,
  surfaceNames,
  toolDefinitionsFor,
  type ToolRegistry,
} from '../tools/registry.ts';
import type {
  TodoItem,
  ToolContext,
  ToolImage,
  ToolOutput,
  VisionDescriber,
} from '../tools/types.ts';
import { COMPACT_AT, Conversation } from './conversation.ts';
import { wrapData } from './envelope.ts';
import { backoffMs, mapProviderError, PROVIDER_RETRIES } from './provider-errors.ts';
import { buildSystemPrompt } from './prompt.ts';
import { RunRecord, truncateJson } from './record.ts';
import { detectTextToolCall, repairToolJson, TEXT_TOOL_CALL_CORRECTION } from './repair.ts';
import type {
  AgentEvent,
  PauseDecision,
  PauseInfo,
  RoleModel,
  RunDeps,
  RunRequest,
  TurnOptions,
  TurnResult,
  Usage,
} from './types.ts';

/** Identical calls in a row: the 2nd runs with a note, the 3rd is not run (pause `error`). */
export const IDENTICAL_NOTE = 'Same as your previous call; the result has not changed.';
/** Invalid arguments: the zod error goes back; after 2 retries the run pauses (`error`). */
export const MAX_ARG_RETRIES = 2;
const MAX_PAUSE_LOOPS = 5;

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function toUsage(u: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  inputTokenDetails?: {
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
  };
  outputTokenDetails?: { reasoningTokens?: number | undefined };
}): Usage {
  const n = (x: number | undefined) =>
    typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : 0;
  return {
    inputTokens: n(u.inputTokens),
    outputTokens: n(u.outputTokens),
    cacheReadTokens: n(u.inputTokenDetails?.cacheReadTokens),
    cacheWriteTokens: n(u.inputTokenDetails?.cacheWriteTokens),
    reasoningTokens: n(u.outputTokenDetails?.reasoningTokens),
  };
}

function reportedCost(pm: unknown): number | undefined {
  const c = (pm as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage
    ?.cost;
  return typeof c === 'number' ? c : undefined;
}

const short = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);

export class RunStopped extends Error {
  constructor() {
    super('run stopped');
    this.name = 'RunStopped';
  }
}

interface ModelCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  /** Set when the SDK could not parse the input: the raw text. */
  rawInput?: string;
  unknownTool?: boolean;
}

interface TurnState {
  lastKey?: string;
  repeats: number;
  argFailures: Map<string, number>;
}

export class AgentRun {
  readonly runId: string;
  readonly aliases: AliasTable;
  readonly registry: ToolRegistry;
  readonly record: RunRecord;
  readonly versions: number[] = [];
  readonly ctx: ToolContext;
  spentUsd = 0;
  #cap: number;
  #noteFrom = 0;
  #step = 0;
  #summaries: string[] = [];
  #todos: TodoItem[] = [];
  #finished = false;
  readonly #deps: RunDeps;
  readonly #req: RunRequest;

  private constructor(deps: RunDeps, req: RunRequest, runId: string, startVersion: number) {
    this.#deps = deps;
    this.#req = req;
    this.runId = runId;
    this.#cap = deps.limits.maxUsdPerRun;
    this.aliases = new AliasTable();
    this.registry = deps.registry ?? buildRegistry(deps.engine);
    this.record = new RunRecord({
      projectsDir: deps.engine.projectsDir,
      projectId: req.projectId,
      runId,
      redactor: deps.redactor,
      ...(deps.now && { now: deps.now }),
    });
    this.#noteFrom = startVersion;
    const vision = this.#visionDescriber();
    this.ctx = {
      engine: deps.engine,
      projectId: req.projectId,
      runId,
      aliases: this.aliases,
      question: req.question === true,
      userSources: new Set([req.message, ...(req.attachments ?? [])]),
      approvedSources: new Set(),
      editorVision: deps.models.editor.vision === true,
      seenVersion: startVersion,
      setTodos: (items) => {
        this.#todos = items;
        this.record.write({ type: 'todos', items });
        this.emit({ type: 'agent.todos', payload: { runId, items } });
      },
      ...(vision && { vision }),
      ...(req.signal && { signal: req.signal }),
    };
  }

  static async start(deps: RunDeps, req: RunRequest): Promise<AgentRun> {
    const p = await deps.engine.getProject(req.projectId);
    const runId = deps.newRunId?.() ?? `run_${randomBytes(9).toString('base64url')}`;
    const run = new AgentRun(deps, req, runId, p.version);
    const models: Record<string, string> = {};
    for (const [role, m] of Object.entries(deps.models)) {
      if (m) models[role] = `${m.provider.label}:${m.modelId}`;
    }
    run.record.write({
      type: 'started',
      runId,
      projectId: req.projectId,
      workflow: req.workflow,
      mode: req.mode,
      models,
      message: req.message,
      attachments: req.attachments ?? [],
      allowedTools: req.allowedTools,
      ...(req.planKind && { planKind: req.planKind }),
      question: req.question === true,
      version: p.version,
    });
    run.emit({
      type: 'agent.started',
      payload: { runId, projectId: req.projectId, workflow: req.workflow, mode: req.mode, models },
    });
    return run;
  }

  get mode() {
    return this.#req.mode;
  }
  get request(): Readonly<RunRequest> {
    return this.#req;
  }
  get deps(): Readonly<RunDeps> {
    return this.#deps;
  }
  get capUsd(): number {
    return this.#cap;
  }

  /** Emits an event through the redactor (S19). */
  emit(event: AgentEvent): void {
    if (!this.#deps.emit) return;
    try {
      this.#deps.emit(this.#deps.redactor.redact(event));
    } catch {
      // a listener bug never breaks the run
    }
  }

  /** Records the pause, emits `agent.paused` and waits for the decision (default: stop). */
  async pause(p: Omit<PauseInfo, 'runId'>): Promise<PauseDecision> {
    const info: PauseInfo = { runId: this.runId, ...p };
    // The plan itself stays in the run record; the event carries only the pause.
    const event: Omit<PauseInfo, 'plan'> & { plan?: unknown } = { ...info };
    delete event.plan;
    this.record.write({ type: 'paused', ...info, spentUsd: this.spentUsd });
    this.emit({ type: 'agent.paused', payload: event });
    const decision = this.#deps.onPause
      ? await this.#deps.onPause(info)
      : { action: 'stop' as const };
    this.record.write({ type: 'resumed', decision });
    if (decision.action === 'continue' && decision.maxUsdPerRun !== undefined) {
      this.#cap = decision.maxUsdPerRun;
    }
    return decision;
  }

  /**
   * Budget bound before a request: `spent + input × inPrice + maxOutputTokens × outPrice` must stay
   * within the cap (S23); else the run pauses (`budget`). Throws RunStopped when the user stops.
   */
  async ensureBudget(role: RoleModel, inputTokens: number): Promise<void> {
    for (let i = 0; i < MAX_PAUSE_LOOPS; i++) {
      const bound = stepUpperBoundUsd(role.price, inputTokens, role.maxOutputTokens);
      if (!exceedsBudget(this.spentUsd, bound, this.#cap)) return;
      const d = await this.pause({
        reason: 'budget',
        detail: `The next request could cost up to $${bound.toFixed(4)}; this run has spent $${this.spentUsd.toFixed(4)} of its $${this.#cap.toFixed(2)} cap.`,
      });
      if (d.action === 'stop') throw new RunStopped();
    }
    throw new RunStopped();
  }

  addCost(role: RoleModel, usage: Usage, providerMetadata: unknown): number {
    const usd = costFromReported(reportedCost(providerMetadata), role.price, usage) ?? 0;
    this.spentUsd += usd;
    return usd;
  }

  #visionDescriber(): VisionDescriber | undefined {
    const v = this.#deps.models.vision;
    if (!v) return undefined;
    return {
      describe: async (images: readonly ToolImage[], task: string, signal?: AbortSignal) => {
        await this.ensureBudget(v, estimateTokens(VISION_RULE + task) + images.length * 1_600);
        const r = await this.#withRetries(v, () =>
          generateText({
            model: v.model,
            system: VISION_RULE,
            maxRetries: 0,
            maxOutputTokens: v.maxOutputTokens,
            ...(signal && { abortSignal: signal }),
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: `${task}\nImages in order: ${images.map((i) => i.label).join(', ')}.`,
                  },
                  ...images.map((i) => ({
                    type: 'image' as const,
                    image: i.data,
                    mediaType: i.mediaType,
                  })),
                ],
              },
            ],
          }),
        );
        const usage = toUsage(r.usage);
        const usd = this.addCost(v, usage, r.providerMetadata);
        this.record.write({ type: 'vision', usage, costUsd: usd, spentUsd: this.spentUsd });
        return r.text;
      },
    };
  }

  /** Runs a model request with error mapping, backoff on 429/5xx and a pause after 3 tries. */
  async #withRetries<T>(
    role: RoleModel,
    call: () => Promise<T>,
    onOverflow?: () => Promise<boolean>,
  ): Promise<T> {
    let attempt = 0;
    let compacted = false;
    for (;;) {
      try {
        return await call();
      } catch (err) {
        if (err instanceof RunStopped) throw err;
        if (this.#req.signal?.aborted) throw new RunStopped();
        const m = mapProviderError(err, role.provider.label, this.#deps.redactor);
        this.record.write({ type: 'providerError', error: toVoxErrorJson(m.error), attempt });
        if (m.error.code === 'CONTEXT_OVERFLOW' && onOverflow && !compacted) {
          compacted = true;
          await onOverflow();
          continue;
        }
        if (!m.retryable) throw m.error;
        if (attempt < PROVIDER_RETRIES) {
          await (this.#deps.sleep ?? sleepDefault)(backoffMs(attempt, m.retryAfterMs));
          attempt++;
          continue;
        }
        const d = await this.pause({
          reason: 'error',
          detail: `${m.error.message}. ${m.error.hint}`,
        });
        if (d.action === 'stop') throw new RunStopped();
        attempt = 0;
      }
    }
  }

  /** One structured answer from the editor (plan mode), under the same budget and retries. */
  async structured<T>(opts: {
    system: string;
    messages: ModelMessage[];
    schema: z.ZodType<T>;
  }): Promise<{
    value: unknown;
    usage: Usage;
  }> {
    const editor = this.#deps.models.editor;
    await this.ensureBudget(
      editor,
      estimateTokens(opts.system) + estimateTokens(JSON.stringify(opts.messages)),
    );
    const r = await this.#withRetries(editor, async () => {
      try {
        return await generateText({
          model: editor.model,
          system: opts.system,
          messages: opts.messages,
          maxRetries: 0,
          maxOutputTokens: editor.maxOutputTokens,
          output: Output.object({ schema: opts.schema }),
          ...(this.#req.signal && { abortSignal: this.#req.signal }),
        });
      } catch (err) {
        // an answer that does not validate goes back to the model as data, not as a provider error
        const e = err as { name?: string; text?: string; usage?: unknown };
        if (e.name === 'AI_NoObjectGeneratedError')
          return { invalidText: e.text ?? '', usage: e.usage } as const;
        throw err;
      }
    });
    if ('invalidText' in r) {
      const usage = toUsage((r.usage ?? {}) as Parameters<typeof toUsage>[0]);
      this.addCost(editor, usage, undefined);
      const parsed = repairToolJson(r.invalidText ?? '');
      return { value: parsed.ok ? parsed.value : r.invalidText, usage };
    }
    const usage = toUsage(r.usage);
    this.addCost(editor, usage, r.providerMetadata);
    return { value: r.output, usage };
  }

  /** The injected state before a step: the view of each sequence in scope and the change note. */
  async injection(scope: readonly string[]): Promise<{ text: string; version: number }> {
    const parts: string[] = [];
    let version = this.ctx.seenVersion;
    for (const sequenceId of scope) {
      const v = await compactView(this.ctx, sequenceId);
      version = Math.max(version, v.version);
      parts.push(
        `Sequence ${this.aliases.aliasOf(sequenceId)} @v${String(v.version)}: ${JSON.stringify(v.view.items)}${v.captions ? `\nCaptions:\n${v.captions}` : ''}`,
      );
    }
    const note = await this.changeNote();
    if (note) parts.push(note);
    return { text: `[Current state, newest only]\n${parts.join('\n\n')}`, version };
  }

  /** History after the last noted version, by the user or another run (not this run's writes). */
  async changeNote(): Promise<string> {
    const entries = await this.#deps.engine.history(this.#req.projectId, {
      sinceVersion: this.#noteFrom,
    });
    const mine = new Set(this.versions);
    const lines: string[] = [];
    for (const e of entries) {
      this.#noteFrom = Math.max(this.#noteFrom, e.version);
      if ((e.actor === 'agent' && e.runId === this.runId) || mine.has(e.version)) continue;
      const touched = [...new Set(e.changes.map((c) => this.#describeKey(c)))].slice(0, 20);
      const what = e.kind === 'op' ? (e.op ?? 'edit') : e.kind;
      lines.push(`- v${String(e.version)} by ${e.actor}: ${what} → ${touched.join(', ')}`);
    }
    return lines.length === 0
      ? ''
      : `Changes since your last step (not yours; re-read before editing these):\n${lines.join('\n')}`;
  }

  #describeKey(c: Change): string {
    const [kind, rest = ''] = c.key.split(/:(.*)/s, 2) as [string, string?];
    const [seq, sub] = rest.split('/');
    const verb = c.before === null ? 'added ' : c.after === null ? 'removed ' : '';
    switch (kind) {
      case 'item':
        return `${verb}${this.aliases.aliasOf(sub ?? '')}`;
      case 'sequence':
        return `${verb}${this.aliases.aliasOf(seq ?? '')}`;
      case 'media':
        return `${verb}${this.aliases.aliasOf(seq ?? '')}`;
      case 'track':
        return `${verb}track ${sub ?? ''} of ${this.aliases.aliasOf(seq ?? '')}`;
      case 'captions':
        return `captions of ${this.aliases.aliasOf(seq ?? '')}`;
      default:
        return kind;
    }
  }

  systemPrompt(conv?: Conversation): string {
    return buildSystemPrompt({
      mode: this.#req.mode,
      styleGuide: this.#req.styleGuide,
      workflowPrompt: this.#req.workflowPrompt,
      projectSummary: this.#req.projectSummary,
      notes: conv?.notes,
    });
  }

  #summariser(): ((text: string, prev: string) => Promise<string>) | undefined {
    const fast = this.#deps.models.fast;
    if (!fast) return undefined;
    return async (text, prev) => {
      const prompt = `Summarise these earlier agent steps into short notes for the agent itself: what was read (with versions), what was changed (aliases, versions), what is still open. Previous notes:\n${prev || '(none)'}\n\nSteps:\n${wrapData('steps', text)}`;
      await this.ensureBudget(fast, estimateTokens(prompt));
      const r = await this.#withRetries(fast, () =>
        generateText({
          model: fast.model,
          prompt,
          maxRetries: 0,
          maxOutputTokens: fast.maxOutputTokens,
        }),
      );
      this.addCost(fast, toUsage(r.usage), r.providerMetadata);
      return r.text;
    };
  }

  /** A model step of a tools-mode turn: text plus tool calls as the model sent them. */
  async #modelStep(
    system: string,
    messages: ModelMessage[],
    tools: ToolSet,
    onOverflow: () => Promise<boolean>,
    rebuild: () => ModelMessage[],
  ): Promise<{ text: string; calls: ModelCall[]; usage: Usage; costUsd: number }> {
    const editor = this.#deps.models.editor;
    let msgs = messages;
    const r = await this.#withRetries(
      editor,
      async () => {
        let captured: unknown;
        const s = streamText({
          model: editor.model,
          system,
          messages: msgs,
          tools,
          maxRetries: 0,
          maxOutputTokens: editor.maxOutputTokens,
          ...(this.#req.signal && { abortSignal: this.#req.signal }),
          onError: ({ error }) => {
            captured = error;
          },
        });
        try {
          const [content, usage, pm] = await Promise.all([s.content, s.usage, s.providerMetadata]);
          return { content, usage, pm };
        } catch (err) {
          throw captured ?? err;
        }
      },
      async () => {
        const ok = await onOverflow();
        msgs = rebuild();
        return ok;
      },
    );
    let text = '';
    const calls: ModelCall[] = [];
    for (const part of r.content) {
      if (part.type === 'text') text += part.text;
      if (part.type !== 'tool-call') continue;
      const p = part as {
        toolCallId: string;
        toolName: string;
        input: unknown;
        invalid?: boolean;
        error?: { name?: string };
      };
      const call: ModelCall = { toolCallId: p.toolCallId, toolName: p.toolName, input: p.input };
      if (p.invalid && p.error?.name === 'AI_NoSuchToolError') call.unknownTool = true;
      if (p.invalid && typeof p.input === 'string') call.rawInput = p.input;
      calls.push(call);
    }
    const usage = toUsage(r.usage);
    const costUsd = this.addCost(editor, usage, r.pm);
    return { text, calls, usage, costUsd };
  }

  /**
   * One (sub-)run: a fresh conversation (system prompt, the scope's view, the instruction), up to
   * `maxStepsPerRun` model steps. Plan mode hands over to the plan executor.
   */
  async turn(opts: TurnOptions): Promise<TurnResult> {
    if (this.#finished) throw new VoxError('VALIDATION', 'the run has ended', 'Start a new run.');
    if (this.#req.mode === 'plan') {
      const { planTurn } = await import('./plan.ts');
      return planTurn(this, opts);
    }
    const conv = new Conversation();
    const instruction = opts.instruction ?? this.#req.message;
    conv.user(0, instruction);
    const state: TurnState = { repeats: 0, argFailures: new Map() };
    const names = surfaceNames(this.registry, this.#req.allowedTools, {
      mode: 'tools',
      ...(this.#req.question && { question: true }),
    });
    const tools = aiToolSet(this.registry, names);
    const toolTokens = estimateTokens(JSON.stringify(toolDefinitionsFor(this.registry, names)));
    const editor = this.#deps.models.editor;
    const cap = this.#deps.limits.maxStepsPerRun;
    let summary = '';
    try {
      for (let step = 1; step <= cap; step++) {
        if (this.#req.signal?.aborted) throw new RunStopped();
        this.#step++;
        const inj = await this.injection(opts.scope);
        const budget = Math.floor(editor.contextTokens * COMPACT_AT);
        const fixed = () =>
          estimateTokens(this.systemPrompt(conv)) + toolTokens + estimateTokens(inj.text);
        const compactOnce = async (force: boolean) => {
          const r = await conv.compact({
            budgetTokens: budget - fixed(),
            currentStep: step,
            currentVersion: inj.version,
            ...(force && { force: true }),
            ...(this.#summariser() && { summarise: this.#summariser()! }),
          });
          if (r.stubbed + r.summarised > 0)
            this.record.write({ type: 'compacted', step, ...r, force });
          return r.stubbed + r.summarised > 0;
        };
        await compactOnce(false);
        const build = () => withInjection(conv.messages(inj.version), inj.text);
        const messages = build();
        await this.ensureBudget(editor, fixed() + conv.tokens(inj.version));
        const out = await this.#modelStep(
          this.systemPrompt(conv),
          messages,
          tools,
          () => compactOnce(true),
          build,
        );
        summary = out.text.trim() || summary;
        this.record.write({
          type: 'step',
          step,
          ...(opts.subRun !== undefined && { subRun: opts.subRun }),
          scope: opts.scope,
          text: out.text,
          calls: out.calls,
          usage: out.usage,
          costUsd: out.costUsd,
          spentUsd: this.spentUsd,
        });
        this.emit({
          type: 'agent.step',
          payload: {
            runId: this.runId,
            step,
            ...(opts.subRun !== undefined && { subRun: opts.subRun }),
            scope: opts.scope,
            summary: short(out.text.trim()),
            usage: out.usage,
            costUsd: out.costUsd,
          },
        });
        conv.assistant(step, {
          role: 'assistant',
          content: [
            ...(out.text ? [{ type: 'text' as const, text: out.text }] : []),
            ...out.calls.map((c) => ({
              type: 'tool-call' as const,
              toolCallId: c.toolCallId,
              toolName: c.toolName,
              input: c.rawInput === undefined ? c.input : repairedOrEmpty(c.rawInput),
            })),
          ],
        });
        if (out.calls.length === 0) {
          if (detectTextToolCall(out.text, names)) {
            conv.user(step, TEXT_TOOL_CALL_CORRECTION);
            this.record.write({ type: 'correction', step });
            continue;
          }
          return this.#endTurn(opts, {
            status: 'completed',
            summary: summary || 'Done.',
            steps: step,
          });
        }
        const parts: ToolResultPart[] = [];
        const meta = new Map<string, { label: string; version: number }>();
        for (const call of out.calls) {
          const res = await this.#runCall(call, state, opts);
          parts.push(res.part);
          meta.set(call.toolCallId, res.meta);
          if (res.stop) {
            conv.toolResults(step, parts, meta);
            return this.#endTurn(opts, {
              status: 'stopped',
              summary: 'Stopped by the user.',
              steps: step,
            });
          }
        }
        conv.toolResults(step, parts, meta);
      }
      const open = this.#todos.filter((t) => t.status !== 'done').map((t) => t.text);
      return this.#endTurn(opts, {
        status: 'capped',
        summary: `Stopped at the step cap (${String(cap)} steps).${open.length > 0 ? ` Still open: ${open.join('; ')}.` : ''}${summary ? ` Last note: ${short(summary)}` : ''}`,
        steps: cap,
      });
    } catch (err) {
      if (err instanceof RunStopped) {
        return this.#endTurn(opts, {
          status: 'stopped',
          summary: 'Stopped by the user.',
          steps: this.#step,
        });
      }
      const e = isVoxError(err)
        ? this.#deps.redactor.redact(toVoxErrorJson(err))
        : this.#deps.redactor.redact(
            toVoxErrorJson(
              new VoxError('TOOL_FAILED', 'the agent loop failed', 'See the run record.', {
                cause: err,
              }),
            ),
          );
      return this.#endTurn(opts, {
        status: 'failed',
        summary: `${e.message}. ${e.hint}`,
        steps: this.#step,
        error: e,
      });
    }
  }

  #endTurn(opts: TurnOptions, r: TurnResult): TurnResult {
    if (opts.subRun !== undefined) {
      this.#summaries.push(
        `Sub-run ${String(opts.subRun)} (${opts.scope.map((s) => this.aliases.aliasOf(s)).join(', ')}): ${r.status}. ${r.summary}`,
      );
      this.record.write({ type: 'subRun', subRun: opts.subRun, scope: opts.scope, ...r });
    }
    this.record.write({ type: 'aliases', table: this.aliases.snapshot() });
    return r;
  }

  /** Runs one tool call under the loop's rules; never throws for tool errors (they go back as data). */
  async #runCall(
    call: ModelCall,
    state: TurnState,
    opts: TurnOptions,
  ): Promise<{ part: ToolResultPart; meta: { label: string; version: number }; stop?: boolean }> {
    const meta = { label: `${call.toolName} result`, version: this.ctx.seenVersion };
    const done = (output: ToolResultPart['output'], extra: Partial<{ stop: boolean }> = {}) => ({
      part: {
        type: 'tool-result' as const,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output,
      },
      meta,
      ...extra,
    });
    const fail = (e: VoxError | VoxErrorJson, args: unknown) => {
      const j = isVoxError(e) ? toVoxErrorJson(e) : e;
      const err = this.#deps.redactor.redact({ code: j.code, message: j.message, hint: j.hint });
      this.record.write({
        type: 'tool',
        callId: call.toolCallId,
        tool: call.toolName,
        args: truncateJson(args),
        error: err,
      });
      this.emit({
        type: 'agent.tool',
        payload: {
          runId: this.runId,
          callId: call.toolCallId,
          tool: call.toolName,
          args: truncateJson(args, 512),
          status: 'failed',
          resultSummary: `${err.code}: ${short(err.message, 120)}`,
        },
      });
      return done({ type: 'error-text', value: JSON.stringify({ error: err }) });
    };

    let args: unknown = call.input;
    this.emit({
      type: 'agent.tool',
      payload: {
        runId: this.runId,
        callId: call.toolCallId,
        tool: call.toolName,
        args: truncateJson(call.rawInput ?? args, 512),
        status: 'started',
      },
    });
    if (call.unknownTool) {
      const known = this.registry.get(call.toolName) !== undefined;
      return fail(
        new VoxError(
          known ? 'TOOL_REFUSED' : 'TOOL_UNKNOWN',
          known
            ? `${call.toolName} is not in your tool list`
            : `${JSON.stringify(call.toolName)} is not a tool`,
          known
            ? `Run it through call_tool { name: "${call.toolName}", args }.`
            : 'Use describe_tool or one of your tools.',
        ),
        call.input,
      );
    }
    if (call.rawInput !== undefined) {
      const r = repairToolJson(call.rawInput);
      if (!r.ok) {
        return this.#argFailure(
          call,
          state,
          fail(
            new VoxError(
              'VALIDATION',
              `${call.toolName}: arguments are not valid JSON (${r.error})`,
              'Send one complete JSON object.',
            ),
            call.rawInput,
          ),
        );
      }
      args = r.value;
      if (r.repaired)
        this.record.write({ type: 'repaired', callId: call.toolCallId, tool: call.toolName });
    }

    // identical call in a row (same tool, same arguments after alias resolution)
    let resolved: unknown = args;
    try {
      resolved = this.aliases.fromModel(args);
    } catch {
      // an unknown alias is reported by the tool call itself
    }
    const key = `${call.toolName}:${stable(resolved)}`;
    state.repeats = state.lastKey === key ? state.repeats + 1 : 1;
    state.lastKey = key;
    if (state.repeats >= 3) {
      const d = await this.pause({
        reason: 'error',
        detail: `The agent called ${call.toolName} with the same arguments 3 times in a row; the call was not run.`,
      });
      state.repeats = 0;
      state.lastKey = undefined;
      const err = new VoxError(
        'TOOL_REFUSED',
        `${call.toolName} was not run: identical call 3 times in a row`,
        'Do something different or finish.',
      );
      const r = fail(err, args);
      return d.action === 'stop' ? { ...r, stop: true } : r;
    }

    let output: ToolOutput;
    try {
      output = await invokeTool(this.ctx, this.registry, call.toolName, args);
      for (let i = 0; output.pause && i < MAX_PAUSE_LOOPS; i++) {
        const d = await this.pause({
          reason: output.pause.reason,
          kind: output.pause.kind,
          detail: output.pause.detail,
          sources: output.pause.sources,
        });
        if (d.action === 'stop') {
          const r = fail(
            new VoxError(
              'TOOL_REFUSED',
              `${call.toolName}: the user stopped the run`,
              'Nothing was ingested.',
            ),
            args,
          );
          return { ...r, stop: true };
        }
        for (const s of output.pause.sources) this.ctx.approvedSources.add(s);
        output = await invokeTool(this.ctx, this.registry, call.toolName, args);
      }
    } catch (err) {
      if (err instanceof RunStopped) throw err;
      if (isVoxError(err)) {
        const r = fail(err, args);
        return err.code === 'VALIDATION' ? this.#argFailure(call, state, r) : r;
      }
      return fail(
        new VoxError(
          'TOOL_FAILED',
          `${call.toolName} failed`,
          'Try another way; the error is in the run record.',
          { cause: err },
        ),
        args,
      );
    }
    state.argFailures.delete(call.toolName);
    if (output.read) {
      meta.label = output.read.label;
      meta.version = output.read.version;
    } else meta.version = this.ctx.seenVersion;
    if (output.versions) this.versions.push(...output.versions);
    let text = JSON.stringify(output.result) ?? 'null';
    if (output.untrusted) text = wrapData(output.untrusted, text);
    if (state.repeats === 2) text = `${IDENTICAL_NOTE}\n${text}`;
    this.record.write({
      type: 'tool',
      callId: call.toolCallId,
      tool: call.toolName,
      args: truncateJson(args),
      result: truncateJson(output.result),
      ...(output.versions && { versions: output.versions }),
      ...(output.changes && { changes: truncateJson(output.changes) }),
      ...(opts.subRun !== undefined && { subRun: opts.subRun }),
    });
    this.emit({
      type: 'agent.tool',
      payload: {
        runId: this.runId,
        callId: call.toolCallId,
        tool: call.toolName,
        args: truncateJson(args, 512),
        status: 'done',
        resultSummary: short(JSON.stringify(output.result) ?? '', 160),
        ...(output.versions && { versions: output.versions }),
      },
    });
    if (output.images && output.images.length > 0) {
      return done({
        type: 'content',
        value: [
          { type: 'text', text },
          ...output.images.map((i) => ({
            type: 'file' as const,
            data: { type: 'data' as const, data: i.data },
            mediaType: i.mediaType,
          })),
        ],
      });
    }
    return done({ type: 'text', value: text });
  }

  async #argFailure<R extends { part: ToolResultPart }>(
    call: ModelCall,
    state: TurnState,
    r: R,
  ): Promise<R & { stop?: boolean }> {
    const n = (state.argFailures.get(call.toolName) ?? 0) + 1;
    state.argFailures.set(call.toolName, n);
    if (n <= MAX_ARG_RETRIES) return r;
    state.argFailures.delete(call.toolName);
    const d = await this.pause({
      reason: 'error',
      detail: `The agent sent invalid arguments to ${call.toolName} ${String(n)} times in a row.`,
    });
    return d.action === 'stop' ? { ...r, stop: true } : r;
  }

  /** Ends the run: the `done` line (with sub-run summaries) and `agent.done`. */
  finish(status: 'completed' | 'stopped' | 'failed', summary: string, error?: VoxErrorJson) {
    if (this.#finished)
      throw new VoxError('VALIDATION', 'the run has already ended', 'Start a new run.');
    this.#finished = true;
    const full = [summary, ...this.#summaries].filter((s) => s.trim() !== '').join('\n');
    const payload = {
      runId: this.runId,
      status,
      summary: full,
      costUsd: Number(this.spentUsd.toFixed(6)),
      versions: [...new Set(this.versions)].sort((a, b) => a - b),
      ...(error && { error }),
    };
    this.record.write({
      type: 'done',
      ...payload,
      todos: this.#todos,
      aliases: this.aliases.snapshot(),
    });
    this.emit({ type: 'agent.done', payload });
    return payload;
  }
}

function repairedOrEmpty(raw: string): unknown {
  const r = repairToolJson(raw);
  return r.ok && r.value !== null && typeof r.value === 'object' ? r.value : {};
}

/** The injection goes after the conversation; only the newest one is ever sent. */
export function withInjection(messages: ModelMessage[], text: string): ModelMessage[] {
  const last = messages.at(-1);
  if (last?.role === 'user') {
    const content =
      typeof last.content === 'string'
        ? [{ type: 'text' as const, text: last.content }]
        : last.content;
    return [
      ...messages.slice(0, -1),
      { role: 'user', content: [...content, { type: 'text', text }] },
    ];
  }
  return [...messages, { role: 'user', content: text }];
}

/** Start, one turn on `scope`, finish. */
export async function runAgent(deps: RunDeps, req: RunRequest & { scope: string[] }) {
  const run = await AgentRun.start(deps, req);
  const r = await run.turn({ scope: req.scope });
  const status =
    r.status === 'completed' ? 'completed' : r.status === 'failed' ? 'failed' : 'stopped';
  return { run, turn: r, done: run.finish(status, r.summary, r.error) };
}
