// Steps 10 and 14: the probe runner assembles a report per capability (incl. `plan`, a ClipPlan
// for a fixture sequence) and measures the editor's largest tool list; a role whose probe failed
// cannot be assigned, and a tool list over 25 % of the context fails the editor.
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { APPLE_NO_VISION_REASON } from '../../src/providers/apple.ts';
import { providerEntryFromPreset, type ProviderEntry } from '../../src/providers/presets.ts';
import { assertRoleAssignable, roleCheck } from '../../src/providers/roles.ts';
import { CLIP_PLAN_TASK, largestToolList, probeModel } from '../../src/providers/run-probe.ts';
import { scriptedModel } from '../helpers/model.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-apple-llm.mjs', import.meta.url));
const pass = () => Promise.resolve({ status: 'pass' as const });
const failWith = (reason: string) => () => Promise.resolve({ status: 'fail' as const, reason });

function entry(contextTokens: number): ProviderEntry {
  const e = providerEntryFromPreset('9router', { baseUrl: 'https://router.example/v1' });
  return { ...e, options: { ...(e.options ?? {}), contextTokens: { 'gw/model': contextTokens } } };
}
const prices = [{ 'gw/model': { inPerMTok: 1, outPerMTok: 2 } }];
const { model } = scriptedModel([]);

