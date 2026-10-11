// Context-size detection for the capability probe (agent spec "Capability probe" → context):
// OpenRouter's models endpoint (`context_length`), Ollama `/api/show` plus the `num_ctx` the agent
// sends, Apple `--status`; every other provider uses the entry's `options.contextTokens` (D-38).
import { z } from 'zod';
import { assertSafeBaseUrl } from '../config/mask.ts';
import { VoxError } from '../errors.ts';
import { parseOpenRouterPricing, type PriceEntry } from './prices.ts';
import { appleStatus, type AppleModelOptions } from './apple.ts';
import type { FetchFunction } from './capture.ts';
import { OLLAMA_DEFAULT_NUM_CTX } from './factory.ts';
import { PRESETS, type ProviderEntry } from './presets.ts';

const FETCH_TIMEOUT_MS = 15_000;
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const OLLAMA_ROOT = 'http://localhost:11434';

export interface ContextInfo {
  /** Effective context in tokens, or null when unknown. */
  contextTokens: number | null;
  source: 'openrouter' | 'ollama' | 'apple' | 'config' | 'unknown';
  /** What the provider advertises (OpenRouter, Ollama). */
  advertised?: number;
  /** Ollama: the `num_ctx` sent on every request. */
  numCtx?: number;
  /** Why detection failed (a code, never provider text). */
  error?: string;
}

const probeFailed = (message: string, hint: string): VoxError =>
  new VoxError('PROBE_FAILED', message, hint);

const positiveInt = z.int().positive();

const OpenRouterModel = z.looseObject({
  id: z.string().min(1),
  context_length: positiveInt.nullable().optional(),
  pricing: z.record(z.string(), z.unknown()).optional(),
  architecture: z
    .looseObject({
      input_modalities: z.array(z.string()).optional(),
      output_modalities: z.array(z.string()).optional(),
    })
    .optional(),
  supported_parameters: z.array(z.string()).optional(),
});

export interface OpenRouterModelInfo {
  id: string;
  contextLength: number | null;
  /** From `pricing`; undefined leaves the model unpriced (G1 `parseOpenRouterPricing`). */
  price: PriceEntry | undefined;
  inputModalities: string[];
  outputModalities: string[];
  supportsTools: boolean;
}

/** Parses OpenRouter's `GET /models` body. Entries that do not parse are skipped. */
export function parseOpenRouterModels(body: unknown): Map<string, OpenRouterModelInfo> {
  const list = z.looseObject({ data: z.array(z.unknown()) }).safeParse(body);
  if (!list.success) {
    throw probeFailed(
      'the OpenRouter models list has an unexpected shape',
      'Try the probe again later.',
    );
  }
  const out = new Map<string, OpenRouterModelInfo>();
  for (const raw of list.data.data) {
    const m = OpenRouterModel.safeParse(raw);
    if (!m.success) continue;
    const { id, architecture, pricing } = m.data;
    out.set(id, {
      id,
      contextLength: m.data.context_length ?? null,
      price: pricing ? parseOpenRouterPricing(pricing) : undefined,
      inputModalities: architecture?.input_modalities ?? [],
      outputModalities: architecture?.output_modalities ?? [],
      supportsTools: m.data.supported_parameters?.includes('tools') ?? false,
    });
  }
  return out;
}

interface HttpDeps {
  fetch?: FetchFunction;
  signal?: AbortSignal;
}

async function getJson(url: string, init: RequestInit, deps: HttpDeps): Promise<unknown> {
  // Same rule as the factory: http(s) only, no credentials in the URL (they would reach logs).
  const host = assertSafeBaseUrl(url).host;
  const doFetch = deps.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      ...init,
      signal: deps.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw probeFailed(`could not reach ${host}`, 'Check the connection and the base URL.');
  }
  if (!res.ok) {
    throw probeFailed(
      `${host} answered HTTP ${String(res.status)}`,
      'Check the base URL and the model name.',
    );
  }
  try {
    return (await res.json()) as unknown;
  } catch {
    throw probeFailed(`${host} did not answer JSON`, 'Check the base URL.');
  }
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** `GET <base>/models` (public; no key is sent). */
export async function fetchOpenRouterModels(
  deps: HttpDeps & { baseUrl?: string } = {},
): Promise<Map<string, OpenRouterModelInfo>> {
  const base = trimSlash(deps.baseUrl ?? OPENROUTER_BASE);
  return parseOpenRouterModels(await getJson(`${base}/models`, { method: 'GET' }, deps));
}

