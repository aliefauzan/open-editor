// Phase 12 step 5, LLM scorer half (D-11): scripted `fast` scores decide the quick-clip ranges; a
// scorer error falls back to the heuristic and the run summary says so.
import { describe, expect, test } from 'vitest';
import { readRunRecord } from '../../src/loop/record.ts';
import { createLlmScorer, scoreOf } from '../../src/quickScorer.ts';
import { runWorkflow } from '../../src/workflows/run-workflow.ts';
import { toolsStylist } from '../helpers/stylists.ts';
import { dynamicModel, FIXTURE_VIDEO, role, workflowKit, type Kit } from '../helpers/workflow.ts';

async function clipOne(kit: Kit, fast: ReturnType<typeof dynamicModel>) {
  kit.deps.models = {
    editor: role(dynamicModel(toolsStylist()).model),
    fast: role(fast.model, { maxOutputTokens: 2_000 }),
  };
  const r = await runWorkflow(kit.deps, {
    projectId: kit.projectId,
    workflow: 'clipper',
    message: `make 1 vox clip from ${FIXTURE_VIDEO}`,
    mode: 'tools',
    count: 1,
    minMs: 4000,
    maxMs: 8000,
    tighten: 'all',
  });
  const quick = readRunRecord(r.run.record.path).find(
    (l) => l.type === 'tool' && l['tool'] === 'quickClips',
  )!['result'] as { scorer: string; clips: { startMs: number; endMs: number; text: string }[] };
  return { r, quick };
}

describe('LLM scorer (step 5)', () => {
  test('scripted scores decide the range', async () => {
    const kit = await workflowKit();
    const fast = dynamicModel((o) => {
      const text = JSON.stringify(o.prompt);
      const ids = [...text.matchAll(/#(\d+) \(\d+ ms\): ([^#]*?)(?=\\n#|\\n<\/data|<\/data)/g)];
      return {
        json: {
          scores: ids.map((m) => {
            const best = /That is all/.test(m[2]!);
            return { index: Number(m[1]), hook: best ? 10 : 1, selfContained: 5, ending: 5 };
          }),
        },
      };
    });
    const { r, quick } = await clipOne(kit, fast);
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(quick.scorer).toBe('llm');
    expect(quick.clips[0]!.text).toMatch(/That is all/);
    expect(fast.prompts.length).toBeGreaterThan(0);
    expect(JSON.stringify(fast.prompts[0]!.prompt)).toContain('<data source=\\"transcript\\">');
    expect(r.done.summary).not.toContain('scorer failed');
  }, 120_000);

  test('a scorer error falls back to the heuristic, reported', async () => {
    const kit = await workflowKit();
    const fast = dynamicModel(() => ({ error: new Error('model is down') }));
    const { r, quick } = await clipOne(kit, fast);
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(quick.scorer).toBe('heuristic');
    expect(r.done.summary).toMatch(
      /The LLM scorer failed \(.+\); the heuristic scorer picked the moments\./,
    );
  }, 120_000);

  test('the score weights hook first', () => {
    expect(scoreOf({ hook: 10, selfContained: 0, ending: 0 })).toBe(4);
    expect(scoreOf({ hook: 0, selfContained: 10, ending: 10 })).toBe(6);
  });
});

describe('LLM scorer: missing scores', () => {
  const candidates = [0, 1, 2].map((index) => ({
    index,
    startMs: index * 5000,
    endMs: index * 5000 + 4000,
    text: `sentence ${String(index)}.`,
  }));
  const host = {
    ensureBudget: () => Promise.resolve(),
    addCost: () => 0,
    record: { write: () => undefined },
  };

  test('a candidate left out is asked for once more, alone', async () => {
    const fast = dynamicModel((_o, n) =>
      n === 0
        ? {
            json: {
              scores: [0, 2].map((index) => ({ index, hook: 5, selfContained: 5, ending: 5 })),
            },
          }
        : { json: { scores: [{ index: 1, hook: 10, selfContained: 10, ending: 10 }] } },
    );
    const fn = createLlmScorer(host, role(fast.model));
    const s = await fn({ mediaId: 'm_x', candidates }, { signal: new AbortController().signal });
    expect(s).toEqual([5, 10, 5]);
    expect(fast.prompts).toHaveLength(2);
    expect(JSON.stringify(fast.prompts[1]!.prompt)).toContain('#1 (4000 ms)');
    expect(JSON.stringify(fast.prompts[1]!.prompt)).not.toContain('#0 (4000 ms)');
  });

  test('still missing after the follow-up: the scorer fails (the engine falls back)', async () => {
    const fast = dynamicModel(() => ({ json: { scores: [] } }));
    const fn = createLlmScorer(host, role(fast.model));
    await expect(
      fn({ mediaId: 'm_x', candidates }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/left 3 candidate\(s\) unscored/);
  });
});

describe('LLM scorer: renumbered answers', () => {
  test('an answer that renumbers from 0 (no index matches, same count) is taken in order', async () => {
    const candidates = [4, 7].map((index) => ({ index, startMs: 0, endMs: 4000, text: 'x.' }));
    const fast = dynamicModel(() => ({
      json: {
        scores: [
          { index: 0, hook: 10, selfContained: 0, ending: 0 },
          { index: 1, hook: 0, selfContained: 10, ending: 0 },
        ],
      },
    }));
    const host = {
      ensureBudget: () => Promise.resolve(),
      addCost: () => 0,
      record: { write: () => undefined },
    };
    const fn = createLlmScorer(host, role(fast.model));
    const s = await fn({ mediaId: 'm_x', candidates }, { signal: new AbortController().signal });
    expect(s).toEqual([4, 3.5]);
  });
});
