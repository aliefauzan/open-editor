// Screenplay match on local signals (D-77): tagging takes the Apple on-device model when it is the
// vision role, else frame cards, and a paid vision model only when neither gives tags; a `local`
// embedder matches the sure scenes itself and sends only the others, each with a shortlist, to the
// LLM. Ends with the before/after count of model calls and estimated tokens on the fixture set.
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SCENES } from '../../../../scripts/make-screenplay-set.ts';
import { estimateTokens } from '../../src/providers/tool-cost.ts';
import { type Embedder } from '../../src/screenplay/match.ts';
import { tagsFromCards } from '../../src/workflows/screenplay.ts';
import { runWorkflow, type WorkflowRequest } from '../../src/workflows/run-workflow.ts';
import {
  card,
  rankerModel,
  role,
  sceneIn,
  screenplayKit,
  tagEntries,
  visionModel,
  type SpKit,
} from '../helpers/screenplay.ts';

const req = (kit: SpKit): WorkflowRequest => ({
  projectId: kit.projectId,
  workflow: 'screenplay',
  message: 'match each scene to the right clip',
  mode: 'tools',
});

const v1Order = async (kit: SpKit, sequenceId: string) => {
  const p = await kit.engine.getProject(kit.projectId);
  const s = p.sequences.find((x) => x.id === sequenceId)!;
  return s.videoTracks
    .find((t) => t.id === 'V1')!
    .items.map((it) => (it.type === 'media' ? it.mediaId : it.type));
};
const expectedOrder = (kit: SpKit) =>
  (JSON.parse(readFileSync(join(kit.dir, 'expected.json'), 'utf8')) as { file: string }[]).map(
    (e) => kit.ids.get(e.file),
  );

/** Frame cards whose Vision labels are the clip's fixture tags (`fishing_boat` style). */
const tagCards = (kit: SpKit) => (file: string, paths: readonly string[]) => {
  const entry = tagEntries(kit.dir).find((t) => t.file === file)!;
  return paths.map((p) =>
    card(
      p,
      entry.tags.map((t) => t.replace(/ /g, '_')),
      1,
    ),
  );
};

/** A ranker that scores 9 when the clip line names the scene's first two tags (cards carry no prose). */
const tagRanker = () =>
  rankerModel({
    score: (scene, desc) =>
      desc.includes(scene.tags[0]!) && desc.includes(scene.tags[1]!) ? 9 : 1,
  });

const paid = (m: ReturnType<typeof visionModel>) => role(m.model, { vision: true });
const apple = (m: ReturnType<typeof visionModel>) =>
  role(m.model, {
    vision: true,
    provider: { type: 'apple', label: 'Apple on-device model' },
    modelId: 'apple-on-device',
    price: { free: true },
  });

/** Word vectors over the fixture vocabulary; texts naming the kitchen scene are blurred. */
function fixtureEmbedder(blur: (text: string) => boolean = () => false): Embedder {
  const vocab = [
    ...new Set(
      SCENES.flatMap((s) =>
        [...s.tags, ...s.heading.toLowerCase().split(/\W+/)].flatMap((t) => t.split(' ')),
      ),
    ),
  ].filter((w) => w.length > 2);
  const embed: Embedder = (texts) =>
    Promise.resolve(
      texts.map((t) =>
        blur(t) ? vocab.map(() => 1) : vocab.map((w) => (t.toLowerCase().includes(w) ? 1 : 0)),
      ),
    );
  embed.local = true;
  return embed;
}

