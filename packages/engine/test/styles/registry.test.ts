import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { VoxError } from '../../src/errors.ts';
import { registryTemplateLookup } from '../../src/styles/lookup.ts';
import { loadStyleRegistry, MAX_EXTENDS_DEPTH } from '../../src/styles/registry.ts';

const FIX = fileURLToPath(new URL('../fixtures/styles/', import.meta.url));
const BUILTIN = join(FIX, 'builtin');
const USER = join(FIX, 'user');

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'vox-styles-'));
  temps.push(d);
  return d;
}

/** A styles dir holding a copy of the fixture `base`. */
function dirWithBase(): string {
  const d = tmp();
  cpSync(join(BUILTIN, 'base'), join(d, 'base'), { recursive: true });
  return d;
}

function child(id: string, ext: string | undefined, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: '',
    status: 'active',
    ...(ext === undefined ? {} : { extends: ext }),
    source: { type: 'user' },
    trusted: false,
    templates: [],
    transitions: [],
    ...extra,
  };
}

function writeStyle(dir: string, folder: string, json: unknown): string {
  const d = join(dir, folder);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'style.json'), typeof json === 'string' ? json : JSON.stringify(json));
  return d;
}

function writeJson(file: string, json: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(json));
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function thrown(fn: () => unknown): VoxError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(VoxError);
    return e as VoxError;
  }
  throw new Error('expected a VoxError');
}

function problem(reg: ReturnType<typeof loadStyleRegistry>, id: string) {
  const p = reg.problems().find((x) => x.id === id);
  expect(p, `problem for ${id}`).toBeDefined();
  return p!;
}

describe('search order and duplicates', () => {
  test('styles from every dir are listed; the built-in fixture set resolves', () => {
    const reg = loadStyleRegistry({ stylesDirs: [BUILTIN, USER] });
    expect(reg.list().map((s) => s.id)).toEqual(['base', 'draft', 'paper']);
    expect(reg.get('base').dir).toBe(join(BUILTIN, 'base'));
  });

  test('a duplicate id in a later dir is rejected and the first dir wins (no silent change)', () => {
    const reg = loadStyleRegistry({ stylesDirs: [BUILTIN, USER] });
    expect(reg.get('base').style.name).toBe('Base');
    expect(reg.list().filter((s) => s.id === 'base')).toHaveLength(1);
    const p = problem(reg, 'base');
    expect(p.dir).toBe(join(USER, 'base'));
    expect(p.error.code).toBe('STYLE_DUPLICATE');
    expect(p.error.details).toMatchObject({
      style: 'base',
      dirs: [join(BUILTIN, 'base'), join(USER, 'base')],
    });
  });

  test('search order decides which copy wins', () => {
    const one = dirWithBase();
    const two = dirWithBase();
    for (const [d, name] of [
      [one, 'One'],
      [two, 'Two'],
    ] as const) {
      const f = join(d, 'base', 'style.json');
      writeJson(f, { ...readJson(f), name });
    }
    expect(loadStyleRegistry({ stylesDirs: [one, two] }).get('base').style.name).toBe('One');
    const rev = loadStyleRegistry({ stylesDirs: [two, one] });
    expect(rev.get('base').style.name).toBe('Two');
    expect(problem(rev, 'base').dir).toBe(join(one, 'base'));
  });

  test('a missing styles dir is skipped (e.g. ~/.vox/styles not created yet)', () => {
    const reg = loadStyleRegistry({ stylesDirs: [BUILTIN, join(tmp(), 'absent')] });
    expect(reg.list().map((s) => s.id)).toEqual(['base', 'paper']);
    expect(reg.problems()).toEqual([]);
  });

  test('folders without style.json and dot folders are not styles', () => {
    const d = dirWithBase();
    mkdirSync(join(d, 'notes'));
    writeStyle(d, '.hidden', child('hidden', 'base'));
    const reg = loadStyleRegistry({ stylesDirs: [d] });
    expect(reg.list().map((s) => s.id)).toEqual(['base']);
    expect(reg.problems()).toEqual([]);
  });

  test('unknown id fails with STYLE_NOT_FOUND', () => {
    const reg = loadStyleRegistry({ stylesDirs: [BUILTIN] });
    expect(thrown(() => reg.get('vox')).code).toBe('STYLE_NOT_FOUND');
  });
});

