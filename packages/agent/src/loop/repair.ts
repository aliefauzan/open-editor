// Tool-call robustness (agent spec "Agent loop" → "Tool-call repair", plan D-15):
// - repairToolJson: fix malformed tool-call JSON (trailing commas, truncation, code fences, prose
//   around the object) before zod sees it.
// - detectTextToolCall: spot a tool call written as plain text in the reply.
// The loop (phase 11) owns the "one correction per step" counter; this file only detects.
import type { ZodType } from 'zod';

export type RepairResult =
  { ok: true; value: unknown; repaired: boolean } | { ok: false; error: string };

const MAX_DEPTH = 256;
const TOKEN_CHAR = /[-+.0-9A-Za-z]/;
const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const LITERALS = ['true', 'false', 'null'];

interface Frame {
  t: '{' | '[';
  st: 'key' | 'colon' | 'value' | 'after';
  /** Output offset where the object's current key (and the comma before it) begins. */
  keyStart: number;
}

/** Parse tool-call arguments; repair what a weak model commonly breaks. */
export function repairToolJson(raw: string): RepairResult {
  const text = raw.trim();
  if (text === '') return { ok: false, error: 'empty input' };
  try {
    return { ok: true, value: JSON.parse(text), repaired: false };
  } catch {
    // fall through to repair
  }
  let lastError = 'no JSON object or array found';
  for (const start of candidateStarts(text)) {
    const fixed = rebuild(text, start);
    if (typeof fixed !== 'string') {
      lastError = fixed.error;
      continue;
    }
    try {
      return { ok: true, value: JSON.parse(fixed), repaired: true };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: lastError };
}

/** Drop a cut-off backslash-u escape, but not a literal backslash that happens to precede "u12". */
function dropCutUnicodeEscape(out: string): string {
  const m = /u[0-9a-fA-F]{0,3}$/.exec(out);
  if (!m) return out;
  let slashes = 0;
  while (out[m.index - 1 - slashes] === '\\') slashes++;
  return slashes % 2 === 1 ? out.slice(0, m.index - 1) : out;
}

const MAX_STARTS = 5;

/** Where the object may begin: up to 5 `{` (tool arguments are objects), then the first `[`. */
function candidateStarts(text: string): number[] {
  const starts: number[] = [];
  for (
    let i = text.indexOf('{');
    i >= 0 && starts.length < MAX_STARTS;
    i = text.indexOf('{', i + 1)
  ) {
    starts.push(i);
  }
  const bracket = text.indexOf('[');
  if (bracket >= 0) starts.push(bracket);
  return starts;
}

/** One pass over the text; returns repaired JSON text, or an error for hopeless input. */
function rebuild(text: string, start: number): string | { error: string } {
  let out = '';
  const stack: Frame[] = [];
  let pendingComma = false;
  let tok = '';
  let inStr = false;
  let strIsKey = false;
  let esc = false;
  let done = false;

  const top = (): Frame | undefined => stack[stack.length - 1];
  const emitComma = (): void => {
    if (pendingComma) {
      out += ',';
      pendingComma = false;
    }
  };
  const valueDone = (): void => {
    const f = top();
    if (f) f.st = 'after';
  };
  const flushToken = (): void => {
    if (tok === '') return;
    emitComma();
    out += tok;
    tok = '';
    valueDone();
  };

  for (let i = start; i < text.length && !done; i++) {
    const c = text[i] as string;
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') {
        inStr = false;
        const f = top();
        if (f) f.st = strIsKey ? 'colon' : 'after';
      }
      continue;
    }
    if (TOKEN_CHAR.test(c)) {
      tok += c;
      continue;
    }
    flushToken();
    if (/\s/.test(c)) continue;
    const f = top();
    switch (c) {
      case '"': {
        strIsKey = f?.t === '{' && f.st === 'key';
        if (strIsKey && f) f.keyStart = out.length;
        emitComma();
        out += c;
        inStr = true;
        break;
      }
      case '{':
      case '[': {
        if (stack.length >= MAX_DEPTH) return { error: 'nesting too deep' };
        emitComma();
        out += c;
        stack.push({ t: c, st: c === '{' ? 'key' : 'value', keyStart: 0 });
        break;
      }
      case '}':
      case ']': {
        pendingComma = false;
        out += c;
        stack.pop();
        valueDone();
        if (stack.length === 0) done = true;
        break;
      }
      case ',': {
        if (f && f.st === 'after') {
          pendingComma = true;
          f.st = f.t === '{' ? 'key' : 'value';
        } else out += c; // invalid; JSON.parse reports it
        break;
      }
      case ':': {
        if (f && f.t === '{' && f.st === 'colon') f.st = 'value';
        out += c;
        break;
      }
      default:
        out += c;
    }
  }

  if (done) return out;

  // Truncated input: finish the open string or token, drop a key with no value, close containers.
  let dropKey = false;
  if (inStr) {
    if (esc) out = out.slice(0, -1);
    out = dropCutUnicodeEscape(out);
    if (strIsKey) dropKey = true;
    else {
      out += '"';
      valueDone();
    }
  } else if (tok !== '') {
    const literal = LITERALS.find((l) => l.startsWith(tok));
    if (literal) {
      tok = literal;
      flushToken();
    } else {
      let n = tok;
      while (n !== '' && !NUMBER.test(n) && /[-+.eE]$/.test(n)) n = n.slice(0, -1);
      if (NUMBER.test(n)) {
        tok = n;
        flushToken();
      } else if (/^[-+.eE\d]+$/.test(tok)) {
        dropKey = true; // a number cut off before its first digit
      } else {
        return { error: `unexpected token ${JSON.stringify(tok)}` };
      }
    }
  }
  const f = top();
  if (f && f.t === '{' && (dropKey || f.st === 'colon' || f.st === 'value')) {
    out = out.slice(0, f.keyStart); // key written, value missing
  }
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i]?.t === '{' ? '}' : ']';
  return out;
}

