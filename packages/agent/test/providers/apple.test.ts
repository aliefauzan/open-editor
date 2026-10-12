// Apple on-device provider against the fake helper (phase 11 step 12, D-22): text, schema output,
// every `--status` value, crash, timeout, restart. The real helper: apple.local.test.ts.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText, Output, streamText, tool } from 'ai';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  appleStatus,
  appleStatusInfo,
  createAppleLanguageModel,
  type AppleLanguageModel,
  type AppleModelOptions,
} from '../../src/providers/apple.ts';
import { appleStatusValues } from '../../src/providers/apple-protocol.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-apple-llm.mjs', import.meta.url));
const RESTARTS = fileURLToPath(new URL('../fixtures/fake-apple-llm-restarts.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'vox-apple-provider-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const file = (name: string) => join(dir, `${String(++n)}-${name}`);

const fake = (env: Record<string, string> = {}, extra: Partial<AppleModelOptions> = {}) => ({
  command: process.execPath,
  args: [FAKE],
  env,
  ...extra,
});
const answers = (list: unknown[]) => ({ VOX_FAKE_APPLE_ANSWERS: JSON.stringify(list) });

const models: AppleLanguageModel[] = [];
function model(opts: AppleModelOptions): AppleLanguageModel {
  const m = createAppleLanguageModel(opts);
  models.push(m);
  return m;
}
afterEach(() => {
  for (const m of models.splice(0)) m.close();
});

const loggedRequests = (path: string): Record<string, unknown>[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('appleStatus (--status)', () => {
  test.each(appleStatusValues)('reports %s and the context size', async (status) => {
    const s = await appleStatus(
      fake({ VOX_FAKE_APPLE_STATUS: status, VOX_FAKE_APPLE_CONTEXT: '8192' }),
    );
    expect(s).toEqual({ status, contextSize: 8192 });
  });

  test('reports vision when the helper sends it (D-74); an older helper sends none', async () => {
    expect(await appleStatus(fake({ VOX_FAKE_APPLE_VISION: '1' }))).toEqual({
      status: 'ready',
      contextSize: 4096,
      vision: true,
    });
    expect((await appleStatus(fake({ VOX_FAKE_APPLE_VISION: '0' }))).vision).toBe(false);
    expect((await appleStatus(fake())).vision).toBeUndefined();
  });

  test('maps each status to usable or a hint', () => {
    expect(appleStatusInfo('ready')).toEqual({ usable: true, hint: '' });
    for (const s of appleStatusValues.filter((v) => v !== 'ready')) {
      const info = appleStatusInfo(s);
      expect(info.usable).toBe(false);
      expect(info.hint.length).toBeGreaterThan(10);
    }
    expect(appleStatusInfo('notEnabled').hint).toMatch(/Apple Intelligence/);
    expect(appleStatusInfo('unsupportedOS').hint).toMatch(/macOS 26/);
  });

  test('a missing helper is APPLE_UNAVAILABLE', async () => {
    await expect(appleStatus({ command: join(dir, 'no-such-helper') })).rejects.toMatchObject({
      code: 'APPLE_UNAVAILABLE',
    });
  });

  test('a helper that fails --status is APPLE_UNAVAILABLE', async () => {
    await expect(appleStatus(fake({ VOX_FAKE_APPLE_STATUS: 'bogus' }))).rejects.toMatchObject({
      code: 'APPLE_UNAVAILABLE',
    });
  });
});

describe('Apple LanguageModelV4 over the fake helper', () => {
  test('text: system, messages, maxTokens and temperature go to the helper; usage comes back', async () => {
    const log = file('log');
    const m = model(fake({ ...answers([{ text: 'Hello there.' }]), VOX_FAKE_APPLE_LOG: log }));
    const r = await generateText({
      model: m,
      system: 'Be brief.',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello.' },
        { role: 'user', content: [{ type: 'text', text: 'Again' }] },
      ],
      maxOutputTokens: 100,
      temperature: 0.5,
    });
    expect(r.text).toBe('Hello there.');
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(r.usage.outputTokens).toBe(Math.ceil('Hello there.'.length / 4));
    expect(r.finishReason).toBe('stop');
    expect(r.providerMetadata).toEqual({ apple: { estimatedUsage: true } });
    const [req] = loggedRequests(log);
    expect(req).toMatchObject({
      system: 'Be brief.',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello.' },
        { role: 'user', content: 'Again' },
      ],
      maxTokens: 100,
      temperature: 0.5,
    });
    expect(req).not.toHaveProperty('schema');
  });

  test('defaults: maxTokens 2000, temperature 0, empty system', async () => {
    const log = file('log');
    const m = model(fake({ ...answers([{ text: 'ok' }]), VOX_FAKE_APPLE_LOG: log }));
    await generateText({ model: m, prompt: 'x' });
    expect(loggedRequests(log)[0]).toMatchObject({ system: '', maxTokens: 2000, temperature: 0 });
  });

  test('reported usage is used as is', async () => {
    const m = model(
      fake(
        answers([{ text: 'ok', usage: { inputTokens: 10, outputTokens: 3, estimated: false } }]),
      ),
    );
    const r = await generateText({ model: m, prompt: 'x' });
    expect(r.usage).toMatchObject({ inputTokens: 10, outputTokens: 3, totalTokens: 13 });
    expect(r.providerMetadata).toEqual({ apple: { estimatedUsage: false } });
  });

  test('schema output: the JSON Schema goes to the helper and the answer passes zod', async () => {
    const log = file('log');
    const schema = z.object({
      beats: z.array(z.object({ startMs: z.int().min(0), kind: z.enum(['speaker', 'scene']) })),
    });
    const json = { beats: [{ startMs: 0, kind: 'speaker' }] };
    const m = model(fake({ ...answers([{ json }]), VOX_FAKE_APPLE_LOG: log }));
    const r = await generateText({ model: m, prompt: 'plan', output: Output.object({ schema }) });
    expect(r.output).toEqual(json);
    const [req] = loggedRequests(log);
    expect(req?.['schema']).toMatchObject({
      type: 'object',
      properties: { beats: { type: 'array' } },
    });
  });

  test('streaming yields the same text', async () => {
    const m = model(fake(answers([{ text: 'streamed answer' }])));
    const r = streamText({ model: m, prompt: 'x' });
    expect(await r.text).toBe('streamed answer');
    expect((await r.usage).outputTokens).toBeGreaterThan(0);
  });

  test('two concurrent requests are answered in order on one process', async () => {
    const log = file('log');
    const m = model(
      fake({
        ...answers([{ text: 'first', delayMs: 100 }, { text: 'second' }]),
        VOX_FAKE_APPLE_LOG: log,
      }),
    );
    const [a, b] = await Promise.all([
      generateText({ model: m, prompt: 'one' }),
      generateText({ model: m, prompt: 'two' }),
    ]);
    expect([a.text, b.text]).toEqual(['first', 'second']);
    expect(
      loggedRequests(log).map((r) => (r['messages'] as { content: string }[])[0]?.content),
    ).toEqual(['one', 'two']);
  });

  test.each(appleStatusValues.filter((s) => s !== 'ready'))(
    'status %s: a request fails with APPLE_UNAVAILABLE and the status hint',
    async (status) => {
      const m = model(fake({ VOX_FAKE_APPLE_STATUS: status }));
      const err = await generateText({ model: m, prompt: 'x', maxRetries: 0 }).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ code: 'APPLE_UNAVAILABLE', hint: appleStatusInfo(status).hint });
    },
  );

  test.each([
    ['contextOverflow', 'CONTEXT_OVERFLOW', undefined],
    ['guardrail', 'APPLE_FAILED', 'guardrail'],
    ['generation', 'APPLE_FAILED', 'generation'],
    ['badRequest', 'APPLE_FAILED', 'badRequest'],
  ] as const)('helper error %s → %s', async (code, voxCode, reason) => {
    const m = model(fake(answers([{ error: { code, message: 'nope' } }, { text: 'after' }])));
    const err = await generateText({ model: m, prompt: 'x', maxRetries: 0 }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: voxCode });
    if (reason) expect(err).toMatchObject({ details: { reason } });
    // the helper keeps serving after an error answer
    expect((await generateText({ model: m, prompt: 'y' })).text).toBe('after');
  });

  test('a crash fails the request with the stderr tail, and the next request restarts the helper', async () => {
    const spawns = file('spawns');
    const m = model({
      command: process.execPath,
      args: [RESTARTS],
      env: {
        VOX_FAKE_APPLE_SPAWNS: spawns,
        VOX_FAKE_APPLE_SCRIPTS: JSON.stringify([
          [{ crash: { exitCode: 3, stderr: 'model exploded' } }],
          [{ text: 'back' }],
        ]),
      },
    });
    const err = await generateText({ model: m, prompt: 'x', maxRetries: 0 }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'APPLE_FAILED', details: { reason: 'crash', exitCode: 3 } });
    expect(String((err as Error).cause)).toContain('model exploded');
    expect((await generateText({ model: m, prompt: 'y' })).text).toBe('back');
    expect(readFileSync(spawns, 'utf8')).toBe('2');
  });

  test('a timeout kills the helper; the next request starts a fresh one', async () => {
    const spawns = file('spawns');
    const m = model({
      command: process.execPath,
      args: [RESTARTS],
      timeoutMs: 400,
      env: {
        VOX_FAKE_APPLE_SPAWNS: spawns,
        VOX_FAKE_APPLE_SCRIPTS: JSON.stringify([[{ hang: true }], [{ text: 'fresh' }]]),
      },
    });
    // Only the request timer is faked: the 400 ms pass when the test says, however long a fresh
    // helper takes to start on a loaded machine. `until` polls with setImmediate, which stays real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const until = async (cond: () => boolean, ms = 10_000) => {
        const t0 = Date.now();
        while (!cond()) {
          if (Date.now() - t0 > ms) throw new Error('timed out');
          await new Promise((r) => setImmediate(r));
        }
      };
      let err: unknown;
      let settled = false;
      const first = generateText({ model: m, prompt: 'x', maxRetries: 0 })
        .catch((e: unknown) => (err = e))
        .finally(() => (settled = true));
      // the request is out and the helper is up (it counts its spawn first thing)
      const spawned = () => (existsSync(spawns) ? readFileSync(spawns, 'utf8') : '');
      await until(() => vi.getTimerCount() === 1 && m.pid() !== undefined && spawned() === '1');
      const pid = m.pid()!;
      vi.advanceTimersByTime(399);
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      expect(settled).toBe(false);
      expect(isAlive(pid)).toBe(true);
      vi.advanceTimersByTime(1);
      await first;
      expect(err).toMatchObject({ code: 'APPLE_FAILED', details: { reason: 'timeout' } });
      expect(m.pid()).toBeUndefined();
      await until(() => !isAlive(pid));
      // the next request starts a fresh helper; no time passes, so it cannot time out
      expect((await generateText({ model: m, prompt: 'y' })).text).toBe('fresh');
      expect(readFileSync(spawns, 'utf8')).toBe('2');
    } finally {
      vi.useRealTimers();
    }
  });

  test('an abort kills the helper and rejects', async () => {
    const m = model(fake(answers([{ hang: true }])));
    const ctrl = new AbortController();
    const p = generateText({ model: m, prompt: 'x', abortSignal: ctrl.signal, maxRetries: 0 });
    setTimeout(() => ctrl.abort(), 200);
    await expect(p).rejects.toThrow();
    const pid = m.pid();
    expect(pid === undefined || !isAlive(pid)).toBe(true);
  });

  test('a missing helper fails the request with APPLE_UNAVAILABLE', async () => {
    const m = model({ command: join(dir, 'no-such-helper') });
    await expect(generateText({ model: m, prompt: 'x', maxRetries: 0 })).rejects.toMatchObject({
      code: 'APPLE_UNAVAILABLE',
    });
  });

  test('the helper gets a minimal environment (no keys from the parent)', async () => {
    const envlog = file('env');
    process.env['VOX_TEST_SECRET_FOR_APPLE'] = 'sk-should-not-leak';
    try {
      const m = model({
        command: process.execPath,
        args: [RESTARTS],
        env: { VOX_FAKE_APPLE_ENVLOG: envlog, VOX_FAKE_APPLE_SCRIPTS: '[[{"text":"ok"}]]' },
      });
      await generateText({ model: m, prompt: 'x' });
    } finally {
      delete process.env['VOX_TEST_SECRET_FOR_APPLE'];
    }
    const names = readFileSync(envlog, 'utf8').split('\n');
    expect(names).not.toContain('VOX_TEST_SECRET_FOR_APPLE');
    expect(
      names.every((k) => /^(HOME|TMPDIR|LANG|LC_ALL|PATH|VOX_FAKE_APPLE_\w+|__CF\w*)$/.test(k)),
    ).toBe(true);
  });

  test('tools are refused: the helper has no tool calls (plan mode only)', async () => {
    const m = model(fake(answers([{ text: 'x' }])));
    await expect(
      generateText({
        model: m,
        prompt: 'x',
        maxRetries: 0,
        tools: { t: tool({ inputSchema: z.object({}) }) },
      }),
    ).rejects.toMatchObject({ name: 'AI_UnsupportedFunctionalityError' });
  });

  test('a file that is not an image is refused', async () => {
    const m = model(fake(answers([{ text: 'x' }])));
    await expect(
      generateText({
        model: m,
        maxRetries: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'file', mediaType: 'application/pdf', data: new Uint8Array([1, 2, 3]) },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ name: 'AI_UnsupportedFunctionalityError' });
  });

  test('image input on a model without vision is APPLE_UNAVAILABLE naming macOS 27 (D-74)', async () => {
    const m = model(fake(answers([{ text: 'x' }])));
    await expect(
      generateText({
        model: m,
        maxRetries: 0,
        messages: [
          {
            role: 'user',
            content: [{ type: 'file', mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) }],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'APPLE_UNAVAILABLE',
      message: expect.stringMatching(/cannot see images.*macOS 27/),
      details: { status: 'noVision' },
    });
  });

  test('images go to the helper as private temp files that are deleted after the answer (D-74)', async () => {
    const log = file('images.log');
    const m = model(
      fake({
        VOX_FAKE_APPLE_VISION: '1',
        VOX_FAKE_APPLE_LOG: log,
        ...answers([{ text: 'a red frame' }]),
      }),
    );
    const r = await generateText({
      model: m,
      maxRetries: 0,
      system: 'describe',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe both.' },
            { type: 'file', mediaType: 'image/png', data: new Uint8Array([137, 80, 78, 71]) },
            {
              type: 'file',
              mediaType: 'image/jpeg',
              data: Buffer.from([255, 216, 255]).toString('base64'),
            },
          ],
        },
      ],
    });
    expect(r.text).toBe('a red frame');
    const [req] = loggedRequests(log);
    const messages = req!['messages'] as { role: string; content: string; images?: string[] }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe('Describe both.');
    const paths = messages[0]!.images!;
    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/vox-apple-img-[^/]+\/0-0\.png$/);
    expect(paths[1]).toMatch(/vox-apple-img-[^/]+\/0-1\.jpg$/);
    // the fake answers badRequest when a file is not readable, so both existed during the call
    for (const p of paths) expect(existsSync(p)).toBe(false);
    expect(existsSync(join(paths[0]!, '..'))).toBe(false);
  });

  test('the image temp dir is deleted when the helper fails too', async () => {
    const log = file('images-fail.log');
    const m = model(
      fake({
        VOX_FAKE_APPLE_VISION: '1',
        VOX_FAKE_APPLE_LOG: log,
        ...answers([{ error: { code: 'generation', message: 'boom' } }]),
      }),
    );
    await expect(
      generateText({
        model: m,
        maxRetries: 0,
        messages: [
          {
            role: 'user',
            content: [{ type: 'file', mediaType: 'image/png', data: new Uint8Array([1]) }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'APPLE_FAILED' });
    const [req] = loggedRequests(log);
    const path = (req!['messages'] as { images: string[] }[])[0]!.images[0]!;
    expect(existsSync(join(path, '..'))).toBe(false);
  });

  test('more than 16 images, or images in an assistant message, are refused before the helper runs', async () => {
    const log = file('images-refused.log');
    const m = model(fake({ VOX_FAKE_APPLE_VISION: '1', VOX_FAKE_APPLE_LOG: log }));
    const img = { type: 'file' as const, mediaType: 'image/png', data: new Uint8Array([1]) };
    await expect(
      generateText({
        model: m,
        maxRetries: 0,
        messages: [{ role: 'user', content: Array.from({ length: 17 }, () => img) }],
      }),
    ).rejects.toMatchObject({ name: 'AI_InvalidPromptError' });
    await expect(
      generateText({
        model: m,
        maxRetries: 0,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'file', mediaType: 'image/png', data: new Uint8Array([1]) }],
          },
          { role: 'user', content: 'and?' },
        ],
      }),
    ).rejects.toMatchObject({ name: 'AI_UnsupportedFunctionalityError' });
    expect(existsSync(log)).toBe(false);
  });

  test('a prompt that does not end with a user message is refused', async () => {
    const m = model(fake(answers([{ text: 'x' }])));
    await expect(
      generateText({
        model: m,
        maxRetries: 0,
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
        ],
      }),
    ).rejects.toMatchObject({ name: 'AI_InvalidPromptError' });
  });

  test('unsupported settings come back as warnings', async () => {
    const m = model(fake(answers([{ text: 'x' }])));
    const r = await generateText({ model: m, prompt: 'x', topP: 0.5, seed: 1 });
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'unsupported', feature: 'topP' }),
        expect.objectContaining({ type: 'unsupported', feature: 'seed' }),
      ]),
    );
  });

  test('close() stops the helper', async () => {
    const m = model(fake(answers([{ text: 'x' }])));
    await generateText({ model: m, prompt: 'x' });
    const pid = m.pid();
    expect(pid !== undefined && isAlive(pid)).toBe(true);
    m.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(pid as number)).toBe(false);
  });
});