describe('probe runner (step 10)', () => {
  test('every check passes: the editor can be assigned in tools mode', async () => {
    const e = entry(128_000);
    const report = await probeModel(e, 'gw/model', model, {
      checks: { tools: pass, loop: pass, vision: pass, plan: pass },
    });
    expect(report).toMatchObject({
      tools: { status: 'pass' },
      loop: { status: 'pass' },
      vision: { status: 'pass' },
      plan: { status: 'pass' },
      context: { contextTokens: 128_000, source: 'config' },
      toolList: { result: { status: 'pass' } },
    });
    expect(report.toolList!.tokens).toBeGreaterThan(500);
    expect(
      roleCheck('editor', { provider: e, model: 'gw/model', probe: report, priceTables: prices }),
    ).toMatchObject({
      assignable: true,
      mode: 'tools',
    });
  });

  test('a failed capability makes `roles set` refuse with that capability (PROBE_FAILED)', async () => {
    const e = entry(128_000);
    const report = await probeModel(e, 'gw/model', model, {
      checks: { tools: pass, loop: pass, vision: failWith('named the wrong colour'), plan: pass },
    });
    expect(() =>
      assertRoleAssignable('vision', {
        provider: e,
        model: 'gw/model',
        probe: report,
        priceTables: prices,
      }),
    ).toThrow(
      expect.objectContaining({ code: 'PROBE_FAILED', message: expect.stringContaining('vision') }),
    );
  });

  test('a tool list over 25 % of the context fails the editor (D-15)', async () => {
    const tokens = (await probeModel(entry(128_000), 'gw/model', model, { only: [] })).toolList!
      .tokens;
    const e = entry(Math.max(4_000, Math.floor(tokens * 3)));
    const report = await probeModel(e, 'gw/model', model, {
      checks: { tools: pass, loop: pass, vision: pass, plan: pass },
    });
    expect(report.toolList?.result.status).toBe('fail');
    const v = roleCheck('editor', {
      provider: e,
      model: 'gw/model',
      probe: report,
      priceTables: prices,
    });
    expect(v.assignable).toBe(false);
    expect(v.failures.map((f) => f.check)).toContain('toolList');
  });

  test('the largest list is a workflow’s allowedTools plus the always-present tools', () => {
    const names = largestToolList([
      ['get_transcript'],
      ['get_transcript', 'view_frames', 'check_audio'],
    ]).map((d) => d.name);
    expect(names.sort()).toEqual(
      [
        'get_transcript',
        'view_frames',
        'check_audio',
        'describe_tool',
        'call_tool',
        'get_sequence',
        'update_todos',
        'undo_my_last_edit',
      ].sort(),
    );
  });

  test('the plan check: a valid ClipPlan passes, an invalid one fails', async () => {
    const good = scriptedModel([
      {
        json: {
          sequences: [
            {
              sequenceId: 's1',
              beats: [
                {
                  startMs: 0,
                  endMs: 3000,
                  kind: 'scene',
                  template: 'base/title',
                  variables: { title: 'Lighthouse' },
                },
                { startMs: 3000, endMs: 20000, kind: 'speaker' },
              ],
            },
          ],
        },
      },
    ]);
    const r1 = await probeModel(entry(128_000), 'gw/model', good.model, { only: ['plan'] });
    expect(r1.plan).toEqual({ status: 'pass' });
    expect(JSON.stringify(good.prompts[0]!.prompt)).toContain('lighthouse');
    const bad = scriptedModel([
      {
        json: {
          sequences: [{ sequenceId: 's1', beats: [{ startMs: 5000, endMs: 1000, kind: 'scene' }] }],
        },
      },
    ]);
    const r2 = await probeModel(entry(128_000), 'gw/model', bad.model, { only: ['plan'] });
    expect(r2.plan?.status).toBe('fail');
    expect(CLIP_PLAN_TASK.prompt).toContain('Sequence s1');
  });

  test('Apple: status, plan and vision only; a helper that is not ready skips the plan', async () => {
    const e = providerEntryFromPreset('apple');
    const plan = vi.fn(pass);
    const vision = vi.fn(pass);
    const ready = await probeModel(e, 'apple/on-device', model, {
      apple: { command: process.execPath, args: [FAKE], env: { VOX_FAKE_APPLE_CONTEXT: '4096' } },
      checks: { plan, vision, tools: pass },
    });
    // a helper that reports no vision (older than D-74, or before macOS 27) fails the vision
    // check without sending an image
    expect(ready).toEqual({
      appleStatus: 'ready',
      context: { contextTokens: 4096, source: 'apple' },
      // a helper without the `embed` flag (older than D-77) cannot embed
      capabilities: { embeddings: false },
      vision: { status: 'fail', reason: APPLE_NO_VISION_REASON },
      plan: { status: 'pass' },
    });
    expect(vision).not.toHaveBeenCalled();
    const off = await probeModel(e, 'apple/on-device', model, {
      apple: {
        command: process.execPath,
        args: [FAKE],
        env: { VOX_FAKE_APPLE_STATUS: 'notEnabled' },
      },
      checks: { plan },
    });
    expect(off.appleStatus).toBe('notEnabled');
    expect(plan).toHaveBeenCalledTimes(1);
    expect(
      roleCheck('fast', { provider: e, model: 'apple/on-device', probe: off, priceTables: [] })
        .failures[0]?.reason,
    ).toMatch(/^notEnabled: Turn on Apple Intelligence/);
  });

  test('Apple with vision (macOS 27, D-74): the vision check runs and the role can be vision', async () => {
    const e = providerEntryFromPreset('apple');
    const vision = vi.fn(pass);
    const report = await probeModel(e, 'apple/on-device', model, {
      apple: {
        command: process.execPath,
        args: [FAKE],
        env: { VOX_FAKE_APPLE_CONTEXT: '8192', VOX_FAKE_APPLE_VISION: '1' },
      },
      checks: { plan: pass, vision },
    });
    expect(vision).toHaveBeenCalledTimes(1);
    expect(report.vision).toEqual({ status: 'pass' });
    expect(
      roleCheck('vision', { provider: e, model: 'apple/on-device', probe: report, priceTables: [] })
        .assignable,
    ).toBe(true);
    const off = await probeModel(e, 'apple/on-device', model, {
      apple: { command: process.execPath, args: [FAKE], env: { VOX_FAKE_APPLE_VISION: '0' } },
      checks: { plan: pass, vision },
    });
    expect(vision).toHaveBeenCalledTimes(1);
    expect(() =>
      assertRoleAssignable('vision', {
        provider: e,
        model: 'apple/on-device',
        probe: off,
        priceTables: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'PROBE_FAILED' }));
    const planOnly = await probeModel(e, 'apple/on-device', model, {
      apple: { command: process.execPath, args: [FAKE], env: { VOX_FAKE_APPLE_VISION: '1' } },
      checks: { plan: pass, vision },
      only: ['plan'],
    });
    expect(planOnly.vision).toBeUndefined();
    expect(vision).toHaveBeenCalledTimes(1);
  });
});
