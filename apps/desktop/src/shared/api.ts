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
  mode: z.enum(['tools', 'plan']).optional(),
  confirmPlan: z.boolean().optional(),
  /** Media ids the user attached in the chat (files dropped on the input are imported first). */
  attachments: z
    .array(z.string().regex(/^m_[A-Za-z0-9_-]+$/, 'media id'))
    .max(20)
    .optional(),
});

const AgentDecision = z.union([
  z.strictObject({ approve: z.boolean(), wordKeys: z.array(z.string()).optional() }),
  z.strictObject({ choice: z.string().min(1).max(200) }),
]);

/** Provider presets (agent spec "Providers and models", D-38); a test keeps it equal to @vox/agent's. */
export const PRESET_IDS = [
  'claude',
  'openrouter',
  'opencode-zen',
  '9router',
  'lmstudio',
  'ollama',
  'apple',
  'openai',
  'gemini',
] as const;
/** Roles the Settings screen assigns (the run uses these three; agent spec "Model roles"). */
export const SETTINGS_ROLES = ['editor', 'fast', 'vision'] as const;
export const COOKIE_BROWSERS = ['safari', 'chrome', 'firefox'] as const;

const ProviderIdArg = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, 'provider id');
const ModelIdArg = z.string().trim().min(1).max(200);
const Usd = z.number().positive().finite().max(10_000);

/**
 * `settings.save(patch)` (phase 13): one change per field; every field optional. `apiKey` absent,
 * empty or masked = unchanged (S18); a typed key goes to the Keychain in the engine host. A role is
 * assigned only to a model whose probe passed that role. `cookiesFromBrowser` is the only app path
 * that writes `ingest.cookiesFromBrowser` (S33).
 */
export const SettingsPatch = z.strictObject({
  provider: z
    .strictObject({
      id: ProviderIdArg.optional(),
      preset: z.enum(PRESET_IDS).optional(),
      baseUrl: z.string().trim().min(1).max(2048).optional(),
      apiKey: z.string().max(4096).nullable().optional(),
      options: z
        .strictObject({
          numCtx: z.int().positive().max(10_000_000).optional(),
          contextTokens: z.record(ModelIdArg, z.int().positive().max(100_000_000)).optional(),
        })
        .optional(),
    })
    .optional(),
  removeProvider: ProviderIdArg.optional(),
  role: z
    .strictObject({ role: z.enum(SETTINGS_ROLES), providerId: ProviderIdArg, model: ModelIdArg })
    .optional(),
  clearRole: z.enum(SETTINGS_ROLES).optional(),
  limits: z
    .strictObject({
      maxUsdPerRun: Usd.optional(),
      maxStepsPerRun: z.int().positive().max(1_000).optional(),
    })
    .optional(),
  price: z
    .union([
      z.strictObject({ model: ModelIdArg, free: z.literal(true) }),
      z.strictObject({
        model: ModelIdArg,
        inPerMTok: z.number().min(0).max(10_000),
        outPerMTok: z.number().min(0).max(10_000),
      }),
    ])
    .optional(),
  cookiesFromBrowser: z.enum(COOKIE_BROWSERS).nullable().optional(),
  contact: z.string().max(200).nullable().optional(),
});
export type SettingsPatchData = z.infer<typeof SettingsPatch>;

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
  'settings.save': t(SettingsPatch),
  // `<providerId>:<model>` or a role name
  'settings.probe': t(z.string().min(1).max(270)),
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
  'settings.get': SettingsData;
  'settings.save': SettingsData;
  'settings.probe': ProbedData;
  'agent.run': { runId: string; workflow: string; mode: 'tools' | 'plan' };
  'agent.runs': AgentRunData[];
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

