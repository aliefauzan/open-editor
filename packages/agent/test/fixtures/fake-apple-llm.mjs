#!/usr/bin/env node
// Fake `vox-apple-llm` for tests (R7): the same JSON-lines protocol as `native/apple-llm`, with
// scripted answers and `--status` values. Never touches the network; writes a file only when
// VOX_FAKE_APPLE_LOG is set.
//
// Environment:
//   VOX_FAKE_APPLE_STATUS   ready (default) | notEnabled | notEligible | modelNotReady | unsupportedOS
//   VOX_FAKE_APPLE_CONTEXT  context size for --status (default 4096)
//   VOX_FAKE_APPLE_VISION   1 | 0: --status reports vision true | false; unset: no `vision` field
//                           (a helper older than D-74). A request with images gets
//                           `visionUnavailable` unless this is 1, and `badRequest` when an image
//                           file is not readable.
//   VOX_FAKE_APPLE_ANSWERS  JSON array, one entry consumed per valid request, in order:
//     { "text": "..." }                 text answer
//     { "json": <any> }                 JSON answer (for schema requests)
//     { "error": { "code", "message" } } error answer
//     { "crash": { "exitCode"?, "stderr"? } }  exit without answering (default 134)
//     { "hang": true }                  never answer (timeout case)
//     optional on text/json/error: "delayMs" (answer later), "usage" (replaces the estimate)
//     A malformed list exits 2 at start. A text answer to a schema request (or JSON to a text
//     request) is sent as a `generation` error, so a mis-scripted test fails loudly.
//   VOX_FAKE_APPLE_LOG      append every received request line to this file
//
// Like the real helper, lines are split on "\n" only (not with node:readline, which also splits
// on U+2028/U+2029), and U+2028/U+2029 are escaped on output. A hang keeps the process alive
// after stdin closes, as a stuck real helper would; the caller must kill it.
import { accessSync, appendFileSync, constants } from 'node:fs';

// Exit only after stdout and stderr are flushed (pipes are asynchronous on macOS).
const exitAfterFlush = (code) =>
  new Promise(() => {
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
  });

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

const STATUSES = ['ready', 'notEnabled', 'notEligible', 'modelNotReady', 'unsupportedOS'];
const USAGE = 'usage: vox-apple-llm [--status]\n  reads JSON-lines requests on stdin\n';

const status = process.env.VOX_FAKE_APPLE_STATUS ?? 'ready';
if (!STATUSES.includes(status)) {
  process.stderr.write(`fake-apple-llm: unknown VOX_FAKE_APPLE_STATUS ${status}\n`);
  await exitAfterFlush(2);
}
const contextSize = Number(process.env.VOX_FAKE_APPLE_CONTEXT ?? '4096');
const visionEnv = process.env.VOX_FAKE_APPLE_VISION;
const vision = visionEnv === '1';
const ERROR_CODES = [
  'badRequest',
  'unavailable',
  'contextOverflow',
  'guardrail',
  'generation',
  'visionUnavailable',
];
const MAX_IMAGES = 16;

/** Returns why a scripted answer is malformed, or null. */
function badAnswer(a) {
  if (!isObject(a)) return 'an entry is not an object';
  const kinds = ['text', 'json', 'error', 'crash', 'hang'].filter((k) => k in a);
  if (kinds.length !== 1) return `an entry needs exactly one of text|json|error|crash|hang`;
  if ('text' in a && typeof a.text !== 'string') return 'text must be a string';
  if ('error' in a && !(isObject(a.error) && ERROR_CODES.includes(a.error.code)))
    return 'error needs a known code';
  if ('error' in a && typeof a.error.message !== 'string') return 'error needs a message';
  if ('crash' in a && !isObject(a.crash)) return 'crash must be an object';
  if ('delayMs' in a && !(Number.isFinite(a.delayMs) && a.delayMs >= 0))
    return 'delayMs must be a number >= 0';
  return null;
}

let answers;
try {
  answers = JSON.parse(process.env.VOX_FAKE_APPLE_ANSWERS ?? '[]');
  if (!Array.isArray(answers)) throw new Error('not a JSON array');
  const problem = answers.map(badAnswer).find((p) => p !== null);
  if (problem) throw new Error(problem);
} catch (err) {
  process.stderr.write(`fake-apple-llm: bad VOX_FAKE_APPLE_ANSWERS: ${err.message}\n`);
  await exitAfterFlush(2);
}
const logPath = process.env.VOX_FAKE_APPLE_LOG;

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--status') {
  const line = visionEnv === undefined ? { status, contextSize } : { status, contextSize, vision };
  process.stdout.write(JSON.stringify(line) + '\n');
  await exitAfterFlush(0);
}
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  process.stdout.write(USAGE);
  await exitAfterFlush(0);
}
if (args.length > 0) {
  process.stderr.write(`unknown argument: ${args[0]}\n${USAGE}`);
  await exitAfterFlush(2);
}

/** About 4 characters per token, at least 1 for non-empty text (same rule as the helper). */
const estimate = (text) => (text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4)));

