// Short ids (agent spec "Short ids", plan D-15). The model never sees engine ids: each item,
// sequence and media item gets a per-run alias on first sight (`c1`… items, `s1`… sequences,
// `m1`… media). One table lives for the whole run (all sub-runs) and is written to the run record.
import { VoxError } from '../errors.ts';

const ENGINE_ID = /^(it|seq|m)_[A-Za-z0-9_-]+$/;
const WORD_KEY = /^(m_[A-Za-z0-9_-]+)(:[^:\s]+:\d+)$/;
const ALIAS = /^([csm])([1-9][0-9]*)$/;
const ALIAS_WORD_KEY = /^(m[1-9][0-9]*)(:[^:\s]+:\d+)$/;
const PREFIX: Readonly<Record<string, string>> = { it: 'c', seq: 's', m: 'm' };

/** Input keys whose string values are ids (aliases are resolved only there). */
const ID_KEY = /(^ids?$|Ids?$|^wordKeys?$)/;

export const UNKNOWN_ALIAS_HINT = 're-read with `get_sequence`';

export type AliasSnapshot = Readonly<Record<string, string>>;

export class AliasTable {
  readonly #byId = new Map<string, string>();
  readonly #byAlias = new Map<string, string>();
  readonly #next: Record<string, number> = { c: 1, s: 1, m: 1 };

  constructor(init: AliasSnapshot = {}) {
    for (const [alias, id] of Object.entries(init)) {
      const m = ALIAS.exec(alias);
      if (!m || !ENGINE_ID.test(id)) continue;
      this.#byAlias.set(alias, id);
      this.#byId.set(id, alias);
      const letter = m[1] as string;
      this.#next[letter] = Math.max(this.#next[letter] ?? 1, Number(m[2]) + 1);
    }
  }

  /** The alias of an engine id, assigned on first sight; other strings come back unchanged. */
  aliasOf(id: string): string {
    const known = this.#byId.get(id);
    if (known) return known;
    const m = ENGINE_ID.exec(id);
    if (!m) return id;
    const letter = PREFIX[m[1] as string] as string;
    const n = this.#next[letter] ?? 1;
    this.#next[letter] = n + 1;
    const alias = `${letter}${String(n)}`;
    this.#byId.set(id, alias);
    this.#byAlias.set(alias, id);
    return alias;
  }

  /** The engine id of an alias; an engine id passes through; anything else is undefined. */
  resolve(value: string): string | undefined {
    if (ENGINE_ID.test(value)) return value;
    return this.#byAlias.get(value);
  }

  /** Alias → engine id, for the run record. */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.#byAlias);
  }

  /** Deep copy with every engine id (and the media id inside word keys) replaced by its alias. */
  toModel<T>(value: T): T {
    return this.#mapOut(value) as T;
  }

  #mapOut(v: unknown): unknown {
    if (typeof v === 'string') {
      if (ENGINE_ID.test(v)) return this.aliasOf(v);
      const w = WORD_KEY.exec(v);
      return w ? `${this.aliasOf(w[1] as string)}${w[2] as string}` : v;
    }
    if (Array.isArray(v)) return v.map((x) => this.#mapOut(x));
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = this.#mapOut(x);
      return out;
    }
    return v;
  }

  /**
   * Deep copy with the aliases under id keys (`sequenceId`, `itemIds`, `wordKeys`, …) resolved to
   * engine ids. An unknown alias throws `UNKNOWN_ALIAS` (a tool error the model can fix).
   */
  fromModel(value: unknown): unknown {
    return this.#mapIn(value, false);
  }

  #mapIn(v: unknown, idContext: boolean): unknown {
    if (typeof v === 'string') return idContext ? this.#resolveOne(v) : v;
    if (Array.isArray(v)) return v.map((x) => this.#mapIn(x, idContext));
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = this.#mapIn(x, ID_KEY.test(k));
      return out;
    }
    return v;
  }

  #resolveOne(s: string): string {
    if (ALIAS.test(s)) return this.#need(s);
    const w = ALIAS_WORD_KEY.exec(s);
    if (w) return `${this.#need(w[1] as string)}${w[2] as string}`;
    return s;
  }

  #need(alias: string): string {
    const id = this.#byAlias.get(alias);
    if (id === undefined) {
      throw new VoxError('UNKNOWN_ALIAS', `unknown id ${alias}`, UNKNOWN_ALIAS_HINT, {
        details: { alias },
      });
    }
    return id;
  }
}
