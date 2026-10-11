// Asset jobs on the engine (engine spec "Stages": `assets search|fetch|cutout|generate`, "Archive
// assets and licences", "Image generation provider"; plan phase 05 steps 1–4, S7, S29). Jobs that
// add media apply one `addMedia` with their `jobId` (one undo entry, JOB_CONFLICT rules as in 04).
import { randomBytes } from 'node:crypto';
import { mkdir, unlink, copyFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { Config } from './config.ts';
import { VoxError } from './errors.ts';
import type { JobRunner } from './jobs.ts';
import {
  ActorSchema,
  RunIdSchema,
  applyJobOps,
  ensureModel,
  findMedia,
  type MediaApiDeps,
  type ModelSpec,
} from './media-api.ts';
import { MediaIdSchema, type MediaItem } from './model/schema.ts';
import { runPyTool, repoPyProject } from './py.ts';
import {
  archiveOrigin,
  downloadAsset,
  findCandidate,
  httpGetJson,
  isNoDerivatives,
  searchAssets,
  SearchArgsSchema,
  type GetJson,
  type SearchResult,
  userAgent,
} from './stages/assets.ts';
import { ingestOne } from './stages/ingest.ts';
import { resolveProjectPath } from './paths.ts';

/** Pinned cutout model (R5): rembg's U^2-Net, Apache-2.0 (upstream xuebinqin/U-2-Net). */
export const CUTOUT_MODEL: ModelSpec = {
  name: 'u2net.onnx',
  url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx',
  sha256: '8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491',
  maxBytes: 200 * 1024 * 1024,
  label: 'cutout model',
};

// ---- image providers (engine spec "Image generation provider") ----

export interface ImageRequest {
  prompt: string;
  width: number;
  height: number;
  seed?: number;
}

export interface ImageProvider {
  id: string;
  /**
   * False while the provider cannot work yet (a local model that is not installed). Such a provider
   * is left out of `list()` and is never the default, but `get(id)` still returns it, so asking for
   * it by name fails with its own hint. Absent = available.
   */
  available?(): boolean;
  /** True when the returned file is a temporary one that the job deletes after copying it. */
  disposable?: boolean;
  /** Writes an image file and resolves to its absolute path. */
  generate(
    req: ImageRequest,
    opts: { signal: AbortSignal; onProgress?(p: number): void },
  ): Promise<string>;
}

export interface ImageProviders {
  register(p: ImageProvider): void;
  list(): { id: string }[];
  get(id?: string): ImageProvider | undefined;
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const usable = (p: ImageProvider): boolean => p.available?.() !== false;

export function createImageProviders(): ImageProviders {
  const byId = new Map<string, ImageProvider>();
  return {
    register(p) {
      if (!p || typeof p.generate !== 'function' || !PROVIDER_ID.test(String(p.id))) {
        throw new VoxError(
          'VALIDATION',
          'An image provider needs an id (lowercase letters, digits, . _ -) and generate()',
          'Check the provider object',
        );
      }
      if (byId.has(p.id)) {
        throw new VoxError(
          'VALIDATION',
          `Image provider ${p.id} is already registered`,
          'Register each provider once',
          { details: { id: p.id } },
        );
      }
      byId.set(p.id, p);
    },
    list: () => [...byId.values()].filter(usable).map((p) => ({ id: p.id })),
    // the most recently registered available provider is the default
    get: (id) => (id === undefined ? [...byId.values()].filter(usable).at(-1) : byId.get(id)),
  };
}

// ---- jobs ----

export const AssetsSearchJobArgsSchema = SearchArgsSchema.extend({ projectId: z.string() });
export const AssetsFetchJobArgsSchema = z.strictObject({
  projectId: z.string(),
  candidateId: z.string().min(1).max(80),
  actor: ActorSchema,
  runId: RunIdSchema,
});
export const AssetsCutoutJobArgsSchema = z.strictObject({
  projectId: z.string(),
  mediaId: MediaIdSchema,
  actor: ActorSchema,
  runId: RunIdSchema,
});
export const AssetsGenerateJobArgsSchema = z.strictObject({
  projectId: z.string(),
  prompt: z.string().trim().min(1).max(2000),
  width: z.int().min(64).max(4096).default(1080),
  height: z.int().min(64).max(4096).default(1920),
  seed: z.int().min(0).optional(),
  provider: z.string().min(1).optional(),
  styleId: z.string().min(1).optional(),
  actor: ActorSchema,
  runId: RunIdSchema,
});

export interface AssetMediaResult {
  mediaId: string;
  reused: boolean;
  license?: string;
  author?: string;
  warning?: string;
  version: number;
}

export interface AssetsApiDeps extends MediaApiDeps {
  version: string;
  providers: ImageProviders;
  /** Test seam for search requests (recorded replies); default: checked HTTPS through `fetchPublic`. */
  getJson?: GetJson;
  commonsThrottle?: (signal?: AbortSignal) => Promise<void>;
  /** Extra CA for test HTTPS servers. */
  ca?: string;
  /** Retry back-off (tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const noProvider = (): VoxError =>
  new VoxError(
    'PROVIDER_MISSING',
    'No image provider is registered, so nothing was generated.',
    'Turn on local image generation (Settings, or `vox imagegen install`), add an image provider (agent settings), or find archive images with `vox assets search`.',
  );

export function registerAssetJobs(runner: JobRunner, deps: AssetsApiDeps): void {
  const tools = deps.tools;
  const redact = (s: string): string => deps.redactor.redact(s);
  const begin = async (projectId: string) => {
    const store = await deps.store(projectId);
    const project = await store.read();
    return { store, project, baseVersion: project.version, dir: deps.dirOf(projectId) };
  };
  const ingestEnv = (dir: string, existing: readonly MediaItem[], signal: AbortSignal) => ({
    projectDir: dir,
    existing,
    tools,
    signal,
    redact,
    docText: () =>
      Promise.reject(new VoxError('MEDIA_UNSUPPORTED', 'Not an image.', 'Pick an image.')),
  });
  const tempIn = async (dir: string, ext: string) => {
    await mkdir(join(dir, 'cache', 'assets'), { recursive: true, mode: 0o700 });
    return join(
      dir,
      'cache',
      'assets',
      `.vox-part-${process.pid}-${randomBytes(6).toString('hex')}${ext}`,
    );
  };
  const addOne = async (
    args: {
      projectId: string;
      actor?: z.infer<typeof ActorSchema>;
      runId?: string | undefined;
    },
    ctx: { jobId: string; signal: AbortSignal },
    file: string,
    origin: MediaItem['origin'],
    extra: Partial<MediaItem> = {},
  ): Promise<AssetMediaResult> => {
    const { store, project, baseVersion, dir } = await begin(args.projectId);
    const r = await ingestOne(ingestEnv(dir, project.media, ctx.signal), file, origin);
    if (r.media.kind !== 'image') {
      throw new VoxError(
        'MEDIA_UNSUPPORTED',
        `The downloaded file is ${r.media.kind}, not an image.`,
        'Pick another candidate.',
      );
    }
    const media = { ...r.media, ...extra };
    const version = r.reused
      ? project.version
      : await applyJobOps(store, [{ op: 'addMedia', args: { media } }], {
          actor: args.actor ?? 'user',
          runId: args.runId,
          jobId: ctx.jobId,
          baseVersion,
        });
    return {
      mediaId: media.id,
      reused: r.reused,
      ...(media.origin.license ? { license: media.origin.license } : {}),
      ...(media.origin.author ? { author: media.origin.author } : {}),
      version,
    };
  };

  runner.register<z.infer<typeof AssetsSearchJobArgsSchema>, SearchResult>('assets.search', {
    args: AssetsSearchJobArgsSchema,
    async run(args, ctx) {
      const { projectId, ...search } = args;
      const dir = deps.dirOf(projectId);
      await deps.store(projectId); // the project must exist
      const config: Config = await deps.config();
      ctx.progress(0.1, 'searching');
      return searchAssets(
        {
          projectDir: dir,
          version: deps.version,
          ...(config.contact ? { contact: config.contact } : {}),
          getJson:
            deps.getJson ??
            httpGetJson({
              ...(deps.net?.resolver ? { resolver: deps.net.resolver } : {}),
              ...(deps.net?.dial ? { dial: deps.net.dial } : {}),
              ...(deps.ca ? { ca: deps.ca } : {}),
            }),
          ...(deps.commonsThrottle ? { commonsThrottle: deps.commonsThrottle } : {}),
          signal: ctx.signal,
        },
        search,
      );
    },
  });

  runner.register<z.infer<typeof AssetsFetchJobArgsSchema>, AssetMediaResult>('assets.fetch', {
    args: AssetsFetchJobArgsSchema,
    async run(args, ctx) {
      const dir = deps.dirOf(args.projectId);
      await deps.store(args.projectId);
      const c = await findCandidate(dir, args.candidateId);
      const config = await deps.config();
      const tmp = await tempIn(dir, '.img');
      try {
        ctx.progress(0.1, 'downloading');
        await downloadAsset(c.url, tmp, {
          ...(deps.net?.resolver ? { resolver: deps.net.resolver } : {}),
          ...(deps.net?.dial ? { dial: deps.net.dial } : {}),
          ...(deps.ca ? { ca: deps.ca } : {}),
          headers: { 'user-agent': userAgent(deps.version, config.contact) },
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          signal: ctx.signal,
        });
        ctx.progress(0.7, 'adding');
        const r = await addOne(args, ctx, tmp, archiveOrigin(c));
        return { ...r, ...(c.warning ? { warning: c.warning } : {}) };
      } finally {
        await unlink(tmp).catch(() => undefined);
      }
    },
  });

  runner.register<z.infer<typeof AssetsCutoutJobArgsSchema>, AssetMediaResult>('assets.cutout', {
    args: AssetsCutoutJobArgsSchema,
    async run(args, ctx) {
      const dir = deps.dirOf(args.projectId);
      const src = findMedia(await (await deps.store(args.projectId)).read(), args.mediaId);
      if (src.kind !== 'image') {
        throw new VoxError(
          'MEDIA_UNSUPPORTED',
          `Media ${src.id} is ${src.kind}; cutout takes an image.`,
          'Pick an image (for a video, take a still with `vox media-frames` and add it first).',
        );
      }
      if (isNoDerivatives(src.origin.license)) {
        throw new VoxError(
          'LICENSE_REFUSED',
          `Media ${src.id} is ${src.origin.license}: no derivatives, so no cutout.`,
          'Use the image as it is, or pick one under CC0, PDM, CC BY or CC BY-SA.',
          { details: { mediaId: src.id, license: src.origin.license } },
        );
      }
      const models = tools['models'];
      if (!models) {
        throw new VoxError(
          'TOOL_MISSING',
          'No tools folder for the cutout model.',
          'Run vox doctor.',
        );
      }
      ctx.progress(0.02, 'cutout model');
      const modelPath = await ensureModel(join(models, 'rembg'), CUTOUT_MODEL, {
        signal: ctx.signal,
        ...(deps.net ? { net: deps.net } : {}),
      });
      const out = await tempIn(dir, '.png');
      try {
        await runPyTool(
          'cutout',
          { input: await resolveProjectPath(dir, src.path), output: out, modelPath },
          CutoutResultSchema,
          {
            pyProject: tools['py'] ?? repoPyProject(),
            ...(tools['uv'] ? { uv: tools['uv'] } : {}),
            ...(tools['pyEnv'] && tools['dir'] ? { toolsDir: tools['dir'] } : {}),
            signal: ctx.signal,
            onProgress: (p, m) => ctx.progress(0.1 + p * 0.7, m),
            redactor: deps.redactor,
            input: CutoutRequestSchema,
          },
        );
        ctx.progress(0.85, 'adding');
        return await addOne(
          args,
          ctx,
          out,
          { ...src.origin },
          {
            description: `Cutout of ${src.id}`,
            tags: ['cutout'],
          },
        );
      } finally {
        await unlink(out).catch(() => undefined);
      }
    },
  });

  runner.register<
    z.infer<typeof AssetsGenerateJobArgsSchema>,
    AssetMediaResult & { provider: string }
  >('assets.generate', {
    args: AssetsGenerateJobArgsSchema,
    gpu: true,
    async run(args, ctx) {
      const dir = deps.dirOf(args.projectId);
      await deps.store(args.projectId);
      if (deps.providers.list().length === 0) throw noProvider();
      const p = deps.providers.get(args.provider);
      if (!p) {
        throw new VoxError(
          'NOT_FOUND',
          `No image provider ${args.provider}.`,
          `Use one of: ${deps.providers
            .list()
            .map((x) => x.id)
            .join(', ')}`,
        );
      }
      ctx.progress(0.05, `generating with ${p.id}`);
      const file = await p.generate(
        {
          prompt: args.prompt,
          width: args.width,
          height: args.height,
          ...(args.seed !== undefined ? { seed: args.seed } : {}),
        },
        { signal: ctx.signal, onProgress: (x) => ctx.progress(0.05 + 0.8 * x) },
      );
      if (typeof file !== 'string' || !isAbsolute(file)) {
        throw new VoxError(
          'TOOL_FAILED',
          `Image provider ${p.id} returned no absolute file path.`,
          'Check the provider.',
        );
      }
      // Work on a copy: the provider's file stays the provider's.
      const tmp = await tempIn(dir, '.img');
      try {
        await copyFile(file, tmp);
        const r = await addOne(args, ctx, tmp, {
          type: 'generated',
          prompt: args.prompt,
          author: p.id,
        });
        return { ...r, provider: p.id };
      } finally {
        await unlink(tmp).catch(() => undefined);
        if (p.disposable) await unlink(file).catch(() => undefined);
      }
    },
  });
}

export const CutoutRequestSchema = z.strictObject({
  input: z.string().min(1),
  output: z.string().regex(/\.png$/),
  modelPath: z.string().regex(/u2net\.onnx$/),
});
export const CutoutResultSchema = z.strictObject({
  output: z.string(),
  width: z.int().positive(),
  height: z.int().positive(),
  coverage: z.number().min(0).max(1),
});