describe('extends', () => {
  const reg = () => loadStyleRegistry({ stylesDirs: [BUILTIN, USER] });

  test('chain runs from the style to base', () => {
    expect(reg().get('draft').chain).toEqual(['draft', 'paper', 'base']);
    expect(reg().get('base').chain).toEqual(['base']);
  });

  test('child overrides parent tokens, pacing and imagery field by field', () => {
    const s = reg().get('draft').style;
    expect(s.tokens.colors).toEqual({
      paper: '#f4ecd8',
      ink: '#111111',
      accentSoft: '#ff0066',
      sea: '#3a6f8f',
    });
    expect(s.tokens.fonts.display.family).toBe('Test Display');
    expect(s.tokens.texture).toEqual({ paper: 'assets/textures/paper.jpg', grain: 0.4 });
    expect(s.tokens.motion).toEqual({
      easing: 'power2.out',
      frameHold: 2,
      jitterPx: 1.5,
      entrance: 'pop',
    });
    expect(s.pacing).toEqual({
      beatMs: { min: 1000, target: 2000, max: 4000 },
      speakerRatio: { min: 0.3, max: 0.8 },
    });
    expect(s.imagery).toEqual({
      searchHints: ['vintage photograph'],
      generateSuffix: '',
      cutoutStroke: { color: '#ffffff', widthPx: 6 },
    });
    // own fields are never inherited
    expect(s).toMatchObject({ id: 'draft', status: 'draft', trusted: false, extends: 'paper' });
    expect(s.templates).toEqual(['card']);
  });

  test('captions, overlays and sfx inherit; files resolve in the declaring style', () => {
    const r = reg().get('draft');
    expect(r.style.captions).toEqual({
      default: 'paper/box',
      presets: ['paper/box', 'base/plain'],
    });
    expect(Object.keys(r.style.sfx).sort()).toEqual(['pop', 'tap']);
    expect(r.files.sfx).toEqual({
      pop: join(BUILTIN, 'paper', 'assets/sfx/pop.wav'),
      tap: join(BUILTIN, 'base', 'assets/sfx/tap.wav'),
    });
    expect(r.files.fonts.caption).toBe(join(BUILTIN, 'base', 'assets/fonts/caption.ttf'));
    expect(r.files.texture).toEqual({ paper: join(BUILTIN, 'paper', 'assets/textures/paper.jpg') });
    expect(r.overlays).toEqual([
      {
        name: 'grain',
        default: true,
        styleId: 'base',
        htmlPath: join(BUILTIN, 'base', 'overlays/grain.html'),
      },
    ]);
    expect(Object.keys(r.captionPresets)).toEqual(['paper/box', 'base/plain']);
    expect(r.captionPresets['base/plain']).toMatchObject({
      styleId: 'base',
      case: 'asis',
      htmlPath: join(BUILTIN, 'base', 'captions/plain.html'),
    });
    expect(r.captionPresets['paper/box']?.case).toBe('upper');
  });

  test('the template lookup gives a caption preset by full id (D-93)', () => {
    const lookup = registryTemplateLookup(reg);
    expect(lookup.captionPreset?.('paper/box')).toEqual({ position: { yPct: 70 } });
    expect(lookup.captionPreset?.('base/plain')).toEqual({ position: { yPct: 75 } });
    expect(lookup.captionPreset?.('paper/none')).toBeUndefined();
    expect(lookup.captionPreset?.('nostyle/box')).toBeUndefined();
  });

  test('guide sections: child replaces a section with the same heading, adds new ones', () => {
    expect(reg().get('draft').guide).toBe(
      [
        '# Base guide',
        '',
        'Base preamble.',
        '',
        '## Pacing',
        '',
        'Draft pacing.',
        '',
        '## Templates',
        '',
        'Paper templates.',
        '',
        '## Imagery',
        '',
        'Paper imagery.',
        '',
        '## Voice',
        '',
        'Draft voice.',
        '',
      ].join('\n'),
    );
  });

  test(`a chain of ${MAX_EXTENDS_DEPTH} extends hops loads; one more is rejected`, () => {
    expect(MAX_EXTENDS_DEPTH).toBe(4);
    const d = dirWithBase();
    let parent = 'base';
    for (let i = 1; i <= 5; i++) {
      writeStyle(d, `s${i}`, child(`s${i}`, parent));
      parent = `s${i}`;
    }
    const r = loadStyleRegistry({ stylesDirs: [d] });
    expect(r.get('s4').chain).toEqual(['s4', 's3', 's2', 's1', 'base']);
    const e = thrown(() => r.get('s5'));
    expect(e.code).toBe('STYLE_INVALID');
    expect(e.details?.['reason']).toBe('extends-depth');
    expect(r.list().map((s) => s.id)).toEqual(['base', 's1', 's2', 's3', 's4']);
  });

  test('a cycle is rejected for every style on it and for styles that reach it', () => {
    const d = dirWithBase();
    writeStyle(d, 'a', child('a', 'b'));
    writeStyle(d, 'b', child('b', 'a'));
    writeStyle(d, 'c', child('c', 'a'));
    const r = loadStyleRegistry({ stylesDirs: [d] });
    for (const id of ['a', 'b', 'c']) {
      const e = thrown(() => r.get(id));
      expect(e.code).toBe('STYLE_INVALID');
      expect(e.details?.['reason']).toBe('extends-cycle');
    }
    expect(r.list().map((s) => s.id)).toEqual(['base']);
  });

  test('a missing parent is rejected', () => {
    const d = dirWithBase();
    writeStyle(d, 'orphan', child('orphan', 'nope'));
    const e = thrown(() => loadStyleRegistry({ stylesDirs: [d] }).get('orphan'));
    expect(e.details).toMatchObject({ reason: 'extends-missing', style: 'orphan', parent: 'nope' });
  });

  test('every chain ends in base: a root that is not base, and base with extends, are rejected', () => {
    const d = dirWithBase();
    const root = child('root', undefined, readJson(join(BUILTIN, 'base', 'style.json')));
    writeStyle(d, 'root', { ...root, id: 'root' });
    writeStyle(d, 'kid', child('kid', 'root'));
    const r = loadStyleRegistry({ stylesDirs: [d] });
    expect(thrown(() => r.get('root')).details?.['reason']).toBe('extends-root');
    expect(thrown(() => r.get('kid')).details?.['reason']).toBe('extends-root');

    const d2 = tmp();
    writeStyle(
      d2,
      'other',
      child('other', undefined, readJson(join(BUILTIN, 'base', 'style.json'))),
    );
    const f = join(d2, 'other', 'style.json');
    writeJson(f, { ...readJson(f), id: 'other' });
    cpSync(join(BUILTIN, 'base'), join(d2, 'base'), { recursive: true });
    const b = join(d2, 'base', 'style.json');
    writeJson(b, { ...readJson(b), extends: 'other' });
    expect(
      thrown(() => loadStyleRegistry({ stylesDirs: [d2] }).get('base')).details?.['reason'],
    ).toBe('extends-root');
  });

  test('a child of an invalid style is rejected as parent-invalid', () => {
    const d = dirWithBase();
    writeStyle(d, 'bad', { ...child('bad', 'base'), status: 'nope' });
    writeStyle(d, 'kid', child('kid', 'bad'));
    const r = loadStyleRegistry({ stylesDirs: [d] });
    expect(problem(r, 'bad').error.details?.['reason']).toBe('schema');
    const e = thrown(() => r.get('kid'));
    expect(e.details).toMatchObject({ reason: 'parent-invalid', parent: 'bad' });
    expect((e.cause as VoxError).details?.['reason']).toBe('schema');
  });

  test('merged result must be complete: a root base missing a section is rejected', () => {
    const d = dirWithBase();
    const f = join(d, 'base', 'style.json');
    const json = readJson(f);
    delete json['pacing'];
    writeJson(f, json);
    const e = thrown(() => loadStyleRegistry({ stylesDirs: [d] }).get('base'));
    expect(e.details?.['reason']).toBe('schema');
  });
});

