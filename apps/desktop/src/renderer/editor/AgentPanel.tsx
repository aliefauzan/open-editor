// Agent panel (app spec "Main editor" → Agent panel; plan phase 13, D-14, D-15): the chat input with
// attachments (media from the bin, files dropped from Finder), the model/mode indicator with the
// "Confirm plan first" toggle, Stop, one pause card per kind (source, plan, pauses, budget, error),
// and a collapsible activity log per run (todos, steps, changes, audio numbers and LISTEN timecodes
// that seek the preview, "Undo this run", the UNDO_CONFLICT view).
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { AgentPauseData, AgentRunData, ClipReportData } from '../../shared/api.ts';
import { parseTimecode, type LiveRun } from './agent-store.ts';
import { useAgent, useCtx, useEditor } from './context.tsx';
import { mediaName, Thumb } from './MediaBin.tsx';
import { DRAG_MEDIA } from './Timeline.tsx';

const btn = 'rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700 disabled:opacity-50';
const primary =
  'rounded bg-indigo-600 px-2 py-1 text-xs font-semibold text-white hover:bg-indigo-500';
const fmtMs = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};
const usd = (n: number) => `$${n.toFixed(2)}`;

/** Media ids anywhere in an import job's result. */
function mediaIdsIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') {
    if (/^m_[A-Za-z0-9_-]+$/.test(v) && !out.includes(v)) out.push(v);
  } else if (Array.isArray(v)) for (const x of v) mediaIdsIn(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) mediaIdsIn(x, out);
  return out;
}

/** Seek the preview (and the playhead) to `ms` in `sequenceId` (the open one when absent). */
function useSeek() {
  const { editor, player } = useCtx();
  return (ms: number, sequenceId?: string) => {
    const st = editor.getState();
    if (sequenceId && st.project?.sequences.some((s) => s.id === sequenceId))
      st.setSequence(sequenceId);
    editor.getState().setPlayhead(ms);
    player.current?.seekMs(ms);
  };
}

