// The one schema for `window.vox` (app spec "Engine-host API", R2; D-15 shapes). Main validates every
// call's arguments with these zod tuples before it forwards the call to the engine host; the preload
// builds the typed bridge from METHODS. Grows additively in phases 09–13.
import { z } from 'zod';

const ProjectId = z.string().regex(/^p_[a-z0-9]+$/, 'project id');
const SequenceId = z.string().regex(/^seq_[A-Za-z0-9_-]+$/, 'sequence id');
const Name = z.string().trim().min(1).max(200);
const Loudness = z.enum(['youtube', 'tiktok', 'broadcast']);
const Captions = z.enum(['burn', 'none']);

/** Keys that would carry a raw file system path; jobs take an export `targetId` instead (D-13). */
export const RAW_PATH_KEYS = [
  'path',
  'file',
  'dir',
  'out',
  'outPath',
  'output',
  'paths',
  'outDir',
  'input',
  'inputs',
  'target',
] as const;

const JobArgs = z
  .record(z.string(), z.unknown())
  .refine((a) => !RAW_PATH_KEYS.some((k) => k in a), {
    message: 'jobs take a targetId from exports.chooseTarget, never a raw path',
  })
  .refine((a) => a['loudness'] === undefined || Loudness.safeParse(a['loudness']).success, {
    message: 'loudness is youtube, tiktok or broadcast',
  })
  .refine((a) => a['captions'] === undefined || Captions.safeParse(a['captions']).success, {
    message: "captions is 'burn' or 'none'",
  });

const OpsApply = z.strictObject({
  projectId: ProjectId,
  op: z.string().regex(/^[a-zA-Z]+$/),
  args: z.record(z.string(), z.unknown()),
  baseVersion: z.int().min(0),
  coalesceKey: z.string().min(1).max(200).optional(),
});

const AgentRun = z.strictObject({
  projectId: ProjectId,
  message: z.string().min(1).max(20_000),
  workflow: z.string().min(1).max(100).optional(),
  selection: z.array(z.string()).max(10_000),
  mode: z.string().min(1).max(50).optional(),
  confirmPlan: z.boolean().optional(),
});

const AgentDecision = z.union([
  z.strictObject({ approve: z.boolean(), wordKeys: z.array(z.string()).optional() }),
  z.strictObject({ choice: z.string().min(1).max(200) }),
]);

const ChooseTarget = z.strictObject({
  // the dialog opens in the folder last used for this project (plan D-13)
  projectId: ProjectId.optional(),
  mode: z.enum(['file', 'folder']),
  suggestedName: z.string().min(1).max(255).optional(),
  format: z.string().min(1).max(20),
});

const t = <T extends z.ZodTypeAny[]>(...items: T) => z.tuple(items as never) as z.ZodTuple<T, null>;

/** Every `window.vox` method: name → argument tuple. */
export const METHOD_ARGS = {
  'projects.list': t(),
  'projects.create': t(Name),
  'projects.open': t(ProjectId),
  'projects.reveal': t(ProjectId),
  'ops.apply': t(OpsApply),
  'history.undo': t(ProjectId),
  'history.redo': t(ProjectId),
  'history.list': t(ProjectId, z.int().min(0).optional()),
  'snapshots.list': t(ProjectId),
  'snapshots.create': t(ProjectId, Name),
  'media.importFiles': t(
    ProjectId,
    z.strictObject({ paths: z.array(z.string().min(1)).min(1).max(1000) }).optional(),
  ),
  'media.importUrl': t(ProjectId, z.string().min(1).max(4096)),
  'media.classifyUrl': t(z.string().max(4096)),
  // waveform peaks of a media item (`peaks/<mediaId>.json`; the renderer CSP allows no fetch), 10a
  'media.peaks': t(ProjectId, z.string().regex(/^m_[A-Za-z0-9_-]+$/, 'media id')),
  // media bin search over names, tags, descriptions and transcript text → media ids (10b)
  'media.search': t(ProjectId, z.string().max(200)),
  'captions.get': t(ProjectId, SequenceId),
  'jobs.start': t(z.string().regex(/^[a-zA-Z]+(\.[a-zA-Z]+)?$/), JobArgs),
  'jobs.get': t(z.string().min(1).max(100)),
  'jobs.cancel': t(z.string().min(1).max(100)),
  'preview.url': t(ProjectId, SequenceId),
  'geo.search': t(z.string().max(200)),
  'agent.run': t(AgentRun),
  'agent.runs': t(ProjectId),
  'agent.stop': t(z.string().min(1).max(100)),
  'agent.decide': t(z.string().min(1).max(100), AgentDecision),
  'agent.undoRun': t(z.string().min(1).max(100)),
  'settings.get': t(),
  'settings.save': t(z.record(z.string(), z.unknown())),
  'settings.probe': t(z.string().min(1).max(200)),
  'styles.list': t(),
  'styles.get': t(z.string().min(1).max(100)),
  'styles.accept': t(z.string().min(1).max(100)),
  'styles.remove': t(z.string().min(1).max(100)),
  'exports.chooseTarget': t(ChooseTarget),
  'exports.lastFolder': t(ProjectId),
  'exports.reveal': t(z.string().min(1).max(4096)),
  'setup.status': t(),
  'setup.install': t(z.string().min(1).max(100)),
  'setup.updateYtDlp': t(),
} as const;

export type Method = keyof typeof METHOD_ARGS;
export const METHODS = Object.keys(METHOD_ARGS) as Method[];
export type MethodArgs<M extends Method> = z.input<(typeof METHOD_ARGS)[M]>;

