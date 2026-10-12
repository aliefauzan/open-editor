// D-80: images in the history. A tool result's images stay while the step is recent; once it is
// older than KEEP_RECENT_STEPS they are replaced, once, by the stills' frame cards, and the message
// keeps those bytes on every later request (the D-76 cached prefix changes once, not per step).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import type { FrameCard } from '@vox/engine';
import type { ToolResultPart } from 'ai';
import { describe, expect, test, vi } from 'vitest';
import { Conversation, KEEP_RECENT_STEPS } from '../../src/loop/conversation.ts';
import { runAgent } from '../../src/loop/run.ts';
import { estimateTokens } from '../../src/providers/tool-cost.ts';
import { imageTokens } from '../../src/tools/png.ts';
import type { AgentEngine } from '../../src/tools/types.ts';
import { roleModel, runDeps, scriptedModel } from '../helpers/model.ts';
import { noise, rgbPng } from '../helpers/png.ts';
import { fixtureProject } from '../helpers/project.ts';

const still = rgbPng(1920, 1080, (x, y) => [Math.floor(noise(x % 61, y % 53) * 255), 90, 40]);

function imagePart(callId: string, data: Uint8Array): ToolResultPart {
  return {
    type: 'tool-result',
    toolCallId: callId,
    toolName: 'view_frames',
    output: {
      type: 'content',
      value: [
        { type: 'text', text: '{"frames":[]}' },
        { type: 'file', data: { type: 'data', data }, mediaType: 'image/png' },
      ],
    },
  };
}

describe('Conversation: aged images (D-80)', () => {
  test('replaced once by the describer text; the same bytes on every later call', async () => {
    const conv = new Conversation();
    conv.user(0, 'look at the frames');
    conv.toolResults(
      1,
      [imagePart('a', still)],
      new Map([
        [
          'a',
          { label: 'view_frames s1', version: 1, stills: [{ label: 'seqMs 0', path: '/f/0.png' }] },
        ],
      ]),
    );
    const describe = vi.fn((s: readonly { label: string }[]) =>
      Promise.resolve(`cards for ${s.map((x) => x.label).join(', ')}`),
    );
    // still recent: nothing happens
    expect(await conv.ageImagesThrough(0, describe)).toBe(0);
    expect(JSON.stringify(conv.messages(1))).toContain('image/png');
    // billed size, not the PNG bytes: 1080p is 1,600 tokens
    const withImage = conv.tokens(1);
    expect(withImage).toBeGreaterThanOrEqual(imageTokens(still));
    expect(withImage).toBeLessThan(imageTokens(still) + 200);

    expect(await conv.ageImagesThrough(1, describe)).toBe(1);
    const first = JSON.stringify(conv.messages(1));
    expect(first).not.toContain('image/png');
    expect(first).toContain('cards for seqMs 0');
    expect(first).toContain('{\\"frames\\":[]}'); // the result text stays
    expect(conv.tokens(1)).toBeLessThan(estimateTokens(first) + 1);

    expect(await conv.ageImagesThrough(5, describe)).toBe(0);
    expect(JSON.stringify(conv.messages(1))).toBe(first);
    expect(describe).toHaveBeenCalledTimes(1);
  });

  test('a result already stubbed is not described', async () => {
    const conv = new Conversation();
    conv.toolResults(
      1,
      [imagePart('a', still)],
      new Map([['a', { label: 'x', version: 1, stills: [{ label: 's' }] }]]),
    );
    conv.stubThrough(1);
    const describe = vi.fn(() => Promise.resolve('never'));
    expect(await conv.ageImagesThrough(1, describe)).toBe(0);
    expect(describe).not.toHaveBeenCalled();
  });
});

describe('the loop: view_frames pixels in the history (D-80)', () => {
  const card = (path: string): FrameCard => ({
    path,
    width: 1920,
    height: 1080,
    labels: [{ label: 'outdoor', confidence: 0.8 }],
    text: [],
    faces: { count: 0, boxes: [] },
    saliency: null,
    cached: true,
    ms: 50,
  });

  test('images stay for the recent steps, then become frame cards once, with stable bytes', async () => {
    const f = await fixtureProject();
    const dir = mkdtempSync(join(tmpdir(), 'vox-agent-img-'));
    const paths = [0, 1].map((i) => {
      const p = join(dir, `f${String(i)}.png`);
      writeFileSync(p, still);
      return p;
    });
    const engine = Object.create(f.engine) as AgentEngine;
    engine.frames = vi.fn(() => Promise.resolve(paths));
    const frameCards = vi.fn((_p: string, ps: readonly string[]) => Promise.resolve(ps.map(card)));
    engine.frameCards = frameCards;
    const reads = [
      { name: 'get_project_summary', input: {} },
      { name: 'get_sequence', input: { sequenceId: 's1' } },
    ];
    const steps = 12;
    const m = scriptedModel([
      {
        calls: [
          { name: 'view_frames', input: { sequenceId: 's1', atSeqMs: [0, 500], detail: 'pixels' } },
        ],
      },
      ...Array.from({ length: steps - 2 }, (_, i) => ({ calls: [reads[i % 2]!] })),
      { text: 'done' },
    ]);
    const editor = roleModel(m.model, {
      vision: true,
      provider: { type: 'anthropic', label: 'Anthropic' },
      modelId: 'claude-sonnet-4-5',
    });
    const { deps } = runDeps(f, editor, { engine });
    const { done } = await runAgent(deps, {
      projectId: f.projectId,
      workflow: 'freeform',
      message: 'check the frames',
      allowedTools: ['view_frames', 'get_project_summary', 'get_sequence'],
      mode: 'tools',
      scope: [f.sequenceId],
    });
    expect(done.status).toBe('completed');
    expect(m.prompts).toHaveLength(steps);
    // the view_frames result (the first tool message) in request n
    const frameMsg = (o: LanguageModelV4CallOptions) =>
      JSON.stringify(o.prompt.find((p) => p.role === 'tool'));
    const ageAt = 1 + KEEP_RECENT_STEPS; // the step whose request first sends the cards
    for (let n = 2; n < ageAt; n++) {
      expect(frameMsg(m.prompts[n - 1]!), `request ${String(n)}`).toContain('image/png');
    }
    const aged = frameMsg(m.prompts[ageAt - 1]!);
    expect(aged).not.toContain('image/png');
    expect(aged).toContain('[images replaced by their frame cards]');
    expect(aged).toContain('labels: outdoor 0.80');
    expect(aged).toContain('seqMs 500');
    for (let n = ageAt + 1; n <= steps; n++) expect(frameMsg(m.prompts[n - 1]!)).toBe(aged);
    // one card request for the aged images; detail "pixels" itself made none
    expect(frameCards).toHaveBeenCalledTimes(1);
    expect(frameCards).toHaveBeenCalledWith(f.projectId, paths, {});
  });
});