// Settings (phase 13; engine host `SettingsHost`). Keys never appear here: only the masked form.
export interface ProbeCheckData {
  status: string;
  reason?: string;
}
export interface ProbedData {
  providerId: string;
  model: string;
  report?: {
    tools?: ProbeCheckData;
    loop?: ProbeCheckData;
    vision?: ProbeCheckData;
    plan?: ProbeCheckData;
    context?: { contextTokens: number | null; source: string; error?: string };
    toolList?: { tokens: number; share: number | null; result: ProbeCheckData };
    appleStatus?: string;
  };
  error?: { code: string; message: string; hint: string };
  roles: {
    role: string;
    assignable: boolean;
    mode?: 'tools' | 'plan';
    failures: { check: string; reason: string }[];
  }[];
}
export type SettingsRole = (typeof SETTINGS_ROLES)[number];
export interface SettingsData {
  providers: {
    id: string;
    type: string;
    preset?: string;
    baseUrl?: string;
    keyRef: 'keychain' | 'env' | 'none';
    /** `sk-or-…a1b2`, or null when no key is stored. Never the key. */
    keyMasked: string | null;
    /** Runs on this Mac (Ollama, LM Studio, Apple): project content stays here. */
    local: boolean;
    /** Installed models the host could list (Ollama tags, the Apple model). */
    models: string[];
    options?: { numCtx?: number; contextTokens?: Record<string, number> };
  }[];
  presets: {
    id: (typeof PRESET_IDS)[number];
    label: string;
    key: 'required' | 'none';
    baseUrl?: string;
    local: boolean;
  }[];
  roles: Partial<Record<SettingsRole, { providerId: string; model: string }>>;
  /** The editor's loop mode (`tools` or `plan`). */
  mode?: 'tools' | 'plan';
  limits: { maxUsdPerRun: number; maxStepsPerRun: number };
  prices: Record<string, unknown>;
  /** `build-info.json` `appleHelper`; false hides the Apple provider (D-16). */
  appleHelper: boolean;
  /** The helper's `--status`. */
  apple?: { status: string; usable: boolean; hint: string };
  /** Probe results of this session. */
  probes: ProbedData[];
  ingest: { cookiesFromBrowser: (typeof COOKIE_BROWSERS)[number] | null };
  contact: string | null;
  /** Local image generation (phase 14d); absent in builds without the models folder. */
  imagegen?: ImageGenData;
}

/**
 * Local image models (engine `imagegenStatus`). The toggle in Settings shows the download size and
 * the licence before the first use, then runs the `imagegen.install` job (`jobs.start`); turning it
 * off runs `imagegen.remove`. A failed or cancelled install keeps its partial download
 * (`partialBytes`), which the next install resumes; the row shows it and `imagegen.remove` deletes it
 * (D-69).
 */
export interface ImageGenModelData {
  id: string;
  label: string;
  license: string;
  licenseUrl: string;
  gated: boolean;
  installed: boolean;
  /** Bytes fetched from Hugging Face. */
  downloadBytes: number;
  /** About what stays on disk once installed. */
  installedBytes: number;
  sizeOnDisk: number;
  /** Bytes of a partial download kept for the next install (0 when none, D-69). */
  partialBytes: number;
}
export interface ImageGenData {
  models: ImageGenModelData[];
}

// Agent panel (phase 13; engine host `AgentHost`). Events: `agent.event` carries `{ type, payload }`
// (`agent.started|step|tool|todos|paused|done`, agent spec "Events", plus `agent.report` when the
// run's clip reports are written); `agent.todos` carries `{ runId, items }`.
export interface TightenRangeData {
  wordKey: string;
  kind: 'pause' | 'filler' | 'repeat';
  seqStartMs: number;
  seqEndMs: number;
  text: string;
}
export interface AgentPauseData {
  runId: string;
  reason: 'budget' | 'approval' | 'error';
  kind?: 'source' | 'plan' | 'pauses';
  detail: string;
  sources?: string[];
  ranges?: TightenRangeData[];
  /** A `pauses` pause: the sequence of the ranges. */
  sequenceId?: string;
  /** A `plan` pause: the validated plan (`ClipPlan` for clips, an op list for free-form). */
  plan?: unknown;
  /** A `budget` pause: the cap "Continue" raises the run to. */
  continueUsd?: number;
}
export interface ClipReportData {
  sequenceId: string;
  status: string;
  scenes: number;
  placeholders: number;
  speakerShare: number;
  health: string[];
  audio?: {
    pass: boolean;
    failing: string[];
    integratedLufs?: number;
    truePeakDbtp?: number;
    listen: string[];
  };
  edges: string[];
  skipped: string[];
}
export interface AgentRunData {
  runId: string;
  projectId: string;
  workflow: string;
  mode: 'tools' | 'plan';
  message: string;
  models: Record<string, string>;
  startedAt: string;
  status: 'running' | 'paused' | 'completed' | 'stopped' | 'failed';
  summary: string;
  costUsd: number;
  /** `notes`: the change note the step was given (edits by the user or another run since the last step). */
  steps: { step: number; subRun?: number; scope: string[]; text: string; notes?: string[] }[];
  tools: { tool: string; status: 'done' | 'failed'; byWorkflow?: boolean; error?: string }[];
  todos: { text: string; status: 'pending' | 'in_progress' | 'done' }[];
  /** Sequences in the latest step's scope (the "agent editing" marker while it runs). */
  scope: string[];
  /** The run's history entries still in effect: "Edited in timeline (n changes)". */
  changes: {
    version: number;
    op: string;
    itemIds: string[];
    sequenceIds: string[];
    undone: boolean;
  }[];
  clips: ClipReportData[];
  sequenceIds: string[];
  pause?: AgentPauseData;
  error?: ErrorData;
}
