// Step 20 (D-15): a recorded mock run replays to the same tool results and history versions; a
// changed tool result in the record fails the replay.
import { describe, expect, test } from 'vitest';
import { readRunRecord } from '../../src/loop/record.ts';
import { runAgent } from '../../src/loop/run.ts';
import { roleModel, runDeps, scriptedModel } from '../helpers/model.ts';
import { fixtureProject } from '../helpers/project.ts';
import { replay } from './harness.ts';

async function recordedRun() {
  const f = await fixtureProject();
  const m = scriptedModel([
    { calls: [{ name: 'get_transcript', input: { mediaId: 'm_talk0000000001', fromSrcMs: 0, toSrcMs: 3000 } }] },
    { calls: [{ name: 'split_item', input: '{"sequenceId": "s1", "itemId": "c1", "atMs": 5000,}' }] },
    { calls: [{ name: 'update_clip', input: { sequenceId: 's1', itemId: 'c3', volume: 0.5 } }] },
    { text: 'Split and lowered the second half.' },
  ]);
  const { deps } = runDeps(f, roleModel(m.model));
  const { run, done } = await runAgent(deps, {
    projectId: f.projectId,
    workflow: 'freeform',
    message: 'split at 5 s and lower the second half',
    allowedTools: ['get_transcript', 'split_item', 'update_clip'],
    mode: 'tools',
    scope: [f.sequenceId],
  });
  expect(done.status).toBe('completed');
  return readRunRecord(run.record.path);
}

describe('replay harness (step 20)', () => {
  test('a recorded run replays to the same tool results and versions', async () => {
    const lines = await recordedRun();
    const r = await replay(lines, await fixtureProject());
    expect(r.mismatches).toEqual([]);
    expect(r.recorded.map((t) => t.tool)).toEqual(['get_transcript', 'split_item', 'update_clip']);
    expect(r.replayed.flatMap((t) => t.versions ?? [])).toEqual([2, 3]);
  });

  test('a changed tool result fails the replay', async () => {
    const lines = await recordedRun();
    const i = lines.findIndex((l) => l.type === 'tool' && l['tool'] === 'update_clip');
    lines[i] = { ...lines[i]!, result: { version: 3, results: [{ op: 'updateClip', status: 'failed' }] } };
    const r = await replay(lines, await fixtureProject());
    expect(r.ok).toBe(false);
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0]).toMatch(/^tool call 2:/);
  });
});