/** Events the renderer can subscribe to (`window.vox.on`); `host.restarted` drives the banner. */
export const EVENTS = [
  'project.changed',
  'job.started',
  'job.progress',
  'job.done',
  'job.failed',
  'job.cancelled',
  'agent.event',
  'agent.todos',
  'preview.updated',
  'setup.progress',
  'host.restarted',
  // a native menu item was chosen: { command } (src/shared/commands.ts)
  'menu.command',
] as const;
export type EventName = (typeof EVENTS)[number];

/** Errors cross IPC as plain data (engine `VoxError` shape); app-level codes below. */
export interface ErrorData {
  code: string;
  message: string;
  hint: string;
  details?: Record<string, unknown>;
}
export const APP_ERRORS = {
  IPC_REJECTED: 'Calls come only from the main frame of a Vox Studio window',
  ARGS_INVALID: 'The call arguments do not match the window.vox schema',
  NOT_AVAILABLE: 'This feature arrives in a later build',
  HOST_UNAVAILABLE: 'The engine is restarting; try again in a moment',
} as const;

export type CallResult = { ok: true; value: unknown } | { ok: false; error: ErrorData };

/** Validates a call; returns the parsed args or an ARGS_INVALID error. */
export function parseCall(
  method: unknown,
  args: unknown,
): { ok: true; method: Method; args: unknown[] } | { ok: false; error: ErrorData } {
  if (typeof method !== 'string' || !Object.hasOwn(METHOD_ARGS, method)) {
    return { ok: false, error: appError('ARGS_INVALID', `Unknown method ${String(method)}`) };
  }
  const schema = METHOD_ARGS[method as Method] as z.ZodType<unknown[]>;
  const r = schema.safeParse(args);
  if (!r.success) {
    return {
      ok: false,
      error: appError('ARGS_INVALID', `${method}: ${z.prettifyError(r.error)}`, {
        issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      }),
    };
  }
  return { ok: true, method: method as Method, args: r.data };
}

export function appError(
  code: keyof typeof APP_ERRORS,
  message: string,
  details?: Record<string, unknown>,
): ErrorData {
  return { code, message, hint: APP_ERRORS[code], ...(details ? { details } : {}) };
}

// Results the renderer reads in phase 08 (engine shapes, kept structural so shared never imports
// the engine; later phases add more).
export interface ProjectSummary {
  id: string;
  name: string;
  version: number;
  updatedAt: string;
}
export interface OpenedProject {
  project: { id: string; name: string; sequences: { id: string; name: string }[] };
  version: number;
  /** Media ids whose file is missing on disk (10b: offline block + relink). */
  offline?: string[];
}
export interface ApplyResultData {
  version: number;
  changes: unknown[];
  results: { status: string; error?: ErrorData; report?: unknown }[];
}

// First-run setup (phase 09; engine host `AppSetup`, kept structural here).
export interface SetupComponentData {
  id: string;
  label: string;
  kind: string;
  licence: string;
  sizeBytes: number;
  state: 'ready' | 'missing' | 'stale' | 'modified';
  detail?: string;
  path?: string;
  version?: string;
}
export interface DoctorCheckData {
  name: string;
  level: 'ok' | 'warn' | 'error';
  detail: string;
  fix?: string;
}
export type UpdateData =
  | { status: 'pending' | 'disabled' }
  | { status: 'up-to-date'; current: string; latest: string }
  | { status: 'available'; current: string; latest: string; name: string; url: string }
  | { status: 'error'; code: string; message: string };
export interface SetupStatusData {
  components: SetupComponentData[];
  ffmpeg: {
    state: 'ok' | 'brew-missing' | 'ffmpeg-missing';
    ffmpegPath?: string;
    version?: string;
    commands: string[];
  };
  /** stage → component ids it waits for */
  disabledStages: Record<string, string[]>;
  ready: boolean;
  doctor?: { ok: boolean; checks: DoctorCheckData[] };
  /** The doctor runs in the background; a `setup.progress` event (component `doctor`) follows. */
  doctorRunning: boolean;
  /** Components ready and no doctor error: the green "Ready". */
  done: boolean;
  busy: string[];
  update: UpdateData;
}
export interface SetupInstallData {
  installed: string[];
  skipped: string[];
  failed: { id: string; code: string; message: string }[];
}
export interface SetupProgressData {
  type: 'setup.progress';
  /** a component id, or `doctor` when a doctor run finished */
  component: string;
  phase: 'download' | 'verify' | 'extract' | 'install' | 'sync' | 'done' | 'error';
  receivedBytes?: number;
  totalBytes?: number;
  message?: string;
}

/** Typed results per method where phase 08 defines one; `unknown` elsewhere. */
export interface Results {
  'setup.status': SetupStatusData;
  'setup.install': SetupInstallData;
  'setup.updateYtDlp': { version: string };
  'projects.list': ProjectSummary[];
  'projects.create': OpenedProject['project'];
  'projects.open': OpenedProject;
  'ops.apply': ApplyResultData;
  'preview.url': string;
}
export type Result<M extends Method> = M extends keyof Results ? Results[M] : unknown;

/** The bridge type: `window.vox.projects.open(id)` etc. Calls reject with an `ErrorData`. */
type Split<S extends string> = S extends `${infer A}.${infer B}` ? [A, B] : never;
export type VoxApi = {
  [A in Split<Method>[0]]: {
    [M in Method as Split<M>[0] extends A ? Split<M>[1] : never]: (
      ...args: MethodArgs<M>
    ) => Promise<Result<M>>;
  };
} & {
  on(event: EventName, handler: (payload: unknown) => void): () => void;
  /** Finder drop onto the window: imports the dropped files (preload resolves their paths). */
  dropFiles?(projectId: string, files: ArrayLike<File>): Promise<unknown>;
};
