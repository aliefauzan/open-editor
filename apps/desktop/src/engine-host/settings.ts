// Settings in the engine host (app spec "Settings"; agent spec "Configuration and keys"; R4 S17,
// S18, S33). Keys are read and written only here: `settings.get` returns providers with the key
// masked, a typed key goes to the Keychain (`security -i`, stdin) and the config stores only
// `keychain:<id>`; an absent or masked key in a save means "unchanged". A role is assigned only to a
// model whose probe passed that role (the probe runs here, the result is kept for the session).
// `ingest.cookiesFromBrowser` is written only through `settings.save` (or `vox config` in a
// terminal; S33): no agent tool and no project file reach it.
import {
  appleStatus,
  appleStatusInfo,
  assertRoleAssignable,
  createLanguageModel,
  fetchOpenRouterModels,
  findProvider,
  loadAgentConfig,
  maskedProviders,
  PRESETS,
  presetIds,
  probeModel,
  providerKey,
  removeProvider,
  roleCheck,
  ROLES,
  saveProvider,
  selectMode,
  setLimits,
  setPrice,
  setRole,
  type AgentConfig,
  type AgentConfigDeps,
  type AppleModelOptions,
  type OpenRouterModelInfo,
  type PriceEntry,
  type PriceTable,
  type ProbeRunDeps,
  type ProviderEntry,
  type Role,
} from '@vox/agent';
import { VoxError, type ConfigPatch } from '@vox/engine';

type LanguageModelV4 = ReturnType<typeof createLanguageModel>;
import {
  SETTINGS_ROLES,
  type ProbedData,
  type SettingsData,
  type SettingsPatchData,
} from '../shared/api.ts';

export interface SettingsDeps {
  cfg: AgentConfigDeps;
  /** The Apple helper; absent when it is not built (`pnpm dist:no-apple`) or not found. */
  apple?: AppleModelOptions;
  /** `build-info.json` `appleHelper` (dev: the helper exists); false hides the Apple preset. */
  appleHelper: boolean;
  fetch?: typeof fetch;
  createModel?: (entry: ProviderEntry, modelId: string, apiKey: string | null) => LanguageModelV4;
  /** Test seam for the probe (scripted checks, context). */
  probe?: Omit<ProbeRunDeps, 'apple'>;
  /** Local model lists (Ollama `/api/tags`); tests replace it. */
  listLocalModels?: (entry: ProviderEntry) => Promise<string[]>;
}

const refKey = (providerId: string, model: string) => `${providerId}:${model}`;

/** `<providerId>:<model>`; the model id may hold colons (Ollama tags). */
export function parseRef(ref: string): { providerId: string; model: string } | null {
  const i = ref.indexOf(':');
  return i <= 0 || i === ref.length - 1
    ? null
    : { providerId: ref.slice(0, i), model: ref.slice(i + 1) };
}

const LOCAL_TYPES = new Set(['ollama', 'apple']);
const isLocal = (e: { type: string; preset?: string }) =>
  LOCAL_TYPES.has(e.type) || e.preset === 'lmstudio';

/** Ollama's installed models (`GET <base>/api/tags`); a local server, so no key and no project data. */
async function ollamaTags(entry: ProviderEntry, fetchFn: typeof fetch): Promise<string[]> {
  const base = (entry.baseUrl ?? PRESETS.ollama.baseUrl ?? '').replace(/\/+$/, '');
  try {
    const r = await fetchFn(`${base}/api/tags`, { signal: AbortSignal.timeout(2_000) });
    if (!r.ok) return [];
    const body = (await r.json()) as { models?: { name?: unknown }[] };
    return (body.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === 'string')
      .slice(0, 200);
  } catch {
    return [];
  }
}

export class SettingsHost {
  readonly #d: SettingsDeps;
  /** Probe results of this session, by `<providerId>:<model>`. */
  readonly #probes = new Map<string, ProbedData>();

  constructor(deps: SettingsDeps) {
    this.#d = deps;
  }

