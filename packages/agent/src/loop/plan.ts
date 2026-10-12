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
  validateVariables,
} from '@vox/engine';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { VoxError, isVoxError, toVoxErrorJson } from '../errors.ts';
import { applyAsAgent } from '../tools/ops.ts';
import { invokeTool } from '../tools/registry.ts';
import { transcriptLines } from '../tools/transcript.ts';
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
                // Guided-generation models (Apple on-device) fill every field: a speaker beat may
                // come back with an empty template, which means none.
                template: z.string().optional(),
                variables: z.record(z.string(), z.unknown()).optional(),
                imageQueries: z.array(z.string().trim().min(1).max(200)).max(4).optional(),
              })
              // a beat that does not end after it starts is dropped as a repair (clipPlanToOps), so
              // one slip among many beats of a small model does not reject the whole plan
              .refine((b) => b.kind === 'speaker' || (b.template ?? '') !== '', {
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

/**
 * The retry hint for a plan with nothing to apply: says why each scene beat was dropped (a caption
 * preset used as a scene template, a beat that does not fit), so the next answer can fix it.
 */
export function emptyPlanHint(repairs: readonly Repair[]): string {
  const dropped = repairs.filter((r) => r.what.startsWith('dropped'));
  if (dropped.length === 0)
    return 'Plan at least one change: add a scene beat with a scene template from the list.';
  const why = dropped
    .slice(0, 8)
    .map((r) => r.what.replace(/^dropped: /, ''))
    .join('; ');
  return `Plan at least one change. Scene beats not applied: ${why}. Use scene templates from the list.`;
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

/** Top-level image/cutout slots of a template (arrays and panels are filled by their own helpers). */
const fillableSlots = (t: TemplateInfo) =>
  Object.entries(t.slots).filter(
    ([path, kind]) => /^[A-Za-z0-9_]+$/.test(path) && (kind === 'image' || kind === 'cutout'),
  );

/** Media slots inside an array (slot path `items/<any>/media`): [array variable, field, kind]. */
const nestedSlots = (t: TemplateInfo) =>
  Object.entries(t.slots).flatMap(([path, kind]) => {
    const m = /^([A-Za-z0-9_]+)\/\*\/([A-Za-z0-9_]+)$/.exec(path);
    return m && (kind === 'image' || kind === 'cutout') ? [[m[1]!, m[2]!, kind] as const] : [];
  });

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

/** A picture of the project in a slot value (the model was told to leave slots empty). */
const isImage = (p: Project, v: unknown) =>
  typeof v === 'string' && p.media.some((m) => m.id === v.trim() && m.kind === 'image');

/** The text the model wrote in a slot when it is a description (has a space), as a query. */
const describedQuery = (v: unknown) =>
  typeof v === 'string' && /\s/.test(v.trim()) ? v.trim().slice(0, 120) : undefined;

/**
 * Pictures inside arrays (paper-collage `items/*\/media`): an entry that does not name a picture of
 * the project gets one from the next image query, or from its own text when the model wrote a
 * description there. `missing` names the first entry left without a picture.
 */
async function fillArrays(
  run: AgentRun,
  p: Project,
  t: TemplateInfo,
  variables: Record<string, unknown>,
  queries: string[],
): Promise<{ variables: Record<string, unknown>; missing?: string }> {
  let out = variables;
  for (const [arr, field, kind] of nestedSlots(t)) {
    const list = out[arr];
    if (!Array.isArray(list)) continue;
    const filled: unknown[] = [];
    for (const el of list) {
      if (typeof el !== 'object' || el === null) continue;
      const entry = { ...(el as Record<string, unknown>) };
      if (isImage(p, entry[field])) {
        filled.push(entry);
        continue;
      }
      const q = queries.shift() ?? describedQuery(entry[field]);
      const id = q === undefined ? undefined : await fillSlot(run, q, kind);
      if (!id) return { variables: out, missing: q ?? `${arr} ${field}` };
      entry[field] = id;
      filled.push(entry);
    }
    out = { ...out, [arr]: filled };
  }
  return { variables: out };
}

/** `template` slots of a scene (stack `panels/*`): the array variable holding the panels. */
const panelSlots = (t: TemplateInfo) =>
  Object.entries(t.slots).flatMap(([path, kind]) => {
    const m = /^([A-Za-z0-9_]+)\/\*$/.exec(path);
    return m && kind === 'template' ? [m[1]!] : [];
  });

/**
 * Pictures inside the panels of a `template` slot (D-86). A panel's picture slot that does not name
 * a picture of the project gets one from the next image query (or the description written there).
 * An optional slot with no picture is left empty, with a repair note when a picture was asked for
 * (the panel renders without it); a required one is `missing`, and the scene becomes a placeholder.
 * Panels with an unknown template are left as they are: the engine's variable check decides.
 */
async function fillPanels(
  run: AgentRun,
  p: Project,
  t: TemplateInfo,
  variables: Record<string, unknown>,
  queries: string[],
  templates: TemplateLookup,
  note: (what: string) => void,
): Promise<{ variables: Record<string, unknown>; missing?: string }> {
  let out = variables;
  for (const arr of panelSlots(t)) {
    const list = out[arr];
    if (!Array.isArray(list)) continue;
    const panels: unknown[] = [];
    for (const [i, el] of list.entries()) {
      const panel = el as { template?: unknown; variables?: unknown } | null;
      const inner = typeof panel?.template === 'string' ? templates.get(panel.template) : undefined;
      if (!panel || !inner || inner.kind !== 'scene') {
        panels.push(el);
        continue;
      }
      let vars: Record<string, unknown> =
        typeof panel.variables === 'object' && panel.variables !== null
          ? { ...(panel.variables as Record<string, unknown>) }
          : {};
      const required = new Set((inner.variables['required'] ?? []) as string[]);
      for (const [slot, kind] of fillableSlots(inner)) {
        if (isImage(p, vars[slot])) continue;
        const q = queries.shift() ?? describedQuery(vars[slot]);
        const id = q === undefined ? undefined : await fillSlot(run, q, kind);
        if (id) {
          vars[slot] = id;
          continue;
        }
        if (required.has(slot)) return { variables: out, missing: q ?? `${arr} ${slot}` };
        if (vars[slot] !== undefined || q !== undefined)
          note(`panel ${String(i)}: no picture for ${q ?? slot}, ${slot} left empty`);
        delete vars[slot];
      }
      const arrays = await fillArrays(run, p, inner, vars, queries);
      if (arrays.missing !== undefined) return { variables: out, missing: arrays.missing };
      vars = arrays.variables;
      panels.push({ ...panel, variables: vars });
    }
    out = { ...out, [arr]: panels };
  }
  return { variables: out };
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
    // the Scenes track is added only when at least one scene beat of this sequence applies
    const addTrackAt = trackId ? -1 : ops.length;
    if (!trackId) {
      const n = Math.max(0, ...seq.videoTracks.map((t) => Number(t.id.slice(1)))) + 1;
      trackId = `V${String(n)}`;
    }
    const occupied = (free?.items ?? []).map(
      (it) => [it.startMs, it.startMs + it.durationMs] as const,
    );
    let prevEnd = 0;
    const beats = [...sp.beats].sort((a, b) => a.startMs - b.startMs);
    for (const [i, b] of beats.entries()) {
      if (b.kind !== 'scene') continue;
      const note = (what: string) => repairs.push({ beat: i, sequenceId: sp.sequenceId, what });
      if (b.endMs <= b.startMs) {
        note(`dropped: ends at ${String(b.endMs)}, not after its start ${String(b.startMs)}`);
        continue;
      }
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
      // Pictures inside an array (paper-collage `items/*/media`): the model was told to leave image
      // slots empty, so an entry that does not name a picture of the project gets one from the beat's
      // next image query, or from its own text when the model wrote a description there. No picture
      // for an entry → the scene becomes a placeholder, as for a top-level slot.
      // Scenes inside a `template` slot (stack `panels/*`, D-86): each panel's own picture slots are
      // filled the same way, from the same queue of image queries, in panel order.
      let missing: string | undefined;
      if (template !== PLACEHOLDER_TEMPLATE) {
        const arrays = await fillArrays(run, p, t, variables, queries);
        missing = arrays.missing;
        if (missing === undefined) {
          const panels = await fillPanels(run, p, t, arrays.variables, queries, templates, note);
          missing = panels.missing;
          variables = panels.variables;
        }
      }
      if (missing !== undefined) {
        const ph = templates.get(PLACEHOLDER_TEMPLATE);
        if (!ph) {
          note(`dropped: no picture for ${missing} and no placeholder template`);
          continue;
        }
        note(`placeholder: no picture for ${missing}`);
        template = PLACEHOLDER_TEMPLATE;
        variables = { label: `Picture: ${missing}`.slice(0, 120) };
        t = ph;
      }
      // Variables that still do not fit the template (a required array left out) would fail the
      // whole batch: the scene becomes a placeholder instead, with the reason in the repairs.
      if (template !== PLACEHOLDER_TEMPLATE) {
        const problem = await variablesProblem(run, t, variables, templates);
        const ph = problem === undefined ? undefined : templates.get(PLACEHOLDER_TEMPLATE);
        if (problem !== undefined && !ph) {
          note(`dropped: ${template} variables do not fit (${problem})`);
          continue;
        }
        if (problem !== undefined && ph) {
          note(`placeholder: ${template} variables do not fit (${problem})`);
          variables = { label: `Scene: ${template}`.slice(0, 120) };
          template = PLACEHOLDER_TEMPLATE;
          t = ph;
        }
      }
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
    if (addTrackAt >= 0 && ops.length > addTrackAt)
      ops.splice(addTrackAt, 0, {
        op: 'addTrack',
        args: { sequenceId: sp.sequenceId, kind: 'video', name: 'Scenes' },
      });
  }
  return { ops, repairs };
}

/** Why the variables do not fit the template (the engine's own check), or undefined when they do. */
async function variablesProblem(
  run: AgentRun,
  t: TemplateInfo,
  variables: Record<string, unknown>,
  templates: TemplateLookup,
): Promise<string | undefined> {
  // pictures found for this plan were added to the project after the plan started: read it again
  const p = await run.ctx.engine.getProject(run.ctx.projectId);
  try {
    validateVariables(t, variables, templates, p);
    return undefined;
  } catch (err) {
    if (!isVoxError(err)) throw err;
    return err.message.slice(0, 200);
  }
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
    // the sequence's span only, one line per sentence in sequence ms (D-81)
    const { page } = await transcriptLines(
      run.ctx.engine,
      run.ctx.projectId,
      { mediaId, sequenceId },
      3_000,
    );
    parts.push(
      `Transcript of ${run.aliases.aliasOf(sequenceId)} ([startMs-endMs] text, sequence ms):\n${wrapData('transcript', page.lines)}`,
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
  if (run.ctx.question) return questionTurn(run, opts);
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
            emptyPlanHint(repairs),
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

const AnswerSchema = z.strictObject({ answer: z.string().min(1).max(4000) });

/** A question turn in plan mode (S35): one structured answer from the view, no writes. */
async function questionTurn(run: AgentRun, opts: TurnOptions): Promise<TurnResult> {
  try {
    const inj = await run.injection(opts.scope);
    const out = await run.structured({
      system: `${run.systemPrompt()}\n\nThis turn is a question: answer it from the current state; change nothing. Answer with { answer }.`,
      messages: [
        { role: 'user', content: `${opts.instruction ?? run.request.message}\n\n${inj.text}` },
      ],
      schema: AnswerSchema,
    });
    run.record.write({
      type: 'step',
      step: 1,
      mode: 'plan',
      scope: opts.scope,
      plan: out.value,
      usage: out.usage,
    });
    const r = AnswerSchema.safeParse(out.value);
    const summary = r.success
      ? r.data.answer
      : String(typeof out.value === 'string' ? out.value : 'No answer.');
    return endPlan(run, opts, { status: 'completed', summary, steps: 1 });
  } catch (err) {
    if (err instanceof RunStopped)
      return endPlan(run, opts, { status: 'stopped', summary: 'Stopped by the user.', steps: 1 });
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
      steps: 1,
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
