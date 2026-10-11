// Agent done-when 6 (phase 12): with Apple Intelligence on, the on-device model fills the `fast`
// role in a clipper run (it scores the quick-clip candidates) and the run passes the checkpoints.
// Local tier (never on CI): skipped with the helper's `--status` reason when the model is not ready.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readRunRecord } from '../../src/loop/record.ts';
import {
  APPLE_MODEL_ID,
  appleStatus,
  appleStatusInfo,
  createAppleLanguageModel,
} from '../../src/providers/apple.ts';
import { runWorkflow } from '../../src/workflows/run-workflow.ts';
import { toolsStylist } from '../helpers/stylists.ts';
import { dynamicModel, FIXTURE_VIDEO, REPO, role, workflowKit } from '../helpers/workflow.ts';

const PKG = join(REPO, 'native', 'apple-llm');

function helper(): string | null {
  const fromEnv = process.env['VOX_APPLE_LLM'];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
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

describe('clipper with fast = apple (done-when 6, local)', () => {
  let command: string | null = null;
  let skip = '';
  let model: ReturnType<typeof createAppleLanguageModel> | undefined;

  beforeAll(async () => {
    command = helper();
    if (!command) {
      skip = 'no Apple helper (no Xcode with the macOS 26 SDK)';
      return;
    }
    const s = await appleStatus({ command });
    if (!appleStatusInfo(s.status).usable) skip = `Apple model status: ${s.status}`;
    else model = createAppleLanguageModel({ command, timeoutMs: 180_000 });
  }, 900_000);

  afterAll(() => model?.close());

  test('the on-device model scores the candidates and every checkpoint is met', async (ctx) => {
    if (!model) {
      console.warn(`apple-fast.local: skipped: ${skip}`);
      ctx.skip();
      return;
    }
    const kit = await workflowKit();
    kit.deps.models = {
      editor: role(dynamicModel(toolsStylist()).model),
      fast: role(model as never, {
        provider: { type: 'apple', label: 'Apple' },
        modelId: APPLE_MODEL_ID,
        contextTokens: 8_192,
        price: { free: true },
        maxOutputTokens: 2_000,
      }),
    };
    const r = await runWorkflow(kit.deps, {
      projectId: kit.projectId,
      workflow: 'clipper',
      message: `make 3 vox clips from ${FIXTURE_VIDEO}`,
      mode: 'tools',
      count: 3,
      minMs: 4000,
      maxMs: 8000,
      tighten: 'all',
    });
    const quick = readRunRecord(r.run.record.path).find(
      (l) => l.type === 'tool' && l['tool'] === 'quickClips',
    )!['result'] as { scorer: string; scorerError?: { message: string } };
    console.warn(
      `apple-fast.local: scorer ${quick.scorer}${quick.scorerError ? ` (${quick.scorerError.message})` : ''}`,
    );
    expect(quick.scorerError).toBeUndefined();
    expect(quick.scorer).toBe('llm');
    expect(r.done.status, r.done.summary).toBe('completed');
    expect(r.checkpoints.filter((c) => c.status !== 'met')).toEqual([]);
  }, 600_000);
});
