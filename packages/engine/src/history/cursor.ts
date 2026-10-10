// Undo/redo cursor (engine spec "Undo / redo cursor"): rebuilt on load by replaying the entries.
import type { HistoryEntry } from './types.ts';

export const UNDO_DEPTH = 500;

export class Cursor {
  /** Versions of `op` and `redo` entries not yet undone, oldest first. */
  undo: number[] = [];
  /** Versions of `undo` entries since the last new op, oldest first. */
  redo: number[] = [];

  static build(entries: readonly HistoryEntry[]): Cursor {
    const c = new Cursor();
    for (const e of entries) c.push(e);
    return c;
  }

  push(e: HistoryEntry): void {
    switch (e.kind) {
      case 'op':
        if (e.replaces !== undefined) this.undo = this.undo.filter((v) => v !== e.replaces);
        if (e.changes.length > 0) this.undo.push(e.version);
        this.redo = [];
        break;
      case 'undo': {
        const t = new Set(e.targets ?? []);
        this.undo = this.undo.filter((v) => !t.has(v));
        this.redo.push(e.version);
        break;
      }
      case 'redo':
        this.redo.pop();
        this.undo.push(e.version);
        break;
    }
    if (this.undo.length > UNDO_DEPTH) this.undo.splice(0, this.undo.length - UNDO_DEPTH);
  }
}
