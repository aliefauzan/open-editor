// D-76: Anthropic prompt caching. Which roles get breakpoints, where they go in the request (as the
// Anthropic and OpenRouter packages serialise it), that the state block stays after them, that a
// step reads the prefix the step before wrote, and that cache writes and reads are billed at their
// own prices (never below the real Anthropic bill) with the budget bound on the dearest rate.
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { describe, expect, test, vi } from 'vitest';
import { AgentRun, runAgent } from '../../src/loop/run.ts';
import { captureRequest } from '../../src/providers/capture.ts';
import { createLanguageModel } from '../../src/providers/factory.ts';
import type { ProviderEntry } from '../../src/providers/presets.ts';
import { costOfUsage, stepUpperBoundUsd } from '../../src/providers/prices.ts';
import {
  cachedHistory,
  promptCacheTarget,
  withCachePrices,
} from '../../src/providers/prompt-cache.ts';
import { AnthropicCacheSim, blocksOf } from '../helpers/anthropic-cache.ts';
import { roleModel, runDeps, scriptedModel, type ScriptStep } from '../helpers/model.ts';
import { fixtureProject } from '../helpers/project.ts';

const ANTHROPIC = { provider: { type: 'anthropic' as const, label: 'Anthropic' } };
const SCRIPT: ScriptStep[] = [
  {
    calls: [
      {
        name: 'get_transcript',
        input: { mediaId: 'm_talk0000000001', fromSrcMs: 0, toSrcMs: 3000 },
      },
    ],
  },
  { calls: [{ name: 'update_clip', input: { sequenceId: 's1', itemId: 'c1', volume: 0.5 } }] },
  { text: 'Lowered the volume of c1.' },
];

async function anthropicRun(
  over: Partial<Parameters<typeof roleModel>[1]> = {},
  sim?: AnthropicCacheSim,
) {
  const f = await fixtureProject();
  const m = scriptedModel(SCRIPT, sim ? { usage: (o) => sim.modelUsage(o) } : {});
  const { deps } = runDeps(
    f,
    roleModel(m.model, { ...ANTHROPIC, modelId: 'claude-sonnet-4-5', ...over }),
    {
      limits: { maxUsdPerRun: 100, maxStepsPerRun: 60 },
    },
  );
  const r = await runAgent(deps, {
    projectId: f.projectId,
    workflow: 'freeform',
    message: 'make the clip quieter',
    allowedTools: ['get_transcript', 'update_clip'],
    mode: 'tools',
    scope: [f.sequenceId],
  });
  return { ...r, prompts: m.prompts };
}

const cacheCount = (body: unknown) =>
  (JSON.stringify(body).match(/"cache_control":\{"type":"ephemeral"\}/g) ?? []).length;

async function body(entry: ProviderEntry, modelId: string, o: LanguageModelV4CallOptions) {
  const rest = { ...o };
  delete rest.abortSignal;
  const r = await captureRequest(
    (fetch) => createLanguageModel(entry, modelId, { apiKey: 'sk-test', fetch }),
    rest,
  );
  return r.body as Record<string, unknown>;
}

describe('which models get breakpoints (D-76)', () => {
  test.each([
    [{ type: 'anthropic' }, 'claude-sonnet-4-5', 'anthropic'],
    [{ type: 'openrouter' }, 'anthropic/claude-sonnet-4.5', 'anthropic'],
    [{ type: 'openai-compatible', preset: 'opencode-zen' }, 'claude-sonnet-4-5', 'anthropic'],
    [{ type: 'openai-compatible', preset: 'opencode-zen' }, 'gpt-5', undefined],
    [{ type: 'openrouter' }, 'openai/gpt-5-mini', undefined],
    [{ type: 'openai' }, 'gpt-5-mini', undefined],
    [{ type: 'google' }, 'gemini-2.5-flash', undefined],
    [{ type: 'ollama' }, 'qwen3:8b', undefined],
    [{ type: 'apple' }, 'system', undefined],
    [{ type: 'openai-compatible' }, 'claude-sonnet-4-5', undefined],
  ] as const)('%o %s → %s', (provider, modelId, want) => {
    expect(promptCacheTarget({ provider, modelId })).toBe(want);
  });

  test('non-Anthropic history comes back as the same array', () => {
    const msgs = [{ role: 'user' as const, content: 'x' }];
    expect(cachedHistory(undefined, msgs)).toBe(msgs);
  });
});

