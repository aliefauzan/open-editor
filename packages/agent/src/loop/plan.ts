// Plan mode (agent spec "Plan mode"; plan phase 11 step 9). The model answers with one structured
// plan (a `ClipPlan` or a list of engine ops), zod-validated; invalid plans go back with the zod
// error (max 2 retries). Code then executes it as one `batch`: slot filling (search → fetch →
// cutout; generate only when search finds nothing and a provider exists; else a placeholder scene)
// and small repairs (clamp durations to template bounds and the sequence, drop beats that cannot
// fit). With `confirmPlan` each validated plan pauses for approval (kind `plan`) before it runs.
import {
  OP_ARGS,
  OP_NAMES,
  type Project,
  type TemplateInfo,
  type TemplateLookup,
} from '@vox/engine';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { VoxError, isVoxError, toVoxErrorJson } from '../errors.ts';
import { applyAsAgent } from '../tools/ops.ts';
import { invokeTool } from '../tools/registry.ts';
import { transcriptPage } from '../tools/transcript.ts';
import type { AgentRun } from './run.ts';
import { RunStopped } from './run.ts';
import { wrapData } from './envelope.ts';
import type { TurnOptions, TurnResult } from './types.ts';

export const MAX_PLAN_RETRIES = 2;
export const PLACEHOLDER_TEMPLATE = 'base/placeholder';

const ms = z.int().min(0);

export const ClipPlanSchema = z.strictObject({
  sequences: z
    .array(
      z.strictObject({
        sequenceId: z.string().min(1),
        beats: z
          .array(
            z
              .strictObject({
                startMs: ms,
                endMs: ms,
                kind: z.enum(['speaker', 'scene']),
                template: z.string().min(1).optional(),
                variables: z.record(z.string(), z.unknown()).optional(),
                imageQueries: z.array(z.string().trim().min(1).max(200)).max(4).optional(),
              })
              .refine((b) => b.endMs > b.startMs, { message: 'endMs must be after startMs' })
              .refine((b) => b.kind === 'speaker' || b.template !== undefined, {
                message: 'a scene beat needs a template',
              }),
          )
          .min(1)
          .max(80),
      }),
    )
    .min(1)
    .max(20),
});
export type ClipPlan = z.infer<typeof ClipPlanSchema>;

const PLAN_OPS = OP_NAMES.filter((o) => o !== 'batch') as [string, ...string[]];
export const OpsPlanSchema = z.strictObject({
  ops: z
    .array(z.strictObject({ op: z.enum(PLAN_OPS), args: z.record(z.string(), z.unknown()) }))
    .min(1)
    .max(100),
});
export type OpsPlan = z.infer<typeof OpsPlanSchema>;

export interface PlanOp {
  op: string;
  args: Record<string, unknown>;
}

export interface Repair {
  beat: number;
  sequenceId: string;
  what: string;
}

const issuesOf = (e: z.ZodError) =>
  e.issues
    .slice(0, 12)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');

/** Validates a plan answer (aliases resolved to engine ids). Throws PLAN_INVALID with the issues. */
export function validatePlan(
  run: Pick<AgentRun, 'aliases'>,
  kind: 'clip' | 'ops',
  value: unknown,
): ClipPlan | OpsPlan {
  let resolved: unknown;
  try {
    resolved = run.aliases.fromModel(value);
  } catch (err) {
    if (isVoxError(err)) throw new VoxError('PLAN_INVALID', err.message, err.hint);
    throw err;
  }
  const schema = kind === 'clip' ? ClipPlanSchema : OpsPlanSchema;
  const r = schema.safeParse(resolved);
  if (!r.success)
    throw new VoxError(
      'PLAN_INVALID',
      `the plan is invalid: ${issuesOf(r.error)}`,
      'Send a corrected plan.',
    );
  if (kind === 'ops') {
    const plan = r.data as OpsPlan;
    for (const [i, o] of plan.ops.entries()) {
      const schemaOf = OP_ARGS[o.op as keyof typeof OP_ARGS] as z.ZodType;
      const a = schemaOf.safeParse(o.args);
      if (!a.success) {
        throw new VoxError(
          'PLAN_INVALID',
          `ops.${String(i)} (${o.op}): ${issuesOf(a.error)}`,
          'Send a corrected plan.',
        );
      }
    }
  }
  return r.data;
}

function sequenceEnd(p: Project, sequenceId: string): number {
  const s = p.sequences.find((x) => x.id === sequenceId);
  if (!s)
    throw new VoxError(
      'PLAN_INVALID',
      `no sequence ${sequenceId}`,
      'Use a sequence id from the view.',
    );
  let end = 0;
  for (const t of [...s.videoTracks, ...s.audioTracks]) {
    for (const it of t.items) end = Math.max(end, it.startMs + it.durationMs);
  }
  return end;
}

