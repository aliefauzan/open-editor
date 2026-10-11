// Phase 07 GATE 3 round 2: compositions that inline a style asset as a data URL (the emphasis font
// subset, the film grain tile) carry the exact bytes of the file named in their marker.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
// @ts-expect-error plain ESM script without types
import { dataUrl, inlineFiles } from '../../../../../scripts/sync-vox-inline.mjs';

const VOX = join(import.meta.dirname, '..', '..', '..', '..', '..', 'styles', 'vox');
const files = (inlineFiles as (dir: string) => string[])(VOX);
const toUrl = dataUrl as (rel: string, dir: string) => string;

describe('styles/vox inlined assets', () => {
  test('word-reveal and film-look inline their assets', () => {
    const rel = files.map((f) => f.slice(VOX.length + 1));
    expect(rel).toEqual(
      expect.arrayContaining(['captions/word-reveal.html', 'overlays/film-look.html']),
    );
  });

  test.each(files.map((f) => [f.slice(VOX.length + 1), f] as const))(
    '%s carries the current bytes (run node scripts/sync-vox-inline.mjs)',
    (_rel, f) => {
      const src = readFileSync(f, 'utf8');
      const marks = [...src.matchAll(/\/\* vox:inline (\S+) \*\/\n[^\n]*?url\('(data:[^']*)'/g)];
      expect(marks.length).toBeGreaterThan(0);
      for (const m of marks) expect(m[2]).toBe(toUrl(m[1]!, VOX));
    },
  );
});
