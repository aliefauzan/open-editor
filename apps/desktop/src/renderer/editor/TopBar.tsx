// Top bar (app spec "Main editor" → Top bar): project name, the step bar (Upload footage · Describe
// edit · Review cut · Export) that highlights the current stage and jumps to its panel, undo/redo,
// snapshots menu (save / restore), settings (the Settings dialog, phase 13) and Export (the dialog, 10b).
import { useEffect, useState } from 'react';
import { useCtx, useEditor, useUi } from './context.tsx';
import { ExportDialog } from './ExportDialog.tsx';
import type { Stage } from './ui-store.ts';

export const STEPS: { id: Stage; label: string }[] = [
  { id: 'upload', label: 'Upload footage' },
  { id: 'describe', label: 'Describe edit' },
  { id: 'review', label: 'Review cut' },
  { id: 'export', label: 'Export' },
];

interface Snap {
  name: string;
  createdAt?: string;
}

function SnapshotsMenu(props: { onClose: () => void }) {
  const { vox, editor } = useCtx();
  const projectId = useEditor((s) => s.projectId);
  const [list, setList] = useState<Snap[]>([]);
  const [name, setName] = useState('');
  const load = () => {
    if (projectId)
      vox.snapshots
        .list(projectId)
        .then((l) => setList(l as Snap[]))
        .catch((e: unknown) => editor.getState().toast(e));
  };
  useEffect(load, [projectId]);
  return (
    <div
      role="dialog"
      aria-label="Snapshots"
      className="absolute top-10 right-0 z-30 w-72 rounded border border-neutral-700 bg-neutral-900 p-3 shadow-xl"
    >
      <form
        className="mb-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (!projectId || !n) return;
          vox.snapshots
            .create(projectId, n)
            .then(() => {
              setName('');
              load();
            })
            .catch((err: unknown) => editor.getState().toast(err));
        }}
      >
        <input
          aria-label="Snapshot name"
          className="min-w-0 flex-1 rounded bg-neutral-800 px-2 py-1 text-xs"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          autoFocus
        />
        <button type="submit" className="rounded bg-neutral-700 px-2 text-xs">
          Save
        </button>
      </form>
      <ul className="max-h-60 space-y-1 overflow-y-auto" aria-label="Saved snapshots">
        {list.length === 0 && <li className="text-xs text-neutral-500">No snapshots yet.</li>}
        {list.map((s) => (
          <li key={s.name} className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate">{s.name}</span>
            <button
              type="button"
              className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700"
              onClick={() => {
                void editor.getState().apply({ op: 'restoreSnapshot', args: { name: s.name } });
                props.onClose();
              }}
            >
              Restore
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="mt-2 text-xs text-neutral-400 underline"
        onClick={props.onClose}
      >
        Close
      </button>
    </div>
  );
}

export function TopBar(props: { onClose?: () => void; onOpenSetup?: () => void }) {
  const { ui, run } = useCtx();
  const name = useEditor((s) => s.project?.name ?? '');
  const pending = useEditor((s) => s.pending.length);
  const stage = useUi((s) => s.stage);
  const snapshotsOpen = useUi((s) => s.snapshotsOpen);
  const exportOpen = useUi((s) => s.exportOpen);
  const btn = 'rounded px-2 py-1 text-xs bg-neutral-800 hover:bg-neutral-700';
  const jump = (id: Stage) => {
    // each step opens the panel that belongs to it
    const panel: Partial<Record<Stage, Partial<ReturnType<typeof ui.getState>>>> = {
      upload: { leftTab: 'media' },
      describe: {},
      review: { leftTab: 'styles' },
      export: { exportOpen: true },
    };
    ui.getState().set({ stage: id, ...panel[id] });
    const target = {
      upload: 'media-panel',
      describe: 'agent-panel',
      review: 'timeline',
      export: null,
    }[id];
    if (target) document.getElementById(target)?.focus();
  };
  return (
    <header className="relative flex h-11 shrink-0 items-center gap-3 border-b border-neutral-800 bg-neutral-900 px-3">
      {props.onClose && (
        <button type="button" className={btn} onClick={props.onClose} aria-label="All projects">
          ‹ Projects
        </button>
      )}
      <h1 className="max-w-56 truncate text-sm font-semibold" data-testid="project-name">
        {name}
      </h1>
      <nav aria-label="Steps" className="flex flex-1 items-center justify-center gap-1">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            type="button"
            aria-current={stage === s.id ? 'step' : undefined}
            onClick={() => jump(s.id)}
            className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs ${
              stage === s.id ? 'bg-indigo-600 text-white' : 'text-neutral-400 hover:bg-neutral-800'
            }`}
          >
            <span className="tabular-nums opacity-70">{i + 1}</span> {s.label}
          </button>
        ))}
      </nav>
      {pending > 0 && (
        <span className="text-xs text-neutral-500" role="status">
          Saving…
        </span>
      )}
      <button type="button" className={btn} onClick={() => run('undo')} title="Undo (⌘Z)">
        Undo
      </button>
      <button type="button" className={btn} onClick={() => run('redo')} title="Redo (⇧⌘Z)">
        Redo
      </button>
      <button
        type="button"
        className={btn}
        aria-expanded={snapshotsOpen}
        onClick={() => ui.getState().set({ snapshotsOpen: !snapshotsOpen })}
      >
        Snapshots
      </button>
      <button type="button" className={btn} onClick={() => run('settings')}>
        Settings
      </button>
      <button
        type="button"
        className="rounded bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-500"
        onClick={() => run('export')}
      >
        Export
      </button>
      {snapshotsOpen && (
        <SnapshotsMenu onClose={() => ui.getState().set({ snapshotsOpen: false })} />
      )}
      {exportOpen && <ExportDialog />}
    </header>
  );
}
