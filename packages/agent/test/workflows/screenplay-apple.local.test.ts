// Screenplay match with the real on-device embeddings (D-77, local tier: never on CI). The fixture
// set's clips are tagged by the scripted vision model (its pictures are test patterns, so frame
// cards would only say "pattern"); the real helper's `--embed` is the first pass, and the scripted
// ranker counts the scenes that still go to the language model. Skipped without the helper or
// when `--status` reports no `embed`.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { appleStatus, createAppleEmbedder } from '../../src/providers/apple.ts';
import { runWorkflow } from '../../src/workflows/run-workflow.ts';
import {
  rankerModel,
  role,
  screenplayKit,
  tagEntries,
  visionModel,
} from '../helpers/screenplay.ts';
import { REPO } from '../helpers/workflow.ts';

const PKG = join(REPO, 'native', 'apple-llm');

function helper(): string | null {
  const fromEnv = process.env['VOX_APPLE_LLM'];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (process.platform !== 'darwin') return null;
  if (spawnSync('xcrun', ['--show-sdk-version']).status !== 0) return null;
  const build = spawnSync('swift', ['build', '-c', 'release', '--package-path', PKG], {
    encoding: 'utf8',
  });
  if (build.status !== 0) return null;
  const bin = spawnSync(
    'swift',
    ['build', '-c', 'release', '--package-path', PKG, '--show-bin-path'],
    {
      encoding: 'utf8',
    },
  );
  return join(bin.stdout.trim(), 'vox-apple-llm');
}

describe('screenplay match with on-device embeddings (D-77, local)', () => {
  let command: string | null = null;
  let skip = '';

  beforeAll(async () => {
    command = helper();
    if (!command) {
      skip = 'no Apple helper (not macOS, or no Xcode)';
      return;
    }
    const s = await appleStatus({ command });
    if (s.embed !== true) skip = 'the helper reports no embed';
  }, 900_000);

  test('the right clip in every scene with fewer ranking calls than scenes', async (ctx) => {
    if (skip) ctx.skip(skip);
    const kit = await screenplayKit();
    await kit.load();
    const vision = visionModel(tagEntries(kit.dir));
    const ranker = rankerModel();
    kit.deps.models = { editor: role(ranker.model), vision: role(vision.model, { vision: true }) };
    kit.deps.embed = createAppleEmbedder({ command: command! });
    const started = Date.now();
    const r = await runWorkflow(kit.deps, {
      projectId: kit.projectId,
      workflow: 'screenplay',
      message: 'match each scene to the right clip',
      mode: 'tools',
    });
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(r.screenplay).toMatchObject({ scenes: 6, matched: 6, placeholders: 0 });
    const expected = tagEntries(kit.dir);
    const p = await kit.engine.getProject(kit.projectId);
    const seq = p.sequences.find((s) => s.id === r.sequenceIds[0])!;
    const got = seq.videoTracks
      .find((t) => t.id === 'V1')!
      .items.map((it) => (it.type === 'media' ? it.mediaId : it.type));
    const want = (
      JSON.parse(readFileSync(join(kit.dir, 'expected.json'), 'utf8')) as { file: string }[]
    ).map((e) => kit.ids.get(e.file));
    expect(got).toEqual(want);
    console.info(
      `screenplay + real --embed: ${String(ranker.prompts.length)} of ${String(expected.length)} scenes sent to the language model (before: 6), ${String(Date.now() - started)} ms; ${r.screenplay!.notes.find((n) => n.startsWith('On-device')) ?? ''}`,
    );
    expect(ranker.prompts.length).toBeLessThan(6);
  }, 300_000);
});
