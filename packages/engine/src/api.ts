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
import type { TemplateLookup } from './ops/templates.ts';
import { ensureProjectsDir, isProjectId, projectDirFor, resolveProjectPath } from './paths.ts';
import {
  compileSequence,
  type BuildResult,
  type CompileOptions,
  type FramingProvider,
} from './compile/compile.ts';
import { buildDirFor, writeBuildTo } from './compile/write.ts';
import { search as geoSearch, type Place } from './geo/search.ts';
import { chunkLines, deriveCaptions, type CaptionChunk } from './model/captions.ts';
import { TranscriptSchema, type Transcript } from './model/schema.ts';
import { registryTemplateLookup } from './styles/lookup.ts';
import {
  loadStyleRegistry,
  type ResolvedStyle,
  type StyleProblem,
  type StyleRegistry,
  type StyleSummary,
} from './styles/registry.ts';

export const version = '0.0.0';

// The public surface, listed by name so a new internal export never leaks into the contract.
export {
  ERROR_CODES,
  VoxError,
  isVoxError,
  toVoxErrorJson,
  type ErrorCode,
  type VoxErrorJson,
  type VoxErrorOptions,
} from './errors.ts';
export {
  ACTORS,
  HistoryEntrySchema,
  type Actor,
  type ApplyOptions,
  type ApplyResult,
  type Change,
  type HistoryEntry,
  type ItemEntity,
  type OpResult,
  type ProjectChangedEvent,
} from './history/types.ts';
export type { Migration, SnapshotInfo, UndoOptions, WriteStep } from './history/store.ts';
export {
  AudioTrackIdSchema,
  AudioTrackSchema,
  CanvasFpsSchema,
  CanvasSchema,
  CaptionOverrideSchema,
  CaptionTrackSchema,
  DenoiseSchema,
  FpsSchema,
  FrameSchema,
  ItemIdSchema,
  ItemSchema,
  KeyframeSchema,
  LinkIdSchema,
  MediaClipSchema,
  MediaIdSchema,
  MediaItemSchema,
  MediaKindSchema,
  MotionSchema,
  ProjectSchema,
  SCHEMA_VERSION,
  SceneClipSchema,
  SequenceIdSchema,
  SequenceSchema,
  TemplateIdSchema,
  TrackIdSchema,
  TrackSchema,
  TranscriptSchema,
  TranscriptWordSchema,
  TransitionInSchema,
  VideoTrackIdSchema,
  VideoTrackSchema,
  WordKeySchema,
  formatIssues,
  parseProject,
  type CaptionOverride,
  type CaptionTrack,
  type Fps,
  type Frame,
  type Item,
  type Keyframe,
  type MediaClip,
  type MediaItem,
  type MediaKind,
  type Project,
  type SceneClip,
  type Sequence,
  type Track,
  type Transcript,
  type TranscriptWord,
  type WordKind,
} from './model/schema.ts';
export { FPS_SET, DEFAULT_FPS, ms, frame, snap } from './model/fps.ts';
export type { Entity } from './model/normalise.ts';
export {
  CAPTION_DEFAULTS,
  OP_ARGS,
  OP_NAMES,
  OpCallSchema,
  SnapshotNameSchema,
  addMediaArgs,
  addSceneArgs,
  addSequenceArgs,
  addTrackArgs,
  batchArgs,
  duplicateSequenceArgs,
  emptyTemplateLookup,
  isOpName,
  linkArgs,
  mapTemplateLookup,
  mapWordsToTimeline,
  moveItemArgs,
  parseWordKey,
  pasteItemsArgs,
  placeClipArgs,
  removeItemArgs,
  removeMediaArgs,
  removePausesArgs,
  removeSequenceArgs,
  removeTrackArgs,
  removeWordsArgs,
  reorderTracksArgs,
  replaceMediaArgs,
  requireTemplate,
  restoreSnapshotArgs,
  rippleDeleteArgs,
  runOp,
  setCaptionsArgs,
  setTransitionArgs,
  slotValues,
  splitItemArgs,
  switchVariables,
  trimItemArgs,
  unlinkArgs,
  updateClipArgs,
  updateMediaArgs,
  updateSceneArgs,
  updateSequenceArgs,
  updateTrackArgs,
  validateVariables,
  wordSourceTracks,
  type CutRange,
  type OpCall,
  type OpContext,
  type OpName,
  type OpOutcome,
  type SfxCueInfo,
  type SingleOpName,
  type SlotKind,
  type StepOutcome,
  type TemplateInfo,
  type TemplateLookup,
  type TimelineWord,
} from './ops/index.ts';
export { computeWordKinds } from './text/fillers.ts';
export {
  captionsToSrt,
  captionsToVtt,
  chunkLines,
  deriveCaptions,
  type CaptionChunk,
  type CaptionWord,
  type TranscriptOf,
} from './model/captions.ts';
export type {
  BuildResult,
  CompileMode,
  CompileOptions,
  FramingProvider,
} from './compile/compile.ts';
export { cueList, type Cue, type CueDropReason, type CueList } from './audio/cues.ts';
export type { Place } from './geo/search.ts';
export type {
  ResolvedStyle,
  StyleProblem,
  StyleRegistry,
  StyleSummary,
  TemplateDef,
} from './styles/registry.ts';
export {
  checkRelativePath,
  ensureProjectsDir,
  isProjectId,
  projectDirFor,
  resolveProjectPath,
  resolveProjectsDir,
  type ProjectsDirInput,
  type ProjectsDirSource,
  type ResolveOptions,
} from './paths.ts';

