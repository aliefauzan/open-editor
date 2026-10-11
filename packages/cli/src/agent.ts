// `vox agent <project> ["<instruction>"]` and `vox agent undo <project> <runId>` (agent spec "CLI";
// plan phase 12). The role models come from the config (`vox config roles set`); every pause is
// answered on the terminal. `--yes` applies the clipper's tighten list without asking and never
// approves a source; `--yes-sources` approves only sources named in the instruction; without a
// terminal any other pause stops the run (nothing is approved silently).
import {
  buildRunModels,
  CLIPPER_DEFAULTS,
  engineConfigIO,
  loadAgentConfig,
  runWorkflow,
  sourceIn,
  sourceNamedByUser,
  WORKFLOW_NAMES,
  type AgentConfigDeps,
  type AgentEvent,
  type PauseDecision,
  type PauseInfo,
  type WorkflowName,
  type WorkflowRequest,
} from '@vox/agent';

import { createRedactor, type Engine, type Redactor } from '@vox/engine';
import { depsOf, type ConfigIo } from './config.ts';

export interface AgentIo extends ConfigIo {
  prompt?: (question: string) => Promise<string>;
}

export class AgentUsageError extends Error {}

// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

/** "make 3 clips …" → 3 (1–20); else the default. */
export function countIn(instruction: string): number | undefined {
  const m = /\b(\d{1,2})\s+(?:[a-z-]+\s+){0,2}(?:clips?|shorts?|reels?)\b/i.exec(instruction);
  const n = m ? Number(m[1]) : undefined;
  return n !== undefined && n >= 1 && n <= 20 ? n : undefined;
}

function pauseText(p: PauseInfo): string {
  const lines = [`paused (${p.reason}${p.kind ? `, ${p.kind}` : ''}): ${p.detail}`];
  for (const s of p.sources ?? []) lines.push(`  source: ${s}`);
  (p.ranges ?? []).forEach((r, i) =>
    lines.push(
      `  ${String(i + 1)}. ${String(r.seqStartMs)}–${String(r.seqEndMs)} ms ${r.kind} ${r.text}`,
    ),
  );
  if (p.plan !== undefined) lines.push(`  plan: ${JSON.stringify(p.plan).slice(0, 2000)}`);
  return `${lines.join('\n')}\n`;
}

const yes = (a: string) => /^y(es)?$/i.test(a.trim());

/** Answers to the tighten prompt before an answer without a valid number cuts nothing. */
const PICK_TRIES = 3;

/** Answers pauses on the terminal (agent spec "CLI"). */
export function terminalPauses(
  io: AgentIo,
  o: { json: boolean; yesSources: boolean; instruction: string; redactor: Redactor },
): (p: PauseInfo) => Promise<PauseDecision> {
  const canAsk = !o.json && io.isTTY === true && io.prompt !== undefined;
  const ask = async (q: string) => io.prompt!(clean(o.redactor.redact(q)));
  return async (p) => {
    if (
      p.kind === 'source' &&
      o.yesSources &&
      (p.sources ?? []).length > 0 &&
      (p.sources ?? []).every((s) => sourceNamedByUser(s, [o.instruction]))
    ) {
      return { action: 'continue' };
    }
    io.stderr(clean(o.redactor.redact(pauseText(p))));
    if (!canAsk) {
      io.stderr(
        p.kind === 'pauses'
          ? 'no terminal to ask: stopped (use --yes to cut the whole list)\n'
          : 'no terminal to ask: stopped (nothing was approved)\n',
      );
      return { action: 'stop' };
    }
    switch (p.kind) {
      case 'source':
        return yes(await ask('Allow these sources? [y/N] '))
          ? { action: 'continue' }
          : { action: 'stop' };
      case 'plan':
        return yes(await ask('Run this plan? [y/N] '))
          ? { action: 'continue' }
          : { action: 'stop' };
      case 'pauses': {
        const ranges = p.ranges ?? [];
        // an answer with no valid number asks again; after the last try nothing is cut
        for (let tries = 1; ; tries++) {
          const a = (await ask('Cut which? all, none, or numbers like 1,3 [all] '))
            .trim()
            .toLowerCase();
          if (a === '' || a === 'all') return { action: 'continue' };
          if (a === 'none') return { action: 'continue', wordKeys: [] };
          const tokens = a.split(/[\s,]+/).filter((t) => t !== '');
          const valid = (t: string) =>
            /^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= ranges.length;
          const ignored = tokens.filter((t) => !valid(t));
          if (ignored.length > 0)
            io.stderr(
              clean(`ignored: ${ignored.join(', ')} (pick from 1 to ${String(ranges.length)})\n`),
            );
          const picks = tokens.filter(valid).map(Number);
          if (picks.length > 0)
            return {
              action: 'continue',
              wordKeys: [...new Set(picks)].map((n) => ranges[n - 1]!.wordKey),
            };
          if (tries >= PICK_TRIES) {
            io.stderr('no valid pick: nothing is cut\n');
            return { action: 'continue', wordKeys: [] };
          }
        }
      }
      default: {
        if (p.reason === 'budget') {
          const a = (await ask('Raise the cap for this run to (USD, empty = stop): ')).trim();
          const usd = Number(a);
          return a !== '' && Number.isFinite(usd) && usd > 0
            ? { action: 'continue', maxUsdPerRun: usd }
            : { action: 'stop' };
        }
        return yes(await ask('Continue? [y/N] ')) ? { action: 'continue' } : { action: 'stop' };
      }
    }
  };
}

