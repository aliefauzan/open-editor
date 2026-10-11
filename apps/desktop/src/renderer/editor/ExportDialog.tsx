// Export dialog (app spec "Export dialog"; plan D-11, D-13, D-14, D-15): MP4 (quality, range,
// subtitles burned in or not, this sequence or all), SRT / VTT with the subtitle edits, OTIO; "Save
// to" (one file → save dialog, several → folder; default = the folder last used for this project,
// else ~/Movies) through `exports.chooseTarget`, so the renderer only holds a `targetId`; loudness
// target (sent to `render` and `audioQa`); the audio check before an MP4 export (warns on FAIL, never
// blocks; listen timecodes seek the preview); progress, and "Show in Finder" for each written path.
import { useEffect, useState } from 'react';
import type { ErrorData } from '../../shared/api.ts';
import { useCtx, useEditor, useUi } from './context.tsx';
import type { JobRow } from './jobs.ts';

export type Format = 'mp4' | 'srt' | 'vtt' | 'otio';
export type Loudness = 'youtube' | 'tiktok' | 'broadcast';

export const LOUDNESS: { id: Loudness; label: string }[] = [
  { id: 'youtube', label: 'YouTube (−14 LUFS)' },
  { id: 'tiktok', label: 'TikTok (−12 LUFS)' },
  { id: 'broadcast', label: 'Broadcast (−23 LUFS)' },
];

interface Target {
  targetId: string;
  displayPath: string;
  mode: 'file' | 'folder';
}

export interface QaCheck {
  id: string;
  rule?: string;
  status: 'pass' | 'fail' | string;
  [k: string]: unknown;
}
export interface QaResult {
  pass: boolean;
  png?: string;
  checks?: QaCheck[];
  listen?: { atMs: number; kind: string; listenFor: string }[];
}

/** The numbers of a check worth showing (measured values; rules and limits stay in the tooltip). */
export function checkNumbers(c: QaCheck): string {
  const skip = new Set(['toleranceLu', 'maxTruePeakDbtp']);
  return Object.entries(c)
    .filter(([k, v]) => typeof v === 'number' && !skip.has(k))
    .slice(0, 3)
    .map(([k, v]) => `${k} ${v as number}`)
    .join(', ');
}