/** Ollama `/api/show`: `<architecture>.context_length` from `model_info`, and `capabilities`. */
export function parseOllamaShow(body: unknown): {
  contextLength: number | null;
  capabilities: string[];
} {
  const parsed = z
    .looseObject({
      model_info: z.record(z.string(), z.unknown()).optional(),
      capabilities: z.array(z.string()).optional(),
    })
    .safeParse(body);
  if (!parsed.success) return { contextLength: null, capabilities: [] };
  let contextLength: number | null = null;
  for (const [key, value] of Object.entries(parsed.data.model_info ?? {})) {
    if (key.endsWith('.context_length') && positiveInt.safeParse(value).success) {
      contextLength = value as number;
    }
  }
  return { contextLength, capabilities: parsed.data.capabilities ?? [] };
}

/** `POST <root>/api/show { model }`. `baseUrl` is the server root, as in the `ollama` preset. */
export async function fetchOllamaShow(
  deps: HttpDeps & { baseUrl?: string; model: string },
): Promise<{ contextLength: number | null; capabilities: string[] }> {
  const root = trimSlash(deps.baseUrl ?? OLLAMA_ROOT).replace(/\/api$/, '');
  const body = await getJson(
    `${root}/api/show`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: deps.model }),
    },
    deps,
  );
  return parseOllamaShow(body);
}

export interface ContextDeps extends HttpDeps {
  /** For `apple` entries. */
  apple?: AppleModelOptions;
  /** A models list already fetched for this probe run (OpenRouter). */
  openRouterModels?: Map<string, OpenRouterModelInfo>;
}

const codeOf = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'PROBE_FAILED';
};

function fromConfig(entry: ProviderEntry, modelId: string): ContextInfo {
  const n = entry.options?.contextTokens?.[modelId];
  return n === undefined || !Object.hasOwn(entry.options?.contextTokens ?? {}, modelId)
    ? { contextTokens: null, source: 'unknown' }
    : { contextTokens: n, source: 'config' };
}

/** The effective context of `modelId` on `entry`. Never throws for an unreachable provider. */
export async function detectContext(
  entry: ProviderEntry,
  modelId: string,
  deps: ContextDeps = {},
): Promise<ContextInfo> {
  const baseUrl =
    entry.baseUrl ?? (entry.preset !== undefined ? PRESETS[entry.preset].baseUrl : undefined);
  switch (entry.type) {
    case 'openrouter': {
      let advertised: number | null = null;
      let error: string | undefined;
      try {
        const models =
          deps.openRouterModels ??
          (await fetchOpenRouterModels({ ...deps, ...(baseUrl !== undefined && { baseUrl }) }));
        advertised = models.get(modelId)?.contextLength ?? null;
      } catch (err) {
        error = codeOf(err);
      }
      if (advertised !== null)
        return { contextTokens: advertised, source: 'openrouter', advertised };
      const config = fromConfig(entry, modelId);
      return error !== undefined && config.source === 'unknown' ? { ...config, error } : config;
    }
    case 'ollama': {
      const numCtx = entry.options?.numCtx ?? OLLAMA_DEFAULT_NUM_CTX;
      try {
        const show = await fetchOllamaShow({
          ...deps,
          ...(baseUrl !== undefined && { baseUrl }),
          model: modelId,
        });
        if (show.contextLength === null) return { contextTokens: numCtx, source: 'ollama', numCtx };
        return {
          contextTokens: Math.min(show.contextLength, numCtx),
          source: 'ollama',
          advertised: show.contextLength,
          numCtx,
        };
      } catch (err) {
        return { contextTokens: null, source: 'unknown', numCtx, error: codeOf(err) };
      }
    }
    case 'apple': {
      if (deps.apple === undefined)
        return { contextTokens: null, source: 'unknown', error: 'APPLE_UNAVAILABLE' };
      try {
        return { contextTokens: (await appleStatus(deps.apple)).contextSize, source: 'apple' };
      } catch (err) {
        return { contextTokens: null, source: 'unknown', error: codeOf(err) };
      }
    }
    default:
      return fromConfig(entry, modelId);
  }
}
