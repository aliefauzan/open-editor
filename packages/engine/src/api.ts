// Package entry `@vox/engine` (engine spec "Library API"): the only import other packages use, plus
// the `@vox/engine/paths` subpath. Phase 02: projects, applyOp, view, undo/redo/undoRun, history,
// snapshots and the project.changed event. Later phases add compile, captions, styles, jobs, ….
import { EventEmitter } from 'node:events';
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { VoxError } from './errors.ts';
import { acquireLock } from './history/lock.ts';
import {
  ProjectStore,
  PROJECT_FILE,
  type Migration,
  type SnapshotInfo,
  type UndoOptions,
} from './history/store.ts';
import type {
  ApplyOptions,
  ApplyResult,
  HistoryEntry,
  ProjectChangedEvent,
} from './history/types.ts';
import { newId } from './model/ids.ts';
import { SCHEMA_VERSION, type Project } from './model/schema.ts';
import { findSeq, tracksOf } from './ops/core.ts';
import type { OpCall } from './ops/index.ts';
import { emptyTemplateLookup, type TemplateLookup } from './ops/templates.ts';
import { ensureProjectsDir, isProjectId, projectDirFor } from './paths.ts';

export const version = '0.0.0';

export * from './errors.ts';
export * from './history/types.ts';
export type { Migration, SnapshotInfo, UndoOptions, WriteStep } from './history/store.ts';
export * from './model/schema.ts';
export { FPS_SET, DEFAULT_FPS, ms, frame, snap } from './model/fps.ts';
export type { Entity } from './model/normalise.ts';
export * from './ops/index.ts';
export { computeWordKinds } from './text/fillers.ts';
export * from './paths.ts';

/** External tool paths (ffmpeg, ffprobe, yt-dlp, deno, uv, py env, Chrome); filled in by phase 04. */
export type ToolPaths = Readonly<Record<string, string | undefined>>;

export interface EngineOptions {
  projectsDir: string;
  /** Searched in order; a duplicate style id is an error (spec 2). */
  stylesDirs: readonly string[];
  tools?: ToolPaths;
  /** Template metadata lookup; phase 03 plugs the registry in. */
  templates?: TemplateLookup;
  now?: () => Date;
  migrations?: Readonly<Record<number, Migration>>;
  lockTimeoutMs?: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  version: number;
  updatedAt: string;
}

export interface SequenceViewItem {
  id: string;
  track: string;
  startMs: number;
  endMs: number;
  kind: 'video' | 'audio' | 'image' | 'scene';
  mediaId?: string;
  template?: string;
  /** First string variable of a scene, if any. */
  text?: string;
}

/** Compact read of one sequence for the agent (plan D-15). */
export interface SequenceView {
  version: number;
  items: SequenceViewItem[];
  /** Chunk text; empty until phase 03 plugs in deriveCaptions. */
  captions: { startMs: number; endMs: number; text: string }[];
}

export interface EngineEvents {
  'project.changed': ProjectChangedEvent;
}

export interface Engine {
  readonly projectsDir: string;
  readonly stylesDirs: readonly string[];
  readonly tools: ToolPaths;
  listProjects(): Promise<ProjectSummary[]>;
  createProject(name: string): Promise<Project>;
  getProject(id: string): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  applyOp(projectId: string, op: OpCall, opts: ApplyOptions): Promise<ApplyResult>;
  view(projectId: string, sequenceId: string): Promise<SequenceView>;
  undo(projectId: string, opts?: UndoOptions): Promise<ApplyResult>;
  redo(projectId: string, opts?: UndoOptions): Promise<ApplyResult>;
  undoRun(projectId: string, runId: string, opts?: UndoOptions): Promise<ApplyResult>;
  history(projectId: string, opts?: { sinceVersion?: number }): Promise<HistoryEntry[]>;
  snapshot(projectId: string, name: string): Promise<SnapshotInfo>;
  listSnapshots(projectId: string): Promise<SnapshotInfo[]>;
  /** Subscribe; returns the unsubscribe function. */
  on<K extends keyof EngineEvents>(event: K, handler: (e: EngineEvents[K]) => void): () => void;
}

const USER: UndoOptions = { actor: 'user' };

export function sequenceView(p: Project, sequenceId: string): SequenceView {
  const s = findSeq(p, sequenceId);
  const media = new Map(p.media.map((m) => [m.id, m]));
  const items: (SequenceViewItem & { order: number })[] = [];
  tracksOf(s).forEach((t, order) => {
    const audio = s.audioTracks.some((a) => a.id === t.id);
    for (const it of t.items) {
      const base = {
        id: it.id,
        track: t.id,
        startMs: it.startMs,
        endMs: it.startMs + it.durationMs,
      };
      if (it.type === 'scene') {
        const text = Object.values(it.variables).find((v): v is string => typeof v === 'string');
        items.push({
          ...base,
          kind: 'scene',
          template: it.template,
          ...(text === undefined ? {} : { text }),
          order,
        });
      } else {
        const kind = audio ? 'audio' : media.get(it.mediaId)?.kind === 'image' ? 'image' : 'video';
        items.push({ ...base, kind, mediaId: it.mediaId, order });
      }
    }
  });
  items.sort((a, b) => a.startMs - b.startMs || a.order - b.order || (a.id < b.id ? -1 : 1));
  return { version: p.version, items: items.map(({ order: _o, ...rest }) => rest), captions: [] };
}

