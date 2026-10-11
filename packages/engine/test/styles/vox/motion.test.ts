// Phase 07 step 3: every vox composition that inlines the motion helpers carries an exact copy of
// styles/vox/assets/motion.js (whitespace and trailing commas aside; prettier re-indents and re-wraps the copy).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
// @ts-expect-error plain ESM script without types
import { motionFiles } from '../../../../../scripts/sync-vox-motion.mjs';

const VOX = join(import.meta.dirname, '..', '..', '..', '..', '..', 'styles', 'vox');
const squash = (s: string) => s.replace(/\s+/g, '').replace(/,([)\]}])/g, '$1');
const motion = readFileSync(join(VOX, 'assets', 'motion.js'), 'utf8');
const files = (motionFiles as (dir: string) => string[])(VOX);

describe('styles/vox motion helpers', () => {
  test('every template, caption preset and overlay inlines motion.js', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files.map((f) => [f.slice(VOX.length + 1), f] as const))(
    '%s carries an exact copy (run node scripts/sync-vox-motion.mjs)',
    (_rel, f) => {
      const src = readFileSync(f, 'utf8');
      const m = /\/\/ vox:motion:begin\n([\s\S]*?)\n[ \t]*\/\/ vox:motion:end/.exec(src);
      expect(m).not.toBeNull();
      expect(squash(m![1]!)).toBe(squash(motion));
    },
  );
});

// The helpers themselves, run in a vm with real GSAP and a stub DOM.
import { createRequire } from 'node:module';
import vm from 'node:vm';

interface Helpers {
  held(ease: string, duration: number): (p: number) => number;
  pop(tl: unknown, el: object, at: number, d?: number): number;
  hold: number;
  step: number;
}

function load(tokens: Record<string, string>, id: string) {
  const require = createRequire(import.meta.url);
  const gsap = (require('gsap') as { gsap: unknown }).gsap;
  const window: Record<string, unknown> = {
    gsap,
    getComputedStyle: () => ({ getPropertyValue: (n: string) => tokens[n] ?? '' }),
    document: { querySelector: () => null },
  };
  vm.runInNewContext(motion, { window, Math });
  const api = window['voxMotion'] as { create(root: object, id: string): Helpers };
  return {
    gsap: gsap as { timeline(o: object): { seek(t: number): void } },
    m: api.create({}, id),
  };
}

const TOK = {
  '--tok-motion-frame-hold': '2',
  '--tok-motion-jitter-px': '2',
  '--tok-motion-easing': 'back.out(1.6)',
  '--tok-motion-entrance': 'pop',
};

describe('motion.js', () => {
  test('held ease changes only every 2 frames at 30 fps and ends at 1', () => {
    const { m } = load(TOK, 's1');
    const e = m.held('back.out(1.6)', 0.4); // 12 frames, 6 steps
    expect(m.step).toBeCloseTo(2 / 30);
    expect(e(0.05)).toBe(e(0));
    expect(e(1 / 6 + 0.01)).toBe(e(2 / 6 - 0.01));
    expect(e(2 / 6 + 0.01)).not.toBe(e(1 / 6 + 0.01));
    expect(e(1)).toBe(1);
  });

  test('pop jitter is seeded by the instance id, at most jitterPx, and rests at 0', () => {
    const run = (id: string) => {
      const { gsap, m } = load(TOK, id);
      const el: Record<string, unknown> = { x: 0, y: 0, scale: 1, opacity: 1 };
      const tl = gsap.timeline({ paused: true });
      m.pop(tl, el, 0, 0.4);
      const xs: string[] = [];
      for (let f = 0; f <= 15; f++) {
        tl.seek(f / 30);
        xs.push(String(el['x']));
      }
      return xs;
    };
    const a = run('scene-a');
    expect(run('scene-a')).toEqual(a);
    expect(run('scene-b')).not.toEqual(a);
    for (const x of a) expect(Math.abs(parseFloat(x))).toBeLessThanOrEqual(2);
    expect(parseFloat(a[15]!)).toBe(0);
  });
});
