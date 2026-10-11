// Context detection (agent spec "Capability probe" → context): OpenRouter `context_length`, Ollama
// `/api/show` plus the `num_ctx` the agent sends, Apple `--status`, else the entry's
// `options.contextTokens`. HTTP goes to an injected fetch; no network.
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import {
  detectContext,
  fetchOllamaShow,
  fetchOpenRouterModels,
  parseOllamaShow,
  parseOpenRouterModels,
} from '../../src/providers/context.ts';
import { providerEntryFromPreset, type ProviderEntry } from '../../src/providers/presets.ts';
import { CANARY_KEY } from '../helpers/canary.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-apple-llm.mjs', import.meta.url));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const OPENROUTER_MODELS = {
  data: [
    {
      id: 'qwen/qwen3-coder',
      context_length: 262144,
      pricing: { prompt: '0.0000002', completion: '0.0000008', input_cache_read: '0.00000002' },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['tools', 'tool_choice', 'response_format'],
    },
    {
      id: 'google/gemini-2.5-flash-image',
      context_length: 32768,
      pricing: { prompt: '0.0000003', completion: '0.0000025' },
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text', 'image'] },
      supported_parameters: [],
    },
    { id: 'broken/model', context_length: 'big' },
    { id: 'free/model', context_length: null, pricing: { prompt: '0', completion: '0' } },
  ],
};

const OLLAMA_SHOW = {
  model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 },
  capabilities: ['completion', 'tools', 'thinking'],
};

describe('OpenRouter models endpoint', () => {
  test('parses context, price, modalities and tools; skips broken entries', () => {
    const models = parseOpenRouterModels(OPENROUTER_MODELS);
    expect(models.get('qwen/qwen3-coder')).toEqual({
      id: 'qwen/qwen3-coder',
      contextLength: 262144,
      // G1 `parseOpenRouterPricing` multiplies per-token strings by 1e6 (float).
      price: {
        inPerMTok: expect.closeTo(0.2, 9),
        outPerMTok: expect.closeTo(0.8, 9),
        cacheReadPerMTok: expect.closeTo(0.02, 9),
      },
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: true,
    });
    expect(models.get('google/gemini-2.5-flash-image')).toMatchObject({
      inputModalities: ['text', 'image'],
      outputModalities: ['text', 'image'],
      supportsTools: false,
    });
    expect(models.has('broken/model')).toBe(false);
    expect(models.get('free/model')).toMatchObject({ contextLength: null, price: { free: true } });
  });

  test('a body that is not a model list fails', () => {
    expect(() => parseOpenRouterModels({ nope: 1 })).toThrow(
      expect.objectContaining({ code: 'PROBE_FAILED' }),
    );
  });

  test('fetches GET <base>/models without any key', async () => {
    const fetch = vi.fn(() => Promise.resolve(json(OPENROUTER_MODELS)));
    const models = await fetchOpenRouterModels({ fetch });
    expect(models.size).toBe(3);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/models');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  test('an HTTP error is PROBE_FAILED', async () => {
    const fetch = vi.fn(() => Promise.resolve(json({ error: 'x' }, 503)));
    await expect(fetchOpenRouterModels({ fetch })).rejects.toMatchObject({ code: 'PROBE_FAILED' });
  });
});

describe('Ollama /api/show', () => {
  test('parses <arch>.context_length and capabilities', () => {
    expect(parseOllamaShow(OLLAMA_SHOW)).toEqual({
      contextLength: 40960,
      capabilities: ['completion', 'tools', 'thinking'],
    });
    expect(parseOllamaShow({ model_info: {} })).toEqual({ contextLength: null, capabilities: [] });
  });

  test('POSTs {model} to <root>/api/show', async () => {
    const fetch = vi.fn(() => Promise.resolve(json(OLLAMA_SHOW)));
    await fetchOllamaShow({ baseUrl: 'http://localhost:11434/', model: 'qwen3:8b', fetch });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/show');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'qwen3:8b' });
  });
});

