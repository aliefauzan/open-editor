// Phase 06: the static part of `vox style validate` (no render, no Chrome) and the pure helpers:
// text maxLength, file references, SFX credits (step 6), caption preset schema (step 5c), reserved
// `skipEntrance` (step 5b), and the cue-timing measurement on synthetic frame differences (step 6).
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { cueTimingFindings, frameDiffs } from '../../src/styles/cue-timing.ts';
import { loadStyleRegistry } from '../../src/styles/registry.ts';
import {
  fileRefProblems,
  textLength,
  textWithoutMaxLength,
  validateStyle,
} from '../../src/styles/validate.ts';
import { REPO_STYLES } from '../compile/fixture.ts';

const VALIDATE_STYLES = join(import.meta.dirname, '..', 'fixtures', 'styles', 'validate');

const registry = () => loadStyleRegistry({ stylesDirs: [REPO_STYLES, VALIDATE_STYLES] });
const staticOnly = (styleId: string) =>
  validateStyle({ registry: registry(), styleId, render: false, dom: false });
const rules = (r: { problems: { rule: string }[] }) => [...new Set(r.problems.map((p) => p.rule))];

describe('validate: static checks', () => {
  test('base passes the static checks', async () => {
    const r = await staticOnly('base');
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checked['text-max-length']).toBe(5);
  });

  test('a good test style passes; its SFX are credited', async () => {
    const r = await staticOnly('vgood');
    expect(r.problems).toEqual([]);
    expect(r.checked['sfx-credits']).toBe(1);
  });

  test('a missing CREDITS.md entry fails (step 6)', async () => {
    const r = await staticOnly('vnocredit');
    expect(rules(r)).toEqual(['sfx-credits']);
    expect(r.problems[0]!.message).toContain('pop.wav');
  });

  test('a caption preset with no .json or a bad case fails (step 5c)', async () => {
    const a = await staticOnly('vnojson');
    expect(rules(a)).toEqual(['caption-preset']);
    expect(a.ok).toBe(false);
    const b = await staticOnly('vbadcase');
    expect(rules(b)).toEqual(['caption-preset']);
    expect(b.problems[0]!.message).toMatch(/case/);
  });

  test('a variables schema that declares skipEntrance fails with the rule named (step 5b)', async () => {
    const r = await staticOnly('vskip');
    expect(rules(r)).toEqual(['skip-entrance']);
    expect(r.problems[0]!.message).toContain('skipEntrance is reserved');
  });

  test('a text variable without maxLength and a file reference fail', async () => {
    const r = await staticOnly('vunsafe');
    expect(rules(r).sort()).toEqual(['missing-asset', 'text-max-length']);
    expect(r.problems.find((p) => p.rule === 'text-max-length')!.message).toContain('/note');
    expect(r.problems.find((p) => p.rule === 'missing-asset')!.message).toContain('pic.png');
  });

  test('helpers: maxLength walk skips enums and slots; refs; text length', () => {
    expect(
      textWithoutMaxLength(
        {
          type: 'object',
          properties: {
            a: { type: 'string' },
            b: { type: 'string', maxLength: 3 },
            c: { enum: ['x'], type: 'string' },
            photo: { type: 'string' },
            items: {
              type: 'array',
              items: { type: 'object', properties: { t: { type: 'string' } } },
            },
          },
        },
        { photo: 'image' },
      ),
    ).toEqual(['/a', '/items/*/t']);
    expect(
      fileRefProblems('<img src="a.png"><b style="background:url(\'https://x/y.png\')">'),
    ).toEqual([
      { rule: 'missing-asset', ref: 'a.png' },
      { rule: 'remote-asset', ref: 'https://x/y.png' },
    ]);
    expect(fileRefProblems('<img src="__PHOTO__"><a href="#x"><i style="fill:url(#g)">')).toEqual(
      [],
    );
    expect(textLength({ a: 'abc', b: ['de', { c: 'f' }], n: 3 })).toBe(6);
  });
});

describe('cue timing on frame differences (step 6)', () => {
  // 90 frames of a still picture with encoder noise, a pop at frame 15, motion 30–40 settling at 41
  const frames = Array.from({ length: 90 }, (_, i) => {
    const f = new Uint8Array(64).fill(20 + (i % 2));
    if (i >= 15) f.fill(220, 0, 16);
    if (i >= 30 && i <= 40) f.fill(100 + (i - 30) * 10, 32, 64);
    if (i > 40) f.fill(200, 32, 64);
    return f;
  });
  const diffs = frameDiffs(frames);

  test('an appear cue on the pop passes; 4 frames off fails', () => {
    expect(cueTimingFindings(diffs, [{ name: 'pop', type: 'appear', frame: 15 }])).toEqual([]);
    expect(cueTimingFindings(diffs, [{ name: 'pop', type: 'appear', frame: 16 }])).toEqual([]);
    const late = cueTimingFindings(diffs, [{ name: 'pop', type: 'appear', frame: 19 }]);
    expect(late).toHaveLength(1);
    expect(late[0]!.message).toContain('frame 19');
  });

  test('land within 1 frame of settling, move within 2 frames of peak motion; hero unmeasured', () => {
    expect(cueTimingFindings(diffs, [{ name: 'l', type: 'land', frame: 41 }])).toEqual([]);
    expect(cueTimingFindings(diffs, [{ name: 'l', type: 'land', frame: 45 }])).toHaveLength(1);
    expect(cueTimingFindings(diffs, [{ name: 'm', type: 'move', frame: 31 }])).toEqual([]);
    expect(cueTimingFindings(diffs, [{ name: 'm', type: 'move', frame: 60 }])).toHaveLength(1);
    expect(cueTimingFindings(diffs, [{ name: 'h', type: 'hero', frame: 60 }])).toEqual([]);
  });
});
