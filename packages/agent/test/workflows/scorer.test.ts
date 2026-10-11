// Phase 12 step 5, LLM scorer half (D-11): scripted `fast` scores decide the quick-clip ranges; a
// scorer error falls back to the heuristic and the run summary says so.
import { describe, expect, test } from 'vitest';
import { readRunRecord } from '../../src/loop/record.ts';
import { scoreOf } from '../../src/quickScorer.ts';
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
    expect(r.done.summary).toMatch(/The LLM scorer failed \(.+\); the heuristic scorer picked the moments\./);
  }, 120_000);

  test('the score weights hook first', () => {
    expect(scoreOf({ hook: 10, selfContained: 0, ending: 0 })).toBe(4);
    expect(scoreOf({ hook: 0, selfContained: 10, ending: 10 })).toBe(6);
  });
});
