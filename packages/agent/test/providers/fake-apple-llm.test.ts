// Protocol tests against the fake Apple helper (fast tier, runs on CI). The same zod schemas
// check the real helper in `apple-helper.local.test.ts`.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  appleStatusValues,
  encodeAppleRequest,
  parseAppleResponseLine,
  parseAppleStatusLine,
  type AppleRequestInput,
  type AppleResponse,
} from '../../src/providers/apple-protocol.ts';
import { awkwardRequest, invalidRequests } from '../helpers/apple-cases.ts';
import {
  runOnce,
  startSession,
  type Command,
  type Session,
} from '../helpers/apple-helper-process.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-apple-llm.mjs', import.meta.url));

const fake = (env: Record<string, string> = {}): Command => ({
  command: process.execPath,
  args: [FAKE],
  env,
});

const request = (over: Partial<AppleRequestInput> = {}): AppleRequestInput => ({
  system: 'Answer briefly.',
  messages: [{ role: 'user', content: 'Say hi.' }],
  maxTokens: 64,
  temperature: 0,
  ...over,
});

const sessions: Session[] = [];
const open = (env: Record<string, string> = {}): Session => {
  const s = startSession(fake(env));
  sessions.push(s);
  return s;
};
afterEach(async () => {
  for (const s of sessions.splice(0)) {
    if (s.isRunning()) s.kill();
    await s.exited;
  }
  vi.unstubAllEnvs();
});

async function answer(s: Session, timeoutMs = 5_000): Promise<AppleResponse> {
  const line = await s.nextLine(timeoutMs);
  expect(line, 'helper sent no line').not.toBeNull();
  const parsed = parseAppleResponseLine(line ?? '');
  if (!parsed.ok) throw new Error(`invalid response line: ${parsed.error}`);
  return parsed.value;
}

describe('fake apple helper: --status', () => {
  test.each(appleStatusValues.map((s) => [s]))(
    'reports %s as one valid status line and exits 0',
    async (status) => {
      const out = await runOnce(fake({ VOX_FAKE_APPLE_STATUS: status }), ['--status']);
      expect(out.code).toBe(0);
      expect(out.stdout.trim().split('\n')).toHaveLength(1);
      expect(parseAppleStatusLine(out.stdout)).toEqual({
        ok: true,
        value: { status, contextSize: 4096 },
      });
    },
  );

  test('reports a scripted context size', async () => {
    const out = await runOnce(fake({ VOX_FAKE_APPLE_CONTEXT: '8192' }), ['--status']);
    expect(parseAppleStatusLine(out.stdout)).toEqual({
      ok: true,
      value: { status: 'ready', contextSize: 8192 },
    });
  });

  test.each([
    ['not JSON', 'nope'],
    ['not an array', '{"text":"a"}'],
    ['an entry of no known kind', '[{"foo":1}]'],
    ['a text entry that is not a string', '[{"text":1}]'],
    ['an error entry with an unknown code', '[{"error":{"code":"boom","message":"x"}}]'],
  ])('a malformed VOX_FAKE_APPLE_ANSWERS (%s) exits 2 at start', async (_name, answers) => {
    const out = await runOnce(fake({ VOX_FAKE_APPLE_ANSWERS: answers }), ['--status']);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain('VOX_FAKE_APPLE_ANSWERS');
  });

  test("the driver does not pass the test runner's own VOX_FAKE_* variables to the helper", async () => {
    vi.stubEnv('VOX_FAKE_APPLE_STATUS', 'notEnabled');
    const out = await runOnce(fake(), ['--status']);
    expect(parseAppleStatusLine(out.stdout)).toMatchObject({
      ok: true,
      value: { status: 'ready' },
    });
  });

  test('an unknown flag exits 2 with usage on stderr', async () => {
    const out = await runOnce(fake(), ['--bogus']);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toMatch(/usage/i);
  });
});

