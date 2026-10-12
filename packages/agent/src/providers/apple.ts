// Apple on-device model as a LanguageModelV4 over the `vox-apple-llm` helper (agent spec "Apple
// on-device model", D-10, D-22). One long-lived helper process answers JSON lines in order; this
// side owns the timeout: a helper that does not answer in time is killed and the next request
// starts a fresh one. The helper has no tool calls, so the agent uses it in plan mode only. On
// macOS 27 the model also sees images (D-74): image parts of user messages are written to a
// private temp dir, passed to the helper as file paths and deleted after the answer; `--status`
// reports `vision`. Cost is 0 (prices.ts treats `apple` as local). `createAppleEmbedder` (D-77) runs
// `vox-apple-llm --embed` once per call: on-device NaturalLanguage sentence vectors for the `embed`
// role (screenplay match), which need no Apple Intelligence.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InvalidPromptError,
  UnsupportedFunctionalityError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4GenerateResult,
  type LanguageModelV4Prompt,
  type LanguageModelV4StreamPart,
  type LanguageModelV4Usage,
  type SharedV4Warning,
} from '@ai-sdk/provider';
import { VoxError } from '../errors.ts';
import type { Embedder } from '../screenplay/match.ts';
import {
  APPLE_EMBED_MAX_TEXTS,
  APPLE_EMBED_MAX_TEXT_LENGTH,
  APPLE_MAX_IMAGES,
  AppleEmbedRequest,
  JsonLineSplitter,
  appleStatusValues,
  encodeAppleRequest,
  parseAppleEmbedLine,
  parseAppleResponseLine,
  parseAppleStatusLine,
  type AppleMessage,
  type AppleRequestInput,
  type AppleResponse,
  type AppleStatus,
  type AppleStatusValue,
} from './apple-protocol.ts';

export interface AppleModelOptions {
  /** The helper binary (the app ships it in `<resources>/bin/vox-apple-llm`). */
  command: string;
  /** Arguments before the helper's own (tests: the fake script after `node`). */
  args?: readonly string[];
  /** Extra environment; the helper otherwise gets only HOME, TMPDIR, LANG, LC_ALL and PATH. */
  env?: Readonly<Record<string, string>>;
  /** Per-request answer timeout (default 120 s); on expiry the helper is killed. */
  timeoutMs?: number;
  /** `--status` timeout (default 15 s). */
  statusTimeoutMs?: number;
}

export interface AppleLanguageModel extends LanguageModelV4 {
  /** Stops the helper process (a later request starts a new one). */
  close(): void;
  /** The running helper's pid, if any. */
  pid(): number | undefined;
}

export const APPLE_MODEL_ID = 'apple-on-device';
export const APPLE_DEFAULT_TIMEOUT_MS = 120_000;
/** `maxTokens` when the caller sets no `maxOutputTokens` (the `fast` role default). */
export const APPLE_DEFAULT_MAX_TOKENS = 2_000;
const STATUS_TIMEOUT_MS = 15_000;
const STDERR_LINES = 40;
const ENV_PASSTHROUGH = ['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'PATH'] as const;

const STATUS_HINTS: Record<Exclude<AppleStatusValue, 'ready'>, string> = {
  notEnabled: 'Turn on Apple Intelligence in System Settings, then probe again.',
  notEligible: 'This Mac cannot run Apple Intelligence; choose another model for this role.',
  modelNotReady: 'The on-device model is still downloading; try again later.',
  unsupportedOS: 'The Apple on-device model needs macOS 26 or later.',
};

/** Why the Apple model cannot fill the `vision` role, shown by the probe and `roles set`. */
export const APPLE_NO_VISION_REASON =
  'the Apple on-device model cannot see images on this Mac (image input needs macOS 27 with Apple Intelligence)';

/** `--status` value → usable or not, with the hint shown to the user. */
export function appleStatusInfo(status: AppleStatusValue): { usable: boolean; hint: string } {
  return status === 'ready'
    ? { usable: true, hint: '' }
    : { usable: false, hint: STATUS_HINTS[status] };
}

function helperEnv(extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_PASSTHROUGH) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  return { ...env, ...extra };
}

const unavailable = (message: string, hint: string, details?: Record<string, unknown>) =>
  new VoxError('APPLE_UNAVAILABLE', message, hint, details ? { details } : {});

const MISSING_HINT = 'The app ships `vox-apple-llm`; reinstall Vox Studio if it is missing.';

