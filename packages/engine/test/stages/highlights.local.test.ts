// Video highlights with the real `vox-apple-llm` (local tier, macOS 27 only; D-75): builds the
// Swift helper, ingests the 20 s talking-head fixture and runs the `highlights` job on its proxy.
// Asserts a highlight range inside the video and the key frame inside it, not exact numbers.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openEngine, type HighlightsJobResult } from '../../src/api.ts';
import type { JobInfo } from '../../src/jobs.ts';
import { REPO_STYLES } from '../export/project.ts';
import { tempDir } from '../helpers/store.ts';

const repo = new URL('../../../../', import.meta.url).pathname;
const PKG = join(repo, 'native', 'apple-llm');
const VIDEO = join(repo, 'packages/engine/test/fixtures/assets/media/talking-head-20s.mp4');

function skipReason(): string | null {
  if (process.platform !== 'darwin') return `not macOS (${process.platform})`;
  const v = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout ?? '';
  if (!(Number.parseInt(v, 10) >= 27)) return `macOS ${v.trim()} has no MediaIntelligence`;
  const sdk = spawnSync('xcrun', ['--show-sdk-version'], { encoding: 'utf8' }).stdout ?? '';
  if (!(Number.parseInt(sdk, 10) >= 27)) return `macOS SDK ${sdk.trim()} is older than 27`;
  return null;
}
const reason = skipReason();
if (reason) console.warn(`highlights.local: skipped: ${reason}`);

describe.skipIf(reason !== null)('highlights (real helper, local)', () => {
  test('the talking-head fixture gets a highlight range and a key frame inside the video', async () => {
    const build = spawnSync('swift', ['build', '-c', 'release', '--package-path', PKG], {
      encoding: 'utf8',
    });
    if (build.status !== 0) throw new Error(`swift build failed:\n${build.stderr}`);
    const e = openEngine({
      projectsDir: join(tempDir('vox-hl-local-'), 'Projects'),
      stylesDirs: [REPO_STYLES],
      config: async () => ({}),
      appleHelper: { command: join(PKG, '.build', 'release', 'vox-apple-llm') },
    });
    const p = await e.createProject('highlights');
    const ing = (await e.jobs.wait(
      e.jobs.start('ingest', { projectId: p.id, inputs: [VIDEO], actor: 'cli' }),
    )) as JobInfo<{ media: { mediaId: string }[] }>;
    expect(ing.status, JSON.stringify(ing.error)).toBe('done');
    const mediaId = ing.result!.media[0]!.mediaId;
    const t0 = Date.now();
    const job = (await e.jobs.wait(
      e.jobs.start('highlights', { projectId: p.id, mediaId, actor: 'cli' }),
    )) as JobInfo<HighlightsJobResult>;
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    const r = job.result!;
    if (!r.available) throw new Error(`not available: ${r.reason}`);
    console.info(`highlights.local: ${Date.now() - t0} ms, ${JSON.stringify(r)}`);
    const m = (await e.getProject(p.id)).media.find((x) => x.id === mediaId)!;
    const { readFile } = await import('node:fs/promises');
    const h = JSON.parse(await readFile(join(e.projectsDir, p.id, r.highlightsPath), 'utf8')) as {
      highlights: { startMs: number; endMs: number }[];
      levels: unknown[];
    };
    expect(h.highlights.length).toBeGreaterThan(0);
    for (const x of h.highlights) {
      expect(x.startMs).toBeGreaterThanOrEqual(0);
      expect(x.endMs).toBeGreaterThan(x.startMs);
      expect(x.endMs).toBeLessThanOrEqual(m.durationMs! + 500);
    }
    expect(h.levels.length).toBeGreaterThan(0);
    expect(r.keyFrameMs).not.toBeNull();
    expect(r.keyFrameMs!).toBeLessThanOrEqual(m.durationMs!);
  }, 600_000);
});
