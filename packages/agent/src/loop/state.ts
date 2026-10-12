// The state block before each step (agent spec "Agent loop"; plan D-15, D-76, D-81). The full block
// is the view of every sequence in scope plus the change note. With a prompt-caching editor (D-76)
// each block stays in the history after its step, so a step can send only what changed since the
// previous block: the blocks before it are a cached prefix, and the new one is the only uncached
// state text. A full block is sent at the start of a turn, after every compaction (which stubs or
// drops the old blocks) and every STATE_FULL_EVERY steps, so the model never rebuilds the state
// from more than STATE_FULL_EVERY - 1 diffs. Without caching nothing is kept: every step gets the
// full block, newest only, as before D-81.
import { wrapData } from './envelope.ts';

/**
 * A full block at least every 8 steps: the same as KEEP_RECENT_STEPS, so the last full block is
 * always among the steps compaction keeps whole.
 */
export const STATE_FULL_EVERY = 8;

export const FULL_STATE_HEADER = '[Current state, newest only]';
export const DIFF_STATE_HEADER =
  '[State changes since the last state block; the rest is unchanged]';

export interface SequenceState {
  /** The sequence's short id (s1). */
  alias: string;
  version: number;
  /** The view items as the model sees them (aliased), in timeline order. */
  items: readonly { id: string }[];
  /** Caption lines, `startMs–endMs text` (transcript text: wrapped when sent). */
  captions: readonly string[];
}

export interface StateSnapshot {
  sequences: readonly SequenceState[];
  /** The change note (only changes since the last note), or ''. */
  note: string;
}

const captionBlock = (lines: readonly string[]) =>
  lines.length === 0 ? '' : wrapData('captions', lines.join('\n'));

/** The full block, byte for byte the pre-D-81 injection text. */
export function renderFullState(s: StateSnapshot): string {
  const parts = s.sequences.map((q) => {
    const captions = captionBlock(q.captions);
    return `Sequence ${q.alias} @v${String(q.version)}: ${JSON.stringify(q.items)}${captions ? `\nCaptions:\n${captions}` : ''}`;
  });
  if (s.note) parts.push(s.note);
  return `${FULL_STATE_HEADER}\n${parts.join('\n\n')}`;
}

function diffSequence(prev: SequenceState | undefined, cur: SequenceState): string {
  if (!prev) {
    const captions = captionBlock(cur.captions);
    return `Sequence ${cur.alias} @v${String(cur.version)} (new in scope): ${JSON.stringify(cur.items)}${captions ? `\nCaptions:\n${captions}` : ''}`;
  }
  const before = new Map(prev.items.map((it) => [it.id, JSON.stringify(it)]));
  const changed = cur.items.filter((it) => before.get(it.id) !== JSON.stringify(it));
  const ids = new Set(cur.items.map((it) => it.id));
  const removed = prev.items.map((it) => it.id).filter((id) => !ids.has(id));
  const was = new Set(prev.captions);
  const now = new Set(cur.captions);
  const added = cur.captions.filter((l) => !was.has(l));
  const gone = prev.captions.filter((l) => !now.has(l));
  const head = `Sequence ${cur.alias} @v${String(cur.version)}`;
  if (changed.length === 0 && removed.length === 0 && added.length === 0 && gone.length === 0)
    return `${head}: no change`;
  const out: string[] = [];
  const what: string[] = [];
  if (changed.length > 0) what.push(`changed or added ${JSON.stringify(changed)}`);
  if (removed.length > 0) what.push(`removed ${JSON.stringify(removed)}`);
  out.push(`${head}: ${what.length > 0 ? what.join('; ') : 'items unchanged'}`);
  if (added.length > 0 || gone.length > 0) {
    const all = captionBlock(cur.captions);
    const parts: string[] = [];
    if (gone.length > 0) parts.push(`Caption lines removed:\n${captionBlock(gone)}`);
    if (added.length > 0) parts.push(`Caption lines added:\n${captionBlock(added)}`);
    const diff = parts.join('\n');
    // when most lines moved (a ripple), the whole caption list is shorter than the diff
    out.push(
      all === '' || diff.length < all.length + 'Captions (all):\n'.length
        ? diff
        : `Captions (all):\n${all}`,
    );
  }
  return out.join('\n');
}

/** Only what changed since `prev`, per sequence, plus the change note. */
export function renderStateDiff(prev: StateSnapshot, cur: StateSnapshot): string {
  const before = new Map(prev.sequences.map((q) => [q.alias, q]));
  const parts = cur.sequences.map((q) => diffSequence(before.get(q.alias), q));
  const ids = new Set(cur.sequences.map((q) => q.alias));
  for (const q of prev.sequences)
    if (!ids.has(q.alias)) parts.push(`Sequence ${q.alias}: no longer in scope`);
  if (cur.note) parts.push(cur.note);
  return `${DIFF_STATE_HEADER}\n${parts.join('\n\n')}`;
}

export type StateKind = 'full' | 'diff';

/**
 * Picks full or diff for each step of one turn (one conversation). `take` is called once per
 * request; `commit` once the step's block went into the history.
 */
export class StateTracker {
  #last: StateSnapshot | undefined;
  #sinceFull = 0;
  #forceFull = true;
  readonly fullEvery: number;

  constructor(fullEvery = STATE_FULL_EVERY) {
    this.fullEvery = fullEvery;
  }

  /** The next block must be full (after a compaction). */
  invalidate(): void {
    this.#forceFull = true;
  }

  /** The block for `cur`: full at the start, after `invalidate`, every `fullEvery` steps, or when the diff is not shorter. */
  render(cur: StateSnapshot): { text: string; kind: StateKind } {
    const full = renderFullState(cur);
    if (this.#forceFull || !this.#last || this.#sinceFull + 1 >= this.fullEvery)
      return { text: full, kind: 'full' };
    const diff = renderStateDiff(this.#last, cur);
    return diff.length < full.length ? { text: diff, kind: 'diff' } : { text: full, kind: 'full' };
  }

  /** The block for `cur` was sent and kept in the history. */
  commit(cur: StateSnapshot, kind: StateKind): void {
    this.#last = cur;
    this.#forceFull = false;
    this.#sinceFull = kind === 'full' ? 0 : this.#sinceFull + 1;
  }
}
