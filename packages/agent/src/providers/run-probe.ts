// The capability probe for one model (agent spec "Capability probe"; phase 11 step 10): context,
// tools, loop, vision, plan (one ClipPlan for a fixture sequence and its transcript must validate)
// and the tool-list cost of the largest list the editor can get (> 25 % of the effective context
// fails the role, D-15). Apple entries run the status and plan checks, and the vision check when
// the helper reports image input (macOS 27, D-74).
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { ClipPlanSchema } from '../loop/plan.ts';
import {
  ALWAYS_PRESENT,
  CLIPPER_CORE_TOOLS,
  buildRegistry,
  surfaceNames,
  toolDefinitionsFor,
} from '../tools/registry.ts';
import { APPLE_NO_VISION_REASON, appleStatus, type AppleModelOptions } from './apple.ts';
import type { AppleStatus } from './apple-protocol.ts';
import { detectContext, type ContextDeps, type ContextInfo } from './context.ts';
import type { ProviderEntry } from './presets.ts';
import {
  probeLoop,
  probePlan,
  probeTools,
  probeVision,
  type CheckResult,
  type PlanTask,
  type ProbeOptions,
} from './probe.ts';
import type { ProbeReport } from './roles.ts';
import { measureToolListCost } from './tool-cost.ts';

/** The plan check: a 20 s talking-head sequence and its transcript, in sequence time. */
export const CLIP_PLAN_TASK: PlanTask<unknown> = {
  schema: ClipPlanSchema,
  system:
    'You plan short video clips. Answer with one JSON object only: { sequences: [{ sequenceId, beats: [{ startMs, endMs, kind: "speaker" | "scene", template?, variables?, imageQueries? }] }] }. Times are integer milliseconds in sequence time.',
  prompt: [
    'Sequence s1 (0–20000 ms): one talking-head clip c1 on V1, 0–20000.',
    'Scene templates: base/title (variables { title: string }, 500–10000 ms), base/photo (slot image; give imageQueries, 1000–6000 ms).',
    'Transcript (sequence ms, word): 0 Hello, 400 and 700 welcome 1100 to 1300 the 1500 lighthouse 2100 tour. 6000 It 6200 was 6400 built 6800 in 7100 1874 9000 and 9300 still 9600 shines 10400 every 10800 night.',
    'Plan sequence s1: a title scene for the first 3 seconds, a photo scene of the lighthouse while it is described, speaker beats in between.',
  ].join('\n'),
};

export interface ProbeChecks {
  tools: typeof probeTools;
  loop: typeof probeLoop;
  vision: typeof probeVision;
  plan: typeof probePlan;
}

export interface ProbeRunDeps {
  context?: ContextDeps;
  apple?: AppleModelOptions;
  /** Tool lists the editor can get (each workflow's `allowedTools`); default: the clipper core set. */
  toolLists?: readonly (readonly string[])[];
  /** Which checks to run (default all that apply). */
  only?: readonly ('tools' | 'loop' | 'vision' | 'plan')[];
  options?: ProbeOptions;
  /** Test seam. */
  checks?: Partial<ProbeChecks>;
}

const noImages = { imageProviders: { list: () => [], register: () => undefined } };

/** The largest tool list (definitions as the model sees them) over the given workflows. */
export function largestToolList(lists: readonly (readonly string[])[] = [CLIPPER_CORE_TOOLS]) {
  const registry = buildRegistry(noImages);
  let best = toolDefinitionsFor(registry, [...ALWAYS_PRESENT]);
  let bestSize = -1;
  for (const l of lists) {
    const defs = toolDefinitionsFor(registry, surfaceNames(registry, l, { mode: 'tools' }));
    const size = JSON.stringify(defs).length;
    if (size > bestSize) {
      best = defs;
      bestSize = size;
    }
  }
  return best;
}

export async function probeModel(
  entry: ProviderEntry,
  modelId: string,
  model: LanguageModelV4,
  deps: ProbeRunDeps = {},
): Promise<ProbeReport> {
  const checks: ProbeChecks = {
    tools: probeTools,
    loop: probeLoop,
    vision: probeVision,
    plan: probePlan,
    ...deps.checks,
  };
  const want = (c: 'tools' | 'loop' | 'vision' | 'plan') =>
    deps.only === undefined || deps.only.includes(c);
  const opts = deps.options ?? {};
  const report: ProbeReport = {};
  if (entry.type === 'apple') {
    if (!deps.apple) {
      report.plan = { status: 'error', reason: 'APPLE_UNAVAILABLE' };
      return report;
    }
    let s: AppleStatus;
    try {
      s = await appleStatus(deps.apple);
    } catch {
      report.plan = { status: 'error', reason: 'APPLE_UNAVAILABLE' };
      return report;
    }
    report.appleStatus = s.status;
    report.context = { contextTokens: s.contextSize, source: 'apple' };
    if (s.status !== 'ready') return report;
    if (want('vision')) {
      report.vision =
        s.vision === true
          ? await checks.vision(model, opts)
          : { status: 'fail', reason: APPLE_NO_VISION_REASON };
    }
    if (want('plan')) report.plan = await checks.plan(model, CLIP_PLAN_TASK, opts);
    return report;
  }
  const context: ContextInfo = await detectContext(entry, modelId, deps.context ?? {});
  report.context = context;
  const or = deps.context?.openRouterModels?.get(modelId);
  if (or) {
    report.capabilities = {
      imageOutput: or.outputModalities.includes('image'),
      embeddings: or.outputModalities.includes('embeddings'),
    };
  }
  const run = async (
    name: 'tools' | 'loop' | 'vision' | 'plan',
  ): Promise<CheckResult | undefined> => {
    if (!want(name)) return undefined;
    if (name === 'plan') return checks.plan(model, CLIP_PLAN_TASK, opts);
    return checks[name](model, opts);
  };
  for (const name of ['tools', 'loop', 'vision', 'plan'] as const) {
    const r = await run(name);
    if (r) report[name] = r;
  }
  report.toolList = await measureToolListCost({
    entry,
    modelId,
    tools: largestToolList(deps.toolLists),
    contextTokens: context.contextTokens,
  });
  return report;
}
