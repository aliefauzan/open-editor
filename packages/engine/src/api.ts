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
import { spanMs, speedOf } from './model/speed.ts';
import { findSeq, tracksOf } from './ops/core.ts';
import type { OpCall } from './ops/index.ts';
import type { TemplateLookup } from './ops/templates.ts';
import { ensureProjectsDir, isProjectId, projectDirFor, resolveProjectPath } from './paths.ts';
import { cueList } from './audio/cues.ts';
import { renderMix, type LoudnessPreset, type MixResult } from './audio/graph.ts';
import {
  applyRange,
  compileSequence,
  type BuildResult,
  type CompileOptions,
  type FramingProvider,
} from './compile/compile.ts';
import { buildDirFor, writeBuildTo } from './compile/write.ts';
import { renderLayerBuild } from './render/layers.ts';
import { search as geoSearch, type Place } from './geo/search.ts';
import { chunkLines, deriveCaptions, type CaptionChunk } from './model/captions.ts';
import { TranscriptSchema, type Transcript } from './model/schema.ts';
import { registryTemplateLookup } from './styles/lookup.ts';
import { readConfig, type Config } from './config.ts';
import { createJobRunner, type JobEventName, type JobEvents, type JobRunner } from './jobs.ts';
import { activeAreaOf, registerMediaJobs, type MediaApi } from './media-api.ts';
import { registerQuickClipJobs } from './quick-api.ts';
import type { QuickClipScorer } from './stages/quickClips.ts';
import {
  applyClipFraming,
  staticTrackPath,
  trackOptionsFromFrame,
  type Area,
  type TrackPath,
  type TrackPathOptions,
} from './stages/facetrack.ts';
import { createMfluxProviders, registerImagegenJobs } from './imagegen.ts';
import { createImageProviders, registerAssetJobs, type ImageProvider } from './assets-api.ts';
export {
  IMAGE_MODELS,
  IMAGE_MODEL_IDS,
  hfTokenPresent,
  imagegenStatus,
  isInstalled as isImageModelInstalled,
  type ImageModelId,
  type ImageModelInfo,
  type ImageModelStatus,
  type ImagegenInstallResult,
  type ImagegenRemoveResult,
} from './imagegen.ts';
import type { GetJson } from './stages/assets.ts';
import {
  registerExportJobs,
  type CreditLine,
  type ExportApi,
  type HyperframesRun,
} from './export-api.ts';
import { doctor, doctorProject, type DoctorReport, type ProjectDoctorReport } from './doctor.ts';
import { ProjectSchema } from './model/schema.ts';
import type { Resolver } from './net/address.ts';
import type { Dial } from './net/proxy.ts';
import { redactor as sharedRedactor, type Redactor } from './redact.ts';
import {
  loadStyleRegistry,
  type ResolvedStyle,
  type StyleProblem,
  type StyleRegistry,
  type StyleSummary,
} from './styles/registry.ts';
import {
  acceptStyle,
  newStyle,
  openTrustStore,
  removeStyle,
  trustStyle,
  type TrustStore,
} from './styles/manage.ts';
import { repoPyProject } from './py.ts';
import { validateStyle, type ValidateOptions, type ValidateReport } from './styles/validate.ts';

