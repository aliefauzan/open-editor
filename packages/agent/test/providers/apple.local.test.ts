// `createAppleLanguageModel` against the real `vox-apple-llm` (local tier: never on CI, R3/D-16):
// `--status`, context detection, one text request and one schema request through the AI SDK, and
// the plan/json probe. Skipped with the reason on another OS, without a macOS 26+ SDK, or when
// Apple Intelligence is not ready.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText, Output, streamText } from 'ai';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import {
  APPLE_MODEL_ID,
  appleStatus,
  appleStatusInfo,
  createAppleLanguageModel,
  type AppleLanguageModel,
} from '../../src/providers/apple.ts';
import { detectContext } from '../../src/providers/context.ts';
import { providerEntryFromPreset } from '../../src/providers/presets.ts';
import { probePlan } from '../../src/providers/probe.ts';
import { roleCheck } from '../../src/providers/roles.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PKG = join(ROOT, 'native', 'apple-llm');
const BUILD_TIMEOUT = 900_000;
const REQUEST_TIMEOUT = 180_000;

function run(command: string, args: string[]) {
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const major = (version: string) => Number.parseInt(version.split('.')[0] ?? '', 10);

function sdkSkipReason(): string | null {
  if (process.platform !== 'darwin') return `not macOS (${process.platform})`;
  const sdk = run('xcrun', ['--show-sdk-version']);
  if (sdk.code !== 0) return 'no Xcode or command-line tools (xcrun failed)';
  if (!(major(sdk.stdout.trim()) >= 26))
    return `macOS SDK ${sdk.stdout.trim()} is older than 26 (Foundation Models)`;
  return null;
}

const reason = sdkSkipReason();
if (reason) console.warn(`apple.local: skipped: ${reason}`);

describe.skipIf(reason !== null)('createAppleLanguageModel (real helper, local)', () => {
  let command = '';
  let ready = false;
  let model: AppleLanguageModel | null = null;

  beforeAll(async () => {
    const build = run('swift', ['build', '-c', 'release', '--package-path', PKG]);
    if (build.code !== 0) throw new Error(`swift build failed:\n${build.stdout}\n${build.stderr}`);
    const bin = run('swift', ['build', '-c', 'release', '--package-path', PKG, '--show-bin-path']);
    command = join(bin.stdout.trim(), 'vox-apple-llm');
    const status = await appleStatus({ command });
    ready = appleStatusInfo(status.status).usable;
    if (!ready) console.warn(`apple.local: requests skipped: status ${status.status}`);
    else model = createAppleLanguageModel({ command, timeoutMs: REQUEST_TIMEOUT });
  }, BUILD_TIMEOUT);

  afterAll(() => {
    model?.close();
  });

  test('--status maps to a context size the probe reports', async () => {
    const c = await detectContext(providerEntryFromPreset('apple'), APPLE_MODEL_ID, {
      apple: { command },
    });
    expect(c.source).toBe('apple');
    expect(c.contextTokens).toBeGreaterThan(0);
  });

  test(
    'one text request through generateText and streamText',
    async (ctx) => {
      if (!model) return ctx.skip();
      const r = await generateText({
        model,
        system: 'Answer with one word.',
        prompt: 'What colour is a clear daytime sky?',
        maxOutputTokens: 20,
      });
      expect(r.text.trim().length).toBeGreaterThan(0);
      expect(r.usage.outputTokens).toBeGreaterThan(0);
      const s = streamText({ model, prompt: 'Say hello in one word.', maxOutputTokens: 20 });
      expect((await s.text).trim().length).toBeGreaterThan(0);
    },
    REQUEST_TIMEOUT,
  );

  test(
    'one schema request validates with zod (guided generation)',
    async (ctx) => {
      if (!model) return ctx.skip();
      const schema = z.object({ title: z.string(), beats: z.array(z.int()).min(1).max(5) });
      const r = await generateText({
        model,
        prompt: 'Give a short title for a cooking video and between 1 and 3 beat numbers.',
        output: Output.object({ schema }),
        maxOutputTokens: 200,
      });
      expect(schema.safeParse(r.output).success).toBe(true);
    },
    REQUEST_TIMEOUT,
  );

  test(
    'the plan/json probe decides fast; the editor fails on context (spec: usually fast only)',
    async (ctx) => {
      if (!model) return ctx.skip();
      const plan = await probePlan(model, {
        schema: z.object({ beats: z.array(z.object({ startMs: z.int(), endMs: z.int() })) }),
        prompt: 'Split a 10 second clip (0 to 10000 ms) into two beats.',
      });
      const context = await detectContext(providerEntryFromPreset('apple'), APPLE_MODEL_ID, {
        apple: { command },
      });
      const probe = { plan, context, appleStatus: 'ready' as const };
      const args = { provider: providerEntryFromPreset('apple'), model: APPLE_MODEL_ID, probe };
      console.info(
        `apple.local: plan probe ${plan.status}; context ${String(context.contextTokens)}`,
      );
      expect(roleCheck('fast', { ...args, priceTables: [] }).assignable).toBe(
        plan.status === 'pass',
      );
      const editor = roleCheck('editor', { ...args, priceTables: [] });
      expect(editor.mode).toBe('plan');
      if ((context.contextTokens ?? 0) < 32_000) {
        expect(editor.failures).toContainEqual(expect.objectContaining({ check: 'context' }));
      }
    },
    REQUEST_TIMEOUT,
  );
});
