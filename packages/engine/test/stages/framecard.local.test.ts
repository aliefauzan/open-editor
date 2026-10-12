// Frame cards through the engine with the real Python tool and Apple Vision (local tier, macOS
// only; D-73): an ingested face image gets a card, and the second call is served from the cache.
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openEngine, resolveToolPaths } from '../../src/api.ts';
import type { JobInfo } from '../../src/jobs.ts';
import { tempDir } from '../helpers/store.ts';
import { templates } from '../helpers/templates.ts';

const repo = new URL('../../../../', import.meta.url).pathname;
const FACE = `${repo}packages/engine/test/fixtures/assets/faces/face-a.jpg`;

describe.skipIf(process.platform !== 'darwin')('frameCards (local, Apple Vision)', () => {
  test('a face image: people, one face; the repeat call is cached', async () => {
    const tools = resolveToolPaths({
      toolsDir: tempDir('vox-cards-tools-'),
      env: process.env,
      pyProject: `${repo}py`,
    });
    const e = openEngine({
      projectsDir: join(tempDir('vox-cards-'), 'Projects'),
      stylesDirs: [],
      templates,
      tools,
      config: async () => ({}),
    });
    const p = await e.createProject('cards');
    const ing = (await e.jobs.wait(
      e.jobs.start('ingest', { projectId: p.id, inputs: [FACE], actor: 'cli' }),
    )) as JobInfo<{ media: { mediaId: string }[] }>;
    const mediaId = ing.result!.media[0]!.mediaId;
    const paths = await e.mediaFrames(p.id, mediaId, [0]);
    const [first] = await e.frameCards(p.id, paths);
    expect(first).toMatchObject({ cached: false, faces: { count: 1 } });
    expect(first && 'labels' in first && first.labels.map((l) => l.label)).toContain('people');
    const [again] = await e.frameCards(p.id, paths);
    expect(again).toMatchObject({ cached: true, faces: { count: 1 } });
  }, 120_000);
});
