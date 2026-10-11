// Agent settings in ~/.vox/config.json (agent spec "Configuration and keys", R4 S17, S18, S30).
// The file is read and written only through the engine's readConfig/writeConfig, which own the
// file, its 0600 mode and the fields other writers own (`contact`, `projectsDir`). Keys never go
// into the file: `apiKey` holds `keychain:<providerId>` or `env:NAME`, and a key typed by the
// user is written to the Keychain through `security -i` (stdin), never through argv.
import { readConfig, writeConfig, type Config, type ConfigPatch, type Redactor } from '@vox/engine';
import { z } from 'zod';
import { VoxError } from '../errors.ts';
import { PriceEntry, type PriceTable } from '../providers/prices.ts';
import type { PresetId, ProviderOptions } from '../providers/presets.ts';
import {
  PRESETS,
  ProviderEntry,
  providerEntryFromPreset,
  requiresKey,
} from '../providers/presets.ts';
import { ROLES, type Role, type RoleVerdict } from '../providers/roles.ts';
import { resolveApiKey, type Keychain } from './keychain.ts';
import { assertSafeBaseUrl, keyInputIsUnchanged, maskKey, parseKeyRef } from './mask.ts';

/** Agent spec "Configuration and keys": $2.00 per run, 60 steps per (sub-)run. */
export const DEFAULT_LIMITS = Object.freeze({ maxUsdPerRun: 2, maxStepsPerRun: 60 });

/** Agent spec "Cost tracking": every request sets `maxOutputTokens` from these (editable). */
export const DEFAULT_MAX_OUTPUT_TOKENS: Readonly<Record<Role, number>> = Object.freeze({
  editor: 8_000,
  vision: 2_000,
  fast: 2_000,
  image: 2_000,
  embed: 2_000,
});

/**
 * `env:NAME` references must name a variable ending in `_API_KEY` (phase-11 decision): a shared
 * config cannot point a provider at an unrelated secret such as `AWS_SECRET_ACCESS_KEY`.
 */
export const ENV_KEY_NAME = /^[A-Z][A-Z0-9_]*_API_KEY$/;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface RoleRef {
  providerId: string;
  model: string;
}

export interface Limits {
  maxUsdPerRun: number;
  maxStepsPerRun: number;
}

export interface AgentConfig {
  providers: ProviderEntry[];
  roles: Partial<Record<Role, RoleRef>>;
  limits: Limits;
  /** Per-role output caps (defaults above, overridden by config `maxOutputTokens`). */
  maxOutputTokens: Record<Role, number>;
  /** The user's price table (`prices` in config.json), keyed by model id. */
  prices: PriceTable;
}

/** How the config file is reached: the engine's readConfig/writeConfig (tests pass a VOX_HOME). */
export interface ConfigIO {
  read(): Promise<Config>;
  write(patch: ConfigPatch): Promise<Config>;
}

export function engineConfigIO(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConfigIO {
  return { read: () => readConfig(env), write: (patch) => writeConfig(patch, env) };
}

export interface AgentConfigDeps {
  io: ConfigIO;
  keychain: Keychain;
  env: Readonly<Record<string, string | undefined>>;
  /** Every key is registered here as soon as it is read or typed (S19). */
  redactor: Pick<Redactor, 'addSecrets'>;
}

const invalid = (message: string, hint: string, details?: Record<string, unknown>): VoxError =>
  new VoxError('CONFIG_INVALID', message, hint, details ? { details } : {});

const RoleRefSchema = z.looseObject({ providerId: z.string().min(1), model: z.string().min(1) });
const LimitsSchema = z.looseObject({
  maxUsdPerRun: z.number().positive().finite().optional(),
  maxStepsPerRun: z.int().positive().optional(),
});
const AgentSections = z.looseObject({
  providers: z.array(ProviderEntry).optional(),
  roles: z.record(z.string(), RoleRefSchema).optional(),
  limits: LimitsSchema.optional(),
  maxOutputTokens: z.record(z.string(), z.int().positive()).optional(),
  prices: z.record(z.string().min(1), PriceEntry).optional(),
});

/** Checks the stored key reference and base URL of one entry (S17). */
export function checkEntry(entry: ProviderEntry): void {
  if (entry.apiKey !== undefined) {
    const ref = parseKeyRef(entry.apiKey);
    if (ref === null) {
      throw invalid(
        `provider ${entry.id}: apiKey must be a reference (keychain:<id> or env:NAME), not a key`,
        'Save the key through Settings or `vox config providers add`; it goes to the Keychain.',
        { providerId: entry.id },
      );
    }
    if (ref.kind === 'keychain' && ref.providerId !== entry.id) {
      throw invalid(
        `provider ${entry.id}: a keychain: reference must name its own provider`,
        'Re-enter the key for this provider.',
        { providerId: entry.id },
      );
    }
    if (ref.kind === 'env' && !ENV_KEY_NAME.test(ref.name)) {
      throw invalid(
        `provider ${entry.id}: env:${ref.name} is not an API key variable`,
        'Use a variable whose name ends in _API_KEY, e.g. env:OPENROUTER_API_KEY.',
        { providerId: entry.id },
      );
    }
  }
  if (entry.baseUrl !== undefined) {
    const url = assertSafeBaseUrl(entry.baseUrl);
    if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname) && requiresKey(entry)) {
      throw invalid(
        `provider ${entry.id}: a key would be sent over plain http to ${url.hostname}`,
        'Use an https:// base URL, or a server on this Mac (localhost).',
        { providerId: entry.id },
      );
    }
  }
}

