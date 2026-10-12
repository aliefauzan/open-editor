// Plan-mode speech sync (D-92, owner report 2026-10-12 "the voice and the vox not matching"): a
// scene beat of a ClipPlan starts a short lead before the words on it are spoken.
import { mapTemplateLookup, type TemplateInfo } from '@vox/engine';
import { describe, expect, test } from 'vitest';
import {
  SPEECH_LEAD_MS,
  matchSpeech,
  sceneTexts,
  speechTokens,
  syncScenesToSpeech,
  type SpokenWord,
} from '../../src/loop/speech-sync.ts';
import { runAgent } from '../../src/loop/run.ts';
import { readRunRecord } from '../../src/loop/record.ts';
import { roleModel, runDeps, scriptedModel } from '../helpers/model.ts';
import { TEMPLATES, fixtureProject } from '../helpers/project.ts';

/** Words 300 ms apart from `atMs` (the transcript's own spelling and punctuation). */
function said(text: string, atMs: number, gapMs = 300): SpokenWord[] {
  return text.split(' ').map((w, i) => ({ text: w, startMs: atMs + i * gapMs }));
}

// The live clip of the owner report (seq time, after the tighten cuts), shortened.
const CLIP: SpokenWord[] = [
  ...said('Secara matematika, uang kita pasti bakal otomatis berkurang jadi 80 ribu.', 122),
  ...said('Nah, tapi menurut gue, konsep rezeki itu nggak sesederhana matematika', 4113),
  ...said('100 ribu dikurang 20 ribu sama dengan 80 ribu.', 8453),
  ...said('Karena kita tuh nggak pernah tahu dari 20 ribu yang kita keluarkan itu,', 11671),
  ...said('Allah tuh bakalan bukain pintu rezeki yang mana buat kita.', 15733),
  ...said('Bisa jadi lewat kesempatan kerja yang nggak pernah kita bayangin sebelumnya.', 19660),
  ...said('Atau bisnis yang tiba -tiba berkembang,', 23942),
];
const at = (text: string) => CLIP.find((w) => w.text === text)!.startMs;

describe('speech sync: matcher', () => {
  test('normalises case, punctuation, hyphens and spelling variants', () => {
    expect(speechTokens('Bisnis tiba-tiba, BERKEMBANG!')).toEqual([
      'bisnis',
      'tiba',
      'tiba',
      'berkembang',
    ]);
    expect(speechTokens('yang tiba -tiba')).toEqual(['yang', 'tiba', 'tiba']);
    expect(speechTokens('gak tau')).toEqual(speechTokens('nggak tahu'));
  });

  test('exact match: the first word of the best run', () => {
    expect(matchSpeech('Allah tuh bakalan bukain pintu', CLIP, 0)).toMatchObject({
      startMs: at('Allah'),
      matched: 5,
      ratio: 1,
    });
  });

  test('in-order words with gaps: the run holding the most words, not the first word seen', () => {
    // "Allah bukain pintu": "pintu" alone is not enough, the whole run starts at "Allah"
    expect(matchSpeech('Allah bukain pintu', CLIP, 0)?.startMs).toBe(at('Allah'));
    // "konsep rezeki nggak sesederhana matematika": "matematika" is also said at the start
    expect(matchSpeech('konsep rezeki nggak sesederhana matematika', CLIP, 0)?.startMs).toBe(
      at('konsep'),
    );
  });

  test('hyphen written with a space in the transcript ("tiba -tiba")', () => {
    expect(matchSpeech('bisnis tiba-tiba berkembang', CLIP, 0)?.startMs).toBe(at('bisnis'));
  });

  test('gak / nggak and tau / tahu are the same word', () => {
    const m = matchSpeech('kita gak pernah tau', CLIP, 0);
    expect(m?.startMs).toBe(at('Karena') + 300);
    expect(m?.ratio).toBe(1);
  });

  test('a phrase said twice: the run nearest the planned time', () => {
    expect(matchSpeech('80 ribu', CLIP, 1433)?.startMs).toBe(at('jadi') + 300);
    expect(matchSpeech('80 ribu', CLIP, 10_000)?.startMs).toBe(8453 + 7 * 300);
  });

  test('no confident match: unrelated text, one word of a phrase, one short word', () => {
    expect(matchSpeech('harga emas naik tajam', CLIP, 0)).toBeUndefined();
    expect(matchSpeech('pintu darurat', CLIP, 0)).toBeUndefined();
    expect(matchSpeech('20', CLIP, 0)).toBeUndefined();
    expect(matchSpeech('', CLIP, 0)).toBeUndefined();
  });
});

