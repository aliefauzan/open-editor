// Role rules (agent spec "Model roles", "Capability probe", "Plan mode" → mode selection): which
// probe results let a model fill a role, and in which mode the editor runs. Pure functions over a
// probe report; running the probes and storing the report are phase 11 (config, CLI).
import type { AppleStatusValue } from './apple-protocol.ts';
import { appleStatusInfo } from './apple.ts';
import type { ContextInfo } from './context.ts';
import type { ProviderEntry } from './presets.ts';
import { assertRoleModelPriced, priceStatus, type PriceTable } from './prices.ts';
import type { CheckResult } from './probe.ts';
import type { ToolListCost } from './tool-cost.ts';
import { VoxError } from '../errors.ts';

export const ROLES = ['editor', 'vision', 'fast', 'image', 'embed'] as const;
export type Role = (typeof ROLES)[number];

export type AgentMode = 'tools' | 'plan';

/** "≥ 32k effective context" for `editor`, read as 32,000 tokens so a 32,768 model passes (D-38). */
export const EDITOR_MIN_CONTEXT = 32_000;

/** One model's probe results. A check that did not run is absent. */
export interface ProbeReport {
  tools?: CheckResult;
  loop?: CheckResult;
  vision?: CheckResult;
  plan?: CheckResult;
  context?: ContextInfo;
  /** The editor's largest tool list (tool-cost.ts). */
  toolList?: ToolListCost;
  /** Not probed by a request: from the OpenRouter models list, or declared for the entry. */
  capabilities?: { imageOutput?: boolean; embeddings?: boolean };
  /** Apple only: the helper's `--status`. */
  appleStatus?: AppleStatusValue;
}

export interface RoleFailure {
  check: string;
  reason: string;
}

export interface RoleVerdict {
  role: Role;
  assignable: boolean;
  /** `editor` only. */
  mode?: AgentMode;
  failures: RoleFailure[];
}

export interface RoleCheckArgs {
  provider: ProviderEntry;
  model: string;
  probe: ProbeReport;
  priceTables: ReadonlyArray<PriceTable | undefined>;
  /** `--mode`; otherwise `selectMode`. */
  mode?: AgentMode;
}

const isPlanOnlyByDefault = (p: ProviderEntry) =>
  p.type === 'ollama' || p.type === 'apple' || p.preset === 'lmstudio';

/**
 * `plan` for models that fail (or never ran) the loop probe and for Ollama, LM Studio and Apple;
 * `tools` otherwise; an override wins, except that Apple has no tool calls.
 */
export function selectMode(args: {
  provider: ProviderEntry;
  probe: ProbeReport;
  override?: AgentMode;
}): AgentMode {
  if (args.provider.type === 'apple') {
    if (args.override === 'tools') {
      throw new VoxError(
        'CONFIG_INVALID',
        'the Apple on-device model cannot run in tools mode',
        'It has no tool calls; use --mode plan or another model for the editor.',
      );
    }
    return 'plan';
  }
  if (args.override !== undefined) return args.override;
  if (isPlanOnlyByDefault(args.provider)) return 'plan';
  return args.probe.loop?.status === 'pass' ? 'tools' : 'plan';
}

function need(failures: RoleFailure[], check: keyof ProbeReport, result: CheckResult | undefined) {
  if (result === undefined) failures.push({ check, reason: 'not probed' });
  else if (result.status !== 'pass') failures.push({ check, reason: result.reason });
}

function needContext(failures: RoleFailure[], context: ContextInfo | undefined) {
  const n = context?.contextTokens ?? null;
  if (n === null) {
    failures.push({
      check: 'context',
      reason:
        'context size unknown; enter it for this model (options.contextTokens) and probe again',
    });
  } else if (n < EDITOR_MIN_CONTEXT) {
    failures.push({
      check: 'context',
      reason: `effective context ${String(n)} tokens is below the editor's ${String(EDITOR_MIN_CONTEXT)}`,
    });
  }
}

/** Whether `model` on `provider` may fill `role`, with every failed rule. Never throws. */
export function roleCheck(role: Role, args: RoleCheckArgs): RoleVerdict {
  const { provider, probe } = args;
  const failures: RoleFailure[] = [];
  if (priceStatus(provider, args.model, ...args.priceTables).status === 'unpriced') {
    failures.push({
      check: 'price',
      reason: 'no known price; enter its prices or mark it free',
    });
  }
  if (provider.type === 'apple') {
    const status = probe.appleStatus;
    if (status !== undefined && !appleStatusInfo(status).usable) {
      failures.push({ check: 'apple', reason: `${status}: ${appleStatusInfo(status).hint}` });
    }
    if (role === 'vision' || role === 'image' || role === 'embed') {
      failures.push({ check: 'apple', reason: `the Apple on-device model cannot fill ${role}` });
    }
  }

  let mode: AgentMode | undefined;
  switch (role) {
    case 'editor': {
      mode = selectMode({
        provider,
        probe,
        ...(args.mode !== undefined && { override: args.mode }),
      });
      if (mode === 'tools') {
        need(failures, 'tools', probe.tools);
        need(failures, 'loop', probe.loop);
      } else {
        need(failures, 'plan', probe.plan);
      }
      needContext(failures, probe.context);
      // Tools mode always sends the tool list; plan mode sends read tools, checked when measured.
      if (mode === 'tools' || probe.toolList !== undefined) {
        need(failures, 'toolList', probe.toolList?.result);
      }
      break;
    }
    case 'vision':
      if (provider.type !== 'apple') need(failures, 'vision', probe.vision);
      break;
    case 'fast':
      need(failures, 'plan', probe.plan);
      break;
    case 'image':
      if (probe.capabilities?.imageOutput !== true) {
        failures.push({ check: 'imageOutput', reason: 'the model does not output images' });
      }
      break;
    case 'embed':
      if (probe.capabilities?.embeddings !== true) {
        failures.push({ check: 'embeddings', reason: 'the model has no embeddings' });
      }
      break;
  }
  return {
    role,
    assignable: failures.length === 0,
    ...(mode !== undefined && { mode }),
    failures,
  };
}

/**
 * `vox config roles set` and the settings screen: throws PRICE_MISSING (G1 message) for an
 * unpriced paid model, else PROBE_FAILED naming the failed checks. Returns the verdict.
 */
export function assertRoleAssignable(role: Role, args: RoleCheckArgs): RoleVerdict {
  assertRoleModelPriced(args.provider, args.model, role, ...args.priceTables);
  const verdict = roleCheck(role, args);
  if (verdict.assignable) return verdict;
  const checks = [...new Set(verdict.failures.map((f) => f.check))].join(', ');
  throw new VoxError(
    'PROBE_FAILED',
    `${args.model} cannot be the ${role} model: ${checks} failed`,
    'Run `vox config probe` for the reasons, or choose another model for this role.',
    { details: { role, model: args.model, failures: verdict.failures } },
  );
}
