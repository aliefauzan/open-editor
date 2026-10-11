// Run record (agent spec "Agent loop" → "Run record", "Restart"; plan D-15): one JSON line per
// event in `<projectsDir>/<projectId>/runs/<runId>.jsonl`. Every line passes through the engine's
// redactor (S19); tool results are cut to 2 kB. The record also holds the model outputs of each
// step, so the replay harness can feed them back.
import { projectDirFor, type Redactor } from '@vox/engine';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VoxError } from '../errors.ts';

export const RESULT_MAX_BYTES = 2_048;
export const RUN_ID = /^run_[A-Za-z0-9_-]{4,64}$/;

/** Cuts a JSON-able value to `max` bytes of JSON (a string with a marker when cut). */
export function truncateJson(value: unknown, max = RESULT_MAX_BYTES): unknown {
  const s = JSON.stringify(value) ?? 'null';
  if (Buffer.byteLength(s) <= max) return value;
  let cut = s.slice(0, max);
  while (Buffer.byteLength(cut) > max) cut = cut.slice(0, -1);
  return `${cut}… [truncated, ${String(Buffer.byteLength(s))} bytes]`;
}

export type RecordLine = { type: string; ts?: string } & Record<string, unknown>;

export function runsDir(projectsDir: string, projectId: string): string {
  return join(projectDirFor(projectsDir, projectId), 'runs');
}

export function runRecordPath(projectsDir: string, projectId: string, runId: string): string {
  if (!RUN_ID.test(runId))
    throw new VoxError(
      'VALIDATION',
      `invalid run id ${runId}`,
      'Use the runId from agent.started.',
    );
  return join(runsDir(projectsDir, projectId), `${runId}.jsonl`);
}

/** Append-only writer. Synchronous appends keep line order equal to event order. */
export class RunRecord {
  readonly path: string;
  readonly #redactor: Pick<Redactor, 'redact'>;
  readonly #now: () => Date;

  constructor(opts: {
    projectsDir: string;
    projectId: string;
    runId: string;
    redactor: Pick<Redactor, 'redact'>;
    now?: () => Date;
  }) {
    this.path = runRecordPath(opts.projectsDir, opts.projectId, opts.runId);
    mkdirSync(join(this.path, '..'), { recursive: true });
    this.#redactor = opts.redactor;
    this.#now = opts.now ?? (() => new Date());
  }

  write(line: RecordLine): void {
    const full = { ts: this.#now().toISOString(), ...line };
    const text = this.#redactor.redact(JSON.stringify(full));
    appendFileSync(this.path, `${text}\n`, { mode: 0o600 });
  }
}

export function readRunRecord(path: string): RecordLine[] {
  if (!existsSync(path)) return [];
  const out: RecordLine[] = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (raw.trim() === '') continue;
    try {
      out.push(JSON.parse(raw) as RecordLine);
    } catch {
      // a torn last line (crash mid-write) is skipped
    }
  }
  return out;
}

/**
 * Restart rule: a run whose record has no `done` line (paused, or cut off when the app quit)
 * ends as `stopped`; its edits stay and `undoRun` still works. Returns the runIds closed.
 */
export function closeUnfinishedRuns(opts: {
  projectsDir: string;
  projectId: string;
  redactor: Pick<Redactor, 'redact'>;
  emit?: (event: { type: 'agent.done'; payload: Record<string, unknown> }) => void;
  now?: () => Date;
}): string[] {
  const dir = runsDir(opts.projectsDir, opts.projectId);
  if (!existsSync(dir)) return [];
  const closed: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const runId = f.slice(0, -'.jsonl'.length);
    if (!RUN_ID.test(runId)) continue;
    const lines = readRunRecord(join(dir, f));
    if (lines.length === 0 || lines.some((l) => l.type === 'done')) continue;
    const versions = lines.flatMap((l) =>
      Array.isArray(l['versions']) ? (l['versions'] as number[]) : [],
    );
    const costUsd = lines.reduce(
      (m, l) => (typeof l['spentUsd'] === 'number' ? Math.max(m, l['spentUsd']) : m),
      0,
    );
    const payload = {
      runId,
      status: 'stopped',
      summary:
        'Stopped: the run was not finished when Vox Studio quit. Its edits stay; "Undo this run" still works.',
      costUsd,
      versions: [...new Set(versions)].sort((a, b) => a - b),
    };
    new RunRecord({ ...opts, runId }).write({ type: 'done', ...payload });
    opts.emit?.({ type: 'agent.done', payload });
    closed.push(runId);
  }
  return closed;
}
