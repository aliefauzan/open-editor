// D-81: the state block as a diff. The full block is the pre-D-81 injection text; with a caching
// editor later steps send only the changes, a full block comes at the start, every
// STATE_FULL_EVERY steps and after a compaction, and the blocks stay in the history.
import { describe, expect, test } from 'vitest';
import { readRunRecord } from '../../src/loop/record.ts';
import { AgentRun, runAgent } from '../../src/loop/run.ts';
import {
  DIFF_STATE_HEADER,
  FULL_STATE_HEADER,
  STATE_FULL_EVERY,
  StateTracker,
  renderFullState,
  renderStateDiff,
  type StateSnapshot,
} from '../../src/loop/state.ts';
import { roleModel, runDeps, scriptedModel, type ScriptStep } from '../helpers/model.ts';
import { fixtureProject, longTranscriptFile } from '../helpers/project.ts';

const ANTHROPIC = {
  provider: { type: 'anthropic' as const, label: 'Anthropic' },
  modelId: 'claude-sonnet-4-5',
};

const item = (id: string, startMs: number, endMs: number) => ({
  id,
  track: 'V1',
  startMs,
  endMs,
  kind: 'video',
});

const snap = (
  over: Partial<StateSnapshot['sequences'][number]> = {},
  note = '',
): StateSnapshot => ({
  sequences: [
    {
      alias: 's1',
      version: 3,
      items: [item('c1', 0, 5000), item('c2', 5000, 9000), item('c3', 9000, 12000)],
      captions: ['0–1200 Hello and welcome', '1200–2600 to the demo'],
      ...over,
    },
  ],
  note,
});

const MORE = Array.from(
  { length: 10 },
  (_, i) => `${String(3000 + i * 1000)}–${String(3900 + i * 1000)} more words ${String(i)}`,
);

describe('state diff rendering (D-81)', () => {
  test('no change: one short line per sequence', () => {
    const d = renderStateDiff(snap(), snap());
    expect(d).toBe(`${DIFF_STATE_HEADER}\nSequence s1 @v3: no change`);
  });

  test('changed, added and removed items; caption lines added and removed; the note', () => {
    const cur = snap(
      {
        version: 5,
        items: [item('c1', 0, 4000), item('c3', 9000, 12000), item('c4', 12000, 13000)],
        captions: ['0–1200 Hello and welcome', '1200–2600 to our demo', ...MORE],
      },
      'Changes since your last step (not yours; re-read before editing these):\n- v4 by user: trimItem → c1',
    );
    const d = renderStateDiff(snap({ captions: [...snap().sequences[0]!.captions, ...MORE] }), cur);
    expect(d.startsWith(DIFF_STATE_HEADER)).toBe(true);
    expect(d).toContain(
      `Sequence s1 @v5: changed or added ${JSON.stringify([item('c1', 0, 4000), item('c4', 12000, 13000)])}; removed ["c2"]`,
    );
    expect(d).toContain(
      'Caption lines removed:\n<data source="captions">\n1200–2600 to the demo\n</data>',
    );
    expect(d).toContain(
      'Caption lines added:\n<data source="captions">\n1200–2600 to our demo\n</data>',
    );
    expect(d).not.toContain('Hello and welcome');
    expect(d.endsWith('- v4 by user: trimItem → c1')).toBe(true);
  });

  test('when every caption line moved, the whole caption list is sent instead of the diff', () => {
    const lines = Array.from(
      { length: 30 },
      (_, i) => `${String(i * 1000)}–${String(i * 1000 + 900)} line ${String(i)}`,
    );
    const moved = lines.map((l) =>
      l.replace(
        /^(\d+)–(\d+)/,
        (_, a: string, b: string) => `${String(Number(a) + 500)}–${String(Number(b) + 500)}`,
      ),
    );
    const d = renderStateDiff(snap({ captions: lines }), snap({ captions: moved }));
    expect(d).toContain('Captions (all):');
    expect(d).not.toContain('Caption lines removed');
  });

  test('a sequence new in scope comes in full; one that left is named', () => {
    const two: StateSnapshot = {
      sequences: [...snap().sequences, { ...snap().sequences[0]!, alias: 's2' }],
      note: '',
    };
    expect(renderStateDiff(snap(), two)).toContain('Sequence s2 @v3 (new in scope): [');
    expect(renderStateDiff(two, snap())).toContain('Sequence s2: no longer in scope');
  });
});