function progress(io: AgentIo, json: boolean, redactor: Redactor) {
  return (e: AgentEvent) => {
    // the runId first, on stderr in every mode: a stopped or killed run can still be undone
    if (e.type === 'agent.started')
      io.stderr(
        clean(
          redactor.redact(
            `run ${e.payload.runId} started (Ctrl-C stops it; undo: vox agent undo ${e.payload.projectId} ${e.payload.runId})\n`,
          ),
        ),
      );
    if (json || io.isTTY !== true) return;
    if (e.type === 'agent.tool' && e.payload.status !== 'started')
      io.stderr(clean(redactor.redact(`  ${e.payload.tool}: ${e.payload.status}\n`)));
    if (e.type === 'agent.step' && e.payload.summary)
      io.stderr(clean(redactor.redact(`step ${String(e.payload.step)}: ${e.payload.summary}\n`)));
  };
}

/** `vox agent <project> …` on an open engine; returns the exit code. */
export async function agentCommand(
  engine: Engine,
  projectId: string,
  instruction: string,
  values: Record<string, unknown>,
  io: AgentIo,
): Promise<number> {
  const json = values['json'] === true;
  const workflowFlag = values['workflow'];
  if (workflowFlag !== undefined && !(WORKFLOW_NAMES as readonly unknown[]).includes(workflowFlag))
    throw new AgentUsageError(`--workflow must be one of ${WORKFLOW_NAMES.join(', ')}`);
  if (!instruction && workflowFlag === undefined)
    throw new AgentUsageError('agent needs an instruction unless --workflow is given');
  const seqs = (values['seq'] as string[] | undefined) ?? [];
  const workflow: WorkflowName =
    (workflowFlag as WorkflowName | undefined) ??
    (seqs.length > 0 && !sourceIn(instruction)
      ? 'edit'
      : sourceIn(instruction)
        ? 'clipper'
        : 'edit');
  const modeFlag = values['mode'];
  if (modeFlag !== undefined && modeFlag !== 'tools' && modeFlag !== 'plan')
    throw new AgentUsageError('--mode must be tools or plan');
  const layout = values['layout'];
  if (layout !== undefined && layout !== 'full-collage' && layout !== 'hybrid')
    throw new AgentUsageError('--layout must be full-collage or hybrid');
  let maxUsd: number | undefined;
  if (values['max-usd'] !== undefined) {
    maxUsd = Number(values['max-usd']);
    if (!/^\d+(\.\d+)?$/.test(String(values['max-usd'])) || !(maxUsd > 0))
      throw new AgentUsageError('--max-usd must be a positive amount, e.g. 2 or 0.5');
  }
  let count: number | undefined;
  if (values['count'] !== undefined) {
    count = Number(values['count']);
    if (!/^\d+$/.test(String(values['count'])) || count < 1 || count > 20)
      throw new AgentUsageError('--count must be a whole number from 1 to 20');
  }
  let length: [number, number] | undefined;
  if (values['length'] !== undefined) {
    const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(String(values['length']));
    const a = m ? Math.round(Number(m[1]) * 1000) : 0;
    const b = m ? Math.round(Number(m[2]) * 1000) : 0;
    if (!m || a < 1000 || b <= a)
      throw new AgentUsageError('--length takes <from>-<to> in seconds, e.g. 30-60');
    length = [a, b];
  }
  if (workflow === 'stylize' && seqs.length === 0)
    throw new AgentUsageError('--workflow stylize needs --seq <id> (repeatable)');

  const redactor = createRedactor();
  const deps = depsOf(io);
  const cfg: AgentConfigDeps = {
    io: engineConfigIO(io.env),
    keychain: deps.keychain,
    env: io.env,
    redactor,
  };
  const conf = await loadAgentConfig(cfg);
  const built = await buildRunModels(conf, cfg, {
    createModel: deps.createModel,
    ...(deps.fetch !== undefined && { fetch: deps.fetch }),
    ...(deps.apple !== undefined && { apple: deps.apple }),
    ...(deps.probe.context !== undefined && { context: deps.probe.context }),
  });
  const models = built.models;
  let mode = built.mode;
  if (modeFlag !== undefined) mode = modeFlag;
  const e = deps.wrapEngine ? deps.wrapEngine(engine) : engine;
  // Ctrl-C stops the run (the edits so far stay; the run can be undone)
  const stop = new AbortController();
  const onInterrupt =
    deps.onInterrupt ??
    ((handler: () => void) => {
      process.once('SIGINT', handler);
      return () => void process.off('SIGINT', handler);
    });
  const removeInterrupt = onInterrupt(() => {
    io.stderr('stopping the run…\n');
    stop.abort();
  });
  const r = await runWorkflow(
    {
      engine: e,
      redactor,
      models,
      limits: { ...conf.limits, ...(maxUsd !== undefined && { maxUsdPerRun: maxUsd }) },
      emit: progress(io, json, redactor),
      onPause: terminalPauses(io, {
        json,
        yesSources: values['yes-sources'] === true,
        instruction,
        redactor,
      }),
      ...(deps.runJob && { runJob: deps.runJob }),
    },
    {
      projectId,
      workflow,
      message: instruction,
      mode: mode ?? 'tools',
      ...(workflow === 'clipper' && {
        count: count ?? countIn(instruction) ?? CLIPPER_DEFAULTS.count,
        ...(length && { minMs: length[0], maxMs: length[1] }),
      }),
      tighten: values['yes'] === true ? 'all' : 'ask',
      ...(seqs.length > 0 && workflow === 'stylize' && { sequenceIds: seqs }),
      ...(seqs.length > 0 && workflow === 'edit' && { selection: { sequenceId: seqs[0]! } }),
      ...(typeof values['style'] === 'string' && { styleId: values['style'] }),
      ...(layout !== undefined && { layout: layout as WorkflowRequest['layout'] & string }),
      ...(values['confirm-plan'] === true && { confirmPlan: true }),
      signal: stop.signal,
    },
  ).finally(removeInterrupt);
  const out = {
    runId: r.done.runId,
    status: r.done.status,
    workflow,
    mode: r.run.mode,
    summary: r.done.summary,
    costUsd: r.done.costUsd,
    versions: r.done.versions,
    sequenceIds: r.sequenceIds,
    checkpoints: r.checkpoints,
    clips: r.clips,
    ...(r.done.error && { error: r.done.error }),
  };
  io.stdout(
    redactor.redact(
      json
        ? `${JSON.stringify(out, null, 2)}\n`
        : clean(
            `${r.done.summary}\nrun ${r.done.runId}: ${r.done.status}, cost $${r.done.costUsd.toFixed(4)} (undo: vox agent undo ${projectId} ${r.done.runId})\n`,
          ),
    ),
  );
  return r.done.status === 'completed' ? 0 : 1;
}
