// The `window.vox` bridge, generated from the one schema (src/shared/api.ts). Runs sandboxed in the
// main frame of app windows only (subframes get no preload). Every call goes to main, which checks
// the sender and validates the arguments (S11); a failed call rejects with plain `ErrorData`.
import { contextBridge, ipcRenderer } from 'electron';
import { EVENTS, METHODS, type CallResult, type EventName } from '../shared/api.ts';

const listeners = new Map<string, Set<(payload: unknown) => void>>();
ipcRenderer.on('vox:event', (_e, name: string, payload: unknown) => {
  for (const h of listeners.get(name) ?? []) h(payload);
});

const vox: Record<string, unknown> = {};
for (const method of METHODS) {
  const [area, name] = method.split('.') as [string, string];
  const group = (vox[area] ??= {}) as Record<string, unknown>;
  group[name] = async (...args: unknown[]) => {
    const r = (await ipcRenderer.invoke('vox:call', method, args)) as CallResult;
    if (r.ok) return r.value;
    throw r.error;
  };
}
vox['on'] = (event: EventName, handler: (payload: unknown) => void) => {
  if (!EVENTS.includes(event)) throw new Error(`Unknown event ${String(event)}`);
  if (typeof handler !== 'function') throw new Error('handler must be a function');
  let set = listeners.get(event);
  if (!set) listeners.set(event, (set = new Set()));
  set.add(handler);
  return () => void set.delete(handler);
};

contextBridge.exposeInMainWorld('vox', vox);