const scene = (startMs: number, durationMs: number, texts: string[], minMs = 1200) => ({
  startMs,
  durationMs,
  minMs,
  texts,
});

describe('speech sync: moving scenes', () => {
  test('the live plan: every scene starts a short lead before its words', () => {
    const r = syncScenesToSpeech(
      [
        scene(1433, 1200, ['80 ribu', 'uang berkurang otomatis']),
        scene(4100, 1467, ['konsep rezeki nggak sesederhana matematika']),
        scene(5567, 5000, ['Allah bukain pintu'], 1800),
      ],
      CLIP,
      40_000,
    );
    expect(r).toEqual([
      { startMs: at('jadi') + 300 - SPEECH_LEAD_MS, durationMs: 1200, matchedText: '80 ribu' },
      {
        startMs: at('konsep') - SPEECH_LEAD_MS,
        durationMs: 1467,
        matchedText: 'konsep rezeki nggak sesederhana matematika',
      },
      {
        startMs: at('Allah') - SPEECH_LEAD_MS,
        durationMs: 5000,
        matchedText: 'Allah bukain pintu',
      },
    ]);
  });

  test('no match, or already near its words: the scene is left as it is', () => {
    const r = syncScenesToSpeech(
      [scene(1000, 2000, ['harga emas naik']), scene(at('Allah') - 500, 2000, ['Allah bukain'])],
      CLIP,
      40_000,
    );
    expect(r).toEqual([
      { startMs: 1000, durationMs: 2000 },
      { startMs: at('Allah') - 500, durationMs: 2000 },
    ]);
  });

  test('stack panels: the first panel text that matches places the scene', () => {
    const r = syncScenesToSpeech(
      [scene(18_500, 5000, ['kesempatan kerja', 'bisnis tiba-tiba berkembang'])],
      CLIP,
      40_000,
    );
    expect(r[0]).toMatchObject({ startMs: at('kesempatan') - SPEECH_LEAD_MS, durationMs: 5000 });
  });

  test('collision with the next scene: the earlier one yields (shorter), order kept', () => {
    // "Allah…" moves to 15533 with 5000 ms and would run into the next scene at 17000
    const r = syncScenesToSpeech(
      [scene(2000, 5000, ['Allah bukain pintu'], 1200), scene(17_000, 2000, ['harga emas'])],
      CLIP,
      40_000,
    );
    expect(r).toEqual([
      {
        startMs: at('Allah') - SPEECH_LEAD_MS,
        durationMs: 17_000 - (at('Allah') - SPEECH_LEAD_MS),
        matchedText: 'Allah bukain pintu',
      },
      { startMs: 17_000, durationMs: 2000 },
    ]);
  });

  test('collision under the minimum: the earlier one starts earlier, keeping its minimum', () => {
    const next = at('Allah') + 300;
    const r = syncScenesToSpeech(
      [scene(2000, 3000, ['Allah bukain pintu'], 1800), scene(next, 2000, ['nothing said here'])],
      CLIP,
      40_000,
    );
    expect(r[0]).toEqual({
      startMs: next - 1800,
      durationMs: 1800,
      matchedText: 'Allah bukain pintu',
    });
    expect(r[1]).toEqual({ startMs: next, durationMs: 2000 });
  });

  test('end of the sequence: a moved scene is shortened, or starts earlier to keep its minimum', () => {
    const lead = at('bisnis') - SPEECH_LEAD_MS;
    const short = syncScenesToSpeech([scene(1000, 5000, ['bisnis tiba-tiba'])], CLIP, lead + 3000);
    expect(short[0]).toMatchObject({ startMs: lead, durationMs: 3000 });
    const min = syncScenesToSpeech(
      [scene(1000, 5000, ['bisnis tiba-tiba'], 2000)],
      CLIP,
      lead + 500,
    );
    expect(min[0]).toMatchObject({ startMs: lead + 500 - 2000, durationMs: 2000 });
  });

  test('no transcript words: nothing moves', () => {
    expect(syncScenesToSpeech([scene(0, 2000, ['Allah bukain pintu'])], [], 40_000)).toEqual([
      { startMs: 0, durationMs: 2000 },
    ]);
  });
});

