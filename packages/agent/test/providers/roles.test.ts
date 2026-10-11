// Role rules (agent spec "Model roles", "Capability probe", "Plan mode" → mode selection; phase 11
// steps 8 and 10, probe half): which probe results let a model fill a role, and in which mode.
import { describe, expect, test } from 'vitest';
import type { CheckResult } from '../../src/providers/probe.ts';
import { providerEntryFromPreset, type ProviderEntry } from '../../src/providers/presets.ts';
import type { PriceTable } from '../../src/providers/prices.ts';
import {
  EDITOR_MIN_CONTEXT,
  ROLES,
  assertRoleAssignable,
  roleCheck,
  selectMode,
  type ProbeReport,
} from '../../src/providers/roles.ts';

const PASS: CheckResult = { status: 'pass' };
const FAIL: CheckResult = { status: 'fail', reason: 'no valid call' };
const PRICES: PriceTable = {
  'qwen/qwen3-coder': { inPerMTok: 0.2, outPerMTok: 0.8 },
  'claude-sonnet-4-5': { inPerMTok: 3, outPerMTok: 15 },
};

const toolList = (tokens: number, contextTokens: number) => ({
  tokens,
  contextTokens,
  share: tokens / contextTokens,
  result:
    tokens <= contextTokens / 4
      ? PASS
      : ({ status: 'fail', reason: 'too many tools' } as CheckResult),
});

const strong: ProbeReport = {
  tools: PASS,
  loop: PASS,
  plan: PASS,
  vision: PASS,
  context: { contextTokens: 200_000, source: 'config' },
  toolList: toolList(6_000, 200_000),
};

const openrouter = providerEntryFromPreset('openrouter');
const ollama = providerEntryFromPreset('ollama');
const lmstudio = providerEntryFromPreset('lmstudio');
const apple = providerEntryFromPreset('apple');
const claude = providerEntryFromPreset('claude');

describe('ROLES', () => {
  test('editor, vision, fast and the optional image and embed', () => {
    expect(ROLES).toEqual(['editor', 'vision', 'fast', 'image', 'embed']);
    expect(EDITOR_MIN_CONTEXT).toBe(32_000);
  });
});