function SourceCard(props: { pause: AgentPauseData }) {
  const { agent } = useCtx();
  const runId = props.pause.runId;
  return (
    <div className="space-y-2" data-testid="pause-source">
      {(props.pause.sources ?? []).map((s) => (
        <p key={s} className="break-all">
          The agent wants to ingest <code className="text-amber-300">{s}</code>
        </p>
      ))}
      <div className="flex gap-2">
        <button
          type="button"
          className={primary}
          onClick={() => void agent.getState().decide(runId, { approve: true })}
        >
          Allow
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => void agent.getState().decide(runId, { approve: false })}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

interface PlanBeat {
  startMs: number;
  endMs: number;
  kind: string;
  template?: string;
  variables?: Record<string, unknown>;
}

function beatText(b: PlanBeat): string {
  const v = b.variables ?? {};
  const t = Object.values(v).find((x) => typeof x === 'string');
  return typeof t === 'string' ? t : '';
}

function PlanCard(props: { pause: AgentPauseData }) {
  const { agent } = useCtx();
  const seek = useSeek();
  const runId = props.pause.runId;
  const plan = props.pause.plan as
    | {
        sequences?: { sequenceId: string; beats: PlanBeat[] }[];
        ops?: { op: string; args?: Record<string, unknown> }[];
        repairs?: unknown[];
      }
    | undefined;
  return (
    <div className="space-y-2" data-testid="pause-plan">
      <p>The agent plans these edits. Nothing is changed yet.</p>
      {(plan?.sequences ?? []).map((s) => (
        <ol key={s.sequenceId} className="space-y-0.5" aria-label={`Plan for ${s.sequenceId}`}>
          {s.beats.map((b, i) => (
            <li key={i} className="flex gap-1.5">
              <button
                type="button"
                className="font-mono text-neutral-400 hover:text-white"
                onClick={() => seek(b.startMs, s.sequenceId)}
              >
                {fmtMs(b.startMs)}–{fmtMs(b.endMs)}
              </button>
              <span>{b.kind === 'speaker' ? 'speaker' : (b.template ?? b.kind)}</span>
              {beatText(b) && <span className="truncate text-neutral-400">“{beatText(b)}”</span>}
            </li>
          ))}
        </ol>
      ))}
      {plan?.ops && (
        <ol className="space-y-0.5" aria-label="Planned edits">
          {plan.ops.map((o, i) => {
            const a = o.args ?? {};
            const at = typeof a['startMs'] === 'number' ? a['startMs'] : undefined;
            const dur = typeof a['durationMs'] === 'number' ? a['durationMs'] : undefined;
            const what = typeof a['template'] === 'string' ? a['template'] : '';
            const text = beatText({
              startMs: 0,
              endMs: 0,
              kind: '',
              variables: a['variables'] as never,
            });
            return (
              <li key={i} className="flex gap-1.5">
                {at !== undefined && (
                  <button
                    type="button"
                    className="font-mono text-neutral-400 hover:text-white"
                    onClick={() => seek(at)}
                  >
                    {fmtMs(at)}
                    {dur !== undefined && `–${fmtMs(at + dur)}`}
                  </button>
                )}
                <span>{o.op}</span>
                {what && <span>{what}</span>}
                {text && <span className="truncate text-neutral-400">“{text}”</span>}
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className={primary}
          onClick={() => void agent.getState().decide(runId, { approve: true })}
        >
          Run plan
        </button>
        <button type="button" className={btn} onClick={() => void agent.getState().stop(runId)}>
          Stop
        </button>
      </div>
    </div>
  );
}

function TightenCard(props: { pause: AgentPauseData }) {
  const { agent } = useCtx();
  const seek = useSeek();
  const runId = props.pause.runId;
  const ranges = props.pause.ranges ?? [];
  const [ticked, setTicked] = useState(() => new Set(ranges.map((r) => r.wordKey)));
  return (
    <div
      className="space-y-2"
      data-testid="pause-tighten"
      data-sequence-id={props.pause.sequenceId}
    >
      <p>{props.pause.detail}</p>
      <ul className="max-h-48 space-y-0.5 overflow-y-auto" aria-label="Pauses & fillers">
        {ranges.map((r) => (
          <li key={r.wordKey} className="flex items-center gap-1.5" data-word-key={r.wordKey}>
            <input
              type="checkbox"
              aria-label={`Cut ${r.kind} at ${fmtMs(r.seqStartMs)}`}
              checked={ticked.has(r.wordKey)}
              onChange={(e) => {
                const next = new Set(ticked);
                if (e.target.checked) next.add(r.wordKey);
                else next.delete(r.wordKey);
                setTicked(next);
              }}
            />
            <button
              type="button"
              className="font-mono text-neutral-400 hover:text-white"
              onClick={() => seek(r.seqStartMs, props.pause.sequenceId)}
            >
              {fmtMs(r.seqStartMs)}
            </button>
            <span className="text-neutral-400">{r.kind}</span>
            <span className="truncate">{r.text}</span>
            <span className="ml-auto text-neutral-500">{r.seqEndMs - r.seqStartMs} ms</span>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <button
          type="button"
          className={primary}
          onClick={() =>
            void agent.getState().decide(runId, {
              approve: true,
              wordKeys: ranges.map((r) => r.wordKey).filter((k) => ticked.has(k)),
            })
          }
        >
          Apply
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => void agent.getState().decide(runId, { approve: true, wordKeys: [] })}
        >
          Skip
        </button>
      </div>
    </div>
  );
}

function BudgetCard(props: { pause: AgentPauseData; capUsd: number | undefined }) {
  const { agent } = useCtx();
  const runId = props.pause.runId;
  return (
    <div className="space-y-2" data-testid="pause-budget">
      <p>
        Budget reached{props.capUsd !== undefined && ` (${usd(props.capUsd)})`}.{' '}
        <span className="text-neutral-400">{props.pause.detail}</span>
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          className={primary}
          onClick={() => void agent.getState().decide(runId, { approve: true })}
        >
          Continue with {usd(props.pause.continueUsd ?? 0)}
        </button>
        <button type="button" className={btn} onClick={() => void agent.getState().stop(runId)}>
          Stop
        </button>
      </div>
    </div>
  );
}

function PauseCard(props: { pause: AgentPauseData }) {
  const { agent } = useCtx();
  const cap = useAgent((s) => s.settings?.limits.maxUsdPerRun);
  const p = props.pause;
  let body;
  if (p.reason === 'budget') {
    const m = /of its \$([0-9.]+) cap/.exec(p.detail);
    body = <BudgetCard pause={p} capUsd={m ? Number(m[1]) : cap} />;
  } else if (p.kind === 'source') body = <SourceCard pause={p} />;
  else if (p.kind === 'plan') body = <PlanCard pause={p} />;
  else if (p.kind === 'pauses') body = <TightenCard pause={p} />;
  else
    body = (
      <div className="space-y-2">
        <p>{p.detail}</p>
        <div className="flex gap-2">
          <button
            type="button"
            className={primary}
            onClick={() => void agent.getState().decide(p.runId, { approve: true })}
          >
            Continue
          </button>
          <button type="button" className={btn} onClick={() => void agent.getState().stop(p.runId)}>
            Stop
          </button>
        </div>
      </div>
    );
  return (
    <div
      role="group"
      aria-label="Agent is waiting"
      className="rounded border border-amber-700 bg-amber-950/40 p-2 text-xs"
    >
      {body}
    </div>
  );
}

function Todos(props: { items: AgentRunData['todos'] }) {
  if (props.items.length === 0) return null;
  return (
    <ul className="space-y-0.5" aria-label="Agent todo list" data-testid="agent-todos">
      {props.items.map((t, i) => (
        <li
          key={i}
          data-status={t.status}
          aria-current={t.status === 'in_progress' ? 'step' : undefined}
          className={
            t.status === 'done'
              ? 'text-neutral-500 line-through'
              : t.status === 'in_progress'
                ? 'rounded bg-indigo-900/60 px-1 text-white'
                : ''
          }
        >
          {t.status === 'done' ? '✓ ' : '• '}
          {t.text}
        </li>
      ))}
    </ul>
  );
}

function ClipReport(props: { clip: ClipReportData }) {
  const seek = useSeek();
  const c = props.clip;
  const name = useEditor(
    (s) => s.project?.sequences.find((q) => q.id === c.sequenceId)?.name ?? c.sequenceId,
  );
  return (
    <div className="rounded bg-neutral-800/60 p-1.5" data-testid="clip-report">
      <p className="font-medium">
        {name}: {c.scenes} scene(s){c.placeholders > 0 && `, ${c.placeholders} placeholder(s)`},
        speaker {Math.round(c.speakerShare * 100)} %
      </p>
      {c.audio && (
        <p data-testid="audio-numbers">
          Audio check {c.audio.pass ? 'passed' : `failed (${c.audio.failing.join(', ')})`}
          {c.audio.integratedLufs !== undefined && ` · ${c.audio.integratedLufs.toFixed(1)} LUFS`}
          {c.audio.truePeakDbtp !== undefined && ` · ${c.audio.truePeakDbtp.toFixed(1)} dBTP`}
        </p>
      )}
      {c.audio && c.audio.listen.length > 0 && (
        <p className="flex flex-wrap items-center gap-1">
          Listen at
          {c.audio.listen.map((tc) => {
            const ms = parseTimecode(tc);
            return (
              <button
                key={tc}
                type="button"
                className="rounded bg-neutral-700 px-1 font-mono hover:bg-neutral-600"
                disabled={ms === undefined}
                onClick={() => ms !== undefined && seek(ms, c.sequenceId)}
              >
                {tc}
              </button>
            );
          })}
        </p>
      )}
      {c.skipped.length > 0 && <p className="text-neutral-400">Skipped: {c.skipped.join('; ')}</p>}
    </div>
  );
}

const STATUS_LABEL: Record<AgentRunData['status'], string> = {
  running: 'running',
  paused: 'waiting for you',
  completed: 'done',
  stopped: 'stopped',
  failed: 'failed',
};

function RunCard(props: { run: AgentRunData; live?: LiveRun }) {
  const { agent, editor } = useCtx();
  const r = props.run;
  const live = props.live;
  const status =
    live && (live.status === 'running' || live.status === 'paused') ? live.status : r.status;
  const active = status === 'running' || status === 'paused';
  const todos = live?.todos.length ? live.todos : r.todos;
  const pause = live?.pause ?? r.pause;
  const kept = r.changes.filter((c) => !c.undone);
  const analysed = r.tools.filter((t) => t.byWorkflow).length;
  const [open, setOpen] = useState(active);
  const pick = (itemIds: string[], sequenceIds: string[]) => {
    const st = editor.getState();
    if (sequenceIds[0]) st.setSequence(sequenceIds[0]);
    st.setSelection(itemIds);
  };
  return (
    <li
      className="space-y-1.5 rounded border border-neutral-800 p-2 text-xs"
      data-testid="agent-run"
      data-run-id={r.runId}
      data-status={status}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          aria-expanded={open}
          className="min-w-0 flex-1 text-left"
          onClick={() => setOpen(!open)}
        >
          <span className="block truncate font-medium">{r.message}</span>
          <span className="text-neutral-400">
            {r.workflow} · {STATUS_LABEL[status]} · {usd(r.costUsd)}
            {live?.tool && active && ` · ${live.tool}`}
          </span>
        </button>
        {active && (
          <button type="button" className={btn} onClick={() => void agent.getState().stop(r.runId)}>
            Stop
          </button>
        )}
      </div>
      {r.mode === 'tools' && <Todos items={todos} />}
      {pause && active && <PauseCard pause={pause} />}
      {open && (
        <div className="space-y-1.5" data-testid="activity-log">
          {analysed > 0 && <p className="text-neutral-400">Analyzed ({analysed} job(s))</p>}
          {r.steps.length > 0 && (
            <details>
              <summary className="cursor-pointer text-neutral-400">
                {r.steps.length} step(s)
              </summary>
              <ol className="mt-1 space-y-0.5">
                {r.steps.map((s, i) => (
                  <li key={i} className="text-neutral-300">
                    {s.subRun !== undefined && `[${s.subRun}] `}
                    {s.text || '(tools)'}
                    {s.notes?.map((n) => (
                      <span key={n} className="block text-amber-300" data-testid="change-note">
                        Saw your edit: {n.replace(/^- /, '')}
                      </span>
                    ))}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {r.changes.length > 0 && (
            <details open>
              <summary className="cursor-pointer">
                Edited in timeline ({kept.length} change{kept.length === 1 ? '' : 's'})
              </summary>
              <ul className="mt-1 space-y-0.5">
                {r.changes.map((c) => (
                  <li key={c.version}>
                    <button
                      type="button"
                      className={`hover:underline ${c.undone ? 'text-neutral-500 line-through' : ''}`}
                      onClick={() => pick(c.itemIds, c.sequenceIds)}
                    >
                      v{c.version} {c.op}
                      {c.itemIds.length > 0 && ` (${c.itemIds.length} item(s))`}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {r.tools.some((t) => t.status === 'failed') && (
            <p className="text-amber-400">
              {r.tools.filter((t) => t.status === 'failed').length} tool call(s) failed
            </p>
          )}
          {r.clips.map((c) => (
            <ClipReport key={c.sequenceId} clip={c} />
          ))}
          {r.summary && <p className="whitespace-pre-wrap text-neutral-300">{r.summary}</p>}
          {r.error && <p className="text-red-400">{r.error.message}</p>}
          {!active && kept.length > 0 && (
            <button
              type="button"
              className={btn}
              onClick={() => void agent.getState().undoRun(r.runId)}
            >
              Undo this run
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function ConflictView() {
  const { agent, editor } = useCtx();
  const conflict = useAgent((s) => s.conflict);
  if (!conflict) return null;
  return (
    <div
      role="alert"
      className="space-y-1 rounded bg-red-950 p-2 text-xs"
      data-testid="undo-conflict"
    >
      <p className="font-medium">This run cannot be undone: later edits changed the same items.</p>
      <ul>
        {conflict.itemIds.map((id) => (
          <li key={id}>
            <button
              type="button"
              className="underline"
              onClick={() => editor.getState().setSelection([id])}
            >
              {id}
            </button>
          </li>
        ))}
        {conflict.itemIds.length === 0 &&
          conflict.keys.map((k) => (
            <li key={k} className="font-mono">
              {k}
            </li>
          ))}
      </ul>
      <p className="text-neutral-300">Undo those edits first, or change the items by hand.</p>
      <button type="button" className={btn} onClick={() => agent.getState().clearError()}>
        Close
      </button>
    </div>
  );
}

export function AgentPanel() {
  const { run, agent, editor, vox, jobs, ui } = useCtx();
  const projectId = useEditor((s) => s.projectId);
  const media = useEditor((s) => s.project?.media);
  const runs = useAgent((s) => s.runs);
  const live = useAgent((s) => s.live);
  const settings = useAgent((s) => s.settings);
  const confirmPlan = useAgent((s) => s.confirmPlan);
  const attachments = useAgent((s) => s.attachments);
  const sending = useAgent((s) => s.sending);
  const error = useAgent((s) => s.error);
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    void agent.getState().load(projectId);
  }, [agent, projectId]);
  const editorRole = settings?.roles.editor;
  const mode = settings?.mode ?? 'tools';
  const ordered = useMemo(() => [...runs].reverse(), [runs]);
  const send = async () => {
    const st = editor.getState();
    const selection = [...(st.sequenceId ? [st.sequenceId] : []), ...st.selection];
    const r = await agent.getState().send(text, { selection });
    if (r) setText('');
  };
  const onDrop = (e: DragEvent) => {
    const raw = e.dataTransfer.getData(DRAG_MEDIA);
    if (raw) {
      e.preventDefault();
      try {
        const m = JSON.parse(raw) as { id?: unknown };
        if (typeof m.id === 'string') agent.getState().attach(m.id);
      } catch {
        /* not ours */
      }
      return;
    }
    if (!e.dataTransfer.files.length || !vox.dropFiles || !projectId) return;
    e.preventDefault();
    void vox.dropFiles(projectId, Array.from(e.dataTransfer.files)).then(
      async (started) => {
        const jobId = (started as { jobId?: string } | null)?.jobId;
        if (!jobId) return;
        const row = await jobs.getState().track(jobId, 'ingest', 'Import');
        if (row.status !== 'done') return;
        await editor.getState().reload();
        for (const id of mediaIdsIn(row.result)) agent.getState().attach(id);
      },
      (err: unknown) => editor.getState().toast(err),
    );
  };
  return (
    <aside
      id="agent-panel"
      tabIndex={-1}
      aria-label="Agent"
      className="flex h-full flex-col gap-2 bg-neutral-900 p-3"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">Agent</h2>
        <span className="truncate text-[11px] text-neutral-400" data-testid="agent-mode">
          {editorRole ? `${editorRole.model} · ${mode}` : 'no model'}
        </span>
      </div>
      <label className="flex items-center gap-1.5 text-[11px] text-neutral-300">
        <input
          type="checkbox"
          checked={confirmPlan}
          onChange={(e) => agent.getState().setConfirmPlan(e.target.checked)}
        />
        Confirm plan first
      </label>
      {settings && !editorRole && (
        <p className="text-xs text-neutral-400">
          No editor model yet.{' '}
          <button type="button" className="underline" onClick={() => run('settings')}>
            Open settings
          </button>
        </p>
      )}
      {error && (
        <div role="alert" className="rounded bg-red-950 p-2 text-xs">
          <p>{error.message}</p>
          {error.hint && <p className="text-neutral-300">{error.hint}</p>}
          {(error.code === 'ROLE_MISSING' || error.code === 'PROBE_FAILED') && (
            <button type="button" className="underline" onClick={() => run('settings')}>
              Open settings
            </button>
          )}
        </div>
      )}
      <ConflictView />
      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto" aria-label="Agent runs">
        {ordered.map((r) => (
          <RunCard key={r.runId} run={r} {...(live[r.runId] && { live: live[r.runId] })} />
        ))}
      </ul>
      <div className="flex gap-2">
        <button
          type="button"
          className={btn}
          onClick={() => {
            setText('Make 3 clips from ');
            input.current?.focus();
          }}
        >
          Make clips from URL
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => ui.getState().set({ galleryOpen: true, galleryExtract: true })}
        >
          Extract style
        </button>
      </div>
      <form
        className="flex flex-col gap-1"
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {attachments.length > 0 && (
          <ul className="flex flex-wrap gap-1" aria-label="Attachments">
            {attachments.map((id) => {
              const m = media?.find((x) => x.id === id);
              return (
                <li
                  key={id}
                  className="flex items-center gap-1 rounded bg-neutral-800 px-1.5 text-[11px]"
                >
                  {m && projectId && (
                    <span className="w-6">
                      <Thumb projectId={projectId} m={m} offline={false} />
                    </span>
                  )}
                  <span className="max-w-24 truncate">{m ? mediaName(m) : id}</span>
                  <button
                    type="button"
                    aria-label={`Remove attachment ${id}`}
                    onClick={() => agent.getState().detach(id)}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <textarea
          ref={input}
          aria-label="Message to the agent"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Ask for an edit, or drop a file here"
          className="resize-none rounded bg-neutral-800 p-2 text-xs"
        />
        <button type="submit" className={primary} disabled={sending || !text.trim()}>
          Send
        </button>
      </form>
    </aside>
  );
}
