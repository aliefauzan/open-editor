// Step 14 (fast part): a layers build (`compile` with `layers`) keeps only the chosen scene,
// transition, overlay and caption layers, over a transparent background, with no media clips.
import { describe, expect, test } from 'vitest';
import { build, mainProject } from './fixture.ts';

describe('compile layers option (step 14)', () => {
  test('only the chosen layers, transparent, no media clips or their tweens', async () => {
    const b = await build(mainProject(), {
      mode: 'render',
      layers: ['it_o1', 'it_v2-tx', 'captions'],
    });
    const index = b.files.get('index.html') as string;
    expect(index).toContain('background: transparent');
    expect(index).not.toContain('#000000');
    expect(index).not.toContain('<video');
    expect(index).not.toContain('<img');
    expect(index).not.toContain("byId('it_i1')");
    expect(index).toContain('id="it_o1"');
    expect(index).toContain('id="it_v2-tx"');
    expect(index).toContain('id="captions"');
    expect(index).not.toContain('id="it_t1"');
    expect([...b.files.keys()].filter((f) => f.startsWith('scenes/')).sort()).toEqual([
      'scenes/captions.html',
      'scenes/it_o1.html',
      'scenes/it_v2-tx.html',
    ]);
    expect([...b.links.keys()].filter((f) => f.startsWith('media/'))).toEqual([]);
  });

  test('unknown layers and preview builds are rejected', async () => {
    await expect(
      build(mainProject(), { mode: 'render', layers: ['it_t1', 'it_nope', 'it_v1'] }),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringContaining('it_nope, it_v1'),
    });
    await expect(
      build(mainProject(), { mode: 'preview', layers: ['it_t1'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
