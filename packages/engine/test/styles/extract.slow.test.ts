// Phase 15 steps 1 and 3 (slow tier; needs make.sh outputs, ffmpeg, uv and Chrome): measurements on
// `style-extract-10s.mp4` against its truth file (shot count from the `shots` stage, palette within
// tolerance, caption words/position/case, the speaker shot), then the mapped draft passes
// `vox style validate` with the render, rendering every inherited template's fixtures (including
// `vox/map-route` with its trusted hook), and the report page is written beside the previews.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openEngine, type Engine } from '../../src/api.ts';
import type { JobInfo } from '../../src/jobs.ts';
import { mapDraftStyle } from '../../src/styles/extract/map.ts';
import { measureReference, type Measurements } from '../../src/styles/extract/measure.ts';
import { writeDraftStyle, writeStyleReport } from '../../src/styles/extract/write.ts';
import { validateStyle } from '../../src/styles/validate.ts';
import { tempDir } from '../helpers/store.ts';
import { templates } from '../helpers/templates.ts';
import { description, mapInput, userStyles } from './extract-fixture.ts';

const fx = new URL('../fixtures/', import.meta.url).pathname;
const REF = `${fx}out/style-extract-10s.mp4`;
interface Truth {
  cutsMs: number[];
  shotColors: string[];
  faceShots: number[];
  captionYPct: number;
  captionCase: string;
  wordsPerCaption: number;
  captions: { text: string }[];
}
const truth = (): Truth =>
  JSON.parse(readFileSync(`${fx}out/style-extract-10s.truth.json`, 'utf8')) as Truth;

const engine = (): Engine =>
  openEngine({
    projectsDir: join(tempDir('vox-extract-'), 'Projects'),
    stylesDirs: [],
    templates,
    config: async () => ({}),
  });

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const dist = (a: string, b: string) => {
  const x = rgb(a);
  const y = rgb(b);
  return Math.hypot(x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!);
};

let measured: Measurements | undefined;
async function measure(): Promise<Measurements> {
  if (measured) return measured;
  if (!existsSync(REF)) throw new Error('Run `bash packages/engine/test/fixtures/make.sh` first.');
  const e = engine();
  const p = await e.createProject('ref');
  const info = (await e.jobs.wait(
    e.jobs.start('ingest', { projectId: p.id, inputs: [REF], proxies: false }),
  )) as JobInfo<{ media: { mediaId: string }[] }>;
  expect(info.status).toBe('done');
  measured = await measureReference(e, {
    projectId: p.id,
    mediaId: info.result!.media[0]!.mediaId,
    workDir: join(tempDir('vox-extract-work-'), 'work'),
  });
  return measured;
}

describe('measure on style-extract-10s.mp4 (step 1)', () => {
  test('shot count, palette, speaker shot', async () => {
    const m = await measure();
    const t = truth();
    expect(m.shots).toHaveLength(t.cutsMs.length + 1);
    for (const [i, cut] of t.cutsMs.entries()) {
      expect(Math.abs(m.shots[i + 1]!.startMs - cut), `cut ${String(i)}`).toBeLessThanOrEqual(34);
    }
    for (const c of t.shotColors) {
      const near = Math.min(...m.palette.map((p) => dist(p.hex, c)));
      expect(near, c).toBeLessThanOrEqual(30);
    }
    expect(m.keyframes.length).toBeGreaterThanOrEqual(m.shots.length);
    expect(m.sheets.length).toBeGreaterThanOrEqual(1);
    if (m.speakerRatio !== null) {
      expect(m.shots.map((s, i) => (s.speaker ? i : -1)).filter((i) => i >= 0)).toEqual(
        t.faceShots,
      );
    }
  }, 300_000);

  test('captions: count, words, position, case', async () => {
    const m = await measure();
    const t = truth();
    const s = m.captions.summary;
    expect(s.detected).toBe(true);
    if (!s.detected) return;
    expect(s.captionCount).toBe(t.captions.length);
    expect(s.wordsPerCaption).toBe(t.wordsPerCaption);
    expect(Math.abs(s.yPct - t.captionYPct)).toBeLessThanOrEqual(3);
    expect(s.case).toBe(t.captionCase);
    expect(m.captions.events.map((x) => x.text.toUpperCase())).toEqual(
      t.captions.map((c) => c.text),
    );
  }, 300_000);
});

describe('draft from the fixture passes vox style validate (step 3)', () => {
  test('re-skin renders every inherited template, including vox/map-route; report beside previews', async () => {
    const m = await measure();
    const s = userStyles();
    const d = mapDraftStyle(mapInput(s.reg(), { measurements: m, description: description() }));
    const { dir } = writeDraftStyle(s.dirs, d);
    const v = await validateStyle({ registry: s.reg(), styleId: 'ref-look', kit: false });
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.notes.join('\n')).toMatch(/re-skin: renders the \d+ inherited templates/);
    expect(existsSync(join(dir, 'previews', 'map-route.jpg'))).toBe(true);
    expect(existsSync(join(dir, 'previews', 'contact.jpg'))).toBe(true);
    await writeStyleReport(dir, {
      draft: d,
      measurements: m,
      previews: ['previews/map-route.jpg'],
      validate: { ok: v.ok, problems: [], notes: v.notes },
      describedBy: 'mock-vision',
      reference: 'style-extract-10s.mp4',
    });
    expect(readFileSync(join(dir, 'report.html'), 'utf8')).toContain('previews/map-route.jpg');
    expect(existsSync(join(dir, 'report', 'ref-01.jpg'))).toBe(true);
  }, 600_000);
});
