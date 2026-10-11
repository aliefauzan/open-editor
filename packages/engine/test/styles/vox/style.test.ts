// Phase 07: the real `vox` style loads, every template has at least two valid fixtures, the guide
// names only installed templates (phase 12 picks templates by its keyword rules), and no file of the
// style reaches the network (S9).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadStyleRegistry } from '../../../src/styles/registry.ts';
import { variablesValidator } from '../../../src/styles/schema.ts';
import { REPO_STYLES } from '../../compile/fixture.ts';

const reg = loadStyleRegistry({ stylesDirs: [REPO_STYLES] });
const VOX = join(REPO_STYLES, 'vox');

describe('styles/vox', () => {
  test('loads: 4 scene templates, 2 transitions, 3 caption presets, the paper-grain overlay (default) and film-look', () => {
    expect(reg.problems()).toEqual([]);
    const vox = reg.get('vox');
    const own = Object.values(vox.templates).filter((t) => t.styleId === 'vox');
    expect(own.map((t) => `${t.kind}:${t.id}`).sort()).toEqual([
      'scene:vox/kinetic-serif',
      'scene:vox/map-route',
      'scene:vox/paper-collage',
      'scene:vox/stat',
      'transition:vox/paper-tear',
      'transition:vox/slide-paper',
    ]);
    expect(Object.keys(vox.captionPresets).sort()).toEqual([
      'vox/mono-box',
      'vox/serif-lower',
      'vox/word-reveal',
    ]);
    expect(vox.style.captions.default).toBe('vox/mono-box');
    expect(vox.overlays.map((o) => [o.name, o.default])).toEqual([
      ['paper-grain', true],
      ['film-look', false],
    ]);
  });

  test.each(
    Object.values(reg.get('vox').templates)
      .filter((t) => t.styleId === 'vox')
      .map((t) => [t.id, t] as const),
  )('%s: at least 2 fixtures, all valid; scenes have a longest fixture', (_id, t) => {
    expect(t.fixtures.length).toBeGreaterThanOrEqual(2);
    if (t.kind === 'scene') expect(t.fixtures.some((f) => f.endsWith('longest.json'))).toBe(true);
    const v = variablesValidator(t.variables);
    for (const f of t.fixtures) {
      const vars = JSON.parse(readFileSync(f, 'utf8')) as unknown;
      expect(v(vars), `${f}: ${JSON.stringify(v.errors)}`).toBe(true);
    }
  });

  test('every template accepts bg and declares sfx cues; at most one hero cue each', () => {
    for (const t of Object.values(reg.get('vox').templates).filter((x) => x.styleId === 'vox')) {
      expect(t.sfxCues?.length, t.id).toBeGreaterThan(0);
      expect(t.sfxCues!.filter((c) => c.type === 'hero').length).toBeLessThanOrEqual(1);
      if (t.kind === 'scene') {
        const props = (t.variables as { properties: Record<string, { enum?: string[] }> })
          .properties;
        expect(props['bg']?.enum, t.id).toEqual(['paper', 'dark', 'highlight']);
      }
    }
  });

  test('the guide names every installed template and no v1.1 template', () => {
    const guide = readFileSync(join(VOX, 'guide.md'), 'utf8');
    const named = [...guide.matchAll(/`(vox\/[a-z-]+)`/g)].map((m) => m[1]!);
    const installed = [
      ...Object.keys(reg.get('vox').templates).filter((id) => id.startsWith('vox/')),
      ...Object.keys(reg.get('vox').captionPresets),
    ];
    expect([...new Set(named)].sort()).toEqual([...installed].sort());
    for (const later of ['year-card', 'framed-portrait', 'newspaper', 'stack']) {
      expect(guide).not.toContain(later);
    }
  });

  test('no file of the style names a network URL (the SVG namespace is not fetched)', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(html|mjs|js|json|css)$/.test(n) && !p.includes(`${join('assets', 'geo')}`))
          files.push(p);
      }
    };
    walk(VOX);
    const hits: string[] = [];
    for (const f of files.filter((x) => !x.includes(join('map-route', 'vendor')))) {
      const s = readFileSync(f, 'utf8').replaceAll('http://www.w3.org/2000/svg', '');
      // style.json `sfx.source` and `source.reference` record where a file came from; not fetched
      const t = f.endsWith('style.json') ? '' : s;
      for (const m of t.matchAll(/\b(?:https?|wss?):\/\/[^\s"'`)]+/g)) hits.push(`${f}: ${m[0]}`);
      if (/\bfetch\(|XMLHttpRequest|WebSocket|import\(/.test(t)) hits.push(`${f}: network API`);
    }
    expect(hits).toEqual([]);
  });
});