/** External tool paths (ffmpeg, ffprobe, yt-dlp, deno, uv, py env, Chrome); filled in by phase 04. */
export type ToolPaths = Readonly<Record<string, string | undefined>>;

export interface EngineOptions {
  projectsDir: string;
  /** Searched in order; a duplicate style id is an error (spec 2). */
  stylesDirs: readonly string[];
  tools?: ToolPaths;
  /** Template metadata lookup; default: the style registry over `stylesDirs`. */
  templates?: TemplateLookup;
  /** Trust of a style outside the built-in folder (S8); default untrusted. */
  isTrusted?: (styleId: string, dir: string) => boolean;
  /** Crop path provider for `facetrack`/`auto` clips (phase 05 plugs in the facetrack path). */
  framing?: FramingProvider;
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
  /** Chunk text (lines joined by a space), from deriveCaptions. */
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
  compile(projectId: string, sequenceId: string, opts: CompileOptions): Promise<BuildResult>;
  /** Writes a build to `build/<sequenceId>/` of its project; returns that folder. */
  writeBuild(result: BuildResult): Promise<string>;
  captions(projectId: string, sequenceId: string): Promise<CaptionChunk[]>;
  styles: {
    list(): StyleSummary[];
    get(styleId: string): ResolvedStyle;
    problems(): StyleProblem[];
    /** `vox` when installed and valid, else `base` (the style new projects get). */
    defaultId(): string;
    /** Re-reads the style folders (after a style is added or edited). */
    reload(): void;
  };
  geo: { search(query: string, opts?: { limit?: number }): Place[] };
  /** Subscribe; returns the unsubscribe function. */
  on<K extends keyof EngineEvents>(event: K, handler: (e: EngineEvents[K]) => void): () => void;
}

const USER: UndoOptions = { actor: 'user' };

export function sequenceView(
  p: Project,
  sequenceId: string,
  captions: readonly CaptionChunk[] = [],
): SequenceView {
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
  return {
    version: p.version,
    items: items.map(({ order: _o, ...rest }) => rest),
    captions: captions.map((c) => ({
      startMs: c.startMs,
      endMs: c.endMs,
      text: chunkLines(c).join(' '),
    })),
  };
}