/** Reads the agent sections; a broken entry fails with `CONFIG_INVALID` (no key text). */
export async function loadAgentConfig(deps: Pick<AgentConfigDeps, 'io'>): Promise<AgentConfig> {
  const raw = await deps.io.read();
  const r = AgentSections.safeParse(raw);
  if (!r.success) {
    throw invalid(
      'the agent settings in config.json are not valid',
      'Fix or remove the providers, roles, limits or prices entries, then try again.',
      { issues: r.error.issues.slice(0, 5).map((i) => i.path.join('.')) },
    );
  }
  const providers = r.data.providers ?? [];
  for (const p of providers) checkEntry(p);
  const roles: Partial<Record<Role, RoleRef>> = {};
  for (const role of ROLES) {
    const ref = r.data.roles?.[role];
    if (ref) roles[role] = { providerId: ref.providerId, model: ref.model };
  }
  const maxOutputTokens = { ...DEFAULT_MAX_OUTPUT_TOKENS };
  for (const role of ROLES) {
    const n = r.data.maxOutputTokens?.[role];
    if (n !== undefined) maxOutputTokens[role] = n;
  }
  return {
    providers,
    roles,
    limits: {
      maxUsdPerRun: r.data.limits?.maxUsdPerRun ?? DEFAULT_LIMITS.maxUsdPerRun,
      maxStepsPerRun: r.data.limits?.maxStepsPerRun ?? DEFAULT_LIMITS.maxStepsPerRun,
    },
    maxOutputTokens,
    prices: r.data.prices ?? {},
  };
}

export function findProvider(cfg: Pick<AgentConfig, 'providers'>, id: string): ProviderEntry {
  const p = cfg.providers.find((e) => e.id === id);
  if (!p) {
    throw invalid(
      `no provider ${JSON.stringify(id)} is configured`,
      'Add it with `vox config providers add <preset>`.',
      {
        providerId: id,
      },
    );
  }
  return p;
}

/** Settings and CLI input for one provider. `apiKey`: a key, a reference, masked or absent. */
export interface ProviderInput {
  id?: string;
  preset?: PresetId;
  baseUrl?: string;
  /** Absent, empty or the masked form = unchanged (S18). */
  apiKey?: string | null;
  options?: ProviderOptions;
}

/**
 * Adds or updates a provider. A typed key goes to the Keychain (`security -i`, stdin) and the
 * entry stores `keychain:<id>`; a reference is stored as it is; a masked or absent key keeps the
 * stored reference. Keyless presets never store an `apiKey`.
 */
export async function saveProvider(
  deps: AgentConfigDeps,
  input: ProviderInput,
): Promise<ProviderEntry> {
  const cfg = await loadAgentConfig(deps);
  const id = input.id ?? input.preset;
  if (id === undefined)
    throw invalid('a provider needs an id or a preset', 'Pass a preset, e.g. openrouter.');
  const existing = cfg.providers.find((p) => p.id === id);
  let entry: ProviderEntry;
  if (existing) {
    if (
      input.preset !== undefined &&
      existing.preset !== undefined &&
      input.preset !== existing.preset
    ) {
      throw invalid(
        `provider ${id} was created from preset ${existing.preset}`,
        'Remove it first or pick another id with --id.',
      );
    }
    entry = { ...existing };
    if (input.baseUrl !== undefined) entry.baseUrl = input.baseUrl;
  } else {
    if (input.preset === undefined) {
      throw invalid(
        `no provider ${JSON.stringify(id)} is configured`,
        'Add it from a preset first.',
      );
    }
    entry = providerEntryFromPreset(input.preset, {
      id,
      ...(input.baseUrl !== undefined && { baseUrl: input.baseUrl }),
    });
  }
  if (input.options !== undefined) entry.options = { ...entry.options, ...input.options };

  const keyless =
    entry.preset !== undefined
      ? PRESETS[entry.preset].key === 'none'
      : entry.type === 'ollama' || entry.type === 'apple';
  const raw = input.apiKey;
  if (!keyInputIsUnchanged(raw)) {
    const value = (raw as string).trim();
    if (keyless) {
      throw invalid(`provider ${id} takes no API key`, 'Leave the key empty for local providers.');
    }
    const ref = parseKeyRef(value);
    if (ref !== null) {
      entry.apiKey = value;
    } else {
      deps.redactor.addSecrets([value]);
      checkEntry({ ...entry, apiKey: `keychain:${id}` });
      await deps.keychain.set(id, value);
      entry.apiKey = `keychain:${id}`;
    }
  }
  if (keyless) delete entry.apiKey;
  const parsed = ProviderEntry.parse(entry);
  checkEntry(parsed);
  const providers = existing
    ? cfg.providers.map((p) => (p.id === id ? parsed : p))
    : [...cfg.providers, parsed];
  await deps.io.write({ providers } as ConfigPatch);
  return parsed;
}

