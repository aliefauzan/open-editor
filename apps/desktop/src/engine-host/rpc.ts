// Main ⇄ engine host RPC over a MessagePort (Electron MessagePortMain in the app, node:worker_threads
// MessagePort in tests). Requests {id, method, args}; replies {id, ok, value | error}; events
// {event, payload}. Errors cross as plain `ErrorData`.
import { appError, type ErrorData, type EventName, type Method } from '../shared/api.ts';

export interface PortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (m: unknown) => void): unknown;
  start?(): void;
}

type Request = { id: number; method: Method; args: unknown[] };
type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: ErrorData };
type EventMsg = { event: EventName; payload: unknown };

/** Electron delivers `{ data, ports }`; node delivers the value itself. */
const unwrap = (m: unknown): unknown =>
  m !== null && typeof m === 'object' && 'ports' in m && 'data' in m
    ? (m as { data: unknown }).data
    : m;

export function toErrorData(e: unknown): ErrorData {
  const o = (e ?? {}) as Partial<Record<keyof ErrorData, unknown>>;
  return {
    code: typeof o.code === 'string' ? o.code : 'INTERNAL',
    message: typeof o.message === 'string' ? o.message : String(e),
    hint: typeof o.hint === 'string' ? o.hint : 'See the log for details',
    ...(o.details && typeof o.details === 'object'
      ? { details: o.details as Record<string, unknown> }
      : {}),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- args were validated by main (zod)
type Handler = (...args: any[]) => Promise<unknown>;
export type Handlers = Partial<Record<Method, Handler>>;

/** Engine-host side: answers requests with `handlers`; returns `emit` for events. */
export function serve(
  port: PortLike,
  handlers: Handlers,
): (name: EventName, payload: unknown) => void {
  port.on('message', (raw) => {
    const m = unwrap(raw) as Partial<Request>;
    if (typeof m?.id !== 'number' || typeof m.method !== 'string') return;
    const id = m.id;
    const fn = Object.hasOwn(handlers, m.method) ? handlers[m.method] : undefined;
    const reply = (r: Reply) => port.postMessage(r);
    if (!fn) {
      reply({
        id,
        ok: false,
        error: appError('NOT_AVAILABLE', `${m.method} is not available yet`),
      });
      return;
    }
    Promise.resolve()
      .then(() => fn(...(m.args ?? [])))
      .then(
        (value) => reply({ id, ok: true, value }),
        (e: unknown) => reply({ id, ok: false, error: toErrorData(e) }),
      );
  });
  port.start?.();
  return (event, payload) => port.postMessage({ event, payload } satisfies EventMsg);
}

export interface Client {
  call(method: Method, args: unknown[]): Promise<unknown>;
  /** Rejects every pending call with `err` (host exited). */
  close(err: unknown): void;
}

/** Main side. */
export function createClient(
  port: PortLike,
  onEvent: (name: EventName, payload: unknown) => void,
): Client {
  let next = 1;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  port.on('message', (raw) => {
    const m = unwrap(raw) as Partial<EventMsg> & {
      id?: number;
      ok?: boolean;
      value?: unknown;
      error?: ErrorData;
    };
    if (typeof m?.event === 'string') {
      onEvent(m.event, m.payload);
      return;
    }
    if (typeof m?.id !== 'number') return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else p.reject(m.error);
  });
  port.start?.();
  return {
    call(method, args) {
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        port.postMessage({ id, method, args } satisfies Request);
      });
    },
    close(err) {
      const data = toErrorData(err);
      for (const p of pending.values()) p.reject(data);
      pending.clear();
    },
  };
}
