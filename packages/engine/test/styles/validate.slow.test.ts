// Phase 06 steps 4, 5, 5b, 5c, 6 (slow part): `validateStyle` with the HyperFrames render and the
// Chrome DOM checks. The test styles are copied to a temp folder so previews are not written into
// the repo fixtures.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { loadStyleRegistry } from '../../src/styles/registry.ts';
import { validateStyle, type ValidateReport } from '../../src/styles/validate.ts';
import { REPO_STYLES } from '../compile/fixture.ts';
const VALIDATE_STYLES = join(import.meta.dirname, '..', 'fixtures', 'styles', 'validate');

const dir = mkdtempSync(join(tmpdir(), 'vox-validate-test-'));
cpSync(VALIDATE_STYLES, dir, { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const registry = () => loadStyleRegistry({ stylesDirs: [REPO_STYLES, dir] });
const rules = (r: ValidateReport) => [...new Set(r.problems.map((p) => p.rule))].sort();

describe('vox style validate: render and DOM checks', () => {
  test('base passes every check (previews not written)', async () => {
    const r = await validateStyle({ registry: registry(), styleId: 'base', previews: false });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    for (const k of ['lint', 'render', 'safe-area', 'caption-safe-area', 'caption-states']) {
      expect(r.checked[k], k).toBeGreaterThan(0);
    }
  });

  test('a good style passes and writes previews: contact sheet, a JPEG and GIF per template, one cell per preset', async () => {
    const r = await validateStyle({ registry: registry(), styleId: 'vgood' });
    expect(r.problems).toEqual([]);
    expect(r.checked['cue-timing']).toBe(2); // one per fixture
    expect(r.checked['min-entrance']).toBe(1);
    const prev = join(dir, 'vgood', 'previews');
    for (const f of ['contact.jpg', 'contact.json', 'pop.jpg', 'pop.gif']) {
      expect(existsSync(join(prev, f)), f).toBe(true);
    }
    const sheet = JSON.parse(readFileSync(join(prev, 'contact.json'), 'utf8')) as {
      cells: { kind: string; preset?: string }[];
    };
    const presets = sheet.cells.filter((c) => c.kind === 'caption').map((c) => c.preset);
    expect(presets.sort()).toEqual(['base/plain', 'vgood/loud']);
  });

  test('an appear cue 4 frames after the picture change fails cue timing (step 6)', async () => {
    const r = await validateStyle({
      registry: registry(),
      styleId: 'vlate',
      dom: false,
      previews: false,
    });
    expect(rules(r)).toEqual(['cue-timing']);
    expect(r.problems[0]!.message).toMatch(/dot/);
  });

  test('text outside the safe area and an entrance that ignores skipEntrance fail (steps 4, 5b)', async () => {
    const r = await validateStyle({
      registry: registry(),
      styleId: 'vunsafe',
      render: false,
    });
    const dom = r.problems.filter((p) => p.rule === 'safe-area' || p.rule === 'min-entrance');
    expect([...new Set(dom.map((p) => `${p.rule} ${p.template}`))].sort()).toEqual([
      'min-entrance vunsafe/noskip',
      'safe-area vunsafe/low',
    ]);
    expect(dom.find((p) => p.rule === 'min-entrance')!.message).toContain('at 1500 ms');
  });
});
