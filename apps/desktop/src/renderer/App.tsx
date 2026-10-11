import { useEffect, useMemo } from 'react';
import type { SetupProgressData } from '../shared/api.ts';
import { createEditorContext, EditorProvider } from './editor/context.tsx';
import { Editor } from './editor/Editor.tsx';
import { fewerNote } from './editor/quick-flow.ts';
import { QuickStart } from './editor/QuickStart.tsx';
import { SettingsDialog } from './Settings.tsx';
import { SetupNotices, SetupScreen } from './Setup.tsx';
import { useSetup } from './setup-store.ts';
import { useShell } from './store.ts';
import { useStore } from 'zustand';

export function App() {
  const s = useShell();
  const ctx = useMemo(() => createEditorContext(window.vox), []);
  const openId = useStore(ctx.editor, (x) => x.projectId);
  const openError = useStore(ctx.editor, (x) => x.openError);
  const settingsOpen = useStore(ctx.ui, (x) => x.settingsOpen);
  const settingsFocus = useStore(ctx.ui, (x) => x.settingsFocus);
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
                // the next-steps bar belongs to the quick-clips project that was open
                ctx.ui.getState().set({ nextSteps: false, quickNote: null, exportOpen: false });
                void useShell.getState().loadProjects();
              }}
              onOpenSetup={() => useSetup.getState().show(true)}
            />
          ) : (
            <>
              {openError?.code === 'SCHEMA_TOO_NEW' && (
                <div
                  role="alert"
                  data-testid="schema-too-new"
                  className="bg-red-900 px-4 py-2 text-sm"
                >
                  This project was made with a newer version of Vox Studio. Update the app to open
                  it.
                </div>
              )}
              <QuickStart
                projects={s.projects}
                onOpen={(id) => void ctx.editor.getState().open(id)}
                onCreate={(name) => void s.createProject(name)}
                onOpenSetup={() => useSetup.getState().show(true)}
                onDone={(o) => {
                  void ctx.editor
                    .getState()
                    .open(o.projectId)
                    .then(() => {
                      if (o.sequenceIds[0]) ctx.editor.getState().setSequence(o.sequenceIds[0]);
                      ctx.ui.getState().set({ nextSteps: true, quickNote: fewerNote(o) });
                    });
                }}
              />
            </>
          )}
          {settingsOpen && (
            <SettingsDialog
              focus={settingsFocus}
              onClose={() => ctx.ui.getState().set({ settingsOpen: false, settingsFocus: null })}
            />
          )}
        </EditorProvider>
      </div>
    </div>
  );
}