describe('detectContext', () => {
  test('openrouter: context_length from the models endpoint', async () => {
    const fetch = vi.fn(() => Promise.resolve(json(OPENROUTER_MODELS)));
    const c = await detectContext(providerEntryFromPreset('openrouter'), 'qwen/qwen3-coder', {
      fetch,
    });
    expect(c).toEqual({ contextTokens: 262144, source: 'openrouter', advertised: 262144 });
  });

  test('openrouter: a model missing from the list falls back to the entry, then unknown', async () => {
    const fetch = vi.fn(() => Promise.resolve(json(OPENROUTER_MODELS)));
    const entry: ProviderEntry = {
      ...providerEntryFromPreset('openrouter'),
      options: { contextTokens: { 'x/y': 64000 } },
    };
    expect(await detectContext(entry, 'x/y', { fetch })).toEqual({
      contextTokens: 64000,
      source: 'config',
    });
    expect(await detectContext(entry, 'x/z', { fetch })).toEqual({
      contextTokens: null,
      source: 'unknown',
    });
  });

  test('ollama: the smaller of the advertised context and num_ctx (default 32768)', async () => {
    const fetch = vi.fn(() => Promise.resolve(json(OLLAMA_SHOW)));
    expect(await detectContext(providerEntryFromPreset('ollama'), 'qwen3:8b', { fetch })).toEqual({
      contextTokens: 32768,
      source: 'ollama',
      advertised: 40960,
      numCtx: 32768,
    });
    const small: ProviderEntry = {
      ...providerEntryFromPreset('ollama'),
      options: { numCtx: 65536 },
    };
    expect(await detectContext(small, 'qwen3:8b', { fetch })).toMatchObject({
      contextTokens: 40960,
      numCtx: 65536,
    });
  });

  test('ollama: an unreachable server gives an unknown context with a reason', async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    expect(await detectContext(providerEntryFromPreset('ollama'), 'qwen3:8b', { fetch })).toEqual({
      contextTokens: null,
      source: 'unknown',
      numCtx: 32768,
      error: 'PROBE_FAILED',
    });
  });

  test('apple: the --status context size', async () => {
    const c = await detectContext(providerEntryFromPreset('apple'), 'apple-on-device', {
      apple: { command: process.execPath, args: [FAKE], env: { VOX_FAKE_APPLE_CONTEXT: '8192' } },
    });
    expect(c).toEqual({ contextTokens: 8192, source: 'apple' });
  });

  test.each(['claude', 'opencode-zen', '9router', 'lmstudio', 'openai', 'gemini'] as const)(
    '%s: options.contextTokens for the model, else unknown (no request sent)',
    async (preset) => {
      const fetch = vi.fn();
      const entry: ProviderEntry = {
        ...providerEntryFromPreset(preset),
        options: { contextTokens: { m1: 200000 } },
      };
      expect(await detectContext(entry, 'm1', { fetch })).toEqual({
        contextTokens: 200000,
        source: 'config',
      });
      expect(await detectContext(entry, 'm2', { fetch })).toEqual({
        contextTokens: null,
        source: 'unknown',
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test('a base URL with credentials is refused before any request', async () => {
    const fetch = vi.fn();
    const entry: ProviderEntry = {
      ...providerEntryFromPreset('ollama'),
      baseUrl: 'http://user:secret@localhost:11434',
    };
    const c = await detectContext(entry, 'qwen3:8b', { fetch });
    expect(c).toMatchObject({ contextTokens: null, source: 'unknown', error: 'CONFIG_INVALID' });
    expect(JSON.stringify(c)).not.toContain('secret');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('an error reason never carries a key', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error(`boom ${CANARY_KEY}`)));
    const c = await detectContext(providerEntryFromPreset('openrouter'), 'm', { fetch });
    expect(JSON.stringify(c)).not.toContain(CANARY_KEY);
  });
});