/** Removes a provider, its Keychain item and the roles that use it. */
export async function removeProvider(deps: AgentConfigDeps, id: string): Promise<void> {
  const cfg = await loadAgentConfig(deps);
  const entry = findProvider(cfg, id);
  const roles: Record<string, null> = {};
  for (const [role, ref] of Object.entries(cfg.roles))
    if (ref.providerId === id) roles[role] = null;
  await deps.io.write({
    providers: cfg.providers.filter((p) => p.id !== id),
    ...(Object.keys(roles).length > 0 && { roles }),
  } as ConfigPatch);
  if (entry.apiKey !== undefined && parseKeyRef(entry.apiKey)?.kind === 'keychain') {
    await deps.keychain.remove(id);
  }
}

/** Resolves an entry's key (engine host only) and registers it with the redactor at once. */
export async function providerKey(
  deps: AgentConfigDeps,
  entry: ProviderEntry,
): Promise<string | null> {
  if (entry.apiKey === undefined) {
    if (requiresKey(entry)) {
      throw invalid(
        `no API key is stored for provider ${entry.id}`,
        'Add the key in Settings or with `vox config providers add`.',
      );
    }
    return null;
  }
  const key = await resolveApiKey(entry.apiKey, deps, entry.id);
  if (key === null || key === '') {
    if (requiresKey(entry)) {
      throw invalid(
        `no API key is stored for provider ${entry.id}`,
        'Add the key in Settings or with `vox config providers add`.',
      );
    }
    return null;
  }
  deps.redactor.addSecrets([key]);
  return key;
}

/** What the renderer and `vox config` print: entries with the key masked, never the key. */
export interface MaskedProvider extends Omit<ProviderEntry, 'apiKey'> {
  keyRef: 'keychain' | 'env' | 'none';
  /** `sk-or-…a1b2`, `…`, or null when no key is stored. */
  keyMasked: string | null;
}

export async function maskedProviders(deps: AgentConfigDeps): Promise<MaskedProvider[]> {
  const cfg = await loadAgentConfig(deps);
  const out: MaskedProvider[] = [];
  for (const p of cfg.providers) {
    const { apiKey, ...rest } = p;
    const ref = apiKey === undefined ? null : parseKeyRef(apiKey);
    let masked: string | null = null;
    if (ref !== null) {
      const key = await resolveApiKey(apiKey as string, deps, p.id).catch(() => null);
      if (key) {
        deps.redactor.addSecrets([key]);
        masked = maskKey(key);
      }
    }
    out.push({ ...rest, keyRef: ref?.kind ?? 'none', keyMasked: masked });
  }
  return out;
}

/**
 * Assigns a model to a role. The caller passes the probe verdict (`assertRoleAssignable`); a
 * verdict that is not assignable or is for another role is refused (a model that failed the
 * role's probe cannot fill it).
 */
export async function setRole(
  deps: AgentConfigDeps,
  role: Role,
  ref: RoleRef,
  verdict: RoleVerdict,
): Promise<void> {
  const cfg = await loadAgentConfig(deps);
  findProvider(cfg, ref.providerId);
  if (verdict.role !== role || !verdict.assignable) {
    throw new VoxError(
      'PROBE_FAILED',
      `${ref.model} cannot be the ${role} model`,
      'Run `vox config probe` and pick a model that passes this role.',
      { details: { role, failures: verdict.failures } },
    );
  }
  await deps.io.write({
    roles: { [role]: { providerId: ref.providerId, model: ref.model } },
  } as ConfigPatch);
}

export async function setLimits(deps: AgentConfigDeps, limits: Partial<Limits>): Promise<Limits> {
  const r = LimitsSchema.safeParse(limits);
  if (!r.success)
    throw invalid('limits must be positive numbers', 'e.g. --max-usd 2 --max-steps 60');
  await deps.io.write({ limits: r.data } as ConfigPatch);
  return (await loadAgentConfig(deps)).limits;
}

/** The user's price for a model (per million tokens), or `{ free: true }`. */
export async function setPrice(
  deps: AgentConfigDeps,
  model: string,
  price: PriceEntry,
): Promise<void> {
  const r = PriceEntry.safeParse(price);
  if (!r.success || model.trim() === '') {
    throw invalid(
      'the price is not valid',
      'Give inPerMTok and outPerMTok in USD, or mark it free.',
    );
  }
  // A merge patch merges objects: clear the old fields the new entry does not have.
  const old = (await loadAgentConfig(deps)).prices[model];
  const cleared = Object.fromEntries(Object.keys(old ?? {}).map((k) => [k, null]));
  await deps.io.write({ prices: { [model]: { ...cleared, ...r.data } } } as ConfigPatch);
}
