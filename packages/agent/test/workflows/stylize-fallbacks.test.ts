// Plan-mode picture fallbacks (D-88 live runs, ollama qwen3.5): a weak editor's ClipPlan should not
// end as a row of placeholders when a deterministic repair exists.
// (a) paper-collage items that name the source video with no image query get a still of that video
//     at the beat's time (cut out like any collage picture), with a repair note;
// (b) an optional top-level picture that is not found is left empty (the scene renders without it),
//     as D-88 does for panel pictures; a required one still makes a placeholder;
// (c) text over a template's length limit is shortened at a word boundary, keeping the emphasis words.
// The run summary says what was repaired.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { describe, expect, test } from 'vitest';
import { shortenText } from '../../src/loop/plan.ts';
import { readRunRecord } from '../../src/loop/record.ts';
import { runWorkflow } from '../../src/workflows/run-workflow.ts';
import { sceneItems } from '../../src/workflows/stylize.ts';
import type { ScriptStep } from '../helpers/model.ts';
import { rgbPng } from '../helpers/png.ts';
import { dynamicModel, quickClipsProject, role, viewIn, workflowKit } from '../helpers/workflow.ts';
import type { Kit } from '../helpers/workflow.ts';

/** A ClipPlan with one scene beat over the middle of the clip. */
function sceneStylist(template: string, variables: unknown, imageQueries?: string[]) {
  return (o: LanguageModelV4CallOptions): ScriptStep => {
    const { seq, items } = viewIn(o);
    const end = Math.max(...items.map((i) => i.endMs));
    const a = Math.round(end * 0.3);
    const b = Math.min(a + 3000, Math.round(end * 0.8));
    return {
      json: {
        sequences: [
          {
            sequenceId: seq,
            beats: [
              { startMs: 0, endMs: a, kind: 'speaker' },
              {
                startMs: a,
                endMs: b,
                kind: 'scene',
                template,
                variables,
                ...(imageQueries && { imageQueries }),
              },
              { startMs: b, endMs: end, kind: 'speaker' },
            ],
          },
        ],
      },
    };
  };
}

async function stylizePlan(kit: Kit, next: ReturnType<typeof sceneStylist>) {
  const { mediaId, sequenceIds } = await quickClipsProject(kit, 1);
  const m = dynamicModel(next);
  kit.deps.models = { editor: role(m.model) };
  const r = await runWorkflow(kit.deps, {
    projectId: kit.projectId,
    workflow: 'stylize',
    message: '',
    mode: 'plan',
    sequenceIds,
  });
  const p = await kit.engine.getProject(kit.projectId);
  const s = p.sequences.find((x) => x.id === sequenceIds[0])!;
  const scenes = sceneItems(s).map(
    ({ item }) => item as { template?: string; variables?: Record<string, unknown> },
  );
  const lines = readRunRecord(r.run.record.path);
  const repairs = JSON.stringify(
    lines.find((l) => l.tool === 'batch' && l['by'] === 'plan')?.['repairs'] ?? [],
  );
  return { r, p, scenes, mediaId, repairs, lines };
}

/** The cutout job stands in with a fixed PNG ingested as the run (no Python, no network). */
function offlineCutout(kit: Kit) {
  const png = join(mkdtempSync(join(tmpdir(), 'vox-agent-cut-')), 'cut.png');
  writeFileSync(
    png,
    rgbPng(48, 64, (x, y) => [x * 4, 120, y * 3]),
  );
  const cut: string[] = [];
  const runJob = kit.deps.runJob!;
  kit.deps.runJob = async (kind, args, signal) => {
    if (kind !== 'assets.cutout') return runJob(kind, args, signal);
    cut.push(args['mediaId'] as string);
    const out = (await runJob(
      'ingest',
      { projectId: args['projectId'], inputs: [png], actor: args['actor'], runId: args['runId'] },
      signal,
    )) as { media: { mediaId: string }[] };
    return { mediaId: out.media[0]!.mediaId, reused: false };
  };
  return cut;
}

