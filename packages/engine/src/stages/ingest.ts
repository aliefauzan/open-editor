// Ingest (engine spec "Stages", "Ingest analysis", "Ingest sources", "Ingest hardening"; R4 S2–S6,
// S33; D-13, D-15, D-25). Links go through yt-dlp behind the filtering proxy; local files and folders
// are copied (never linked) into `media/`. The engine's own copy is sniffed and analysed (no TOCTOU),
// then the CFR copy, proxy, audio, thumbnail sprite and peaks are written. Each output goes to an
// O_EXCL temp first and is then moved into place without replacing anything. Pure file work: the
// caller applies the returned media items as one `addMedia` batch (job result, D-15).
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { isVoxError, VoxError } from '../errors.ts';
import { writeAtomic } from '../history/files.ts';
import { EXCL_FLAGS, placeNoReplace } from '../fs/no-replace.ts';
import { newId } from '../model/ids.ts';
import type { MediaItem } from '../model/schema.ts';
import type { Resolver } from '../net/address.ts';
import type { Dial } from '../net/proxy.ts';
import { analyzeMedia, type MediaAnalysis } from './media/analyze.ts';
import { copyFileSafe, listFolderFiles, type SkippedEntry } from './media/copy.ts';
import { audioArgs, computePeaks, peaksArgs, thumbsArgs } from './media/derive.ts';
import { h264Encoder, markHardwareFailed } from './media/encoders.ts';
import { progressReader, withProgress } from './media/progress.ts';
import { cfrCopyArgs, imageReencodeArgs, proxyArgs, type H264Encoder } from './media/proxy.ts';
import { runTool, type RunOptions } from './media/run.ts';
import { SNIFF_BYTES, sniffBytes, type Sniffed, type SniffedMedia } from './media/sniff.ts';
import { classifyUrl, type UrlKind } from './sources.ts';
import { downloadWithYtdlp } from './ytdlp.ts';
import type { CookieBrowser } from './ytdlpArgs.ts';

/** Largest local file copied in (links are capped at 4G by yt-dlp's `--max-filesize`). */
export const MAX_INGEST_BYTES = 16 * 1024 ** 3;

export const IngestArgsSchema = z.strictObject({
  projectId: z.string(),
  /** http(s) links or absolute local paths (files or folders). */
  inputs: z.array(z.string().min(1)).min(1).max(100),
  playlist: z.boolean().optional(),
  /** false: no proxy, thumbs or peaks (styles Part C reference videos). */
  proxies: z.boolean().optional(),
});
export type IngestArgs = z.infer<typeof IngestArgsSchema>;

export const DocTextResultSchema = z.strictObject({
  text: z.string(),
  pages: z.int().nonnegative(),
});

export interface IngestEnv {
  projectDir: string;
  /** The project's media when the job started (rerun detection). */
  existing: readonly MediaItem[];
  tools: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  progress?: (p: number, message?: string) => void;
  redact?: (s: string) => string;
  /** From `readConfig()` only (S33). */
  cookiesFromBrowser?: CookieBrowser | null;
  /** `vox_py.doctext` through the bridge. */
  docText: (path: string) => Promise<z.infer<typeof DocTextResultSchema>>;
  net?: { resolver?: Resolver; dial?: Dial };
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export interface IngestedMedia {
  input: string;
  source: UrlKind | 'file';
  media: MediaItem;
  /** True when the same file was ingested before (no new media item). */
  reused: boolean;
}

export interface IngestResult {
  media: IngestedMedia[];
  /** Links whose post or playlist held more videos than were taken. */
  posts: { url: string; count: number; taken: number }[];
  /** Folder entries that were not copied (symlinks, special files …). */
  skipped: SkippedEntry[];
}

const DIRS = ['media', 'proxies', 'audio', 'thumbs', 'peaks', 'cache/ingest', 'cache/media'];
const PART = /^\.vox-part-(\d+)-/;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Removes `.vox-part-<pid>-…` temps of engine processes that no longer run (D-25). */
export async function sweepPartFiles(projectDir: string): Promise<number> {
  let n = 0;
  for (const d of DIRS) {
    const dir = join(projectDir, d);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const m = PART.exec(name);
      if (!m || pidAlive(Number(m[1]))) continue;
      await unlink(join(dir, name)).then(
        () => n++,
        () => undefined,
      );
    }
  }
  return n;
}

