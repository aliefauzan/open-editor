// Tool layer types (agent spec "Tools"). A tool is generated from an engine zod schema or written
// here; every tool runs with the run's context (actor `agent`, `runId`, aliases, source rule).
import type { Change, Engine } from '@vox/engine';
import type { z } from 'zod';
import type { AliasTable } from './aliases.ts';

/** The engine surface the agent uses (`@vox/engine` api.ts only, R1). */
export type AgentEngine = Pick<
  Engine,
  | 'projectsDir'
  | 'applyOp'
  | 'view'
  | 'getProject'
  | 'history'
  | 'undoRun'
  | 'jobs'
  | 'frames'
  | 'mediaFrames'
  | 'frameCards'
  | 'styles'
  | 'geo'
  | 'imageProviders'
  | 'captions'
  | 'compile'
  | 'quickClips'
>;

/** `read` tools change nothing; a question turn may call only these (S35). */
export type ToolKind = 'read' | 'write' | 'job' | 'meta';

export interface ToolImage {
  mediaType: 'image/png';
  data: Uint8Array;
  /** What the image is, e.g. `seqMs 1200` or `srcMs 5000`. */
  label: string;
  /** The still on disk: once the image leaves the recent history, its frame card replaces it (D-80). */
  path?: string;
}

/** Describes images with the `vision` role; its prompt holds the on-image text rule (S34). */
export interface VisionDescriber {
  describe(images: readonly ToolImage[], task: string, signal?: AbortSignal): Promise<string>;
}

export interface PauseRequest {
  reason: 'approval';
  kind: 'source';
  detail: string;
  sources: string[];
}

export interface TodoItem {
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface ToolContext {
  engine: AgentEngine;
  projectId: string;
  runId: string;
  aliases: AliasTable;
  /** A question turn: `call_tool` refuses every tool that is not a read tool (S35). */
  question: boolean;
  /** Sources the user named in this conversation (messages, attachments), verbatim (S20). */
  userSources: ReadonlySet<string>;
  /** Sources the user approved after a `source` pause. */
  approvedSources: Set<string>;
  /** `vision` role; absent when none is set. */
  vision?: VisionDescriber;
  /** The editor model takes images itself. */
  editorVision: boolean;
  /** The last project version this run has seen (write tools send it as `baseVersion`). */
  seenVersion: number;
  /** Replaces the run's todo list (emits `agent.todos`). */
  setTodos(items: TodoItem[]): void;
  /** Starts an engine job and waits for it (the loop wires cancel and progress); `signal` cancels it. */
  runJob?(kind: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  /** Reads a still written by the engine (`frames`, `mediaFrames`, `qa.png`). */
  readImage?(path: string): Promise<Uint8Array>;
  signal?: AbortSignal;
}

export interface ToolOutput {
  /** Compact JSON for the model (ids already aliased). */
  result: unknown;
  /** Untrusted text inside: the loop wraps the result in `<data source="…">` (S21). */
  untrusted?: string;
  images?: ToolImage[];
  /** Versions this call created. */
  versions?: number[];
  /** Entity changes (run record only, never sent to the model). */
  changes?: Change[];
  /** The tool did not run: the run pauses until the user decides. */
  pause?: PauseRequest;
  /** What was read at which version, for the compaction stub (D-15). */
  read?: { version: number; label: string };
}

export interface AgentTool {
  name: string;
  kind: ToolKind;
  description: string;
  /** Engine-side schema: validates the args after aliases are resolved. */
  input: z.ZodType;
  run(ctx: ToolContext, args: unknown): Promise<ToolOutput>;
}
