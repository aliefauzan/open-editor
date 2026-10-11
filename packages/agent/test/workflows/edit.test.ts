// Phase 12 steps 4 and 8c (D-15, S35): free-form edits with the UI selection, the intent gate
// (question turns get read tools only and make no history entry), the change note for a user edit
// between two steps, and a colliding agent write that is re-read and retried.
import { createRedactor } from '@vox/engine';
import { describe, expect, test } from 'vitest';
import { buildRegistry } from '../../src/tools/registry.ts';
import { runWorkflow, type WorkflowRequest } from '../../src/workflows/run-workflow.ts';
import { fixtureProject, type Fixture } from '../helpers/project.ts';
import type { ScriptStep } from '../helpers/model.ts';
import { dynamicModel, role } from '../helpers/workflow.ts';

const registry = buildRegistry({ imageProviders: { list: () => [], register: () => undefined } });

async function trimmed(): Promise<Fixture> {
  const f = await fixtureProject();
  await f.engine.applyOp(
    f.projectId,
    { op: 'trimItem', args: { sequenceId: f.sequenceId, itemId: f.v1, edge: 'end', toMs: 15000 } },
    { actor: 'user' },
  );
  return f;
}

async function edit(
  f: Fixture,
  editor: ReturnType<typeof dynamicModel>,
  over: Partial<WorkflowRequest> = {},
  fast?: ReturnType<typeof dynamicModel>,
) {
  return runWorkflow(
    {
      engine: f.engine,
      redactor: createRedactor(),
      models: { editor: role(editor.model), ...(fast && { fast: role(fast.model) }) },
      limits: { maxUsdPerRun: 2, maxStepsPerRun: 60 },
      sleep: () => Promise.resolve(),
    },
    {
      projectId: f.projectId,
      workflow: 'edit',
      message: 'make this longer',
      mode: 'tools',
      selection: { sequenceId: f.sequenceId, itemIds: [f.v1], playheadMs: 4000 },
      ...over,
    },
  );
}

const script = (steps: ScriptStep[]) => dynamicModel((_o, n) => steps[n] ?? { text: 'Done.' });

describe('free-form edit (step 4)', () => {
  test('"make this longer" on the selected item trims that item', async () => {
    const f = await trimmed();
    const editor = script([
      {
        calls: [
          {
            name: 'trim_item',
            input: { sequenceId: 's1', itemId: 'c1', edge: 'end', toMs: 17000 },
          },
        ],
      },
      { text: 'Made the clip 2 s longer.' },
    ]);
    const r = await edit(f, editor);
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(r.intent).toBe('edit');
    expect(JSON.stringify(editor.prompts[0]!.prompt)).toContain(
      'Selection: sequence s1, selected item(s) c1, playhead 4000 ms.',
    );
    const last = (await f.engine.history(f.projectId)).at(-1)!;
    expect(last).toMatchObject({ actor: 'agent', runId: r.done.runId, op: 'trimItem' });
    expect(last.changes.map((c) => c.key)).toContain(`item:${f.sequenceId}/${f.v1}`);
  });
});

describe('free-form D-15 (step 8c, S35)', () => {
  test('a question turn gets read tools only, refuses a write through call_tool, writes nothing', async () => {
    const f = await trimmed();
    const fast = dynamicModel(() => ({ json: { intent: 'question' } }));
    const editor = script([
      {
        calls: [
          {
            name: 'call_tool',
            input: {
              name: 'trim_item',
              args: { sequenceId: 's1', itemId: 'c1', edge: 'end', toMs: 17000 },
            },
          },
        ],
      },
      { text: 'It is short because the clip was trimmed to 15 s.' },
    ]);
    const versions = (await f.engine.history(f.projectId)).length;
    const r = await edit(f, editor, { message: 'why is this clip so short?' }, fast);
    expect(r.intent).toBe('question');
    expect(r.done.status).toBe('completed');
    const sent = (editor.prompts[0]!.tools ?? []).map((t) => (t as { name: string }).name);
    expect(sent.length).toBeGreaterThan(0);
    for (const n of sent) {
      const kind = registry.get(n)!.kind;
      expect(kind === 'read' || n === 'call_tool' || n === 'describe_tool', n).toBe(true);
    }
    expect(sent).not.toContain('update_todos');
    expect(sent).not.toContain('undo_my_last_edit');
    expect(r.run.calls[0]).toMatchObject({ tool: 'trim_item', ok: false });
    expect(JSON.stringify(r.run.calls[0]!.result)).toContain('TOOL_REFUSED');
    expect((await f.engine.history(f.projectId)).length).toBe(versions);
  });

  test('plan mode: a question gets one answer and no write', async () => {
    const f = await trimmed();
    const fast = dynamicModel(() => ({ json: { intent: 'question' } }));
    const editor = script([{ json: { answer: 'The clip is 15 s: it was trimmed at the end.' } }]);
    const versions = (await f.engine.history(f.projectId)).length;
    const r = await edit(f, editor, { message: 'why is this clip so short?', mode: 'plan' }, fast);
    expect(r.done.status).toBe('completed');
    expect(r.done.summary).toContain('trimmed at the end');
    expect((await f.engine.history(f.projectId)).length).toBe(versions);
  });

  test('with no fast model every turn is an edit', async () => {
    const f = await trimmed();
    const r = await edit(f, script([{ text: 'Nothing to change.' }]), {
      message: 'why is this clip so short?',
    });
    expect(r.intent).toBe('edit');
    expect(r.done.summary).toContain('No fast model');
  });

  test('a user edit between two steps shows in the next change note', async () => {
    const f = await trimmed();
    const editor = dynamicModel(async (_o, n) => {
      if (n === 0) {
        await f.engine.applyOp(
          f.projectId,
          { op: 'updateClip', args: { sequenceId: f.sequenceId, itemId: f.a1, volume: 0.5 } },
          { actor: 'user' },
        );
        return { calls: [{ name: 'get_sequence', input: { sequenceId: 's1' } }] };
      }
      return { text: 'Read it.' };
    });
    await edit(f, editor);
    const second = JSON.stringify(editor.prompts[1]!.prompt);
    expect(second).toContain('Changes since your last step');
    expect(second).toMatch(/by user: updateClip → c\d/);
    expect(JSON.stringify(editor.prompts[0]!.prompt)).not.toContain('Changes since your last step');
  });

  test('a colliding agent write is re-read and retried once', async () => {
    const f = await trimmed();
    const editor = dynamicModel(async (_o, n) => {
      if (n === 0) {
        await f.engine.applyOp(
          f.projectId,
          {
            op: 'trimItem',
            args: { sequenceId: f.sequenceId, itemId: f.v1, edge: 'end', toMs: 14000 },
          },
          { actor: 'user' },
        );
        return {
          calls: [
            {
              name: 'trim_item',
              input: { sequenceId: 's1', itemId: 'c1', edge: 'end', toMs: 17000 },
            },
          ],
        };
      }
      return { text: 'Done.' };
    });
    const r = await edit(f, editor);
    const call = r.run.calls.find((c) => c.tool === 'trim_item')!;
    expect(JSON.stringify(call.result)).toMatch(/re-read at version \d+ and retried once/);
  });
});
