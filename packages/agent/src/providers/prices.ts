// Cost math and price rules (agent spec "Cost tracking", D-10, R4 S23).
// Prices are USD per million tokens. No price data is bundled here: the table is user-editable
// config plus OpenRouter's models endpoint (see `parseOpenRouterPricing`).
import { z } from 'zod';
import { VoxError } from '../errors.ts';

const nonNegative = z.number().finite().nonnegative();

/** USD per million tokens. Cache and reasoning prices fall back as documented on `costOfUsage`. */
export const Price = z.strictObject({
  inPerMTok: nonNegative,
  outPerMTok: nonNegative,
  cacheReadPerMTok: nonNegative.optional(),
  cacheWritePerMTok: nonNegative.optional(),
  reasoningPerMTok: nonNegative.optional(),
});
export type Price = z.infer<typeof Price>;

/** A table entry: a price, or "free" (counts as 0, so the budget cap still applies). */
export const PriceEntry = z.union([Price, z.strictObject({ free: z.literal(true) })]);
export type PriceEntry = z.infer<typeof PriceEntry>;

export type PriceTable = Readonly<Record<string, PriceEntry>>;

/**
 * Token usage in the usual AI SDK shape: `inputTokens` is the total input including cache reads
 * and writes, `outputTokens` the total output including reasoning. Adapters for providers that
 * report these separately (Anthropic) add them up before calling.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

const isFree = (p: PriceEntry): p is { free: true } => 'free' in p;

function tokens(n: number | undefined, name: string): number {
  if (n === undefined) return 0;
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(`${name} must be a non-negative integer`);
  return n;
}

/**
 * Cost of one request from usage × price. Fresh input = input − cache read − cache write (never
 * below 0), billed at `inPerMTok`; cache reads and writes at their own price, else `inPerMTok`;
 * reasoning tokens (part of output) at `reasoningPerMTok`, else `outPerMTok`.
 */
export function costOfUsage(price: PriceEntry, usage: Usage): number {
  const input = tokens(usage.inputTokens, 'inputTokens');
  const output = tokens(usage.outputTokens, 'outputTokens');
  const cacheRead = tokens(usage.cacheReadTokens, 'cacheReadTokens');
  const cacheWrite = tokens(usage.cacheWriteTokens, 'cacheWriteTokens');
  const reasoning = Math.min(tokens(usage.reasoningTokens, 'reasoningTokens'), output);
  if (isFree(price)) return 0;
  const cachedRead = Math.min(cacheRead, input);
  const cachedWrite = Math.min(cacheWrite, input - cachedRead);
  const fresh = input - cachedRead - cachedWrite;
  const usd =
    fresh * price.inPerMTok +
    cachedRead * (price.cacheReadPerMTok ?? price.inPerMTok) +
    cachedWrite * (price.cacheWritePerMTok ?? price.inPerMTok) +
    (output - reasoning) * price.outPerMTok +
    reasoning * (price.reasoningPerMTok ?? price.outPerMTok);
  return usd / 1e6;
}

/**
 * The provider-reported cost when it is a usable number (OpenRouter usage accounting), else
 * usage × price, else `undefined` (unpriced and unreported: the caller must not guess).
 */
export function costFromReported(
  reportedUsd: number | null | undefined,
  price: PriceEntry | undefined,
  usage: Usage,
): number | undefined {
  if (typeof reportedUsd === 'number' && Number.isFinite(reportedUsd) && reportedUsd >= 0) {
    // A reported 0 with real usage on a priced model (e.g. BYOK accounting) is not trusted.
    const suspicious =
      reportedUsd === 0 &&
      price !== undefined &&
      !isFree(price) &&
      usage.inputTokens + usage.outputTokens > 0;
    if (!suspicious) return reportedUsd;
  }
  return price === undefined ? undefined : costOfUsage(price, usage);
}

/**
 * Per-step upper bound: `inputTokens × inPrice + maxOutputTokens × outPrice` (spec). Each rate is
 * the dearest one that could apply (cache and reasoning prices above the base price count), so the
 * bound never under-counts.
 */
