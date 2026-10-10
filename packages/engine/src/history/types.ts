// History contracts (engine spec "Change records", "Write order"; plan D-15, D-18). Frozen in phase 02.
import { z } from 'zod';
import type { VoxError } from '../errors.ts';
import type { Change } from '../model/diff.ts';
import type { Entity } from '../model/normalise.ts';
import type { Item } from '../model/schema.ts';

export type { Change } from '../model/diff.ts';

export const ACTORS = ['user', 'agent', 'cli', 'external'] as const;
export type Actor = (typeof ACTORS)[number];

export interface HistoryEntry {
  /** Project version after this entry. */
  version: number;
  ts: string;
  kind: 'op' | 'undo' | 'redo';
  actor: Actor;
  /** Agent run that produced it. */
  runId?: string;
  /** Job whose result it applied (plan D-15). */
  jobId?: string;
  op?: string;
  args?: unknown;
  coalesceKey?: string;
  /** The coalesced entry this one replaces. */
  replaces?: number;
  /** For undo/redo: the versions being undone/redone. */
  targets?: number[];
  changes: Change[];
}

const EntitySchema = z.record(z.string(), z.unknown()) as unknown as z.ZodType<Entity>;

export const HistoryEntrySchema: z.ZodType<HistoryEntry> = z.strictObject({
  version: z.int().positive(),
  ts: z.string(),
  kind: z.enum(['op', 'undo', 'redo']),
  actor: z.enum(ACTORS),
  runId: z.string().optional(),
  jobId: z.string().optional(),
  op: z.string().optional(),
  args: z.unknown().optional(),
  coalesceKey: z.string().optional(),
  replaces: z.int().positive().optional(),
  targets: z.array(z.int().positive()).optional(),
  changes: z.array(
    z.strictObject({
      key: z.string().min(1),
      before: EntitySchema.nullable(),
      after: EntitySchema.nullable(),
    }),
  ),
}) as unknown as z.ZodType<HistoryEntry>;

export type ItemEntity = Item & { trackId: string };

export interface OpResult {
  op: string;
  status: 'succeeded' | 'failed' | 'conflicted';
  error?: VoxError;
  /** Touched items' new state, each with its trackId. */
  items?: ItemEntity[];
  /** Op output, e.g. removePauses ranges (plan D-18). */
  report?: unknown;
}

export interface ApplyResult {
  version: number;
  changes: Change[];
  results: OpResult[];
}

export interface ApplyOptions {
  actor: Actor;
  runId?: string;
  baseVersion?: number;
  coalesceKey?: string;
  jobId?: string;
}

export interface ProjectChangedEvent {
  projectId: string;
  version: number;
  actor: Actor;
  runId?: string;
  op?: string;
  changes: Change[];
}
