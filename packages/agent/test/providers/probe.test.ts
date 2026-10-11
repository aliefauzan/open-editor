// Capability probe against mock models (phase 11 step 10, agent spec "Capability probe"): tools,
// loop, vision, plan/json. Every model is a MockLanguageModelV4; no network.
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
} from '@ai-sdk/provider';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { inflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import {
  PROBE_COLOURS,
  probeLoop,
  probePlan,
  probeTools,
  probeVision,
  solidColourPng,
} from '../../src/providers/probe.ts';
import { CANARY_KEY } from '../helpers/canary.ts';

function result(
  content: LanguageModelV4Content[],
  unified: 'stop' | 'tool-calls' = 'stop',
): LanguageModelV4GenerateResult {
  return {
    content,
    finishReason: { unified, raw: undefined },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    },
    warnings: [],
  };
}
const text = (t: string) => result([{ type: 'text', text: t }]);
let callNo = 0;
const call = (toolName: string, input: unknown) =>
  result(
    [
      {
        type: 'tool-call',
        toolCallId: `c${String(++callNo)}`,
        toolName,
        input: typeof input === 'string' ? input : JSON.stringify(input),
      },
    ],
    'tool-calls',
  );
const failing = () =>
  new MockLanguageModelV4({
    doGenerate: () => {
      throw new APICallError({
        message: `Unauthorized: key ${CANARY_KEY} rejected`,
        url: 'https://openrouter.ai/api/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 401,
        isRetryable: false,
      });
    },
  });

describe('probeTools', () => {
  test('passes when the model calls the tool with valid arguments', async () => {
    const model = new MockLanguageModelV4({ doGenerate: call('record_number', { value: 42 }) });
    expect(await probeTools(model)).toEqual({ status: 'pass' });
    const opts = model.doGenerateCalls[0] as LanguageModelV4CallOptions;
    expect(opts.tools?.map((t) => t.name)).toEqual(['record_number']);
    expect(opts.maxOutputTokens).toBeGreaterThan(0);
  });

  test.each([
    ['a text answer', text('I would call record_number with 42.')],
    ['wrong arguments', call('record_number', { value: 41 })],
    ['invalid arguments', call('record_number', { value: 'forty-two' })],
    ['malformed JSON', call('record_number', '{"value": ')],
    ['an unknown tool', call('other_tool', { value: 42 })],
  ])('fails on %s', async (_, answer) => {
    const r = await probeTools(new MockLanguageModelV4({ doGenerate: answer }));
    expect(r.status).toBe('fail');
  });

  test('a request error is an error result that never carries the key (S19)', async () => {
    const r = await probeTools(failing());
    expect(r).toEqual({ status: 'error', reason: 'request failed (HTTP 401)' });
    expect(JSON.stringify(r)).not.toContain(CANARY_KEY);
  });
});

describe('probeLoop (three chained calls with results fed back)', () => {
  test('passes when the model follows the chain and reports the word', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        call('open_box', { key: 'start' }),
        call('open_box', { key: 'ruby' }),
        call('open_box', { key: 'opal' }),
        text('saffron'),
      ],
    });
    expect(await probeLoop(model)).toEqual({ status: 'pass' });
    // each result is fed back: the 2nd request holds the 1st tool result
    const second = model.doGenerateCalls[1] as LanguageModelV4CallOptions;
    expect(JSON.stringify(second.prompt)).toContain('ruby');
  });

  test('fails when a key is guessed instead of read from the result', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        call('open_box', { key: 'start' }),
        call('open_box', { key: 'opal' }),
        call('open_box', { key: 'ruby' }),
        text('saffron'),
      ],
    });
    expect((await probeLoop(model)).status).toBe('fail');
  });

  test('fails when the final answer lacks the word', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        call('open_box', { key: 'start' }),
        call('open_box', { key: 'ruby' }),
        call('open_box', { key: 'opal' }),
        text('done'),
      ],
    });
    expect((await probeLoop(model)).status).toBe('fail');
  });

  test('fails when the model stops after one call', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [call('open_box', { key: 'start' }), text('saffron')],
    });
    expect((await probeLoop(model)).status).toBe('fail');
  });

  test('a model that never stops calling is cut off and fails', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: () => Promise.resolve(call('open_box', { key: 'start' })),
    });
    expect((await probeLoop(model)).status).toBe('fail');
    expect(model.doGenerateCalls.length).toBeLessThanOrEqual(6);
  });
});

describe('probeVision', () => {
  test('sends one PNG and passes when the answer names its colour', async () => {
    const model = new MockLanguageModelV4({ doGenerate: text('Green.') });
    expect(await probeVision(model, { colour: 'green' })).toEqual({ status: 'pass' });
    const opts = model.doGenerateCalls[0] as LanguageModelV4CallOptions;
    const files = opts.prompt.flatMap((m) =>
      m.role === 'user' ? m.content.filter((p) => p.type === 'file') : [],
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ mediaType: 'image/png' });
  });

  test('fails on the wrong colour or a colour inside another word', async () => {
    expect(
      (await probeVision(new MockLanguageModelV4({ doGenerate: text('Red') }), { colour: 'blue' }))
        .status,
    ).toBe('fail');
    expect(
      (
        await probeVision(new MockLanguageModelV4({ doGenerate: text('bluish-grey') }), {
          colour: 'blue',
        })
      ).status,
    ).toBe('fail');
  });

  test('a model without image input fails with an error result', async () => {
    const r = await probeVision(failing(), { colour: 'red' });
    expect(r.status).toBe('error');
  });

  test('without a colour it picks one of the probe colours at random', async () => {
    const model = new MockLanguageModelV4({ doGenerate: text(`It is ${PROBE_COLOURS[3]}.`) });
    expect(await probeVision(model, { random: () => 0.99 })).toEqual({ status: 'pass' });
  });

  test('solidColourPng is a valid PNG of one colour', () => {
    const png = solidColourPng([255, 0, 0], 8);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const idat = png.indexOf(Buffer.from('IDAT'));
    const len = png.readUInt32BE(idat - 4);
    const raw = inflateSync(png.subarray(idat + 4, idat + 4 + len));
    expect(raw.length).toBe(8 * (1 + 8 * 3));
    expect([...raw.subarray(0, 4)]).toEqual([0, 255, 0, 0]);
  });
});

describe('probePlan (structured output validates with zod)', () => {
  const schema = z.object({
    sequences: z.array(
      z.object({
        sequenceId: z.string(),
        beats: z.array(z.object({ startMs: z.int().min(0), endMs: z.int().min(0) })),
      }),
    ),
  });
  const task = { schema, system: 'You plan clips.', prompt: 'Plan one beat for s1.' };

  test('passes on a valid object and asks for JSON with the schema', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: text(
        JSON.stringify({ sequences: [{ sequenceId: 's1', beats: [{ startMs: 0, endMs: 900 }] }] }),
      ),
    });
    expect(await probePlan(model, task)).toEqual({ status: 'pass' });
    const opts = model.doGenerateCalls[0] as LanguageModelV4CallOptions;
    expect(opts.responseFormat).toMatchObject({ type: 'json', schema: { type: 'object' } });
  });

  test.each([
    ['not JSON', 'Here is the plan: beat at 0'],
    ['the wrong shape', JSON.stringify({ sequences: [{ beats: [{ startMs: -1 }] }] })],
  ])('fails on %s', async (_, answer) => {
    const r = await probePlan(new MockLanguageModelV4({ doGenerate: text(answer) }), task);
    expect(r.status).toBe('fail');
  });

  test('a request error is an error result', async () => {
    expect((await probePlan(failing(), task)).status).toBe('error');
  });
});