describe('tagging on local signals (D-77)', () => {
  test('frame cards tag the clips by default: the paid vision model is not asked', async () => {
    const kit = await screenplayKit();
    await kit.load();
    kit.cards = tagCards(kit);
    const vision = visionModel(tagEntries(kit.dir));
    kit.deps.models = { editor: role(tagRanker().model), vision: paid(vision) };
    const r = await runWorkflow(kit.deps, req(kit));
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(vision.prompts).toHaveLength(0);
    expect(kit.cardCalls).toHaveLength(6);
    expect(r.screenplay).toMatchObject({ matched: 6, placeholders: 0, tagged: 6 });
    expect(r.screenplay!.notes.join('\n')).toContain(
      '6 clip(s) tagged from Apple Vision frame cards',
    );
    expect(await v1Order(kit, r.sequenceIds[0]!)).toEqual(expectedOrder(kit));
    const p = await kit.engine.getProject(kit.projectId);
    const harbor = p.media.find((m) => m.id === kit.ids.get(`clips/${SCENES[1]!.clip}.mp4`))!;
    expect(harbor.tags).toEqual(expect.arrayContaining(['harbor', 'fishing boat']));
    expect(harbor.description).toMatch(/^Shows harbor, dock, fishing boat, rope, gulls; 1 face$/);
  }, 180_000);

  test('cards give no labels: the paid vision model tags the clips, as before', async () => {
    const kit = await screenplayKit();
    await kit.load();
    kit.cards = (_file, paths) => paths.map((p) => card(p, []));
    const vision = visionModel(tagEntries(kit.dir));
    kit.deps.models = { editor: role(rankerModel().model), vision: paid(vision) };
    const r = await runWorkflow(kit.deps, req(kit));
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(kit.cardCalls).toHaveLength(6);
    expect(vision.prompts).toHaveLength(6);
    expect(r.screenplay).toMatchObject({ matched: 6, method: 'llm' });
    expect(r.screenplay!.notes.join('\n')).not.toContain('frame cards');
  }, 180_000);

  test('the Apple model is the vision role: it describes the clips and no card is made', async () => {
    const kit = await screenplayKit();
    await kit.load();
    kit.cards = tagCards(kit);
    const vision = visionModel(tagEntries(kit.dir));
    kit.deps.models = { editor: role(rankerModel().model), vision: apple(vision) };
    const r = await runWorkflow(kit.deps, req(kit));
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(vision.prompts).toHaveLength(6);
    expect(kit.cardCalls).toHaveLength(0);
    expect(await v1Order(kit, r.sequenceIds[0]!)).toEqual(expectedOrder(kit));
  }, 180_000);

  test('the Apple model fails (a guardrail): frame cards tag the clip instead', async () => {
    const kit = await screenplayKit();
    await kit.load();
    kit.cards = tagCards(kit);
    const vision = visionModel(tagEntries(kit.dir));
    const refusing = { ...vision, model: rankerModel({ fail: new Error('guardrail') }).model };
    kit.deps.models = { editor: role(tagRanker().model), vision: apple(refusing) };
    const r = await runWorkflow(kit.deps, req(kit));
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(kit.cardCalls).toHaveLength(6);
    const notes = r.screenplay!.notes.join('\n');
    expect(notes).toContain('the vision model failed');
    expect(notes).toContain('6 clip(s) tagged from Apple Vision frame cards');
    expect(r.screenplay).toMatchObject({ matched: 6 });
  }, 180_000);

  test('cards → tags: best label confidence first, faces, a little on-screen text', () => {
    const a = card('/a', ['sky', 'outdoor_scene'], 2);
    const b = {
      ...card('/b', ['outdoor_scene', 'boat']),
      text: [
        { text: 'HARBOR <b>', box: { x: 0, y: 0, w: 1, h: 0.1 }, confidence: 0.9 },
        { text: 'noise', box: { x: 0, y: 0, w: 1, h: 0.1 }, confidence: 0.2 },
      ],
    };
    expect(tagsFromCards([a, b, { path: '/c', error: { code: 'X', message: 'm' } }])).toEqual({
      description: 'Shows outdoor scene, sky, boat; 2 faces; on-screen text: "HARBOR b"',
      tags: ['outdoor scene', 'sky', 'boat'],
    });
    expect(tagsFromCards([card('/a', [])])).toBeNull();
  });
});