export const version = '1.0.0';

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
export { hyperframesBin, renderLayerBuild, type LayerRenderOptions } from './render/layers.ts';
export {
  DENOISE_FILTERS,
  LOUDNESS_TARGETS,
  loudnormPass1,
  loudnormPass2,
  mixGraph,
  renderMix,
  TRUE_PEAK_DBTP,
  type LoudnessPreset,
  type LoudnormMeasure,
  type MixGraph,
  type MixInput,
  type MixOptions,
  type MixResult,
  type StemKind,
} from './audio/graph.ts';
export type { Place } from './geo/search.ts';
export type {
  ResolvedStyle,
  StyleProblem,
  StyleRegistry,
  StyleSummary,
  TemplateDef,
} from './styles/registry.ts';
export { openTrustStore, styleCodeHash, type TrustStore } from './styles/manage.ts';
export type { ValidateProblem, ValidateReport } from './styles/validate.ts';
export {
  closestFont,
  loadFontCatalogue,
  type FontCatalogue,
  type FontEntry,
} from './styles/extract/catalogue.ts';
export {
  repairDescription,
  StyleDescriptionSchema,
  type StyleDescription,
} from './styles/extract/description.ts';
export {
  mapDraftStyle,
  plainText,
  type DraftStyle,
  type MapInput,
  type StyleSource,
} from './styles/extract/map.ts';
export {
  MeasurementsSchema,
  measureReference,
  type Measurements,
  type MeasureOptions,
} from './styles/extract/measure.ts';
export {
  reportHtml,
  writeDraftStyle,
  writeStyleReport,
  type ReportInput,
} from './styles/extract/write.ts';
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
export {
  ConfigSchema,
  configPath,
  readConfig,
  voxHome,
  writeConfig,
  type Config,
  type ConfigPatch,
} from './config.ts';
export { createRedactor, REDACTED, type Redactor } from './redact.ts';
export type {
  JobContext,
  JobError,
  JobEventName,
  JobEvents,
  JobHandler,
  JobInfo,
  JobRunner,
  JobStatus,
} from './jobs.ts';
export { TOOL_NAMES, resolveToolPaths, which, type ToolName } from './tools.ts';
export { resourceDirs, setResourceDirs, type ResourceDirs } from './resources.ts';
export { repoPyProject } from './py.ts';
export {
  FACE_MODEL,
  FacetrackJobArgsSchema,
  IngestJobArgsSchema,
  ShotsJobArgsSchema,
  TranscribeJobArgsSchema,
  ensureFaceModel,
  type FacetrackJobResult,
  type IngestJobArgs,
  type IngestJobResult,
  type MediaJobArgs,
  type ShotsJobResult,
  type TranscribeJobArgs,
  type TranscribeJobResult,
} from './media-api.ts';
export { classifyUrl, type UrlKind } from './stages/sources.ts';
export {
  RENDER_QUALITIES,
  hyperframesEnv,
  muxArgs,
  pictureRenderArgs,
  type AudioQaResult,
  type CreditLine,
  type HyperframesRun,
  type RenderJobArgs,
  type RenderJobResult,
  type RenderQuality,
  type RenderedFile,
  type TimelineResult,
} from './export-api.ts';
export {
  QuickClipsArgsSchema,
  quickClipFps,
  type QuickClip,
  type QuickClipsArgs,
  type QuickClipsResult,
} from './quick-api.ts';
export {
  HEURISTIC,
  heuristicScores,
  pickClips,
  quickCandidates,
  sentenceUnits,
  type Candidate as QuickCandidate,
  type QuickClipScorer,
  type ScorerInput,
} from './stages/quickClips.ts';
export {
  CUTOUT_MODEL,
  type AssetMediaResult,
  type ImageProvider,
  type ImageRequest,
} from './assets-api.ts';
export {
  BY_SA_WARNING,
  LICENSES,
  classifyLicense,
  type AssetCandidate,
  type License,
  type SearchResult as AssetSearchResult,
} from './stages/assets.ts';
export type { CheckLevel, DoctorCheck, DoctorReport, ProjectDoctorReport } from './doctor.ts';
export { SILERO_SHA256 } from './doctor.ts';
export { LOGIN_REQUIRED_HINT } from './stages/ytdlp.ts';
export { WHISPER_REPO, WHISPER_REVISION } from './stages/transcribe.ts';
export type { TrackPath, TrackPathOptions, ShotFraming } from './stages/facetrack.ts';

/** External tool paths (ffmpeg, ffprobe, yt-dlp, deno, uv, py env, Chrome); filled in by phase 04. */
export type ToolPaths = Readonly<Record<string, string | undefined>>;

/** `engine.mix` options: the output WAV, the loudness preset, optional stems and range. */
export interface MixRequest {
  out: string;
  preset?: LoudnessPreset;
  normalize?: boolean;
  stemsDir?: string;
  range?: { startMs: number; endMs: number };
}

