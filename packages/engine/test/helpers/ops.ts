import { expect } from 'vitest';
import { runOp, type OpContext, type OpOutcome } from '../../src/ops/index.ts';
import type { Project, Transcript, MediaItem } from '../../src/model/schema.ts';
import { templates } from './templates.ts';

let counter = 0;
export function testCtx(extra: Partial<OpContext> = {}): OpContext {
  return {
    templates,
    newId: (prefix) => `${prefix}t${(++counter).toString(36).padStart(4, '0')}`,
    transcript: () => undefined,
    snapshot: () => undefined,
    ...extra,
  };
}

export function transcriptCtx(
  map: Record<string, Transcript>,
  extra: Partial<OpContext> = {},
): OpContext {
  return testCtx({ transcript: (m: MediaItem) => map[m.id], ...extra });
}

export function apply(
  p: Project,
  op: string,
  args: unknown,
  ctx: OpContext = testCtx(),
): OpOutcome {
  return runOp(p, { op, args } as never, ctx);
}

/** Apply and return the new project only. */
export function ap(p: Project, op: string, args: unknown, ctx: OpContext = testCtx()): Project {
  return apply(p, op, args, ctx).project;
}

export function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect((e as { code?: string }).code, (e as Error).message).toBe(code);
    return;
  }
  throw new Error(`expected VoxError ${code}, nothing was thrown`);
}

export function seq(p: Project, id = 'seq_1') {
  const s = p.sequences.find((x) => x.id === id);
  if (!s) throw new Error(`no sequence ${id}`);
  return s;
}

export function trackItems(p: Project, trackId: string, seqId = 'seq_1') {
  const s = seq(p, seqId);
  const t = [...s.videoTracks, ...s.audioTracks].find((x) => x.id === trackId);
  if (!t) throw new Error(`no track ${trackId}`);
  return t.items;
}

export function item(p: Project, itemId: string, seqId = 'seq_1') {
  const s = seq(p, seqId);
  for (const t of [...s.videoTracks, ...s.audioTracks]) {
    const it = t.items.find((i) => i.id === itemId);
    if (it) return { ...it, trackId: t.id };
  }
  throw new Error(`no item ${itemId}`);
}

export const spans = (items: { startMs: number; durationMs: number }[]) =>
  items.map((i) => [i.startMs, i.startMs + i.durationMs]);

/** A media clip by id (fails on scenes). */
export function clip(p: Project, itemId: string, seqId = 'seq_1') {
  const it = item(p, itemId, seqId);
  if (it.type !== 'media') throw new Error(`${itemId} is not a media clip`);
  return it;
}

/** A scene clip by id (fails on media clips). */
export function scene(p: Project, itemId: string, seqId = 'seq_1') {
  const it = item(p, itemId, seqId);
  if (it.type !== 'scene') throw new Error(`${itemId} is not a scene`);
  return it;
}
