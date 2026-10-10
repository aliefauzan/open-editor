import { describe, expect, test } from 'vitest';
import {
  AppleRequest,
  appleErrorCodes,
  appleStatusValues,
  JsonLineSplitter,
  encodeAppleRequest,
  parseAppleResponseLine,
  parseAppleStatusLine,
  type AppleRequestInput,
} from '../../src/providers/apple-protocol.ts';
import { awkwardRequest, invalidRequests } from '../helpers/apple-cases.ts';

const minimal: AppleRequestInput = {
  system: 'You write short answers.',
  messages: [{ role: 'user', content: 'Say hi.' }],
  maxTokens: 64,
  temperature: 0.2,
};

describe('apple protocol: request', () => {
  test('accepts a minimal text request and a request with a JSON schema and an id', () => {
    expect(AppleRequest.safeParse(minimal).success).toBe(true);
    const withSchema = {
      ...minimal,
      id: 'r1',
      schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
    };
    expect(AppleRequest.safeParse(withSchema).success).toBe(true);
  });

  test('accepts earlier assistant turns when the last message is from the user', () => {
    const turns = {
      ...minimal,
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    };
    expect(AppleRequest.safeParse(turns).success).toBe(true);
  });

  test.each([
    ['no messages', { ...minimal, messages: [] }],
    [
      'last message from the assistant',
      { ...minimal, messages: [{ role: 'assistant', content: 'x' }] },
    ],
    ['a system role inside messages', { ...minimal, messages: [{ role: 'system', content: 'x' }] }],
    ['maxTokens 0', { ...minimal, maxTokens: 0 }],
    ['fractional maxTokens', { ...minimal, maxTokens: 1.5 }],
    ['temperature above 2', { ...minimal, temperature: 2.5 }],
    ['negative temperature', { ...minimal, temperature: -0.1 }],
    ['missing system', { messages: minimal.messages, maxTokens: 8, temperature: 0 }],
    ['a schema that is not an object', { ...minimal, schema: 'string' }],
    ['an unknown field', { ...minimal, tools: [] }],
    ['an empty id', { ...minimal, id: '' }],
    ['a numeric id', { ...minimal, id: 1 }],
    ['a request that is not an object', [minimal]],
  ])('rejects %s', (_name, value) => {
    expect(AppleRequest.safeParse(value).success).toBe(false);
  });

  test('encodes one request as exactly one JSON line, even with newlines in the content', () => {
    const line = encodeAppleRequest({
      ...minimal,
      messages: [{ role: 'user', content: 'line one\nline two\r\n' }],
    });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toMatch(/[\r\n]/);
    expect(JSON.parse(line).messages[0].content).toBe('line one\nline two\r\n');
  });

  test('escapes U+2028 and U+2029, so a line splitter that also breaks on them still sees one line', () => {
    const line = encodeAppleRequest(awkwardRequest);
    expect(line.slice(0, -1)).not.toMatch(/[\n\r\u2028\u2029]/);
    expect(JSON.parse(line)).toEqual(awkwardRequest);
  });

  test('refuses to encode an invalid request', () => {
    expect(() => encodeAppleRequest({ ...minimal, maxTokens: -1 })).toThrow();
  });
  test.each(invalidRequests)('rejects the shared invalid case: %s', (_name, value) => {
    expect(AppleRequest.safeParse(value).success).toBe(false);
  });
});

describe('apple protocol: response', () => {
  const usage = { inputTokens: 12, outputTokens: 3, estimated: true };

  test('parses a text answer, a JSON answer and an error', () => {
    expect(parseAppleResponseLine(JSON.stringify({ id: 'r1', text: 'hi', usage }))).toEqual({
      ok: true,
      value: { id: 'r1', text: 'hi', usage },
    });
    const json = parseAppleResponseLine(JSON.stringify({ json: { n: 3 }, usage }));
    expect(json).toEqual({ ok: true, value: { json: { n: 3 }, usage } });
    const err = parseAppleResponseLine(
      JSON.stringify({ id: 'r2', error: { code: 'contextOverflow', message: 'too long' } }),
    );
    expect(err).toEqual({
      ok: true,
      value: { id: 'r2', error: { code: 'contextOverflow', message: 'too long' } },
    });
  });

  test('a JSON answer may be null, an array or a scalar', () => {
    for (const json of [null, [1, 2], 'x', 4, false]) {
      expect(parseAppleResponseLine(JSON.stringify({ json, usage })).ok).toBe(true);
    }
  });

  test.each([
    ['not JSON', 'hello'],
    ['text and json together', JSON.stringify({ text: 'a', json: 1, usage })],
    ['text without usage', JSON.stringify({ text: 'a' })],
    ['negative token counts', JSON.stringify({ text: 'a', usage: { ...usage, inputTokens: -1 } })],
    ['an unknown error code', JSON.stringify({ error: { code: 'boom', message: 'x' } })],
    ['an empty object', '{}'],
  ])('rejects %s', (_name, line) => {
    const result = parseAppleResponseLine(line);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  test('error codes are the five the helper can send', () => {
    expect([...appleErrorCodes]).toEqual([
      'badRequest',
      'unavailable',
      'contextOverflow',
      'guardrail',
      'generation',
    ]);
  });
});

describe('apple protocol: --status', () => {
  test('status values are exactly the five in the agent spec', () => {
    expect([...appleStatusValues]).toEqual([
      'ready',
      'notEnabled',
      'notEligible',
      'modelNotReady',
      'unsupportedOS',
    ]);
  });

  test.each(appleStatusValues.map((s) => [s]))(
    'parses status %s with its context size',
    (status) => {
      expect(parseAppleStatusLine(JSON.stringify({ status, contextSize: 4096 }))).toEqual({
        ok: true,
        value: { status, contextSize: 4096 },
      });
    },
  );

  test.each([
    [
      "the framework's raw name `available`",
      JSON.stringify({ status: 'available', contextSize: 4096 }),
    ],
    ['a missing context size', JSON.stringify({ status: 'ready' })],
    ['a zero context size', JSON.stringify({ status: 'ready', contextSize: 0 })],
    ['not JSON', 'ready'],
  ])('rejects %s', (_name, line) => {
    expect(parseAppleStatusLine(line).ok).toBe(false);
  });

  test('tolerates surrounding whitespace and a trailing newline', () => {
    expect(parseAppleStatusLine(' {"status":"ready","contextSize":4096}\n').ok).toBe(true);
  });
});

describe('apple protocol: line splitting', () => {
  test('splits on \\n only, across chunks, keeping U+2028/U+2029 and dropping a trailing \\r', () => {
    const split = new JsonLineSplitter();
    expect(split.push('a\u2028b\u2029c\n{"x"')).toEqual(['a\u2028b\u2029c']);
    expect(split.push(':1}\r\n\nrest')).toEqual(['{"x":1}', '']);
    expect(split.end()).toBe('rest');
    expect(split.end()).toBeNull();
  });
});
