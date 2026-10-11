// Provider presets and the provider entry shape (agent spec "Providers and models" and
// "Configuration and keys", D-10). A preset fills the type and base URL; the user only adds a key.
// Entries are read and written through the engine config module in phase 11; this file only
// defines their shape and builds new ones.
import { z } from 'zod';
import { VoxError } from '../errors.ts';
import { assertSafeBaseUrl, formatKeyRef } from '../config/mask.ts';

export const providerTypes = [
  'openrouter',
  'anthropic',
  'openai',
  'google',
  'ollama',
  'openai-compatible',
  'apple',
] as const;
export const ProviderType = z.enum(providerTypes);
export type ProviderType = z.infer<typeof ProviderType>;

export const presetIds = [
  'claude',
  'openrouter',
  'opencode-zen',
  '9router',
  'lmstudio',
  'ollama',
  'apple',
  'openai',
  'gemini',
] as const;
export const PresetId = z.enum(presetIds);
export type PresetId = z.infer<typeof PresetId>;

export interface Preset {
  type: ProviderType;
  /** Default base URL (the provider's own default for cloud APIs); absent for Apple on-device. */
  baseUrl?: string;
  /** Keyed presets store `keychain:<id>`; keyless ones store no `apiKey`. */
  key: 'required' | 'none';
  label: string;
}

export const PRESETS: Readonly<Record<PresetId, Preset>> = {
  claude: {
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    key: 'required',
    label: 'Claude (Anthropic API key)',
  },
  openrouter: {
    type: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    key: 'required',
    label: 'OpenRouter',
  },
  // One key, several wire formats: the factory picks the package per model family (spec table).
  'opencode-zen': {
    type: 'openai-compatible',
    baseUrl: 'https://opencode.ai/zen/v1',
    key: 'required',
    label: 'OpenCode Zen',
  },
  '9router': {
    type: 'openai-compatible',
    baseUrl: 'http://localhost:20128/v1',
    key: 'required',
    label: '9router (local gateway)',
  },
  lmstudio: {
    type: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    key: 'none',
    label: 'LM Studio',
  },
  ollama: { type: 'ollama', baseUrl: 'http://localhost:11434', key: 'none', label: 'Ollama' },
  apple: { type: 'apple', key: 'none', label: 'Apple on-device model' },
  openai: {
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    key: 'required',
    label: 'OpenAI',
  },
  gemini: {
    type: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    key: 'required',
    label: 'Google Gemini',
  },
};

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const positiveInt = z.int().positive();

export const ProviderOptions = z.looseObject({
  /** Ollama `num_ctx`, sent on every request (default 32768). */
  numCtx: positiveInt.optional(),
  /** Context size per model id, for providers with no context endpoint (D-38). */
  contextTokens: z.record(z.string().min(1), positiveInt).optional(),
});
export type ProviderOptions = z.infer<typeof ProviderOptions>;

/**
 * One `providers[]` entry of `~/.vox/config.json`. Unknown fields are kept (the engine config
 * module never drops another writer's fields). `apiKey` is a reference, never a key (S17).
 */
export const ProviderEntry = z.looseObject({
  id: z.string().regex(PROVIDER_ID),
  type: ProviderType,
  /** The preset the entry was created from (D-38); drives Zen routing and local pricing. */
  preset: PresetId.optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  options: ProviderOptions.optional(),
});
export type ProviderEntry = z.infer<typeof ProviderEntry>;

const invalid = (message: string, hint: string): VoxError =>
  new VoxError('CONFIG_INVALID', message, hint);

/** True when the entry cannot run without a key. A bare OpenAI-compatible entry may be keyless. */
export function requiresKey(entry: { type: ProviderType; preset?: PresetId | undefined }): boolean {
  if (entry.preset !== undefined) return PRESETS[entry.preset].key === 'required';
  return entry.type !== 'openai-compatible' && entry.type !== 'ollama' && entry.type !== 'apple';
}

/** A new entry from a preset: type, base URL and, for keyed presets, `keychain:<id>`. */
export function providerEntryFromPreset(
  presetId: PresetId,
  opts: { id?: string; baseUrl?: string } = {},
): ProviderEntry {
  const preset = PRESETS[presetId];
  const id = opts.id ?? presetId;
  if (!PROVIDER_ID.test(id)) {
    throw invalid(
      'provider id is not valid',
      'Use letters, digits, dot, dash or underscore, starting with a letter or digit.',
    );
  }
  if (opts.baseUrl !== undefined && preset.baseUrl === undefined) {
    throw invalid(`the ${presetId} preset has no base URL`, 'Remove the base URL.');
  }
  const baseUrl = opts.baseUrl ?? preset.baseUrl;
  if (baseUrl !== undefined) assertSafeBaseUrl(baseUrl);
  return {
    id,
    type: preset.type,
    preset: presetId,
    ...(baseUrl !== undefined && { baseUrl }),
    ...(preset.key === 'required' && {
      apiKey: formatKeyRef({ kind: 'keychain', providerId: id }),
    }),
  };
}