export interface EngineOptions {
  projectsDir: string;
  /** Searched in order; a duplicate style id is an error (spec 2). */
  stylesDirs: readonly string[];
  tools?: ToolPaths;
  /** Template metadata lookup; default: the style registry over `stylesDirs`. */
  templates?: TemplateLookup;
  /** Trust of a style outside the built-in folder (S8); default: `trustFile`, else untrusted. */
  isTrusted?: (styleId: string, dir: string) => boolean;
  /** Trust store (`<voxHome>/trust.json`, S8): read by the default `isTrusted`, written by `styles.trust`. */
  trustFile?: string;
  /** Crop path provider for `facetrack`/`auto` clips (phase 05 plugs in the facetrack path). */
  framing?: FramingProvider;
  now?: () => Date;
  migrations?: Readonly<Record<number, Migration>>;
  lockTimeoutMs?: number;
  /** User config reader; default `readConfig` (`~/.vox/config.json`). */
  config?: () => Promise<Config>;
  /** Default: the shared `redactor` (S19). */
  redactor?: Redactor;
  jobs?: { concurrency?: number };
  /** Test seams for downloads (no internet in tests). */
  net?: { resolver?: Resolver; dial?: Dial };
  /** Test seams for archive search and fetch (recorded replies, local HTTPS, no back-off). */
  assets?: {
    getJson?: GetJson;
    commonsThrottle?: (signal?: AbortSignal) => Promise<void>;
    ca?: string;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  };
  /** Test seams for the local image model install: free disk space and the environment (HF_TOKEN). */
  imagegen?: { freeBytes?: (dir: string) => number; env?: NodeJS.ProcessEnv };
  /** Test seam: runs the HyperFrames CLI (render, snapshot). */
  hyperframes?: HyperframesRun;
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
  /** Media clips with a speed other than 1 (v1.1, plan D-62). */
  speed?: number;
}

/** Compact read of one sequence for the agent (plan D-15). */
export interface SequenceView {
  version: number;
  items: SequenceViewItem[];
  /** Chunk text (lines joined by a space), from deriveCaptions. */
  captions: { startMs: number; endMs: number; text: string }[];
}

export interface EngineEvents extends JobEvents {
  'project.changed': ProjectChangedEvent;
}

