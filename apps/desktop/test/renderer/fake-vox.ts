// A `window.vox` for renderer tests backed by the real engine-host handlers and the real engine:
// arguments go through the same zod schema main uses, values and events are structured-cloned like
// IPC, and events arrive asynchronously (as over IPC, they may come before or after the call reply).
import type { Engine } from '@vox/engine';
import { createHandlers, forwardEvents } from '../../src/engine-host/handlers.ts';
import { toErrorData } from '../../src/engine-host/rpc.ts';
import { METHODS, parseCall, type EventName, type VoxApi } from '../../src/shared/api.ts';

export interface FakeVox {
  vox: VoxApi;
  /** Every call: method and args. */
  calls: { method: string; args: unknown[] }[];
  /** While paused, events queue up; `resume` delivers them. */
  pauseEvents(): void;
  resumeEvents(): void;
  /** Drops queued events (the renderer never sees them). */
  dropEvents(): void;
  emit(name: EventName, payload: unknown): void;
  /** Waits until queued work (calls, events) has run. */
  settle(): Promise<void>;
}

export function fakeVox(
  engine: Engine,
  extra: Record<string, (...a: never[]) => unknown> = {},
): FakeVox {
  const handlers = { ...createHandlers(engine), ...extra } as Record<
    string,
    (...a: unknown[]) => Promise<unknown>
  >;
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const calls: FakeVox['calls'] = [];
  let paused = false;
  let queued: [EventName, unknown][] = [];
  let inflight = 0;
  const deliver = (name: EventName, payload: unknown) => {
    inflight++;
    setTimeout(() => {
      inflight--;
      for (const h of listeners.get(name) ?? []) h(structuredClone(payload));
    }, 0);
  };
  const emit = (name: EventName, payload: unknown) => {
    if (paused) queued.push([name, payload]);
    else deliver(name, payload);
  };
  forwardEvents(engine, emit);
  const vox: Record<string, unknown> = {};
  for (const method of METHODS) {
    const [area, name] = method.split('.') as [string, string];
    const group = (vox[area] ??= {}) as Record<string, unknown>;
    group[name] = async (...args: unknown[]) => {
      calls.push({ method, args: structuredClone(args) });
      const parsed = parseCall(method, args);
      if (!parsed.ok) throw parsed.error;
      const fn = handlers[method];
      if (!fn) throw { code: 'NOT_AVAILABLE', message: method, hint: '' };
      inflight++;
      try {
        return structuredClone(await fn(...parsed.args));
      } catch (e) {
        throw toErrorData(e);
      } finally {
        inflight--;
      }
    };
  }
  vox['on'] = (event: string, h: (p: unknown) => void) => {
    let set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    set.add(h);
    return () => void set.delete(h);
  };
  return {
    vox: vox as unknown as VoxApi,
    calls,
    pauseEvents: () => void (paused = true),
    resumeEvents: () => {
      paused = false;
      const q = queued;
      queued = [];
      for (const [n, p] of q) deliver(n, p);
    },
    dropEvents: () => void (queued = []),
    emit: deliver,
    async settle() {
      for (let i = 0; i < 500; i++) {
        await new Promise((r) => setTimeout(r, 2));
        if (inflight === 0) {
          await new Promise((r) => setTimeout(r, 5));
          if (inflight === 0) return;
        }
      }
      throw new Error('fake vox did not settle');
    },
  };
}
