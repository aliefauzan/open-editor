// The model-facing conversation of one (sub-)run and its compaction (agent spec "Agent loop" →
// "Context compaction", plan D-15). Tool results older than the last 8 steps become one-line stubs
// stamped with the project version they read; a stub older than the current version is shown as
// stale. If that is not enough, the oldest steps are summarised into a notes block (by the `fast`
// model when there is one) and dropped. Images in tool results older than the last 8 steps are
// replaced once by their frame cards (D-80), whether or not the history is over budget.
import type { ModelMessage, ToolResultPart } from 'ai';
import { estimateTokens } from '../providers/tool-cost.ts';
import { imageTokens } from '../tools/png.ts';

export const KEEP_RECENT_STEPS = 8;
export const COMPACT_AT = 0.7;

/** An image a tool result carried: its label and the still on disk (for its frame card). */
export interface StillRef {
  label: string;
  path?: string;
}

/** What the loop knows about one tool result: its stub label, read version and images. */
export interface ResultMeta {
  label: string;
  version: number;
  stills?: StillRef[];
}

interface ToolMeta extends ResultMeta {
  stubbed: boolean;
  /** Its images were replaced by text (D-80); never undone, so the bytes stay the same. */
  imagesAged?: boolean;
}

/** Turns aged images into text (frame cards in the loop). */
export type DescribeStills = (stills: readonly StillRef[]) => Promise<string>;

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
  toolResults(step: number, parts: ToolResultPart[], meta: Map<string, ResultMeta>): void {
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

  /** Text at ~3 characters a token; an image at its billed size (≈ w × h / 750), not its bytes. */
  tokens(currentVersion: number): number {
    let images = 0;
    // the holder's value, not `v`: a Buffer reaches the replacer already turned into JSON
    const json = JSON.stringify(this.messages(currentVersion), function (k, v: unknown) {
      const raw = (this as Record<string, unknown>)[k];
      if (raw instanceof Uint8Array) {
        images += imageTokens(raw);
        return '';
      }
      return v;
    });
    return estimateTokens(json) + images + estimateTokens(this.#notes);
  }

  /**
   * Replaces the images of tool results from steps up to `step` (inclusive) with `describe`'s text,
   * once per result: the message is rewritten a single time and keeps those bytes after, so the
   * cached prefix (D-76) changes once, not every step. Returns how many results changed.
   */
  async ageImagesThrough(step: number, describe: DescribeStills): Promise<number> {
    let n = 0;
    for (const e of this.#entries) {
      if (e.step > step || !e.tools || e.message.role !== 'tool') continue;
      for (const [id, m] of e.tools) {
        // a stubbed result is sent as its one-line stub: no images left to replace
        if (!m.stills || m.stills.length === 0 || m.imagesAged || m.stubbed) continue;
        const text = await describe(m.stills);
        const message = e.message as Extract<ModelMessage, { role: 'tool' }>;
        e.message = {
          ...message,
          content: message.content.map((p) => {
            if (p.type !== 'tool-result' || p.toolCallId !== id || p.output.type !== 'content')
              return p;
            const kept = p.output.value.filter((v) => v.type === 'text');
            return {
              ...p,
              output: {
                type: 'content' as const,
                value: [...kept, { type: 'text' as const, text }],
              },
            };
          }),
        };
        m.imagesAged = true;
        n++;
      }
    }
    return n;
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
