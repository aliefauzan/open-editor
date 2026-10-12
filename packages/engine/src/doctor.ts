// `vox doctor` checks (plan phase 04 step 13): every tool with its version and a fix line when
// missing or broken, yt-dlp's JS runtime / yt-dlp-ejs / impersonation, the Python env, the
// HyperFrames Chrome, models with their licences (the vendored Silero model's SHA-256), and the
// Commons contact. Project checks: caption overrides whose word no longer exists, and the lock.
import { spawn } from 'node:child_process';
import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { LOCK_FILE, type LockInfo } from './history/lock.ts';
import { FACE_MODEL, sha256File } from './media-api.ts';
import type { Project, Transcript } from './model/schema.ts';
import { moduleRequire } from './resources.ts';
import { WHISPER_DIR, WHISPER_REPO, WHISPER_REVISION } from './stages/transcribe.ts';

import {
  IMAGE_MODEL_IDS,
  IMAGE_MODELS,
  hfTokenPresent,
  isInstalled,
  modelDir,
} from './imagegen.ts';

export type CheckLevel = 'ok' | 'warn' | 'error';

export interface DoctorCheck {
  name: string;
  level: CheckLevel;
  detail: string;
  version?: string;
  path?: string;
  fix?: string;
  licence?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/** Silero VAD v6.2.3, vendored in `py/vox_py/models/` (pin mirrors `vad.py` MODEL_SHA256, R5). */
export const SILERO_SHA256 = '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3';

export interface Exec {
  (
    cmd: string,
    args: readonly string[],
    opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
  ): Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>;
}

/** Runs a tool with a timeout; never throws (a spawn error is code -1). Output capped at 1 MiB. */
export const exec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const cap = (s: string, d: string) => (s.length > 1 << 20 ? s : s + d);
    const child = spawn(cmd, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env ?? process.env,
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 60_000);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout = cap(stdout, d)));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr = cap(stderr, d)));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

const FIX: Readonly<Record<string, string>> = {
  ffmpeg: 'brew install ffmpeg',
  ffprobe: 'brew install ffmpeg',
  'yt-dlp': 'brew install yt-dlp (or: pip install -U "yt-dlp[default]"), then yt-dlp -U',
  deno: 'brew install deno (yt-dlp then uses deno, its default JS runtime)',
  node: 'brew install node@24',
  uv: 'brew install uv',
};

const VERSION_ARGS: Readonly<Record<string, readonly string[]>> = {
  ffmpeg: ['-hide_banner', '-version'],
  ffprobe: ['-hide_banner', '-version'],
  'yt-dlp': ['--version'],
  deno: ['--version'],
  node: ['--version'],
  uv: ['--version'],
};

function versionOf(name: string, out: string): string | undefined {
  const first = out.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const m =
    name === 'ffmpeg' || name === 'ffprobe'
      ? /version (\S+)/.exec(first)
      : /(\d+\.\d+(?:\.\d+)?)/.exec(first);
  return m?.[1];
}

export interface DoctorOptions {
  tools: Readonly<Record<string, string | undefined>>;
  config: { contact?: string | undefined };
  exec?: Exec;
  /** HOME for caches (HF, puppeteer); default the user's home. */
  home?: string;
  /** Environment for the Hugging Face token check; default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Skip the Python import check (it takes a few seconds). */
  quick?: boolean;
}

