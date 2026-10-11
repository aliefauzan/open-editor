// Tool-list cost (agent spec "Capability probe", D-15): the token count of the largest tool list a
// role can get, as serialised for that provider. The list is serialised by the provider package
// itself (its first request is captured, never sent), so the measure follows each wire format.
// More than 25 % of the role's effective context fails the role.
import type { JSONSchema7 } from '@ai-sdk/provider';
import { asSchema, type ToolSet } from 'ai';
import { UtilError } from '../errors.pending.ts';
import { captureRequest } from './capture.ts';
import { createLanguageModel } from './factory.ts';
import type { ProviderEntry } from './presets.ts';
import type { CheckResult } from './probe.ts';

export const TOOL_LIST_MAX_SHARE = 0.25;

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: JSONSchema7;
}

/** An AI SDK tool set (phase 11: the tools generated from engine schemas) → plain definitions. */
export async function toolDefinitions(tools: ToolSet): Promise<ToolDefinition[]> {
  const out: ToolDefinition[] = [];
  for (const [name, t] of Object.entries(tools)) {
    const inputSchema = await asSchema(t.inputSchema).jsonSchema;
    // A function description is resolved per call; the measure has no call context, so it is left out.
    const description = typeof t.description === 'string' ? t.description : undefined;
    out.push({ name, ...(description !== undefined && { description }), inputSchema });
  }
  return out;
}

/**
 * About 3 UTF-16 units per token: no tokenizer ships for every provider, and JSON schemas
 * tokenize denser than prose, so this over-counts rather than under-counts (D-XX).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** The JSON of the `tools` field the provider package would send for this list. */
export async function serializedToolList(
  entry: ProviderEntry,
  modelId: string,
  tools: readonly ToolDefinition[],
): Promise<string> {
  if (entry.type === 'apple') {
    throw new UtilError(
      'PROBE_FAILED',
      'the Apple on-device model has no tool calls',
      'Apple runs in plan mode only; no tool list is sent to it.',
    );
  }
  if (tools.length === 0) return '';
  const req = await captureRequest(
    (fetch) => createLanguageModel(entry, modelId, { apiKey: 'probe-only-not-sent', fetch }),
    {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: tools.map((t) => ({ type: 'function' as const, ...t })),
      toolChoice: { type: 'auto' },
    },
  );
  const body = req.body as { tools?: unknown } | null;
  if (body === null || typeof body !== 'object' || body.tools === undefined) {
    throw new UtilError(
      'PROBE_FAILED',
      `the ${entry.type} request has no tools field`,
      'Please report this; the provider package changed its request format.',
    );
  }
  return JSON.stringify(body.tools);
}

/** > 25 % of the effective context fails; an unknown context fails too (it cannot be checked). */
export function checkToolListCost(tokens: number, contextTokens: number | null): CheckResult {
  if (contextTokens === null) {
    return {
      status: 'fail',
      reason:
        'context size unknown; enter it for this model (options.contextTokens) and probe again',
    };
  }
  if (tokens > contextTokens * TOOL_LIST_MAX_SHARE) {
    const pct = Math.round((tokens / contextTokens) * 100);
    return {
      status: 'fail',
      reason: `the tool list takes ${String(pct)} % of the context (${String(tokens)} of ${String(contextTokens)} tokens; limit 25 %)`,
    };
  }
  return { status: 'pass' };
}

export interface ToolListCost {
  tokens: number;
  contextTokens: number | null;
  share: number | null;
  result: CheckResult;
}

export async function measureToolListCost(args: {
  entry: ProviderEntry;
  modelId: string;
  /** The largest list the role can get: a workflow's `allowedTools` plus the always-present tools. */
  tools: readonly ToolDefinition[];
  contextTokens: number | null;
  countTokens?: (serialised: string) => number;
}): Promise<ToolListCost> {
  const serialised = await serializedToolList(args.entry, args.modelId, args.tools);
  const tokens = (args.countTokens ?? estimateTokens)(serialised);
  const share = args.contextTokens === null ? null : tokens / args.contextTokens;
  return {
    tokens,
    contextTokens: args.contextTokens,
    share,
    result: checkToolListCost(tokens, args.contextTokens),
  };
}
