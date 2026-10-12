// The agent panel's state (app spec "Main editor" → Agent panel; plan phase 13, D-15). The activity
// log comes from `agent.runs` (run records + history, read again when a run changes); the live part
// of a running run (its pause, todos, the sequences in the latest step's scope) comes from the
// `agent.event` / `agent.todos` events. One store per editor window.
import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  AgentPauseData,
  AgentRunData,
  ErrorData,
  SettingsData,
  VoxApi,
} from '../../shared/api.ts';

export interface LiveRun {
  runId: string;
  projectId: string;
  workflow: string;
  mode: 'tools' | 'plan';
  status: AgentRunData['status'];
  /** Sequences in the latest `agent.step` scope (the tab marker); cleared on `agent.done`. */
  scope: string[];
  todos: AgentRunData['todos'];
  pause?: AgentPauseData;
  /** The tool now running ("Analyzing", job progress). */
  tool?: string;
}

/** A refused "Undo this run": the later edits that touch the run's items (`UNDO_CONFLICT`). */
export interface UndoConflict {
  runId: string;
  itemIds: string[];
  keys: string[];
}

export type Decision = { approve: boolean; wordKeys?: string[] } | { choice: string };

export interface AgentState {
  projectId: string | null;
  runs: AgentRunData[];
  live: Record<string, LiveRun>;
  settings: SettingsData | null;
  confirmPlan: boolean;
  attachments: string[];
  sending: boolean;
  error: ErrorData | null;
  conflict: UndoConflict | null;
  load(projectId: string | null): Promise<void>;
  refresh(): Promise<void>;
  loadSettings(): Promise<void>;
  /** Starts a run with the message; selection = the open sequence and the selected items. */
  send(
    message: string,
    o: { selection: string[]; workflow?: string },
  ): Promise<{ runId: string } | null>;
  stop(runId: string): Promise<void>;
  decide(runId: string, d: Decision): Promise<void>;
  undoRun(runId: string): Promise<boolean>;
  setConfirmPlan(on: boolean): void;
  attach(mediaId: string): void;
  detach(mediaId: string): void;
  clearError(): void;
  onEvent(e: { type?: string; payload?: Record<string, unknown> }): void;
  onTodos(p: { runId?: string; items?: AgentRunData['todos'] }): void;
}

export type AgentStore = StoreApi<AgentState>;

const asError = (e: unknown): ErrorData =>
  e && typeof e === 'object' && 'code' in e
    ? (e as ErrorData)
    : { code: 'INTERNAL', message: String(e), hint: '' };

/** Sequences an active run is editing now (the "agent editing" tab marker). */
export function agentScope(s: Pick<AgentState, 'live' | 'projectId'>): Set<string> {
  const out = new Set<string>();
  for (const r of Object.values(s.live)) {
    if (r.projectId !== s.projectId || (r.status !== 'running' && r.status !== 'paused')) continue;
    for (const id of r.scope) out.add(id);
  }
  return out;
}

/** `00:12.345` (LISTEN.md) or `1234 ms` → ms; undefined when it is neither. */
export function parseTimecode(tc: string): number | undefined {
  const m = /^(\d+):(\d{2})(?:\.(\d{1,3}))?$/.exec(tc.trim());
  if (m) return Number(m[1]) * 60_000 + Number(m[2]) * 1000 + Number((m[3] ?? '0').padEnd(3, '0'));
  const ms = /^(\d+)\s*ms$/.exec(tc.trim());
  return ms ? Number(ms[1]) : undefined;
}

