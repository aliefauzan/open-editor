// D-76: Anthropic prompt caching in the agent loop. Every other provider must get the same request
// as before caching existed: the HTTP bodies of a scripted tools run and a plan run, serialised by
// the real provider packages, are compared with a golden file recorded on the code before D-76.
// Run with VOX_RECORD_GOLDEN=1 to record the golden file again (only on purpose). Re-recorded once
// for D-81: only the get_transcript tool (schema, description, its compact result) and the plan
// mode transcript lines changed; the state block and everything else are byte for byte as before.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { describe, expect, test } from 'vitest';
import { runAgent } from '../../src/loop/run.ts';
import { captureRequest } from '../../src/providers/capture.ts';
import { createLanguageModel } from '../../src/providers/factory.ts';
import type { ProviderEntry } from '../../src/providers/presets.ts';
import { roleModel, runDeps, scriptedModel, type ScriptStep } from '../helpers/model.ts';
import { fixtureProject } from '../helpers/project.ts';

const GOLDEN = new URL('../fixtures/requests/non-anthropic.json', import.meta.url).pathname;
const RECORD = process.env['VOX_RECORD_GOLDEN'] === '1';

/** Non-Anthropic providers: each must see exactly the pre-D-76 request. */
const PROVIDERS: { name: string; entry: ProviderEntry; modelId: string }[] = [
  { name: 'openai', entry: { id: 'openai', type: 'openai' }, modelId: 'gpt-5-mini' },
  { name: 'google', entry: { id: 'google', type: 'google' }, modelId: 'gemini-2.5-flash' },
  {
    name: 'openrouter',
    entry: { id: 'openrouter', type: 'openrouter' },
    modelId: 'openai/gpt-5-mini',
  },
  {
    name: 'openai-compatible',
    entry: { id: 'lmstudio', type: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' },
    modelId: 'qwen3-8b',
  },
  { name: 'ollama', entry: { id: 'ollama', type: 'ollama' }, modelId: 'qwen3:8b' },
];

const TOOLS_SCRIPT: ScriptStep[] = [
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

/**
 * Temp folders, project ids and link ids are random per run: each is replaced (link ids by their
 * order of first appearance) so runs compare. Nothing else is touched.
 */
const TMP = tmpdir();
const normalise = (v: unknown): unknown => {
  const links = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(v)
      .split(TMP)
      .join('<TMP>')
      .replace(/<TMP>\/[A-Za-z0-9._-]+/g, '<TMP>/x')
      .replace(/\bp_[A-Za-z0-9]{12}\b/g, 'p_X')
      .replace(/\bln_[A-Za-z0-9]+\b/g, (id) => {
        if (!links.has(id)) links.set(id, `ln_${String(links.size + 1)}`);
        return links.get(id)!;
      }),
  );
};

/** The provider-facing call options of a scripted run, one per model request. */
async function callOptions(
  type: ProviderEntry['type'],
  modelId: string,
  mode: 'tools' | 'plan',
): Promise<LanguageModelV4CallOptions[]> {
  const f = await fixtureProject();
  const script: ScriptStep[] =
    mode === 'tools' ? TOOLS_SCRIPT : [{ json: {} }, { json: {} }, { json: {} }];
  const m = scriptedModel(script);
  const { deps } = runDeps(f, roleModel(m.model, { provider: { type, label: type }, modelId }));
  await runAgent(deps, {
    projectId: f.projectId,
    workflow: 'freeform',
    message: 'make the clip quieter',
    allowedTools: ['get_transcript', 'update_clip'],
    mode,
    ...(mode === 'plan' && { planKind: 'ops' as const }),
    scope: [f.sequenceId],
  });
  return m.prompts;
}

/** The HTTP bodies each non-Anthropic provider would send for the scripted runs. */
async function bodies(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const p of PROVIDERS) {
    for (const mode of ['tools', 'plan'] as const) {
      const opts = await callOptions(p.entry.type, p.modelId, mode);
      const list: unknown[] = [];
      for (const o of opts) {
        const rest = { ...o };
        delete rest.abortSignal;
        const r = await captureRequest(
          (fetch) => createLanguageModel(p.entry, p.modelId, { apiKey: 'sk-test', fetch }),
          rest,
        );
        list.push(r.body);
      }
      out[`${p.name}/${mode}`] = normalise(list) as unknown[];
    }
  }
  return out;
}

describe('non-Anthropic requests are unchanged by prompt caching (D-76)', () => {
  test('HTTP bodies match the pre-D-76 golden file', async () => {
    const got = await bodies();
    if (RECORD || !existsSync(GOLDEN)) {
      if (!RECORD)
        throw new Error(`golden file missing: ${GOLDEN} (record with VOX_RECORD_GOLDEN=1)`);
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, `${JSON.stringify(got, null, 1)}\n`);
      return;
    }
    const want = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown[]>;
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    for (const k of Object.keys(want)) {
      expect(got[k]!.length, k).toBe(want[k]!.length);
      // byte-identical: compare the serialised bodies, not just deep equality
      expect(JSON.stringify(got[k]), k).toBe(JSON.stringify(want[k]));
    }
  }, 120_000);

  test('two runs give the same bodies (the golden comparison is meaningful)', async () => {
    const a = await bodies();
    const b = await bodies();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  }, 120_000);
});
