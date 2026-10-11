// The editor store (app spec "Live updates and editing flow"; plan D-15). It keeps the engine's
// confirmed project as an entity map at a version, plus the user's pending ops shown optimistically
// on top. Ops go to the engine one at a time with `baseVersion`; results and `project.changed` events
// apply their change records. `STALE` → reload, re-run the user's intent once, else revert + toast.
// External edits (`actor: 'external'`) and version gaps reload the whole project.
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ApplyResultData, ErrorData, VoxApi } from '../../shared/api.ts';
import type { Change, Project, ProjectChanged } from '../../shared/project.ts';
import {
  allItems,
  applyChanges,
  denormalise,
  normalise,
  projectFrame,
  type EntityMap,
  type ProjectFrame,
} from './entities.ts';
import { optimisticChanges, type OpCall } from './optimistic.ts';

export type { OpCall } from './optimistic.ts';

export interface Toast extends ErrorData {
  id: number;
}

export interface ApplyOptions {
  /** `<field>:<itemId>` (D-15): changes with one key within 1 s are one undo entry. */
  coalesceKey?: string;
  /**
   * The user's intent, re-run against the newer project after `STALE` (e.g. "move item X to
   * 12,000 ms"); `null` = the intent no longer applies. Default: the same call again.
   */
  intent?: (p: Project) => OpCall | null;
}

interface Pending {
  seq: number;
  call: OpCall;
  coalesceKey?: string;
  intent?: (p: Project) => OpCall | null;
  sent: boolean;
  done: Promise<void>;
  resolve: () => void;
}

export interface EditorState {
  projectId: string | null;
  /** Confirmed project with the pending ops applied on top (what the UI shows). */
  project: Project | null;
  /** Confirmed engine version. */
  version: number;
  pending: readonly Pending[];
  sequenceId: string | null;
  selection: string[];
  playheadMs: number;
  /** itemId → runId of the agent run that last changed it (the "agent" badge, phase 13). */
  agentItems: Record<string, string>;
  toasts: Toast[];
  open(projectId: string): Promise<void>;
  close(): void;
  /** Re-reads the project from the engine (external edit, version gap, host restart). */
  reload(): Promise<void>;
  apply(call: OpCall, opts?: ApplyOptions): Promise<void>;
  /**
   * A slider or text field change: one op per change with coalesceKey `<field>:<itemId>`. A change
   * that has not been sent yet is replaced by the newer one.
   */
  setField(field: string, itemId: string, call: OpCall): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  /** Resolves when every queued op, undo and reload has finished. */
  whenIdle(): Promise<void>;
  setSequence(id: string): void;
  /** Click: the item and its linked partners; `alt`: only the item; `add`: toggle into the selection. */
  select(itemId: string, o?: { alt?: boolean; add?: boolean }): void;
  setSelection(ids: string[]): void;
  setPlayhead(ms: number): void;
  toast(e: unknown): void;
  dismissToast(id: number): void;
}

export const asError = (e: unknown): ErrorData =>
  e && typeof e === 'object' && 'code' in e && 'message' in e
    ? { ...(e as ErrorData), hint: (e as ErrorData).hint ?? '' }
    : { code: 'INTERNAL', message: String(e), hint: '' };

export type EditorStore = StoreApi<EditorState>;

