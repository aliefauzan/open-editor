// Tool-list cost (D-15, phase 11 step 14 probe half): the token count of a tool list as the
// provider serialises it; more than 25 % of the role's effective context fails the role.
import { tool } from 'ai';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { providerEntryFromPreset, type PresetId } from '../../src/providers/presets.ts';
import {
  TOOL_LIST_MAX_SHARE,
  checkToolListCost,
  estimateTokens,
  measureToolListCost,
  serializedToolList,
  toolDefinitions,
  type ToolDefinition,
} from '../../src/providers/tool-cost.ts';

const defs = (count: number): ToolDefinition[] =>
  Array.from({ length: count }, (_, i) => ({
    name: `tool_${String(i)}`,
    description: `Tool number ${String(i)}: moves an item on the timeline (sequence time, ms).`,
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Item alias, e.g. c1' },
        startMs: { type: 'integer', minimum: 0 },
      },
      required: ['itemId', 'startMs'],
      additionalProperties: false,
    },
  }));

describe('toolDefinitions', () => {
  test('turns an AI SDK tool set into name, description and JSON Schema', async () => {
    const list = await toolDefinitions({
      move_item: tool({
        description: 'Moves an item.',
        inputSchema: z.object({ itemId: z.string(), startMs: z.int().min(0) }),
      }),
    });
    expect(list).toEqual([
      {
        name: 'move_item',
        description: 'Moves an item.',
        inputSchema: expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({ itemId: { type: 'string' } }),
        }),
      },
    ]);
  });
});

describe('serializedToolList: the tools part of the real request body', () => {
  test.each([
    ['claude', 'claude-sonnet-4-5', 'input_schema'],
    ['openrouter', 'qwen/qwen3-coder', '"parameters"'],
    ['openai', 'gpt-5-mini', '"parameters"'],
    ['gemini', 'gemini-2.5-flash', 'functionDeclarations'],
    ['ollama', 'qwen3:8b', '"parameters"'],
    ['lmstudio', 'qwen3-8b', '"parameters"'],
    ['opencode-zen', 'claude-sonnet-4-5', 'input_schema'],
  ] as const)('%s serialises the list in its own format', async (preset, model, marker) => {
    const s = await serializedToolList(providerEntryFromPreset(preset as PresetId), model, defs(2));
    expect(s).toContain(marker);
    expect(s).toContain('tool_0');
    expect(s).toContain('tool_1');
    expect(s).not.toContain('"hi"'); // only the tools, not the prompt
  });

  test('apple has no tool calls', async () => {
    await expect(
      serializedToolList(providerEntryFromPreset('apple'), 'apple-on-device', defs(1)),
    ).rejects.toMatchObject({ code: 'PROBE_FAILED' });
  });

  test('an empty list costs nothing', async () => {
    expect(await serializedToolList(providerEntryFromPreset('claude'), 'm', [])).toBe('');
  });
});

describe('checkToolListCost', () => {
  test('25 % is the limit: at the limit passes, one token over fails', () => {
    expect(TOOL_LIST_MAX_SHARE).toBe(0.25);
    expect(checkToolListCost(8000, 32000)).toEqual({ status: 'pass' });
    expect(checkToolListCost(8001, 32000)).toMatchObject({ status: 'fail' });
  });

  test('an unknown context fails with a hint to enter it', () => {
    expect(checkToolListCost(10, null)).toMatchObject({
      status: 'fail',
      reason: expect.stringMatching(/context/),
    });
  });

  test('estimateTokens counts one token per 3 UTF-16 units, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('x'.repeat(300))).toBe(100);
  });
});

describe('measureToolListCost', () => {
  test('a small list passes on a 32k context; a large one fails', async () => {
    const entry = providerEntryFromPreset('ollama');
    const small = await measureToolListCost({
      entry,
      modelId: 'qwen3:8b',
      tools: defs(3),
      contextTokens: 32768,
    });
    expect(small.result).toEqual({ status: 'pass' });
    expect(small.tokens).toBeGreaterThan(0);
    expect(small.share).toBeCloseTo(small.tokens / 32768);

    const big = await measureToolListCost({
      entry,
      modelId: 'qwen3:8b',
      tools: defs(200),
      contextTokens: 32768,
    });
    expect(big.result.status).toBe('fail');
    expect(big.tokens).toBeGreaterThan(32768 * 0.25);
  });

  test('a custom token counter is used when given', async () => {
    const r = await measureToolListCost({
      entry: providerEntryFromPreset('claude'),
      modelId: 'claude-sonnet-4-5',
      tools: defs(1),
      contextTokens: 100,
      countTokens: () => 26,
    });
    expect(r).toMatchObject({ tokens: 26, share: 0.26, result: { status: 'fail' } });
  });
});
