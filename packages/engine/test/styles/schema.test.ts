import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { VoxError } from '../../src/errors.pending.ts';
import {
  captionSafeArea,
  parseCaptionPreset,
  parseStyleFile,
  parseTemplate,
  StyleSchema,
  variablesValidator,
} from '../../src/styles/schema.ts';

const fixture = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../fixtures/styles/${rel}`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;

const baseStyle = () => fixture('builtin/base/style.json');
const titleTemplate = () => fixture('builtin/base/templates/title/template.json');
const boxPreset = () => fixture('builtin/paper/captions/box.json');

function styleInvalid(fn: () => unknown): VoxError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(VoxError);
    expect((e as VoxError).code).toBe('STYLE_INVALID');
    return e as VoxError;
  }
  throw new Error('expected STYLE_INVALID');
}

describe('style.json schema', () => {
  test('accepts the complete root fixture and the partial child fixtures', () => {
    expect(parseStyleFile(baseStyle(), 'base/style.json').id).toBe('base');
    expect(StyleSchema.safeParse(baseStyle()).success).toBe(true);
    expect(parseStyleFile(fixture('builtin/paper/style.json'), 'p').extends).toBe('base');
    expect(parseStyleFile(fixture('user/draft/style.json'), 'd').status).toBe('draft');
  });

  test('a child file may omit tokens, pacing, imagery, captions, overlays and sfx', () => {
    const child = {
      id: 'kid',
      name: 'Kid',
      version: '1.0.0',
      description: '',
      status: 'active',
      extends: 'base',
      source: { type: 'user' },
      trusted: false,
      templates: [],
      transitions: [],
    };
    expect(parseStyleFile(child, 'kid/style.json').id).toBe('kid');
    // The resolved (complete) schema still needs every section.
    expect(StyleSchema.safeParse(child).success).toBe(false);
  });

  test.each([
    ['id with capitals', { id: 'Base' }],
    ['id with a slash', { id: 'a/b' }],
    ['unknown status', { status: 'published' }],
    ['unknown source type', { source: { type: 'web' } }],
    ['version that is not semver', { version: 'v1' }],
    [
      'frameHold 4',
      {
        tokens: {
          ...baseStyle()['tokens']!,
          motion: { easing: 'none', frameHold: 4, jitterPx: 0, entrance: 'fade' },
        },
      },
    ],
    ['grain above 1', { tokens: { ...baseStyle()['tokens']!, texture: { grain: 1.5 } } }],
    ['unknown top-level key (typo)', { extend: 'base' }],
    ['extends itself', { extends: 'base' }],
    [
      'default caption preset not listed',
      { captions: { default: 'base/other', presets: ['base/plain'] } },
    ],
    [
      'caption preset id without style prefix',
      { captions: { default: 'plain', presets: ['plain'] } },
    ],
    ['template listed twice', { templates: ['title', 'title'] }],
    ['name both template and transition', { transitions: ['title'] }],
    [
      'beatMs min above target',
      {
        pacing: {
          beatMs: { min: 5000, target: 3000, max: 6000 },
          speakerRatio: { min: 0, max: 1 },
        },
      },
    ],
    [
      'speakerRatio above 1',
      { pacing: { beatMs: { min: 1, target: 2, max: 3 }, speakerRatio: { min: 0, max: 2 } } },
    ],
  ])('rejects %s', (_label, patch) => {
    const e = styleInvalid(() => parseStyleFile({ ...baseStyle(), ...patch }, 'base/style.json'));
    expect(e.details?.['file']).toBe('base/style.json');
    expect(e.details?.['reason']).toBe('schema');
    expect((e.details?.['issues'] as string[]).length).toBeGreaterThan(0);
  });

  test.each([
    ['CSS break-out in a colour', '#fff; } body { color: red'],
    ['markup in a colour', '</style><script>alert(1)</script>'],
    ['a newline', '#fff\n'],
    ['an empty value', ''],
    ['url() (network or file fetch at render)', 'url(//evil.example/x.png)'],
    ['url() without a scheme', 'url(assets/x.png)'],
    ['var()', 'var(--x)'],
    ['image-set()', 'image-set(a 1x)'],
    ['a protocol-relative URL', 'a//b'],
  ])('rejects a token value with %s', (_label, value) => {
    const s = baseStyle();
    const tokens = s['tokens'] as { colors: Record<string, string> };
    tokens.colors['paper'] = value;
    styleInvalid(() => parseStyleFile(s, 'base/style.json'));
  });

  test('rejects a quote in a font family and an unsafe token name', () => {
    const s = baseStyle();
    const tokens = s['tokens'] as {
      colors: Record<string, string>;
      fonts: { display: { family: string } };
    };
    tokens.fonts.display.family = 'Evil" , x';
    styleInvalid(() => parseStyleFile(s, 'f'));
    const t = baseStyle();
    (t['tokens'] as { colors: Record<string, string> }).colors['bad name'] = '#fff';
    styleInvalid(() => parseStyleFile(t, 'f'));
  });

  describe('sfx entries (D-14 object form)', () => {
    const withSfx = (entry: Record<string, unknown>) => ({
      ...baseStyle(),
      sfx: {
        tap: { path: 'assets/sfx/tap.wav', type: 'appear', source: 'x', licence: 'CC0', ...entry },
      },
    });
    test('accepts CC0 and project licences', () => {
      expect(parseStyleFile(withSfx({ licence: 'project' }), 'f').sfx?.['tap']?.licence).toBe(
        'project',
      );
      expect(parseStyleFile(withSfx({}), 'f').sfx?.['tap']?.type).toBe('appear');
    });
    test.each([
      ['an unknown licence', { licence: 'CC-BY' }],
      ['an unknown type', { type: 'boom' }],
      ['an empty source', { source: '' }],
      ['an absolute path', { path: '/etc/passwd' }],
      ['a parent path', { path: '../other/assets/x.wav' }],
      ['a parent segment inside', { path: 'assets/../../x.wav' }],
      ['a backslash', { path: 'assets\\x.wav' }],
      ['a quote (CSS break-out)', { path: 'assets/x");}.wav' }],
      ['markup', { path: 'assets/</style>.wav' }],
      ['a newline', { path: 'assets/x\n.wav' }],
      ['a URL scheme', { path: 'data:audio/wav;base64,AAA' }],
      ['a percent-encoded parent', { path: '%2e%2e/x.wav' }],
      ['a query', { path: 'assets/x.wav?x' }],
      ['a fragment', { path: 'assets/x.wav#x' }],
      ['a string instead of the object form', null],
    ])('rejects %s', (_label, entry) => {
      const s =
        entry === null ? { ...baseStyle(), sfx: { tap: 'assets/sfx/tap.wav' } } : withSfx(entry);
      styleInvalid(() => parseStyleFile(s, 'f'));
    });
  });

  test('font files and the paper texture follow the style-relative path rule', () => {
    const s = baseStyle();
    (s['tokens'] as { fonts: { body: { file: string } } }).fonts.body.file = '/Library/Fonts/x.ttf';
    styleInvalid(() => parseStyleFile(s, 'f'));
    const t = baseStyle();
    (t['tokens'] as Record<string, unknown>)['texture'] = { paper: '../x.jpg' };
    styleInvalid(() => parseStyleFile(t, 'f'));
  });
});

describe('template.json schema', () => {
  test('accepts the fixtures', () => {
    const t = parseTemplate(titleTemplate(), 'title/template.json');
    expect(t.kind).toBe('scene');
    expect(t.minEntranceMs).toBe(2000);
    expect(t.sfxCues?.[0]?.atMs).toBe('entrance');
    expect(
      parseTemplate(fixture('builtin/base/templates/crossfade/template.json'), 'c').blendsShots,
    ).toBe(true);
    expect(parseTemplate(fixture('builtin/paper/templates/map/template.json'), 'm').slots).toEqual({
      'places/*': 'geo',
    });
  });

  test.each([
    ['an unknown kind', { kind: 'overlay' }],
    ['durationMs default below min', { durationMs: { min: 1000, default: 500, max: 2000 } }],
    ['durationMs max below default', { durationMs: { min: 0, default: 3000, max: 2000 } }],
    ['fractional durationMs', { durationMs: { min: 0.5, default: 1, max: 2 } }],
    ['an unknown slot kind', { slots: { photo: 'audio' } }],
    ['a bad slot path', { slots: { '/photo': 'image' } }],
    ['a cue with a negative atMs', { sfxCues: [{ name: 'a', atMs: -1, sfx: 'tap', type: 'cut' }] }],
    ['a cue with an unknown type', { sfxCues: [{ name: 'a', atMs: 0, sfx: 'tap', type: 'boom' }] }],
    [
      'two cues with one name',
      {
        sfxCues: [
          { name: 'a', atMs: 0, sfx: 'tap', type: 'cut' },
          { name: 'a', atMs: 10, sfx: 'tap', type: 'cut' },
        ],
      },
    ],
    [
      'minEntranceMs on a transition',
      { kind: 'transition', minEntranceMs: 500, sfxCues: undefined },
    ],
    ['blendsShots on a scene', { blendsShots: true }],
    ['minEntranceMs of 0', { minEntranceMs: 0 }],
    ['an unknown key', { duration: 3 }],
    ['an empty name', { name: '' }],
  ])('rejects %s', (_label, patch) => {
    const e = styleInvalid(() =>
      parseTemplate({ ...titleTemplate(), ...patch }, 't/template.json'),
    );
    expect(e.details?.['reason']).toBe('schema');
  });

  describe('variables JSON Schema (ajv)', () => {
    const withVars = (variables: unknown) => ({ ...titleTemplate(), variables });

    test('a valid schema compiles and validates fixture variables', () => {
      const t = parseTemplate(titleTemplate(), 't');
      const v = variablesValidator(t.variables);
      expect(v({ text: 'Hello' })).toBe(true);
      expect(v({ text: 'x'.repeat(61) })).toBe(false);
      expect(v({})).toBe(false);
      expect(v({ text: 'a', extra: 1 })).toBe(false);
      expect(variablesValidator(t.variables)).toBe(v); // cached per schema object
    });

    test.each([
      ['a root that is not an object schema', { type: 'array', items: {} }],
      ['a root without type', { properties: { a: { type: 'string' } } }],
      ['an invalid type name', { type: 'object', properties: { a: { type: 'strng' } } }],
      ['required that is not an array', { type: 'object', required: 'a' }],
      [
        'an unknown keyword (typo)',
        { type: 'object', properties: { a: { type: 'string', maxLenght: 3 } } },
      ],
      [
        'an unknown format',
        { type: 'object', properties: { a: { type: 'string', format: 'colour' } } },
      ],
      [
        'the reserved skipEntrance variable (D-15)',
        { type: 'object', properties: { skipEntrance: { type: 'boolean' } } },
      ],
      ['skipEntrance in required', { type: 'object', required: ['skipEntrance'] }],
      [
        'skipEntrance nested in allOf',
        { type: 'object', allOf: [{ properties: { skipEntrance: { type: 'boolean' } } }] },
      ],
    ])('rejects %s', (_label, variables) => {
      const e = styleInvalid(() => parseTemplate(withVars(variables), 't/template.json'));
      expect(e.details?.['reason']).toBe('schema');
    });
  });
});

describe('accepted token values', () => {
  test.each([
    ['a hex colour', '#f4ecd8'],
    ['a colour function', 'oklch(70% 0.1 200 / 50%)'],
    ['a CSS easing', 'cubic-bezier(0.2, 0, 0, 1)'],
    ['a GSAP ease with a parameter', 'back.out(1.7)'],
    ['a GSAP ease name', 'power2.inOut'],
  ])('%s', (_label, value) => {
    const s = baseStyle();
    const tokens = s['tokens'] as { colors: Record<string, string>; motion: { easing: string } };
    tokens.colors['paper'] = value;
    tokens.motion.easing = value;
    expect(parseStyleFile(s, 'f').tokens?.colors?.['paper']).toBe(value);
  });

  test('two colour keys with one CSS name are rejected at load', () => {
    const s = baseStyle();
    (s['tokens'] as { colors: Record<string, string> }).colors['accent-soft'] = '#000';
    styleInvalid(() => parseStyleFile(s, 'f'));
  });

  test('a variables schema with $id parses again (no shared Ajv cache)', () => {
    const t = { ...titleTemplate(), variables: { $id: 'title-vars', type: 'object' } };
    parseTemplate(t, 'a');
    expect(parseTemplate(structuredClone(t), 'b').name).toBe('title');
    expect(variablesValidator(structuredClone(t).variables)({})).toBe(true);
    expect(variablesValidator(structuredClone(t).variables)({})).toBe(true);
  });
});

describe('caption preset .json schema (D-15)', () => {
  test('accepts the fixtures', () => {
    const p = parseCaptionPreset(boxPreset(), 'box.json');
    expect(p).toMatchObject({ case: 'upper', stripPunctuation: true, position: { yPct: 70 } });
    expect(
      parseCaptionPreset(fixture('builtin/base/captions/plain.json'), 'p').safeArea,
    ).toBeUndefined();
  });

  test.each([
    ['an unknown case', { case: 'title' }],
    ['stripPunctuation as a string', { stripPunctuation: 'yes' }],
    ['a missing position', { position: undefined }],
    ['yPct above 100', { position: { yPct: 101 } }],
    ['bottomPct of 100', { safeArea: { bottomPct: 100, rightPct: 0 } }],
    ['rightPct of 50 (no width left)', { safeArea: { bottomPct: 0, rightPct: 50 } }],
    ['a negative safe area', { safeArea: { bottomPct: -1, rightPct: 0 } }],
    ['a partial safe area', { safeArea: { bottomPct: 10 } }],
    ['an unknown key', { font: 'x' }],
  ])('rejects %s', (_label, patch) => {
    styleInvalid(() => parseCaptionPreset({ ...boxPreset(), ...patch }, 'box.json'));
  });

  test('safe area defaults to 20 / 12 on 9:16 and 0 / 0 otherwise; an explicit one wins', () => {
    const plain = parseCaptionPreset(fixture('builtin/base/captions/plain.json'), 'p');
    expect(captionSafeArea(plain, { width: 1080, height: 1920 })).toEqual({
      bottomPct: 20,
      rightPct: 12,
    });
    expect(captionSafeArea(plain, { width: 720, height: 1280 })).toEqual({
      bottomPct: 20,
      rightPct: 12,
    });
    expect(captionSafeArea(plain, { width: 1920, height: 1080 })).toEqual({
      bottomPct: 0,
      rightPct: 0,
    });
    expect(captionSafeArea(plain, { width: 1080, height: 1080 })).toEqual({
      bottomPct: 0,
      rightPct: 0,
    });
    const box = parseCaptionPreset(boxPreset(), 'b');
    expect(captionSafeArea(box, { width: 1920, height: 1080 })).toEqual({
      bottomPct: 25,
      rightPct: 10,
    });
  });
});
