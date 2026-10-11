// Each preset builds the right model object and base URL (phase 11 step 11). The model's first
// request is captured by an injected fetch and never sent: no network in fast tests.
import { describe, expect, test, vi } from 'vitest';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { captureRequest, type CapturedRequest } from '../../src/providers/capture.ts';
import {
  createLanguageModel,
  OLLAMA_DEFAULT_NUM_CTX,
  resolveEntryKey,
  zenFamily,
} from '../../src/providers/factory.ts';
import {
  providerEntryFromPreset,
  type PresetId,
  type ProviderEntry,
} from '../../src/providers/presets.ts';
import type { Keychain } from '../../src/config/keychain.ts';
import { CANARY_KEY } from '../helpers/canary.ts';

const KEY = CANARY_KEY;

async function firstRequest(
  entry: ProviderEntry,
  modelId: string,
  apiKey: string | null,
): Promise<CapturedRequest> {
  return captureRequest((fetch) => createLanguageModel(entry, modelId, { apiKey, fetch }), {
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  });
}

const preset = (p: PresetId, opts?: { id?: string; baseUrl?: string }) =>
  providerEntryFromPreset(p, opts);

describe('createLanguageModel: presets', () => {
  test('claude → Anthropic messages API with x-api-key', async () => {
    const r = await firstRequest(preset('claude'), 'claude-sonnet-4-5', KEY);
    expect(r.url).toBe('https://api.anthropic.com/v1/messages');
    expect(r.headers['x-api-key']).toBe(KEY);
    expect(r.body).toMatchObject({ model: 'claude-sonnet-4-5' });
  });

  test('openrouter → chat completions, bearer key, usage accounting on', async () => {
    const r = await firstRequest(preset('openrouter'), 'qwen/qwen3-coder', KEY);
    expect(r.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(r.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(r.body).toMatchObject({ model: 'qwen/qwen3-coder', usage: { include: true } });
  });

  test('openai → responses API', async () => {
    const r = await firstRequest(preset('openai'), 'gpt-5-mini', KEY);
    expect(r.url).toBe('https://api.openai.com/v1/responses');
    expect(r.headers['authorization']).toBe(`Bearer ${KEY}`);
  });

  test('gemini → generateContent with x-goog-api-key', async () => {
    const r = await firstRequest(preset('gemini'), 'gemini-2.5-flash', KEY);
    expect(r.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    expect(r.headers['x-goog-api-key']).toBe(KEY);
  });

  test.each([
    ['claude-sonnet-4-5', 'anthropic', 'https://opencode.ai/zen/v1/messages', 'x-api-key'],
    ['gpt-5.1-codex', 'openai', 'https://opencode.ai/zen/v1/responses', 'authorization'],
    [
      'gemini-3-pro',
      'google',
      'https://opencode.ai/zen/v1/models/gemini-3-pro:generateContent',
      'x-goog-api-key',
    ],
    [
      'qwen3-coder',
      'openai-compatible',
      'https://opencode.ai/zen/v1/chat/completions',
      'authorization',
    ],
  ] as const)('opencode-zen routes %s to %s (%s)', async (model, family, url, header) => {
    expect(zenFamily(model)).toBe(family);
    const r = await firstRequest(preset('opencode-zen'), model, KEY);
    expect(r.url).toBe(url);
    expect(r.headers[header]).toContain(KEY);
  });

  test('9router → its local OpenAI-compatible URL with a bearer key', async () => {
    const r = await firstRequest(preset('9router'), 'cc/claude-sonnet', KEY);
    expect(r.url).toBe('http://localhost:20128/v1/chat/completions');
    expect(r.headers['authorization']).toBe(`Bearer ${KEY}`);
  });

  test('9router with an edited base URL uses it', async () => {
    const entry = preset('9router', { baseUrl: 'http://127.0.0.1:20999/v1/' });
    const r = await firstRequest(entry, 'm', KEY);
    expect(r.url).toBe('http://127.0.0.1:20999/v1/chat/completions');
  });

  test('lmstudio → localhost:1234 with no Authorization header', async () => {
    const r = await firstRequest(preset('lmstudio'), 'qwen3-8b', null);
    expect(r.url).toBe('http://localhost:1234/v1/chat/completions');
    expect(r.headers).not.toHaveProperty('authorization');
  });

  test('ollama → /api/chat with num_ctx 32768 by default', async () => {
    const r = await firstRequest(preset('ollama'), 'qwen3:8b', null);
    expect(r.url).toBe('http://localhost:11434/api/chat');
    expect(r.body).toMatchObject({
      model: 'qwen3:8b',
      options: { num_ctx: OLLAMA_DEFAULT_NUM_CTX },
    });
    expect(OLLAMA_DEFAULT_NUM_CTX).toBe(32768);
  });

  test('ollama sends the configured numCtx and accepts a base URL ending in /api', async () => {
    const entry: ProviderEntry = {
      ...preset('ollama', { baseUrl: 'http://127.0.0.1:11434/api/' }),
      options: { numCtx: 8192 },
    };
    const r = await firstRequest(entry, 'qwen3:8b', null);
    expect(r.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(r.body).toMatchObject({ options: { num_ctx: 8192 } });
  });

  test('ollama keeps caller options and still forces num_ctx', async () => {
    const r = await captureRequest(
      (fetch) => createLanguageModel(preset('ollama'), 'qwen3:8b', { apiKey: null, fetch }),
      {
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        providerOptions: { ollama: { options: { num_ctx: 1, top_k: 5 } } },
      },
    );
    expect(r.body).toMatchObject({ options: { num_ctx: OLLAMA_DEFAULT_NUM_CTX, top_k: 5 } });
  });

  test('a generic openai-compatible entry without a preset may be keyless', async () => {
    const entry: ProviderEntry = {
      id: 'vllm',
      type: 'openai-compatible',
      baseUrl: 'http://h:8000/v1',
    };
    const r = await firstRequest(entry, 'm', null);
    expect(r.url).toBe('http://h:8000/v1/chat/completions');
    expect(r.headers).not.toHaveProperty('authorization');
  });

  test('apple builds the on-device model (no fetch, no key)', () => {
    const model = createLanguageModel(preset('apple'), 'system', {
      apiKey: null,
      apple: { command: '/nonexistent/vox-apple-llm' },
    });
    expect(model.specificationVersion).toBe('v4');
    expect(model.provider).toBe('apple');
  });
});

describe('createLanguageModel: refusals', () => {
  const build = (entry: ProviderEntry, apiKey: string | null): LanguageModelV4 =>
    createLanguageModel(entry, 'm', { apiKey, fetch: vi.fn() });

  test.each(['claude', 'openrouter', 'opencode-zen', '9router', 'openai', 'gemini'] as const)(
    'keyed preset %s without a key fails (no env fallback)',
    (p) => {
      expect(() => build(preset(p), null)).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
      expect(() => build(preset(p), '')).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
    },
  );

  test('a base URL with credentials is rejected before any request (S17)', () => {
    const entry: ProviderEntry = {
      id: 'x',
      type: 'openai-compatible',
      baseUrl: 'https://h/v1?api_key=abc',
    };
    expect(() => build(entry, null)).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  test('an openai-compatible entry needs a base URL', () => {
    expect(() => build({ id: 'x', type: 'openai-compatible' }, null)).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });

  test('apple needs the helper command', () => {
    expect(() => build(preset('apple'), null)).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });

  test('an empty model id is rejected', () => {
    expect(() => createLanguageModel(preset('claude'), '', { apiKey: KEY })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });
});

describe('resolveEntryKey', () => {
  const keychain = (
    stored: Record<string, string>,
  ): Keychain & { get: ReturnType<typeof vi.fn> } => ({
    get: vi.fn(async (id: string) => stored[id] ?? null),
    set: vi.fn(),
    remove: vi.fn(),
  });

  test('a keyless entry resolves to null without touching the Keychain', async () => {
    const kc = keychain({});
    expect(await resolveEntryKey(preset('ollama'), { keychain: kc, env: {} })).toBeNull();
    expect(kc.get).not.toHaveBeenCalled();
  });

  test('a keyed entry reads its own Keychain item and reports the key once', async () => {
    const kc = keychain({ claude: KEY });
    const onKey = vi.fn();
    const key = await resolveEntryKey(preset('claude'), { keychain: kc, env: {}, onKey });
    expect(key).toBe(KEY);
    expect(kc.get).toHaveBeenCalledWith('claude');
    expect(onKey).toHaveBeenCalledExactlyOnceWith(KEY);
  });

  test('an env: reference reads the environment', async () => {
    const entry: ProviderEntry = { ...preset('openrouter'), apiKey: 'env:OPENROUTER_API_KEY' };
    const key = await resolveEntryKey(entry, {
      keychain: keychain({}),
      env: { OPENROUTER_API_KEY: KEY },
    });
    expect(key).toBe(KEY);
  });

  test('a keyed entry with no stored key fails with a hint', async () => {
    await expect(
      resolveEntryKey(preset('openrouter'), { keychain: keychain({}), env: {} }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(
      resolveEntryKey({ id: 'a', type: 'anthropic' }, { keychain: keychain({}), env: {} }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  test('a keychain: reference to another provider is refused', async () => {
    const entry: ProviderEntry = { ...preset('claude'), apiKey: 'keychain:openrouter' };
    await expect(
      resolveEntryKey(entry, { keychain: keychain({ openrouter: KEY }), env: {} }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  test('a raw key in apiKey is refused and not echoed', async () => {
    const entry: ProviderEntry = { ...preset('claude'), apiKey: KEY };
    const err = await resolveEntryKey(entry, { keychain: keychain({}), env: {} }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(JSON.stringify(err) + String(err)).not.toContain(KEY);
  });
});
