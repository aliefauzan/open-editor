#!/usr/bin/env node
// Fake `vox-apple-llm` for tests (R7): the same JSON-lines protocol as `native/apple-llm`, with
// scripted answers and `--status` values. Never touches the network; writes a file only when
// VOX_FAKE_APPLE_LOG is set.
//
// Environment:
//   VOX_FAKE_APPLE_STATUS   ready (default) | notEnabled | notEligible | modelNotReady | unsupportedOS
//   VOX_FAKE_APPLE_CONTEXT  context size for --status (default 4096)
//   VOX_FAKE_APPLE_ANSWERS  JSON array, one entry consumed per valid request, in order:
//     { "text": "..." }                 text answer
//     { "json": <any> }                 JSON answer (for schema requests)
//     { "error": { "code", "message" } } error answer
//     { "crash": { "exitCode"?, "stderr"? } }  exit without answering (default 134)
//     { "hang": true }                  never answer (timeout case)
//     optional on text/json/error: "delayMs" (answer later), "usage" (replaces the estimate)
//   VOX_FAKE_APPLE_LOG      append every received request line to this file
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// Exit only after stdout and stderr are flushed (pipes are asynchronous on macOS).
const exitAfterFlush = (code) =>
  new Promise(() => {
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
  });

const STATUSES = ['ready', 'notEnabled', 'notEligible', 'modelNotReady', 'unsupportedOS'];
const USAGE = 'usage: vox-apple-llm [--status]\n  reads JSON-lines requests on stdin\n';

const status = process.env.VOX_FAKE_APPLE_STATUS ?? 'ready';
if (!STATUSES.includes(status)) {
  process.stderr.write(`fake-apple-llm: unknown VOX_FAKE_APPLE_STATUS ${status}\n`);
  await exitAfterFlush(2);
}
const contextSize = Number(process.env.VOX_FAKE_APPLE_CONTEXT ?? '4096');
const answers = JSON.parse(process.env.VOX_FAKE_APPLE_ANSWERS ?? '[]');
const logPath = process.env.VOX_FAKE_APPLE_LOG;

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--status') {
  process.stdout.write(JSON.stringify({ status, contextSize }) + '\n');
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

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

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
  for (const m of req.messages) {
    if (
      !isObject(m) ||
      Object.keys(m).some((k) => k !== 'role' && k !== 'content') ||
      !['user', 'assistant'].includes(m.role) ||
      typeof m.content !== 'string'
    )
      return 'each message needs role user|assistant and string content';
  }
  if (req.messages.at(-1).role !== 'user') return 'the last message must be from the user';
  if (req.schema !== undefined && !isObject(req.schema)) return 'schema must be a JSON object';
  if (!Number.isInteger(req.maxTokens) || req.maxTokens <= 0)
    return 'maxTokens must be a positive integer';
  if (typeof req.temperature !== 'number' || req.temperature < 0 || req.temperature > 2)
    return 'temperature must be a number from 0 to 2';
  return null;
}

const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
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
  const next = answers.shift();
  if (next === undefined) {
    write(withId(id, { error: { code: 'generation', message: 'fake: no scripted answer left' } }));
    return;
  }
  if (next.crash) {
    process.stderr.write((next.crash.stderr ?? 'fake-apple-llm: crashed') + '\n');
    await exitAfterFlush(next.crash.exitCode ?? 134);
  }
  if (next.hang) await new Promise(() => {}); // never answers; blocks every later answer too
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

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  queue = queue.then(() => handle(line));
});
rl.on('close', () => {
  queue.then(() => exitAfterFlush(0));
});
