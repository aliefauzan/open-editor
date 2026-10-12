// Anthropic prompt caching (D-76). Only Anthropic models get cache breakpoints, directly or through
// OpenRouter (which passes `cache_control` through for `anthropic/*` models) or OpenCode Zen
// (which routes `claude-*` models to the Anthropic package). Every other provider gets the request
// exactly as before: the helpers below return their inputs untouched when there is no target.
//
// Breakpoints (Anthropic allows 4 per request; the order of the cached prefix is tools → system →
// messages):
//   1. the last tool definition (the tool list survives a system prompt change after compaction),
//   2. the system prompt,
//   3. the end of the history the previous request ended on (a sure hit even when a step added
//      more than Anthropic's 20-block lookback),
//   4. the end of the history (rolling: the next step reads everything up to here).
// The per-step state block goes after breakpoint 4 (`withInjection`), so it is never cached.
import type { ModelMessage, SystemModelMessage, ToolSet } from 'ai';
import type { PriceEntry, ProviderKind } from './prices.ts';

export type CacheTarget = 'anthropic';

/** Anthropic's 5-minute cache: a write costs 1.25 × input, a read 0.1 × input. */
export const ANTHROPIC_CACHE_WRITE_FACTOR = 1.25;
export const ANTHROPIC_CACHE_READ_FACTOR = 0.1;

const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' } } } as const;

/** The caching scheme for a role's model, or undefined when the provider gets no breakpoints. */
export function promptCacheTarget(role: {
  provider: ProviderKind;
  modelId: string;
}): CacheTarget | undefined {
  const { provider, modelId } = role;
  if (provider.type === 'anthropic') return 'anthropic';
  if (provider.type === 'openrouter' && modelId.startsWith('anthropic/')) return 'anthropic';
  if (
    provider.type === 'openai-compatible' &&
    provider.preset === 'opencode-zen' &&
    modelId.startsWith('claude-') // zenFamily() in factory.ts
  )
    return 'anthropic';
  return undefined;
}

/**
 * The price with Anthropic's cache rates filled in where the table has none: without them a cache
 * write would be billed at the plain input price (an undercount of 25 %). Prices the table or
 * OpenRouter give are kept. Other providers and free entries come back unchanged.
 */
export function withCachePrices(target: CacheTarget | undefined, price: PriceEntry): PriceEntry {
  if (target !== 'anthropic' || 'free' in price) return price;
  return {
    ...price,
    cacheWritePerMTok: price.cacheWritePerMTok ?? price.inPerMTok * ANTHROPIC_CACHE_WRITE_FACTOR,
    cacheReadPerMTok: price.cacheReadPerMTok ?? price.inPerMTok * ANTHROPIC_CACHE_READ_FACTOR,
  };
}

/** The system prompt as a message with a breakpoint (Anthropic), else the string as it was. */
export function cachedSystem(
  target: CacheTarget | undefined,
  system: string,
): string | SystemModelMessage {
  if (target === undefined) return system;
  return { role: 'system', content: system, providerOptions: EPHEMERAL };
}

/** The tool set with a breakpoint on its last tool (Anthropic), else the same object. */
export function cachedTools(target: CacheTarget | undefined, tools: ToolSet): ToolSet {
  const names = Object.keys(tools);
  const last = names.at(-1);
  if (target === undefined || last === undefined) return tools;
  return { ...tools, [last]: { ...tools[last], providerOptions: EPHEMERAL } as ToolSet[string] };
}

/** One message with the breakpoint on its last part (string content becomes one text part). */
function markLast(message: ModelMessage): ModelMessage {
  switch (message.role) {
    case 'system':
      return { ...message, providerOptions: EPHEMERAL };
    case 'user':
    case 'assistant': {
      const parts =
        typeof message.content === 'string'
          ? [{ type: 'text' as const, text: message.content }]
          : message.content;
      if (parts.length === 0) return message;
      const last = { ...parts.at(-1)!, providerOptions: EPHEMERAL };
      return { ...message, content: [...parts.slice(0, -1), last] } as ModelMessage;
    }
    case 'tool': {
      if (message.content.length === 0) return message;
      const last = { ...message.content.at(-1)!, providerOptions: EPHEMERAL };
      return { ...message, content: [...message.content.slice(0, -1), last] };
    }
  }
}

/**
 * The history with breakpoints 3 and 4 (Anthropic): on the last message, and on the message just
 * before the last assistant message (where the previous request's history ended). Other targets
 * get the same array back. Call it on the history only, before the state block is added.
 */
export function cachedHistory(
  target: CacheTarget | undefined,
  messages: ModelMessage[],
): ModelMessage[] {
  if (target === undefined || messages.length === 0) return messages;
  const out = [...messages];
  const lastAssistant = out.findLastIndex((m) => m.role === 'assistant');
  const prev = lastAssistant - 1;
  if (prev >= 0 && prev < out.length - 1) out[prev] = markLast(out[prev]!);
  out[out.length - 1] = markLast(out[out.length - 1]!);
  return out;
}
