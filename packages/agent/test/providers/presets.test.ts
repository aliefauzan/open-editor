import { describe, expect, test } from 'vitest';
import {
  PRESETS,
  ProviderEntry,
  presetIds,
  providerEntryFromPreset,
  requiresKey,
} from '../../src/providers/presets.ts';

describe('provider presets (agent spec "Providers and models", D-10)', () => {
  test('the spec presets plus openai and gemini exist', () => {
    expect([...presetIds]).toEqual([
      'claude',
      'openrouter',
      'opencode-zen',
      '9router',
      'lmstudio',
      'ollama',
      'apple',
      'openai',
      'gemini',
    ]);
  });

  test.each([
    ['claude', 'anthropic', 'https://api.anthropic.com/v1'],
    ['openrouter', 'openrouter', 'https://openrouter.ai/api/v1'],
    ['opencode-zen', 'openai-compatible', 'https://opencode.ai/zen/v1'],
    ['9router', 'openai-compatible', 'http://localhost:20128/v1'],
    ['lmstudio', 'openai-compatible', 'http://localhost:1234/v1'],
    ['ollama', 'ollama', 'http://localhost:11434'],
    ['openai', 'openai', 'https://api.openai.com/v1'],
    ['gemini', 'google', 'https://generativelanguage.googleapis.com/v1beta'],
  ] as const)('%s fills type %s and base URL %s', (preset, type, baseUrl) => {
    expect(PRESETS[preset].type).toBe(type);
    expect(PRESETS[preset].baseUrl).toBe(baseUrl);
    const entry = providerEntryFromPreset(preset);
    expect(entry).toMatchObject({ id: preset, type, preset, baseUrl });
  });

  test('apple has no base URL', () => {
    expect(PRESETS.apple.type).toBe('apple');
    expect(PRESETS.apple.baseUrl).toBeUndefined();
    expect(providerEntryFromPreset('apple')).toEqual({
      id: 'apple',
      type: 'apple',
      preset: 'apple',
    });
  });

  test.each(['lmstudio', 'ollama', 'apple'] as const)('keyless preset %s stores no apiKey', (p) => {
    const entry = providerEntryFromPreset(p);
    expect(entry).not.toHaveProperty('apiKey');
    expect(requiresKey(entry)).toBe(false);
  });

  test.each(['claude', 'openrouter', 'opencode-zen', '9router', 'openai', 'gemini'] as const)(
    'keyed preset %s stores a keychain reference to its own id',
    (p) => {
      expect(providerEntryFromPreset(p).apiKey).toBe(`keychain:${p}`);
      expect(providerEntryFromPreset(p, { id: 'work' }).apiKey).toBe('keychain:work');
      expect(requiresKey(providerEntryFromPreset(p))).toBe(true);
    },
  );

  test('a custom id and an edited base URL are kept', () => {
    const entry = providerEntryFromPreset('9router', {
      id: 'router-2',
      baseUrl: 'http://127.0.0.1:20999/v1',
    });
    expect(entry).toEqual({
      id: 'router-2',
      type: 'openai-compatible',
      preset: '9router',
      baseUrl: 'http://127.0.0.1:20999/v1',
      apiKey: 'keychain:router-2',
    });
  });

  test('a base URL with credentials is rejected (S17)', () => {
    expect(() =>
      providerEntryFromPreset('9router', { baseUrl: 'http://user:pw@localhost:20128/v1' }),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  test('the base URL of a preset without one cannot be set', () => {
    expect(() => providerEntryFromPreset('apple', { baseUrl: 'http://localhost:1/v1' })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });

  test('an unsafe provider id is rejected', () => {
    expect(() => providerEntryFromPreset('claude', { id: '../x' })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });

  test('ProviderEntry keeps unknown fields and rejects an unknown type', () => {
    const parsed = ProviderEntry.parse({ id: 'x', type: 'ollama', extra: 1 });
    expect(parsed).toEqual({ id: 'x', type: 'ollama', extra: 1 });
    expect(ProviderEntry.safeParse({ id: 'x', type: 'bedrock' }).success).toBe(false);
  });

  test('ProviderEntry options: numCtx and contextTokens are positive integers', () => {
    expect(
      ProviderEntry.safeParse({
        id: 'o',
        type: 'ollama',
        options: { numCtx: 8192, contextTokens: { 'qwen3:8b': 40960 } },
      }).success,
    ).toBe(true);
    expect(
      ProviderEntry.safeParse({ id: 'o', type: 'ollama', options: { numCtx: 0 } }).success,
    ).toBe(false);
    expect(
      ProviderEntry.safeParse({ id: 'o', type: 'ollama', options: { contextTokens: { m: 1.5 } } })
        .success,
    ).toBe(false);
  });

  test('requiresKey: a generic openai-compatible entry without a preset needs no key', () => {
    const vllm: ProviderEntry = { id: 'vllm', type: 'openai-compatible', baseUrl: 'http://h/v1' };
    const anthropic: ProviderEntry = { id: 'a', type: 'anthropic' };
    expect(requiresKey(vllm)).toBe(false);
    expect(requiresKey(anthropic)).toBe(true);
  });
});
