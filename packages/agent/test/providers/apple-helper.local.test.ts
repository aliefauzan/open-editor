// Real `vox-apple-llm` build and smoke test (local tier: never on CI, R3/D-16). Builds the Swift
// helper in release mode, checks it against the same zod protocol schemas as the fake, and runs
// one short text request and one schema request when Apple Intelligence is ready, and one image
// description when the model reports vision (macOS 27, D-74).
// Skipped with the reason on a Mac without a macOS 26+ SDK or on another OS.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import {
  encodeAppleRequest,
  parseAppleResponseLine,
  parseAppleStatusLine,
  type AppleResponse,
  type AppleStatus,
} from '../../src/providers/apple-protocol.ts';
import { awkwardRequest, invalidRequests } from '../helpers/apple-cases.ts';
import { runOnce, startSession, type Session } from '../helpers/apple-helper-process.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PKG = join(ROOT, 'native', 'apple-llm');
const FACE = join(ROOT, 'packages', 'engine', 'test', 'fixtures', 'assets', 'faces', 'face-a.jpg');
const BUILD_TIMEOUT = 900_000;

function run(command: string, args: string[]) {
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

const major = (version: string) => Number.parseInt(version.split('.')[0] ?? '', 10);

function skipReason(): string | null {
  if (process.platform !== 'darwin') return `not macOS (${process.platform})`;
  const sdk = run('xcrun', ['--show-sdk-version']);
  if (sdk.code !== 0) return 'no Xcode or command-line tools (xcrun failed)';
  if (!(major(sdk.stdout.trim()) >= 26))
    return `macOS SDK ${sdk.stdout.trim()} is older than 26 (Foundation Models)`;
  return null;
}

const reason = skipReason();
const macosMajor = major(run('sw_vers', ['-productVersion']).stdout.trim());
if (reason) console.warn(`apple-helper.local: skipped: ${reason}`);

describe.skipIf(reason !== null)('vox-apple-llm (real helper, local)', () => {
  let bin = '';
  let status: AppleStatus | null = null;
  let session: Session | null = null;

  beforeAll(() => {
    const build = run('swift', ['build', '-c', 'release', '--package-path', PKG]);
    if (build.code !== 0) throw new Error(`swift build failed:\n${build.stdout}\n${build.stderr}`);
    const binPath = run('swift', [
      'build',
      '-c',
      'release',
      '--package-path',
      PKG,
      '--show-bin-path',
    ]);
    bin = join(binPath.stdout.trim(), 'vox-apple-llm');
  }, BUILD_TIMEOUT);

  afterAll(() => {
    if (session?.isRunning()) session.kill();
  });

  const exchange = async (line: string, timeoutMs = 120_000): Promise<AppleResponse> => {
    session ??= startSession({ command: bin, args: [] });
    session.send(line);
    const out = await session.nextLine(timeoutMs);
    if (out === null) {
      // A late answer would be read by the next test: start a fresh helper instead.
      session.kill();
      session = null;
    }
    expect(out, 'helper sent no line').not.toBeNull();
    const parsed = parseAppleResponseLine(out ?? '');
    if (!parsed.ok) throw new Error(`invalid response line ${out}: ${parsed.error}`);
    return parsed.value;
  };

  test('swift build -c release produces the vox-apple-llm binary', () => {
    expect(existsSync(bin)).toBe(true);
  });

  test('FoundationModels is weak-linked, so the binary starts on macOS 14 and 15', () => {
    const otool = run('otool', ['-l', bin]);
    expect(otool.code).toBe(0);
    const commands = otool.stdout.split(/^Load command \d+$/m);
    const fm = commands.filter((c) => c.includes('FoundationModels.framework'));
    expect(fm).toHaveLength(1);
    expect(fm[0]).toMatch(/cmd LC_LOAD_WEAK_DYLIB/);
    // D-75: MediaIntelligence (`--highlights`, macOS 27) is weak-linked too
    const mi = commands.filter((c) => c.includes('MediaIntelligence.framework'));
    expect(mi).toHaveLength(1);
    expect(mi[0]).toMatch(/cmd LC_LOAD_WEAK_DYLIB/);
  });

  test(
    'the Swift unit tests pass (schema conversion, request parsing, encoding)',
    () => {
      const t = run('swift', ['test', '--package-path', PKG]);
      if (t.code !== 0) throw new Error(`swift test failed:\n${t.stdout}\n${t.stderr}`);
    },
    BUILD_TIMEOUT,
  );

  test('--status prints one valid status line and exits 0', async () => {
    const out = await runOnce({ command: bin, args: [] }, ['--status']);
    expect(out.code).toBe(0);
    expect(out.stdout.trim().split('\n')).toHaveLength(1);
    const parsed = parseAppleStatusLine(out.stdout);
    if (!parsed.ok) throw new Error(`invalid status line ${out.stdout}: ${parsed.error}`);
    status = parsed.value;
    console.info(`vox-apple-llm --status: ${JSON.stringify(status)}`);
    if (Number.isNaN(macosMajor)) return; // sw_vers gave no version: nothing to compare
    if (macosMajor >= 26) expect(status.status).not.toBe('unsupportedOS');
    else expect(status.status).toBe('unsupportedOS');
    expect(typeof status.vision).toBe('boolean');
    if (macosMajor < 27) expect(status.vision).toBe(false);
    expect(status.highlights).toBe(macosMajor >= 27);
  });

  test('an unknown flag exits 2 with usage on stderr', async () => {
    const out = await runOnce({ command: bin, args: [] }, ['--bogus']);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toMatch(/usage/i);
  });

  test('a line that is not JSON gets badRequest, an invalid request gets badRequest with its id', async () => {
    expect(await exchange('not json')).toMatchObject({ error: { code: 'badRequest' } });
    const bad = JSON.stringify({
      id: 'bad',
      system: '',
      messages: [{ role: 'assistant', content: 'x' }],
      maxTokens: 8,
      temperature: 0,
    });
    expect(await exchange(bad)).toMatchObject({ id: 'bad', error: { code: 'badRequest' } });
  });

  test('every shared invalid case gets badRequest with its id, like zod and the fake', async () => {
    for (const [name, value] of invalidRequests) {
      expect(await exchange(JSON.stringify(value)), name).toMatchObject({
        id: 'x',
        error: { code: 'badRequest' },
      });
    }
  });

  test('U+2028, U+2029 and a lone surrogate are not a bad request (one line, valid JSON)', async () => {
    const res = await exchange(JSON.stringify(awkwardRequest));
    expect(res.id).toBe('awkward');
    if ('error' in res) expect(res.error.code).not.toBe('badRequest');
  }, 180_000);

  test('one short text request', async (ctx) => {
    ctx.skip(status?.status !== 'ready', `Apple Intelligence status: ${status?.status}`);
    const res = await exchange(
      encodeAppleRequest({
        id: 't1',
        system: 'You answer with one short sentence.',
        messages: [{ role: 'user', content: 'Name one colour of the sky on a clear day.' }],
        maxTokens: 40,
        temperature: 0,
      }),
    );
    if (!('text' in res)) throw new Error(`expected a text answer, got ${JSON.stringify(res)}`);
    expect(res.id).toBe('t1');
    expect(res.text.trim().length).toBeGreaterThan(0);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
  }, 180_000);

  test('one schema request returns JSON that passes zod (guided generation)', async (ctx) => {
    ctx.skip(status?.status !== 'ready', `Apple Intelligence status: ${status?.status}`);
    const Answer = z.object({
      answer: z.enum(['yes', 'no']),
      count: z.number().int().min(1).max(5),
      words: z.array(z.string()).min(1).max(3),
    });
    const res = await exchange(
      encodeAppleRequest({
        id: 'j1',
        system: 'You fill in structured answers.',
        messages: [
          {
            role: 'user',
            content:
              'Is water wet? Also give a count from 1 to 5 and up to three words about water.',
          },
        ],
        schema: z.toJSONSchema(Answer) as Record<string, unknown>,
        maxTokens: 200,
        temperature: 0,
      }),
    );
    if (!('json' in res)) throw new Error(`expected a JSON answer, got ${JSON.stringify(res)}`);
    expect(res.id).toBe('j1');
    expect(Answer.safeParse(res.json).success).toBe(true);
  }, 180_000);

  test('one image description from a real file (D-74)', async (ctx) => {
    ctx.skip(status?.status !== 'ready', `Apple Intelligence status: ${status?.status}`);
    ctx.skip(status?.vision !== true, 'the model reports no vision (needs macOS 27)');
    const started = Date.now();
    const res = await exchange(
      encodeAppleRequest({
        id: 'img1',
        system: 'Describe video frames for an editor in one short line.',
        messages: [{ role: 'user', content: 'Describe this frame.', images: [FACE] }],
        maxTokens: 120,
        temperature: 0,
      }),
    );
    if (!('text' in res)) throw new Error(`expected a text answer, got ${JSON.stringify(res)}`);
    console.info(`vox-apple-llm image (${String(Date.now() - started)} ms): ${res.text}`);
    expect(res.id).toBe('img1');
    expect(res.text.trim().length).toBeGreaterThan(0);
    expect(res.usage.inputTokens).toBeGreaterThan(0);
  }, 180_000);

  test('an image file that does not exist gets badRequest', async (ctx) => {
    ctx.skip(status?.status !== 'ready', `Apple Intelligence status: ${status?.status}`);
    const res = await exchange(
      encodeAppleRequest({
        id: 'img2',
        system: '',
        messages: [{ role: 'user', content: 'x', images: [join(PKG, 'no-such-image.png')] }],
        maxTokens: 8,
        temperature: 0,
      }),
    );
    expect(res).toMatchObject({
      id: 'img2',
      error: { code: status?.vision === true ? 'badRequest' : 'visionUnavailable' },
    });
  });

  test('when the model is not ready, a request gets `unavailable`', async (ctx) => {
    ctx.skip(status?.status === 'ready', 'model is ready on this Mac (the fake covers this case)');
    const res = await exchange(
      encodeAppleRequest({
        system: '',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 8,
        temperature: 0,
      }),
    );
    expect(res).toMatchObject({ error: { code: 'unavailable' } });
  });

  test('closing stdin ends the helper with exit 0', async () => {
    session ??= startSession({ command: bin, args: [] });
    session.endInput();
    expect((await session.exited).code).toBe(0);
  });
});