export function createEditorStore(vox: VoxApi): EditorStore {
  let base: { map: EntityMap; frame: ProjectFrame } | null = null;
  let chain: Promise<void> = Promise.resolve();
  let seqNo = 0;
  let toastNo = 0;

  const store = createStore<EditorState>()((set, get) => {
    /** Folds the pending ops onto the confirmed map and publishes the project. */
    const publish = (extra: Partial<EditorState> = {}) => {
      if (!base) return set(extra);
      let map = base.map;
      for (const p of get().pending) map = applyChanges(map, optimisticChanges(map, p.call));
      const project = denormalise(map, { ...base.frame, version: get().version });
      const s = { ...get(), ...extra };
      const seqOk = s.sequenceId && project.sequences.some((q) => q.id === s.sequenceId);
      set({
        ...extra,
        project,
        sequenceId: seqOk ? s.sequenceId : (project.sequences[0]?.id ?? null),
      });
    };

    const enqueue = (task: () => Promise<void>): Promise<void> => {
      const next = chain.then(task, task);
      chain = next.catch(() => undefined);
      return next;
    };

    /** Applies confirmed change records at `version` (must be the next version). */
    const confirm = (version: number, changes: readonly Change[]) => {
      if (!base) return;
      base = { ...base, map: applyChanges(base.map, changes) };
      set({ version });
    };

    const loadBase = async (id: string) => {
      const opened = await vox.projects.open(id);
      const project = opened.project as unknown as Project;
      base = { map: normalise(project), frame: projectFrame(project) };
      set({ projectId: id, version: project.version });
    };

    const drop = (p: Pending) => {
      set({ pending: get().pending.filter((x) => x !== p) });
      p.resolve();
    };

    const fail = (p: Pending, e: ErrorData) => {
      drop(p);
      publish();
      get().toast(e);
    };

    /** Handles an ApplyResult (ops.apply, undo, redo). Returns the failed result's error, if any. */
    const take = async (r: ApplyResultData): Promise<ErrorData | undefined> => {
      const bad = r.results.find((x) => x.status !== 'succeeded');
      if (bad) return bad.error ?? { code: 'OP_FAILED', message: 'The edit failed', hint: '' };
      const v = get().version;
      if (r.version === v + 1) confirm(r.version, r.changes as Change[]);
      else if (r.version > v + 1) await loadBase(get().projectId!); // missed changes in between
      return undefined;
    };

    const send = async (p: Pending): Promise<void> => {
      const id = get().projectId;
      if (!id) return drop(p);
      let retried = false;
      for (;;) {
        p.sent = true;
        let err: ErrorData | undefined;
        try {
          const r = await vox.ops.apply({
            projectId: id,
            op: p.call.op,
            args: p.call.args,
            baseVersion: get().version,
            ...(p.coalesceKey ? { coalesceKey: p.coalesceKey } : {}),
          });
          err = await take(r);
        } catch (e) {
          err = asError(e);
        }
        if (!err) {
          drop(p);
          return publish();
        }
        if (retried) {
          return fail(p, {
            ...err,
            message: `The project changed while you edited, so the edit was undone: ${err.message}`,
          });
        }
        if (err.code !== 'STALE') return fail(p, err);
        // STALE: take the newer state, re-run the user's intent once
        retried = true;
        try {
          await loadBase(id);
        } catch (e) {
          return fail(p, asError(e));
        }
        const confirmed = denormalise(base!.map, { ...base!.frame, version: get().version });
        const next = p.intent ? p.intent(confirmed) : p.call;
        if (!next) {
          return fail(p, {
            code: 'STALE',
            message: 'The project changed while you edited, so the edit was undone',
            hint: err.hint,
          });
        }
        p.call = next;
        publish();
      }
    };

    const history = (kind: 'undo' | 'redo') =>
      enqueue(async () => {
        const id = get().projectId;
        if (!id) return;
        try {
          const r = await (kind === 'undo' ? vox.history.undo(id) : vox.history.redo(id));
          const err = await take(r as ApplyResultData);
          if (err) get().toast(err);
        } catch (e) {
          const err = asError(e);
          if (err.code !== 'NOTHING_TO_UNDO' && err.code !== 'NOTHING_TO_REDO') get().toast(err);
        }
        publish();
      });

    const onChanged = (ev: ProjectChanged) => {
      if (!base || ev.projectId !== get().projectId) return;
      if (ev.actor === 'external') {
        void get().reload();
        return;
      }
      const v = get().version;
      if (ev.version <= v) return; // our own result came first
      if (ev.version > v + 1) {
        void get().reload();
        return;
      }
      confirm(ev.version, ev.changes);
      if (ev.actor === 'agent') {
        const marks = { ...get().agentItems };
        for (const c of ev.changes) {
          if (!c.key.startsWith('item:') || c.after === null) continue;
          marks[c.key.slice(c.key.indexOf('/') + 1)] = ev.runId ?? 'agent';
        }
        set({ agentItems: marks });
      }
      publish();
    };
    vox.on('project.changed', (p) => onChanged(p as ProjectChanged));

    const add = (call: OpCall, opts: ApplyOptions = {}): Pending => {
      let resolve!: () => void;
      const done = new Promise<void>((r) => (resolve = r));
      const p: Pending = {
        seq: ++seqNo,
        call,
        sent: false,
        done,
        resolve,
        ...(opts.coalesceKey ? { coalesceKey: opts.coalesceKey } : {}),
        ...(opts.intent ? { intent: opts.intent } : {}),
      };
      set({ pending: [...get().pending, p] });
      publish();
      void enqueue(() => (p.sent ? Promise.resolve() : send(p)));
      return p;
    };

    return {
      projectId: null,
      project: null,
      version: 0,
      pending: [],
      sequenceId: null,
      selection: [],
      playheadMs: 0,
      agentItems: {},
      toasts: [],
      async open(projectId) {
        base = null;
        set({
          projectId,
          project: null,
          pending: [],
          selection: [],
          agentItems: {},
          playheadMs: 0,
        });
        try {
          await loadBase(projectId);
          publish({ sequenceId: null });
        } catch (e) {
          get().toast(e);
        }
      },
      close() {
        base = null;
        set({ projectId: null, project: null, pending: [], selection: [], sequenceId: null });
      },
      reload() {
        return enqueue(async () => {
          const id = get().projectId;
          if (!id) return;
          try {
            await loadBase(id);
          } catch (e) {
            get().toast(e);
          }
          publish();
        });
      },
      apply(call, opts) {
        if (!get().projectId) return Promise.resolve();
        return add(call, opts).done;
      },
      setField(field, itemId, call) {
        const key = `${field}:${itemId}`;
        const last = get().pending.at(-1);
        if (last && !last.sent && last.coalesceKey === key) {
          last.call = call;
          publish();
          return last.done;
        }
        return get().apply(call, { coalesceKey: key });
      },
      undo: () => history('undo'),
      redo: () => history('redo'),
      whenIdle() {
        return chain;
      },
      setSequence(id) {
        set({ sequenceId: id, selection: [] });
      },
      select(itemId, o = {}) {
        const s = get().project?.sequences.find((q) => q.id === get().sequenceId);
        let ids = [itemId];
        if (s && !o.alt) {
          const all = allItems(s);
          const linkId = all.find((x) => x.item.id === itemId)?.item.linkId;
          if (linkId) ids = all.filter((x) => x.item.linkId === linkId).map((x) => x.item.id);
        }
        if (!o.add) return set({ selection: ids });
        const cur = new Set(get().selection);
        const on = !cur.has(itemId);
        for (const id of ids) {
          if (on) cur.add(id);
          else cur.delete(id);
        }
        set({ selection: [...cur] });
      },
      setSelection(ids) {
        set({ selection: [...new Set(ids)] });
      },
      setPlayhead(ms) {
        set({ playheadMs: Math.max(0, Math.round(ms)) });
      },
      toast(e) {
        const err = asError(e);
        set({ toasts: [...get().toasts, { ...err, id: ++toastNo }].slice(-5) });
      },
      dismissToast(id) {
        set({ toasts: get().toasts.filter((t) => t.id !== id) });
      },
    };
  });
  return store;
}
