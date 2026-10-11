// Phase 03 step 4 + 16: the engine uses the real style registry for scene variables (replacing
// phase 02's fixture lookup), exposes styles / geo, and fills the compact view's captions.
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openEngine, type ApplyResult } from '../../src/api.ts';
import { tempDir } from '../helpers/store.ts';

const REPO_STYLES = join(import.meta.dirname, '..', '..', '..', '..', 'styles');
const KIT = join(import.meta.dirname, '..', 'fixtures', 'styles', 'kit');

const engine = () =>
  openEngine({
    projectsDir: join(tempDir('vox-wiring-'), 'Projects'),
    stylesDirs: [REPO_STYLES, KIT],
  });

const err = (r: ApplyResult) => r.results.find((x) => x.status === 'failed')?.error;

async function withSequence() {
  const e = engine();
  const p = await e.createProject('demo');
  await e.applyOp(
    p.id,
    { op: 'addSequence', args: { name: 'Main', id: 'seq_main', styleId: 'kit' } },
    { actor: 'cli' },
  );
  const scene = (template: string, variables: unknown, startMs = 0) =>
    e.applyOp(
      p.id,
      {
        op: 'addScene',
        args: { sequenceId: 'seq_main', trackId: 'V1', startMs, template, variables },
      } as never,
      { actor: 'cli' },
    );
  return { e, p, scene };
}

describe('scene variables through the real registry (step 4)', () => {
  test('addScene validates against base/title from the real styles folder', async () => {
    const { scene } = await withSequence();
    expect(err(await scene('base/title', { title: 'x'.repeat(81) }))).toMatchObject({
      code: 'VARIABLES_INVALID',
    });
    expect(err(await scene('base/title', { title: 'Hi', extra: 1 }))).toMatchObject({
      code: 'VARIABLES_INVALID',
    });
    expect(err(await scene('base/nope', { title: 'Hi' }))).toMatchObject({
      code: 'TEMPLATE_UNKNOWN',
    });
    const ok = await scene('base/title', { title: 'Hi' });
    expect(ok.results[0]).toMatchObject({ status: 'succeeded' });
  });

  test('updateScene rejects invalid variables', async () => {
    const { e, p, scene } = await withSequence();
    const r = await scene('base/text-overlay', { text: 'hello', position: 'top', align: 'left' });
    const itemId = (r.results[0]!.report as { itemIds: string[] }).itemIds[0]!;
    const bad = await e.applyOp(
      p.id,
      {
        op: 'updateScene',
        args: { sequenceId: 'seq_main', itemId, variables: { text: 'x', position: 'left' } },
      } as never,
      { actor: 'cli' },
    );
    expect(err(bad)).toMatchObject({ code: 'VARIABLES_INVALID' });
  });

  test('a nested stack panel is validated against its own template (depth 1)', async () => {
    const { scene } = await withSequence();
    const panel = (label: string) => ({ template: 'kit/swatch', variables: { label } });
    expect(
      err(await scene('kit/stack', { panels: [panel('one'), panel('x'.repeat(21))] })),
    ).toMatchObject({ code: 'VARIABLES_INVALID' });
    expect(
      err(
        await scene('kit/stack', {
          panels: [panel('one'), { template: 'base/title', variables: { title: 5 } }],
        }),
      ),
    ).toMatchObject({ code: 'VARIABLES_INVALID' });
    const ok = await scene('kit/stack', { panels: [panel('one'), panel('two')] });
    expect(ok.results[0]).toMatchObject({ status: 'succeeded' });
  });
});

describe('engine.styles and engine.geo', () => {
  test('lists the installed styles; vox is the default once installed (phase 07)', () => {
    const e = engine();
    expect(e.styles.list().map((s) => s.id)).toEqual(['base', 'kit', 'kitdraft', 'vox']);
    expect(e.styles.defaultId()).toBe('vox');
    expect(e.styles.get('kit').chain).toEqual(['kit', 'base']);
    expect(e.styles.problems()).toEqual([]);
  });

  test('geo.search("lisbon") returns name + lat/lon offline (step 16)', () => {
    const e = engine();
    const [first] = e.geo.search('lisbon');
    expect(first).toMatchObject({ name: 'Lisbon', iso2: 'PT' });
    expect(first!.lat).toBeCloseTo(38.7, 0);
    expect(first!.lon).toBeCloseTo(-9.1, 0);
    expect(() => e.geo.search('  ')).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
  });
});
