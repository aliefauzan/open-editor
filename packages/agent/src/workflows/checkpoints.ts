// Workflow checkpoints (agent spec "Workflows"): the loop enforces each workflow's `checkpoints`, in
// order, per sequence. A checkpoint is met (with a note), skipped by the user (Tighten), or missed;
// a missed one fails the run at the end with a message naming the checkpoint and the sequence.
import { VoxError } from '../errors.ts';
import type { Checkpoint } from './load.ts';

export interface CheckpointMark {
  checkpoint: Checkpoint;
  sequenceId: string;
  status: 'met' | 'skipped' | 'missed';
  note: string;
}

export class Checkpoints {
  readonly required: readonly Checkpoint[];
  readonly marks: CheckpointMark[] = [];

  constructor(required: readonly Checkpoint[]) {
    this.required = required;
  }

  #mark(
    checkpoint: Checkpoint,
    sequenceId: string,
    status: CheckpointMark['status'],
    note: string,
  ) {
    if (!this.required.includes(checkpoint)) return;
    const done = this.marks.filter((m) => m.sequenceId === sequenceId).map((m) => m.checkpoint);
    const order = this.required.indexOf(checkpoint);
    const early = this.required.slice(0, order).filter((c) => !done.includes(c));
    if (early.length > 0) {
      // out of order: the earlier ones were never reached for this sequence
      for (const c of early)
        this.marks.push({ checkpoint: c, sequenceId, status: 'missed', note: 'not reached' });
    }
    this.marks.push({ checkpoint, sequenceId, status, note });
  }

  met(checkpoint: Checkpoint, sequenceId: string, note = ''): void {
    this.#mark(checkpoint, sequenceId, 'met', note);
  }
  skipped(checkpoint: Checkpoint, sequenceId: string, note: string): void {
    this.#mark(checkpoint, sequenceId, 'skipped', note);
  }
  missed(checkpoint: Checkpoint, sequenceId: string, note: string): void {
    this.#mark(checkpoint, sequenceId, 'missed', note);
  }

  /** Every required checkpoint not met or skipped, per sequence in `sequenceIds`. */
  open(sequenceIds: readonly string[]): CheckpointMark[] {
    const out: CheckpointMark[] = [];
    for (const sequenceId of sequenceIds) {
      for (const checkpoint of this.required) {
        const m = this.marks.filter(
          (x) => x.sequenceId === sequenceId && x.checkpoint === checkpoint,
        );
        const last = m.at(-1);
        if (!last) out.push({ checkpoint, sequenceId, status: 'missed', note: 'not reached' });
        else if (last.status === 'missed') out.push(last);
      }
    }
    return out;
  }

  /** CHECKPOINT_MISSED naming each open checkpoint, its sequence (by `label`) and why. */
  error(open: readonly CheckpointMark[], label: (sequenceId: string) => string): VoxError {
    const list = open.map((m) => `${m.checkpoint} (${label(m.sequenceId)}: ${m.note})`);
    return new VoxError(
      'CHECKPOINT_MISSED',
      `the run missed required checkpoint${open.length === 1 ? '' : 's'}: ${list.join('; ')}`,
      'The edits so far stay (undo the run to remove them); see the run summary.',
      { details: { checkpoints: open.map((m) => ({ ...m })) } },
    );
  }
}