describe('templates through the registry', () => {
  test('template identity names the declaring style, also through a chain', () => {
    const r = loadStyleRegistry({ stylesDirs: [BUILTIN, USER] }).get('draft');
    expect(Object.keys(r.templates).sort()).toEqual([
      'base/crossfade',
      'base/title',
      'draft/card',
      'paper/map',
    ]);
    const map = r.templates['paper/map']!;
    expect(map).toMatchObject({
      id: 'paper/map',
      styleId: 'paper',
      name: 'map',
      kind: 'scene',
      version: '2.0.0',
      dir: join(BUILTIN, 'paper', 'templates/map'),
      htmlPath: join(BUILTIN, 'paper', 'templates/map/template.html'),
      fixtures: [join(BUILTIN, 'paper', 'templates/map/fixtures/lisbon.json')],
    });
    expect(r.templates['base/crossfade']).toMatchObject({ kind: 'transition', blendsShots: true });
  });

  test('S8 (loading): hook trust comes from the declaring style, not the using style', () => {
    const r = loadStyleRegistry({ stylesDirs: [BUILTIN, USER] }).get('draft');
    expect(r.style.trusted).toBe(false);
    expect(r.templates['paper/map']).toMatchObject({
      trusted: true,
      hookPath: join(BUILTIN, 'paper', 'templates/map/build.mjs'),
    });
    expect(r.templates['draft/card']).toMatchObject({
      trusted: false,
      hookPath: join(USER, 'draft', 'templates/card/build.mjs'),
    });
    expect(r.templates['base/title']?.hookPath).toBeUndefined();
  });

  test('registry.template looks up any installed template by full id', () => {
    const reg = loadStyleRegistry({ stylesDirs: [BUILTIN, USER] });
    expect(reg.template('paper/map')?.styleId).toBe('paper');
    expect(reg.template('base/title')?.minEntranceMs).toBe(2000);
    expect(reg.template('paper/title')).toBeUndefined();
    expect(reg.template('nope')).toBeUndefined();
  });

  function withTemplate(mutate: (styleDir: string) => void) {
    const d = dirWithBase();
    mutate(join(d, 'base'));
    return loadStyleRegistry({ stylesDirs: [d] });
  }
  const titleJson = (s: string) => join(s, 'templates/title/template.json');

  test.each([
    ['a missing template.json', (s: string) => rmSync(titleJson(s)), 'file-missing'],
    [
      'a missing template.html',
      (s: string) => rmSync(join(s, 'templates/title/template.html')),
      'file-missing',
    ],
    [
      'a template name that differs from its folder',
      (s: string) => writeJson(titleJson(s), { ...readJson(titleJson(s)), name: 'other' }),
      'template-name',
    ],
    [
      'a transition listed under templates',
      (s: string) => {
        const t = readJson(titleJson(s));
        delete t['minEntranceMs'];
        writeJson(titleJson(s), { ...t, kind: 'transition' });
      },
      'template-kind',
    ],
    [
      'a cue naming an inherited Object property as sfx',
      (s: string) =>
        writeJson(titleJson(s), {
          ...readJson(titleJson(s)),
          sfxCues: [{ name: 'in', atMs: 0, sfx: 'constructor', type: 'cut' }],
        }),
      'sfx-unknown',
    ],
    [
      'a template.json symlinked from outside the style folder',
      (s: string) => {
        const outside = join(s, '..', 'outside.json');
        writeFileSync(outside, readFileSync(titleJson(s)));
        rmSync(titleJson(s));
        symlinkSync(outside, titleJson(s));
      },
      'path',
    ],
    [
      'a dangling build.mjs symlink',
      (s: string) => symlinkSync(join(s, 'nowhere.mjs'), join(s, 'templates/title/build.mjs')),
      'file-missing',
    ],
    [
      'a fixture symlinked from outside the style folder',
      (s: string) => {
        const outside = join(s, '..', 'fixture.json');
        writeFileSync(outside, '{}');
        symlinkSync(outside, join(s, 'templates/title/fixtures/out.json'));
      },
      'path',
    ],
    [
      'a cue naming an sfx the style does not have',
      (s: string) =>
        writeJson(titleJson(s), {
          ...readJson(titleJson(s)),
          sfxCues: [{ name: 'in', atMs: 0, sfx: 'boom', type: 'cut' }],
        }),
      'sfx-unknown',
    ],
    [
      'an invalid variables schema',
      (s: string) =>
        writeJson(titleJson(s), {
          ...readJson(titleJson(s)),
          variables: { type: 'object', properties: { skipEntrance: { type: 'boolean' } } },
        }),
      'schema',
    ],
    ['broken JSON', (s: string) => writeFileSync(titleJson(s), '{ "name": '), 'json'],
  ])('a style with %s is rejected', (_label, mutate, reason) => {
    const reg = withTemplate(mutate);
    const e = thrown(() => reg.get('base'));
    expect(e.code).toBe('STYLE_INVALID');
    expect(e.details?.['reason']).toBe(reason);
    expect(String(e.details?.['file'] ?? '')).toContain('title');
    expect(reg.template('base/title')).toBeUndefined();
  });
});