describe('selectMode', () => {
  test('tools for a model that passes the loop probe on a hosted provider', () => {
    expect(selectMode({ provider: openrouter, probe: strong })).toBe('tools');
  });

  test('plan for a model that fails or never ran the loop probe', () => {
    expect(selectMode({ provider: openrouter, probe: { ...strong, loop: FAIL } })).toBe('plan');
    expect(selectMode({ provider: openrouter, probe: { tools: PASS } })).toBe('plan');
  });

  test('plan by default for Ollama, LM Studio and Apple', () => {
    for (const provider of [ollama, lmstudio, apple]) {
      expect(selectMode({ provider, probe: strong })).toBe('plan');
    }
  });

  test('--mode overrides, except that Apple never runs in tools mode', () => {
    expect(selectMode({ provider: ollama, probe: strong, override: 'tools' })).toBe('tools');
    expect(selectMode({ provider: openrouter, probe: strong, override: 'plan' })).toBe('plan');
    expect(() => selectMode({ provider: apple, probe: strong, override: 'tools' })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });
});

describe('roleCheck: price', () => {
  test('an unpriced paid model cannot fill any role', () => {
    const v = roleCheck('fast', {
      provider: openrouter,
      model: 'new/unpriced',
      probe: strong,
      priceTables: [PRICES],
    });
    expect(v.assignable).toBe(false);
    expect(v.failures).toContainEqual(expect.objectContaining({ check: 'price' }));
  });

  test('a model marked free and a local model pass the price rule', () => {
    expect(
      roleCheck('fast', {
        provider: openrouter,
        model: 'free/model',
        probe: strong,
        priceTables: [{ 'free/model': { free: true } }],
      }).assignable,
    ).toBe(true);
    expect(
      roleCheck('fast', { provider: ollama, model: 'qwen3:8b', probe: strong, priceTables: [] })
        .assignable,
    ).toBe(true);
  });
});

describe('roleCheck: editor', () => {
  const args = (probe: ProbeReport, provider: ProviderEntry = openrouter) => ({
    provider,
    model: 'qwen/qwen3-coder',
    probe,
    priceTables: [PRICES],
  });

  test('tools mode: tools, loop and the tool-list cost must pass, context ≥ 32k', () => {
    expect(roleCheck('editor', args(strong))).toEqual({
      role: 'editor',
      assignable: true,
      mode: 'tools',
      failures: [],
    });
  });

  test('tools mode with the tool list unmeasured fails', () => {
    const noList: ProbeReport = { ...strong };
    delete noList.toolList;
    const v = roleCheck('editor', { ...args(noList), mode: 'tools' });
    expect(v.assignable).toBe(false);
    expect(v.failures).toContainEqual(expect.objectContaining({ check: 'toolList' }));
  });

  test('a tool list over 25 % of the context fails the role', () => {
    const v = roleCheck('editor', args({ ...strong, toolList: toolList(60_000, 200_000) }));
    expect(v.assignable).toBe(false);
    expect(v.failures).toEqual([{ check: 'toolList', reason: 'too many tools' }]);
  });

  test('plan mode: the plan probe decides; tools and loop are not needed', () => {
    const v = roleCheck('editor', args({ ...strong, tools: FAIL, loop: FAIL }));
    expect(v).toMatchObject({ assignable: true, mode: 'plan' });
    const bad = roleCheck('editor', args({ ...strong, loop: FAIL, plan: FAIL }));
    expect(bad.assignable).toBe(false);
    expect(bad.failures).toContainEqual({ check: 'plan', reason: 'no valid call' });
  });

  test('context below 32k or unknown fails', () => {
    const small = roleCheck(
      'editor',
      args({ ...strong, context: { contextTokens: 31_999, source: 'config' } }),
    );
    expect(small.failures).toContainEqual(expect.objectContaining({ check: 'context' }));
    const at = roleCheck(
      'editor',
      args({
        ...strong,
        context: { contextTokens: 32_000, source: 'config' },
        toolList: toolList(1_000, 32_000),
      }),
    );
    expect(at.assignable).toBe(true);
    const unknown = roleCheck(
      'editor',
      args({ ...strong, context: { contextTokens: null, source: 'unknown' } }),
    );
    expect(unknown.failures).toContainEqual(expect.objectContaining({ check: 'context' }));
  });

  test('Ollama with a 32k num_ctx and a passing plan probe can be the plan-mode editor', () => {
    const v = roleCheck('editor', {
      provider: ollama,
      model: 'qwen3:8b',
      probe: {
        plan: PASS,
        loop: FAIL,
        context: { contextTokens: 32_768, source: 'ollama', advertised: 40_960, numCtx: 32_768 },
      },
      priceTables: [],
    });
    expect(v).toMatchObject({ assignable: true, mode: 'plan', failures: [] });
  });

  test('a probe that errored is reported with its reason', () => {
    const v = roleCheck('editor', {
      ...args({ ...strong, tools: { status: 'error', reason: 'request failed (HTTP 401)' } }),
      mode: 'tools',
    });
    expect(v.failures).toContainEqual({ check: 'tools', reason: 'request failed (HTTP 401)' });
  });
});

describe('roleCheck: vision, fast, image, embed', () => {
  const base = { provider: claude, model: 'claude-sonnet-4-5', priceTables: [PRICES] };

  test('vision needs the vision probe', () => {
    expect(roleCheck('vision', { ...base, probe: strong }).assignable).toBe(true);
    expect(roleCheck('vision', { ...base, probe: { ...strong, vision: FAIL } }).failures).toEqual([
      { check: 'vision', reason: 'no valid call' },
    ]);
    expect(roleCheck('vision', { ...base, probe: { plan: PASS } }).failures).toEqual([
      { check: 'vision', reason: 'not probed' },
    ]);
  });

  test('fast needs the plan/json probe and nothing else (no mode)', () => {
    const v = roleCheck('fast', { ...base, probe: { plan: PASS } });
    expect(v).toEqual({ role: 'fast', assignable: true, failures: [] });
    expect(roleCheck('fast', { ...base, probe: { plan: FAIL } }).assignable).toBe(false);
  });

  test('image and embed need their declared capability', () => {
    expect(roleCheck('image', { ...base, probe: strong }).failures).toEqual([
      { check: 'imageOutput', reason: 'the model does not output images' },
    ]);
    expect(
      roleCheck('image', { ...base, probe: { capabilities: { imageOutput: true } } }).assignable,
    ).toBe(true);
    expect(
      roleCheck('embed', { ...base, probe: { capabilities: { embeddings: true } } }).assignable,
    ).toBe(true);
    expect(roleCheck('embed', { ...base, probe: strong }).assignable).toBe(false);
  });
});

describe('roleCheck: Apple on-device', () => {
  const appleProbe: ProbeReport = {
    plan: PASS,
    appleStatus: 'ready',
    context: { contextTokens: 4_096, source: 'apple' },
  };
  const args = (probe: ProbeReport) => ({
    provider: apple,
    model: 'apple-on-device',
    probe,
    priceTables: [],
  });

  test('a ready Apple model with a passing plan probe fills fast, free of charge', () => {
    expect(roleCheck('fast', args(appleProbe))).toEqual({
      role: 'fast',
      assignable: true,
      failures: [],
    });
  });

  test('it is the editor only in plan mode and only with ≥ 32k context (so usually not)', () => {
    const v = roleCheck('editor', args(appleProbe));
    expect(v.mode).toBe('plan');
    expect(v.failures).toEqual([expect.objectContaining({ check: 'context' })]);
    expect(
      roleCheck(
        'editor',
        args({ ...appleProbe, context: { contextTokens: 32_768, source: 'apple' } }),
      ).assignable,
    ).toBe(true);
  });

  test('a status other than ready fails every role with the status hint', () => {
    const v = roleCheck('fast', args({ ...appleProbe, appleStatus: 'notEnabled' }));
    expect(v.assignable).toBe(false);
    expect(v.failures).toEqual([
      { check: 'apple', reason: expect.stringMatching(/notEnabled.*Apple Intelligence/) },
    ]);
  });

  test('vision, image and embed are never Apple roles', () => {
    for (const role of ['vision', 'image', 'embed'] as const) {
      expect(roleCheck(role, args({ ...appleProbe, vision: PASS })).assignable).toBe(false);
    }
  });
});

describe('assertRoleAssignable', () => {
  test('an unpriced model throws PRICE_MISSING (G1 message)', () => {
    expect(() =>
      assertRoleAssignable('editor', {
        provider: openrouter,
        model: 'new/unpriced',
        probe: strong,
        priceTables: [PRICES],
      }),
    ).toThrow(expect.objectContaining({ code: 'PRICE_MISSING' }));
  });

  test('a failed probe throws PROBE_FAILED naming the failed checks', () => {
    let caught: unknown;
    try {
      assertRoleAssignable('vision', {
        provider: claude,
        model: 'claude-sonnet-4-5',
        probe: { ...strong, vision: FAIL },
        priceTables: [PRICES],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({
      code: 'PROBE_FAILED',
      message: expect.stringContaining('vision'),
      details: { role: 'vision', model: 'claude-sonnet-4-5', failures: [{ check: 'vision' }] },
    });
  });

  test('an assignable model returns the verdict', () => {
    expect(
      assertRoleAssignable('editor', {
        provider: openrouter,
        model: 'qwen/qwen3-coder',
        probe: strong,
        priceTables: [PRICES],
      }),
    ).toMatchObject({ assignable: true, mode: 'tools' });
  });
});