export function createAgentStore(vox: VoxApi): AgentStore {
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  // runs this window started: a run that fails before `agent.started` has no record, so its
  // `agent.done` error is shown in the panel instead
  const mine = new Set<string>();
  const store = createStore<AgentState>()((set, get) => {
    const scheduleRefresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void get().refresh(), 150);
    };
    const patchLive = (runId: string, patch: Partial<LiveRun>) => {
      const cur = get().live[runId];
      if (!cur) return;
      set({ live: { ...get().live, [runId]: { ...cur, ...patch } } });
    };
    return {
      projectId: null,
      runs: [],
      live: {},
      settings: null,
      confirmPlan: false,
      attachments: [],
      sending: false,
      error: null,
      conflict: null,
      async load(projectId) {
        set({ projectId, runs: [], conflict: null, error: null, attachments: [] });
        if (projectId) await get().refresh();
        void get().loadSettings();
      },
      async refresh() {
        const projectId = get().projectId;
        if (!projectId) return;
        try {
          const runs = await vox.agent.runs(projectId);
          if (get().projectId !== projectId) return;
          // a run listed as paused carries its pause (after a reload of the window)
          const live = { ...get().live };
          for (const r of runs) {
            if (r.status !== 'running' && r.status !== 'paused') continue;
            live[r.runId] = {
              runId: r.runId,
              projectId,
              workflow: r.workflow,
              mode: r.mode,
              status: r.status,
              scope: live[r.runId]?.scope ?? r.scope,
              todos: live[r.runId]?.todos ?? r.todos,
              ...((r.pause ?? live[r.runId]?.pause) && { pause: r.pause ?? live[r.runId]?.pause }),
            };
          }
          set({ runs, live });
        } catch (e) {
          set({ error: asError(e) });
        }
      },
      async loadSettings() {
        try {
          set({ settings: await vox.settings.get() });
        } catch {
          set({ settings: null });
        }
      },
      async send(message, o) {
        const projectId = get().projectId;
        if (!projectId || !message.trim()) return null;
        set({ sending: true, error: null });
        // the roles may have changed outside the app since the panel last read them
        void get().loadSettings();
        try {
          const r = await vox.agent.run({
            projectId,
            message: message.trim(),
            selection: o.selection,
            ...(o.workflow && { workflow: o.workflow }),
            ...(get().confirmPlan && { confirmPlan: true }),
            ...(get().attachments.length > 0 && { attachments: get().attachments }),
          });
          mine.add(r.runId);
          set({ attachments: [] });
          scheduleRefresh();
          return { runId: r.runId };
        } catch (e) {
          set({ error: asError(e) });
          return null;
        } finally {
          set({ sending: false });
        }
      },
      async stop(runId) {
        try {
          await vox.agent.stop(runId);
        } catch (e) {
          set({ error: asError(e) });
        }
      },
      async decide(runId, d) {
        patchLive(runId, { pause: undefined, status: 'running' });
        try {
          await vox.agent.decide(runId, d);
        } catch (e) {
          set({ error: asError(e) });
        }
        scheduleRefresh();
      },
      async undoRun(runId) {
        set({ conflict: null, error: null });
        try {
          await vox.agent.undoRun(runId);
          await get().refresh();
          return true;
        } catch (e) {
          const err = asError(e);
          if (err.code === 'UNDO_CONFLICT') {
            const d = (err.details ?? {}) as { itemIds?: unknown; keys?: unknown };
            const list = (v: unknown) =>
              Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
            set({ conflict: { runId, itemIds: list(d.itemIds), keys: list(d.keys) } });
          } else set({ error: err });
          return false;
        }
      },
      setConfirmPlan(on) {
        set({ confirmPlan: on });
      },
      attach(mediaId) {
        if (!get().attachments.includes(mediaId))
          set({ attachments: [...get().attachments, mediaId].slice(0, 20) });
      },
      detach(mediaId) {
        set({ attachments: get().attachments.filter((m) => m !== mediaId) });
      },
      clearError() {
        set({ error: null, conflict: null });
      },
      onEvent(e) {
        const p = e.payload ?? {};
        const runId = typeof p['runId'] === 'string' ? p['runId'] : undefined;
        if (!runId) return;
        switch (e.type) {
          case 'agent.started':
            set({
              live: {
                ...get().live,
                [runId]: {
                  runId,
                  projectId: String(p['projectId'] ?? ''),
                  workflow: String(p['workflow'] ?? ''),
                  mode: p['mode'] === 'plan' ? 'plan' : 'tools',
                  status: 'running',
                  scope: [],
                  todos: [],
                },
              },
            });
            break;
          case 'agent.step':
            if (Array.isArray(p['scope']))
              patchLive(runId, { scope: (p['scope'] as unknown[]).map(String), tool: undefined });
            break;
          case 'agent.tool':
            patchLive(runId, {
              tool: p['status'] === 'started' ? String(p['tool'] ?? '') : undefined,
            });
            break;
          case 'agent.paused':
            patchLive(runId, { status: 'paused', pause: p as unknown as AgentPauseData });
            break;
          case 'agent.done':
            if (
              !get().live[runId] &&
              p['status'] === 'failed' &&
              (get().sending || mine.has(runId)) &&
              p['error'] &&
              typeof p['error'] === 'object'
            )
              set({ error: p['error'] as ErrorData });
            patchLive(runId, {
              status: (p['status'] as LiveRun['status'] | undefined) ?? 'completed',
              scope: [],
              pause: undefined,
              tool: undefined,
            });
            break;
          default:
            break;
        }
        const live = get().live[runId];
        if (!live || live.projectId === get().projectId) scheduleRefresh();
      },
      onTodos(p) {
        if (typeof p.runId === 'string' && Array.isArray(p.items))
          patchLive(p.runId, { todos: p.items });
      },
    };
  });
  vox.on('agent.event', (e) => store.getState().onEvent(e as never));
  vox.on('agent.todos', (e) => store.getState().onTodos(e as never));
  return store;
}
