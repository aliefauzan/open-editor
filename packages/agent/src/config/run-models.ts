// Role models for a run from the config (agent spec "Model roles"): the provider entry and key, the
// model object, its effective context, its price (local providers are free; a paid model needs a
// price) and the loop mode. The CLI (`vox agent`) and the live evals build their runs with this.
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { VoxError } from '../errors.ts';
import type { RoleModel, RunModels } from '../loop/types.ts';
import type { AppleModelOptions } from '../providers/apple.ts';
import {
  detectContext,
  fetchOpenRouterModels,
  type ContextDeps,
  type OpenRouterModelInfo,
} from '../providers/context.ts';
import { createEmbedder } from '../providers/factory.ts';
import { PRESETS, type ProviderEntry } from '../providers/presets.ts';
import type { Embedder } from '../screenplay/match.ts';
import { isLocalProvider, lookupPrice, type PriceEntry } from '../providers/prices.ts';
import { promptCacheTarget, withCachePrices } from '../providers/prompt-cache.ts';
import { selectMode, type AgentMode } from '../providers/roles.ts';
import { findProvider, providerKey, type AgentConfig, type AgentConfigDeps } from './store.ts';

export const RUN_ROLES = ['editor', 'fast', 'vision'] as const;

export interface RunModelDeps {
  createModel: (entry: ProviderEntry, modelId: string, apiKey: string | null) => LanguageModelV4;
  fetch?: typeof fetch;
  apple?: AppleModelOptions;
  context?: ContextDeps;
}

async function roleModel(
  role: (typeof RUN_ROLES)[number],
  conf: AgentConfig,
  cfg: AgentConfigDeps,
  deps: RunModelDeps,
  orModels: () => Promise<Map<string, OpenRouterModelInfo> | undefined>,
): Promise<{ model: RoleModel; mode: AgentMode } | undefined> {
  const ref = conf.roles[role];
  if (!ref) return undefined;
  const entry = findProvider(conf, ref.providerId);
  const key = await providerKey(cfg, entry);
  const model = deps.createModel(entry, ref.model, key);
  const kind = { type: entry.type, ...(entry.preset !== undefined && { preset: entry.preset }) };
  const label = entry.preset !== undefined ? PRESETS[entry.preset].label : (entry.id ?? entry.type);
  const models = entry.type === 'openrouter' ? await orModels() : undefined;
  const ctx = await detectContext(entry, ref.model, {
    ...(deps.fetch !== undefined && { fetch: deps.fetch }),
    ...(deps.apple !== undefined && { apple: deps.apple }),
    ...(models !== undefined && { openRouterModels: models }),
    ...deps.context,
  });
  let price: PriceEntry | undefined = isLocalProvider(kind) ? { free: true } : undefined;
  if (!price) {
    const fromOr = models?.get(ref.model)?.price;
    price = lookupPrice(ref.model, conf.prices, fromOr ? { [ref.model]: fromOr } : undefined);
  }
  if (!price) {
    throw new VoxError(
      'PRICE_MISSING',
      `${ref.model} has no price, so the run cannot keep to its cost cap`,
      `Set it: vox config prices set ${ref.model} --in <usd> --out <usd> (or --free).`,
    );
  }
  if (ctx.contextTokens === null) {
    throw new VoxError(
      'CONFIG_INVALID',
      `the context size of ${ref.model} is unknown`,
      `Enter it: vox config providers add … --context ${ref.model}=<tokens>, then vox config probe.`,
    );
  }
  // a role is only set after its probe passed (`roles set`), so the editor passed the loop probe
  const mode = selectMode({ provider: entry, probe: { loop: { status: 'pass' } } as never });
  return {
    mode,
    model: {
      model,
      provider: { ...kind, label },
      modelId: ref.model,
      contextTokens: ctx.contextTokens,
      // Anthropic cache rates filled in where the table has none (D-76)
      price: withCachePrices(promptCacheTarget({ provider: kind, modelId: ref.model }), price),
      maxOutputTokens: conf.maxOutputTokens[role],
    },
  };
}

/** The run's role models from `conf.roles` and the editor's default loop mode. */
export async function buildRunModels(
  conf: AgentConfig,
  cfg: AgentConfigDeps,
  deps: RunModelDeps,
): Promise<{ models: Partial<RunModels>; mode?: AgentMode }> {
  let cache: Promise<Map<string, OpenRouterModelInfo> | undefined> | undefined;
  const known = deps.context?.openRouterModels;
  const orModels = () =>
    (cache ??=
      known !== undefined
        ? Promise.resolve(known)
        : fetchOpenRouterModels(deps.fetch !== undefined ? { fetch: deps.fetch } : {}).catch(
            () => undefined,
          ));
  const models: Partial<RunModels> = {};
  let mode: AgentMode | undefined;
  for (const role of RUN_ROLES) {
    const m = await roleModel(role, conf, cfg, deps, orModels);
    if (!m) continue;
    models[role] = m.model;
    if (role === 'editor') mode = m.mode;
  }
  return { models, ...(mode && { mode }) };
}

/**
 * The `embed` role as an embedding function (screenplay match), or undefined when no embed role is
 * set. A set role whose provider cannot embed throws CONFIG_INVALID (the caller reports it and the
 * workflow falls back to LLM ranking).
 */
export async function buildEmbedder(
  conf: AgentConfig,
  cfg: AgentConfigDeps,
  deps: { fetch?: typeof fetch } = {},
): Promise<Embedder | undefined> {
  const ref = conf.roles.embed;
  if (!ref) return undefined;
  const entry = findProvider(conf, ref.providerId);
  const key = await providerKey(cfg, entry);
  return createEmbedder(entry, ref.model, {
    apiKey: key,
    ...(deps.fetch !== undefined && { fetch: deps.fetch }),
  });
}
