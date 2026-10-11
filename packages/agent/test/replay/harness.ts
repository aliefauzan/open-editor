// Replay harness (plan D-15, phase 11 step 20): the model outputs recorded in a run record are fed
// back through MockLanguageModelV4 against a fresh fixture project; the tool results and history
// versions of the replay must match the record. Phase 12 records its workflow runs as fixtures.
import { readRunRecord, type RecordLine } from '../../src/loop/record.ts';
import { runAgent } from '../../src/loop/run.ts';
import type { RunDeps } from '../../src/loop/types.ts';
import { roleModel, runDeps, scriptedModel, type ScriptStep } from '../helpers/model.ts';
import type { Fixture } from '../helpers/project.ts';

export interface ToolTrace {
  tool: string;
  result?: unknown;
  error?: unknown;
  versions?: number[];
}

export interface ReplayResult {
  ok: boolean;
  mismatches: string[];
  recorded: ToolTrace[];
  replayed: ToolTrace[];
}

/** The model's side of a recorded run, step by step. */
export function scriptFromRecord(lines: readonly RecordLine[]): ScriptStep[] {
  return lines
    .filter((l) => l.type === 'step')
    .map((l) => {
      if (l['plan'] !== undefined) return { json: l['plan'] };
      const calls =
        (l['calls'] as { toolName: string; input: unknown; rawInput?: string }[] | undefined) ?? [];
      return {
        text: (l['text'] as string | undefined) ?? '',
        calls: calls.map((c) => ({
          name: c.toolName,
          input: c.rawInput ?? (c.input as Record<string, unknown>),
        })),
        ...(l['usage'] !== undefined && {
          usage: {
            input: (l['usage'] as { inputTokens: number }).inputTokens,
            output: (l['usage'] as { outputTokens: number }).outputTokens,
          },
        }),
      };
    });
}

export function toolTrace(lines: readonly RecordLine[]): ToolTrace[] {
  return lines
    .filter((l) => l.type === 'tool')
    .map((l) => ({
      tool: l['tool'] as string,
      ...(l['result'] !== undefined && { result: l['result'] }),
      ...(l['error'] !== undefined && { error: l['error'] }),
      ...(l['versions'] !== undefined && { versions: l['versions'] as number[] }),
    }));
}

/**
 * Engine ids the alias table does not cover (link ids, job ids) are random per run: each is
 * replaced by its order of first appearance, so equal structure compares equal.
 */
export function normaliseIds(trace: ToolTrace[]): ToolTrace[] {
  const seen = new Map<string, string>();
  const text = JSON.stringify(trace).replace(/\b(ln|job)_[A-Za-z0-9_-]+/g, (id, kind: string) => {
    let v = seen.get(id);
    if (!v) {
      v = `<${kind}#${String(seen.size + 1)}>`;
      seen.set(id, v);
    }
    return v;
  });
  return JSON.parse(text) as ToolTrace[];
}

/** Replays `lines` on `fixture` (a fresh copy of the project the run was recorded on). */
export async function replay(
  lines: readonly RecordLine[],
  fixture: Fixture,
  over: Partial<RunDeps> = {},
): Promise<ReplayResult> {
  const started = lines.find((l) => l.type === 'started');
  if (!started) throw new Error('the record has no started line');
  const firstStep = lines.find((l) => l.type === 'step');
  const scope = (firstStep?.['scope'] as string[] | undefined) ?? [fixture.sequenceId];
  const m = scriptedModel(scriptFromRecord(lines));
  const { deps } = runDeps(fixture, roleModel(m.model), {
    newRunId: () => started['runId'] as string,
    ...over,
  });
  const { run } = await runAgent(deps, {
    projectId: fixture.projectId,
    workflow: started['workflow'] as string,
    message: started['message'] as string,
    attachments: (started['attachments'] as string[] | undefined) ?? [],
    allowedTools: (started['allowedTools'] as string[] | undefined) ?? [],
    mode: started['mode'] as 'tools' | 'plan',
    ...(started['planKind'] !== undefined && { planKind: started['planKind'] as 'clip' | 'ops' }),
    scope,
  });
  const recorded = normaliseIds(toolTrace(lines));
  const replayed = normaliseIds(toolTrace(readRunRecord(run.record.path)));
  const mismatches: string[] = [];
  const n = Math.max(recorded.length, replayed.length);
  for (let i = 0; i < n; i++) {
    const a = JSON.stringify(recorded[i] ?? null);
    const b = JSON.stringify(replayed[i] ?? null);
    if (a !== b)
      mismatches.push(
        `tool call ${String(i)}: recorded ${a.slice(0, 300)} ≠ replayed ${b.slice(0, 300)}`,
      );
  }
  return { ok: mismatches.length === 0, mismatches, recorded, replayed };
}