describe('StateTracker (D-81)', () => {
  test(`full at the start, diffs, a full block every ${String(STATE_FULL_EVERY)} steps`, () => {
    const t = new StateTracker();
    const kinds: string[] = [];
    for (let step = 1; step <= 2 * STATE_FULL_EVERY + 2; step++) {
      const s = snap({
        version: step,
        items: [item('c1', 0, 1000 * step), item('c2', 50_000, 60_000), item('c3', 60_000, 70_000)],
      });
      const r = t.render(s);
      t.commit(s, r.kind);
      kinds.push(r.kind);
      expect(r.text.startsWith(r.kind === 'full' ? FULL_STATE_HEADER : DIFF_STATE_HEADER)).toBe(
        true,
      );
    }
    const fulls = kinds.flatMap((k, i) => (k === 'full' ? [i + 1] : []));
    expect(fulls).toEqual([1, 1 + STATE_FULL_EVERY, 1 + 2 * STATE_FULL_EVERY]);
  });

  test('after invalidate (a compaction) the next block is full, then diffs again', () => {
    const t = new StateTracker();
    const s = snap();
    t.commit(s, t.render(s).kind);
    expect(t.render(s).kind).toBe('diff');
    t.commit(s, 'diff');
    t.invalidate();
    expect(t.render(s).kind).toBe('full');
    t.commit(s, 'full');
    expect(t.render(s).kind).toBe('diff');
  });

  test('a diff that is not shorter than the full block is sent as the full block', () => {
    const t = new StateTracker();
    const a = snap({ items: [item('c1', 0, 1000)], captions: [] });
    t.commit(a, t.render(a).kind);
    const b = snap({ items: [item('c9', 0, 1000)], captions: [] });
    expect(t.render(b).kind).toBe('full');
  });

  test('the full block is the pre-D-81 injection text', async () => {
    const f = await fixtureProject();
    const m = scriptedModel([{ text: 'ok' }]);
    const { deps } = runDeps(f, roleModel(m.model));
    const run = await AgentRun.start(deps, {
      projectId: f.projectId,
      workflow: 'freeform',
      message: 'x',
      allowedTools: [],
      mode: 'tools',
    });
    const a = await run.injection([f.sequenceId]);
    const s = await run.stateSnapshot([f.sequenceId]);
    expect(renderFullState(s.snapshot)).toBe(a.text);
    expect(a.text).toMatch(/^\[Current state, newest only\]\nSequence s1 @v\d+: \[\{"id":"c1"/);
    expect(a.text).not.toContain(DIFF_STATE_HEADER);
  });
});

async function stateRun(
  script: ScriptStep[],
  over: Parameters<typeof roleModel>[1],
  transcript?: string,
) {
  const f = await fixtureProject(transcript ? { transcript } : {});
  const m = scriptedModel(script);
  const { deps } = runDeps(f, roleModel(m.model, over), {
    limits: { maxUsdPerRun: 100, maxStepsPerRun: 60 },
  });
  const r = await runAgent(deps, {
    projectId: f.projectId,
    workflow: 'freeform',
    message: 'make the clip quieter',
    allowedTools: ['get_transcript', 'update_clip', 'move_item'],
    mode: 'tools',
    scope: [f.sequenceId],
  });
  expect(r.done.status).toBe('completed');
  const lines = readRunRecord(r.run.record.path);
  return {
    prompts: m.prompts,
    kinds: lines.filter((l) => l.type === 'state').map((l) => [l['step'], l['kind']]),
    compacted: lines.filter((l) => l.type === 'compacted').map((l) => l['step']),
  };
}

const read = (i: number) => ({
  calls: [
    {
      name: 'get_transcript',
      input: { mediaId: 'm_talk0000000001', fromSrcMs: i * 300, toSrcMs: i * 300 + 200 },
    },
  ],
});
const texts = (o: { prompt: { role: string; content: unknown }[] }) =>
  o.prompt
    .filter((p) => p.role === 'user')
    .flatMap((p) => (p.content as { type: string; text?: string }[]).map((c) => c.text ?? ''));

describe('state blocks in the loop (D-81)', () => {
  test('caching editor: full, 7 diffs, full; each block stays in the history', async () => {
    const script: ScriptStep[] = [
      {
        calls: [{ name: 'get_transcript', input: { mediaId: 'm_talk0000000001', toSrcMs: 3000 } }],
      },
      ...Array.from({ length: 8 }, (_, i) => read(i + 1)),
      {
        calls: [
          {
            name: 'move_item',
            input: { sequenceId: 's1', itemId: 'c1', startMs: 1000, unlinked: true },
          },
        ],
      },
      { text: 'done' },
    ];
    const r = await stateRun(script, ANTHROPIC);
    expect(r.compacted).toEqual([]);
    expect(r.kinds.map((k) => k[1])).toEqual([
      'full',
      ...Array<string>(STATE_FULL_EVERY - 1).fill('diff'),
      'full',
      'diff',
      'diff',
    ]);
    const last = texts(r.prompts.at(-1)! as never);
    const states = last.filter(
      (t) => t.startsWith(FULL_STATE_HEADER) || t.startsWith(DIFF_STATE_HEADER),
    );
    expect(states).toHaveLength(11);
    // the write at step 10 shows up as a change of c1 in step 11's diff
    expect(states.at(-1)).toMatch(
      /^\[State changes[^\n]*\]\nSequence s1 @v2: changed or added \[\{"id":"c1","track":"V1","startMs":1000/,
    );
    expect(states.at(-2)).toBe(`${DIFF_STATE_HEADER}\nSequence s1 @v1: no change`);
  });

  test('after a compaction the next block is full and the old blocks are stubbed', async () => {
    const big = longTranscriptFile(3000);
    const script: ScriptStep[] = [
      read(0),
      read(1),
      { calls: [{ name: 'get_transcript', input: { mediaId: 'm_talk0000000001' } }] },
      ...Array.from({ length: 8 }, (_, i) => read(i + 2)),
      { text: 'done' },
    ];
    const r = await stateRun(
      script,
      { ...ANTHROPIC, contextTokens: 8_000, maxOutputTokens: 100 },
      big,
    );
    // over budget from step 9: each step stubs one more old step until the big read (step 3)
    expect(r.compacted).toEqual([9, 10, 11]);
    const kinds = new Map(r.kinds as [number, string][]);
    expect(kinds.get(8)).toBe('diff');
    expect(kinds.get(9)).toBe('full'); // periodic and compaction
    expect(kinds.get(10)).toBe('full'); // compaction only (periodic would be a diff)
    expect(kinds.get(11)).toBe('full');
    expect(kinds.get(12)).toBe('diff');
    const after = texts(r.prompts[10]! as never);
    expect(after.filter((t) => t.includes('[elided: the state block')).length).toBeGreaterThan(0);
    expect(after.at(-1)!.startsWith(FULL_STATE_HEADER)).toBe(true);
  });

  test('no caching: every step gets the full block, newest only, and nothing is kept', async () => {
    const r = await stateRun([read(0), read(1), { text: 'done' }], {});
    expect(r.kinds).toEqual([]);
    for (const o of r.prompts) {
      const states = texts(o as never).filter(
        (t) => t.includes('[Current state') || t.includes('[State changes'),
      );
      expect(states).toHaveLength(1);
      expect(states[0]!.startsWith(FULL_STATE_HEADER)).toBe(true);
    }
  });
});