/** Runs `vox-apple-llm --status`. Throws APPLE_UNAVAILABLE when the helper cannot report. */
export function appleStatus(opts: AppleModelOptions): Promise<AppleStatus> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.command, [...(opts.args ?? []), '--status'], {
      env: helperEnv(opts.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      signal: AbortSignal.timeout(opts.statusTimeoutMs ?? STATUS_TIMEOUT_MS),
    });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.resume();
    child.once('error', (err) => {
      reject(unavailable('the Apple helper could not run', MISSING_HINT, { error: err.name }));
    });
    child.once('close', (code) => {
      const parsed = parseAppleStatusLine(stdout);
      if (code === 0 && parsed.ok) resolve(parsed.value);
      else
        reject(
          unavailable(
            `the Apple helper did not report its status (exit ${String(code)})`,
            MISSING_HINT,
          ),
        );
    });
  });
}

type Answer = Exclude<AppleResponse, { error: unknown }>;

interface Pending {
  id: string;
  child: ChildProcessWithoutNullStreams;
  resolve: (a: Answer) => void;
  reject: (e: unknown) => void;
}

/** One helper process at a time; requests run one after another (answers come in order anyway). */
class HelperProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending: Pending | null = null;
  private stderrTail: string[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private nextId = 0;
  private readonly opts: AppleModelOptions;

  constructor(opts: AppleModelOptions) {
    this.opts = opts;
  }

  pid(): number | undefined {
    return this.child?.pid;
  }

  close(): void {
    this.kill();
  }

  request(req: Omit<AppleRequestInput, 'id'>, signal: AbortSignal | undefined): Promise<Answer> {
    const run = this.chain.then(() => this.exchange(req, signal));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }

  private fail(err: unknown): void {
    const p = this.pending;
    this.pending = null;
    p?.reject(err);
  }

  /** Fails the pending request only if it was sent to `child` (an old process may exit late). */
  private failFor(child: ChildProcessWithoutNullStreams, err: unknown): void {
    if (this.pending?.child === child) this.fail(err);
  }

  private start(): ChildProcessWithoutNullStreams {
    const child = spawn(this.opts.command, [...(this.opts.args ?? [])], {
      env: helperEnv(this.opts.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.stderrTail = [];
    const splitter = new JsonLineSplitter();
    const errSplitter = new JsonLineSplitter();
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      for (const line of splitter.push(chunk)) this.onLine(child, line);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      this.stderrTail.push(...errSplitter.push(chunk));
      this.stderrTail = this.stderrTail.slice(-STDERR_LINES);
    });
    child.stdin.on('error', () => {
      // the helper died before reading; the exit handler reports it
    });
    child.once('error', (err) => {
      if (this.child !== child) return;
      this.child = null;
      if (child.pid === undefined) {
        this.failFor(
          child,
          unavailable('the Apple helper could not start', MISSING_HINT, { error: err.name }),
        );
      } else {
        this.failFor(child, appleFailed('crash', 'the Apple helper failed', {}, err));
      }
    });
    child.once('exit', (code, sig) => {
      const tail = [...this.stderrTail, ...[errSplitter.end()].filter((l) => l !== null)];
      if (this.child === child) this.child = null;
      this.failFor(
        child,
        appleFailed(
          'crash',
          `the Apple helper stopped (${sig ?? `exit ${String(code)}`})`,
          { exitCode: code, signal: sig },
          tail.join('\n'),
        ),
      );
    });
    // an idle helper must not keep the CLI alive; its stdin closes when we exit
    child.unref();
    for (const s of [child.stdin, child.stdout, child.stderr]) {
      (s as unknown as { unref?: () => void }).unref?.();
    }
    return child;
  }

  private onLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.child !== child) return;
    const p = this.pending;
    const parsed = parseAppleResponseLine(line);
    if (p === null || !parsed.ok || (parsed.value.id !== undefined && parsed.value.id !== p.id)) {
      this.kill();
      this.fail(appleFailed('protocol', 'the Apple helper sent an unexpected line', {}));
      return;
    }
    this.pending = null;
    const answer = parsed.value;
    if ('error' in answer) p.reject(mapHelperError(answer.error.code, answer.error.message));
    else p.resolve(answer);
  }

  private exchange(
    req: Omit<AppleRequestInput, 'id'>,
    signal: AbortSignal | undefined,
  ): Promise<Answer> {
    signal?.throwIfAborted();
    const id = `r${String(++this.nextId)}`;
    const line = encodeAppleRequest({ id, ...req });
    const child = this.child ?? (this.child = this.start());
    const timeoutMs = this.opts.timeoutMs ?? APPLE_DEFAULT_TIMEOUT_MS;
    return new Promise<Answer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.kill();
        this.fail(
          appleFailed('timeout', `the Apple helper did not answer within ${String(timeoutMs)} ms`, {
            timeoutMs,
          }),
        );
      }, timeoutMs);
      const onAbort = () => {
        this.kill();
        this.fail(signal?.reason ?? new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      this.pending = {
        id,
        child,
        resolve: (a) => {
          done();
          resolve(a);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      };
      child.stdin.write(line);
    });
  }
}