  #createModel(entry: ProviderEntry, modelId: string, key: string | null): LanguageModelV4 {
    if (this.#d.createModel) return this.#d.createModel(entry, modelId, key);
    return createLanguageModel(entry, modelId, {
      apiKey: key,
      ...(this.#d.fetch !== undefined && { fetch: this.#d.fetch }),
      ...(this.#d.apple !== undefined && { apple: this.#d.apple }),
    });
  }

  async #openRouterModels(
    entries: readonly ProviderEntry[],
  ): Promise<Map<string, OpenRouterModelInfo> | undefined> {
    if (this.#d.probe?.context?.openRouterModels) return this.#d.probe.context.openRouterModels;
    const or = entries.find((e) => e.type === 'openrouter');
    if (!or) return undefined;
    const base = or.baseUrl ?? (or.preset !== undefined ? PRESETS[or.preset].baseUrl : undefined);
    return fetchOpenRouterModels({
      ...(this.#d.fetch !== undefined && { fetch: this.#d.fetch }),
      ...(base !== undefined && { baseUrl: base }),
    }).catch(() => undefined);
  }

  static #priceTables(conf: AgentConfig, or: Map<string, OpenRouterModelInfo> | undefined) {
    const table: Record<string, PriceEntry> = {};
    for (const [id, info] of or ?? []) if (info.price !== undefined) table[id] = info.price;
    return [conf.prices, table] as ReadonlyArray<PriceTable | undefined>;
  }

  async get(): Promise<SettingsData> {
    const conf = await loadAgentConfig(this.#d.cfg);
    const raw = await this.#d.cfg.io.read();
    const masked = await maskedProviders(this.#d.cfg);
    const providers: SettingsData['providers'] = [];
    for (const p of masked) {
      const entry = conf.providers.find((e) => e.id === p.id);
      if (!entry || (entry.type === 'apple' && !this.#d.appleHelper)) continue;
      const models =
        entry.type === 'apple'
          ? ['apple-on-device']
          : entry.type === 'ollama'
            ? await (this.#d.listLocalModels ?? ((e) => ollamaTags(e, this.#d.fetch ?? fetch)))(
                entry,
              )
            : [];
      const o = entry.options;
      providers.push({
        id: entry.id,
        type: entry.type,
        ...(entry.preset !== undefined && { preset: entry.preset }),
        ...(entry.baseUrl !== undefined && { baseUrl: entry.baseUrl }),
        keyRef: p.keyRef,
        keyMasked: p.keyMasked,
        local: isLocal(entry),
        models,
        ...(o !== undefined && {
          options: {
            ...(typeof o.numCtx === 'number' && { numCtx: o.numCtx }),
            ...(o.contextTokens !== undefined && { contextTokens: o.contextTokens }),
          },
        }),
      });
    }
    let apple: SettingsData['apple'];
    if (this.#d.appleHelper && this.#d.apple) {
      try {
        const s = await appleStatus(this.#d.apple);
        apple = { status: s.status, ...appleStatusInfo(s.status) };
      } catch {
        apple = {
          status: 'failed',
          usable: false,
          hint: 'The Apple helper did not answer; reinstall Vox Studio.',
        };
      }
    }
    const roles: SettingsData['roles'] = {};
    for (const r of SETTINGS_ROLES) {
      const ref = conf.roles[r];
      if (ref) roles[r] = { providerId: ref.providerId, model: ref.model };
    }
    const editorRef = conf.roles.editor;
    const editorEntry = editorRef
      ? conf.providers.find((e) => e.id === editorRef.providerId)
      : undefined;
    const ingest = (raw as { ingest?: { cookiesFromBrowser?: unknown } }).ingest;
    const cookies = ingest?.cookiesFromBrowser;
    const contact = (raw as { contact?: unknown }).contact;
    return {
      providers,
      presets: presetIds
        .filter((id) => id !== 'apple' || this.#d.appleHelper)
        .map((id) => ({
          id,
          label: PRESETS[id].label,
          key: PRESETS[id].key,
          ...(PRESETS[id].baseUrl !== undefined && { baseUrl: PRESETS[id].baseUrl }),
          local: isLocal({ type: PRESETS[id].type, preset: id }),
        })),
      roles,
      ...(editorEntry && {
        mode: selectMode({ provider: editorEntry, probe: { loop: { status: 'pass' } } as never }),
      }),
      limits: { ...conf.limits },
      prices: Object.fromEntries(Object.entries(conf.prices)) as Record<string, unknown>,
      appleHelper: this.#d.appleHelper,
      ...(apple && { apple }),
      probes: [...this.#probes.values()],
      ingest: {
        cookiesFromBrowser:
          cookies === 'safari' || cookies === 'chrome' || cookies === 'firefox' ? cookies : null,
      },
      contact: typeof contact === 'string' ? contact : null,
    };
  }

  /** Probes `<providerId>:<model>`, or the model of a role; keeps the result for role assignment. */
  async probe(roleOrModel: string): Promise<ProbedData> {
    const conf = await loadAgentConfig(this.#d.cfg);
    const ref = (ROLES as readonly string[]).includes(roleOrModel)
      ? conf.roles[roleOrModel as Role]
      : (parseRef(roleOrModel) ?? undefined);
    if (!ref) {
      throw new VoxError(
        'VALIDATION',
        `nothing to probe for ${JSON.stringify(roleOrModel)}`,
        'Name a model as <provider>:<model>, or assign the role first.',
      );
    }
    const entry = findProvider(conf, ref.providerId);
    if (entry.type === 'apple' && !this.#d.appleHelper) {
      throw new VoxError(
        'APPLE_UNAVAILABLE',
        'this build has no Apple helper',
        'Build Vox Studio with the macOS 26+ SDK (pnpm dist) to use the Apple on-device model.',
      );
    }
    const or = await this.#openRouterModels([entry]);
    let out: ProbedData;
    try {
      const key = await providerKey(this.#d.cfg, entry);
      const model = this.#createModel(entry, ref.model, key);
      const report = await probeModel(entry, ref.model, model, {
        ...this.#d.probe,
        context: {
          ...(this.#d.fetch !== undefined && { fetch: this.#d.fetch }),
          ...(this.#d.apple !== undefined && { apple: this.#d.apple }),
          ...(or !== undefined && { openRouterModels: or }),
          ...this.#d.probe?.context,
        },
        ...(this.#d.apple !== undefined && { apple: this.#d.apple }),
      });
      const priceTables = SettingsHost.#priceTables(conf, or);
      const roles = ROLES.map((role) =>
        roleCheck(role, { provider: entry, model: ref.model, probe: report, priceTables }),
      );
      out = {
        providerId: ref.providerId,
        model: ref.model,
        report: JSON.parse(JSON.stringify(report)) as ProbedData['report'],
        roles: roles.map((v) => ({
          role: v.role,
          assignable: v.assignable,
          ...(v.mode !== undefined && { mode: v.mode }),
          failures: v.failures.map((f) => ({ check: f.check, reason: f.reason })),
        })),
      };
    } catch (err) {
      if (!(err instanceof VoxError)) throw err;
      out = {
        providerId: ref.providerId,
        model: ref.model,
        error: { code: err.code, message: err.message, hint: err.hint },
        roles: [],
      };
    }
    this.#probes.set(refKey(ref.providerId, ref.model), out);
    return out;
  }

  /** Applies one settings change (each field independent; validated by main with zod). */
  async save(patch: SettingsPatchData): Promise<SettingsData> {
    const cfg = this.#d.cfg;
    if (patch.provider) {
      const p = patch.provider;
      if (p.preset === 'apple' && !this.#d.appleHelper) {
        throw new VoxError(
          'APPLE_UNAVAILABLE',
          'this build has no Apple helper',
          'Build Vox Studio with the macOS 26+ SDK (pnpm dist) to use the Apple on-device model.',
        );
      }
      await saveProvider(cfg, {
        ...(p.id !== undefined && { id: p.id }),
        ...(p.preset !== undefined && { preset: p.preset }),
        ...(p.baseUrl !== undefined && { baseUrl: p.baseUrl }),
        ...(p.apiKey !== undefined && { apiKey: p.apiKey }),
        ...(p.options !== undefined && { options: p.options }),
      });
      // a changed key or base URL makes the old probe results stale
      const id = p.id ?? p.preset;
      for (const k of [...this.#probes.keys()])
        if (k.startsWith(`${String(id)}:`)) this.#probes.delete(k);
    }
    if (patch.removeProvider !== undefined) {
      await removeProvider(cfg, patch.removeProvider);
      for (const k of [...this.#probes.keys()])
        if (k.startsWith(`${patch.removeProvider}:`)) this.#probes.delete(k);
    }
    if (patch.role) await this.#assignRole(patch.role.role, patch.role);
    if (patch.clearRole !== undefined) {
      await cfg.io.write({ roles: { [patch.clearRole]: null } } as ConfigPatch);
    }
    if (patch.limits) await setLimits(cfg, patch.limits);
    if (patch.price) {
      const { model, ...rest } = patch.price;
      const price: PriceEntry =
        'free' in rest
          ? { free: true }
          : { inPerMTok: rest.inPerMTok, outPerMTok: rest.outPerMTok };
      await setPrice(cfg, model, price);
    }
    // S33: the only app path that writes ingest.cookiesFromBrowser
    if (patch.cookiesFromBrowser !== undefined) {
      await cfg.io.write({
        ingest: { cookiesFromBrowser: patch.cookiesFromBrowser },
      } as ConfigPatch);
    }
    if (patch.contact !== undefined) {
      const c = patch.contact === null ? null : patch.contact.trim() || null;
      await cfg.io.write({ contact: c } as ConfigPatch);
    }
    return this.get();
  }

  /** A model fills a role only after its probe for that role passed (S18 row "settings", app spec). */
  async #assignRole(role: Role, ref: { providerId: string; model: string }): Promise<void> {
    const conf = await loadAgentConfig(this.#d.cfg);
    const entry = findProvider(conf, ref.providerId);
    let probed = this.#probes.get(refKey(ref.providerId, ref.model));
    if (!probed) probed = await this.probe(refKey(ref.providerId, ref.model));
    if (probed.error || !probed.report) {
      throw new VoxError(
        'PROBE_FAILED',
        `${ref.model} could not be probed: ${probed.error?.message ?? 'no result'}`,
        probed.error?.hint ?? 'Press Test again, then assign the role.',
        { details: { role } },
      );
    }
    const or = await this.#openRouterModels([entry]);
    const verdict = assertRoleAssignable(role, {
      provider: entry,
      model: ref.model,
      probe: probed.report as never,
      priceTables: SettingsHost.#priceTables(conf, or),
    });
    await setRole(this.#d.cfg, role, ref, verdict);
  }
}