describe('plan-mode picture fallbacks (D-88 live runs)', () => {
  test('(a) collage items naming the source video with no query get a still of it, cut out', async () => {
    const kit = await workflowKit();
    const cut = offlineCutout(kit);
    const items = [
      { media: 'm1', x: 30, y: 40 },
      { media: 'm1', x: 70, y: 60, scale: 0.8 },
    ];
    const { r, p, scenes, mediaId, repairs, lines } = await stylizePlan(
      kit,
      sceneStylist('vox/paper-collage', { items, label: 'Kerja', bg: 'paper' }),
    );
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(scenes.map((s) => s.template)).toEqual(['vox/paper-collage']);
    // no archive search: there was no query, and the still is local
    expect(lines.filter((l) => l.tool === 'search_images')).toEqual([]);
    const placed = (scenes[0]!.variables!['items'] as { media: string; x: number }[]).map(
      (i) => i.media,
    );
    expect(placed).toHaveLength(2);
    for (const id of placed) expect(p.media.find((x) => x.id === id)?.kind).toBe('image');
    // two stills of the source video (one per item, at different times in the beat), each cut out
    const src = p.media.find((x) => x.id === mediaId)!;
    const stills = p.media.filter((x) => x.tags.includes('still'));
    expect(stills).toHaveLength(2);
    for (const s of stills) {
      expect(s.kind).toBe('image');
      expect(s.origin).toEqual(src.origin);
      expect(s.description).toMatch(new RegExp(`^Still of ${mediaId} at \\d+ ms$`));
    }
    expect(cut.sort()).toEqual(stills.map((s) => s.id).sort());
    expect(repairs).toMatch(/items 0: still of m1 at \d+ ms \(no picture query\)/);
    expect(repairs).toMatch(/items 1: still of m1 at \d+ ms \(no picture query\)/);
    expect(r.checkpoints.find((c) => c.checkpoint === 'fill')).toMatchObject({
      status: 'met',
      note: 'all slots filled',
    });
    expect(r.done.summary).toMatch(/Repaired: items 0: still of m1 at \d+ ms/);
  }, 120_000);

  test('(a) a required panel picture left empty with no query gets a still of the source video', async () => {
    // the live run of this fix (qwen3.5): `media: ""` everywhere and no imageQueries at all
    const kit = await workflowKit();
    offlineCutout(kit);
    const panels = [
      { template: 'vox/framed-portrait', variables: { media: '', frame: 'none', bg: 'dark' } },
      { template: 'vox/stat', variables: { value: '20 Ribu', line2: 'yang kita keluarkan' } },
    ];
    const { r, p, scenes, mediaId, repairs } = await stylizePlan(
      kit,
      sceneStylist('vox/stack', { panels }),
    );
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(scenes.map((s) => s.template)).toEqual(['vox/stack']);
    const vars = scenes[0]!.variables as { panels: { variables: Record<string, unknown> }[] };
    const still = p.media.find((m) => m.id === vars.panels[0]!.variables['media']);
    // framed-portrait's picture is an image slot: the still itself, no cutout
    expect(still?.tags).toContain('still');
    expect(still?.origin).toEqual(p.media.find((m) => m.id === mediaId)!.origin);
    // the optional stat background was never asked for: it stays absent, with no note
    expect(vars.panels[1]!.variables).toEqual(panels[1]!.variables);
    expect(repairs).toMatch(/panel 0: media: still of m1 at \d+ ms \(no picture query\)/);
    expect(repairs).not.toContain('bgPhoto');
  }, 120_000);

  test('(a) collage items left empty with no query get stills of the source video', async () => {
    const kit = await workflowKit();
    const cut = offlineCutout(kit);
    const items = [
      { media: '', x: 10, y: 10, scale: 0.8 },
      { media: '', x: 90, y: 20, scale: 0.7 },
    ];
    const { r, p, scenes, repairs } = await stylizePlan(
      kit,
      sceneStylist('vox/paper-collage', { label: 'Rezeki Tak Terduga', items, bg: 'paper' }),
    );
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(scenes.map((s) => s.template)).toEqual(['vox/paper-collage']);
    expect(p.media.filter((m) => m.tags.includes('still'))).toHaveLength(2);
    expect(cut).toHaveLength(2);
    expect(repairs).toMatch(/items 1: still of m1 at \d+ ms \(no picture query\)/);
  }, 120_000);

  test('(a) a picture asked for by a query that finds nothing is not replaced by a still', async () => {
    const kit = await workflowKit();
    const { r, scenes, p } = await stylizePlan(
      kit,
      sceneStylist('vox/paper-collage', { items: [{ media: '', x: 50, y: 50 }] }, ['a judge']),
    );
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(scenes.map((s) => [s.template, s.variables])).toEqual([
      ['base/placeholder', { label: 'Picture: a judge' }],
    ]);
    expect(p.media.filter((m) => m.tags.includes('still'))).toEqual([]);
  }, 120_000);

  test('(b) an optional top-level picture that is not found is left empty, not a placeholder', async () => {
    const kit = await workflowKit();
    const { r, scenes, repairs } = await stylizePlan(
      kit,
      sceneStylist('vox/stat', { value: '40 %', line2: 'of jobs change' }, ['empty office desk']),
    );
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(scenes.map((s) => [s.template, s.variables])).toEqual([
      ['vox/stat', { value: '40 %', line2: 'of jobs change' }],
    ]);
    expect(repairs).toContain('no picture for empty office desk, bgPhoto left empty');
    expect(r.done.summary).toContain(
      'Repaired: no picture for empty office desk, bgPhoto left empty',
    );
  }, 120_000);

  test('(c) kinetic-serif text over 60 characters is shortened at a word boundary, emphasis kept', async () => {
    const kit = await workflowKit();
    // 89 characters; the emphasis words sit past the limit
    const text =
      'Nobody imagined that this ordinary office job would one day grow into a thriving business';
    const { r, scenes, repairs } = await stylizePlan(
      kit,
      sceneStylist('vox/kinetic-serif', { text, emphasis: ['thriving business'], bg: 'paper' }),
    );
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(scenes.map((s) => s.template)).toEqual(['vox/kinetic-serif']);
    const v = scenes[0]!.variables as { text: string; emphasis: string[]; bg: string };
    expect(v.text.length).toBeLessThanOrEqual(60);
    expect(v.text).toBe('…office job would one day grow into a thriving business');
    expect(v.emphasis).toEqual(['thriving business']);
    expect(v.bg).toBe('paper');
    expect(repairs).toContain(
      `text shortened to the 60-character limit (was ${String(text.length)} characters)`,
    );
    expect(r.done.summary).toContain('Repaired: text shortened to the 60-character limit');
  }, 120_000);
});

describe('shortenText (D-89)', () => {
  test('no key words: the head, cut after a whole word, with an ellipsis', () => {
    expect(shortenText('one two three four five', 14)).toBe('one two three…');
    expect(shortenText('one, two, three four', 10)).toBe('one, two…');
  });
  test('text within the limit is kept (whitespace tidied)', () => {
    expect(shortenText('  short   text ', 20)).toBe('short text');
  });
  test('key words that cannot fit together: the window with the most of them', () => {
    expect(
      shortenText('alpha beta gamma delta epsilon zeta', 19, ['alpha', 'zeta', 'epsilon']),
    ).toBe('…delta epsilon zeta');
  });
  test('a single word over the limit is cut inside the word', () => {
    expect(shortenText('Supercalifragilistic', 8)).toBe('Superca…');
  });
});