/** `…/<projectId>/renders/qa/x/qa.png` → its `vox-media://` URL (project files only). */
export function projectFileUrl(projectId: string, abs: string | undefined): string | null {
  if (!abs) return null;
  const i = abs.indexOf(`/${projectId}/`);
  if (i < 0) return null;
  const rel = abs.slice(i + projectId.length + 2);
  return `vox-media://p/${projectId}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/** Paths a finished export job wrote (render: `files[]`, captions / timeline: `path`). */
export function writtenPaths(r: JobRow): string[] {
  const res = r.result as { files?: { path: string }[]; path?: string } | undefined;
  if (!res) return [];
  return res.files ? res.files.map((f) => f.path) : res.path ? [res.path] : [];
}

const safe = (s: string) => s.replace(/[/\\:]/g, '-').trim() || 'export';

export function ExportDialog() {
  const { vox, editor, ui, jobs } = useCtx();
  const open = useUi((s) => s.exportOpen);
  const inMs = useUi((s) => s.inMs);
  const outMs = useUi((s) => s.outMs);
  const project = useEditor((s) => s.project);
  const sequenceId = useEditor((s) => s.sequenceId);
  const seq = project?.sequences.find((s) => s.id === sequenceId);
  const [formats, setFormats] = useState<Record<Format, boolean>>({
    mp4: true,
    srt: true,
    vtt: false,
    otio: false,
  });
  const [all, setAll] = useState(false);
  const [quality, setQuality] = useState<'draft' | 'standard' | 'high'>('standard');
  const [useRange, setUseRange] = useState(false);
  const [burn, setBurn] = useState(true);
  const [loudness, setLoudness] = useState<Loudness>('youtube');
  const [target, setTarget] = useState<Target | null>(null);
  const [qa, setQa] = useState<{ seq: string; result?: QaResult; error?: ErrorData }[] | null>(
    null,
  );
  const [busy, setBusy] = useState<'qa' | 'export' | null>(null);
  const [rows, setRows] = useState<string[]>([]);

  const projectId = project?.id;
  useEffect(() => {
    if (!open || !projectId) return;
    setRows([]);
    setQa(null);
    setBurn(seq?.captions?.enabled ?? true);
    void vox.exports.lastFolder(projectId).then(
      (t) => setTarget({ ...(t as Omit<Target, 'mode'>), mode: 'folder' }),
      (e: unknown) => editor.getState().toast(e),
    );
    // only when the dialog opens
  }, [open, projectId]);

  const seqs = all ? (project?.sequences ?? []) : seq ? [seq] : [];
  const chosen = (Object.keys(formats) as Format[]).filter((f) => formats[f]);
  const fileCount = chosen.length * seqs.length;
  const oneFormat = fileCount === 1 ? chosen[0] : undefined;
  const hasRange = inMs !== null && outMs !== null && outMs > inMs;
  // a file target only fits one file: with more files the export goes to the folder again
  const effective: Target | null =
    target && target.mode === 'file' && fileCount !== 1 ? null : target;
  const lost = target !== null && effective === null;
  useEffect(() => {
    if (!lost || !projectId) return;
    void vox.exports.lastFolder(projectId).then(
      (t) => setTarget({ ...(t as Omit<Target, 'mode'>), mode: 'folder' }),
      (e: unknown) => editor.getState().toast(e),
    );
  }, [lost, projectId, vox, editor]);
  const live = useJobRows(rows);

  if (!open || !project || !seq) return null;

  const change = async () => {
    const mode = fileCount === 1 ? 'file' : 'folder';
    const ext = oneFormat ?? 'mp4';
    try {
      const t = (await vox.exports.chooseTarget({
        projectId: project.id,
        mode,
        format: ext,
        suggestedName: `${safe(project.name)} - ${safe(seq.name)}.${ext}`,
      })) as Omit<Target, 'mode'> | null;
      if (t) setTarget({ ...t, mode }); // cancel keeps the old target
    } catch (e) {
      editor.getState().toast(e);
    }
  };

  const runQa = async (): Promise<void> => {
    setBusy('qa');
    const out: NonNullable<typeof qa> = [];
    for (const s of seqs) {
      const r = await jobs
        .getState()
        .start(
          'audioQa',
          { projectId: project.id, sequenceId: s.id, loudness },
          `Audio check: ${s.name}`,
        );
      out.push(
        r.status === 'done'
          ? { seq: s.id, result: r.result as QaResult }
          : { seq: s.id, ...(r.error ? { error: r.error } : {}) },
      );
    }
    setQa(out);
    setBusy(null);
  };

  const exportNow = async () => {
    if (!effective || chosen.length === 0) return;
    if (formats.mp4) await runQa(); // warns on FAIL, never blocks
    setBusy('export');
    const t = { targetId: effective.targetId };
    const started: Promise<JobRow>[] = [];
    const ids: string[] = [];
    setRows([]);
    const start = (kind: string, args: Record<string, unknown>, label: string) =>
      started.push(
        jobs.getState().start(kind, { projectId: project.id, ...args, ...t }, label, (id) => {
          ids.push(id);
          setRows([...ids]);
        }),
      );
    if (formats.mp4) {
      const common = { quality, captions: burn ? 'burn' : 'none', loudness };
      if (all) start('render', { all: true, ...common }, 'MP4 (all sequences)');
      else {
        start(
          'render',
          {
            sequenceId: seq.id,
            ...common,
            ...(useRange && hasRange ? { range: { startMs: inMs, endMs: outMs } } : {}),
          },
          `MP4: ${seq.name}`,
        );
      }
    }
    for (const s of seqs) {
      for (const f of ['srt', 'vtt'] as const) {
        if (formats[f])
          start('exportCaptions', { sequenceId: s.id, format: f }, `${f.toUpperCase()}: ${s.name}`);
      }
      if (formats.otio) start('exportTimeline', { sequenceId: s.id }, `OTIO: ${s.name}`);
    }
    await Promise.all(started);
    setBusy(null);
  };

  const failing = qa?.some((q) => q.error || q.result?.pass === false);
  const sel = 'rounded bg-neutral-800 px-1 py-0.5';

  return (
    <div
      role="dialog"
      aria-label="Export"
      aria-modal
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
    >
      <div className="flex max-h-[90vh] w-[560px] flex-col gap-3 overflow-y-auto rounded-lg bg-neutral-900 p-4 text-xs shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Export</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={() => ui.getState().set({ exportOpen: false })}
          >
            ×
          </button>
        </div>
        <fieldset className="flex flex-wrap gap-3">
          <legend className="mb-1 text-neutral-400">Files</legend>
          {(
            [
              ['mp4', 'MP4 video'],
              ['srt', 'SRT captions'],
              ['vtt', 'VTT captions'],
              ['otio', 'Editable timeline (OTIO)'],
            ] as const
          ).map(([f, label]) => (
            <label key={f} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={formats[f]}
                onChange={(e) => setFormats({ ...formats, [f]: e.target.checked })}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          All sequences ({project.sequences.length})
        </label>
        {formats.mp4 && (
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1">
              Quality
              <select
                aria-label="Quality"
                className={sel}
                value={quality}
                onChange={(e) => setQuality(e.target.value as typeof quality)}
              >
                <option value="draft">Draft</option>
                <option value="standard">Standard</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={burn} onChange={(e) => setBurn(e.target.checked)} />
              Subtitles burned in
            </label>
            <label
              className="flex items-center gap-1"
              title={hasRange ? '' : 'Set in and out points (I / O) first'}
            >
              <input
                type="checkbox"
                disabled={!hasRange || all}
                checked={useRange && hasRange && !all}
                onChange={(e) => setUseRange(e.target.checked)}
              />
              In to out only
            </label>
            <label className="flex items-center gap-1">
              Loudness target
              <select
                aria-label="Loudness target"
                className={sel}
                value={loudness}
                onChange={(e) => setLoudness(e.target.value as Loudness)}
              >
                {LOUDNESS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div className="flex items-center gap-2 rounded bg-neutral-950 p-2" data-testid="save-to">
          <span className="text-neutral-400">Save to</span>
          <span className="min-w-0 flex-1 truncate font-mono" title={effective?.displayPath}>
            {effective?.displayPath ?? '…'}
          </span>
          <button type="button" className={sel} onClick={() => void change()}>
            Change…
          </button>
        </div>
        {formats.mp4 && (
          <section className="flex flex-col gap-1" aria-label="Audio check">
            <div className="flex items-center gap-2">
              <h3 className="font-medium">Audio check</h3>
              <button
                type="button"
                className={sel}
                disabled={busy !== null}
                onClick={() => void runQa()}
              >
                {busy === 'qa' ? 'Checking…' : 'Check audio'}
              </button>
            </div>
            {failing && (
              <p role="alert" className="text-amber-400">
                Some audio checks failed. You can still export; listen at the timecodes below.
              </p>
            )}
            {qa?.map((q) => (
              <div key={q.seq} className="rounded bg-neutral-950 p-2">
                {q.error && <p className="text-red-300">{q.error.message}</p>}
                <ul className="flex flex-col gap-0.5">
                  {q.result?.checks?.map((c) => (
                    <li key={c.id} title={c.rule} className="flex gap-2">
                      <span className={c.status === 'fail' ? 'text-red-400' : 'text-emerald-400'}>
                        {c.status === 'fail' ? 'FAIL' : c.status.toUpperCase()}
                      </span>
                      <span>{c.id}</span>
                      <span className="text-neutral-400">{checkNumbers(c)}</span>
                    </li>
                  ))}
                </ul>
                {projectFileUrl(project.id, q.result?.png) && (
                  <img
                    alt="Audio check chart"
                    className="mt-1 w-full rounded"
                    src={projectFileUrl(project.id, q.result?.png)!}
                  />
                )}
                <div className="mt-1 flex flex-wrap gap-1">
                  {q.result?.listen?.map((l) => (
                    <button
                      key={`${l.atMs}-${l.kind}`}
                      type="button"
                      className={sel}
                      title={l.listenFor}
                      onClick={() => {
                        if (q.seq !== editor.getState().sequenceId)
                          editor.getState().setSequence(q.seq);
                        editor.getState().setPlayhead(l.atMs);
                      }}
                    >
                      Listen {(l.atMs / 1000).toFixed(2)} s
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}
        {live.length > 0 && (
          <ul aria-label="Export progress" className="flex flex-col gap-1">
            {live.map((r) => (
              <li key={r.id} className="rounded bg-neutral-950 p-1.5">
                <div className="flex items-center gap-2">
                  <span className="flex-1">{r.label}</span>
                  <span className={r.status === 'failed' ? 'text-red-400' : 'text-neutral-400'}>
                    {r.status === 'running' ? `${Math.round(r.progress * 100)} %` : r.status}
                  </span>
                </div>
                {r.error && (
                  <p className="text-red-300">
                    {r.error.message} {r.error.hint}
                  </p>
                )}
                {writtenPaths(r).map((p) => (
                  <div key={p} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-neutral-400">
                      {p.split('/').pop()}
                    </span>
                    <button
                      type="button"
                      className={sel}
                      onClick={() =>
                        void vox.exports.reveal(p).catch((e: unknown) => editor.getState().toast(e))
                      }
                    >
                      Show in Finder
                    </button>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={sel}
            onClick={() => ui.getState().set({ exportOpen: false })}
          >
            Done
          </button>
          <button
            type="button"
            className="rounded bg-indigo-600 px-3 py-1 font-medium text-white disabled:opacity-50"
            disabled={busy !== null || chosen.length === 0 || !effective}
            onClick={() => void exportNow()}
          >
            {busy === 'export'
              ? 'Exporting…'
              : `Export ${fileCount} file${fileCount === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The dialog's rows (by job id), kept current from the jobs store. */
function useJobRows(ids: string[]): JobRow[] {
  const { jobs } = useCtx();
  const [, force] = useState(0);
  useEffect(() => jobs.subscribe(() => force((n) => n + 1)), [jobs]);
  const all = jobs.getState().rows;
  return ids.map((id) => all.find((x) => x.id === id)).filter((r): r is JobRow => r !== undefined);
}
