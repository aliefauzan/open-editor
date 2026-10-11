// The model-facing conversation of one (sub-)run and its compaction (agent spec "Agent loop" →
// "Context compaction", plan D-15). Tool results older than the last 8 steps become one-line stubs
// stamped with the project version they read; a stub older than the current version is shown as
// stale. If that is not enough, the oldest steps are summarised into a notes block (by the `fast`
// model when there is one) and dropped.
import type { ModelMessage, ToolResultPart } from 'ai';
import { estimateTokens } from '../providers/tool-cost.ts';

export const KEEP_RECENT_STEPS = 8;
export const COMPACT_AT = 0.7;

interface ToolMeta {
  label: string;
  version: number;
  stubbed: boolean;
}

interface Entry {
  step: number;
  message: ModelMessage;
  /** For `tool` messages: one per result part, by toolCallId. */
  tools?: Map<string, ToolMeta>;
}

export type Summarise = (text: string, previousNotes: string) => Promise<string>;

export function stubText(meta: { label: string; version: number }, currentVersion: number): string {
  return meta.version < currentVersion
    ? `[stale @v${String(meta.version)}: ${meta.label}; re-read]`
    : `[elided @v${String(meta.version)}: ${meta.label}]`;
}

export class Conversation {
  readonly #entries: Entry[] = [];
  #notes = '';

  get notes(): string {
    return this.#notes;
  }

  user(step: number, text: string): void {
    this.#entries.push({ step, message: { role: 'user', content: text } });
  }

  assistant(step: number, message: ModelMessage): void {
    this.#entries.push({ step, message });
  }

  /** One tool message with its results; `meta` gives each result's stub label and read version. */
  toolResults(
    step: number,
    parts: ToolResultPart[],
    meta: Map<string, { label: string; version: number }>,
  ): void {
    const tools = new Map<string, ToolMeta>();
    for (const [id, m] of meta) tools.set(id, { ...m, stubbed: false });
    this.#entries.push({ step, message: { role: 'tool', content: parts }, tools });
  }

  /** The messages to send, with stubs rendered against `currentVersion`. */
  messages(currentVersion: number): ModelMessage[] {
    return this.#entries.map((e) => {
      if (!e.tools || e.message.role !== 'tool') return e.message;
      const content = e.message.content.map((p) => {
        if (p.type !== 'tool-result') return p;
        const m = e.tools?.get(p.toolCallId);
        if (!m?.stubbed) return p;
        return { ...p, output: { type: 'text' as const, value: stubText(m, currentVersion) } };
      });
      return { ...e.message, content };
    });
  }

  tokens(currentVersion: number): number {
    return (
      estimateTokens(JSON.stringify(this.messages(currentVersion))) + estimateTokens(this.#notes)
    );
  }

  /** Stubs tool results of steps up to `step` (inclusive). Returns how many were stubbed. */
  stubThrough(step: number): number {
    let n = 0;
    for (const e of this.#entries) {
      if (e.step > step || !e.tools) continue;
      for (const m of e.tools.values()) {
        if (!m.stubbed) {
          m.stubbed = true;
          n++;
        }
      }
    }
    return n;
  }

  /**
   * Compacts when over `budgetTokens`: stubs results older than the last 8 steps (all but the last
   * 2 when `force`), then summarises and drops the oldest steps. The first user message (the
   * instruction) always stays.
   */
  async compact(opts: {
    budgetTokens: number;
    currentStep: number;
    currentVersion: number;
    force?: boolean;
    summarise?: Summarise;
  }): Promise<{ stubbed: number; summarised: number }> {
    const over = () => this.tokens(opts.currentVersion) > opts.budgetTokens;
    if (!opts.force && !over()) return { stubbed: 0, summarised: 0 };
    const keep = opts.force ? 2 : KEEP_RECENT_STEPS;
    const stubbed = this.stubThrough(opts.currentStep - keep);
    if (!opts.force && !over()) return { stubbed, summarised: 0 };
    const cutoff = opts.currentStep - keep;
    const first = this.#entries.findIndex((e) => e.message.role === 'user');
    const old = this.#entries.filter((e, i) => i !== first && e.step <= cutoff);
    if (old.length === 0) return { stubbed, summarised: 0 };
    const text = JSON.stringify(
      old.map((e) => this.messages(opts.currentVersion)[this.#entries.indexOf(e)]),
    );
    const notes = opts.summarise
      ? await opts.summarise(text, this.#notes)
      : `${this.#notes}${this.#notes ? '\n' : ''}[steps up to ${String(cutoff)} elided]`;
    this.#notes = notes;
    const drop = new Set(old);
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      if (drop.has(this.#entries[i] as Entry)) this.#entries.splice(i, 1);
    }
    return { stubbed, summarised: old.length };
  }
}
