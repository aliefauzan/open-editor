// Project store (engine spec "History"; plan D-15, D-18): load with schema check, migration and crash
// recovery; applyOp in the documented write order; undo/redo/undoRun; coalescing; JOB_CONFLICT;
// rotation; snapshots. One store per project folder; writes are serialised in-process and across
// processes by `project.lock`.
import { readFile, mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { isVoxError, VoxError } from '../errors.ts';
import { EngineLog, type EngineLogOptions } from '../log.ts';
import { deepEqual } from '../model/equal.ts';
import { diffProjects, type Change } from '../model/diff.ts';
import { newId as defaultNewId, type IdPrefix } from '../model/ids.ts';
import { canonical, denormalise, normalise, splitSeqKey, type Entity } from '../model/normalise.ts';
import {
  parseProject,
  SCHEMA_VERSION,
  TranscriptSchema,
  type MediaItem,
  type Project,
  type Transcript,
} from '../model/schema.ts';
import { runOp, SnapshotNameSchema, type OpCall, type OpContext } from '../ops/index.ts';
import { emptyTemplateLookup, type TemplateLookup } from '../ops/templates.ts';
import { resolveProjectPath } from '../paths.ts';
import { Cursor } from './cursor.ts';
import { appendDurable, HistoryLineError, readHistory, truncateTo, writeAtomic } from './files.ts';
import { acquireLock, type LockOptions } from './lock.ts';
import type {
  Actor,
  ApplyOptions,
  ApplyResult,
  HistoryEntry,
  ItemEntity,
  OpResult,
  ProjectChangedEvent,
} from './types.ts';

export const PROJECT_FILE = 'project.json';
export const HISTORY_FILE = 'history.jsonl';
export const DEFAULT_ROTATE_AT = 5000;
export const DEFAULT_KEEP = 500;
export const COALESCE_MS = 1000;

/** Points in the write order where test hooks run (kill tests). */
export type WriteStep = 'locked' | 'history-appended' | 'temp-written' | 'renamed';

/** One load-time migration step: a raw project at schemaVersion N → N + 1. */
export type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

export interface StoreOptions {
  templates?: TemplateLookup;
  now?: () => Date;
  lock?: LockOptions;
  migrations?: Readonly<Record<number, Migration>>;
  hooks?: { at?: (step: WriteStep) => void };
  onChanged?: (e: ProjectChangedEvent) => void;
  rotateAt?: number;
  keep?: number;
  newId?: (prefix: IdPrefix) => string;
  log?: EngineLogOptions;
}

export interface UndoOptions {
  actor: Actor;
  runId?: string;
}

export interface SnapshotInfo {
  name: string;
  version: number | null;
}

interface State {
  project: Project;
  entries: HistoryEntry[];
}

interface FileStamp {
  ino: number;
  mtimeMs: number;
  size: number;
  historySize: number;
}

const corrupt = (message: string) =>
  new VoxError(
    'HISTORY_CORRUPT',
    message,
    'Restore the project from a file in snapshots/ (or history/snapshot-<version>.json)',
  );

const json = (p: Project) => `${JSON.stringify(p, null, 2)}\n`;

function stampProject(p: Project, version: number, ts: string): Project {
  return { ...p, version, meta: { ...p.meta, updatedAt: ts } };
}

function itemsOf(changes: readonly Change[]): ItemEntity[] {
  return changes
    .filter((c) => c.key.startsWith('item:') && c.after !== null)
    .map((c) => c.after as unknown as ItemEntity);
}

function itemIdsOf(keys: readonly string[]): string[] {
  return keys.filter((k) => k.startsWith('item:')).map((k) => splitSeqKey(k.slice(5)).sub);
}

/** Set (or delete, for null) entity values and rebuild the project. */
function applyValues(
  p: Project,
  values: ReadonlyMap<string, Entity | null>,
  version: number,
  ts: string,
): Project {
  const m = normalise(p);
  for (const [k, v] of values) {
    if (v === null) m.delete(k);
    else m.set(k, structuredClone(v));
  }
  return parseProject(denormalise(m, { schemaVersion: p.schemaVersion, version, updatedAt: ts }));
}

/** Coalesce: keep the first `before` per key, take the new `after`, drop keys back where they began. */
function mergeChanges(prev: readonly Change[], next: readonly Change[]): Change[] {
  const m = new Map(prev.map((c) => [c.key, { ...c }]));
  for (const c of next) {
    const old = m.get(c.key);
    m.set(c.key, old ? { key: c.key, before: old.before, after: c.after } : { ...c });
  }
  return [...m.values()]
    .filter((c) => !deepEqual(c.before, c.after))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Op names for per-op results: the ops inside a batch, else the op itself. */
function opNames(call: OpCall): string[] {
  if (call.op !== 'batch') return [call.op];
  const ops = (call.args as { ops?: unknown } | undefined)?.ops;
  if (!Array.isArray(ops) || ops.length === 0) return ['batch'];
  return ops.map((o) =>
    o && typeof o === 'object' && typeof (o as { op?: unknown }).op === 'string'
      ? (o as { op: string }).op
      : 'batch',
  );
}

function subCalls(call: OpCall): OpCall[] {
  if (call.op !== 'batch') return [call];
  const ops = (call.args as { ops?: unknown } | undefined)?.ops;
  return Array.isArray(ops)
    ? ops.filter((o): o is OpCall => !!o && typeof o === 'object' && typeof o.op === 'string')
    : [];
}

function failedResults(call: OpCall, e: VoxError): OpResult[] {
  const names = opNames(call);
  const idx = e.details?.['batchIndex'];
  if (call.op === 'batch' && typeof idx === 'number' && idx < names.length) {
    return names.map((op, i) =>
      i === idx ? { op, status: 'failed', error: e } : { op, status: 'failed' },
    );
  }
  if (call.op === 'batch' && names.length > 1) {
    return [{ op: 'batch', status: 'failed', error: e }];
  }
  return [{ op: names[0] ?? call.op, status: 'failed', error: e }];
}

function conflictedResults(call: OpCall, e: VoxError): OpResult[] {
  return opNames(call).map((op) => ({ op, status: 'conflicted', error: e }));
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export class ProjectStore {
  readonly dir: string;
  private readonly opts: StoreOptions;
  private readonly log: EngineLog;
  private current!: Project;
  private text = '';
  private entries: HistoryEntry[] = [];
  private byVersion = new Map<number, HistoryEntry>();
  private cursor = new Cursor();
  private fileStamp: FileStamp | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(dir: string, opts: StoreOptions) {
    this.dir = dir;
    this.opts = opts;
    this.log = new EngineLog(dir, opts.log);
  }

  /** Open an existing project folder (schema check, migration, recovery). */
  static async open(dir: string, opts: StoreOptions = {}): Promise<ProjectStore> {
    const s = new ProjectStore(dir, opts);
    await s.load();
    return s;
  }

  /** Create a project folder (mode 0700) with `project.json` at version 0 and an empty history. */
  static async create(
    dir: string,
    project: Project,
    opts: StoreOptions = {},
  ): Promise<ProjectStore> {
    const p = canonical(parseProject({ ...project, version: 0 }));
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new VoxError(
          'VALIDATION',
          `Project folder ${p.id} already exists`,
          'Pick a new project id',
        );
      }
      throw e;
    }
    await writeAtomic(join(dir, HISTORY_FILE), '');
    await writeAtomic(join(dir, PROJECT_FILE), json(p));
    return ProjectStore.open(dir, opts);
  }

  /** The current project. Treat as read-only. */
  get project(): Project {
    return this.current;
  }

  private now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }

  private hook(step: WriteStep): void {
    this.opts.hooks?.at?.(step);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Run under the in-process queue and the cross-process lock; events are emitted after unlock. */
  private locked<T>(fn: (events: ProjectChangedEvent[]) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const events: ProjectChangedEvent[] = [];
      const release = await acquireLock(this.dir, this.opts.lock);
      let out: T;
      try {
        this.hook('locked');
        const ext = await this.refresh();
        if (ext) events.push(ext);
        out = await fn(events);
      } finally {
        await release();
      }
      for (const e of events) this.opts.onChanged?.(e);
      return out;
    });
  }

  // ---------------------------------------------------------------- load

  private async readRaw(): Promise<{ buf: Buffer; raw: Record<string, unknown> }> {
    let buf: Buffer;
    try {
      buf = await readFile(join(this.dir, PROJECT_FILE));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new VoxError(
          'PROJECT_NOT_FOUND',
          `No project at ${this.dir}`,
          'Check the project id and the projects folder (`vox paths`)',
        );
      }
      throw e;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(buf.toString('utf8'));
    } catch {
      throw new VoxError(
        'VALIDATION',
        'project.json is not valid JSON',
        'Restore the project from a file in snapshots/',
      );
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new VoxError(
        'VALIDATION',
        'project.json is not an object',
        'Restore the project from a file in snapshots/',
      );
    }
    return { buf, raw: raw as Record<string, unknown> };
  }

  /** SCHEMA_TOO_NEW / SCHEMA_UNSUPPORTED checks; true when a migration is needed. Writes nothing. */
  private checkSchema(raw: Record<string, unknown>): boolean {
    const v = raw['schemaVersion'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      throw new VoxError(
        'VALIDATION',
        'project.json has no valid schemaVersion',
        'Restore the project from a file in snapshots/',
      );
    }
    if (v > SCHEMA_VERSION) {
      throw new VoxError(
        'SCHEMA_TOO_NEW',
        `This project was saved by a newer Vox Studio (schemaVersion ${v}; this one reads up to ${SCHEMA_VERSION})`,
        'Update Vox Studio to open it; nothing was changed',
        { details: { schemaVersion: v, supported: SCHEMA_VERSION } },
      );
    }
    for (let n = v; n < SCHEMA_VERSION; n++) {
      if (!this.opts.migrations?.[n]) {
        throw new VoxError(
          'SCHEMA_UNSUPPORTED',
          `No migration from schemaVersion ${n} to ${n + 1}`,
          'This project is too old for this Vox Studio; open it in an older version first',
          { details: { schemaVersion: v } },
        );
      }
    }
    return v < SCHEMA_VERSION;
  }

  private migrate(raw: Record<string, unknown>): Record<string, unknown> {
    let cur = raw;
    for (let n = raw['schemaVersion'] as number; n < SCHEMA_VERSION; n++) {
      cur = this.opts.migrations![n]!(structuredClone(cur));
    }
    return cur;
  }

  /** Not queued: call from open() or from inside serial(). */
  private async load(): Promise<void> {
    const fast = await this.readConsistent();
    if (fast) {
      await this.setState(fast);
      return;
    }
    const release = await acquireLock(this.dir, this.opts.lock);
    try {
      await this.setState(await this.readRepair());
    } finally {
      await release();
    }
  }

  /** Lock-free read; undefined when a migration, truncation or recovery is needed (or a writer is mid-write). */
  private async readConsistent(): Promise<State | undefined> {
    const { raw } = await this.readRaw();
    if (this.checkSchema(raw)) return undefined;
    const project = parseProject(raw);
    let h;
    try {
      h = await readHistory(join(this.dir, HISTORY_FILE));
    } catch (e) {
      if (e instanceof HistoryLineError) return undefined;
      throw e;
    }
    if (h.tornAt !== undefined) return undefined;
    if (!this.contiguous(h.entries)) return undefined;
    const last = h.entries.at(-1);
    if ((last?.version ?? 0) !== project.version) return undefined;
    if (!last && project.version !== 0) return undefined;
    return { project, entries: h.entries };
  }

  private contiguous(entries: readonly HistoryEntry[]): boolean {
    return entries.every((e, i) => i === 0 || e.version === entries[i - 1]!.version + 1);
  }

  /** Under the lock: migrate, truncate a torn line, re-apply a version + 1 entry, or fail. */
  private async readRepair(): Promise<State> {
    const { buf, raw } = await this.readRaw();
    const projectPath = join(this.dir, PROJECT_FILE);
    let project: Project;
    if (this.checkSchema(raw)) {
      const from = raw['schemaVersion'] as number;
      await mkdir(join(this.dir, 'snapshots'), { recursive: true, mode: 0o700 });
      const snap = join(this.dir, 'snapshots', `auto-pre-migrate-v${from}.json`);
      if (!(await exists(snap))) await writeAtomic(snap, buf);
      project = parseProject(this.migrate(raw));
      await writeAtomic(projectPath, json(project));
      await this.log.write(
        `migrated project.json from schemaVersion ${from} to ${SCHEMA_VERSION} (copy in snapshots/auto-pre-migrate-v${from}.json)`,
      );
    } else {
      project = parseProject(raw);
    }
    const historyPath = join(this.dir, HISTORY_FILE);
    let h;
    try {
      h = await readHistory(historyPath);
    } catch (e) {
      if (e instanceof HistoryLineError) throw corrupt(e.message);
      throw e;
    }
    if (h.tornAt !== undefined) {
      await truncateTo(historyPath, h.tornAt);
      await this.log.write(`truncated a torn last line of history.jsonl at byte ${h.tornAt}`);
    }
    const entries = h.entries;
    if (!this.contiguous(entries)) throw corrupt('history.jsonl versions are not contiguous');
    const last = entries.at(-1);
    if (!last) {
      if (project.version !== 0) {
        throw corrupt(`history.jsonl is empty but project.json is at version ${project.version}`);
      }
    } else if (last.version === project.version + 1) {
      const values = new Map(last.changes.map((c) => [c.key, c.after]));
      project = applyValues(project, values, last.version, last.ts);
      await writeAtomic(projectPath, json(project));
      await this.log.write(
        `recovered version ${last.version} from history.jsonl (the last write stopped before project.json)`,
      );
    } else if (last.version !== project.version) {
      throw corrupt(
        `history.jsonl ends at version ${last.version} but project.json is at version ${project.version}`,
      );
    }
    for (const f of await readdir(this.dir)) {
      if (f.startsWith(`.${PROJECT_FILE}.tmp-`))
        await unlink(join(this.dir, f)).catch(() => undefined);
    }
    return { project, entries };
  }

  private async setState(s: State): Promise<void> {
    this.current = s.project;
    this.text = json(s.project);
    this.entries = s.entries;
    this.byVersion = new Map(s.entries.map((e) => [e.version, e]));
    this.cursor = Cursor.build(s.entries);
    this.fileStamp = await this.readStamp();
  }

  private async readStamp(): Promise<FileStamp | undefined> {
    try {
      const [p, h] = await Promise.all([
        stat(join(this.dir, PROJECT_FILE)),
        stat(join(this.dir, HISTORY_FILE)).catch(() => ({ size: 0 })),
      ]);
      return { ino: p.ino, mtimeMs: p.mtimeMs, size: p.size, historySize: h.size };
    } catch {
      return undefined;
    }
  }

  /** Step 2: another process wrote (or crashed mid-write) → reload; returns the external event. */
  private async refresh(): Promise<ProjectChangedEvent | undefined> {
    const now = await this.readStamp();
    const was = this.fileStamp;
    if (now && was && deepEqual(now, was)) return undefined;
    const before = this.current;
    await this.setState(await this.readRepair());
    const changes = diffProjects(before, this.current);
    if (this.current.version === before.version && changes.length === 0) return undefined;
    return {
      projectId: this.current.id,
      version: this.current.version,
      actor: 'external',
      changes,
    };
  }

  // ---------------------------------------------------------------- writes

  private async commit(entry: HistoryEntry, project: Project): Promise<void> {
    const historyPath = join(this.dir, HISTORY_FILE);
    await appendDurable(historyPath, `${JSON.stringify(entry)}\n`);
    this.hook('history-appended');
    const text = json(project);
    await writeAtomic(join(this.dir, PROJECT_FILE), text, {
      afterTemp: () => this.hook('temp-written'),
    });
    this.hook('renamed');
    this.current = project;
    this.text = text;
    this.entries.push(entry);
    this.byVersion.set(entry.version, entry);
    this.cursor.push(entry);
    await this.rotate();
    this.fileStamp = await this.readStamp();
  }

  private async rotate(): Promise<void> {
    const rotateAt = this.opts.rotateAt ?? DEFAULT_ROTATE_AT;
    const keep = Math.max(1, this.opts.keep ?? DEFAULT_KEEP);
    if (this.entries.length < rotateAt) return;
    const cut = this.entries.length - keep;
    if (cut <= 0) return;
    const old = this.entries.slice(0, cut);
    const kept = this.entries.slice(cut);
    const lines = (es: HistoryEntry[]) => es.map((e) => `${JSON.stringify(e)}\n`).join('');
    const hdir = join(this.dir, 'history');
    await mkdir(hdir, { recursive: true, mode: 0o700 });
    await writeAtomic(join(hdir, `${old[0]!.version}.jsonl.gz`), gzipSync(lines(old)));
    await writeAtomic(join(hdir, `snapshot-${this.current.version}.json`), this.text);
    await writeAtomic(join(this.dir, HISTORY_FILE), lines(kept));
    this.entries = kept;
    this.byVersion = new Map(kept.map((e) => [e.version, e]));
    this.cursor = Cursor.build(kept); // the same cursor a reload builds
  }

  /** Synchronous op context; transcripts and snapshots the call needs are read beforehand. */
  private async context(call: OpCall): Promise<OpContext> {
    const calls = subCalls(call);
    const transcripts = new Map<string, Transcript>();
    if (calls.some((c) => c.op === 'removePauses' || c.op === 'removeWords')) {
      for (const m of this.current.media) {
        if (!m.transcriptPath || !m.transcriptRev) continue;
        const t = await this.readTranscript(m);
        if (t) transcripts.set(m.id, t);
      }
    }
    const snapshots = new Map<string, Project>();
    for (const c of calls) {
      if (c.op !== 'restoreSnapshot') continue;
      const name = (c.args as { name?: unknown } | undefined)?.name;
      if (!SnapshotNameSchema.safeParse(name).success) continue;
      const snap = await this.readSnapshot(name as string);
      if (snap) snapshots.set(name as string, snap);
    }
    return {
      templates: this.opts.templates ?? emptyTemplateLookup,
      newId: this.opts.newId ?? defaultNewId,
      transcript: (m: MediaItem) => transcripts.get(m.id),
      snapshot: (name: string) => snapshots.get(name),
    };
  }

  private async readTranscript(m: MediaItem): Promise<Transcript | undefined> {
    let path: string;
    try {
      path = await resolveProjectPath(this.dir, m.transcriptPath!);
    } catch (e) {
      if (isVoxError(e) && e.code === 'PATH_INVALID') return undefined;
      throw e;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      raw = undefined;
    }
    const r = TranscriptSchema.safeParse(raw);
    if (!r.success) {
      throw new VoxError(
        'VALIDATION',
        `The transcript of ${m.id} (${m.transcriptPath}) is invalid`,
        `Transcribe ${m.id} again`,
        { details: { mediaId: m.id } },
      );
    }
    return r.data;
  }

  private async readSnapshot(name: string): Promise<Project | undefined> {
    let text: string;
    try {
      text = await readFile(join(this.dir, 'snapshots', `${name}.json`), 'utf8');
    } catch {
      return undefined;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new VoxError(
        'VALIDATION',
        `Snapshot ${name} is not valid JSON`,
        'Pick another snapshot',
      );
    }
    const obj = raw as Record<string, unknown>;
    return parseProject(this.checkSchema(obj) ? this.migrate(obj) : obj);
  }

  /** applyOp: lock → external-change check → STALE → op → history append → project write → unlock → event. */
  apply(call: OpCall, opts: ApplyOptions): Promise<ApplyResult> {
    return this.locked(async (events) => {
      const before = this.current;
      const unchanged = (results: OpResult[]): ApplyResult => ({
        version: before.version,
        changes: [],
        results,
      });
      if (
        opts.baseVersion !== undefined &&
        opts.jobId === undefined &&
        opts.baseVersion !== before.version
      ) {
        const e = new VoxError(
          'STALE',
          `The project is at version ${before.version}, not ${opts.baseVersion}`,
          'Read the project again and retry the op on the current version',
          { details: { version: before.version, baseVersion: opts.baseVersion } },
        );
        return unchanged(conflictedResults(call, e));
      }
      let outcome;
      try {
        outcome = runOp(before, call, await this.context(call));
      } catch (e) {
        if (!isVoxError(e) || e.code === 'LOCKED' || e.code === 'HISTORY_CORRUPT') throw e;
        return unchanged(failedResults(call, e));
      }
      const results: OpResult[] = outcome.steps.map((s) => ({
        op: s.op,
        status: 'succeeded',
        items: itemsOf(s.changes),
        ...(s.report === undefined ? {} : { report: s.report }),
      }));
      if (outcome.dryRun) return unchanged(results);
      const changes = diffProjects(before, outcome.project);
      if (opts.jobId !== undefined && opts.baseVersion !== undefined) {
        const keys = this.jobConflicts(opts.baseVersion, changes);
        if (keys.length > 0) {
          const e = new VoxError(
            'JOB_CONFLICT',
            `Job ${opts.jobId} changes entities edited since version ${opts.baseVersion}: ${keys.join(', ')}`,
            'Run the job again on the current project',
            { details: { keys, jobId: opts.jobId, baseVersion: opts.baseVersion } },
          );
          return unchanged(conflictedResults(call, e));
        }
      }
      if (changes.length === 0) return unchanged(results);
      const now = this.now();
      const ts = now.toISOString();
      const entry: HistoryEntry = {
        version: before.version + 1,
        ts,
        kind: 'op',
        actor: opts.actor,
        ...(opts.runId === undefined ? {} : { runId: opts.runId }),
        ...(opts.jobId === undefined ? {} : { jobId: opts.jobId }),
        op: call.op,
        ...(call.args === undefined ? {} : { args: call.args }),
        ...(opts.coalesceKey === undefined ? {} : { coalesceKey: opts.coalesceKey }),
        changes,
      };
      const prev = this.entries.at(-1);
      if (
        opts.coalesceKey !== undefined &&
        prev?.kind === 'op' &&
        prev.version === before.version &&
        prev.coalesceKey === opts.coalesceKey &&
        prev.actor === opts.actor &&
        prev.runId === opts.runId &&
        now.getTime() - Date.parse(prev.ts) < COALESCE_MS
      ) {
        entry.replaces = prev.version;
        entry.changes = mergeChanges(prev.changes, changes);
      }
      await this.commit(entry, stampProject(outcome.project, entry.version, ts));
      events.push({
        projectId: this.current.id,
        version: entry.version,
        actor: opts.actor,
        ...(opts.runId === undefined ? {} : { runId: opts.runId }),
        op: call.op,
        changes,
      });
      return { version: entry.version, changes, results };
    });
  }

  /** Keys the result touches that an entry after `baseVersion` touched too. */
  private jobConflicts(baseVersion: number, changes: readonly Change[]): string[] {
    const touched = new Set(changes.map((c) => c.key));
    const first = this.entries[0]?.version;
    if (first !== undefined && baseVersion < first - 1) return [...touched].sort(); // rotated away
    const hit = new Set<string>();
    for (const e of this.entries) {
      if (e.version <= baseVersion) continue;
      for (const c of e.changes) if (touched.has(c.key)) hit.add(c.key);
    }
    return [...hit].sort();
  }

  undo(opts: UndoOptions): Promise<ApplyResult> {
    return this.locked(async (events) => {
      const v = this.cursor.undo.at(-1);
      const target = v === undefined ? undefined : this.byVersion.get(v);
      if (!target) throw new VoxError('NOTHING_TO_UNDO', 'Nothing to undo', 'Make an edit first');
      return this.revert([target], 'undo', opts, events);
    });
  }

  undoRun(runId: string, opts: UndoOptions): Promise<ApplyResult> {
    return this.locked(async (events) => {
      const targets = this.cursor.undo
        .map((v) => this.byVersion.get(v))
        .filter((e): e is HistoryEntry => e?.runId === runId);
      if (targets.length === 0) {
        throw new VoxError(
          'NOTHING_TO_UNDO',
          `Run ${runId} has no edits left to undo`,
          'Check the run id in the history',
          { details: { runId } },
        );
      }
      return this.revert(targets, 'undo', opts, events);
    });
  }

  redo(opts: UndoOptions): Promise<ApplyResult> {
    return this.locked(async (events) => {
      const v = this.cursor.redo.at(-1);
      const u = v === undefined ? undefined : this.byVersion.get(v);
      if (!u) throw new VoxError('NOTHING_TO_REDO', 'Nothing to redo', 'Undo an edit first');
      return this.revert([u], 'redo', opts, events);
    });
  }

  /**
   * undo: apply the oldest `before` per key of the targets, after checking each key still holds the
   * newest `after`. redo of an undo entry U: apply U's `before` values (the newest targeted `after`
   * per key), after checking each key still holds U's `after`.
   */
  private async revert(
    targets: HistoryEntry[],
    kind: 'undo' | 'redo',
    opts: UndoOptions,
    events: ProjectChangedEvent[],
  ): Promise<ApplyResult> {
    const sorted = [...targets].sort((a, b) => a.version - b.version);
    const want = new Map<string, Entity | null>();
    const expect = new Map<string, Entity | null>();
    for (const e of sorted) {
      for (const c of e.changes) {
        if (!want.has(c.key)) want.set(c.key, c.before);
        expect.set(c.key, c.after);
      }
    }
    const cur = normalise(this.current);
    const conflicts = [...expect.keys()]
      .filter((k) => !deepEqual(cur.get(k) ?? null, expect.get(k) ?? null))
      .sort();
    if (conflicts.length > 0) {
      throw new VoxError(
        'UNDO_CONFLICT',
        `Changed since by another edit: ${conflicts.join(', ')}`,
        'Undo the later edits first, or edit these entities by hand',
        { details: { keys: conflicts, itemIds: itemIdsOf(conflicts) } },
      );
    }
    const changes: Change[] = [...want.entries()]
      .map(([key, after]) => ({ key, before: cur.get(key) ?? null, after }))
      .filter((c) => !deepEqual(c.before, c.after))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const ts = this.now().toISOString();
    const version = this.current.version + 1;
    const project = applyValues(this.current, want, version, ts);
    const redoTargets = kind === 'redo' ? (sorted[0]!.targets ?? []) : sorted.map((e) => e.version);
    let runId = opts.runId;
    if (kind === 'redo' && runId === undefined) {
      const runs = new Set(redoTargets.map((t) => this.byVersion.get(t)?.runId));
      const only = [...runs][0];
      if (runs.size === 1 && only !== undefined) runId = only;
    }
    const entry: HistoryEntry = {
      version,
      ts,
      kind,
      actor: opts.actor,
      ...(runId === undefined ? {} : { runId }),
      targets: redoTargets,
      changes,
    };
    await this.commit(entry, project);
    events.push({
      projectId: this.current.id,
      version,
      actor: opts.actor,
      ...(runId === undefined ? {} : { runId }),
      op: kind,
      changes,
    });
    return {
      version,
      changes,
      results: [{ op: kind, status: 'succeeded', items: itemsOf(changes) }],
    };
  }

  // ---------------------------------------------------------------- reads, snapshots

  /** Entries of the current history.jsonl after `sinceVersion` (rotated segments not included). */
  async history(opts: { sinceVersion?: number } = {}): Promise<HistoryEntry[]> {
    const since = opts.sinceVersion ?? 0;
    return this.serial(async () => {
      if (!deepEqual(await this.readStamp(), this.fileStamp)) await this.load();
      return this.entries.filter((e) => e.version > since).map((e) => structuredClone(e));
    });
  }

  /** Copy project.json to snapshots/<name>.json; an existing name is never replaced. */
  snapshot(name: string): Promise<SnapshotInfo> {
    const parsed = SnapshotNameSchema.safeParse(name);
    if (!parsed.success) {
      return Promise.reject(
        new VoxError(
          'VALIDATION',
          `Snapshot name ${JSON.stringify(name)} is not allowed`,
          'Use 1–100 characters from A-Z, a-z, 0-9, ".", "_" and "-"',
        ),
      );
    }
    return this.locked(async () => {
      const sdir = join(this.dir, 'snapshots');
      await mkdir(sdir, { recursive: true, mode: 0o700 });
      let fh;
      try {
        fh = await open(join(sdir, `${name}.json`), 'wx', 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new VoxError(
            'SNAPSHOT_EXISTS',
            `Snapshot ${name} already exists`,
            'Pick another name',
            {
              details: { name },
            },
          );
        }
        throw e;
      }
      try {
        await fh.writeFile(this.text);
        await fh.sync();
      } finally {
        await fh.close();
      }
      return { name, version: this.current.version };
    });
  }

  async listSnapshots(): Promise<SnapshotInfo[]> {
    const sdir = join(this.dir, 'snapshots');
    let files: string[];
    try {
      files = await readdir(sdir);
    } catch {
      return [];
    }
    const out: SnapshotInfo[] = [];
    for (const f of files.filter((x) => x.endsWith('.json')).sort()) {
      let version: number | null = null;
      try {
        const v = (JSON.parse(await readFile(join(sdir, f), 'utf8')) as { version?: unknown })
          .version;
        if (typeof v === 'number') version = v;
      } catch {
        version = null;
      }
      out.push({ name: f.slice(0, -'.json'.length), version });
    }
    return out;
  }
}
