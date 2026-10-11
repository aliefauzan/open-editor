// Step 5 (fast part): the real `base` style loads, and every template fixture validates against its
// template's variables schema. The slow part lints and renders them (base-templates.slow.test.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadStyleRegistry } from '../../src/styles/registry.ts';
import { variablesValidator } from '../../src/styles/schema.ts';

const REPO_STYLES = join(import.meta.dirname, '..', '..', '..', '..', 'styles');
const reg = loadStyleRegistry({ stylesDirs: [REPO_STYLES] });

describe('styles/base (step 5)', () => {
  test('loads without problems: 3 scene templates, 2 transitions, the base/plain preset', () => {
    expect(reg.problems()).toEqual([]);
    const base = reg.get('base');
    expect(Object.keys(base.templates).sort()).toEqual([
      'base/crossfade',
      'base/dip-to-black',
      'base/placeholder',
      'base/text-overlay',
      'base/title',
    ]);
    expect(Object.keys(base.captionPresets)).toEqual(['base/plain']);
    expect(base.templates['base/crossfade']!.blendsShots).toBe(true);
    expect(base.templates['base/dip-to-black']!.blendsShots).toBeUndefined();
  });

  test.each(Object.values(reg.get('base').templates).map((t) => [t.id, t] as const))(
    '%s: every fixture matches the variables schema; scenes have a longest-text fixture',
    (_id, t) => {
      expect(t.fixtures.length).toBeGreaterThan(0);
      if (t.kind === 'scene') expect(t.fixtures.some((f) => f.endsWith('longest.json'))).toBe(true);
      const v = variablesValidator(t.variables);
      for (const f of t.fixtures) {
        const vars = JSON.parse(readFileSync(f, 'utf8')) as unknown;
        expect(v(vars), `${f}: ${JSON.stringify(v.errors)}`).toBe(true);
      }
    },
  );
});