export function openEngine(opts: EngineOptions): Engine {
  const emitter = new EventEmitter();
  const stores = new Map<string, Promise<ProjectStore>>();
  const storeOpts = {
    templates: opts.templates ?? emptyTemplateLookup,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.migrations ? { migrations: opts.migrations } : {}),
    ...(opts.lockTimeoutMs !== undefined ? { lock: { timeoutMs: opts.lockTimeoutMs } } : {}),
    onChanged: (e: ProjectChangedEvent) => emitter.emit('project.changed', e),
  };
  const dirOf = (id: string) => {
    if (!isProjectId(id)) {
      throw new VoxError(
        'PROJECT_NOT_FOUND',
        `${JSON.stringify(id)} is not a project id`,
        'Use an id from `vox` project listings (p_…)',
      );
    }
    return projectDirFor(opts.projectsDir, id);
  };
  const store = (id: string): Promise<ProjectStore> => {
    let s = stores.get(id);
    if (!s) {
      s = (async () => ProjectStore.open(dirOf(id), storeOpts))();
      stores.set(id, s);
      s.catch(() => stores.delete(id));
    }
    return s;
  };

  return {
    projectsDir: opts.projectsDir,
    stylesDirs: opts.stylesDirs,
    tools: opts.tools ?? {},

    async listProjects() {
      let names: string[];
      try {
        names = await readdir(opts.projectsDir);
      } catch {
        return [];
      }
      const out: ProjectSummary[] = [];
      for (const id of names.filter(isProjectId).sort()) {
        try {
          const raw = JSON.parse(
            await readFile(join(opts.projectsDir, id, PROJECT_FILE), 'utf8'),
          ) as Partial<Project>;
          if (raw.id !== id) continue;
          out.push({
            id,
            name: typeof raw.name === 'string' ? raw.name : '',
            version: typeof raw.version === 'number' ? raw.version : 0,
            updatedAt: typeof raw.meta?.updatedAt === 'string' ? raw.meta.updatedAt : '',
          });
        } catch {
          continue; // not a project folder
        }
      }
      return out;
    },

    async createProject(name) {
      await ensureProjectsDir(opts.projectsDir);
      const ts = (opts.now ?? (() => new Date()))().toISOString();
      const id = newId('p_');
      const p: Project = {
        schemaVersion: SCHEMA_VERSION,
        id,
        name,
        version: 0,
        media: [],
        sequences: [],
        meta: { createdAt: ts, updatedAt: ts, sourceUrls: [] },
      };
      const s = ProjectStore.create(dirOf(id), p, storeOpts);
      stores.set(id, s);
      return (await s).project;
    },

    async getProject(id) {
      return (await store(id)).read();
    },

    async deleteProject(id) {
      const dir = dirOf(id);
      const st = await lstat(dir).catch(() => undefined);
      if (!st || !st.isDirectory()) {
        throw new VoxError(
          'PROJECT_NOT_FOUND',
          `No project ${id}`,
          'Check the id with `vox` project listings',
        );
      }
      const release = await acquireLock(
        dir,
        opts.lockTimeoutMs === undefined ? {} : { timeoutMs: opts.lockTimeoutMs },
      );
      try {
        await rm(dir, { recursive: true, force: true });
      } finally {
        stores.delete(id);
        await release().catch(() => undefined);
      }
    },

    async applyOp(projectId, op, applyOpts) {
      return (await store(projectId)).apply(op, applyOpts);
    },

    async view(projectId, sequenceId) {
      return sequenceView(await (await store(projectId)).read(), sequenceId);
    },

    async undo(projectId, o = USER) {
      return (await store(projectId)).undo(o);
    },
    async redo(projectId, o = USER) {
      return (await store(projectId)).redo(o);
    },
    async undoRun(projectId, runId, o = USER) {
      return (await store(projectId)).undoRun(runId, o);
    },
    async history(projectId, o = {}) {
      return (await store(projectId)).history(o);
    },
    async snapshot(projectId, name) {
      return (await store(projectId)).snapshot(name);
    },
    async listSnapshots(projectId) {
      return (await store(projectId)).listSnapshots();
    },

    on(event, handler) {
      emitter.on(event, handler);
      return () => emitter.off(event, handler);
    },
  };
}