export async function doctor(o: DoctorOptions): Promise<DoctorReport> {
  const run = o.exec ?? exec;
  const home = o.home ?? homedir();
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);

  for (const name of ['ffmpeg', 'ffprobe', 'yt-dlp', 'deno', 'node', 'uv']) {
    const path = o.tools[name];
    const optional = name === 'deno';
    if (!path) {
      add({
        name,
        level: optional ? 'warn' : 'error',
        detail: optional ? 'not found; yt-dlp will use node (--js-runtimes node)' : 'not found',
        fix: FIX[name]!,
      });
      continue;
    }
    const r = await run(path, VERSION_ARGS[name]!, { timeoutMs: 30_000 });
    const version = r.code === 0 ? versionOf(name, r.stdout) : undefined;
    add(
      version
        ? { name, level: 'ok', detail: `${name} ${version}`, version, path }
        : {
            name,
            level: 'error',
            detail: `${name} does not run (exit ${r.code})`,
            path,
            fix: FIX[name]!,
          },
    );
  }

  // yt-dlp extras: JS runtime, yt-dlp-ejs (YouTube challenges), impersonation (TikTok).
  const ytdlp = o.tools['yt-dlp'];
  if (ytdlp) {
    const r = await run(
      ytdlp,
      ['-v', '--ignore-config', '--no-update', '--list-impersonate-targets'],
      {
        timeoutMs: 60_000,
      },
    );
    const text = `${r.stdout}\n${r.stderr}`;
    const libs = /Optional libraries: (.*)/.exec(text)?.[1] ?? '';
    const runtimes = /JS runtimes: (.*)/.exec(text)?.[1]?.trim() ?? '';
    const ejs = /yt_dlp_ejs-(\S+?)(?:,|$)/.exec(libs)?.[1];
    add(
      ejs
        ? { name: 'yt-dlp-ejs', level: 'ok', detail: `yt-dlp-ejs ${ejs}`, version: ejs }
        : {
            name: 'yt-dlp-ejs',
            level: 'warn',
            detail: 'yt-dlp-ejs not found; YouTube links may fail',
            fix: 'pip install -U "yt-dlp[default]" (or brew upgrade yt-dlp)',
          },
    );
    const nodeOnly = !/deno/.test(runtimes);
    add({
      name: 'yt-dlp-js-runtime',
      level: runtimes === '' || runtimes === 'none' || nodeOnly ? 'warn' : 'ok',
      detail:
        runtimes === '' || runtimes === 'none'
          ? 'yt-dlp sees no JS runtime'
          : `JS runtimes: ${runtimes}`,
      ...(nodeOnly ? { fix: FIX['deno']! } : {}),
    });
    const targets = text
      .split(/\r?\n/)
      .filter((l) => /curl_cffi/.test(l) && !/Optional libraries/.test(l));
    const usable = targets.filter((l) => !/unavailable/.test(l));
    add(
      usable.length > 0
        ? {
            name: 'yt-dlp-impersonate',
            level: 'ok',
            detail: `${usable.length} impersonate target(s)`,
          }
        : {
            name: 'yt-dlp-impersonate',
            level: 'warn',
            detail: 'no impersonate target available; TikTok links may fail (add the file instead)',
            fix: 'install a curl_cffi build yt-dlp supports: pip install -U "yt-dlp[default,curl-cffi]"',
          },
    );
  }

  // Python env: the vox_py tools import under `python -I` in the uv project.
  const uv = o.tools['uv'];
  const py = o.tools['py'];
  // App-installed env (D-12): it must come from the uv.lock this build ships, else it is re-synced.
  const env = o.tools['pyEnv'];
  if (env && py) {
    const want = await sha256File(join(py, 'uv.lock'));
    const have = (await readFile(join(env, '.vox-lock-hash'), 'utf8').catch(() => '')).trim();
    add(
      want !== undefined && have === want
        ? {
            name: 'python-env-lock',
            level: 'ok',
            detail: "synced from this build's uv.lock",
            path: env,
          }
        : {
            name: 'python-env-lock',
            level: 'error',
            detail:
              have === ''
                ? 'the Python env has no lock hash (not synced by setup)'
                : 'the Python env was synced from a different uv.lock',
            path: env,
            fix: 'open Vox Studio (setup re-syncs it on launch) or Setup → Repair "Python env"',
          },
    );
  }
  if (uv && py && !o.quick) {
    const args = [
      'run',
      '--frozen',
      ...(o.tools['pyEnv'] ? ['--no-sync'] : []),
      '--project',
      py,
      'python',
      '-I',
      '-c',
      'import vox_py, onnxruntime, mlx_whisper, mediapipe, pypdf, Vision; print("ok")',
    ];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (o.tools['pyEnv'] && o.tools['dir']) {
      env['UV_PROJECT_ENVIRONMENT'] = o.tools['pyEnv'];
      env['UV_CACHE_DIR'] = join(o.tools['dir'], 'uv-cache');
      env['UV_PYTHON_INSTALL_DIR'] = join(o.tools['dir'], 'python');
    }
    const r = await run(uv, args, { timeoutMs: 300_000, env });
    add(
      r.code === 0 && r.stdout.includes('ok')
        ? {
            name: 'python-env',
            level: 'ok',
            detail: 'vox_py and its models libraries import',
            path: py,
          }
        : {
            name: 'python-env',
            level: 'error',
            detail: `the Python tools do not import: ${(r.stderr.trim().split('\n').at(-1) ?? '').slice(0, 200)}`,
            path: py,
            fix: `uv sync --frozen --project ${py}`,
          },
    );
  }

  // HyperFrames (pinned in package.json) and the Chrome it renders with.
  try {
    const req = moduleRequire();
    const pkg = req.resolve('hyperframes/package.json');
    const v = (JSON.parse(await readFile(pkg, 'utf8')) as { version?: string }).version ?? '?';
    const shells = await readdir(join(home, '.cache', 'puppeteer', 'chrome-headless-shell')).catch(
      () => [],
    );
    add(
      shells.length > 0
        ? {
            name: 'hyperframes',
            level: 'ok',
            detail: `HyperFrames ${v}; Chrome ${shells.sort().at(-1)}`,
            version: v,
          }
        : {
            name: 'hyperframes',
            level: 'warn',
            detail: `HyperFrames ${v}; no Chrome downloaded yet`,
            version: v,
            fix: `node ${join(dirname(pkg), 'bin', 'hyperframes.mjs')} browser ensure`,
          },
    );
  } catch {
    add({
      name: 'hyperframes',
      level: 'error',
      detail: 'HyperFrames is not installed',
      fix: 'pnpm install',
    });
  }

  // Models.
  if (py) {
    const silero = join(py, 'vox_py', 'models', 'silero_vad.onnx');
    const sha = await sha256File(silero);
    add(
      sha === SILERO_SHA256
        ? {
            name: 'model-silero-vad',
            level: 'ok',
            detail: `silero_vad.onnx sha256 ${sha}`,
            path: silero,
            licence: 'MIT',
          }
        : {
            name: 'model-silero-vad',
            level: 'error',
            detail: sha
              ? `silero_vad.onnx sha256 ${sha} ≠ pinned ${SILERO_SHA256}`
              : 'silero_vad.onnx missing',
            path: silero,
            licence: 'MIT',
            fix: 'restore py/vox_py/models/silero_vad.onnx from git',
          },
    );
  }
  const models = o.tools['models'];
  const face = models ? join(models, FACE_MODEL.name) : undefined;
  const faceSha = face ? await sha256File(face) : undefined;
  add(
    faceSha === FACE_MODEL.sha256
      ? {
          name: 'model-face',
          level: 'ok',
          detail: `${FACE_MODEL.name} sha256 ok`,
          path: face!,
          licence: 'Apache-2.0',
        }
      : {
          name: 'model-face',
          level: faceSha ? 'error' : 'warn',
          detail: faceSha
            ? `${FACE_MODEL.name} sha256 mismatch`
            : `${FACE_MODEL.name} not downloaded yet (the first facetrack job fetches it, ~1 MB)`,
          licence: 'Apache-2.0',
          ...(face ? { path: face } : {}),
          ...(faceSha ? { fix: `delete ${face} and run facetrack again` } : {}),
        },
  );
  const whisperLocal = models ? join(models, WHISPER_DIR, 'weights.safetensors') : undefined;
  const hfSnap = join(
    home,
    '.cache',
    'huggingface',
    'hub',
    `models--${WHISPER_REPO.replace('/', '--')}`,
    'snapshots',
    WHISPER_REVISION,
  );
  const hasLocal = whisperLocal
    ? await stat(whisperLocal).then(
        () => true,
        () => false,
      )
    : false;
  const hasHf = await stat(hfSnap).then(
    () => true,
    () => false,
  );
  add(
    hasLocal || hasHf
      ? {
          name: 'model-whisper',
          level: 'ok',
          detail: `${WHISPER_REPO}@${WHISPER_REVISION.slice(0, 12)} present`,
          path: hasLocal ? dirname(whisperLocal!) : hfSnap,
          licence: 'MIT',
        }
      : {
          name: 'model-whisper',
          level: 'warn',
          detail: `${WHISPER_REPO}@${WHISPER_REVISION.slice(0, 12)} not downloaded yet (the first transcribe fetches ~1.6 GB)`,
          licence: 'MIT',
        },
  );

  // Local image generation (phase 14d): optional, so a missing model is not a warning.
  for (const id of IMAGE_MODEL_IDS) {
    const info = IMAGE_MODELS[id];
    const installed = isInstalled(models, id);
    const gb = (n: number) => `${Math.round(n / 1e9)} GB`;
    const base = {
      name: `image-${id}`,
      licence: info.license,
      ...(installed && models ? { path: modelDir(models, id) } : {}),
    };
    if (installed) {
      add({ ...base, level: 'ok', detail: `${info.label} installed (${info.repo})` });
    } else if (info.gated) {
      add({
        ...base,
        level: 'ok',
        detail: `${info.label} not installed (optional, ${gb(info.downloadBytes)} download). It is gated on Hugging Face: ${hfTokenPresent(o.env) ? 'a token is set' : 'no HF_TOKEN is set'}`,
        fix: `accept the terms at ${info.licenseUrl}, create a read token, then: HF_TOKEN=<token> vox imagegen install --model ${id}. Vox never stores the token.`,
      });
    } else {
      add({
        ...base,
        level: 'ok',
        detail: `${info.label} not installed (optional local image generation, ${gb(info.downloadBytes)} download, about ${gb(info.installedBytes)} kept)`,
        fix: 'vox imagegen install, or turn it on in Settings',
      });
    }
  }

  add(
    o.config.contact
      ? { name: 'contact', level: 'ok', detail: 'contact set (Wikimedia Commons User-Agent)' }
      : {
          name: 'contact',
          level: 'warn',
          detail: 'no contact set for the Wikimedia Commons User-Agent',
          fix: 'run vox doctor in a terminal, or: vox config set contact <email or URL>',
        },
  );

  return { ok: checks.every((c) => c.level !== 'error'), checks };
}