/** Media slots the executor fills: top-level image/cutout slots (nested paths stay with the model). */
const fillableSlots = (t: TemplateInfo) =>
  Object.entries(t.slots).filter(
    ([path, kind]) => /^[A-Za-z0-9_]+$/.test(path) && (kind === 'image' || kind === 'cutout'),
  );

/** Engine media id from an aliased tool result. */
function mediaIdOf(run: AgentRun, result: unknown): string | undefined {
  const r = (result as { result?: { mediaId?: unknown } } | undefined)?.result;
  return typeof r?.mediaId === 'string' ? run.aliases.resolve(r.mediaId) : undefined;
}

/** search → fetch → (cutout); generate when search finds nothing and a provider exists. */
async function fillSlot(run: AgentRun, query: string, kind: string): Promise<string | undefined> {
  const call = async (name: string, args: Record<string, unknown>) => {
    const out = await invokeTool(run.ctx, run.registry, name, args);
    if (out.versions) run.versions.push(...out.versions);
    run.record.write({
      type: 'tool',
      tool: name,
      args,
      result: out.result,
      ...(out.versions && { versions: out.versions }),
      by: 'plan',
    });
    return out.result;
  };
  try {
    let mediaId: string | undefined;
    const found = (await call('search_images', { query })) as { candidates?: { id?: unknown }[] };
    const first = found.candidates?.find((c) => typeof c.id === 'string');
    if (first) mediaId = mediaIdOf(run, await call('fetch_image', { candidateId: first.id }));
    else if (run.registry.get('generate_image'))
      mediaId = mediaIdOf(run, await call('generate_image', { prompt: query }));
    if (mediaId && kind === 'cutout')
      mediaId = mediaIdOf(run, await call('cutout', { mediaId: run.aliases.aliasOf(mediaId) }));
    return mediaId;
  } catch (err) {
    if (err instanceof RunStopped) throw err;
    run.record.write({
      type: 'slotFailed',
      query,
      error: isVoxError(err) ? toVoxErrorJson(err) : 'error',
    });
    return undefined;
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** ClipPlan → ops for one batch, with slot filling and repairs. */
export async function clipPlanToOps(
  run: AgentRun,
  plan: ClipPlan,
  templates: TemplateLookup,
): Promise<{ ops: PlanOp[]; repairs: Repair[] }> {
  const p = await run.ctx.engine.getProject(run.ctx.projectId);
  const ops: PlanOp[] = [];
  const repairs: Repair[] = [];
  for (const sp of plan.sequences) {
    const end = sequenceEnd(p, sp.sequenceId);
    const seq = p.sequences.find((s) => s.id === sp.sequenceId)!;
    const free = seq.videoTracks.find(
      (t) => t.id !== 'V1' && t.items.every((it) => it.type !== 'media'),
    );
    let trackId = free?.id;
    if (!trackId) {
      const n = Math.max(0, ...seq.videoTracks.map((t) => Number(t.id.slice(1)))) + 1;
      trackId = `V${String(n)}`;
      ops.push({
        op: 'addTrack',
        args: { sequenceId: sp.sequenceId, kind: 'video', name: 'Scenes' },
      });
    }
    const occupied = (free?.items ?? []).map(
      (it) => [it.startMs, it.startMs + it.durationMs] as const,
    );
    let prevEnd = 0;
    const beats = [...sp.beats].sort((a, b) => a.startMs - b.startMs);
    for (const [i, b] of beats.entries()) {
      if (b.kind !== 'scene') continue;
      const note = (what: string) => repairs.push({ beat: i, sequenceId: sp.sequenceId, what });
      let template = b.template as string;
      let t = templates.get(template);
      if (!t || t.kind !== 'scene') {
        note(`dropped: ${template} is not a scene template`);
        continue;
      }
      let variables: Record<string, unknown> = { ...(b.variables ?? {}) };
      const queries = [...(b.imageQueries ?? [])];
      for (const [slot, kind] of fillableSlots(t)) {
        if (variables[slot] !== undefined) continue;
        const q = queries.shift();
        const id = q === undefined ? undefined : await fillSlot(run, q, kind);
        if (id) {
          variables[slot] = id;
          continue;
        }
        const ph = templates.get(PLACEHOLDER_TEMPLATE);
        if (!ph) {
          note(`dropped: no picture for slot ${slot} and no placeholder template`);
          t = undefined;
          break;
        }
        note(`placeholder: no picture for ${q ?? slot}`);
        template = PLACEHOLDER_TEMPLATE;
        variables = { label: `Picture: ${q ?? slot}`.slice(0, 120) };
        t = ph;
        break;
      }
      if (!t) continue;
      let start = clamp(Math.max(b.startMs, prevEnd), 0, end);
      if (start !== b.startMs) note(`start moved ${String(b.startMs)} → ${String(start)}`);
      let dur = clamp(b.endMs - b.startMs, t.durationMs.min, t.durationMs.max);
      if (dur !== b.endMs - b.startMs) note(`duration clamped to ${String(dur)} (template bounds)`);
      for (const [s, e] of occupied) {
        if (start < e && start + dur > s) {
          if (start >= s) start = e;
          else dur = s - start;
        }
      }
      if (start + dur > end) dur = end - start;
      if (dur < t.durationMs.min) {
        note('dropped: does not fit in the sequence');
        continue;
      }
      prevEnd = start + dur;
      ops.push({
        op: 'addScene',
        args: {
          sequenceId: sp.sequenceId,
          trackId,
          startMs: start,
          durationMs: dur,
          template,
          variables,
        },
      });
    }
  }
  return { ops, repairs };
}

/** Templates of the project's style (default when the run has no lookup). */
function styleIdOf(p: Project, scope: readonly string[]): string {
  const s = p.sequences.find((x) => x.id === scope[0]) ?? p.sequences[0];
  if (!s)
    throw new VoxError('PLAN_INVALID', 'the project has no sequence', 'Add a sequence first.');
  return s.styleId;
}

async function projectTemplates(run: AgentRun, scope: readonly string[]): Promise<TemplateLookup> {
  if (run.deps.templates) return run.deps.templates;
  const p = await run.ctx.engine.getProject(run.ctx.projectId);
  const style = run.ctx.engine.styles.get(styleIdOf(p, scope));
  return {
    get: (id) => {
      const t = style.templates[id] as unknown as TemplateInfo | undefined;
      return t;
    },
  };
}

async function planContext(
  run: AgentRun,
  scope: readonly string[],
  kind: 'clip' | 'ops',
  templates: TemplateLookup,
): Promise<string> {
  const inj = await run.injection(scope);
  const parts = [inj.text];
  const p = await run.ctx.engine.getProject(run.ctx.projectId);
  for (const sequenceId of scope) {
    const s = p.sequences.find((x) => x.id === sequenceId);
    const clip = s?.videoTracks.find((t) => t.id === 'V1')?.items.find((it) => it.type === 'media');
    const mediaId = clip && clip.type === 'media' ? clip.mediaId : undefined;
    if (!mediaId || !p.media.find((m) => m.id === mediaId)?.transcriptPath) continue;
    const page = await transcriptPage(
      run.ctx.engine,
      run.ctx.projectId,
      { mediaId, sequenceId },
      3_000,
    );
    const text = page.words
      .filter((w) => w.seqMs !== null && w.seqMs !== undefined)
      .map((w) => `${String(w.seqMs)} ${w.text}`)
      .join('\n');
    parts.push(
      `Transcript of ${run.aliases.aliasOf(sequenceId)} (sequence ms, word):\n${wrapData('transcript', text)}`,
    );
  }
  if (kind === 'clip') {
    const style = run.ctx.engine.styles.get(styleIdOf(p, scope));
    const list = Object.keys(style.templates)
      .map((id) => templates.get(id))
      .filter((t): t is TemplateInfo => t !== undefined && t.kind === 'scene')
      .map((t) => ({ id: t.id, durationMs: t.durationMs, variables: t.variables, slots: t.slots }));
    parts.push(`Scene templates: ${JSON.stringify(list)}`);
  }
  return parts.join('\n\n');
}

const PLAN_FORMAT = {
  clip: 'Answer with a ClipPlan: { sequences: [{ sequenceId, beats: [{ startMs, endMs, kind: "speaker" | "scene", template?, variables?, imageQueries? }] }] }. Beat times are sequence time. Leave image slots empty and give imageQueries instead.',
  ops: 'Answer with { ops: [{ op, args }] }: engine op names (moveItem, trimItem, addScene, …) with the same args as their tools. Use the short ids from the view.',
} as const;

/** One plan-mode (sub-)run. */
export async function planTurn(run: AgentRun, opts: TurnOptions): Promise<TurnResult> {
  const kind = run.request.planKind ?? 'ops';
  const schema = kind === 'clip' ? ClipPlanSchema : OpsPlanSchema;
  let step = 0;
  try {
    const templates = await projectTemplates(run, opts.scope);
    const system = `${run.systemPrompt()}\n\n${PLAN_FORMAT[kind]}`;
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: `${opts.instruction ?? run.request.message}\n\n${await planContext(run, opts.scope, kind, templates)}`,
      },
    ];
    for (let attempt = 0; attempt <= MAX_PLAN_RETRIES; attempt++) {
      step++;
      const out = await run.structured({ system, messages, schema: schema as z.ZodType });
      run.record.write({
        type: 'step',
        step,
        mode: 'plan',
        ...(opts.subRun !== undefined && { subRun: opts.subRun }),
        scope: opts.scope,
        plan: out.value,
        usage: out.usage,
        spentUsd: run.spentUsd,
      });
      run.emit({
        type: 'agent.step',
        payload: {
          runId: run.runId,
          step,
          ...(opts.subRun !== undefined && { subRun: opts.subRun }),
          scope: opts.scope,
          summary: `plan (attempt ${String(attempt + 1)})`,
          usage: out.usage,
          costUsd: 0,
        },
      });
      let ops: PlanOp[];
      let repairs: Repair[] = [];
      try {
        const plan = validatePlan(run, kind, out.value);
        if (kind === 'clip')
          ({ ops, repairs } = await clipPlanToOps(run, plan as ClipPlan, templates));
        else ops = (plan as OpsPlan).ops;
        if (ops.length === 0)
          throw new VoxError(
            'PLAN_INVALID',
            'the plan has nothing to apply',
            'Plan at least one change.',
          );
      } catch (err) {
        if (!isVoxError(err) || err.code !== 'PLAN_INVALID') throw err;
        run.record.write({ type: 'planInvalid', step, error: toVoxErrorJson(err) });
        if (attempt === MAX_PLAN_RETRIES) throw err;
        messages.push({ role: 'assistant', content: JSON.stringify(out.value) ?? '' });
        messages.push({ role: 'user', content: `${err.message}. ${err.hint}` });
        continue;
      }
      if (run.request.confirmPlan) {
        const d = await run.pause({
          reason: 'approval',
          kind: 'plan',
          detail: `Plan with ${String(ops.length)} op(s)${repairs.length ? `, ${String(repairs.length)} repair(s)` : ''}.`,
          plan: run.aliases.toModel({ ops, repairs }),
        });
        if (d.action === 'stop')
          return {
            status: 'stopped',
            summary: 'Stopped before the plan ran; nothing was applied.',
            steps: step,
          };
      }
      const applied = await applyAsAgent(run.ctx, 'batch', { ops });
      if (applied.versions) run.versions.push(...applied.versions);
      const res = applied.result as {
        version: number;
        results: { status: string; error?: { message: string; hint: string } }[];
      };
      run.record.write({
        type: 'tool',
        tool: 'batch',
        by: 'plan',
        args: { ops: ops.length },
        result: res,
        repairs,
        ...(applied.versions && { versions: applied.versions }),
      });
      const bad = res.results.filter((r) => r.status !== 'succeeded');
      if (bad.length === 0) {
        const r = `Applied a plan of ${String(ops.length)} op(s) at version ${String(res.version)}.${repairs.length ? ` Repairs: ${repairs.map((x) => x.what).join('; ')}.` : ''}`;
        return endPlan(run, opts, { status: 'completed', summary: r, steps: step });
      }
      if (attempt === MAX_PLAN_RETRIES) {
        throw new VoxError(
          'PLAN_INVALID',
          `the plan did not apply: ${bad.map((b) => b.error?.message ?? b.status).join('; ')}`,
          'Edit by hand or try another model.',
        );
      }
      messages.push({ role: 'assistant', content: JSON.stringify(out.value) ?? '' });
      messages.push({
        role: 'user',
        content: `The plan did not apply (nothing changed): ${JSON.stringify(run.aliases.toModel(bad))}. Send a corrected plan.`,
      });
    }
    throw new VoxError('PLAN_INVALID', 'no valid plan', 'Try another model.');
  } catch (err) {
    if (err instanceof RunStopped)
      return endPlan(run, opts, {
        status: 'stopped',
        summary: 'Stopped by the user.',
        steps: step,
      });
    const e = run.deps.redactor.redact(
      toVoxErrorJson(
        isVoxError(err)
          ? err
          : new VoxError('TOOL_FAILED', 'plan mode failed', 'See the run record.', { cause: err }),
      ),
    );
    return endPlan(run, opts, {
      status: 'failed',
      summary: `${e.message}. ${e.hint}`,
      steps: step,
      error: e,
    });
  }
}

function endPlan(run: AgentRun, opts: TurnOptions, r: TurnResult): TurnResult {
  run.record.write({ type: 'aliases', table: run.aliases.snapshot() });
  if (opts.subRun !== undefined)
    run.record.write({ type: 'subRun', subRun: opts.subRun, scope: opts.scope, ...r });
  return r;
}
