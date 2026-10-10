// restoreSnapshot (engine spec "Snapshots"): replace sequences and media with a snapshot's; undoable.
import { z } from 'zod';
import type { Project } from '../model/schema.ts';
import { fail, type OpContext } from './core.ts';

export const SnapshotNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+$/, 'snapshot names use A-Z, a-z, 0-9, ".", "_" and "-"')
  .max(100)
  .refine((n) => n !== '.' && n !== '..', 'snapshot name cannot be . or ..');

export const restoreSnapshotArgs = z.strictObject({ name: SnapshotNameSchema });

export function restoreSnapshot(
  p: Project,
  a: z.infer<typeof restoreSnapshotArgs>,
  ctx: OpContext,
): void {
  const snap = ctx.snapshot(a.name);
  if (!snap)
    fail(
      'NOT_FOUND',
      `Snapshot ${a.name} not found`,
      'List snapshots with `vox snapshot <project> --list`',
      { name: a.name },
    );
  p.media = structuredClone(snap.media);
  p.sequences = structuredClone(snap.sequences);
}
