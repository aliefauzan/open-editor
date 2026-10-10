import { describe, expect, it } from 'vitest';
import {
  PriceEntry,
  assertRoleModelPriced,
  costFromReported,
  costOfImages,
  costOfUsage,
  exceedsBudget,
  isLocalProvider,
  lookupPrice,
  parseOpenRouterPricing,
  priceStatus,
  stepUpperBoundUsd,
  type Price,
} from '../../src/providers/prices.ts';

// per million tokens, USD; a small test fixture, not product data
const claudeLike: Price = {
  inPerMTok: 3,
  outPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
};
const reasoner: Price = { inPerMTok: 1, outPerMTok: 4, reasoningPerMTok: 10 };

describe('costOfUsage', () => {
  it('prices plain input and output', () => {
    expect(costOfUsage(claudeLike, { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(
      3 + 1.5,
      9,
    );
  });

  it('counts cache read and write at their own prices, not at the input price', () => {
    // inputTokens is the total: 400k fresh + 500k cache read + 100k cache write
    const c = costOfUsage(claudeLike, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 500_000,
      cacheWriteTokens: 100_000,
    });
    expect(c).toBeCloseTo(0.4 * 3 + 0.5 * 0.3 + 0.1 * 3.75, 9);
  });

  it('falls back to the input price when a cache price is missing', () => {
    const p: Price = { inPerMTok: 2, outPerMTok: 8 };
    const c = costOfUsage(p, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 400_000,
      cacheWriteTokens: 100_000,
    });
    expect(c).toBeCloseTo(2, 9);
  });

  it('counts reasoning tokens at the reasoning price (inside outputTokens)', () => {
    const c = costOfUsage(reasoner, {
      inputTokens: 0,
      outputTokens: 1_000_000,
      reasoningTokens: 600_000,
    });
    expect(c).toBeCloseTo(0.4 * 4 + 0.6 * 10, 9);
  });

  it('bills reasoning at the output price when no reasoning price is given', () => {
    const c = costOfUsage(claudeLike, {
      inputTokens: 0,
      outputTokens: 1_000_000,
      reasoningTokens: 250_000,
    });
    expect(c).toBeCloseTo(15, 9);
  });

  it('never goes negative when cache counts exceed the input total', () => {
    const c = costOfUsage(claudeLike, {
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 500,
      cacheWriteTokens: 500,
    });
    expect(c).toBeGreaterThanOrEqual(0);
  });

  it('clamps reasoning to the output total', () => {
    const c = costOfUsage(reasoner, { inputTokens: 0, outputTokens: 1000, reasoningTokens: 5000 });
    expect(c).toBeCloseTo((1000 * 10) / 1e6, 12);
  });

  it('costs 0 for zero usage', () => {
    expect(costOfUsage(claudeLike, { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects token count %s', (n) => {
    expect(() => costOfUsage(claudeLike, { inputTokens: n, outputTokens: 0 })).toThrow();
  });
});

describe('costFromReported', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 0 };

  it('prefers the provider-reported cost', () => {
    expect(costFromReported(0.0123, claudeLike, usage)).toBe(0.0123);
  });

  it('computes from usage × price when nothing is reported', () => {
    expect(costFromReported(undefined, claudeLike, usage)).toBeCloseTo(3, 9);
    expect(costFromReported(null, claudeLike, usage)).toBeCloseTo(3, 9);
  });

  it('does not trust a reported 0 for real usage on a priced model', () => {
    expect(costFromReported(0, claudeLike, usage)).toBeCloseTo(3, 9);
    expect(costFromReported(0, { free: true }, usage)).toBe(0);
    expect(costFromReported(0, undefined, usage)).toBe(0);
    expect(costFromReported(0, claudeLike, { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it('ignores a reported cost that is not a finite non-negative number', () => {
    expect(costFromReported(Number.NaN, claudeLike, usage)).toBeCloseTo(3, 9);
    expect(costFromReported(-1, claudeLike, usage)).toBeCloseTo(3, 9);
  });

  it('returns undefined when there is nothing to go on (unpriced and unreported)', () => {
    expect(costFromReported(undefined, undefined, usage)).toBeUndefined();
  });
});

describe('budget upper bound (S23)', () => {
  it('is inputTokens × inPrice + maxOutputTokens × outPrice', () => {
    expect(stepUpperBoundUsd({ inPerMTok: 3, outPerMTok: 15 }, 200_000, 8_000)).toBeCloseTo(
      0.6 + 0.12,
      9,
    );
  });

  it('uses the dearest rate that could apply (cache write, reasoning)', () => {
    expect(stepUpperBoundUsd(claudeLike, 1_000_000, 0)).toBeCloseTo(3.75, 9);
    expect(stepUpperBoundUsd(reasoner, 0, 1_000_000)).toBeCloseTo(10, 9);
  });

  it('is 0 for a free or local model', () => {
    expect(stepUpperBoundUsd({ free: true }, 1_000_000, 8_000)).toBe(0);
  });

  it('pauses when spent + bound > cap, not when equal', () => {
    expect(exceedsBudget(1.5, 0.5, 2)).toBe(false);
    expect(exceedsBudget(1.5, 0.5000001, 2)).toBe(true);
    expect(exceedsBudget(2.5, 0, 2)).toBe(true);
  });

  it('treats NaN as exceeded, never as fine', () => {
    expect(exceedsBudget(Number.NaN, 0, 2)).toBe(true);
    expect(exceedsBudget(0, Number.NaN, 2)).toBe(true);
    expect(exceedsBudget(0, 0, Number.NaN)).toBe(true);
  });
});

describe('priceStatus and roles (D-10)', () => {
  const table = {
    'claude-x': claudeLike,
    'free-model': { free: true as const },
  };

  it('treats Ollama, Apple on-device and LM Studio as local: cost 0, never needs a price', () => {
    expect(isLocalProvider({ type: 'ollama' })).toBe(true);
    expect(isLocalProvider({ type: 'apple' })).toBe(true);
    expect(isLocalProvider({ type: 'openai-compatible', preset: 'lmstudio' })).toBe(true);
    expect(isLocalProvider({ type: 'openai-compatible', preset: '9router' })).toBe(false);
    expect(isLocalProvider({ type: 'openrouter' })).toBe(false);
    expect(isLocalProvider({ type: 'openai-compatible' })).toBe(false);
  });

  it('reports priced, free and unpriced', () => {
    expect(priceStatus({ type: 'anthropic' }, 'claude-x', table)).toEqual({
      status: 'priced',
      price: claudeLike,
    });
    expect(priceStatus({ type: 'openrouter' }, 'free-model', table)).toEqual({ status: 'free' });
    expect(priceStatus({ type: 'openrouter' }, 'mystery', table)).toEqual({ status: 'unpriced' });
  });

  it('a local provider is free without a table entry', () => {
    expect(priceStatus({ type: 'ollama' }, 'llama3', {})).toEqual({ status: 'free' });
    expect(priceStatus({ type: 'apple' }, 'on-device', {})).toEqual({ status: 'free' });
  });

  it('an unpriced paid model cannot fill a role', () => {
    const err = (() => {
      try {
        assertRoleModelPriced({ type: 'openai' }, 'gpt-new', 'editor', table);
      } catch (e) {
        return e as Error & { code: string; hint: string };
      }
      return null;
    })();
    expect(err?.code).toBe('PRICE_MISSING');
    expect(err?.message).toContain('gpt-new');
    expect(err?.hint).toMatch(/price|free/i);
  });

  it('a priced, free or local model can fill a role', () => {
    expect(() =>
      assertRoleModelPriced({ type: 'anthropic' }, 'claude-x', 'editor', table),
    ).not.toThrow();
    expect(() =>
      assertRoleModelPriced({ type: 'openrouter' }, 'free-model', 'fast', table),
    ).not.toThrow();
    expect(() => assertRoleModelPriced({ type: 'ollama' }, 'any', 'editor', {})).not.toThrow();
  });

  it('lookupPrice: first table wins (user table over bundled)', () => {
    const user = { m: { inPerMTok: 1, outPerMTok: 2 } };
    const bundled = { m: { inPerMTok: 9, outPerMTok: 9 }, n: { free: true as const } };
    expect(lookupPrice('m', user, bundled)).toEqual({ inPerMTok: 1, outPerMTok: 2 });
    expect(lookupPrice('n', user, bundled)).toEqual({ free: true });
    expect(lookupPrice('zzz', user, bundled)).toBeUndefined();
  });

  it('lookupPrice does not read inherited properties', () => {
    expect(lookupPrice('constructor', {})).toBeUndefined();
    expect(lookupPrice('__proto__', {})).toBeUndefined();
  });
});

describe('PriceEntry schema (user-editable table)', () => {
  it('accepts a price and a free marker', () => {
    expect(PriceEntry.safeParse({ inPerMTok: 1, outPerMTok: 2 }).success).toBe(true);
    expect(PriceEntry.safeParse({ free: true }).success).toBe(true);
  });

  it.each([
    { inPerMTok: -1, outPerMTok: 2 },
    { inPerMTok: 1 },
    { inPerMTok: Number.NaN, outPerMTok: 2 },
    { inPerMTok: 1, outPerMTok: 2, extra: 1 },
    { free: false },
    {},
  ])('rejects %j', (v) => {
    expect(PriceEntry.safeParse(v).success).toBe(false);
  });
});

describe('parseOpenRouterPricing', () => {
  it('converts per-token strings to per-million prices incl. cache and reasoning', () => {
    const p = parseOpenRouterPricing({
      prompt: '0.000003',
      completion: '0.000015',
      input_cache_read: '0.0000003',
      input_cache_write: '0.00000375',
      internal_reasoning: '0.00001',
    });
    expect(p).toEqual({
      inPerMTok: expect.closeTo(3, 9),
      outPerMTok: expect.closeTo(15, 9),
      cacheReadPerMTok: expect.closeTo(0.3, 9),
      cacheWritePerMTok: expect.closeTo(3.75, 9),
      reasoningPerMTok: expect.closeTo(10, 9),
    });
  });

  it('treats "0" prompt and completion as free', () => {
    expect(parseOpenRouterPricing({ prompt: '0', completion: '0' })).toEqual({ free: true });
  });

  it.each([
    {},
    { prompt: '0.000003' },
    { prompt: '-1', completion: '1' },
    { prompt: 'abc', completion: '1' },
    { prompt: '-1', completion: '-1' },
  ])('returns undefined for unusable pricing %j (the model stays unpriced)', (v) => {
    expect(parseOpenRouterPricing(v)).toBeUndefined();
  });
});

describe('image prices', () => {
  it('prices per image from a separate table', () => {
    expect(costOfImages({ 'img-model': 0.04 }, 'img-model', 3)).toBeCloseTo(0.12, 9);
  });

  it('is undefined for an unpriced image model', () => {
    expect(costOfImages({}, 'img-model', 1)).toBeUndefined();
  });
});
