// JSON-lines protocol of `vox-apple-llm`, the Swift helper for Apple's on-device model
// (agent spec "Apple on-device model", plan D-10). One request per stdin line, one answer per
// stdout line, in order. `vox-apple-llm --status` prints one status line and exits 0.
// The real helper (`native/apple-llm`) and the fake (`test/fixtures/fake-apple-llm.mjs`) are both
// checked against these schemas.
import { z } from 'zod';

/** `--status` availability values, in the agent spec's order. */
export const appleStatusValues = [
  'ready',
  'notEnabled',
  'notEligible',
  'modelNotReady',
  'unsupportedOS',
] as const;
export const AppleStatusValue = z.enum(appleStatusValues);
export type AppleStatusValue = z.infer<typeof AppleStatusValue>;

/**
 * `--status` output: availability, the model's context size in tokens (4,096 when unknown) and
 * whether it accepts images (macOS 27+, D-74). A helper older than D-74 sends no `vision`: read it
 * as false.
 */
export const AppleStatus = z.strictObject({
  status: AppleStatusValue,
  contextSize: z.number().int().positive(),
  vision: z.boolean().optional(),
});
export type AppleStatus = z.infer<typeof AppleStatus>;

/** Most images one request may carry (the agent's tools send at most 8 stills per call). */
export const APPLE_MAX_IMAGES = 16;

/**
 * One turn. `images` (user messages only, D-74) lists absolute paths of image files the caller
 * wrote for this request; the helper reads them and the caller deletes them after the answer.
 */
export const AppleMessage = z
  .strictObject({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    images: z
      .array(z.string().startsWith('/', 'each image must be an absolute file path'))
      .min(1)
      .max(APPLE_MAX_IMAGES)
      .optional(),
  })
  .refine((m) => m.images === undefined || m.role === 'user', {
    message: 'only user messages may have images',
    path: ['images'],
  });
export type AppleMessage = z.infer<typeof AppleMessage>;

/**
 * One request. `schema` is a JSON Schema object; the helper turns it into a
 * `DynamicGenerationSchema` and drops keywords it cannot express, so callers still validate the
 * answer with zod. `id` is optional and echoed back on the answer.
 */
export const AppleRequest = z
  .strictObject({
    id: z.string().min(1).optional(),
    system: z.string(),
    messages: z.array(AppleMessage).min(1),
    schema: z.record(z.string(), z.unknown()).optional(),
    maxTokens: z.number().int().positive(),
    temperature: z.number().min(0).max(2),
  })
  .refine((r) => r.messages.at(-1)?.role === 'user', {
    message: 'the last message must be from the user',
    path: ['messages'],
  })
  .refine((r) => r.messages.reduce((n, m) => n + (m.images?.length ?? 0), 0) <= APPLE_MAX_IMAGES, {
    message: `a request may carry at most ${String(APPLE_MAX_IMAGES)} images`,
    path: ['messages'],
  });
export type AppleRequest = z.infer<typeof AppleRequest>;
export type AppleRequestInput = z.input<typeof AppleRequest>;

/** Token counts; `estimated` is true when the framework reported none (about 4 characters per token). */
export const AppleUsage = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimated: z.boolean(),
});
export type AppleUsage = z.infer<typeof AppleUsage>;

export const appleErrorCodes = [
  'badRequest',
  'unavailable',
  'contextOverflow',
  'guardrail',
  'generation',
  /** The request has images but the model cannot see them (before macOS 27, or no `vision`). */
  'visionUnavailable',
] as const;
export const AppleErrorCode = z.enum(appleErrorCodes);
export type AppleErrorCode = z.infer<typeof AppleErrorCode>;

const optionalId = z.string().min(1).optional();

export const AppleTextAnswer = z.strictObject({
  id: optionalId,
  text: z.string(),
  usage: AppleUsage,
});
export const AppleJsonAnswer = z.strictObject({
  id: optionalId,
  json: z.json(),
  usage: AppleUsage,
});
export const AppleErrorAnswer = z.strictObject({
  id: optionalId,
  error: z.strictObject({ code: AppleErrorCode, message: z.string() }),
});
export const AppleResponse = z.union([AppleTextAnswer, AppleJsonAnswer, AppleErrorAnswer]);
export type AppleResponse = z.infer<typeof AppleResponse>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Validates a request and returns it as one JSON line (newline-terminated). U+2028 and U+2029 are
 * escaped too (`JSON.stringify` leaves them raw), so no line splitter can break the line.
 */
export function encodeAppleRequest(request: AppleRequestInput): string {
  return (
    JSON.stringify(AppleRequest.parse(request)).replace(/[\u2028\u2029]/g, (c) =>
      c === '\u2028' ? '\\u2028' : '\\u2029',
    ) + '\n'
  );
}

/**
 * Splits decoded stdout text into lines on `\n` only (a trailing `\r` is dropped). Use this
 * instead of `node:readline`, which also splits on `\r`, U+2028 and U+2029: characters that may
 * appear raw inside a JSON string.
 */
export class JsonLineSplitter {
  private rest = '';

  /** Adds a chunk and returns the lines it completes. */
  push(chunk: string): string[] {
    const parts = (this.rest + chunk).split('\n');
    this.rest = parts.pop() ?? '';
    return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  }

  /** Returns the unterminated last line, if any, once the stream has ended. */
  end(): string | null {
    const last = this.rest;
    this.rest = '';
    return last === '' ? null : last;
  }
}

function parseLine<T>(schema: z.ZodType<T>, line: string): Parsed<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    return { ok: false, error: `not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result = schema.safeParse(raw);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: z.prettifyError(result.error) };
}

/** Parses one stdout line of a request/answer exchange. */
export function parseAppleResponseLine(line: string): Parsed<AppleResponse> {
  return parseLine(AppleResponse, line);
}

/** Parses the stdout of `vox-apple-llm --status`. */
export function parseAppleStatusLine(stdout: string): Parsed<AppleStatus> {
  return parseLine(AppleStatus, stdout.trim());
}