function appleFailed(
  reason: 'crash' | 'timeout' | 'protocol' | 'guardrail' | 'generation' | 'badRequest',
  message: string,
  details: Record<string, unknown>,
  cause?: unknown,
): VoxError {
  const hints: Record<typeof reason, string> = {
    crash:
      'The Apple helper stopped; the next request restarts it. Try again or use another model.',
    timeout: 'The on-device model took too long; try a shorter request or another model.',
    protocol: 'The Apple helper answered something unexpected; reinstall Vox Studio.',
    guardrail: "Apple's model refused this request; use another model for this role.",
    generation: 'The on-device model failed to answer; try again or use another model.',
    badRequest: 'Vox sent a request the helper rejected; please report this.',
  };
  return new VoxError('APPLE_FAILED', message, hints[reason], {
    details: { reason, ...details },
    ...(cause !== undefined && cause !== '' && { cause }),
  });
}

function mapHelperError(code: string, message: string): VoxError {
  switch (code) {
    case 'unavailable': {
      const status = /^Apple on-device model: (\w+)$/.exec(message)?.[1];
      const known = appleStatusValues.find((s) => s === status && s !== 'ready');
      return unavailable(
        known ? `Apple on-device model: ${known}` : 'the Apple on-device model is unavailable',
        appleStatusInfo(known ?? 'modelNotReady').hint,
        { status: known ?? 'assetsUnavailable' },
      );
    }
    case 'contextOverflow':
      return new VoxError(
        'CONTEXT_OVERFLOW',
        'the request is larger than the on-device model context',
        'Shorten the request; the loop compacts and retries once.',
        { details: { provider: 'apple' } },
      );
    case 'assetsMissing':
      return unavailable(`Apple helper: ${message}`, ASSETS_HINT, { status: 'assetsMissing' });
    case 'visionUnavailable':
      return unavailable(
        APPLE_NO_VISION_REASON,
        'Choose another model for the vision role, or update to macOS 27.',
        { status: 'noVision' },
      );
    case 'guardrail':
    case 'badRequest':
      return appleFailed(code, `Apple helper: ${message}`, {});
    default:
      return appleFailed('generation', `Apple helper: ${message}`, {});
  }
}

const unsupported = (functionality: string) =>
  new UnsupportedFunctionalityError({
    functionality,
    message: `The Apple on-device model does not support ${functionality}.`,
  });

/** One image of a user message, before it is written to a temp file. */
interface ImageInput {
  bytes: Uint8Array;
  extension: string;
}

type Part = Extract<
  LanguageModelV4Prompt[number],
  { role: 'user' | 'assistant' }
>['content'][number];

/** Image bytes of a user file part; any other file is unsupported. */
function imageOf(part: Extract<Part, { type: 'file' }>): ImageInput {
  if (!part.mediaType.startsWith('image/')) throw unsupported(`file input (${part.mediaType})`);
  if (part.data.type !== 'data') throw unsupported(`image input as ${part.data.type}`);
  const raw = part.data.data;
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'base64') : raw;
  const sub = part.mediaType.slice('image/'.length).toLowerCase();
  const extension = sub === 'jpeg' ? 'jpg' : /^[a-z0-9]{1,8}$/.test(sub) ? sub : 'img';
  return { bytes, extension };
}

function contentOf(
  parts: ReadonlyArray<Part>,
  role: 'user' | 'assistant',
): { text: string; images: ImageInput[] } {
  const texts: string[] = [];
  const images: ImageInput[] = [];
  for (const part of parts) {
    if (part.type === 'text') texts.push(part.text);
    else if (part.type === 'file') {
      if (role !== 'user') throw unsupported(`file or image input (${role} message)`);
      images.push(imageOf(part));
    } else if (part.type === 'reasoning' || part.type === 'reasoning-file') continue;
    else throw unsupported(`tool calls (${part.type} in a ${role} message)`);
  }
  return { text: texts.join('\n'), images };
}

