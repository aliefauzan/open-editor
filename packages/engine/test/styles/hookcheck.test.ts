// Phase 06 step 3: hook purity. A static check rejects clock, randomness and network APIs and imports
// that are bare or leave the style folder; a determinism check runs each hook twice with the same seed
// and compares the output bytes. Trust (S8) is the security boundary, not this check.
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { checkHookDeterminism, checkHookSource } from '../../src/styles/hookcheck.ts';
import type { TemplateDef } from '../../src/styles/registry.ts';

const STYLE = join(import.meta.dirname, '..', 'fixtures', 'styles', 'tooling', 'hooks');
const hook = (name: string) => join(STYLE, name, 'build.mjs');
const rules = (name: string) => checkHookSource(STYLE, hook(name)).map((f) => f.message);

const def = (name: string, trusted = true) =>
  ({ id: `hooks/${name}`, styleId: 'hooks', hookPath: hook(name), trusted }) as TemplateDef;

describe('hook static check (step 3)', () => {
  test('a pure hook with a vendored relative import passes; comments are ignored', () => {
    expect(checkHookSource(STYLE, hook('pure'))).toEqual([]);
  });

  test('clock and randomness APIs fail, each named', () => {
    const m = rules('clock');
    expect(m.some((x) => x.includes('Date'))).toBe(true);
    expect(m.some((x) => x.includes('Math.random'))).toBe(true);
    expect(m.some((x) => x.includes('performance.now'))).toBe(true);
    expect(checkHookSource(STYLE, hook('clock')).every((f) => f.rule === 'hook-source')).toBe(true);
  });

  test('network modules, fetch and process.hrtime fail', () => {
    const f = checkHookSource(STYLE, hook('net'));
    expect(f.find((x) => x.rule === 'hook-import')?.message).toContain('node:http');
    expect(f.some((x) => x.rule === 'hook-source' && x.message.includes('fetch'))).toBe(true);
    expect(f.some((x) => x.rule === 'hook-source' && x.message.includes('process.hrtime'))).toBe(
      true,
    );
  });

  test('a bare import, a path leaving the style folder and a dynamic import fail', () => {
    const bare = checkHookSource(STYLE, hook('bare'));
    expect(bare).toHaveLength(1);
    expect(bare[0]).toMatchObject({ rule: 'hook-import' });
    expect(bare[0]!.message).toContain('d3-geo');
    const out = checkHookSource(STYLE, hook('outside'));
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toContain('outside the style folder');
    expect(checkHookSource(STYLE, hook('dynamic'))[0]!.message).toContain('dynamic import');
  });
});

describe('hook determinism (step 3)', () => {
  const fixtures = [{ name: 'one', vars: { title: 'a' } }];

  test('the same seed gives the same bytes for a pure hook', async () => {
    expect(await checkHookDeterminism(def('pure'), STYLE, fixtures)).toEqual([]);
  });

  test('state kept between calls is caught', async () => {
    const f = await checkHookDeterminism(def('counter'), STYLE, fixtures);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: 'hook-determinism', fixture: 'one' });
  });

  test('an untrusted hook is never run', async () => {
    await expect(checkHookDeterminism(def('counter', false), STYLE, fixtures)).rejects.toMatchObject(
      { code: 'HOOK_UNTRUSTED' },
    );
  });
});