export function stepUpperBoundUsd(
  price: PriceEntry,
  inputTokens: number,
  maxOutputTokens: number,
): number {
  if (isFree(price)) return 0;
  const input = tokens(inputTokens, 'inputTokens');
  const out = tokens(maxOutputTokens, 'maxOutputTokens');
  const inRate = Math.max(
    price.inPerMTok,
    price.cacheReadPerMTok ?? 0,
    price.cacheWritePerMTok ?? 0,
  );
  const outRate = Math.max(price.outPerMTok, price.reasoningPerMTok ?? 0);
  return (input * inRate + out * outRate) / 1e6;
}

/** True when the next step could push the run past its cap (`spent + bound > cap`). */
export function exceedsBudget(spentUsd: number, boundUsd: number, capUsd: number): boolean {
  return !(spentUsd + boundUsd <= capUsd); // NaN counts as exceeded
}

export interface ProviderKind {
  type: 'openrouter' | 'anthropic' | 'openai' | 'google' | 'ollama' | 'openai-compatible' | 'apple';
  /** Preset the entry came from (`lmstudio`, `9router`, …), when known. */
  preset?: string;
}

/** Ollama, Apple on-device and LM Studio cost 0; a gateway such as 9router is not local. */
export function isLocalProvider(p: ProviderKind): boolean {
  return p.type === 'ollama' || p.type === 'apple' || p.preset === 'lmstudio';
}

export type PriceStatus =
  { status: 'priced'; price: Price } | { status: 'free' } | { status: 'unpriced' };

/** First table with an entry for `model` wins (own properties only). */
export function lookupPrice(
  model: string,
  ...tables: ReadonlyArray<PriceTable | undefined>
): PriceEntry | undefined {
  for (const t of tables) {
    if (t && Object.hasOwn(t, model)) return t[model];
  }
  return undefined;
}

export function priceStatus(
  provider: ProviderKind,
  model: string,
  ...tables: ReadonlyArray<PriceTable | undefined>
): PriceStatus {
  if (isLocalProvider(provider)) return { status: 'free' };
  const entry = lookupPrice(model, ...tables);
  if (entry === undefined) return { status: 'unpriced' };
  return isFree(entry) ? { status: 'free' } : { status: 'priced', price: entry };
}

/** A paid model with no price cannot fill a role until priced or marked free (D-10). */
export function assertRoleModelPriced(
  provider: ProviderKind,
  model: string,
  role: string,
  ...tables: ReadonlyArray<PriceTable | undefined>
): void {
  if (priceStatus(provider, model, ...tables).status !== 'unpriced') return;
  throw new VoxError(
    'PRICE_MISSING',
    `${model} has no known price, so it cannot be the ${role} model`,
    'Enter its prices in the price table or mark the model free, then assign the role again.',
    { details: { model, role } },
  );
}

/**
 * OpenRouter's `pricing` object (USD per token, as strings) → a per-million price. Both `prompt`
 * and `completion` must be valid; "0" and "0" means free. Anything unusable returns undefined,
 * which leaves the model unpriced.
 */
export function parseOpenRouterPricing(pricing: Record<string, unknown>): PriceEntry | undefined {
  const perM = (v: unknown): number | undefined => {
    if (typeof v !== 'string' || v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n * 1e6 : undefined;
  };
  const inP = perM(pricing['prompt']);
  const outP = perM(pricing['completion']);
  if (inP === undefined || outP === undefined) return undefined;
  const cacheRead = perM(pricing['input_cache_read']);
  const cacheWrite = perM(pricing['input_cache_write']);
  const reasoning = perM(pricing['internal_reasoning']);
  if (inP === 0 && outP === 0 && !cacheRead && !cacheWrite && !reasoning) return { free: true };
  return {
    inPerMTok: inP,
    outPerMTok: outP,
    ...(cacheRead !== undefined && { cacheReadPerMTok: cacheRead }),
    ...(cacheWrite !== undefined && { cacheWritePerMTok: cacheWrite }),
    ...(reasoning !== undefined && { reasoningPerMTok: reasoning }),
  };
}

/** Image generation is priced per image from its own table (USD per image). */
export function costOfImages(
  table: Readonly<Record<string, number>>,
  model: string,
  count: number,
): number | undefined {
  if (!Object.hasOwn(table, model)) return undefined;
  const per = table[model] as number;
  if (!Number.isFinite(per) || per < 0) return undefined;
  return per * tokens(count, 'count');
}
