// Phase 06 steps 1 and 5: `vox style new` (rejects built-in and existing ids), template identity
// through a chain, trust recorded outside the style folder (S8, D-23), accept and remove.
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  acceptStyle,
  newStyle,
  openTrustStore,
  removeStyle,
  styleCodeHash,
  trustStyle,
} from '../../src/styles/manage.ts';
import { loadStyleRegistry } from '../../src/styles/registry.ts';
import { KIT, REPO_STYLES } from '../compile/fixture.ts';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'vox-styles-'));
  const user = join(home, 'styles');
  cpSync(join(KIT, 'kit'), join(user, 'kit'), { recursive: true });
  const store = openTrustStore(join(home, 'trust.json'));
  const dirs = [REPO_STYLES, user];
  const reg = () =>
    loadStyleRegistry({ stylesDirs: dirs, isTrusted: (id, dir) => store.isTrusted(id, dir) });
  return { home, user, store, dirs, reg };
}

const code = (e: unknown) => (e as { code?: string }).code;
const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('did not throw');
};

describe('vox style new (step 1)', () => {
  test('rejects a built-in id, an installed user id and a bad id', () => {
    const s = setup();
    const r = s.reg();
    expect(code(thrown(() => newStyle({ stylesDirs: s.dirs, registry: r, id: 'base' })))).toBe(
      'STYLE_DUPLICATE',
    );
    expect(code(thrown(() => newStyle({ stylesDirs: s.dirs, registry: r, id: 'kit' })))).toBe(
      'STYLE_DUPLICATE',
    );
    expect(code(thrown(() => newStyle({ stylesDirs: s.dirs, registry: r, id: 'Bad Id' })))).toBe(
      'VALIDATION',
    );
    expect(
      code(thrown(() => newStyle({ stylesDirs: s.dirs, registry: r, id: 'x', extends: 'nope' }))),
    ).toBe('STYLE_NOT_FOUND');
  });

  test('scaffolds a draft untrusted child that loads; inherited templates keep their identity', () => {
    const s = setup();
    const { dir } = newStyle({ stylesDirs: s.dirs, registry: s.reg(), id: 'mine', extends: 'kit' });
    expect(dir).toBe(join(s.user, 'mine'));
    const st = s.reg().get('mine');
    expect(st.chain).toEqual(['mine', 'kit', 'base']);
    expect(st.style.status).toBe('draft');
    expect(st.style.trusted).toBe(false);
    expect(st.style.source.type).toBe('user');
    // kit/card inherited through mine stays kit/card; base/title stays base/title
    expect(Object.keys(st.templates)).toContain('kit/card');
    expect(Object.keys(st.templates)).toContain('base/title');
    expect(Object.keys(st.templates).some((k) => k.startsWith('mine/'))).toBe(false);
    expect(st.templates['kit/card']!.styleId).toBe('kit');
    // a second `new` with the same id fails
    expect(code(thrown(() => newStyle({ stylesDirs: s.dirs, registry: s.reg(), id: 'mine' })))).toBe(
      'STYLE_DUPLICATE',
    );
  });
});

describe('trust, accept, remove (step 5 round trip)', () => {
  test('a copied folder cannot trust itself; `trust` records it outside; editing code withdraws it', () => {
    const s = setup();
    expect(s.reg().get('kit').style.trusted).toBe(false);
    expect(s.reg().template('kit/card')!.trusted).toBe(false);
    trustStyle(s.dirs, s.store, 'kit');
    const rec = JSON.parse(readFileSync(join(s.home, 'trust.json'), 'utf8')) as {
      styles: Record<string, { hash: string }>;
    };
    expect(rec.styles['kit']!.hash).toBe(styleCodeHash(join(s.user, 'kit')));
    expect(s.reg().get('kit').style.trusted).toBe(true);
    expect(s.reg().template('kit/card')!.trusted).toBe(true);
    // a non-code edit keeps trust; a hook edit withdraws it
    writeFileSync(join(s.user, 'kit', 'guide.md'), '# Kit\n\nEdited.\n');
    expect(s.reg().get('kit').style.trusted).toBe(true);
    writeFileSync(join(s.user, 'kit', 'templates', 'card', 'build.mjs'), 'export {};\n');
    expect(s.reg().get('kit').style.trusted).toBe(false);
  });

  test('built-in styles cannot be trusted, accepted or removed', () => {
    const s = setup();
    expect(code(thrown(() => trustStyle(s.dirs, s.store, 'base')))).toBe('VALIDATION');
    expect(code(thrown(() => acceptStyle(s.dirs, 'base')))).toBe('VALIDATION');
    expect(code(thrown(() => removeStyle(s.dirs, s.reg(), 'base')))).toBe('VALIDATION');
    expect(code(thrown(() => removeStyle(s.dirs, s.reg(), 'nope')))).toBe('STYLE_NOT_FOUND');
  });

  test('new + trust + accept + remove', () => {
    const s = setup();
    newStyle({ stylesDirs: s.dirs, registry: s.reg(), id: 'round', extends: 'base' });
    trustStyle(s.dirs, s.store, 'round');
    expect(s.reg().get('round').style.trusted).toBe(true);
    acceptStyle(s.dirs, 'round');
    expect(s.reg().get('round').style.status).toBe('active');
    // a parent with children cannot be removed
    newStyle({ stylesDirs: s.dirs, registry: s.reg(), id: 'child', extends: 'round' });
    expect(code(thrown(() => removeStyle(s.dirs, s.reg(), 'round')))).toBe('VALIDATION');
    removeStyle(s.dirs, s.reg(), 'child');
    removeStyle(s.dirs, s.reg(), 'round');
    s.store.forget('round');
    expect(existsSync(join(s.user, 'round'))).toBe(false);
    expect(s.reg().list().map((x) => x.id)).not.toContain('round');
    expect(readFileSync(join(s.home, 'trust.json'), 'utf8')).not.toContain('"round"');
  });
});
