// Phase 12 steps 1–3 (agent spec "Testing" → mock-model tests): the clipper on the offline fixture
// (20 s talking head, clips of 4–8 s) in tools mode and in plan mode, and checkpoint enforcement.
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import type { Project, Sequence } from '@vox/engine';
import { describe, expect, test } from 'vitest';
import { readRunRecord } from '../../src/loop/record.ts';
import { runWorkflow } from '../../src/workflows/run-workflow.ts';
import { sceneItems, speakerShare } from '../../src/workflows/stylize.ts';
import type { ScriptStep } from '../helpers/model.ts';
import {
  dynamicModel,
  FIXTURE_VIDEO,
  role,
  toolTurns,
  viewIn,
  workflowKit,
  type Kit,
} from '../helpers/workflow.ts';

export const CLIP = { count: 3, minMs: 4000, maxMs: 8000 } as const;

/** Tools mode: two kinetic-serif beats (one muted), then frames and audio, then a summary. */
export function toolsStylist(extra: { finalText?: string } = {}) {
  return (o: LanguageModelV4CallOptions): ScriptStep => {
    const turn = toolTurns(o);
    const { seq, items } = viewIn(o);
    const end = Math.max(...items.map((i) => i.endMs));
    const a = Math.round(end * 0.15);
    const m = Math.round(end * 0.5);
    const b = Math.round(end * 0.9);
    if (turn === 0) {
      const scene = (startMs: number, durationMs: number, text: string, mute = false) => ({
        name: 'add_scene',
        input: {
          sequenceId: seq,
          trackId: 'V2',
          startMs,
          durationMs,
          template: 'vox/kinetic-serif',
          variables: { text },
          ...(mute && { sfxOff: ['reveal'] }),
        },
      });
      return {
        calls:
          m - a >= 1300
            ? [scene(a, m - a, 'A long video'), scene(m, b - m, 'A short clip', true)]
            : [scene(a, b - a, 'A long video')],
      };
    }
    if (turn === 1) {
      const mids = items
        .filter((i) => i.kind === 'scene')
        .map((i) => Math.round((i.startMs + i.endMs) / 2));
      return {
        calls: [
          { name: 'view_frames', input: { sequenceId: seq, atSeqMs: mids } },
          { name: 'check_audio', input: { sequenceId: seq } },
        ],
      };
    }
    return { text: extra.finalText ?? 'Placed the scenes.' };
  };
}

/** Plan mode: one ClipPlan per sub-run (speaker, kinetic-serif, a stat with an image query). */
export function planStylist() {
  return (o: LanguageModelV4CallOptions): ScriptStep => {
    const { seq, items } = viewIn(o);
    const end = Math.max(...items.map((i) => i.endMs));
    const a = Math.round(end * 0.15);
    const m = Math.round(end * 0.5);
    const b = Math.round(end * 0.9);
    return {
      json: {
        sequences: [
          {
            sequenceId: seq,
            beats: [
              { startMs: 0, endMs: a, kind: 'speaker' },
              {
                startMs: a,
                endMs: m,
                kind: 'scene',
                template: 'vox/kinetic-serif',
                variables: { text: 'A long video' },
              },
              {
                startMs: m,
                endMs: b,
                kind: 'scene',
                template: 'vox/stat',
                variables: { value: '3 clips' },
                imageQueries: ['old film reel'],
              },
              { startMs: b, endMs: end, kind: 'speaker' },
            ],
          },
        ],
      },
    };
  };
}

export function assertClips(p: Project, ids: readonly string[]) {
  expect(ids).toHaveLength(3);
  for (const id of ids) {
    const s = p.sequences.find((x) => x.id === id) as Sequence;
    const r = s.sourceRange!;
    expect(r.outMs - r.inMs).toBeGreaterThanOrEqual(CLIP.minMs);
    expect(r.outMs - r.inMs).toBeLessThanOrEqual(CLIP.maxMs);
    expect(s.styleId).toBe('vox');
    expect(s.captions?.enabled).toBe(true);
    expect(s.captions?.preset).toBe('vox/mono-box');
    // no overlaps on any track
    for (const t of [...s.videoTracks, ...s.audioTracks]) {
      const its = [...t.items].sort((x, y) => x.startMs - y.startMs);
      for (let i = 1; i < its.length; i++)
        expect(its[i]!.startMs).toBeGreaterThanOrEqual(its[i - 1]!.startMs + its[i - 1]!.durationMs);
    }
    // scenes from the style, within template bounds; speaker share within the style's range
    const scenes = sceneItems(s);
    expect(scenes.length).toBeGreaterThan(0);
    for (const { item } of scenes) {
      if (item.type !== 'scene') continue;
      expect(['vox/kinetic-serif', 'vox/stat', 'base/placeholder']).toContain(item.template);
    }
    const share = speakerShare(s);
    expect(share).toBeGreaterThanOrEqual(0.15);
    expect(share).toBeLessThanOrEqual(0.35);
    // V1/A1 linked with equal offsets
    const v1 = s.videoTracks.find((t) => t.id === 'V1')!.items;
    const a1 = s.audioTracks.find((t) => t.id === 'A1')!.items;
    expect(v1.length).toBeGreaterThan(0);
    for (const v of v1) {
      if (v.type !== 'media') continue;
      const a = a1.find((x) => x.linkId !== undefined && x.linkId === v.linkId);
      expect(a, `A1 partner of ${v.id}`).toBeDefined();
      if (a?.type !== 'media') continue;
      expect([a.startMs, a.inMs, a.durationMs]).toEqual([v.startMs, v.inMs, v.durationMs]);
    }
    // clip edges: cover-style transitions on the first and the last scene
    for (const sc of [scenes[0]!, scenes.at(-1)!])
      expect(sc.item.transitionIn?.template).toBe('vox/paper-tear');
  }
}

