import { describe, expect, test } from 'vitest';
import { VoxError } from '../../src/errors.pending.ts';
import type { Tokens } from '../../src/styles/schema.ts';
import { tokenName, tokenVars, tokensCss } from '../../src/styles/tokens.ts';

const tokens = (): Tokens => ({
  colors: { paper: '#f4ecd8', ink: '#111', accentSoft: 'rgb(10 20 30 / 50%)' },
  fonts: {
    display: { family: 'Libre Caslon Display', file: 'assets/fonts/d.ttf', weight: 400 },
    body: { family: 'Inter', file: 'assets/fonts/b.ttf', weight: 400 },
    caption: { family: 'IBM Plex Mono', file: 'assets/fonts/c.ttf', weight: 700 },
  },
  texture: { paper: 'assets/textures/paper.jpg', grain: 0.4 },
  motion: { easing: 'steps(4)', frameHold: 2, jitterPx: 1.5, entrance: 'pop' },
});

describe('token names', () => {
  test('--tok-<group>-<name>, camelCase keys become kebab-case', () => {
    expect(tokenName('color', 'paper')).toBe('--tok-color-paper');
    expect(tokenName('color', 'accentSoft')).toBe('--tok-color-accent-soft');
    expect(tokenName('motion', 'frameHold')).toBe('--tok-motion-frame-hold');
    expect(tokenName('color', 'sea-2')).toBe('--tok-color-sea-2');
  });
});

describe('tokenVars', () => {
  test('generates every group in a fixed order, sorted inside each group', () => {
    expect(tokenVars(tokens())).toEqual([
      ['--tok-color-accent-soft', 'rgb(10 20 30 / 50%)'],
      ['--tok-color-ink', '#111'],
      ['--tok-color-paper', '#f4ecd8'],
      ['--tok-font-body', '"Inter"'],
      ['--tok-font-body-weight', '400'],
      ['--tok-font-caption', '"IBM Plex Mono"'],
      ['--tok-font-caption-weight', '700'],
      ['--tok-font-display', '"Libre Caslon Display"'],
      ['--tok-font-display-weight', '400'],
      ['--tok-texture-grain', '0.4'],
      ['--tok-texture-paper', 'url("assets/textures/paper.jpg")'],
      ['--tok-motion-easing', 'steps(4)'],
      ['--tok-motion-entrance', 'pop'],
      ['--tok-motion-frame-hold', '2'],
      ['--tok-motion-jitter-px', '1.5'],
    ]);
  });

  test('the texture URL goes through the caller mapper (compile maps it into the build)', () => {
    const vars = tokenVars(tokens(), {
      assetUrl: (token, path) => `../assets/${token}/${path.split('/').pop()!}`,
    });
    expect(vars).toContainEqual([
      '--tok-texture-paper',
      'url("../assets/texture-paper/paper.jpg")',
    ]);
  });

  test('omits texture tokens that are not set', () => {
    const t = tokens();
    delete t.texture;
    const names = tokenVars(t).map(([n]) => n);
    expect(names.some((n) => n.startsWith('--tok-texture-'))).toBe(false);
  });

  test('key order in the input does not change the output', () => {
    const a = tokens();
    const b = tokens();
    b.colors = { ink: '#111', accentSoft: 'rgb(10 20 30 / 50%)', paper: '#f4ecd8' };
    expect(tokenVars(b)).toEqual(tokenVars(a));
  });

  test('two keys that map to one name fail with STYLE_INVALID (tokens are re-checked)', () => {
    const t = tokens();
    t.colors['accent-soft'] = '#000';
    let err: unknown;
    try {
      tokenVars(t);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VoxError);
    expect((err as VoxError).code).toBe('STYLE_INVALID');
  });

  test('a hand-built token value with url() is rejected, not emitted', () => {
    const t = tokens();
    t.colors['paper'] = 'url(//evil.example/x.png)';
    expect(() => tokenVars(t)).toThrow(VoxError);
  });

  test('a mapped asset URL cannot close the CSS string or the <style> element', () => {
    const [, value] = tokenVars(tokens(), {
      assetUrl: () => 'a"b\\c</style>\nd',
    }).find(([n]) => n === '--tok-texture-paper')!;
    expect(value).toBe('url("a\\"b\\\\c\\3c /style\\3e \\a d")');
    expect(value).not.toMatch(/[<>\n]/);
  });
});

describe('tokensCss', () => {
  test('one declaration block scoped to the selector, byte-identical on rerun', () => {
    const css = tokensCss(tokens(), '[data-composition-id="s1"]');
    expect(css.startsWith('[data-composition-id="s1"] {\n  --tok-color-accent-soft: ')).toBe(true);
    expect(css).toContain('\n  --tok-motion-frame-hold: 2;\n');
    expect(css.endsWith('}\n')).toBe(true);
    expect(tokensCss(tokens(), '[data-composition-id="s1"]')).toBe(css);
  });
});
