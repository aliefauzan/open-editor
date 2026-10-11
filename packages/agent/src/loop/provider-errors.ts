// Provider error mapping (agent spec "Error handling", R4 S19): a failed model request becomes a
// VoxError with a hint. Nothing from the raw error (URL, headers, request or response body, data,
// message) is copied unredacted: only the status, our own words and a short redacted excerpt.
import type { Redactor } from '@vox/engine';
import { APICallError } from 'ai';
import { VoxError, isVoxError } from '../errors.ts';

/** 429 and 5xx retry with backoff this many times; then the run pauses (reason `error`). */
export const PROVIDER_RETRIES = 3;
const BACKOFF_MS = [2_000, 8_000, 20_000] as const;
const MAX_RETRY_AFTER_MS = 60_000;

const OVERFLOW =
  /context[ _-]?(length|window|limit)|maximum context|too many tokens|prompt is too long|exceeds? (the )?(model'?s? )?(context|maximum)|input is too long|reduce the length/i;

function excerpt(redactor: Pick<Redactor, 'redact'>, text: unknown): string | undefined {
  if (typeof text !== 'string' || text === '') return undefined;
  const r = redactor.redact(text).replace(/\s+/g, ' ').trim();
  return r.length > 200 ? `${r.slice(0, 200)}…` : r;
}

function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (raw === undefined) return undefined;
  const s = Number(raw);
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.min(Math.max(0, at - Date.now()), MAX_RETRY_AFTER_MS);
}

export interface MappedProviderError {
  error: VoxError;
  /** 429 / 5xx / network: retry with backoff. */
  retryable: boolean;
  /** Server-requested wait, if any. */
  retryAfterMs?: number;
}

/** Maps any error thrown by a model request. `provider` is our label (`OpenRouter`, `Ollama`, …). */
export function mapProviderError(
  err: unknown,
  provider: string,
  redactor: Pick<Redactor, 'redact'>,
): MappedProviderError {
  if (isVoxError(err)) {
    const retryable = err.code === 'PROVIDER_RATE_LIMITED' || err.code === 'PROVIDER_UNAVAILABLE';
    return { error: redactor.redact(err), retryable };
  }
  if (APICallError.isInstance(err)) {
    const status = err.statusCode;
    const said = excerpt(redactor, err.responseBody) ?? excerpt(redactor, err.message);
    const details = { provider, ...(status !== undefined && { status }), ...(said && { said }) };
    if (status === 401 || status === 403) {
      return {
        error: new VoxError(
          'PROVIDER_AUTH',
          `key rejected by ${provider} (HTTP ${String(status)})`,
          `Check the ${provider} key: vox config providers add, or Settings → Models.`,
          { details },
        ),
        retryable: false,
      };
    }
    const overflow = [err.message, err.responseBody].some(
      (t) => typeof t === 'string' && OVERFLOW.test(t),
    );
    if (overflow && (status === undefined || status === 400 || status === 413 || status === 422)) {
      return {
        error: new VoxError(
          'CONTEXT_OVERFLOW',
          `the request is larger than the ${provider} model's context`,
          'The run compacts its context and retries once; if it fails again use a model with a larger context.',
          { details },
        ),
        retryable: false,
      };
    }
    if (status === 429) {
      const wait = retryAfterMs(err.responseHeaders);
      return {
        error: new VoxError(
          'PROVIDER_RATE_LIMITED',
          `rate limited by ${provider}`,
          `Retrying with backoff${wait === undefined ? '' : ` (in ${String(Math.round(wait / 1000))} s)`}; if it persists, wait or raise the provider's limit.`,
          { details },
        ),
        retryable: true,
        ...(wait !== undefined && { retryAfterMs: wait }),
      };
    }
    if ((status !== undefined && status >= 500) || (status === undefined && err.isRetryable)) {
      return {
        error: new VoxError(
          'PROVIDER_UNAVAILABLE',
          `${provider} is unavailable${status === undefined ? '' : ` (HTTP ${String(status)})`}`,
          'Retrying with backoff; if it persists, try again later or switch the model.',
          { details },
        ),
        retryable: true,
      };
    }
    return {
      error: new VoxError(
        'PROVIDER_FAILED',
        `${provider} refused the request${status === undefined ? '' : ` (HTTP ${String(status)})`}`,
        'Check the model id and its options in Settings → Models.',
        { details },
      ),
      retryable: false,
    };
  }
  const e = err as { name?: unknown; message?: unknown };
  const network =
    e.name === 'TypeError' ||
    e.name === 'AbortError' ||
    /fetch failed|ECONN|ETIMEDOUT|socket/i.test(String(e.message));
  if (e.name === 'AbortError') {
    return {
      error: new VoxError('CANCELLED', 'the request was cancelled', 'Start the run again.'),
      retryable: false,
    };
  }
  const said = excerpt(redactor, e.message);
  return {
    error: new VoxError(
      network ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_FAILED',
      network ? `${provider} could not be reached` : `the ${provider} request failed`,
      network
        ? 'Check the network and the provider base URL; retrying with backoff.'
        : 'Try again or switch the model.',
      { details: { provider, ...(said && { said }) } },
    ),
    retryable: network,
  };
}

/** Backoff before retry `attempt` (0-based): the server's Retry-After wins. */
export function backoffMs(attempt: number, retryAfter?: number): number {
  return retryAfter ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 20_000;
}