async function clipper(kit: Kit, mode: 'tools' | 'plan', next: ReturnType<typeof toolsStylist>) {
  const m = dynamicModel(next);
  kit.deps.models = { editor: role(m.model) };
  const r = await runWorkflow(kit.deps, {
    projectId: kit.projectId,
    workflow: 'clipper',
    message: `make 3 vox clips from ${FIXTURE_VIDEO}`,
    mode,
    ...CLIP,
    tighten: 'all',
  });
  return { ...r, prompts: m.prompts };
}

describe('clipper (steps 1–2)', () => {
  test('tools mode: 3 clips meeting every checkpoint, one sub-run per clip', async () => {
    const kit = await workflowKit();
    const r = await clipper(kit, 'tools', toolsStylist());
    expect(r.done.status, r.done.summary).toBe('completed');
    const p = await kit.engine.getProject(kit.projectId);
    assertClips(p, r.sequenceIds);
    expect(r.checkpoints.filter((c) => c.status !== 'met')).toEqual([]);
    expect(r.checkpoints).toHaveLength(18);
    // one sub-run per sequence, same runId; every write of the run carries it
    const lines = readRunRecord(r.run.record.path);
    expect(lines.filter((l) => l.type === 'subRun').map((l) => l['subRun'])).toEqual([1, 2, 3]);
    const h = await kit.engine.history(kit.projectId);
    expect(h.length).toBeGreaterThan(1);
    expect(h.every((e) => e.runId === 'run_wftest0001')).toBe(true);
    // the summary has the audio numbers and listen timecodes per clip
    expect(r.done.summary).toMatch(/Clip s1: completed/);
    expect(r.done.summary).toContain('Listen at 00:00.600');
    expect(r.done.summary).toContain('-14.2 LUFS');
  }, 120_000);

  test('plan mode: the same checks from scripted ClipPlans; empty search gives a placeholder', async () => {
    const kit = await workflowKit();
    const r = await clipper(kit, 'plan', planStylist());
    expect(r.done.status, r.done.summary).toBe('completed');
    const p = await kit.engine.getProject(kit.projectId);
    assertClips(p, r.sequenceIds);
    expect(r.checkpoints.filter((c) => c.status !== 'met')).toEqual([]);
    const placeholders = r.sequenceIds.flatMap((id) =>
      sceneItems(p.sequences.find((s) => s.id === id)!).filter(
        (x) => x.item.type === 'scene' && x.item.template === 'base/placeholder',
      ),
    );
    expect(placeholders).toHaveLength(3);
    expect(r.done.summary).toContain('placeholder');
    // the workflow ran review and sound itself in plan mode
    expect(kit.jobs.filter((j) => j.kind === 'audioQa')).toHaveLength(3);
  }, 120_000);
});

describe('checkpoint enforcement (step 3)', () => {
  test('a run whose quick clips skip sourceRange fails with a clear message', async () => {
    const kit = await workflowKit();
    const runJob = kit.deps.runJob!;
    kit.deps.runJob = async (kind, args) => {
      const out = (await runJob(kind, args)) as { sequenceIds?: string[] };
      if (kind === 'quickClips') {
        await kit.engine.applyOp(
          kit.projectId,
          { op: 'updateSequence', args: { sequenceId: out.sequenceIds![1]!, sourceRange: null } },
          { actor: 'agent', runId: 'run_wftest0001' },
        );
      }
      return out;
    };
    const r = await clipper(kit, 'tools', toolsStylist());
    expect(r.done.status).toBe('failed');
    expect(r.done.error?.code).toBe('CHECKPOINT_MISSED');
    expect(r.done.summary).toMatch(/missed required checkpoint: ranges \(s\d: no sourceRange saved\)/);
    // nothing was styled
    expect(r.prompts).toHaveLength(0);
  }, 120_000);
});
