// Offline fixture project (phase 05 step 10): `scripts/make-offline-project.ts` builds the project with
// no network, the result opens in a fresh engine and compiles, the seeded shots and facetracks are used
// (no `shots` or `facetrack` job runs) and the `auto` clip compiles with tracked keyframes. The draft
// render through the script's CLI entry is `offline-project.slow.test.ts`.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { openEngine } from '../packages/engine/src/api.ts';
import { tempDir } from '../packages/engine/test/helpers/store.ts';
import { makeOfflineProject } from '../scripts/make-offline-project.ts';

const STYLES = join(import.meta.dirname, '..', 'styles');

beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('network used by the offline project')));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('make-offline-project (step 10)', () => {
  test('builds offline, reopens, compiles with seeded shots and facetracks', async () => {
    const projectsDir = join(tempDir('vox-offline-'), 'Projects');
    const e = openEngine({ projectsDir, stylesDirs: [STYLES], config: async () => ({}) });
    const r = await makeOfflineProject(e);
    expect(e.jobs.list(r.projectId).map((j) => j.kind)).toEqual(['ingest']);

    const again = openEngine({ projectsDir, stylesDirs: [STYLES], config: async () => ({}) });
    const p = await again.getProject(r.projectId);
    const m = p.media.find((x) => x.id === r.mediaId)!;
    for (const f of [m.transcriptPath, m.shotsPath, m.facetrackPath]) {
      expect(f).toBeDefined();
      expect(existsSync(join(r.dir, f!))).toBe(true);
    }
    expect(m.transcriptRev).toMatch(/^[0-9a-f]{16}$/);
    const seq = p.sequences.find((s) => s.id === r.sequenceId)!;
    expect(seq.captions?.enabled).toBe(true);
    const clip = seq.videoTracks[0]!.items[0]!;
    expect(clip.type === 'media' && clip.frame?.mode).toBe('auto');

    const html = String(
      (await again.compile(r.projectId, r.sequenceId, { mode: 'render' })).files.get('index.html'),
    );
    // voxPath steps are [position, x, y, scale, duration]; duration > 0 is a tween
    const path = new RegExp(`voxPath\\('${clip.id}', \\[(.*)\\]\\);`).exec(html)?.[1] ?? '';
    const tweens = path.split('], [').filter((s) => !/, 0\]?$/.test(s));
    expect(tweens.length).toBeGreaterThan(1);
    expect(again.jobs.list(r.projectId)).toEqual([]);
  }, 60_000);
});