export interface Engine {
  readonly projectsDir: string;
  readonly stylesDirs: readonly string[];
  readonly tools: ToolPaths;
  /** Shared secret redactor (S19): errors, job payloads, logs and events go through it. */
  readonly redactor: Redactor;
  /** Job runner: `ingest`, `transcribe` (GPU), `shots`, `facetrack`, `quickClips`, `assets.*`, `render`, `frames`, `exportCaptions`, `exportTimeline`, `audioQa`. */
  readonly jobs: JobRunner;
  facetrackPath: MediaApi['facetrackPath'];
  /**
   * Image generation providers (engine spec "Image generation provider"); none is built in. The
   * most recently registered one is the default of `assets.generate`.
   */
  imageProviders: { register(p: ImageProvider): void; list(): { id: string }[] };
  /**
   * Quick clips scorers (engine spec "Quick clips"): the job `quickClips` uses the most recently
   * registered one unless `scorer` names another (`heuristic` = the built-in one).
   */
  quickClips: { registerScorer(id: string, fn: QuickClipScorer): void; scorers(): string[] };
  /** Compiled stills at canvas size (PNG paths, cached by build and time; first sequence by default). */
  frames(projectId: string, sequenceId: string | undefined, atMs: number[]): Promise<string[]>;
  /** Archive assets the sequences use, with author, licence and link (`vox credits`). */
  credits(projectId: string): Promise<CreditLine[]>;
  /** Compiles and writes the preview build; returns the `npx hyperframes play <buildDir>` call. */
  preview: ExportApi['preview'];
  mediaFrames: MediaApi['mediaFrames'];
  /** Tool, model and config checks (`vox doctor`); `quick` skips the Python import check. */
  doctor(opts?: { quick?: boolean }): Promise<DoctorReport>;
  /** Project checks (`vox doctor <project>`); `unlock` removes `project.lock`. */
  doctorProject(projectId: string, opts?: { unlock?: boolean }): Promise<ProjectDoctorReport>;
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
  /**
   * The final audio mix of a sequence (engine spec "Audio"): a WAV at `out`, two-pass `loudnorm` to
   * the preset (default youtube), and the stems when `stemsDir` is given.
   */
  mix(projectId: string, sequenceId: string, opts: MixRequest): Promise<MixResult>;
  /**
   * Chosen layers (scene item ids, `<itemId>-tx`, `overlay-<name>`, `captions`) to a ProRes 4444 MOV
   * with alpha at `out` (engine spec "Layer renderer"); returns `out`.
   */
  renderLayers(
    projectId: string,
    sequenceId: string,
    layers: string[],
    opts: { out: string; range?: { startMs: number; endMs: number } },
  ): Promise<string>;
  captions(projectId: string, sequenceId: string): Promise<CaptionChunk[]>;
  styles: {
    list(): StyleSummary[];
    get(styleId: string): ResolvedStyle;
    problems(): StyleProblem[];
    /** `vox` when installed and valid, else `base` (the style new projects get). */
    defaultId(): string;
    /** Re-reads the style folders (after a style is added or edited). */
    reload(): void;
    /** `vox style new`: a draft partial child in the last styles folder (the user folder). */
    create(o: { id: string; extends?: string; name?: string }): { id: string; dir: string };
    /** Marks a draft user style `active`. */
    accept(styleId: string): void;
    /** Deletes a user style folder and forgets its trust; fails while another style extends it. */
    remove(styleId: string): void;
    /** Trusts a user style's hook code as it is now (S8); needs `trustFile`. */
    trust(styleId: string): void;
    /** `vox style validate` (phase 06). */
    validate(
      styleId: string,
      o?: Pick<ValidateOptions, 'render' | 'dom' | 'previews' | 'onProgress'>,
    ): Promise<ValidateReport>;
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
        const speed = it.speed !== undefined && it.speed !== 1 ? { speed: it.speed } : {};
        items.push({ ...base, kind, mediaId: it.mediaId, ...speed, order });
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
  const redactor = opts.redactor ?? sharedRedactor;
  const jobs = createJobRunner({
    redactor,
    ...(opts.jobs?.concurrency ? { concurrency: opts.jobs.concurrency } : {}),
  });
  const JOB_EVENTS: readonly JobEventName[] = [
    'job.started',
    'job.progress',
    'job.done',
    'job.failed',
    'job.cancelled',
  ];
  for (const name of JOB_EVENTS) jobs.on(name, (payload) => emitter.emit(name, payload));
  const stores = new Map<string, Promise<ProjectStore>>();
  let reg: StyleRegistry | undefined;
  let trustStore: TrustStore | undefined;
  const trusts = (): TrustStore => {
    if (!opts.trustFile) {
      throw new VoxError(
        'VALIDATION',
        'No trust store configured',
        'Open the engine with trustFile',
      );
    }
    return (trustStore ??= openTrustStore(opts.trustFile));
  };
  const isTrusted =
    opts.isTrusted ??
    (opts.trustFile ? (id: string, dir: string) => trusts().isTrusted(id, dir) : undefined);
  const registry = (): StyleRegistry =>
    (reg ??= loadStyleRegistry({
      stylesDirs: opts.stylesDirs,
      ...(isTrusted ? { isTrusted } : {}),
    }));
  const storeOpts = {
    templates: opts.templates ?? registryTemplateLookup(registry),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.migrations ? { migrations: opts.migrations } : {}),
    ...(opts.lockTimeoutMs !== undefined ? { lock: { timeoutMs: opts.lockTimeoutMs } } : {}),
    onChanged: (e: ProjectChangedEvent) => emitter.emit('project.changed', e),
    log: { redact: (line: string) => redactor.redact(line) },
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

  const media = registerMediaJobs(jobs, {
    tools: opts.tools ?? {},
    redactor,
    store,
    dirOf,
    config: opts.config ?? readConfig,
    ...(opts.net ? { net: opts.net } : {}),
  });
  const imageProviders = createImageProviders();
  if (opts.tools?.['models']) {
    // Local mflux models (phase 14d): each provider shows up once its model is installed.
    for (const p of createMfluxProviders({ tools: opts.tools, redactor }))
      imageProviders.register(p);
    registerImagegenJobs(jobs, { tools: opts.tools, redactor, ...opts.imagegen });
  }
  registerAssetJobs(jobs, {
    tools: opts.tools ?? {},
    redactor,
    store,
    dirOf,
    config: opts.config ?? readConfig,
    ...(opts.net ? { net: opts.net } : {}),
    version,
    providers: imageProviders,
    ...(opts.assets?.getJson ? { getJson: opts.assets.getJson } : {}),
    ...(opts.assets?.commonsThrottle ? { commonsThrottle: opts.assets.commonsThrottle } : {}),
    ...(opts.assets?.ca ? { ca: opts.assets.ca } : {}),
    ...(opts.assets?.sleep ? { sleep: opts.assets.sleep } : {}),
  });
  const quick = registerQuickClipJobs(jobs, { store, dirOf });
  // The export jobs call the engine's own compile, mix and captions (bound once `engine` exists).
  const bound: { engine?: Engine } = {};
  const me = (): Engine => bound.engine!;
  const exports = registerExportJobs(jobs, {
    tools: opts.tools ?? {},
    redactor,
    store,
    dirOf,
    compile: (projectId, sequenceId, o) => me().compile(projectId, sequenceId, o),
    mix: (projectId, sequenceId, o) => me().mix(projectId, sequenceId, o),
    captions: (projectId, sequenceId) => me().captions(projectId, sequenceId),
    style: (id) => registry().get(id),
    ...(opts.hyperframes ? { hyperframes: opts.hyperframes } : {}),
  });

  /**
   * The facetrack path provider (phase 05, replacing 03's stub): for each `facetrack`/`auto` clip
   * whose media has shots and a facetrack, the tracked path is built (cached) before compile; the
   * synchronous provider then cuts it to the clip it is given (after any range) with the user's pins.
   * A clip without them keeps its static crop, pulled inside the media's active area when ingest
   * found black bars in the picture (`cache/media/<id>.json`); the tracked path stays inside it too.
   */
  async function trackedFraming(
    projectId: string,
    p: Project,
    sequenceId: string,
  ): Promise<FramingProvider> {
    const s = p.sequences.find((x) => x.id === sequenceId);
    const paths = new Map<string, TrackPath>();
    const areas = new Map<string, Area | undefined>();
    const keyOf = (mediaId: string, o: TrackPathOptions) => `${mediaId}|${JSON.stringify(o)}`;
    if (s) {
      const aspect = { width: s.canvas.width, height: s.canvas.height };
      for (const t of s.videoTracks) {
        for (const it of t.items) {
          if (it.type !== 'media' || (it.frame?.mode !== 'facetrack' && it.frame?.mode !== 'auto'))
            continue;
          const m = p.media.find((x) => x.id === it.mediaId);
          if (!m) continue;
          if (!areas.has(m.id)) areas.set(m.id, await activeAreaOf(dirOf(projectId), m));
          if (!m.facetrackPath || !m.shotsPath) continue;
          const o = trackOptionsFromFrame(it.frame, aspect);
          const k = keyOf(m.id, o);
          if (!paths.has(k)) paths.set(k, await media.facetrackPath(projectId, m.id, o));
        }
      }
    }
    return (m, clip, seq) => {
      if (!clip.frame || (clip.frame.mode !== 'facetrack' && clip.frame.mode !== 'auto'))
        return undefined;
      const o = trackOptionsFromFrame(clip.frame, {
        width: seq.canvas.width,
        height: seq.canvas.height,
      });
      let path = paths.get(keyOf(m.id, o));
      if (!path) {
        const area = areas.get(m.id);
        if (!area || !m.width || !m.height) return undefined;
        path = staticTrackPath({ width: m.width, height: m.height }, o.aspect, area, clip.frame);
      }
      // the tracked path is in source time: frame the source span, then bring the keyframe times
      // back to item-relative timeline time (clip speed, plan D-62)
      const sp = speedOf(clip);
      const kfs = applyClipFraming(path, {
        inMs: clip.inMs,
        durationMs: spanMs(clip),
        ...(clip.frame.keyframes
          ? {
              keyframes: clip.frame.keyframes.map((k) => ({ ...k, atMs: Math.round(k.atMs * sp) })),
            }
          : {}),
      });
      return sp === 1 ? kfs : kfs.map((k) => ({ ...k, atMs: Math.round(k.atMs / sp) }));
    };
  }

  const engine: Engine = {
    projectsDir: opts.projectsDir,
    stylesDirs: opts.stylesDirs,
    tools: opts.tools ?? {},
    redactor,
    jobs,
    facetrackPath: (projectId, mediaId, o) => media.facetrackPath(projectId, mediaId, o),
    frames: (projectId, sequenceId, atMs) => exports.frames(projectId, sequenceId, atMs),
    credits: (projectId) => exports.credits(projectId),
    preview: (projectId, sequenceId) => exports.preview(projectId, sequenceId),
    imageProviders: {
      register: (p) => imageProviders.register(p),
      list: () => imageProviders.list(),
    },
    quickClips: {
      registerScorer: (id, fn) => quick.registerScorer(id, fn),
      scorers: () => quick.scorers(),
    },
    mediaFrames: (projectId, mediaId, atMs) => media.mediaFrames(projectId, mediaId, atMs),
    async doctor(o = {}) {
      return doctor({
        tools: opts.tools ?? {},
        config: await (opts.config ?? readConfig)(),
        ...(o.quick ? { quick: true } : {}),
      });
    },
    async doctorProject(projectId, o = {}) {
      const dir = dirOf(projectId);
      const st = await lstat(dir).catch(() => undefined);
      if (!st?.isDirectory()) throw notFound(projectId);
      // Read the file directly: a held lock must not stop the check that clears it.
      const p = ProjectSchema.parse(JSON.parse(await readFile(join(dir, PROJECT_FILE), 'utf8')));
      const tr = await transcripts(projectId, p);
      if (o.unlock) stores.delete(projectId);
      return doctorProject(dir, p, (id) => tr.get(id), o);
    },

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
          framing: opts.framing ?? (await trackedFraming(projectId, p, sequenceId)),
        },
        o,
      );
    },

    async writeBuild(result) {
      return writeBuildTo(result, buildDirFor(result.projectDir, result.sequenceId));
    },

    async renderLayers(projectId, sequenceId, layers, o) {
      const p = await (await store(projectId)).read();
      const tr = await transcripts(projectId, p);
      const b = await compileSequence(
        {
          project: p,
          projectDir: dirOf(projectId),
          sequenceId,
          registry: registry(),
          transcriptOf: (m) => tr.get(m.id),
          framing: opts.framing ?? (await trackedFraming(projectId, p, sequenceId)),
        },
        { mode: 'render', layers, ...(o.range ? { range: o.range } : {}) },
      );
      return renderLayerBuild(b, {
        buildDir: buildDirFor(dirOf(projectId), `${sequenceId}-layers`),
        out: o.out,
      });
    },

    async mix(projectId, sequenceId, o) {
      const p = await (await store(projectId)).read();
      const s0 = findSeq(p, sequenceId);
      const s = o.range ? applyRange(s0, o.range, []) : s0;
      const reg = registry();
      const ends = [...s.videoTracks, ...s.audioTracks].flatMap((t) =>
        t.items.map((i) => i.startMs + i.durationMs),
      );
      return renderMix(
        {
          seq: s,
          media: p.media,
          projectDir: dirOf(projectId),
          cues: cueList(
            s,
            registryTemplateLookup(() => reg),
          ).cues,
          sfxFiles: reg.get(s.styleId).files.sfx,
          durationMs: o.range ? o.range.endMs - o.range.startMs : Math.max(0, ...ends),
          preset: o.preset ?? 'youtube',
        },
        // the live tool map: setup may find ffmpeg after the engine opened (D-45)
        { ...o, ...(opts.tools?.['ffmpeg'] ? { ffmpeg: opts.tools['ffmpeg'] } : {}) },
      );
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
      create(o) {
        const r = newStyle({ stylesDirs: opts.stylesDirs, registry: registry(), ...o });
        reg = undefined;
        return r;
      },
      accept(id) {
        acceptStyle(opts.stylesDirs, id);
        reg = undefined;
      },
      remove(id) {
        removeStyle(opts.stylesDirs, registry(), id);
        if (opts.trustFile) trusts().forget(id);
        reg = undefined;
      },
      trust(id) {
        trustStyle(opts.stylesDirs, trusts(), id);
        reg = undefined;
      },
      validate(id, o = {}) {
        const ffmpeg = opts.tools?.['ffmpeg'];
        const t = opts.tools ?? {};
        // the SFX kit check runs the Python audio QA like the audioQa job does
        const py = {
          pyProject: t['py'] ?? repoPyProject(),
          ...(t['uv'] ? { uv: t['uv'] } : {}),
          ...(t['pyEnv'] && t['dir'] ? { toolsDir: t['dir'] } : {}),
        };
        return validateStyle({
          ...o,
          registry: registry(),
          styleId: id,
          py,
          ...(ffmpeg ? { ffmpeg } : {}),
        });
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
  bound.engine = engine;
  return engine;
}