/** ffmpeg `-progress` for one step: 0..1 of `durationMs` goes to `report`. */
interface FfProgress {
  durationMs: number | undefined;
  report: (p: number) => void;
}

/**
 * Weighted progress over the steps of one file (each step reports 0..1). Steps may run at the same
 * time; the total never goes backwards, and the message names the costliest step still running (so
 * a short audio step beside the CFR copy does not make the label flicker).
 */
function stepProgress(
  weights: ReadonlyMap<string, number>,
  report: ((p: number, message?: string) => void) | undefined,
): (step: string, label: string) => (p: number) => void {
  let total = 0;
  for (const w of weights.values()) total += w;
  const done = new Map<string, number>();
  const labels = new Map<string, string>();
  let last = -1;
  return (step, label) => (p) => {
    if (!Number.isFinite(p)) return;
    labels.set(step, label);
    done.set(step, Math.max(done.get(step) ?? 0, Math.min(1, Math.max(0, p))));
    let sum = 0;
    let busy: [number, string] | undefined;
    for (const [k, w] of weights) {
      const d = done.get(k) ?? 0;
      sum += w * d;
      const l = labels.get(k);
      if (l !== undefined && d < 1 && (!busy || w > busy[0])) busy = [w, l];
    }
    const v = total > 0 ? sum / total : 1;
    if (v < last) return;
    last = v;
    report?.(v, busy?.[1] ?? label);
  };
}

/** Rough cost of each ingest step, relative to the analysis (ffprobe, pts scan, ebur128). */
const STEP_WEIGHT = { analyse: 1, cfr: 6, proxy: 3, thumbs: 0.5, audio: 1, peaks: 0.5 } as const;

