// A fake of Anthropic's prompt cache accounting (D-76), for tests and the before/after measurement.
// The request is cut into content blocks in Anthropic's prefix order (tools → system → message
// parts). A `cacheControl` breakpoint caches the prefix up to its block when that prefix has at
// least MIN_TOKENS; a later request reads the longest cached prefix found at or up to 19 blocks
// before one of its breakpoints. Usage comes back in the AI SDK's Anthropic shape: `total` is all
// input, of which `cacheRead` was read and `cacheWrite` written, the rest (`noCache`) fresh.
import { createHash } from 'node:crypto';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { estimateTokens } from '../../src/providers/tool-cost.ts';

export const MIN_TOKENS = 1024;
const LOOKBACK = 20;

interface Block {
  json: string;
  breakpoint: boolean;
}

const hasCacheControl = (po: unknown): boolean =>
  (po as { anthropic?: { cacheControl?: unknown } } | undefined)?.anthropic?.cacheControl !==
  undefined;

/** The request as blocks, without the provider options (they are not part of the cached text). */
export function blocksOf(o: LanguageModelV4CallOptions): Block[] {
  const blocks: Block[] = [];
  for (const t of o.tools ?? []) {
    const { providerOptions, ...rest } = t as typeof t & { providerOptions?: unknown };
    blocks.push({ json: JSON.stringify(rest), breakpoint: hasCacheControl(providerOptions) });
  }
  for (const m of o.prompt) {
    if (m.role === 'system') {
      blocks.push({
        json: JSON.stringify({ system: m.content }),
        breakpoint: hasCacheControl(m.providerOptions),
      });
      continue;
    }
    m.content.forEach((part, i) => {
      const { providerOptions, ...rest } = part as typeof part & { providerOptions?: unknown };
      const last = i === m.content.length - 1;
      blocks.push({
        json: JSON.stringify({ role: m.role, ...rest }),
        breakpoint:
          hasCacheControl(providerOptions) || (last && hasCacheControl(m.providerOptions)),
      });
    });
  }
  return blocks;
}

export interface CacheUsage {
  total: number;
  noCache: number;
  cacheRead: number;
  cacheWrite: number;
}

export class AnthropicCacheSim {
  readonly #cached = new Set<string>();
  readonly requests: CacheUsage[] = [];

  usage(o: LanguageModelV4CallOptions): CacheUsage {
    const blocks = blocksOf(o);
    const tokens = blocks.map((b) => estimateTokens(b.json));
    const hashes: string[] = [];
    const upTo: number[] = [];
    let h = '';
    let sum = 0;
    for (const [i, b] of blocks.entries()) {
      h = createHash('sha256').update(h).update(b.json).digest('hex');
      hashes.push(h);
      sum += tokens[i]!;
      upTo.push(sum);
    }
    const total = sum;
    const bps = blocks.flatMap((b, i) => (b.breakpoint ? [i] : []));
    let readEnd = -1;
    for (const b of bps) {
      for (let j = b; j >= Math.max(0, b - LOOKBACK + 1); j--) {
        if (this.#cached.has(hashes[j]!)) {
          readEnd = Math.max(readEnd, j);
          break;
        }
      }
    }
    const read = readEnd >= 0 ? upTo[readEnd]! : 0;
    let write = 0;
    const lastBp = bps.at(-1);
    if (lastBp !== undefined && lastBp > readEnd && upTo[lastBp]! >= MIN_TOKENS) {
      write = upTo[lastBp]! - read;
    }
    for (const b of bps) if (upTo[b]! >= MIN_TOKENS) this.#cached.add(hashes[b]!);
    const u = { total, noCache: total - read - write, cacheRead: read, cacheWrite: write };
    this.requests.push(u);
    return u;
  }

  /** The usage in the AI SDK model shape, for a scripted mock model. */
  modelUsage(o: LanguageModelV4CallOptions) {
    const u = this.usage(o);
    return {
      inputTokens: u,
      outputTokens: { total: 20, text: 20, reasoning: 0 },
    };
  }

  totals(): CacheUsage {
    return this.requests.reduce(
      (a, u) => ({
        total: a.total + u.total,
        noCache: a.noCache + u.noCache,
        cacheRead: a.cacheRead + u.cacheRead,
        cacheWrite: a.cacheWrite + u.cacheWrite,
      }),
      { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    );
  }
}