/** Returns an error message, or null when the request is valid (mirrors the helper's checks). */
function invalid(req) {
  if (!isObject(req)) return 'request must be a JSON object';
  const known = ['id', 'system', 'messages', 'schema', 'maxTokens', 'temperature'];
  const extra = Object.keys(req).find((k) => !known.includes(k));
  if (extra) return `unknown field: ${extra}`;
  if (req.id !== undefined && (typeof req.id !== 'string' || req.id === ''))
    return 'id must be a non-empty string';
  if (typeof req.system !== 'string') return 'system must be a string';
  if (!Array.isArray(req.messages) || req.messages.length === 0)
    return 'messages must be a non-empty array';
  let images = 0;
  for (const m of req.messages) {
    if (
      !isObject(m) ||
      Object.keys(m).some((k) => k !== 'role' && k !== 'content' && k !== 'images') ||
      !['user', 'assistant'].includes(m.role) ||
      typeof m.content !== 'string'
    )
      return 'each message needs role user|assistant and string content';
    if (m.images === undefined) continue;
    if (m.role !== 'user') return 'only user messages may have images';
    if (!Array.isArray(m.images) || m.images.length === 0 || m.images.length > MAX_IMAGES)
      return `images must be an array of 1 to ${MAX_IMAGES} paths`;
    if (m.images.some((p) => typeof p !== 'string' || !p.startsWith('/')))
      return 'each image must be an absolute file path';
    images += m.images.length;
  }
  if (images > MAX_IMAGES) return `a request may carry at most ${MAX_IMAGES} images`;
  if (req.messages.at(-1).role !== 'user') return 'the last message must be from the user';
  if (req.schema !== undefined && !isObject(req.schema)) return 'schema must be a JSON object';
  if (!Number.isSafeInteger(req.maxTokens) || req.maxTokens <= 0)
    return 'maxTokens must be a positive safe integer';
  if (typeof req.temperature !== 'number' || req.temperature < 0 || req.temperature > 2)
    return 'temperature must be a number from 0 to 2';
  return null;
}

const write = (obj) =>
  process.stdout.write(
    JSON.stringify(obj).replace(/[\u2028\u2029]/g, (c) =>
      c === '\u2028' ? '\\u2028' : '\\u2029',
    ) + '\n',
  );
const withId = (id, body) => (id === undefined ? body : { id, ...body });

// Answers go out strictly in request order, even when one is delayed.
let queue = Promise.resolve();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handle(line) {
  if (logPath) appendFileSync(logPath, line + '\n');
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    write({ error: { code: 'badRequest', message: 'request line is not valid JSON' } });
    return;
  }
  const id = isObject(req) && typeof req.id === 'string' && req.id !== '' ? req.id : undefined;
  const problem = invalid(req);
  if (problem) {
    write(withId(id, { error: { code: 'badRequest', message: problem } }));
    return;
  }
  if (status !== 'ready') {
    write(
      withId(id, { error: { code: 'unavailable', message: `Apple on-device model: ${status}` } }),
    );
    return;
  }
  const imagePaths = req.messages.flatMap((m) => m.images ?? []);
  if (imagePaths.length > 0 && !vision) {
    write(
      withId(id, {
        error: { code: 'visionUnavailable', message: 'fake: no vision on this model' },
      }),
    );
    return;
  }
  const unreadable = imagePaths.find((p) => {
    try {
      accessSync(p, constants.R_OK);
      return false;
    } catch {
      return true;
    }
  });
  if (unreadable !== undefined) {
    write(
      withId(id, {
        error: { code: 'badRequest', message: `image file not readable: ${unreadable}` },
      }),
    );
    return;
  }
  const next = answers.shift();
  if (next === undefined) {
    write(withId(id, { error: { code: 'generation', message: 'fake: no scripted answer left' } }));
    return;
  }
  if (next.crash) {
    process.stderr.write((next.crash.stderr ?? 'fake-apple-llm: crashed') + '\n');
    await exitAfterFlush(next.crash.exitCode ?? 134);
  }
  // Never answers and blocks every later answer; the timer keeps the process alive.
  if (next.hang) await new Promise(() => setInterval(() => {}, 60_000));
  const wantsJson = req.schema !== undefined;
  if (!next.error && wantsJson !== 'json' in next) {
    const kind = wantsJson ? 'text' : 'JSON';
    write(withId(id, { error: { code: 'generation', message: `fake: scripted ${kind} answer` } }));
    return;
  }
  const input = req.system + req.messages.map((m) => m.content).join('');
  let body;
  if (next.error) body = { error: next.error };
  else if ('json' in next)
    body = {
      json: next.json,
      usage: next.usage ?? {
        inputTokens: estimate(input),
        outputTokens: estimate(JSON.stringify(next.json)),
        estimated: true,
      },
    };
  else
    body = {
      text: next.text,
      usage: next.usage ?? {
        inputTokens: estimate(input),
        outputTokens: estimate(next.text),
        estimated: true,
      },
    };
  if (next.delayMs > 0) await sleep(next.delayMs);
  write(withId(id, body));
}

// A bug in handle() answers that request with a generation error instead of stopping the queue.
const enqueue = (line) => {
  queue = queue
    .then(() => handle(line))
    .catch((err) => write({ error: { code: 'generation', message: `fake: ${err.message}` } }));
};

let rest = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  const parts = (rest + chunk).split('\n');
  rest = parts.pop();
  for (const part of parts) enqueue(part.endsWith('\r') ? part.slice(0, -1) : part);
});
process.stdin.on('end', () => {
  if (rest !== '') enqueue(rest);
  queue.then(() => exitAfterFlush(0));
});
