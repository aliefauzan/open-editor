// Scripted MockLanguageModelV4 for loop tests: each model request takes the next scripted step
// (text, tool calls with raw JSON input, usage, a provider-reported cost, or an error) and the
// prompts the loop sent are kept for assertions.
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { createRedactor } from '@vox/engine';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { RoleModel, RunDeps } from '../../src/loop/types.ts';
import type { Fixture } from './project.ts';

export interface ScriptStep {
  text?: string;
  calls?: { name: string; input: string | Record<string, unknown> }[];
  usage?: { input?: number; output?: number; cacheRead?: number; reasoning?: number };
  /** OpenRouter-style reported cost. */
  costUsd?: number;
  /** Throw this instead of answering. */
  error?: unknown;
  /** Structured answer (plan mode / generateText): the JSON text. */
  json?: unknown;
}

export interface Scripted {
  model: MockLanguageModelV4;
  prompts: LanguageModelV4CallOptions[];
  remaining(): number;
}

const usageOf = (u: ScriptStep['usage'] = {}) => ({
  inputTokens: { total: u.input ?? 100, noCache: (u.input ?? 100) - (u.cacheRead ?? 0), cacheRead: u.cacheRead ?? 0, cacheWrite: 0 },
  outputTokens: { total: u.output ?? 20, text: (u.output ?? 20) - (u.reasoning ?? 0), reasoning: u.reasoning ?? 0 },
});

export function scriptedModel(steps: ScriptStep[], opts: { repeatLast?: boolean } = {}): Scripted {
  const prompts: LanguageModelV4CallOptions[] = [];
  let i = 0;
  const next = (o: LanguageModelV4CallOptions): ScriptStep => {
    prompts.push(o);
    const s = steps[i] ?? (opts.repeatLast ? steps.at(-1) : undefined);
    i++;
    if (!s) return { text: 'Done (script ended).' };
    return s;
  };
  const model = new MockLanguageModelV4({
    doStream: async (o) => {
      const s = next(o);
      if (s.error !== undefined) throw s.error;
      const chunks: unknown[] = [];
      const text = s.json !== undefined ? JSON.stringify(s.json) : s.text;
      if (text) chunks.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' });
      for (const [k, c] of (s.calls ?? []).entries()) {
        chunks.push({
          type: 'tool-call',
          toolCallId: `call_${String(i)}_${String(k)}`,
          toolName: c.name,
          input: typeof c.input === 'string' ? c.input : JSON.stringify(c.input),
        });
      }
      chunks.push({
        type: 'finish',
        finishReason: { unified: s.calls?.length ? 'tool-calls' : 'stop', raw: 'x' },
        usage: usageOf(s.usage),
        ...(s.costUsd !== undefined && { providerMetadata: { openrouter: { usage: { cost: s.costUsd } } } }),
      });
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
    doGenerate: async (o) => {
      const s = next(o);
      if (s.error !== undefined) throw s.error;
      const text = s.json !== undefined ? JSON.stringify(s.json) : (s.text ?? '');
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: usageOf(s.usage),
        warnings: [],
        ...(s.costUsd !== undefined && { providerMetadata: { openrouter: { usage: { cost: s.costUsd } } } }),
      } as never;
    },
  });
  return { model, prompts, remaining: () => steps.length - i };
}

export function roleModel(model: MockLanguageModelV4, over: Partial<RoleModel> = {}): RoleModel {
  return {
    model,
    provider: { type: 'openrouter', label: 'OpenRouter' },
    modelId: 'test/model',
    contextTokens: 128_000,
    price: { inPerMTok: 1, outPerMTok: 2 },
    maxOutputTokens: 8_000,
    ...over,
  };
}

export function runDeps(f: Fixture, editor: RoleModel, over: Partial<RunDeps> = {}) {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const deps: RunDeps = {
    engine: f.engine,
    redactor: createRedactor(),
    models: { editor },
    limits: { maxUsdPerRun: 2, maxStepsPerRun: 60 },
    emit: (e) => void events.push(e as never),
    sleep: () => Promise.resolve(),
    newRunId: () => 'run_test0001',
    ...over,
  };
  return { deps, events };
}

/** The text of every message part the model got in request `n` (system + messages). */
export function promptText(p: LanguageModelV4CallOptions): string {
  return JSON.stringify(p.prompt);
}