/** Runs ffmpeg into an O_EXCL temp beside `final`, then moves it into place (never replaces). */
async function ffmpegInto(
  final: string,
  args: (out: string) => string[],
  ro: RunOptions,
  created: string[],
  progress?: FfProgress,
): Promise<void> {
  const temp = join(
    dirname(final),
    `.vox-part-${process.pid}-${randomBytes(6).toString('hex')}-${basename(final)}`,
  );
  await (await open(temp, EXCL_FLAGS, 0o644)).close();
  try {
    if (progress) {
      await runTool('ffmpeg', withProgress(args(temp)), {
        ...ro,
        onStdout: progressReader(progress.durationMs, progress.report),
      });
    } else {
      await runTool('ffmpeg', args(temp), ro);
    }
    await place(temp, final, created);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function place(temp: string, final: string, created: string[]): Promise<void> {
  if (!(await placeNoReplace(temp, final))) {
    throw new VoxError(
      'PATH_INVALID',
      `${basename(final)} already exists in the project folder.`,
      'Run ingest again; a new media id is picked each time.',
      { details: { path: final } },
    );
  }
  created.push(final);
}

async function writeNew(final: string, data: string, created: string[]): Promise<void> {
  const temp = join(
    dirname(final),
    `.vox-part-${process.pid}-${randomBytes(6).toString('hex')}-${basename(final)}`,
  );
  const fh = await open(temp, EXCL_FLAGS, 0o644);
  try {
    await fh.writeFile(data);
    await fh.close();
    await place(temp, final, created);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function readHead(path: string): Promise<Uint8Array> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

interface IndexEntry {
  mediaId: string;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await (await open(path, 'r')).close();
    return true;
  } catch {
    return false;
  }
}

/** The media item for `mediaId` if it is still in the project and its file is on disk. */
async function liveMedia(
  env: IngestEnv,
  known: Map<string, MediaItem>,
  mediaId: string,
): Promise<MediaItem | undefined> {
  const m = known.get(mediaId);
  if (!m) return undefined;
  return (await exists(join(env.projectDir, m.path))) ? m : undefined;
}

const textUnsupported = (what: string) =>
  new VoxError(
    'MEDIA_UNSUPPORTED',
    `The document is not ${what}.`,
    'Save it as UTF-8 text or PDF, then add it again.',
  );

/** Copies one local file in and builds its media item (or returns the earlier one for the same bytes). */
async function ingestFile(
  env: IngestEnv,
  src: string,
  o: {
    within?: string;
    origin: MediaItem['origin'];
    proxies: boolean;
    known: Map<string, MediaItem>;
  },
): Promise<{ media: MediaItem; reused: boolean }> {
  const dir = env.projectDir;
  const id = newId('m_');
  const created: string[] = [];
  const ro: RunOptions = {
    ...(env.signal ? { signal: env.signal } : {}),
    ...(env.redact ? { redact: env.redact } : {}),
    tools: {
      ...(env.tools['ffmpeg'] ? { ffmpeg: env.tools['ffmpeg'] } : {}),
      ...(env.tools['ffprobe'] ? { ffprobe: env.tools['ffprobe'] } : {}),
    },
  };
  const staging = join(dir, 'media', `${id}.src`);
  try {
    const { sha256 } = await copyFileSafe(src, staging, {
      ...(env.signal ? { signal: env.signal } : {}),
      ...(o.within ? { within: o.within } : {}),
      maxBytes: MAX_INGEST_BYTES,
    });
    created.push(staging);
    const index = join(dir, 'cache', 'ingest', `${sha256}.json`);
    const prior = await readJson<IndexEntry>(index);
    const reuse = prior && (await liveMedia(env, o.known, prior.mediaId));
    if (reuse) {
      await unlink(staging).catch(() => undefined);
      return { media: reuse, reused: true };
    }
    const sniffed = sniffBytes(await readHead(staging), basename(src));
    const media = await buildMedia(env, id, staging, sniffed, o, ro, created);
    await writeAtomic(join(dir, 'cache', 'media', `${id}.json`), JSON.stringify({ sha256 }));
    await writeAtomic(index, JSON.stringify({ mediaId: id } satisfies IndexEntry));
    o.known.set(id, media);
    return { media, reused: false };
  } catch (e) {
    for (const f of created) await unlink(f).catch(() => undefined);
    throw e;
  }
}

async function buildMedia(
  env: IngestEnv,
  id: string,
  staging: string,
  sniffed: Sniffed,
  o: { origin: MediaItem['origin']; proxies: boolean },
  ro: RunOptions,
  created: string[],
): Promise<MediaItem> {
  const dir = env.projectDir;
  const rel = (p: string) => p.slice(dir.length + 1);
  const base = { id, origin: o.origin, tags: [] as string[] };

  if (sniffed.kind === 'document') {
    const path = join(dir, 'media', `${id}.${sniffed.ext}`);
    await place(staging, path, created);
    const txt = join(dir, 'media', `${id}.txt`);
    if (sniffed.format === 'pdf') {
      const { text } = await env.docText(path);
      await writeNew(txt, text, created);
    } else {
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
      } catch {
        throw textUnsupported('UTF-8 text');
      }
      if (sniffed.ext !== 'txt') await writeNew(txt, text, created);
    }
    return { ...base, kind: 'document', path: rel(path), textPath: rel(txt) };
  }

  if (sniffed.kind === 'image') {
    const ext = sniffed.format === 'png' ? 'png' : 'jpg';
    const path = join(dir, 'media', `${id}.${ext}`);
    // S6: the stored image is a fresh encode of the decoded picture, never the uploaded bytes.
    await ffmpegInto(
      path,
      (out) => imageReencodeArgs({ input: staging, format: sniffed.format, output: out }),
      ro,
      created,
    );
    await unlink(staging).catch(() => undefined);
    const a = await analyzeMedia(path, { ...sniffed, ext }, ro);
    return {
      ...base,
      kind: 'image',
      path: rel(path),
      ...(a.width ? { width: a.width } : {}),
      ...(a.height ? { height: a.height } : {}),
    };
  }

  const path = join(dir, 'media', `${id}.${sniffed.ext}`);
  await place(staging, path, created);
  env.progress?.(0, 'Analysing');
  const a: MediaAnalysis = await analyzeMedia(path, sniffed, { ...ro, cfrRates: 'all' });
  const isVideo = a.kind === 'video';
  const weights = new Map<string, number>([['analyse', STEP_WEIGHT.analyse]]);
  if (isVideo && a.cfr) weights.set('cfr', STEP_WEIGHT.cfr);
  if (isVideo && o.proxies && a.fps) {
    weights.set('proxy', STEP_WEIGHT.proxy);
    if (a.durationMs) weights.set('thumbs', STEP_WEIGHT.thumbs);
  }
  if (a.hasAudio) {
    weights.set('audio', STEP_WEIGHT.audio);
    if (o.proxies) weights.set('peaks', STEP_WEIGHT.peaks);
  }
  const step = stepProgress(weights, env.progress);
  step('analyse', 'Analysing')(1);
  const ff = (name: string, label: string): FfProgress => ({
    durationMs: a.durationMs,
    report: step(name, label),
  });

  // Picture (CFR copy → proxy → thumbs) and sound (audio → peaks) are independent: they run side by
  // side. Both finish (settle) before an error is thrown, so the caller's cleanup sees every file.
  let cfrPath: string | undefined;
  let proxyPath: string | undefined;
  let thumbsPath: string | undefined;
  const picture = async (): Promise<void> => {
    let video = { path, format: sniffed.format as SniffedMedia['format'] };
    if (isVideo && a.cfr) {
      const out = join(dir, 'media', `${id}.cfr.mp4`);
      const cfr = a.cfr;
      const copy = (encoder: H264Encoder) =>
        ffmpegInto(
          out,
          (tmp) =>
            cfrCopyArgs({
              input: path,
              format: sniffed.format,
              output: tmp,
              fps: cfr.fps,
              audioCodec: a.audioCodec,
              encoder,
            }),
          ro,
          created,
          ff('cfr', 'Converting frame rate'),
        );
      const encoder = await h264Encoder(ro);
      try {
        await copy(encoder);
      } catch (e) {
        // A hardware encode that fails (no encoder session, unsupported size …) is redone in software.
        if (encoder !== 'videotoolbox' || !isVoxError(e) || e.code !== 'TOOL_FAILED') throw e;
        if (env.signal?.aborted) throw e;
        markHardwareFailed(ro);
        await copy('libx264');
      }
      cfrPath = out;
      video = { path: out, format: 'mov' };
    }
    if (isVideo && o.proxies && a.fps) {
      const fps = a.fps;
      const proxy = join(dir, 'proxies', `${id}.mp4`);
      await ffmpegInto(
        proxy,
        (out) => proxyArgs({ input: video.path, format: video.format, output: out, fps }),
        ro,
        created,
        ff('proxy', 'Making proxy'),
      );
      proxyPath = proxy;
      if (a.durationMs) {
        const d = a.durationMs;
        const thumbs = join(dir, 'thumbs', `${id}.jpg`);
        await ffmpegInto(thumbs, (out) => thumbsArgs(proxy, 'mov', out, d), ro, created);
        step('thumbs', 'Making thumbnails')(1);
        thumbsPath = thumbs;
      }
    }
  };
  let audioPath: string | undefined;
  let peaksPath: string | undefined;
  const sound = async (): Promise<void> => {
    if (!a.hasAudio) return;
    const audio = join(dir, 'audio', `${id}.m4a`);
    await ffmpegInto(
      audio,
      (out) => audioArgs(path, sniffed.format, out),
      ro,
      created,
      ff('audio', 'Extracting audio'),
    );
    audioPath = audio;
    if (o.proxies) {
      const seconds = (a.durationMs ?? 0) / 1000;
      const { stdout } = await runTool('ffmpeg', peaksArgs(audio, 'mov'), {
        ...ro,
        maxStdoutBytes: Math.ceil(seconds * 8000 * 1.1) + (1 << 20),
        binaryStdout: true,
      });
      const peaks = join(dir, 'peaks', `${id}.json`);
      await writeNew(peaks, JSON.stringify(computePeaks(Buffer.from(stdout, 'latin1'))), created);
      step('peaks', 'Extracting audio')(1);
      peaksPath = peaks;
    }
  };
  const settled = await Promise.allSettled([picture(), sound()]);
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
  return {
    ...base,
    kind: a.kind,
    path: rel(path),
    ...(proxyPath ? { proxyPath: rel(proxyPath) } : {}),
    ...(audioPath ? { audioPath: rel(audioPath) } : {}),
    ...(thumbsPath ? { thumbsPath: rel(thumbsPath) } : {}),
    ...(peaksPath ? { peaksPath: rel(peaksPath) } : {}),
    ...(a.durationMs && a.durationMs > 0 ? { durationMs: Math.round(a.durationMs) } : {}),
    ...(a.width ? { width: a.width } : {}),
    ...(a.height ? { height: a.height } : {}),
    hasAudio: a.hasAudio,
    ...(a.fps ? { fps: a.fps } : {}),
    ...(a.kind === 'video' ? { vfr: a.vfr } : {}),
    ...(cfrPath ? { cfrPath: rel(cfrPath) } : {}),
    ...(a.loudness ? { loudness: a.loudness } : {}),
  };
}

const looksLikeUrl = (s: string) => /^[a-z][a-z0-9+.-]*:/i.test(s.trim()) && !isAbsolute(s);

/** Ingests links and local files/folders into the project folder; returns the media items. */
export async function ingest(env: IngestEnv, args: IngestArgs): Promise<IngestResult> {
  for (const d of DIRS) await mkdir(join(env.projectDir, d), { recursive: true, mode: 0o700 });
  await sweepPartFiles(env.projectDir);
  const known = new Map(env.existing.map((m) => [m.id, m] as const));
  const proxies = args.proxies !== false;
  const out: IngestResult = { media: [], posts: [], skipped: [] };
  const total = args.inputs.length;
  const sub = (i: number) => (p: number, m?: string) =>
    env.progress?.((i + Math.min(1, p)) / total, m);

  for (const [i, input] of args.inputs.entries()) {
    if (env.signal?.aborted)
      throw new VoxError('CANCELLED', 'Ingest was cancelled.', 'Run it again when ready.');
    const progress = sub(i);
    const kind = classifyUrl(input);
    if (kind !== 'invalid') {
      out.media.push(
        ...(await ingestUrl({ ...env, progress }, input, kind, args, proxies, known, out)),
      );
      continue;
    }
    if (looksLikeUrl(input)) {
      throw new VoxError(
        'URL_INVALID',
        `Not an http(s) link: ${input}`,
        'Paste an http(s) link, or add the video as a local file.',
      );
    }
    if (!isAbsolute(input)) {
      throw new VoxError(
        'PATH_INVALID',
        `Local paths must be absolute: ${input}`,
        'Pass the full path to the file or folder.',
      );
    }
    const e2 = { ...env, progress };
    const st = await lstat(input).catch(() => undefined);
    if (!st) {
      throw new VoxError(
        'NOT_FOUND',
        `No file or folder at ${input}`,
        'Check the path and try again.',
        { details: { path: input } },
      );
    }
    if (st.isDirectory()) {
      const listing = await listFolderFiles(input);
      out.skipped.push(...listing.skipped);
      for (const f of listing.files) {
        const r = await ingestFile(e2, f, {
          within: listing.root,
          origin: { type: 'upload' },
          proxies,
          known,
        });
        out.media.push({ input: f, source: 'file', ...r });
      }
    } else {
      const r = await ingestFile(e2, input, { origin: { type: 'upload' }, proxies, known });
      out.media.push({ input, source: 'file', ...r });
    }
  }
  return out;
}

async function ingestUrl(
  env: IngestEnv,
  url: string,
  kind: UrlKind,
  args: IngestArgs,
  proxies: boolean,
  known: Map<string, MediaItem>,
  out: IngestResult,
): Promise<IngestedMedia[]> {
  const href = new URL(url.trim()).href;
  const indexPath = join(
    env.projectDir,
    'cache',
    'ingest',
    `url-${sha(`${href}\n${args.playlist === true}`)}.json`,
  );
  const prior = await readJson<{ mediaIds: string[]; count: number }>(indexPath);
  if (prior) {
    const live = await Promise.all(prior.mediaIds.map((id) => liveMedia(env, known, id)));
    if (live.every((m) => m !== undefined) && live.length > 0) {
      if (prior.count > live.length)
        out.posts.push({ url: href, count: prior.count, taken: live.length });
      return live.map((m) => ({ input: url, source: kind, media: m!, reused: true }));
    }
  }
  const dl = await mkdtemp(join(env.projectDir, 'cache', 'ingest', 'dl-'));
  // The download takes the first half of this input's progress, the file steps the second. yt-dlp
  // restarts at 0 for each stream it fetches (video, then audio), so its value only goes up.
  let downloaded = 0;
  const onDownload = (p: number): void => {
    if (p < downloaded) return;
    downloaded = p;
    env.progress?.(p * 0.5, 'Downloading');
  };
  try {
    const report = await downloadWithYtdlp({
      url: href,
      outDir: dl,
      outputId: 'download',
      ...(args.playlist ? { playlist: true } : {}),
      cookiesFromBrowser: env.cookiesFromBrowser ?? null,
      tools: env.tools,
      ...(env.signal ? { signal: env.signal } : {}),
      ...(env.redact ? { redact: env.redact } : {}),
      onProgress: onDownload,
      ...(env.net ? { net: env.net } : {}),
      ...(env.sleep ? { sleep: env.sleep } : {}),
      ...(env.env ? { env: env.env } : {}),
    });
    const items: IngestedMedia[] = [];
    // Only files yt-dlp wrote into our folder under the engine-generated name.
    const files = report.files.filter(
      (f) => dirname(f.filepath) === dl && basename(f.filepath).startsWith('download'),
    );
    for (const [i, f] of files.entries()) {
      const progress = (p: number, m?: string) =>
        env.progress?.(0.5 + ((i + Math.min(1, p)) / files.length) * 0.5, m);
      const r = await ingestFile({ ...env, progress }, f.filepath, {
        within: dl,
        origin: { type: 'url', url: href },
        proxies,
        known,
      });
      items.push({ input: url, source: kind, ...r });
    }
    if (report.count > items.length)
      out.posts.push({ url: href, count: report.count, taken: items.length });
    await writeAtomic(
      indexPath,
      JSON.stringify({ mediaIds: items.map((m) => m.media.id), count: report.count }),
    );
    return items;
  } finally {
    await rm(dl, { recursive: true, force: true });
  }
}

/**
 * One local file in as a media item with the given origin (archive downloads, cutouts and generated
 * images, phase 05). Same checks as a local ingest: content sniffing, a fresh image encode (S6),
 * analysis; the same bytes again return the earlier item (`reused`).
 */
export async function ingestOne(
  env: IngestEnv,
  path: string,
  origin: MediaItem['origin'],
): Promise<{ media: MediaItem; reused: boolean }> {
  for (const d of DIRS) await mkdir(join(env.projectDir, d), { recursive: true, mode: 0o700 });
  const known = new Map(env.existing.map((m) => [m.id, m] as const));
  return ingestFile(env, path, { origin, proxies: true, known });
}