export function openEngine(opts: EngineOptions): Engine {
  const emitter = new EventEmitter();
  const stores = new Map<string, Promise<ProjectStore>>();
  let reg: StyleRegistry | undefined;
  const registry = (): StyleRegistry =>
    (reg ??= loadStyleRegistry({
      stylesDirs: opts.stylesDirs,
      ...(opts.isTrusted ? { isTrusted: opts.isTrusted } : {}),
    }));
  const storeOpts = {
    templates: opts.templates ?? registryTemplateLookup(registry),
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
  const notFound = (id: string) =>
    new VoxError(
      'PROJECT_NOT_FOUND',
      `No project ${id}`,
      'Check the id with `vox` project listings',
    );
  /** Cache a store; a store that failed to open or create is dropped so the next call retries. */
  const remember = (id: string, s: Promise<ProjectStore>): Promise<ProjectStore> => {
    stores.set(id, s);
    s.catch(() => {
      if (stores.get(id) === s) stores.delete(id);
    });
    return s;
  };
  const store = (id: string): Promise<ProjectStore> =>
    stores.get(id) ??
    remember(
      id,
      (async () => {
        const dir = dirOf(id);
        // A real folder only: a symlink could point the store at files outside the projects folder.
        const st = await lstat(dir).catch(() => undefined);
        if (!st?.isDirectory()) throw notFound(id);
        const opened = await ProjectStore.open(dir, storeOpts);
        if (opened.project.id !== id) {
          throw new VoxError(
            'VALIDATION',
            `project.json in folder ${id} belongs to project ${opened.project.id}`,
            'Name the folder after the project id, or restore project.json from snapshots/',
            { details: { folder: id, projectId: opened.project.id } },
          );
        }
        return opened;
      })(),
    );

  /** Transcripts of the project's media, read from `transcriptPath` (unreadable ones are skipped). */
  const transcripts = async (projectId: string, p: Project): Promise<Map<string, Transcript>> => {
    const out = new Map<string, Transcript>();
    for (const m of p.media) {
      if (!m.transcriptPath) continue;
      try {
        const file = await resolveProjectPath(dirOf(projectId), m.transcriptPath);
        const r = TranscriptSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
        if (r.success) out.set(m.id, r.data);
      } catch {
        continue;
      }
    }
    return out;
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
      return (await remember(id, ProjectStore.create(dirOf(id), p, storeOpts))).project;
    },

    async getProject(id) {
      return (await store(id)).read();
    },

    async deleteProject(id) {
      const dir = dirOf(id);
      const st = await lstat(dir).catch(() => undefined);
      if (!st?.isDirectory()) throw notFound(id);
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
      const p = await (await store(projectId)).read();
      findSeq(p, sequenceId);
      const tr = await transcripts(projectId, p);
      return sequenceView(
        p,
        sequenceId,
        deriveCaptions(p, sequenceId, (m) => tr.get(m.id)),
      );
    },

    async captions(projectId, sequenceId) {
      const p = await (await store(projectId)).read();
      findSeq(p, sequenceId);
      const tr = await transcripts(projectId, p);
      return deriveCaptions(p, sequenceId, (m) => tr.get(m.id));
    },

    async compile(projectId, sequenceId, o) {
      const p = await (await store(projectId)).read();
      const tr = await transcripts(projectId, p);
      return compileSequence(
        {
          project: p,
          projectDir: dirOf(projectId),
          sequenceId,
          registry: registry(),
          transcriptOf: (m) => tr.get(m.id),
          ...(opts.framing ? { framing: opts.framing } : {}),
        },
        o,
      );
    },

    async writeBuild(result) {
      return writeBuildTo(result, buildDirFor(result.projectDir, result.sequenceId));
    },

    styles: {
      list: () => registry().list(),
      get: (id) => registry().get(id),
      problems: () => registry().problems(),
      defaultId: () =>
        registry()
          .list()
          .some((s) => s.id === 'vox')
          ? 'vox'
          : 'base',
      reload: () => {
        reg = undefined;
      },
    },

    geo: {
      search(query, o = {}) {
        if (typeof query !== 'string' || query.trim() === '') {
          throw new VoxError('VALIDATION', 'Empty place query', 'Pass a place name, e.g. "lisbon"');
        }
        return geoSearch(query, o);
      },
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