/** Helper messages, with the images of each message kept apart until they are written. */
function toHelperPrompt(prompt: LanguageModelV4Prompt): {
  system: string;
  messages: AppleMessage[];
  images: ImageInput[][];
} {
  const system: string[] = [];
  const messages: AppleMessage[] = [];
  const images: ImageInput[][] = [];
  for (const m of prompt) {
    if (m.role === 'system') system.push(m.content);
    else if (m.role === 'user' || m.role === 'assistant') {
      const c = contentOf(m.content, m.role);
      messages.push({ role: m.role, content: c.text });
      images.push(c.images);
    } else throw unsupported('tool results');
  }
  if (messages.at(-1)?.role !== 'user') {
    throw new InvalidPromptError({ prompt, message: 'the last message must be from the user' });
  }
  const count = images.reduce((n, list) => n + list.length, 0);
  if (count > APPLE_MAX_IMAGES) {
    throw new InvalidPromptError({
      prompt,
      message: `the Apple on-device model takes at most ${String(APPLE_MAX_IMAGES)} images per request (got ${String(count)})`,
    });
  }
  return { system: system.join('\n\n'), messages, images };
}

/**
 * Writes the images to a new private temp dir (0700, files 0600), runs `fn` with the messages
 * that name them, and deletes the dir afterwards, also when `fn` fails.
 */
async function withImageFiles<T>(
  messages: AppleMessage[],
  images: ImageInput[][],
  fn: (messages: AppleMessage[]) => Promise<T>,
): Promise<T> {
  if (images.every((list) => list.length === 0)) return fn(messages);
  const dir = await mkdtemp(join(tmpdir(), 'vox-apple-img-'));
  try {
    const withPaths = await Promise.all(
      messages.map(async (m, i) => {
        const list = images[i] ?? [];
        if (list.length === 0) return m;
        const paths = await Promise.all(
          list.map(async (img, j) => {
            const path = join(dir, `${String(i)}-${String(j)}.${img.extension}`);
            await writeFile(path, img.bytes, { mode: 0o600, flag: 'wx' });
            return path;
          }),
        );
        return { ...m, images: paths };
      }),
    );
    return await fn(withPaths);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const IGNORED_SETTINGS = [
  'topP',
  'topK',
  'stopSequences',
  'presencePenalty',
  'frequencyPenalty',
  'seed',
] as const;

function buildRequest(options: LanguageModelV4CallOptions): {
  request: Omit<AppleRequestInput, 'id'>;
  images: ImageInput[][];
  warnings: SharedV4Warning[];
} {
  if (options.tools !== undefined && options.tools.length > 0) throw unsupported('tool calling');
  const warnings: SharedV4Warning[] = [];
  for (const name of IGNORED_SETTINGS) {
    if (options[name] !== undefined) warnings.push({ type: 'unsupported', feature: name });
  }
  if (options.reasoning !== undefined && options.reasoning !== 'provider-default') {
    warnings.push({ type: 'unsupported', feature: 'reasoning' });
  }
  const { system, messages, images } = toHelperPrompt(options.prompt);
  const format = options.responseFormat;
  let schema: Record<string, unknown> | undefined;
  if (format?.type === 'json') {
    if (format.schema !== undefined) schema = format.schema as Record<string, unknown>;
    else
      warnings.push({
        type: 'unsupported',
        feature: 'responseFormat',
        details: 'JSON output needs a schema; the answer is plain text',
      });
  }
  return {
    request: {
      system,
      messages,
      ...(schema !== undefined && { schema }),
      maxTokens: options.maxOutputTokens ?? APPLE_DEFAULT_MAX_TOKENS,
      temperature: options.temperature ?? 0,
    },
    images,
    warnings,
  };
}

function usageOf(answer: Answer): LanguageModelV4Usage {
  const { inputTokens, outputTokens } = answer.usage;
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
  };
}

/** The Apple on-device model. Requests share one helper process until `close()`. */
export function createAppleLanguageModel(opts: AppleModelOptions): AppleLanguageModel {
  const helper = new HelperProcess(opts);

  const doGenerate = async (
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4GenerateResult> => {
    const { request, images, warnings } = buildRequest(options);
    const answer = await withImageFiles(request.messages, images, (messages) =>
      helper.request({ ...request, messages }, options.abortSignal),
    );
    const text = 'json' in answer ? JSON.stringify(answer.json) : answer.text;
    return {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: usageOf(answer),
      providerMetadata: { apple: { estimatedUsage: answer.usage.estimated } },
      response: { modelId: APPLE_MODEL_ID, timestamp: new Date() },
      warnings,
    };
  };

  return {
    specificationVersion: 'v4',
    provider: 'apple',
    modelId: APPLE_MODEL_ID,
    supportedUrls: {},
    doGenerate,
    async doStream(options) {
      const r = await doGenerate(options);
      const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
      const parts: LanguageModelV4StreamPart[] = [
        { type: 'stream-start', warnings: r.warnings },
        { type: 'response-metadata', ...r.response },
        { type: 'text-start', id: '0' },
        { type: 'text-delta', id: '0', delta: text },
        { type: 'text-end', id: '0' },
        {
          type: 'finish',
          usage: r.usage,
          finishReason: r.finishReason,
          ...(r.providerMetadata && { providerMetadata: r.providerMetadata }),
        },
      ];
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        }),
      };
    },
    close: () => helper.close(),
    pid: () => helper.pid(),
  };
}

