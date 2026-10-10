// Step 8b (D-12): NO_HANDLES against the real `base` registry. base/crossfade blends the two shots
// and needs source beyond the cut; base/dip-to-black covers the cut and does not.
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openEngine, type ApplyResult } from '../../src/api.ts';
import { tempDir } from '../helpers/store.ts';
import { media, REPO_STYLES } from './fixture.ts';

const err = (r: ApplyResult) => r.results.find((x) => x.status === 'failed')?.error;

describe('NO_HANDLES with the real registry (step 8b)', () => {
  test('crossfade on a cut without handles fails; dip-to-black on the same cut passes', async () => {
    const e = openEngine({
      projectsDir: join(tempDir('vox-handles-'), 'Projects'),
      stylesDirs: [REPO_STYLES],
    });
    const p = await e.createProject('handles');
    const run = (op: unknown) => e.applyOp(p.id, op as never, { actor: 'cli' });
    await run({ op: 'addSequence', args: { name: 'Main', id: 'seq_main' } });
    // m_a is 4 s long and used to its very end; m_b starts at its first frame
    await run({ op: 'addMedia', args: { media: media('m_a', { durationMs: 4000 }) } });
    await run({ op: 'addMedia', args: { media: media('m_b', { durationMs: 4000 }) } });
    const place = (mediaId: string, startMs: number, inMs: number, durationMs: number) =>
      run({
        op: 'placeClip',
        args: { sequenceId: 'seq_main', trackId: 'V1', mediaId, startMs, inMs, durationMs },
      });
    expect((await place('m_a', 0, 2000, 2000)).results[0]).toMatchObject({ status: 'succeeded' });
    const placed = await place('m_b', 2000, 0, 2000);
    const itemId = (placed.results[0]!.report as { itemIds: string[] }).itemIds[0]!;
    const transition = (template: string) =>
      run({
        op: 'setTransition',
        args: { sequenceId: 'seq_main', itemId, transition: { template, durationMs: 500 } },
      });
    expect(err(await transition('base/crossfade'))).toMatchObject({
      code: 'NO_HANDLES',
      details: { template: 'base/crossfade' },
    });
    const ok = await transition('base/dip-to-black');
    expect(ok.results[0]).toMatchObject({ status: 'succeeded' });
  });
});
