// Phase 12 steps 4b and 5 (D-11, D-14): Stylize on a quick-clips sequence keeps the linked pair, the
// sourceRange and a caption edit, and "Undo this run" returns the plain captioned clip; the sound
// review fixes a spacing FAIL with one sfxOff op, lists a FAIL still open after 2 rounds, and the
// summary never says the sound is good.
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { describe, expect, test } from 'vitest';
import { VoxError } from '../../src/errors.ts';
import { buildRegistry } from '../../src/tools/registry.ts';
import { runWorkflow } from '../../src/workflows/run-workflow.ts';
import { pairOf, sceneItems } from '../../src/workflows/stylize.ts';
import type { ScriptStep } from '../helpers/model.ts';
import {
  dynamicModel,
  normalisedProject,
  quickClipsProject,
  role,
  toolTurns,
  viewIn,
  workflowKit,
} from '../helpers/workflow.ts';
import { toolsStylist } from '../helpers/stylists.ts';

describe('Stylize (step 5)', () => {
  test('keeps pair, sourceRange and caption edit; switches style and preset; undoRun restores', async () => {
    const kit = await workflowKit();
    const { sequenceIds } = await quickClipsProject(kit, 1);
    const sequenceId = sequenceIds[0]!;
    let p = await kit.engine.getProject(kit.projectId);
    const media = p.media[0]!;
    const seq0 = p.sequences.find((s) => s.id === sequenceId)!;
    const wordKey = `${media.id}:${media.transcriptRev!}:3`;
    await kit.engine.applyOp(
      kit.projectId,
      { op: 'setCaptions', args: { sequenceId, overrides: [{ wordKey, text: 'WELCOME' }] } },
      { actor: 'user' },
    );
    const before = await normalisedProject(kit);
    p = await kit.engine.getProject(kit.projectId);
    const s1 = p.sequences.find((s) => s.id === sequenceId)!;

    const m = dynamicModel(toolsStylist());
    kit.deps.models = { editor: role(m.model) };
    const r = await runWorkflow(kit.deps, {
      projectId: kit.projectId,
      workflow: 'stylize',
      message: '',
      mode: 'tools',
      sequenceIds: [sequenceId],
    });
    expect(r.done.status, r.done.summary).toBe('completed');
    p = await kit.engine.getProject(kit.projectId);
    const s2 = p.sequences.find((s) => s.id === sequenceId)!;
    expect(pairOf(s2)).toEqual(pairOf(seq0));
    expect(s2.sourceRange).toEqual(seq0.sourceRange);
    expect(s2.captions?.overrides).toEqual(s1.captions?.overrides);
    expect(s2.styleId).toBe('vox');
    expect(s2.captions?.preset).toBe('vox/mono-box');
    expect(sceneItems(s2).length).toBeGreaterThan(0);

    await kit.engine.undoRun(kit.projectId, r.done.runId);
    expect(await normalisedProject(kit)).toEqual(before);
  }, 120_000);

  test('a missing or unknown sequence fails at start with a hint', async () => {
    const kit = await workflowKit();
    kit.deps.models = { editor: role(dynamicModel(() => ({ text: 'x' })).model) };
    const r = await runWorkflow(kit.deps, {
      projectId: kit.projectId,
      workflow: 'stylize',
      message: '',
      mode: 'tools',
      sequenceIds: ['seq_nope'],
    });
    expect(r.done.status).toBe('failed');
    expect(r.done.summary).toMatch(/no sequence seq_nope/);
  });
});

/** add two scenes, then frames + audio, then `fixes` rounds of (sfxOff on a scene + check_audio). */
function soundScript(fixes: number, finalText: string) {
  return (o: LanguageModelV4CallOptions): ScriptStep => {
    const turn = toolTurns(o);
    const { seq, items } = viewIn(o);
    if (turn <= 1) return toolsStylist()(o);
    const round = turn - 1;
    if (round <= fixes) {
      const scenes = items.filter((i) => i.kind === 'scene');
      const target = scenes[(scenes.length - round) % scenes.length] ?? scenes[0]!;
      return {
        calls: [
          {
            name: 'update_scene',
            input: { sequenceId: seq, itemId: target.id, sfxOff: ['reveal'] },
          },
          { name: 'check_audio', input: { sequenceId: seq } },
        ],
      };
    }
    return { text: finalText };
  };
}