const ASSETS_HINT =
  'macOS downloads the language model for on-device embeddings on first use; connect to the internet and try again, or set another embed model.';

/** One `--embed` run: at most APPLE_EMBED_MAX_TEXTS texts. */
function embedOnce(
  opts: AppleModelOptions,
  request: AppleEmbedRequest,
  signal: AbortSignal | undefined,
): Promise<{ vectors: number[][]; dim: number; language: string }> {
  signal?.throwIfAborted();
  // validated before the helper starts: a bad request never leaves a process waiting on stdin
  const input = JSON.stringify(AppleEmbedRequest.parse(request));
  const timeoutMs = opts.timeoutMs ?? APPLE_DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(opts.command, [...(opts.args ?? []), '--embed'], {
      env: helperEnv(opts.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let settled = false;
    const finish = (
      err: unknown,
      value?: { vectors: number[][]; dim: number; language: string },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (err !== undefined) reject(err);
      else resolve(value!);
    };
    const timer = setTimeout(() => {
      finish(
        appleFailed('timeout', `the Apple helper did not embed within ${String(timeoutMs)} ms`, {
          timeoutMs,
        }),
      );
    }, timeoutMs);
    const onAbort = () => finish(signal?.reason ?? new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.resume();
    child.stdin.on('error', () => {
      // the helper exited before reading (an old helper without --embed); close reports it
    });
    child.once('error', (err) => {
      finish(unavailable('the Apple helper could not run', MISSING_HINT, { error: err.name }));
    });
    child.once('close', (code) => {
      const parsed = parseAppleEmbedLine(stdout);
      if (!parsed.ok) {
        // exit 2 with usage: a helper older than D-77
        finish(
          code === 2 && stdout.trim() === ''
            ? unavailable('this Apple helper cannot embed text', MISSING_HINT, {
                status: 'noEmbed',
              })
            : appleFailed('protocol', 'the Apple helper sent an unexpected embed answer', {
                exitCode: code,
              }),
        );
        return;
      }
      const a = parsed.value;
      if ('error' in a) finish(mapHelperError(a.error.code, a.error.message));
      else if (a.vectors.length !== request.texts.length)
        finish(
          appleFailed('protocol', 'the Apple helper returned the wrong number of vectors', {
            sent: request.texts.length,
            got: a.vectors.length,
          }),
        );
      else finish(undefined, a);
    });
    child.stdin.end(input);
  });
}

/**
 * Sentence vectors from the helper (D-77), one per text, in order. Texts longer than the helper
 * takes are cut; more than APPLE_EMBED_MAX_TEXTS go in several runs, all in the language the first
 * run used. Errors: APPLE_UNAVAILABLE (no helper, an old helper, no model or assets for the
 * language), APPLE_FAILED (timeout, a bad answer).
 */
export async function appleEmbed(
  opts: AppleModelOptions,
  texts: readonly string[],
  options: { language?: string; signal?: AbortSignal } = {},
): Promise<{ vectors: number[][]; dim: number; language: string }> {
  let language = options.language;
  const vectors: number[][] = [];
  let dim = 0;
  for (let i = 0; i < texts.length; i += APPLE_EMBED_MAX_TEXTS) {
    const chunk = texts
      .slice(i, i + APPLE_EMBED_MAX_TEXTS)
      .map((t) => t.slice(0, APPLE_EMBED_MAX_TEXT_LENGTH));
    const r = await embedOnce(
      opts,
      { texts: chunk, ...(language !== undefined && { language }) },
      options.signal,
    );
    language = r.language;
    dim = r.dim;
    vectors.push(...r.vectors);
  }
  return { vectors, dim, language: language ?? 'en' };
}

/**
 * The `embed` role on the Apple helper (D-77). It is `local`: the screenplay match uses it as a
 * free first pass and still asks the language model about scenes it is unsure of.
 */
export function createAppleEmbedder(opts: AppleModelOptions): Embedder {
  const embed: Embedder = async (texts, signal) =>
    texts.length === 0 ? [] : (await appleEmbed(opts, texts, signal ? { signal } : {})).vectors;
  embed.local = true;
  return embed;
}
