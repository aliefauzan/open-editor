// Phase 07 step 8b: `vox style validate` runs the SFX kit check (`audio-qa --kit`, styles spec "SFX
// rules") and writes the sheet to previews/sfx-sheet.png.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { loadStyleRegistry } from '../../../src/styles/registry.ts';
import { validateStyle } from '../../../src/styles/validate.ts';
import { REPO_STYLES } from '../../compile/fixture.ts';

const tmp = mkdtempSync(join(tmpdir(), 'vox-kit-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function beepStyle(): string {
  const dir = join(tmp, 'styles', 'beep');
  mkdirSync(join(dir, 'assets', 'sfx'), { recursive: true });
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:duration=0.3:sample_rate=48000,afade=t=in:d=0.02,afade=t=out:st=0.25:d=0.05,volume=-6dB',
    '-ac',
    '1',
    join(dir, 'assets', 'sfx', 'beep.wav'),
  ]);
  writeFileSync(
    join(dir, 'assets', 'sfx', 'CREDITS.md'),
    '| `beep.wav` | appear | generated test tone | CC0 |\n',
  );
  writeFileSync(
    join(dir, 'style.json'),
    JSON.stringify({
      id: 'beep',
      name: 'Beep',
      version: '1.0.0',
      description: 'test style with a synthesised SFX',
      status: 'draft',
      extends: 'base',
      source: { type: 'user' },
      trusted: false,
      templates: [],
      transitions: [],
      sfx: {
        beep: { path: 'assets/sfx/beep.wav', type: 'appear', source: 'generated', licence: 'CC0' },
      },
    }),
  );
  return join(tmp, 'styles');
}

const opts = { render: false, dom: false } as const;

describe('SFX kit check in vox style validate (step 8b)', () => {
  test('a style whose sfx is a generated sine beep fails, naming the rule', async () => {
    const registry = loadStyleRegistry({ stylesDirs: [REPO_STYLES, beepStyle()] });
    const r = await validateStyle({ registry, styleId: 'beep', ...opts });
    expect(r.ok).toBe(false);
    const kit = r.problems.filter((p) => p.rule === 'sfx-kit');
    // the tone fails "not synthesised" (it may fail other rules too)
    const tone = kit.filter((p) => p.message.includes('notSynthesised'));
    expect(tone).toHaveLength(1);
    expect(tone[0]!.message).toContain('sfx beep: beep.wav');
    expect(r.checked['sfx-kit']).toBe(1);
  });

  test('the vox kit passes every SFX rule and writes previews/sfx-sheet.png', async () => {
    const registry = loadStyleRegistry({ stylesDirs: [REPO_STYLES] });
    const r = await validateStyle({ registry, styleId: 'vox', ...opts, previews: true });
    expect(r.problems.filter((p) => p.rule.startsWith('sfx'))).toEqual([]);
    expect(r.checked['sfx-kit']).toBe(1);
    expect(r.previews).toContain('previews/sfx-sheet.png');
    expect(existsSync(join(REPO_STYLES, 'vox', 'previews', 'sfx-sheet.png'))).toBe(true);
  });
});