describe('ranking on local embeddings (D-77)', () => {
  test('sure scenes need no ranking call; an unsure scene sends its shortlist', async () => {
    const kit = await screenplayKit();
    await kit.load();
    const vision = visionModel(tagEntries(kit.dir));
    const ranker = rankerModel();
    kit.deps.models = { editor: role(ranker.model), vision: paid(vision) };
    const kitchen = SCENES[0]!;
    kit.deps.embed = fixtureEmbedder((t) => t.includes(kitchen.heading));
    const r = await runWorkflow(kit.deps, req(kit));
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(ranker.prompts.map((o) => sceneIn(o)?.heading)).toEqual([kitchen.heading]);
    expect(r.screenplay).toMatchObject({ matched: 6, method: 'mixed' });
    expect(r.screenplay!.notes.join('\n')).toContain(
      'On-device embeddings matched 5 of 6 scene(s); 1 went to the language model with at most 8 clips each.',
    );
    expect(await v1Order(kit, r.sequenceIds[0]!)).toEqual(expectedOrder(kit));
  }, 180_000);

  test('the on-device embedding fails: the language model ranks every scene, as before', async () => {
    const kit = await screenplayKit();
    await kit.load();
    const vision = visionModel(tagEntries(kit.dir));
    const ranker = rankerModel();
    kit.deps.models = { editor: role(ranker.model), vision: paid(vision) };
    const broken: Embedder = () => Promise.reject(new Error('assets missing'));
    broken.local = true;
    kit.deps.embed = broken;
    const r = await runWorkflow(kit.deps, req(kit));
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(ranker.prompts).toHaveLength(6);
    expect(r.screenplay!.method).toBe('llm');
    expect(r.screenplay!.notes.join('\n')).toContain(
      'The on-device embedding failed (assets missing)',
    );
  }, 180_000);
});

/** Estimated input tokens of a scripted model's requests: text at 4 characters a token, 1,600 per image. */
function tokensOf(prompts: readonly LanguageModelV4CallOptions[]): number {
  let n = 0;
  for (const o of prompts)
    for (const m of o.prompt) {
      if (typeof m.content === 'string') n += estimateTokens(m.content);
      else
        for (const c of m.content)
          n += c.type === 'text' ? estimateTokens(c.text) : c.type === 'file' ? 1_600 : 0;
    }
  return n;
}

describe('model calls before and after (D-77 measurement)', () => {
  test('fixture set: vision + LLM ranking vs frame cards + local first pass', async () => {
    const before = await screenplayKit();
    await before.load();
    const bVision = visionModel(tagEntries(before.dir));
    const bRanker = rankerModel();
    before.deps.models = { editor: role(bRanker.model), vision: paid(bVision) };
    const rb = await runWorkflow(before.deps, req(before));
    expect(rb.screenplay).toMatchObject({ matched: 6 });

    const after = await screenplayKit();
    await after.load();
    after.cards = tagCards(after);
    const aVision = visionModel(tagEntries(after.dir));
    const aRanker = tagRanker();
    after.deps.models = { editor: role(aRanker.model), vision: paid(aVision) };
    after.deps.embed = fixtureEmbedder((t) => t.includes(SCENES[0]!.heading));
    const ra = await runWorkflow(after.deps, req(after));
    expect(ra.screenplay).toMatchObject({ matched: 6 });
    expect(await v1Order(after, ra.sequenceIds[0]!)).toEqual(expectedOrder(after));

    const b = { vision: bVision.prompts.length, rank: bRanker.prompts.length };
    const a = { vision: aVision.prompts.length, rank: aRanker.prompts.length };
    const bt = tokensOf(bVision.prompts) + tokensOf(bRanker.prompts);
    const at = tokensOf(aVision.prompts) + tokensOf(aRanker.prompts);
    console.info(
      `screenplay fixture: before ${String(b.vision)} vision + ${String(b.rank)} ranking calls, ~${String(bt)} input tokens (ranking ~${String(tokensOf(bRanker.prompts))}); after ${String(a.vision)} + ${String(a.rank)}, ~${String(at)} tokens (ranking ~${String(tokensOf(aRanker.prompts))})`,
    );
    expect(b).toEqual({ vision: 6, rank: 6 });
    expect(a).toEqual({ vision: 0, rank: 1 });
    expect(at).toBeLessThan(bt / 10);
  }, 360_000);
});
