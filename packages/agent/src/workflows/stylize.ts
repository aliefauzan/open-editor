// Stylize (agent spec "Workflows" 1b; clipper steps 3–6): one sub-run per sequence, all under the
// run's `runId`. The workflow switches the sequence to the style and its default caption preset, the
// model storyboards and fills (tools mode) or plans (`ClipPlan`, plan mode), then the workflow puts
// cover-style transitions at the clip edges and checks the storyboard, fill, review and sound
// checkpoints. The per-clip summary carries the audio numbers and the five listen timecodes; it
// never says the sound is good.
import type { Project, ResolvedStyle, Sequence } from '@vox/engine';
import { RunStopped, type AgentRun } from '../loop/run.ts';
import type { Checkpoints } from './checkpoints.ts';

export type Layout = 'full-collage' | 'hybrid';

export interface StylizeOptions {
  styleId: string;
  layout: Layout;
  /** The user's instruction, passed to each sub-run. */
  instruction: string;
  /** First sub-run number (the clipper and Stylize both start at 1). */
  firstSubRun?: number;
}

export interface ClipReport {
  sequenceId: string;
  status: 'completed' | 'capped' | 'stopped' | 'failed';
  scenes: number;
  placeholders: number;
  /** Share of the runtime with no scene over the speaker (0–1). */
  speakerShare: number;
  /** Frame-health flags still present in the last `view_frames` (`seqMs: flag`). */
  health: string[];
  audio?: {
    pass: boolean;
    failing: string[];
    integratedLufs?: number;
    truePeakDbtp?: number;
    listen: string[];
  };
  edges: string[];
  skipped: string[];
}

interface PairItem {
  id: string;
  track: string;
  startMs: number;
  inMs: number;
  durationMs: number;
  linkId?: string;
}

const PLACEHOLDER = 'base/placeholder';