const TEXT_TEMPLATES: TemplateInfo[] = [
  {
    id: 'vox/stat',
    version: '1.0.0',
    kind: 'scene',
    durationMs: { min: 1200, default: 2500, max: 5000 },
    variables: {
      type: 'object',
      properties: {
        value: { type: 'string', maxLength: 24 },
        bgPhoto: { type: 'string', maxLength: 64 },
        tag: { type: 'string', maxLength: 32 },
        language: { type: 'string', pattern: '^[a-z]{2,3}$' },
        bg: { type: 'string', enum: ['paper', 'dark'] },
      },
    },
    slots: { bgPhoto: 'image' },
  },
  {
    id: 'vox/kinetic-serif',
    version: '1.0.0',
    kind: 'scene',
    durationMs: { min: 1200, default: 2500, max: 5000 },
    variables: { type: 'object', properties: { text: { type: 'string', maxLength: 60 } } },
    slots: {},
  },
  {
    id: 'vox/stack',
    version: '1.0.0',
    kind: 'scene',
    durationMs: { min: 1200, default: 3200, max: 5000 },
    variables: { type: 'object', properties: { panels: { type: 'array' } } },
    slots: { 'panels/*': 'template' },
  },
];

describe('speech sync: scene text', () => {
  const templates = mapTemplateLookup(TEXT_TEMPLATES);
  const get = (id: string) => templates.get(id)!;

  test('free-text strings in schema order; picture slots, enums and codes left out', () => {
    expect(
      sceneTexts(
        get('vox/stat'),
        { tag: 'uang berkurang', value: '80 ribu', bgPhoto: 'm1', language: 'id', bg: 'dark' },
        templates,
      ),
    ).toEqual(['80 ribu', 'uang berkurang']);
  });

  test('panels text, in panel order', () => {
    expect(
      sceneTexts(
        get('vox/stack'),
        {
          panels: [
            { template: 'vox/stat', variables: { value: 'kesempatan kerja' } },
            { template: 'vox/kinetic-serif', variables: { text: 'bisnis tiba-tiba berkembang' } },
            { template: 'vox/unknown', variables: { text: 'skipped' } },
          ],
        },
        templates,
      ),
    ).toEqual(['kesempatan kerja', 'bisnis tiba-tiba berkembang']);
  });
});

describe('speech sync in a ClipPlan', () => {
  test('a scene placed before its words moves to them, with a repair note', async () => {
    // the fixture transcript says "First, we find the best moments in the footage." at 5954 ms
    const f = await fixtureProject();
    const m = scriptedModel([
      {
        json: {
          sequences: [
            {
              sequenceId: 's1',
              beats: [
                { startMs: 0, endMs: 1000, kind: 'speaker' },
                {
                  startMs: 1000,
                  endMs: 3000,
                  kind: 'scene',
                  template: 'base/title',
                  variables: { title: 'we find the best moments' },
                },
                {
                  startMs: 3000,
                  endMs: 4000,
                  kind: 'scene',
                  template: 'base/title',
                  variables: { title: 'nothing like it is said' },
                },
              ],
            },
          ],
        },
      },
    ]);
    const { deps } = runDeps(f, roleModel(m.model), { templates: mapTemplateLookup(TEMPLATES) });
    const { done, run } = await runAgent(deps, {
      projectId: f.projectId,
      workflow: 'freeform',
      message: 'add scenes',
      allowedTools: [],
      mode: 'plan' as const,
      scope: [f.sequenceId],
      planKind: 'clip',
    });
    expect(done.status).toBe('completed');
    const seq = (await f.engine.getProject(f.projectId)).sequences[0]!;
    const scenes = seq.videoTracks.find((t) => t.id === 'V2')!.items;
    const moved = 6500 - SPEECH_LEAD_MS;
    expect(scenes.map((s) => [s.startMs, s.durationMs])).toEqual([
      [3000, 1000],
      [moved, 2000],
    ]);
    const rec = readRunRecord(run.record.path).find((l) => l.tool === 'batch');
    expect(rec?.['repairs']).toEqual([
      {
        beat: 1,
        sequenceId: f.sequenceId,
        what: `scene "we find the best moments" moved 1000 → ${String(moved)} ms to match speech`,
      },
    ]);
  });
});