describe('sound review (step 4b, D-14)', () => {
  const GOOD = /\b(sound|sounds|audio|mix)\b[^.\n]*\b(good|great|fine|clean|perfect)\b/i;

  test('a spacing FAIL is fixed with one sfxOff op; check_audio passes on round 2', async () => {
    const kit = await workflowKit();
    const { sequenceIds } = await quickClipsProject(kit, 1);
    kit.qa.results = ['spacing-fail', 'pass'];
    const m = dynamicModel(soundScript(1, 'Muted one cue; it sounds good now.'));
    kit.deps.models = { editor: role(m.model) };
    const r = await runWorkflow(kit.deps, {
      projectId: kit.projectId,
      workflow: 'stylize',
      message: 'style it',
      mode: 'tools',
      sequenceIds,
    });
    expect(r.done.status, r.done.summary).toBe('completed');
    const fixes = r.run.calls.filter((c) => c.tool === 'update_scene' && c.by === 'model');
    expect(fixes).toHaveLength(1);
    expect(fixes[0]!.args).toMatchObject({ sfxOff: ['reveal'] });
    const pass = (by: string) =>
      r.run.calls
        .filter((c) => c.tool === 'check_audio' && c.by === by)
        .map((c) => (c.result as { pass: boolean }).pass);
    expect(pass('model')).toEqual([false, true]);
    // the clip edges changed the clip after the model's checks: the workflow checked once more
    expect(pass('workflow')).toEqual([true]);
    expect(r.done.summary).toContain('Audio QA PASS');
    expect(r.done.summary).toMatch(
      /Listen at 00:00\.600, 00:01\.500, 00:02\.600, 00:03\.400, 00:04\.800/,
    );
    expect(r.done.summary).not.toMatch(GOOD);
  }, 120_000);

  test('a FAIL still open after 2 rounds is listed in the summary, never hidden', async () => {
    const kit = await workflowKit();
    const { sequenceIds } = await quickClipsProject(kit, 1);
    kit.qa.results = ['spacing-fail'];
    const m = dynamicModel(soundScript(2, 'The audio is clean and the mix sounds great.'));
    kit.deps.models = { editor: role(m.model) };
    const r = await runWorkflow(kit.deps, {
      projectId: kit.projectId,
      workflow: 'stylize',
      message: 'style it',
      mode: 'tools',
      sequenceIds,
    });
    expect(r.done.status, r.done.summary).toBe('completed');
    const qa = (by: string) => r.run.calls.filter((c) => c.tool === 'check_audio' && c.by === by);
    expect(qa('model')).toHaveLength(3);
    // the workflow's own check after the clip edges
    expect(qa('workflow')).toHaveLength(1);
    expect(r.done.summary).toContain('Audio QA FAIL; still failing: spacing');
    expect(r.done.summary).not.toMatch(GOOD);
    expect(r.clips[0]!.audio).toMatchObject({ pass: false, failing: ['spacing'] });
  }, 120_000);
});

describe('clip edges', () => {
  test('a set_transition error is a note on the clip, not a failed workflow', async () => {
    const kit = await workflowKit();
    const { sequenceIds } = await quickClipsProject(kit, 1);
    const base = buildRegistry(kit.engine);
    kit.deps.registry = {
      ...base,
      get: (name) => {
        const t = base.get(name);
        if (name !== 'set_transition' || !t) return t;
        return {
          ...t,
          run: () => Promise.reject(new VoxError('VALIDATION', 'no room for the transition', 'x')),
        };
      },
    };
    const m = dynamicModel(toolsStylist());
    kit.deps.models = { editor: role(m.model) };
    const r = await runWorkflow(kit.deps, {
      projectId: kit.projectId,
      workflow: 'stylize',
      message: 'style it',
      mode: 'tools',
      sequenceIds,
    });
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(r.clips[0]!.edges.join('; ')).toMatch(/could not be set \(no room for the transition\)/);
  }, 120_000);
  test('tools mode: review and sound use checks made after the edges changed the clip', async () => {
    const kit = await workflowKit();
    const { sequenceIds } = await quickClipsProject(kit, 1);
    const m = dynamicModel(toolsStylist());
    kit.deps.models = { editor: role(m.model) };
    const r = await runWorkflow(kit.deps, {
      projectId: kit.projectId,
      workflow: 'stylize',
      message: 'style it',
      mode: 'tools',
      sequenceIds,
    });
    expect(r.done.status, r.done.summary).toBe('completed');
    const last = (tool: string) => r.run.calls.findLastIndex((c) => c.tool === tool);
    expect(last('set_transition')).toBeGreaterThan(-1);
    expect(last('view_frames')).toBeGreaterThan(last('set_transition'));
    expect(last('check_audio')).toBeGreaterThan(last('set_transition'));
    expect(r.checkpoints.filter((c) => c.status !== 'met')).toEqual([]);
  }, 120_000);
});
