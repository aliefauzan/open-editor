import { useEffect, useMemo, useState } from 'react';
import type { SetupProgressData } from '../shared/api.ts';
import { createEditorContext, EditorProvider } from './editor/context.tsx';
import { Editor } from './editor/Editor.tsx';
import { SetupNotices, SetupScreen } from './Setup.tsx';
import { useSetup } from './setup-store.ts';
import { useShell } from './store.ts';
import { useStore } from 'zustand';

function Projects(props: { onOpen: (id: string) => void }) {
  const s = useShell();
  const [name, setName] = useState('');
  return (
    <main className="mx-auto flex h-full w-full max-w-xl flex-col gap-4 overflow-y-auto p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Projects</h1>
        <button
          type="button"
          data-testid="open-setup"
          className="text-xs text-neutral-400 underline"
          onClick={() => useSetup.getState().show(true)}
        >
          Setup
        </button>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void s.createProject(name.trim()).then(() => setName(''));
        }}
      >
        <input
          aria-label="New project name"
          className="min-w-0 flex-1 rounded bg-neutral-900 px-2 py-1 text-sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New project"
        />
        <button type="submit" className="rounded bg-neutral-800 px-3 py-1 text-sm">
          Create
        </button>
      </form>
      <ul className="space-y-1" data-testid="projects">
        {s.projects.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              data-project-id={p.id}
              className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-800"
              onClick={() => props.onOpen(p.id)}
            >
              {p.name}
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

export function App() {
  const s = useShell();
  const ctx = useMemo(() => createEditorContext(window.vox), []);
  const openId = useStore(ctx.editor, (x) => x.projectId);
  useEffect(() => {
    // once on mount; store actions come from getState() so the effect has no dependencies
    void useShell.getState().loadProjects();
    void useSetup.getState().refresh();
    const offs = [
      window.vox.on('host.restarted', () => {
        void useShell.getState().hostRestarted();
        void ctx.editor.getState().reload();
      }),
      window.vox.on('setup.progress', (e) =>
        useSetup.getState().onProgress(e as SetupProgressData),
      ),
    ];
    return () => offs.forEach((off) => off());
  }, [ctx]);
  const setupOpen = useSetup((x) => x.open);
  if (setupOpen) return <SetupScreen />;
  return (
    <div className="flex h-full flex-col">
      {s.banner && (
        <div
          role="status"
          data-testid="banner"
          className="flex items-center justify-between bg-amber-500 px-4 py-2 text-sm text-black"
        >
          <span>{s.banner}</span>
          <button type="button" onClick={s.dismissBanner} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {s.error && (
        <div role="alert" className="bg-red-900 px-4 py-2 text-sm">
          {s.error.message} {s.error.hint && <span className="opacity-70">({s.error.hint})</span>}
        </div>
      )}
      <SetupNotices />
      <div className="min-h-0 flex-1">
        <EditorProvider value={ctx}>
          {openId ? (
            <Editor
              onClose={() => {
                ctx.editor.getState().close();
                void useShell.getState().loadProjects();
              }}
              onOpenSetup={() => useSetup.getState().show(true)}
            />
          ) : (
            <Projects onOpen={(id) => void ctx.editor.getState().open(id)} />
          )}
        </EditorProvider>
      </div>
    </div>
  );
}
