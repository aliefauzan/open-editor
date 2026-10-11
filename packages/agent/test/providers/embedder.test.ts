// The `embed` role as a function (14b): Ollama and OpenRouter requests go to the right endpoint with the
// right model; the vectors come back in order; a provider that cannot embed is CONFIG_INVALID.
import { describe, expect, test } from 'vitest';
import { createEmbedder } from '../../src/providers/factory.ts';
import { providerEntryFromPreset } from '../../src/providers/presets.ts';
import { CANARY_KEY } from '../helpers/canary.ts';

function fakeFetch(reply: (url: string, body: Record<string, unknown>) => unknown) {
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const f = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, body, headers: new Headers(init?.headers) });
    return Promise.resolve(
      new Response(JSON.stringify(reply(url, body)), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  return { f, calls };
}

describe('createEmbedder', () => {
  test('ollama: /api/embed with the model and the texts', async () => {
    const { f, calls } = fakeFetch(() => ({
      embeddings: [
        [1, 0],
        [0, 1],
      ],
      model: 'nomic-embed-text',
      total_duration: 1,
      load_duration: 1,
      prompt_eval_count: 2,
    }));
    const embed = createEmbedder(providerEntryFromPreset('ollama'), 'nomic-embed-text', {
      apiKey: null,
      fetch: f,
    });
    expect(await embed(['a', 'b'])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(calls[0]!.url).toBe('http://localhost:11434/api/embed');
    expect(calls[0]!.body).toMatchObject({ model: 'nomic-embed-text', input: ['a', 'b'] });
  });

  test('openrouter: /embeddings with the key', async () => {
    const { f, calls } = fakeFetch(() => ({
      data: [{ index: 0, embedding: [0.5, 0.5] }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }));
    const embed = createEmbedder(
      providerEntryFromPreset('openrouter'),
      'openai/text-embedding-3-small',
      {
        apiKey: CANARY_KEY,
        fetch: f,
      },
    );
    expect(await embed(['a'])).toEqual([[0.5, 0.5]]);
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${CANARY_KEY}`);
    expect(calls[0]!.body).toMatchObject({ model: 'openai/text-embedding-3-small' });
  });

  test('a provider that cannot embed, or no key: CONFIG_INVALID', () => {
    expect(() =>
      createEmbedder(providerEntryFromPreset('claude'), 'x', { apiKey: CANARY_KEY }),
    ).toThrow(/cannot embed/);
    expect(() =>
      createEmbedder(providerEntryFromPreset('openrouter'), 'x', { apiKey: null }),
    ).toThrow(/needs an API key/);
  });
});