/** The media clips of `V1` and `A1` (the linked pair quick clips placed). */
export function pairOf(s: Sequence): PairItem[] {
  const out: PairItem[] = [];
  for (const t of [...s.videoTracks, ...s.audioTracks]) {
    if (t.id !== 'V1' && t.id !== 'A1') continue;
    for (const it of t.items) {
      if (it.type !== 'media') continue;
      out.push({
        id: it.id,
        track: t.id,
        startMs: it.startMs,
        inMs: it.inMs,
        durationMs: it.durationMs,
        ...(it.linkId !== undefined && { linkId: it.linkId }),
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function sceneItems(s: Sequence) {
  return s.videoTracks
    .filter((t) => t.id !== 'V1')
    .flatMap((t) =>
      t.items.filter((i) => i.type === 'scene').map((i) => ({ track: t.id, item: i })),
    )
    .sort((a, b) => a.item.startMs - b.item.startMs);
}

export function sequenceEndMs(s: Sequence): number {
  let end = 0;
  for (const t of [...s.videoTracks, ...s.audioTracks])
    for (const it of t.items) end = Math.max(end, it.startMs + it.durationMs);
  return end;
}

/** Share of [0, end) with no scene on a track above V1. */
export function speakerShare(s: Sequence): number {
  const end = sequenceEndMs(s);
  if (end <= 0) return 1;
  const spans = sceneItems(s)
    .map(({ item }) => [item.startMs, Math.min(end, item.startMs + item.durationMs)] as const)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let at = 0;
  for (const [a, b] of spans) {
    const from = Math.max(a, at);
    if (b > from) covered += b - from;
    at = Math.max(at, b);
  }
  return Number(((end - covered) / end).toFixed(4));
}

/** Slot values (`items/*\/media` paths) of a scene that do not name a media item of the project. */
function emptySlots(p: Project, slots: Record<string, string>, vars: unknown): string[] {
  const missing: string[] = [];
  const walk = (v: unknown, parts: string[], path: string) => {
    if (parts.length === 0) {
      if (v === undefined) return;
      if (typeof v !== 'string' || !p.media.some((m) => m.id === v)) missing.push(path);
      return;
    }
    const [head, ...rest] = parts as [string, ...string[]];
    if (head === '*') {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, rest, `${path}/${String(i)}`));
      return;
    }
    const o = v as Record<string, unknown> | null;
    if (o === null || typeof o !== 'object') return;
    walk(o[head], rest, path ? `${path}/${head}` : head);
  };
  for (const path of Object.keys(slots)) walk(vars, path.split('/'), '');
  return missing;
}

/** The style's first transition that covers the cut (needs no source handles). */
export function coverTransition(style: ResolvedStyle): string | undefined {
  const own = (style.style.transitions ?? []).map((n) =>
    n.includes('/') ? n : `${style.id}/${n}`,
  );
  const all = [...own, ...Object.keys(style.templates)];
  return all.find((id) => {
    const t = style.templates[id];
    return t?.kind === 'transition' && t.blendsShots !== true;
  });
}

/**
 * Clip edges (plan D-15, D-51): quick clips have no source beyond their range, so the first and the
 * last scene of the clip get a cover-style transition, and any transition that blends two shots on a
 * cut next to a V1 clip is swapped for the cover-style one. Returns notes for the summary.
 */
async function edgeTransitions(
  run: AgentRun,
  sequenceId: string,
  style: ResolvedStyle,
  subRun: number,
): Promise<string[]> {
  const cover = coverTransition(style);
  if (!cover) return ['no cover-style transition in the style: clip edges left as cuts'];
  const def = style.templates[cover]!;
  const p = await run.ctx.engine.getProject(run.ctx.projectId);
  const s = p.sequences.find((x) => x.id === sequenceId);
  if (!s) return [];
  const blends = (id: string | undefined) =>
    id !== undefined && style.templates[id]?.blendsShots === true;
  const targets = new Map<string, string>();
  const scenes = sceneItems(s);
  for (const sc of [scenes[0], scenes.at(-1)]) {
    if (!sc) continue;
    const tr = sc.item.transitionIn;
    if (!tr) targets.set(sc.item.id, 'added');
    else if (blends(tr.template)) targets.set(sc.item.id, `swapped ${tr.template}`);
  }
  for (const t of s.videoTracks) {
    for (const it of t.items) {
      if (it.type === 'media' && blends(it.transitionIn?.template))
        targets.set(it.id, `swapped ${it.transitionIn!.template}`);
    }
  }
  const notes: string[] = [];
  for (const [itemId, what] of targets) {
    // one edge that cannot take the transition is a note on the clip, never a failed workflow
    let ok: boolean;
    let why = '';
    try {
      const out = await run.workflowCall(
        'set_transition',
        {
          sequenceId,
          itemId,
          transition: { template: cover, durationMs: def.durationMs.default },
        },
        subRun,
      );
      const r = out.result as { results?: { status: string }[] };
      ok = r.results?.every((x) => x.status === 'succeeded') ?? false;
    } catch (err) {
      if (err instanceof RunStopped) throw err;
      ok = false;
      const e = run.deps.redactor.redact(err instanceof Error ? err.message : String(err));
      why = ` (${e.slice(0, 200)})`;
      run.record.write({ type: 'edgeError', sequenceId, itemId, error: e });
    }
    notes.push(
      `${cover} ${ok ? what : `could not be set${why}`} on ${run.aliases.aliasOf(itemId)}`,
    );
  }
  return notes;
}

/** The last successful call of `tool` on the sequence in this sub-run, at index `from` or later. */
const lastCall = (run: AgentRun, tool: string, sequenceId: string, subRun: number, from = 0) =>
  run.calls.findLast(
    (c, i) =>
      i >= from &&
      c.tool === tool &&
      c.ok &&
      c.subRun === subRun &&
      (c.args as { sequenceId?: unknown } | null)?.sequenceId === sequenceId,
  );

interface QaView {
  pass?: boolean;
  checks?: { id: string; status?: string; integratedLufs?: number; truePeakDbtp?: number }[];
  listen?: { timecode?: string; atMs?: number }[];
}

function audioOf(result: unknown): ClipReport['audio'] | undefined {
  const qa = result as QaView | undefined;
  if (!qa || typeof qa.pass !== 'boolean') return undefined;
  const checks = qa.checks ?? [];
  const loud = checks.find((c) => c.id === 'loudness');
  return {
    pass: qa.pass,
    failing: checks.filter((c) => c.status !== undefined && c.status !== 'pass').map((c) => c.id),
    ...(typeof loud?.integratedLufs === 'number' && { integratedLufs: loud.integratedLufs }),
    ...(typeof loud?.truePeakDbtp === 'number' && { truePeakDbtp: loud.truePeakDbtp }),
    listen: (qa.listen ?? []).map((l) => l.timecode ?? `${String(l.atMs ?? 0)} ms`),
  };
}

function healthOf(result: unknown): string[] {
  const frames = (result as { frames?: { seqMs: number; health?: string[] }[] } | undefined)
    ?.frames;
  return (frames ?? []).flatMap((f) => (f.health ?? []).map((h) => `${String(f.seqMs)} ms: ${h}`));
}

/** One line per clip for the run summary (never a judgement of how it sounds). */
export function clipSummary(alias: string, r: ClipReport): string {
  const parts = [
    `Clip ${alias}: ${r.status}; ${String(r.scenes)} scene(s)${r.placeholders ? ` (${String(r.placeholders)} placeholder)` : ''}, speaker ${String(Math.round(r.speakerShare * 100))} %.`,
  ];
  parts.push(
    r.health.length ? `Frame-health flags: ${r.health.join(', ')}.` : 'Frame-health flags: none.',
  );
  if (r.audio) {
    const a = r.audio;
    parts.push(
      `Audio QA ${a.pass ? 'PASS' : 'FAIL'}${a.failing.length ? `; still failing: ${a.failing.join(', ')}` : ''}${a.integratedLufs !== undefined ? `; ${String(a.integratedLufs)} LUFS` : ''}${a.truePeakDbtp !== undefined ? `, true peak ${String(a.truePeakDbtp)} dBTP` : ''}.`,
    );
    if (a.listen.length)
      parts.push(
        `Listen at ${a.listen.join(', ')} and check by ear (the agent measures; it cannot hear).`,
      );
  } else parts.push('Audio QA not run.');
  if (r.edges.length) parts.push(`Edges: ${r.edges.join('; ')}.`);
  if (r.skipped.length) parts.push(`Skipped: ${r.skipped.join('; ')}.`);
  return parts.join(' ');
}

/** Scene midpoints (sequence ms) for the review, at most 8. */
const midpoints = (s: Sequence) =>
  sceneItems(s)
    .slice(0, 8)
    .map(({ item }) => item.startMs + Math.floor(item.durationMs / 2));

/** Stylize each sequence in its own sub-run; checkpoints are marked on `cp`. */
export async function stylizeSequences(
  run: AgentRun,
  cp: Checkpoints,
  sequenceIds: readonly string[],
  opts: StylizeOptions,
): Promise<ClipReport[]> {
  const style = run.ctx.engine.styles.get(opts.styleId);
  const reports: ClipReport[] = [];
  const plan = run.mode === 'plan';
  for (const [i, sequenceId] of sequenceIds.entries()) {
    const subRun = (opts.firstSubRun ?? 1) + i;
    const alias = run.aliases.aliasOf(sequenceId);
    const before = await run.ctx.engine.getProject(run.ctx.projectId);
    const seq0 = before.sequences.find((s) => s.id === sequenceId)!;
    const pair0 = JSON.stringify(pairOf(seq0));
    const range0 = JSON.stringify(seq0.sourceRange ?? null);
    const overrides0 = JSON.stringify(seq0.captions?.overrides ?? []);
    const skipped: string[] = [];

    if (seq0.styleId !== style.id)
      await run.workflowCall('update_sequence', { sequenceId, styleId: style.id }, subRun);
    const preset = style.style.captions?.default;
    if (preset && seq0.captions?.preset !== preset)
      await run.workflowCall('set_captions', { sequenceId, enabled: true, preset }, subRun);

    const turn = await run.turn({
      scope: [sequenceId],
      subRun,
      instruction: `${opts.instruction}\n\nStyle the clip ${alias} with the ${style.id} style, layout ${opts.layout}. Keep its V1/A1 pair, sourceRange and caption edits.`,
    });
    if (turn.status === 'stopped') throw new RunStopped();
    if (turn.status !== 'completed') skipped.push(`sub-run ${turn.status}: ${turn.summary}`);
    const preEdges = (await run.ctx.engine.getProject(run.ctx.projectId)).version;
    const mark = run.calls.length;
    const edges = await edgeTransitions(run, sequenceId, style, subRun);

    let p = await run.ctx.engine.getProject(run.ctx.projectId);
    let s = p.sequences.find((x) => x.id === sequenceId)!;
    const scenes = sceneItems(s);
    // The model's frames and audio checks predate the edges: when the edges changed the project, the
    // workflow checks again itself (as in plan mode), and only checks after the edges count.
    const edged = p.version > preEdges;
    const from = edged ? mark : 0;

    if ((plan || edged) && scenes.length > 0) {
      await run.workflowCall('view_frames', { sequenceId, atSeqMs: midpoints(s) }, subRun);
      await run.workflowCall('check_audio', { sequenceId }, subRun);
      p = await run.ctx.engine.getProject(run.ctx.projectId);
      s = p.sequences.find((x) => x.id === sequenceId)!;
    }

    // storyboard: the pair, range and caption edits kept; at least one scene placed
    const kept =
      JSON.stringify(pairOf(s)) === pair0 &&
      JSON.stringify(s.sourceRange ?? null) === range0 &&
      JSON.stringify(s.captions?.overrides ?? []) === overrides0;
    if (!kept)
      cp.missed('storyboard', sequenceId, 'the V1/A1 pair, sourceRange or a caption edit changed');
    else if (scenes.length === 0) cp.missed('storyboard', sequenceId, 'no scene placed');
    else cp.met('storyboard', sequenceId, `${String(scenes.length)} scene(s)`);

    // fill: every slot names a media item of the project
    const empty = scenes.flatMap(({ item }) => {
      if (item.type !== 'scene') return [];
      const t = style.templates[item.template];
      return t
        ? emptySlots(p, t.slots, item.variables).map((x) => `${run.aliases.aliasOf(item.id)} ${x}`)
        : [];
    });
    const placeholders = scenes.filter(
      ({ item }) => item.type === 'scene' && item.template === PLACEHOLDER,
    ).length;
    if (scenes.length === 0) cp.missed('fill', sequenceId, 'no scene to fill');
    else if (empty.length > 0) cp.missed('fill', sequenceId, `empty slot(s): ${empty.join(', ')}`);
    else
      cp.met(
        'fill',
        sequenceId,
        placeholders ? `${String(placeholders)} placeholder(s)` : 'all slots filled',
      );

    const frames = lastCall(run, 'view_frames', sequenceId, subRun, from);
    if (frames)
      cp.met('review', sequenceId, `${String(healthOf(frames.result).length)} health flag(s)`);
    else cp.missed('review', sequenceId, 'view_frames was not called');

    const qa = lastCall(run, 'check_audio', sequenceId, subRun, from);
    if (qa) cp.met('sound', sequenceId, (qa.result as QaView).pass ? 'pass' : 'FAIL reported');
    else cp.missed('sound', sequenceId, 'check_audio was not called');
    if (!run.deps.models.vision && !run.deps.models.editor.vision)
      skipped.push('no vision model: frames and qa.png were not described');

    const report: ClipReport = {
      sequenceId,
      status: turn.status,
      scenes: scenes.length,
      placeholders,
      speakerShare: speakerShare(s),
      health: frames ? healthOf(frames.result) : [],
      ...(qa && audioOf(qa.result) && { audio: audioOf(qa.result)! }),
      edges,
      skipped,
    };
    reports.push(report);
    run.addSummary(clipSummary(alias, report));
  }
  return reports;
}