describe('breakpoints in an Anthropic request (D-76)', () => {
  test('tools, system and history are marked; the state block is after the last breakpoint', async () => {
    const { prompts } = await anthropicRun();
    expect(prompts).toHaveLength(3);
    for (const o of prompts) {
      const blocks = blocksOf(o);
      const bps = blocks.flatMap((b, i) => (b.breakpoint ? [i] : []));
      expect(bps.length).toBeGreaterThanOrEqual(3);
      expect(bps.length).toBeLessThanOrEqual(4);
      // the last block is the state block and is never cached (the fixture's state is below
      // STATE_DIFF_MIN_TOKENS, so it is sent in full every step and not kept, D-81)
      expect(blocks.at(-1)!.json).toContain('[Current state, newest only]');
      expect(blocks.at(-1)!.breakpoint).toBe(false);
      expect(blocks.slice(bps.at(-1)! + 1).every((b) => !b.breakpoint)).toBe(true);
      expect(blocks.filter((b) => b.json.includes('[Current state')).length).toBe(1);
      // the system prompt is a message with a breakpoint, the last tool has one
      expect(o.prompt[0]).toMatchObject({
        role: 'system',
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      });
      expect((o.tools!.at(-1) as { providerOptions?: unknown }).providerOptions).toEqual({
        anthropic: { cacheControl: { type: 'ephemeral' } },
      });
    }
  });

  test('each request starts with the blocks the request before cached', async () => {
    const { prompts } = await anthropicRun();
    for (let i = 1; i < prompts.length; i++) {
      const prev = blocksOf(prompts[i - 1]!);
      const cur = blocksOf(prompts[i]!);
      const lastBp = prev.findLastIndex((b) => b.breakpoint);
      expect(cur.slice(0, lastBp + 1).map((b) => b.json)).toEqual(
        prev.slice(0, lastBp + 1).map((b) => b.json),
      );
    }
  });

  test('the Anthropic package sends cache_control on the last tool, the system and the history', async () => {
    const { prompts } = await anthropicRun();
    const b = await body({ id: 'anthropic', type: 'anthropic' }, 'claude-sonnet-4-5', prompts[2]!);
    expect(cacheCount(b)).toBe(4);
    const tools = b['tools'] as { cache_control?: unknown }[];
    expect(tools.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
    expect((b['system'] as { cache_control?: unknown }[])[0]!.cache_control).toEqual({
      type: 'ephemeral',
    });
    const msgs = b['messages'] as {
      content: { type: string; text?: string; cache_control?: unknown }[];
    }[];
    const lastContent = msgs.at(-1)!.content;
    expect(lastContent.at(-1)!.text).toContain('[Current state');
    expect(lastContent.at(-1)!.cache_control).toBeUndefined();
    expect(lastContent.at(-2)!.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('first step: the instruction is marked, not the state block in the same message', async () => {
    const { prompts } = await anthropicRun();
    const b = await body({ id: 'anthropic', type: 'anthropic' }, 'claude-sonnet-4-5', prompts[0]!);
    const msgs = b['messages'] as { content: { text?: string; cache_control?: unknown }[] }[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content[0]).toMatchObject({
      text: 'make the clip quieter',
      cache_control: { type: 'ephemeral' },
    });
    expect(msgs[0]!.content[1]!.cache_control).toBeUndefined();
  });

  test('OpenRouter passes cache_control through for anthropic/* models', async () => {
    const { prompts } = await anthropicRun({
      provider: { type: 'openrouter', label: 'OpenRouter' },
      modelId: 'anthropic/claude-sonnet-4.5',
    });
    const b = await body(
      { id: 'openrouter', type: 'openrouter' },
      'anthropic/claude-sonnet-4.5',
      prompts[2]!,
    );
    const msgs = b['messages'] as { role: string; content: unknown; cache_control?: unknown }[];
    expect(msgs[0]).toMatchObject({
      role: 'system',
      content: [{ type: 'text', cache_control: { type: 'ephemeral' } }],
    });
    // the history ends on the last tool result (marked); the state block is a user message after it
    const last = msgs.at(-1)!;
    expect(last.role).toBe('user');
    expect(JSON.stringify(last)).not.toContain('cache_control');
    expect(msgs.at(-2)).toMatchObject({ role: 'tool', cache_control: { type: 'ephemeral' } });
    expect(cacheCount(b)).toBeLessThanOrEqual(4);
  });

  test('with the Anthropic cache fake, every step after the first reads the cached prefix', async () => {
    const sim = new AnthropicCacheSim();
    await anthropicRun({}, sim);
    const [first, ...rest] = sim.requests;
    expect(first!.cacheRead).toBe(0);
    expect(first!.cacheWrite).toBeGreaterThan(0);
    for (const u of rest) {
      expect(u.cacheRead).toBeGreaterThan(first!.cacheWrite * 0.9);
      expect(u.noCache).toBeLessThan(u.cacheRead);
    }
  });

  test('plan mode marks the system prompt only; retries read it', async () => {
    const f = await fixtureProject();
    const sim = new AnthropicCacheSim();
    const m = scriptedModel([{ json: {} }, { json: {} }, { json: {} }], {
      usage: (o) => sim.modelUsage(o),
    });
    const { deps } = runDeps(
      f,
      roleModel(m.model, { ...ANTHROPIC, modelId: 'claude-sonnet-4-5' }),
      { limits: { maxUsdPerRun: 100, maxStepsPerRun: 60 } },
    );
    await runAgent(deps, {
      projectId: f.projectId,
      workflow: 'freeform',
      message: 'make the clip quieter',
      allowedTools: ['get_transcript', 'update_clip'],
      mode: 'plan',
      planKind: 'ops',
      // a workflow prompt long enough to pass Anthropic's minimum cacheable prefix
      workflowPrompt: 'Keep every cut on a sentence boundary. '.repeat(150),
      scope: [f.sequenceId],
    });
    expect(m.prompts).toHaveLength(3);
    for (const o of m.prompts) {
      const bps = blocksOf(o).flatMap((b, i) => (b.breakpoint ? [i] : []));
      expect(o.prompt[0]).toMatchObject({
        role: 'system',
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      });
      expect(bps).toEqual([blocksOf(o).findIndex((b) => b.json.startsWith('{"system"'))]);
    }
    expect(sim.requests[0]!.cacheWrite).toBeGreaterThan(0);
    expect(sim.requests[1]!.cacheRead).toBe(sim.requests[0]!.cacheWrite);
  });
});

describe('cache cost accounting (D-76)', () => {
  test('Anthropic prices get 1.25× write and 0.1× read unless the table has its own', () => {
    expect(withCachePrices('anthropic', { inPerMTok: 3, outPerMTok: 15 })).toEqual({
      inPerMTok: 3,
      outPerMTok: 15,
      cacheWritePerMTok: 3.75,
      cacheReadPerMTok: 0.30000000000000004,
    });
    const own = { inPerMTok: 3, outPerMTok: 15, cacheWritePerMTok: 6, cacheReadPerMTok: 0.5 };
    expect(withCachePrices('anthropic', own)).toEqual(own);
    const plain = { inPerMTok: 3, outPerMTok: 15 };
    expect(withCachePrices(undefined, plain)).toBe(plain);
    expect(withCachePrices('anthropic', { free: true })).toEqual({ free: true });
  });

  test('a cache write costs more than fresh input, a read less; no breakdown is full price', () => {
    const p = withCachePrices('anthropic', { inPerMTok: 3, outPerMTok: 15 });
    const fresh = costOfUsage(p, { inputTokens: 1_000_000, outputTokens: 0 });
    const written = costOfUsage(p, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
    });
    const read = costOfUsage(p, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    expect(fresh).toBeCloseTo(3, 9);
    expect(written).toBeCloseTo(3.75, 9);
    expect(read).toBeCloseTo(0.3, 9);
  });

  test('the run bills writes at 1.25× and reads at 0.1× of the input price', async () => {
    const f = await fixtureProject();
    const m = scriptedModel([
      {
        calls: [{ name: 'get_transcript', input: { mediaId: 'm_talk0000000001' } }],
        usage: { input: 1_000_000, cacheWrite: 800_000, output: 0 },
      },
      { text: 'done', usage: { input: 1_000_000, cacheRead: 900_000, output: 0 } },
    ]);
    const { deps } = runDeps(
      f,
      roleModel(m.model, {
        ...ANTHROPIC,
        modelId: 'claude-sonnet-4-5',
        price: { inPerMTok: 1, outPerMTok: 1 },
      }),
      { limits: { maxUsdPerRun: 100, maxStepsPerRun: 60 } },
    );
    const { done } = await runAgent(deps, {
      projectId: f.projectId,
      workflow: 'freeform',
      message: 'read it',
      allowedTools: ['get_transcript'],
      mode: 'tools',
      scope: [f.sequenceId],
    });
    // step 1: 200k fresh + 800k × 1.25; step 2: 100k fresh + 900k × 0.1
    expect(done.costUsd).toBeCloseTo(0.2 + 1.0 + 0.1 + 0.09, 9);
  });

  test('without a breakdown an Anthropic step is billed as all fresh input', async () => {
    const f = await fixtureProject();
    const m = scriptedModel([{ text: 'done', usage: { input: 1_000_000, output: 0 } }]);
    const { deps } = runDeps(
      f,
      roleModel(m.model, {
        ...ANTHROPIC,
        modelId: 'claude-sonnet-4-5',
        price: { inPerMTok: 1, outPerMTok: 1 },
      }),
      { limits: { maxUsdPerRun: 100, maxStepsPerRun: 60 } },
    );
    const { done } = await runAgent(deps, {
      projectId: f.projectId,
      workflow: 'freeform',
      message: 'hi',
      allowedTools: [],
      mode: 'tools',
      scope: [f.sequenceId],
    });
    expect(done.costUsd).toBeCloseTo(1, 9);
  });

  test('the budget bound uses the cache-write rate for Anthropic, the plain rate otherwise', async () => {
    const p = { inPerMTok: 10, outPerMTok: 0 };
    expect(stepUpperBoundUsd(withCachePrices('anthropic', p), 100_000, 0)).toBeCloseTo(1.25, 9);
    expect(stepUpperBoundUsd(withCachePrices(undefined, p), 100_000, 0)).toBeCloseTo(1, 9);
    // a cap between the two: the Anthropic run pauses, the same model elsewhere does not
    const f = await fixtureProject();
    const m = scriptedModel([{ text: 'ok' }]);
    const onPause = vi.fn(() => Promise.resolve({ action: 'stop' as const }));
    const { deps } = runDeps(
      f,
      roleModel(m.model, { ...ANTHROPIC, modelId: 'claude-sonnet-4-5', price: p }),
      { onPause, limits: { maxUsdPerRun: 1, maxStepsPerRun: 60 } },
    );
    const run = await AgentRun.start(deps, {
      projectId: f.projectId,
      workflow: 'freeform',
      message: 'hi',
      allowedTools: [],
      mode: 'tools',
    });
    await expect(run.ensureBudget(deps.models.editor, 90_000)).rejects.toThrow('run stopped');
    expect(onPause).toHaveBeenCalledWith(expect.objectContaining({ reason: 'budget' }));
    const plain = { ...deps.models.editor, provider: { type: 'openai' as const, label: 'OpenAI' } };
    await expect(run.ensureBudget(plain, 90_000)).resolves.toBeUndefined();
  });
});

describe('compaction and the cache (D-76)', () => {
  test('a compaction changes the cached prefix once; tools and system stay cached', async () => {
    const { longTranscriptFile } = await import('../helpers/project.ts');
    const f = await fixtureProject({ transcript: longTranscriptFile(3000) });
    const small = (i: number) => ({
      name: 'get_transcript',
      input: { mediaId: 'm1', fromSrcMs: i * 300, toSrcMs: i * 300 + 200 },
    });
    const sim = new AnthropicCacheSim();
    const m = scriptedModel(
      [
        { calls: [{ name: 'get_transcript', input: { mediaId: 'm_talk0000000001' } }] },
        ...Array.from({ length: 8 }, (_, i) => ({ calls: [small(i + 1)] })),
        {
          calls: [{ name: 'update_clip', input: { sequenceId: 's1', itemId: 'c1', volume: 0.3 } }],
        },
        { text: 'done' },
      ],
      { usage: (o) => sim.modelUsage(o) },
    );
    const { deps } = runDeps(
      f,
      roleModel(m.model, {
        ...ANTHROPIC,
        modelId: 'claude-sonnet-4-5',
        contextTokens: 8_000,
        maxOutputTokens: 100,
      }),
      { limits: { maxUsdPerRun: 100, maxStepsPerRun: 60 } },
    );
    const { done } = await runAgent(deps, {
      projectId: f.projectId,
      workflow: 'freeform',
      message: 'make the clip quieter',
      allowedTools: ['get_transcript', 'update_clip'],
      mode: 'tools',
      scope: [f.sequenceId],
    });
    expect(done.status).toBe('completed');
    const reqs = sim.requests;
    // tools, system prompt and instruction (the first write) are read by every later request
    for (const u of reqs.slice(1)) expect(u.cacheRead).toBeGreaterThanOrEqual(reqs[0]!.cacheWrite);
    // the prefix changes twice: when step 1's result becomes a stub (request 9), and when the
    // write at v2 turns that stub stale (request 11); every other request reads all the previous
    // request cached
    const shrank = reqs
      .map((u, i) =>
        i > 0 && u.cacheRead < reqs[i - 1]!.cacheRead + reqs[i - 1]!.cacheWrite ? i : -1,
      )
      .filter((i) => i >= 0);
    expect(shrank).toEqual([8, 10]);
  });
});