describe('fake apple helper: requests', () => {
  test('a scripted text answer echoes the id and carries usage', async () => {
    const s = open({ VOX_FAKE_APPLE_ANSWERS: JSON.stringify([{ text: 'Hi there.' }]) });
    s.send(encodeAppleRequest(request({ id: 'r1' })));
    const res = await answer(s);
    expect(res).toMatchObject({ id: 'r1', text: 'Hi there.' });
    expect('usage' in res && res.usage.estimated).toBe(true);
    expect('usage' in res && res.usage.outputTokens).toBeGreaterThan(0);
  });

  test('a scripted JSON answer to a schema request', async () => {
    const s = open({ VOX_FAKE_APPLE_ANSWERS: JSON.stringify([{ json: { n: 3 } }]) });
    const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] };
    s.send(encodeAppleRequest(request({ schema })));
    expect(await answer(s)).toMatchObject({ json: { n: 3 } });
  });

  test('answers several requests in order in one process, then exits 0 on end of input', async () => {
    const s = open({
      VOX_FAKE_APPLE_ANSWERS: JSON.stringify([
        { text: 'one' },
        { json: [1, 2] },
        { text: 'three' },
      ]),
    });
    s.send(encodeAppleRequest(request({ id: 'a' })));
    s.send(encodeAppleRequest(request({ id: 'b', schema: { type: 'array' } })));
    s.send(encodeAppleRequest(request({ id: 'c' })));
    expect(await answer(s)).toMatchObject({ id: 'a', text: 'one' });
    expect(await answer(s)).toMatchObject({ id: 'b', json: [1, 2] });
    expect(await answer(s)).toMatchObject({ id: 'c', text: 'three' });
    s.endInput();
    expect((await s.exited).code).toBe(0);
  });

  test('U+2028, U+2029 and a lone surrogate pass through as one line each way', async () => {
    const text = 'a\u2028b\u2029c \udc00';
    const s = open({ VOX_FAKE_APPLE_ANSWERS: JSON.stringify([{ text }]) });
    s.send(JSON.stringify(awkwardRequest));
    expect(await answer(s)).toMatchObject({ id: 'awkward', text });
  });

  test('a scripted answer of the wrong kind for the request gets a generation error', async () => {
    const s = open({ VOX_FAKE_APPLE_ANSWERS: JSON.stringify([{ json: { n: 1 } }, { text: 'x' }]) });
    s.send(encodeAppleRequest(request({ id: 'plain' })));
    expect(await answer(s)).toMatchObject({ id: 'plain', error: { code: 'generation' } });
    s.send(encodeAppleRequest(request({ id: 'schema', schema: { type: 'object' } })));
    expect(await answer(s)).toMatchObject({ id: 'schema', error: { code: 'generation' } });
  });

  test('a scripted error is sent as an error line', async () => {
    const s = open({
      VOX_FAKE_APPLE_ANSWERS: JSON.stringify([
        { error: { code: 'contextOverflow', message: 'Prompt is 5000 tokens, context is 4096.' } },
      ]),
    });
    s.send(encodeAppleRequest(request({ id: 'r9' })));
    expect(await answer(s)).toEqual({
      id: 'r9',
      error: { code: 'contextOverflow', message: 'Prompt is 5000 tokens, context is 4096.' },
    });
  });

  test('with no scripted answer left it sends a generation error', async () => {
    const s = open();
    s.send(encodeAppleRequest(request()));
    expect(await answer(s)).toMatchObject({ error: { code: 'generation' } });
  });

  test.each(appleStatusValues.filter((v) => v !== 'ready').map((v) => [v]))(
    'when the status is %s every request gets `unavailable` naming that status',
    async (status) => {
      const s = open({
        VOX_FAKE_APPLE_STATUS: status,
        VOX_FAKE_APPLE_ANSWERS: JSON.stringify([{ text: 'never sent' }]),
      });
      s.send(encodeAppleRequest(request({ id: 'u' })));
      const res = await answer(s);
      expect(res).toMatchObject({ id: 'u', error: { code: 'unavailable' } });
      expect('error' in res && res.error.message).toContain(status);
    },
  );

  test('a line that is not JSON gets badRequest and the helper keeps serving', async () => {
    const s = open({ VOX_FAKE_APPLE_ANSWERS: JSON.stringify([{ text: 'still here' }]) });
    s.send('this is not json');
    expect(await answer(s)).toMatchObject({ error: { code: 'badRequest' } });
    s.send(encodeAppleRequest(request({ id: 'next' })));
    expect(await answer(s)).toMatchObject({ id: 'next', text: 'still here' });
  });

  test('an invalid request (last turn from the assistant) gets badRequest with its id', async () => {
    const s = open({ VOX_FAKE_APPLE_ANSWERS: JSON.stringify([{ text: 'x' }]) });
    s.send(
      JSON.stringify({
        ...request({ id: 'bad' }),
        messages: [{ role: 'assistant', content: 'x' }],
      }),
    );
    expect(await answer(s)).toMatchObject({ id: 'bad', error: { code: 'badRequest' } });
  });

  test.each(invalidRequests)(
    'the shared invalid case "%s" gets badRequest with its id',
    async (_name, value) => {
      const s = open({ VOX_FAKE_APPLE_ANSWERS: JSON.stringify([{ text: 'x' }]) });
      s.send(JSON.stringify(value));
      expect(await answer(s)).toMatchObject({ id: 'x', error: { code: 'badRequest' } });
    },
  );

  test('a scripted crash exits non-zero with stderr and sends no line', async () => {
    const s = open({
      VOX_FAKE_APPLE_ANSWERS: JSON.stringify([
        { crash: { exitCode: 134, stderr: 'Fatal error: simulated crash' } },
      ]),
    });
    s.send(encodeAppleRequest(request()));
    expect(await s.nextLine(5_000)).toBeNull();
    const exit = await s.exited;
    expect(exit.code).toBe(134);
    expect(exit.stderr).toContain('simulated crash');
    expect(exit.stdout).toBe('');
  });

  test('a scripted hang sends nothing and keeps running until killed (timeout case)', async () => {
    const s = open({ VOX_FAKE_APPLE_ANSWERS: JSON.stringify([{ hang: true }]) });
    s.send(encodeAppleRequest(request()));
    expect(await s.nextLine(300)).toBeNull();
    expect(s.isRunning()).toBe(true);
    s.kill();
    expect((await s.exited).signal).toBe('SIGKILL');
  });

  test('a scripted delay answers late', async () => {
    const s = open({ VOX_FAKE_APPLE_ANSWERS: JSON.stringify([{ text: 'late', delayMs: 200 }]) });
    s.send(encodeAppleRequest(request()));
    expect(await s.nextLine(50)).toBeNull();
    expect(await answer(s)).toMatchObject({ text: 'late' });
  });

  test('scripted usage replaces the estimate', async () => {
    const usage = { inputTokens: 7, outputTokens: 2, estimated: false };
    const s = open({ VOX_FAKE_APPLE_ANSWERS: JSON.stringify([{ text: 'ok', usage }]) });
    s.send(encodeAppleRequest(request()));
    expect(await answer(s)).toMatchObject({ text: 'ok', usage });
  });

  test('records every received request line in the log file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vox-fake-apple-'));
    try {
      const log = join(dir, 'requests.jsonl');
      const s = open({
        VOX_FAKE_APPLE_LOG: log,
        VOX_FAKE_APPLE_ANSWERS: JSON.stringify([{ text: 'a' }, { text: 'b' }]),
      });
      s.send(encodeAppleRequest(request({ id: 'one' })));
      await answer(s);
      s.send(encodeAppleRequest(request({ id: 'two', temperature: 0.5 })));
      await answer(s);
      s.endInput();
      await s.exited;
      const lines = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(lines.map((l) => l.id)).toEqual(['one', 'two']);
      expect(lines[1].temperature).toBe(0.5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('helper driver', () => {
  test('runOnce kills a helper that does not finish in time and rejects', async () => {
    const hang = fake({ VOX_FAKE_APPLE_ANSWERS: JSON.stringify([{ hang: true }]) });
    await expect(runOnce(hang, [], encodeAppleRequest(request()), 300)).rejects.toThrow(
      /did not finish/,
    );
  });

  test('a session whose command cannot start ends with no lines instead of throwing', async () => {
    const s = startSession({ command: '/nonexistent/vox-apple-llm', args: [] });
    sessions.push(s);
    s.send(encodeAppleRequest(request()));
    expect(await s.nextLine(2_000)).toBeNull();
    const exit = await s.exited;
    expect(exit.code).toBeNull();
    expect(exit.stderr).toMatch(/ENOENT/);
  });
});
