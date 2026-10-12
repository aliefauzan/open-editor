// Scripted stylists for the workflow tests: tools-mode tool calls and plan-mode ClipPlans computed
// from the injected view, and the shared assertions on the resulting clips (phase 12 steps 1–2).
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import type { Project, Sequence } from '@vox/engine';
import { expect } from 'vitest';
import { sceneItems, speakerShare } from '../../src/workflows/stylize.ts';
import type { ScriptStep } from './model.ts';
import { toolTurns, viewIn } from './workflow.ts';

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

/**
 * Plan mode: one ClipPlan per sub-run (speaker, kinetic-serif, a framed portrait with an image query).
 * The portrait's picture is required, so an empty search makes it a placeholder (an optional picture
 * such as a stat's `bgPhoto` is left empty instead, D-89).
 */
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
                template: 'vox/framed-portrait',
                variables: { stamp: '3 clips' },
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
        expect(its[i]!.startMs).toBeGreaterThanOrEqual(
          its[i - 1]!.startMs + its[i - 1]!.durationMs,
        );
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
