// Captures the first HTTP request a model would send, without sending it. Used to measure a tool
// list "as serialised for that provider" (D-15) and by tests to check URLs and headers offline.
import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';

export type FetchFunction = typeof globalThis.fetch;

export interface CapturedRequest {
  url: string;
  method: string;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /** Parsed JSON body, or the raw string when it is not JSON. */
  body: unknown;
}

class RequestCaptured extends Error {
  constructor() {
    super('request captured; not sent');
    this.name = 'RequestCaptured';
  }
}

function urlOf(input: Parameters<FetchFunction>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function bodyOf(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** Builds a model with a capturing fetch, starts one `doGenerate` call and returns its request. */
export async function captureRequest(
  build: (fetch: FetchFunction) => LanguageModelV4,
  options: LanguageModelV4CallOptions,
): Promise<CapturedRequest> {
  let captured: CapturedRequest | undefined;
  const fetch: FetchFunction = (input, init) => {
    if (captured === undefined) {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => {
        headers[name] = value;
      });
      captured = {
        url: urlOf(input),
        method: init?.method ?? 'GET',
        headers,
        body: bodyOf(init?.body),
      };
    }
    return Promise.reject(new RequestCaptured());
  };
  const model = build(fetch);
  try {
    await model.doGenerate(options);
  } catch (err) {
    if (captured === undefined) throw err;
  }
  if (captured === undefined) throw new Error('the model answered without sending a request');
  return captured;
}