describe('style files', () => {
  test('folder name must equal the style id', () => {
    const d = dirWithBase();
    writeStyle(d, 'folder', child('other', 'base'));
    expect(
      problem(loadStyleRegistry({ stylesDirs: [d] }), 'folder').error.details?.['reason'],
    ).toBe('id-mismatch');
  });

  test('broken style.json is rejected with reason json and no file text in the message', () => {
    const d = dirWithBase();
    writeStyle(d, 'broken', '{ "id": "broken", SECRET');
    const e = problem(loadStyleRegistry({ stylesDirs: [d] }), 'broken').error;
    expect(e.details?.['reason']).toBe('json');
    expect(e.message).not.toContain('SECRET');
  });

  test.each([
    [
      'a missing font file',
      (s: string) => rmSync(join(s, 'assets/fonts/body.ttf')),
      'file-missing',
    ],
    ['a missing sfx file', (s: string) => rmSync(join(s, 'assets/sfx/tap.wav')), 'file-missing'],
    ['a missing overlay', (s: string) => rmSync(join(s, 'overlays/grain.html')), 'file-missing'],
    [
      'a missing caption preset .json',
      (s: string) => rmSync(join(s, 'captions/plain.json')),
      'file-missing',
    ],
    [
      'a missing caption preset .html',
      (s: string) => rmSync(join(s, 'captions/plain.html')),
      'file-missing',
    ],
    [
      'a caption preset whose name differs from its file',
      (s: string) => {
        const f = join(s, 'captions/plain.json');
        writeJson(f, { ...readJson(f), name: 'fancy' });
      },
      'preset-name',
    ],
    [
      'a font file that is a symlink out of the style folder',
      (s: string) => {
        const outside = join(s, '..', 'outside.ttf');
        writeFileSync(outside, 'x');
        rmSync(join(s, 'assets/fonts/body.ttf'));
        symlinkSync(outside, join(s, 'assets/fonts/body.ttf'));
      },
      'path',
    ],
  ])('%s is rejected', (_label, mutate, reason) => {
    const d = dirWithBase();
    mutate(join(d, 'base'));
    const e = thrown(() => loadStyleRegistry({ stylesDirs: [d] }).get('base'));
    expect(e.code).toBe('STYLE_INVALID');
    expect(e.details?.['reason']).toBe(reason);
  });

  test('S8: a style outside the built-in folder cannot trust itself', () => {
    const user = tmp();
    cpSync(join(USER, 'draft'), join(user, 'draft'), { recursive: true });
    const f = join(user, 'draft', 'style.json');
    writeJson(f, { ...readJson(f), trusted: true });
    const reg = loadStyleRegistry({ stylesDirs: [BUILTIN, user] });
    expect(reg.get('draft').style.trusted).toBe(false);
    expect(reg.get('draft').templates['draft/card']?.trusted).toBe(false);
    expect(reg.list().find((s) => s.id === 'draft')?.trusted).toBe(false);
    // the inherited built-in template keeps its own trust
    expect(reg.get('draft').templates['paper/map']?.trusted).toBe(true);
    // trust recorded outside the folder (phase 06 `vox style trust`) is what counts
    const seen: string[] = [];
    const trusted = loadStyleRegistry({
      stylesDirs: [BUILTIN, user],
      isTrusted: (id, dir) => {
        seen.push(`${id}@${dir}`);
        return id === 'draft';
      },
    });
    expect(trusted.get('draft').templates['draft/card']?.trusted).toBe(true);
    expect(seen).toEqual([`draft@${join(user, 'draft')}`]);
  });

  test('a preview symlinked from outside the style folder is rejected', () => {
    const d = dirWithBase();
    mkdirSync(join(d, 'base', 'previews'));
    writeFileSync(join(d, 'out.jpg'), 'x');
    symlinkSync(join(d, 'out.jpg'), join(d, 'base', 'previews', 'title.jpg'));
    const e = thrown(() => loadStyleRegistry({ stylesDirs: [d] }).get('base'));
    expect(e.details?.['reason']).toBe('path');
  });

  test('a caption preset from a style outside the chain is rejected', () => {
    const d = dirWithBase();
    cpSync(join(BUILTIN, 'paper'), join(d, 'paper'), { recursive: true });
    writeStyle(
      d,
      'kid',
      child('kid', 'base', { captions: { default: 'paper/box', presets: ['paper/box'] } }),
    );
    const e = thrown(() => loadStyleRegistry({ stylesDirs: [d] }).get('kid'));
    expect(e.details).toMatchObject({ reason: 'preset-unknown', preset: 'paper/box' });
  });

  test('list() returns summaries with status, trust and preview thumbnails', () => {
    const list = loadStyleRegistry({ stylesDirs: [BUILTIN, USER] }).list();
    expect(list.find((s) => s.id === 'paper')).toEqual({
      id: 'paper',
      name: 'Paper',
      description: 'Trusted test child of base.',
      version: '0.3.0',
      status: 'active',
      trusted: true,
      source: { type: 'builtin' },
      extends: 'base',
      dir: join(BUILTIN, 'paper'),
      previews: [join(BUILTIN, 'paper', 'previews/map.jpg')],
    });
    expect(list.find((s) => s.id === 'draft')).toMatchObject({ status: 'draft', trusted: false });
  });

  test('two loads of the same folders resolve to equal results', () => {
    const a = loadStyleRegistry({ stylesDirs: [BUILTIN, USER] });
    const b = loadStyleRegistry({ stylesDirs: [BUILTIN, USER] });
    expect(JSON.stringify(b.get('draft'))).toBe(JSON.stringify(a.get('draft')));
  });
});
