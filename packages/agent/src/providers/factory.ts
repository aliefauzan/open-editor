// Provider factory: a provider entry + a resolved key → a LanguageModelV4 (agent spec "Providers
// and models"). Keys come in as parameters; the SDKs' environment-variable fallbacks are never
// reached because a keyed provider without a key fails here first.
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { wrapLanguageModel } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import { UtilError } from '../errors.pending.ts';
import { assertSafeBaseUrl } from '../config/mask.ts';
import { resolveApiKey, type ResolveDeps } from '../config/keychain.ts';
import { createAppleLanguageModel, type AppleModelOptions } from './apple.ts';
import type { FetchFunction } from './capture.ts';
import { PRESETS, requiresKey, type ProviderEntry } from './presets.ts';

export const OLLAMA_DEFAULT_NUM_CTX = 32768;

export interface ModelFactoryDeps {
  /** The resolved key (`resolveEntryKey`), or null for keyless entries. */
  apiKey: string | null;
  /** Injected fetch (tests, request capture). Defaults to the global fetch. */
  fetch?: FetchFunction;
  /** Required for `apple` entries: how to start the bundled helper. */
  apple?: AppleModelOptions;
}

const invalid = (message: string, hint: string): UtilError =>
  new UtilError('CONFIG_INVALID', message, hint);

export type ZenFamily = 'anthropic' | 'openai' | 'google' | 'openai-compatible';

/** OpenCode Zen's package per model family (Claude → messages, GPT → responses, Gemini → google). */
export function zenFamily(modelId: string): ZenFamily {
  if (modelId.startsWith('claude-')) return 'anthropic';
  if (modelId.startsWith('gpt-')) return 'openai';
  if (modelId.startsWith('gemini-')) return 'google';
  return 'openai-compatible';
}

function baseUrlOf(entry: ProviderEntry): string | undefined {
  const raw =
    entry.baseUrl ?? (entry.preset !== undefined ? PRESETS[entry.preset].baseUrl : undefined);
  if (raw === undefined) return undefined;
  assertSafeBaseUrl(raw);
  return raw.replace(/\/+$/, '');
}

/** Ollama's base URL is the server root (`http://localhost:11434`); the package wants `/api`. */
function ollamaApiUrl(base: string | undefined): string {
  const root = (base ?? 'http://localhost:11434').replace(/\/api$/, '');
  return `${root}/api`;
}

/** Sends `num_ctx` on every Ollama request, keeping the caller's other Ollama options. */
function withNumCtx(model: LanguageModelV4, numCtx: number): LanguageModelV4 {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      transformParams: ({ params }): Promise<LanguageModelV4CallOptions> => {
        const ollama = params.providerOptions?.['ollama'] ?? {};
        const options = ollama['options'];
        const merged = {
          ...(typeof options === 'object' && options !== null && !Array.isArray(options)
            ? options
            : {}),
          num_ctx: numCtx,
        };
        return Promise.resolve({
          ...params,
          providerOptions: { ...params.providerOptions, ollama: { ...ollama, options: merged } },
        });
      },
    },
  });
}

/** Builds the model for `modelId` on a provider entry. Throws `CONFIG_INVALID` on a bad entry. */
export function createLanguageModel(
  entry: ProviderEntry,
  modelId: string,
  deps: ModelFactoryDeps,
): LanguageModelV4 {
  if (modelId.trim() === '') throw invalid('model id is empty', 'Choose a model for this role.');
  const apiKey = deps.apiKey === '' ? null : deps.apiKey;
  if (apiKey === null && requiresKey(entry)) {
    throw invalid(
      `provider ${entry.id} needs an API key`,
      'Add the key in Settings or with `vox config providers add`.',
    );
  }
  const key = apiKey ?? undefined;
  const fetch = deps.fetch;
  const baseURL = baseUrlOf(entry);
  const common = { ...(baseURL !== undefined && { baseURL }), ...(fetch && { fetch }) };

  switch (entry.type) {
    case 'anthropic':
      return createAnthropic({ ...common, apiKey: key })(modelId);
    case 'openai':
      return createOpenAI({ ...common, apiKey: key }).responses(modelId);
    case 'google':
      return createGoogle({ ...common, apiKey: key })(modelId);
    case 'openrouter':
      return createOpenRouter({ ...common, apiKey: key, compatibility: 'strict' }).chat(modelId, {
        usage: { include: true },
      });
    case 'ollama': {
      const model = createOllama({ ...common, baseURL: ollamaApiUrl(baseURL) }).chat(modelId);
      return withNumCtx(model, entry.options?.numCtx ?? OLLAMA_DEFAULT_NUM_CTX);
    }
    case 'openai-compatible': {
      if (baseURL === undefined) {
        throw invalid(
          `provider ${entry.id} has no base URL`,
          'Enter the server URL, e.g. http://localhost:1234/v1.',
        );
      }
      if (entry.preset === 'opencode-zen') {
        const family = zenFamily(modelId);
        if (family === 'anthropic') return createAnthropic({ ...common, apiKey: key })(modelId);
        if (family === 'openai') return createOpenAI({ ...common, apiKey: key }).responses(modelId);
        if (family === 'google') return createGoogle({ ...common, apiKey: key })(modelId);
      }
      return createOpenAICompatible({
        ...common,
        baseURL,
        name: entry.preset ?? entry.id,
        ...(key !== undefined && { apiKey: key }),
        includeUsage: true,
      }).chatModel(modelId);
    }
    case 'apple':
      if (deps.apple === undefined) {
        throw invalid(
          'the Apple on-device helper is not available here',
          'The app ships `vox-apple-llm`; reinstall Vox Studio if it is missing.',
        );
      }
      return createAppleLanguageModel(deps.apple);
  }
}

export interface EntryKeyDeps extends ResolveDeps {
  /** Called with each key as soon as it is read (phase 11: `engine.redactor.addSecrets`). */
  onKey?: (key: string) => void;
}

/** Resolves an entry's `apiKey` reference. Keyless entries without a reference give null. */
export async function resolveEntryKey(
  entry: ProviderEntry,
  deps: EntryKeyDeps,
): Promise<string | null> {
  let key: string | null = null;
  if (entry.apiKey !== undefined) {
    key = await resolveApiKey(entry.apiKey, deps, entry.id);
    if (key === '') key = null;
  }
  if (key !== null) deps.onKey?.(key);
  if (key === null && requiresKey(entry)) {
    throw invalid(
      `no API key is stored for provider ${entry.id}`,
      'Add the key in Settings or with `vox config providers add`.',
    );
  }
  return key;
}
