// The public API of @vox/agent: provider config and keys, the provider layer (presets, models,
// probe, roles, prices), the tool layer and the agent loop. The app (phase 13) and the CLI import
// only from here.
export const version = '1.0.0';

export * from './config/store.ts';
export * from './config/keychain.ts';
export * from './config/mask.ts';

export * from './providers/presets.ts';
export * from './providers/factory.ts';
export * from './providers/roles.ts';
export * from './providers/probe.ts';
export * from './providers/run-probe.ts';
export * from './providers/context.ts';
export * from './providers/tool-cost.ts';
export * from './providers/apple.ts';
export {
  Price,
  PriceEntry,
  costOfUsage,
  costFromReported,
  stepUpperBoundUsd,
  exceedsBudget,
  isLocalProvider,
  lookupPrice,
  priceStatus,
  assertRoleModelPriced,
  parseOpenRouterPricing,
  costOfImages,
  type PriceTable,
  type PriceStatus,
  type ProviderKind,
  type Usage as TokenUsage,
} from './providers/prices.ts';

export * from './tools/registry.ts';

export * from './loop/types.ts';
export * from './loop/run.ts';
export * from './loop/plan.ts';
export * from './loop/record.ts';
export * from './loop/provider-errors.ts';
export { buildSystemPrompt, BASE_PROMPT, DATA_RULE } from './loop/prompt.ts';

export * from './workflows/load.ts';
export * from './workflows/checkpoints.ts';
export * from './workflows/run-workflow.ts';
export {
  type ClipReport,
  type Layout,
  coverTransition,
  clipSummary,
  speakerShare,
} from './workflows/stylize.ts';
export {
  type ScreenplayReport,
  type SceneReport,
  cleanText as cleanScreenplayText,
} from './workflows/screenplay.ts';
export { parseScreenplay, estimateMs, type Scene } from './screenplay/parse.ts';
export { type Embedder, type Footage } from './screenplay/match.ts';
export { sourceIn } from './workflows/clipper.ts';
export { classifyIntent, type Intent } from './workflows/intent.ts';
export { createLlmScorer, llmScorerSlot, LLM_SCORER_ID, withLlmScorer } from './quickScorer.ts';
export { scrubSoundClaims } from './loop/summary.ts';
export { sourceNamedByUser } from './tools/sources.ts';
export * from './config/run-models.ts';