export interface ProjectDoctorReport {
  /** Caption overrides whose word is gone (media removed, transcript redone, index out of range). */
  orphanOverrides: { sequenceId: string; wordKey: string; reason: string }[];
  lock: (LockInfo & { removed?: boolean }) | null;
}

/** Project checks; `unlock` removes `project.lock` (the only way to clear another host's lock). */
export async function doctorProject(
  dir: string,
  project: Project,
  transcriptOf: (mediaId: string) => Transcript | undefined,
  opts: { unlock?: boolean } = {},
): Promise<ProjectDoctorReport> {
  const media = new Map(project.media.map((m) => [m.id, m]));
  const orphanOverrides: ProjectDoctorReport['orphanOverrides'] = [];
  for (const s of project.sequences) {
    for (const ov of s.captions?.overrides ?? []) {
      const [mediaId, rev, idx] = ov.wordKey.split(':') as [string, string, string];
      const m = media.get(mediaId);
      const t = transcriptOf(mediaId);
      const reason = !m
        ? 'media removed'
        : m.transcriptRev !== rev
          ? 'transcript changed'
          : !t || Number(idx) >= t.words.length
            ? 'word missing'
            : undefined;
      if (reason) orphanOverrides.push({ sequenceId: s.id, wordKey: ov.wordKey, reason });
    }
  }
  let lock: ProjectDoctorReport['lock'] = null;
  const lockPath = join(dir, LOCK_FILE);
  try {
    lock = JSON.parse(await readFile(lockPath, 'utf8')) as LockInfo;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      lock = { pid: 0, host: '?', startedAt: '?' };
  }
  if (lock && opts.unlock) {
    // Report removed only when the file is really gone; a permission error propagates.
    await unlink(lockPath).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
    lock = { ...lock, removed: true };
  }
  return { orphanOverrides, lock };
}
