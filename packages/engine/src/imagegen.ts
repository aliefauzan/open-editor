// Local image generation with mflux (engine spec "Image generation provider", plan phase 14d, D-XX).
// Z-Image-Turbo (Apache-2.0, not gated) is the default; FLUX.1-schnell is optional and gated on
// Hugging Face (the user accepts its terms and sets HF_TOKEN; this code never asks for a token).
// The Python tool `vox_py.imagegen` does the work. `install` downloads the pinned snapshot into a
// cache folder inside the models folder, quantizes it to 8 bits into `<models>/mflux/<id>/` and
// this module deletes the cache; `generate` loads that folder and never touches the network.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, statfsSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ImageProvider } from './assets-api.ts';
import { VoxError } from './errors.ts';
import type { JobRunner } from './jobs.ts';
import { repoPyProject, runPyTool } from './py.ts';
import type { Redactor } from './redact.ts';

export const IMAGE_MODEL_IDS = ['z-image-turbo', 'flux1-schnell'] as const;
export type ImageModelId = (typeof IMAGE_MODEL_IDS)[number];

export interface ImageModelInfo {
  id: ImageModelId;
  /** Provider id registered in the engine (`vox assets generate --provider <id>`). */
  providerId: string;
  label: string;
  repo: string;
  /** SPDX id of the weights' licence. */
  license: string;
  licenseUrl: string;
  /** True when Hugging Face requires accepted terms and a token. */
  gated: boolean;
  /** Bytes fetched from Hugging Face. */
  downloadBytes: number;
  /** About what stays on disk after quantizing to 8 bits. */
  installedBytes: number;
  steps: number;
}

export const IMAGE_MODELS: Readonly<Record<ImageModelId, ImageModelInfo>> = {
  'z-image-turbo': {
    id: 'z-image-turbo',
    providerId: 'mflux',
    label: 'Z-Image-Turbo',
    repo: 'Tongyi-MAI/Z-Image-Turbo',
    license: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo',
    gated: false,
    downloadBytes: 32_800_000_000,
    installedBytes: 10_000_000_000,
    steps: 9,
  },
  'flux1-schnell': {
    id: 'flux1-schnell',
    providerId: 'mflux-flux1-schnell',
    label: 'FLUX.1-schnell',
    repo: 'black-forest-labs/FLUX.1-schnell',
    license: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell',
    gated: true,
    downloadBytes: 34_000_000_000,
    installedBytes: 17_000_000_000,
    steps: 4,
  },
};

/** The manifest the Python tool writes last; its presence means "installed". */
export const MODEL_MANIFEST = 'vox-model.json';

export function modelDir(models: string, id: ImageModelId): string {
  return join(models, 'mflux', id);
}

export function isInstalled(models: string | undefined, id: ImageModelId): boolean {
  if (!models) return false;
  try {
    return statSync(join(modelDir(models, id), MODEL_MANIFEST)).isFile();
  } catch {
    return false;
  }
}

