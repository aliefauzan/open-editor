// Capability probe, the parts that need no engine tool (agent spec "Capability probe", phase 11
// step 10): tools, loop, vision and plan/json. Each check sends a small request to the model and
// judges the answer in code. Results never carry provider error text (it can echo a key, S19).
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { APICallError, generateText, Output, stepCountIs, tool } from 'ai';
import { crc32, deflateSync } from 'node:zlib';
import { z } from 'zod';

export type CheckResult =
  | { status: 'pass' }
  /** The model answered, but not well enough. */
  | { status: 'fail'; reason: string }
  /** The request itself failed (key, network, unsupported input); the role cannot use the model. */
  | { status: 'error'; reason: string };

export interface ProbeOptions {
  abortSignal?: AbortSignal;
  /** Per-request output cap (default 1,000 tokens), so a probe stays cheap. */
  maxOutputTokens?: number;
}

const DEFAULT_MAX_OUTPUT = 1_000;
const PASS: CheckResult = { status: 'pass' };
const fail = (reason: string): CheckResult => ({ status: 'fail', reason });

/** A short, key-free description of why a request failed. */
export function errorSummary(err: unknown): string {
  if (APICallError.isInstance(err)) {
    return err.statusCode === undefined
      ? 'request failed'
      : `request failed (HTTP ${String(err.statusCode)})`;
  }
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const functionality = (err as { functionality?: unknown }).functionality;
    if (typeof functionality === 'string') return `unsupported: ${functionality}`;
    if (typeof code === 'string' && /^[A-Z_]+$/.test(code)) return code;
    return err.name;
  }
  return 'request failed';
}

const errorResult = (err: unknown): CheckResult => ({ status: 'error', reason: errorSummary(err) });

const common = (opts: ProbeOptions) => ({
  maxRetries: 1,
  maxOutputTokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
  ...(opts.abortSignal && { abortSignal: opts.abortSignal }),
});

/** **tools**: one request that must call one tool with valid arguments. */
export async function probeTools(
  model: LanguageModelV4,
  opts: ProbeOptions = {},
): Promise<CheckResult> {
  try {
    const r = await generateText({
      model,
      ...common(opts),
      system: 'You are being tested for tool use. Answer only by calling a tool.',
      prompt: 'Call the record_number tool with value 42.',
      tools: {
        record_number: tool({
          description: 'Records one integer.',
          inputSchema: z.object({ value: z.int() }),
        }),
      },
      stopWhen: stepCountIs(1),
    });
    const ok = r.toolCalls.some(
      (c) =>
        c.toolName === 'record_number' &&
        c.invalid !== true &&
        (c.input as { value?: unknown }).value === 42,
    );
    return ok ? PASS : fail('no valid record_number call with value 42');
  } catch (err) {
    return errorResult(err);
  }
}

const LOOP_CHAIN: Readonly<Record<string, { nextKey: string } | { word: string }>> = {
  start: { nextKey: 'ruby' },
  ruby: { nextKey: 'opal' },
  opal: { word: 'saffron' },
};
const LOOP_KEYS = ['start', 'ruby', 'opal'];
const LOOP_MAX_STEPS = 6;

/** **loop**: three chained tool calls, each result fed back (decides tools vs plan mode). */
export async function probeLoop(
  model: LanguageModelV4,
  opts: ProbeOptions = {},
): Promise<CheckResult> {
  const keys: string[] = [];
  try {
    const r = await generateText({
      model,
      ...common(opts),
      system: 'You are being tested for multi-step tool use.',
      prompt:
        'Call open_box with key "start". Each result gives the next key; call open_box with it. ' +
        'When a result has a word instead of a key, reply with only that word.',
      tools: {
        open_box: tool({
          description: 'Opens a box with a key and returns the next key or a word.',
          inputSchema: z.object({ key: z.string() }),
          execute: ({ key }) => {
            keys.push(key);
            return Promise.resolve(LOOP_CHAIN[key] ?? { error: 'wrong key' });
          },
        }),
      },
      stopWhen: stepCountIs(LOOP_MAX_STEPS),
    });
    if (keys.join() !== LOOP_KEYS.join()) {
      return fail(
        `calls were ${keys.length === 0 ? 'none' : keys.join(' → ')}, expected start → ruby → opal`,
      );
    }
    return /\bsaffron\b/i.test(r.text) ? PASS : fail('the final answer did not give the word');
  } catch (err) {
    return errorResult(err);
  }
}

export const PROBE_COLOURS = ['red', 'green', 'blue', 'yellow'] as const;
export type ProbeColour = (typeof PROBE_COLOURS)[number];
const RGB: Readonly<Record<ProbeColour, readonly [number, number, number]>> = {
  red: [220, 20, 20],
  green: [20, 170, 40],
  blue: [20, 60, 220],
  yellow: [245, 215, 0],
};

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** A square PNG filled with one RGB colour (8-bit truecolour, no filter). */
export function solidColourPng(rgb: readonly [number, number, number], size = 64): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** **vision**: one solid-colour image; the answer must name its colour as a word. */
export async function probeVision(
  model: LanguageModelV4,
  opts: ProbeOptions & { colour?: ProbeColour; random?: () => number } = {},
): Promise<CheckResult> {
  const pick = Math.floor((opts.random ?? Math.random)() * PROBE_COLOURS.length);
  const colour = opts.colour ?? PROBE_COLOURS[Math.min(pick, PROBE_COLOURS.length - 1)] ?? 'red';
  try {
    const r = await generateText({
      model,
      ...common(opts),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'What is the dominant colour of this image? Answer with one word.',
            },
            { type: 'file', mediaType: 'image/png', data: solidColourPng(RGB[colour]) },
          ],
        },
      ],
    });
    const named = new RegExp(`(^|[^\\p{L}-])${colour}($|[^\\p{L}-])`, 'iu').test(r.text);
    return named ? PASS : fail(`the answer did not name the colour (${colour})`);
  } catch (err) {
    return errorResult(err);
  }
}

export interface PlanTask<T> {
  /** The plan schema (phase 11: `ClipPlan`). */
  schema: z.ZodType<T>;
  system?: string;
  /** The fixture sequence and its transcript, as the plan prompt. */
  prompt: string;
}

/** **plan/json**: one structured answer must validate with zod (decides `fast` and plan mode). */
export async function probePlan<T>(
  model: LanguageModelV4,
  task: PlanTask<T>,
  opts: ProbeOptions = {},
): Promise<CheckResult> {
  try {
    const r = await generateText({
      model,
      ...common(opts),
      ...(task.system !== undefined && { system: task.system }),
      prompt: task.prompt,
      output: Output.object({ schema: task.schema }),
    });
    return task.schema.safeParse(r.output).success ? PASS : fail('the plan did not validate');
  } catch (err) {
    if (err instanceof Error && err.name === 'AI_NoObjectGeneratedError') {
      return fail('the answer was not a valid plan');
    }
    return errorResult(err);
  }
}
