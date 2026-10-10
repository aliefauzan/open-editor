import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  TEXT_TOOL_CALL_CORRECTION,
  detectTextToolCall,
  parseToolInput,
  repairToolJson,
} from '../../src/loop/repair.ts';

const ok = (raw: string) => {
  const r = repairToolJson(raw);
  if (!r.ok) throw new Error(`not repaired: ${raw} (${r.error})`);
  return r;
};

describe('repairToolJson', () => {
  it('passes valid JSON through untouched', () => {
    const r = ok('{"a":[1,2,{"b":null}],"c":"x"}');
    expect(r.repaired).toBe(false);
    expect(r.value).toEqual({ a: [1, 2, { b: null }], c: 'x' });
  });

  it.each([
    ['trailing comma in object', '{"a":1,}', { a: 1 }],
    ['trailing comma in array', '{"a":[1,2,]}', { a: [1, 2] }],
    ['trailing comma with space and newline', '{"a":[1,\n 2 , ]\n, }', { a: [1, 2] }],
    ['nested trailing commas', '{"a":{"b":[{"c":1,},],},}', { a: { b: [{ c: 1 }] } }],
    ['truncated object', '{"a":1,"b":2', { a: 1, b: 2 }],
    ['truncated after comma', '{"a":1,', { a: 1 }],
    [
      'truncated nested',
      '{"items":[{"id":"c1","startMs":0},{"id":"c2"',
      {
        items: [{ id: 'c1', startMs: 0 }, { id: 'c2' }],
      },
    ],
    ['truncated inside string', '{"text":"hello wor', { text: 'hello wor' }],
    ['truncated key', '{"a":1,"bb', { a: 1 }],
    ['key without colon', '{"a":1,"b"', { a: 1 }],
    ['key with colon only', '{"a":1,"b":', { a: 1 }],
    ['truncated true', '{"a":tr', { a: true }],
    ['truncated false', '{"a":fal', { a: false }],
    ['truncated null', '{"a":[nu', { a: [null] }],
    ['truncated number fraction', '{"a":1.', { a: 1 }],
    ['truncated number exponent', '{"a":[2,1e', { a: [2, 1] }],
    ['truncated minus', '{"a":-', {}],
    ['truncated escape', '{"a":"x\\', { a: 'x' }],
    ['truncated unicode escape', '{"a":"x\\u00', { a: 'x' }],
    ['code fence', '```json\n{"a":1,}\n```', { a: 1 }],
    ['prose before and after', 'Sure! {"a":1} done.', { a: 1 }],
    ['only an open brace', '{', {}],
    ['array top level', '[1,2,', [1, 2]],
    ['escaped backslash before u12', '{"a":"x\\\\u12', { a: 'x\\u12' }],
    ['brackets in prose before the object', 'See [1] {"a":1,}', { a: 1 }],
    ['a stray brace in prose', 'use } and { then {"a":1}', { a: 1 }],
  ])('repairs %s', (_name, raw, expected) => {
    const r = ok(raw);
    expect(r.value).toEqual(expected);
    expect(r.repaired).toBe(true);
  });

  it('keeps commas and braces inside strings', () => {
    expect(ok('{"t":"a,}] b",}').value).toEqual({ t: 'a,}] b' });
    expect(ok('{"t":"say \\"hi\\", ok",').value).toEqual({ t: 'say "hi", ok' });
  });

  it('fails on unrepairable input', () => {
    expect(repairToolJson('not json at all').ok).toBe(false);
    expect(repairToolJson('').ok).toBe(false);
    expect(repairToolJson('{"a":}').ok).toBe(false);
    expect(repairToolJson('{"a" 1}').ok).toBe(false);
  });

  it('stays fast on hostile input', () => {
    const t = Date.now();
    repairToolJson('"' + '{'.repeat(100_000));
    repairToolJson('\\'.repeat(100_000));
    repairToolJson('{"a":"' + '\\'.repeat(100_000));
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('does not run away on deep nesting', () => {
    const raw = '['.repeat(5000);
    const r = repairToolJson(raw);
    expect(r.ok).toBe(false);
  });
});

describe('parseToolInput', () => {
  const schema = z.strictObject({ id: z.string(), startMs: z.number().int() });

  it('returns the validated value', () => {
    const r = parseToolInput('{"id":"c1","startMs":40,}', schema);
    expect(r).toEqual({ ok: true, value: { id: 'c1', startMs: 40 }, repaired: true });
  });

  it('returns a model-readable message for a zod error', () => {
    const r = parseToolInput('{"id":"c1","startMs":"x"}', schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/startMs/);
  });

  it('returns the parse error when repair fails', () => {
    const r = parseToolInput('nope', schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON/);
  });

  it('treats empty input as an empty object (tools without arguments)', () => {
    const r = parseToolInput('', z.strictObject({}));
    expect(r.ok).toBe(true);
  });
});

describe('detectTextToolCall', () => {
  const tools = ['get_sequence', 'trimItem', 'call_tool'];

  it.each([
    ['json object', '{"name":"trimItem","arguments":{"itemId":"c1"}}', 'trimItem'],
    ['json with tool key', '{"tool":"get_sequence","args":{}}', 'get_sequence'],
    [
      'fenced json',
      'I will do it:\n```json\n{"name":"trimItem","parameters":{"itemId":"c1"}}\n```',
      'trimItem',
    ],
    ['function call syntax', 'Calling get_sequence({"sequenceId":"s1"}) now', 'get_sequence'],
    ['empty call', 'get_sequence()', 'get_sequence'],
    ['tool_call tag', '<tool_call>{"name":"trimItem","arguments":{}}</tool_call>', 'trimItem'],
    ['function tag', '<function=trimItem>{"itemId":"c1"}</function>', 'trimItem'],
    ['python tag', '<|python_tag|>get_sequence(sequenceId="s1")', 'get_sequence'],
    [
      'openai style',
      '{"type":"function","function":{"name":"trimItem","arguments":"{}"}}',
      'trimItem',
    ],
  ])('detects a %s', (_n, text, tool) => {
    const d = detectTextToolCall(text, tools);
    expect(d).not.toBeNull();
    expect(d?.tool).toBe(tool);
  });

  it.each([
    ['plain prose', 'I trimmed the clip as you asked.'],
    ['tool name in prose', 'The get_sequence tool shows the view.'],
    ['unknown tool in json', '{"name":"rm","arguments":{}}'],
    ['unrelated json', '{"name":"Alice","age":3}'],
    ['empty', ''],
  ])('ignores %s', (_n, text) => {
    expect(detectTextToolCall(text, tools)).toBeNull();
  });

  it('stays fast on hostile text (stray quote then many braces, repeated markers)', () => {
    const t = Date.now();
    detectTextToolCall('"' + '{'.repeat(100_000), tools);
    detectTextToolCall('<function='.repeat(50_000), tools);
    detectTextToolCall('<'.repeat(100_000) + ' '.repeat(100_000), tools);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('finds a tool call after a stray quote', () => {
    const d = detectTextToolCall('He said " then {"name":"trimItem","arguments":{}}', tools);
    expect(d?.tool).toBe('trimItem');
  });

  it('detects a marker with no known tool name as unknown', () => {
    const d = detectTextToolCall('<tool_call>{"foo":1}</tool_call>', tools);
    expect(d).toEqual({ kind: 'marker', tool: null });
  });

  it('has one correction message that tells the model to call, not describe', () => {
    expect(TEXT_TOOL_CALL_CORRECTION).toMatch(/call the tool/i);
    expect(TEXT_TOOL_CALL_CORRECTION).toMatch(/do not describe/i);
  });
});
