// Network stages retry 3× with backoff (engine spec "Error handling"): one first try plus up to
// three retries after 1 s, 2 s and 4 s. Cancellation and errors the caller marks as final stop at once.
import { VoxError } from '../errors.ts';

export const RETRIES = 3;
export const BACKOFF_MS = 1000;

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  signal?: AbortSignal;
  /** False stops retrying (e.g. LOGIN_REQUIRED, NET_BLOCKED, CANCELLED). */
  retryable: (e: unknown) => boolean;
  /** Test seam; default a timer that the signal cancels. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (attempt: number, e: unknown) => void;
}

const cancelled = (): VoxError =>
  new VoxError('CANCELLED', 'The download was cancelled.', 'Run it again when ready.');

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const onAbort = (): void => {
      clearTimeout(t);
      reject(cancelled());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  o: RetryOptions,
): Promise<T> {
  const retries = o.retries ?? RETRIES;
  const base = o.baseMs ?? BACKOFF_MS;
  const wait = o.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    if (o.signal?.aborted) throw cancelled();
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt >= retries || o.signal?.aborted || !o.retryable(e)) throw e;
      o.onRetry?.(attempt + 1, e);
      await wait(base * 2 ** attempt, o.signal);
    }
  }
}