/** True when a Hugging Face token is available the way huggingface_hub finds one. */
export function hfTokenPresent(env: NodeJS.ProcessEnv | undefined = process.env): boolean {
  env ??= process.env;
  if (env['HF_TOKEN'] && env['HF_TOKEN'].length > 0) return true;
  const home = env['HF_HOME'] ?? join(env['HOME'] ?? homedir(), '.cache', 'huggingface');
  try {
    return readFileSync(join(home, 'token'), 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

export interface ImageModelStatus extends ImageModelInfo {
  installed: boolean;
  /** Bytes on disk of the installed model (0 when not installed). */
  sizeOnDisk: number;
  /** Only for gated models: whether a token is set. */
  tokenSet?: boolean;
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirBytes(p);
    else if (e.isFile()) total += (await stat(p)).size;
  }
  return total;
}

export async function imagegenStatus(
  models: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ImageModelStatus[]> {
  const out: ImageModelStatus[] = [];
  for (const id of IMAGE_MODEL_IDS) {
    const info = IMAGE_MODELS[id];
    const installed = isInstalled(models, id);
    out.push({
      ...info,
      installed,
      sizeOnDisk: installed && models ? await dirBytes(modelDir(models, id)) : 0,
      ...(info.gated ? { tokenSet: hfTokenPresent(env) } : {}),
    });
  }
  return out;
}

// ---- the ImageProvider ----

export interface MfluxDeps {
  tools: Record<string, string | undefined>;
  redactor?: Redactor;
}

const GenerateResultSchema = z.strictObject({
  output: z.string(),
  width: z.int().positive(),
  height: z.int().positive(),
  seed: z.int().nonnegative(),
});
const InstallResultSchema = z.strictObject({
  modelDir: z.string(),
  bytes: z.int().positive(),
  quantize: z.int().min(3).max(8),
});

const ToolRequestSchema = z.strictObject({
  action: z.enum(['install', 'generate']),
  model: z.enum(IMAGE_MODEL_IDS),
  modelDir: z.string().min(1),
  cacheDir: z.string().min(1).optional(),
  prompt: z.string().min(1).max(2000).optional(),
  width: z.int().min(64).max(4096).optional(),
  height: z.int().min(64).max(4096).optional(),
  seed: z.int().min(0).optional(),
  output: z
    .string()
    .regex(/\.png$/)
    .optional(),
});

function bridge(deps: MfluxDeps) {
  const t = deps.tools;
  return {
    pyProject: t['py'] ?? repoPyProject(),
    ...(t['uv'] ? { uv: t['uv'] } : {}),
    ...(t['pyEnv'] && t['dir'] ? { toolsDir: t['dir'] } : {}),
    ...(deps.redactor ? { redactor: deps.redactor } : {}),
    input: ToolRequestSchema,
  };
}

/** The `mflux` providers: one per model; each is available only while its model is installed. */
export function createMfluxProviders(deps: MfluxDeps): ImageProvider[] {
  const models = deps.tools['models'];
  return IMAGE_MODEL_IDS.map((id): ImageProvider => {
    const info = IMAGE_MODELS[id];
    return {
      id: info.providerId,
      disposable: true,
      available: () => isInstalled(models, id),
      async generate(req, opts) {
        if (!models || !isInstalled(models, id)) {
          throw new VoxError(
            'PROVIDER_MISSING',
            `${info.label} is not installed.`,
            id === 'z-image-turbo'
              ? 'Turn on local image generation in Settings, or run `vox imagegen install`.'
              : 'Run `vox imagegen install --model flux1-schnell` (see `vox doctor` for the terms).',
          );
        }
        const output = join(tmpdir(), `vox-imagegen-${randomUUID()}.png`);
        const r = await runPyTool(
          'imagegen',
          {
            action: 'generate',
            model: id,
            modelDir: modelDir(models, id),
            prompt: req.prompt,
            width: req.width,
            height: req.height,
            ...(req.seed !== undefined ? { seed: req.seed } : {}),
            output,
          },
          GenerateResultSchema,
          {
            ...bridge(deps),
            signal: opts.signal,
            ...(opts.onProgress ? { onProgress: (p: number) => opts.onProgress!(p) } : {}),
          },
        );
        return r.output;
      },
    };
  });
}

// ---- jobs: install and remove ----

export const ImagegenInstallArgsSchema = z.strictObject({
  model: z.enum(IMAGE_MODEL_IDS).default('z-image-turbo'),
});
export const ImagegenRemoveArgsSchema = ImagegenInstallArgsSchema;

export interface ImagegenInstallResult {
  model: ImageModelId;
  providerId: string;
  bytes: number;
}

export interface ImagegenJobDeps extends MfluxDeps {
  /** Test seam: free bytes on the volume of the models folder. */
  freeBytes?: (dir: string) => number;
  env?: NodeJS.ProcessEnv;
}

function defaultFreeBytes(dir: string): number {
  let probe = dir;
  while (!existsSync(probe) && probe !== '/') probe = join(probe, '..');
  const s = statfsSync(probe);
  return s.bavail * s.bsize;
}

export function registerImagegenJobs(runner: JobRunner, deps: ImagegenJobDeps): void {
  const models = deps.tools['models'];
  const needModels = (): string => {
    if (!models) {
      throw new VoxError('TOOL_MISSING', 'No tools folder for the image model.', 'Run vox doctor.');
    }
    return models;
  };

  runner.register<z.infer<typeof ImagegenInstallArgsSchema>, ImagegenInstallResult>(
    'imagegen.install',
    {
      args: ImagegenInstallArgsSchema,
      gpu: true,
      async run(args, ctx) {
        const root = needModels();
        const info = IMAGE_MODELS[args.model];
        if (info.gated && !hfTokenPresent(deps.env)) {
          throw new VoxError(
            'PROVIDER_MISSING',
            `${info.label} needs a Hugging Face token.`,
            `Accept the terms at ${info.licenseUrl}, create a read token, and run again with HF_TOKEN set. Vox never stores it.`,
          );
        }
        // Downloading needs the snapshot plus room to write the quantized copy.
        const need = info.downloadBytes + info.installedBytes;
        const free = (deps.freeBytes ?? defaultFreeBytes)(root);
        if (free < need) {
          throw new VoxError(
            'TOOL_FAILED',
            `Not enough free disk space for ${info.label}: needs about ${Math.ceil(need / 1e9)} GB while installing, ${Math.floor(free / 1e9)} GB free.`,
            'Free some space and try again.',
            { details: { needBytes: need, freeBytes: free } },
          );
        }
        const base = join(root, 'mflux');
        const cacheDir = join(base, `.download-${args.model}`);
        await mkdir(base, { recursive: true });
        ctx.progress(0.01, `installing ${info.label}`);
        try {
          const r = await runPyTool(
            'imagegen',
            {
              action: 'install',
              model: args.model,
              modelDir: modelDir(root, args.model),
              cacheDir,
            },
            InstallResultSchema,
            {
              ...bridge(deps),
              signal: ctx.signal,
              onProgress: (p, m) => ctx.progress(p, m),
            },
          );
          return { model: args.model, providerId: info.providerId, bytes: r.bytes };
        } finally {
          // the 33 GB snapshot is only needed to build the quantized copy
          await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
          await rm(`${modelDir(root, args.model)}.part`, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
      },
    },
  );

  runner.register<z.infer<typeof ImagegenRemoveArgsSchema>, { removed: boolean }>(
    'imagegen.remove',
    {
      args: ImagegenRemoveArgsSchema,
      async run(args) {
        const root = needModels();
        const dir = modelDir(root, args.model);
        const had = existsSync(dir);
        await rm(dir, { recursive: true, force: true });
        return { removed: had };
      },
    },
  );
}