export type ParseToolInputResult =
  { ok: true; value: unknown; repaired: boolean } | { ok: false; error: string };

/** Repair, then validate with zod. `error` is written for the model to read. */
export function parseToolInput(raw: string, schema: ZodType): ParseToolInputResult {
  let parsed: { value: unknown; repaired: boolean };
  if (raw.trim() === '') parsed = { value: {}, repaired: false };
  else {
    const r = repairToolJson(raw);
    if (!r.ok) {
      return {
        ok: false,
        error: `Arguments are not valid JSON (${r.error}). Send one complete JSON object.`,
      };
    }
    parsed = r;
  }
  const v = schema.safeParse(parsed.value);
  if (v.success) return { ok: true, value: v.data, repaired: parsed.repaired };
  const issues = v.error.issues
    .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, error: `Invalid arguments: ${issues}` };
}

export const TEXT_TOOL_CALL_CORRECTION =
  'You wrote a tool call as text. Call the tool through the tool interface; do not describe the call.';

export interface TextToolCall {
  kind: 'marker' | 'json' | 'call';
  /** The known tool the text names, or null when only a marker was seen. */
  tool: string | null;
}

const MARKERS =
  /<\s*(?:tool_call|function_call|tool_use|tool_calls)\s*>|<\|(?:python_tag|tool_call)\|>|\[TOOL_CALLS?\]|<function=[^<>\s]+>/i;
/** Text longer than this is not scanned for text tool calls (keeps detection linear and cheap). */
const MAX_SCAN = 200_000;
const MAX_SPANS = 20;
const ARG_KEYS = ['arguments', 'args', 'parameters', 'input'];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function firstKnownName(text: string, names: readonly string[]): string | null {
  let best: { name: string; at: number } | null = null;
  for (const name of names) {
    const m = new RegExp(`(?<!\\w)${escapeRe(name)}(?!\\w)`).exec(text);
    if (m && (best === null || m.index < best.at)) best = { name, at: m.index };
  }
  return best?.name ?? null;
}

/** Top-level balanced `{…}` spans, string-aware, in one linear pass (at most MAX_SPANS). */
function topLevelObjects(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let from = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length && spans.length < MAX_SPANS; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (depth > 0 && c === '"') inStr = true;
    else if (c === '{') {
      if (depth++ === 0) from = i;
    } else if (c === '}' && depth > 0 && --depth === 0) spans.push(text.slice(from, i + 1));
  }
  return spans;
}

function namedTool(o: unknown, names: readonly string[]): string | null {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const fn = r['function'];
  if (typeof fn === 'object' && fn !== null) return namedTool(fn, names);
  const name = [r['name'], r['tool'], r['tool_name'], fn].find((v) => typeof v === 'string');
  if (typeof name !== 'string' || !names.includes(name)) return null;
  return ARG_KEYS.some((k) => k in r) ? name : null;
}

/**
 * Detect a tool call that the model wrote into its reply instead of making a real call. Matches
 * only names in `toolNames` (plus bare markers), so prose that mentions a tool does not trigger.
 */
export function detectTextToolCall(
  text: string,
  toolNames: readonly string[],
): TextToolCall | null {
  text = text.slice(0, MAX_SCAN);
  const marker = MARKERS.exec(text);
  if (marker) {
    return { kind: 'marker', tool: firstKnownName(text.slice(marker.index), toolNames) };
  }
  for (const slice of topLevelObjects(text)) {
    try {
      const tool = namedTool(JSON.parse(slice), toolNames);
      if (tool) return { kind: 'json', tool };
    } catch {
      // not JSON
    }
  }
  for (const name of toolNames) {
    if (new RegExp(`(?<![\\w.])${escapeRe(name)}\\(`).test(text)) {
      return { kind: 'call', tool: name };
    }
  }
  return null;
}
