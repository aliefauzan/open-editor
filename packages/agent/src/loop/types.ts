// Loop contracts: models per role, run dependencies, pauses and `agent.*` events (agent spec
// "Agent loop" → "Events"; plan D-15).
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { Redactor, TemplateLookup, VoxErrorJson } from '@vox/engine';
import type { PriceEntry, ProviderKind } from '../providers/prices.ts';
import type { AgentMode } from '../providers/roles.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { AgentEngine, TodoItem } from '../tools/types.ts';

export interface RoleModel {
  model: LanguageModelV4;
  provider: ProviderKind & { label: string };
  modelId: string;
  /** Effective context in tokens (probe). */
  contextTokens: number;
  /** Local providers: `{ free: true }`. A paid model without a price never gets a role. */
  price: PriceEntry;
  /** Per-role default (editor 8,000, vision 2,000, fast 2,000). */
  maxOutputTokens: number;
  /** The model takes images (vision probe passed). */
  vision?: boolean;
}

export interface RunModels {
  editor: RoleModel;
  vision?: RoleModel;
  fast?: RoleModel;
}

export type PauseReason = 'budget' | 'approval' | 'error';
export type PauseKind = 'source' | 'plan' | 'pauses';

export interface PauseInfo {
  runId: string;
  reason: PauseReason;
  kind?: PauseKind;
  detail: string;
  sources?: string[];
  ranges?: TightenRange[];
  /** A `pauses` pause: the sequence the ranges belong to (the app seeks in it). */
  sequenceId?: string;
  plan?: unknown;
}

/** A tighten range offered for review (`approval`, kind `pauses`; agent spec "Clipper"). */
export interface TightenRange {
  wordKey: string;
  kind: 'pause' | 'filler' | 'repeat';
  seqStartMs: number;
  seqEndMs: number;
  text: string;
}

/**
 * `continue` resumes the run. On a `pauses` pause, `wordKeys` lists the ticked ranges (absent: the
 * whole list; empty: skip the step).
 */
export type PauseDecision =
  { action: 'continue'; maxUsdPerRun?: number; wordKeys?: string[] } | { action: 'stop' };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export type AgentEvent =
  | {
      type: 'agent.started';
      payload: {
        runId: string;
        projectId: string;
        workflow: string;
        mode: AgentMode;
        models: Record<string, string>;
      };
    }
  | {
      type: 'agent.step';
      payload: {
        runId: string;
        step: number;
        subRun?: number;
        scope: string[];
        summary: string;
        usage: Usage;
        costUsd: number;
      };
    }
  | {
      type: 'agent.tool';
      payload: {
        runId: string;
        callId: string;
        tool: string;
        args: unknown;
        status: 'started' | 'done' | 'failed';
        resultSummary?: string;
        versions?: number[];
      };
    }
  | { type: 'agent.todos'; payload: { runId: string; items: TodoItem[] } }
  | { type: 'agent.paused'; payload: Omit<PauseInfo, 'plan'> }
  | {
      type: 'agent.done';
      payload: {
        runId: string;
        status: 'completed' | 'stopped' | 'failed';
        summary: string;
        costUsd: number;
        versions: number[];
        error?: VoxErrorJson;
      };
    };

export interface RunDeps {
  engine: AgentEngine;
  redactor: Redactor;
  models: RunModels;
  limits: { maxUsdPerRun: number; maxStepsPerRun: number };
  emit?: (event: AgentEvent) => void;
  /** Called on every pause; the run waits for the decision. Default: stop. */
  onPause?: (pause: PauseInfo) => Promise<PauseDecision>;
  /** Template lookup for plan mode (default: the project style's templates). */
  templates?: TemplateLookup;
  registry?: ToolRegistry;
  /** Runs an engine job (tests: fakes for the Python jobs); default: the engine job runner. */
  runJob?: (kind: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  /** Reads a still the engine wrote (tests). */
  readImage?: (path: string) => Promise<Uint8Array>;
  sleep?: (ms: number) => Promise<void>;
  newRunId?: () => string;
  now?: () => Date;
}

export interface RunRequest {
  projectId: string;
  workflow: string;
  /** The user's message (its sources count for the ingest rule). */
  message: string;
  /** Attachment paths or URLs the user added (they count for the ingest rule). */
  attachments?: string[];
  allowedTools: readonly string[];
  /** Default: from the editor's provider and probe (`selectMode`), decided by the caller. */
  mode: AgentMode;
  /** A question turn: read tools only (S35). */
  question?: boolean;
  workflowPrompt?: string;
  styleGuide?: string;
  projectSummary?: string;
  /** Plan mode: `clip` (ClipPlan, clipper and Stylize) or `ops` (free-form op list). Default `ops`. */
  planKind?: 'clip' | 'ops';
  /** Plan mode: confirm each validated plan first (pause `approval`, kind `plan`). */
  confirmPlan?: boolean;
  signal?: AbortSignal;
}

export interface TurnOptions {
  /** Sequences in scope (their view is injected before each step). */
  scope: string[];
  /** The instruction for this (sub-)run; default: the user's message. */
  instruction?: string;
  /** 1-based sub-run number; absent for a single-turn run. */
  subRun?: number;
}

export type TurnStatus = 'completed' | 'capped' | 'stopped' | 'failed';

export interface TurnResult {
  status: TurnStatus;
  summary: string;
  steps: number;
  error?: VoxErrorJson;
}
