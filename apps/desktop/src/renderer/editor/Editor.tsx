// The main editor (app spec "Main editor (matches the reference layout)"): top bar; agent panel left,
// preview top centre, inspector right (collapsible); style panel (beside the media bin, 10b) bottom
// left, timeline bottom. Toasts show each failed call's hint.
import { useCtx, useEditor, useUi } from './context.tsx';
import { AgentPanel } from './AgentPanel.tsx';
import { Inspector } from './Inspector.tsx';
import { JobsPanel } from './JobsPanel.tsx';
import { useKeyboard } from './keyboard.ts';
import { NextSteps } from './NextSteps.tsx';
import { PreviewPanel } from './PreviewPanel.tsx';
import { MediaBin } from './MediaBin.tsx';
import { StyleGallery } from './StyleGallery.tsx';
import { StylePanel } from './StylePanel.tsx';
import { SubtitlesPanel } from './SubtitlesPanel.tsx';
import { Timeline } from './Timeline.tsx';
import { TopBar } from './TopBar.tsx';

function Toasts() {
  const { editor } = useCtx();
  const toasts = useEditor((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="fixed right-4 bottom-4 z-50 flex w-96 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="alert"
          className="rounded border border-red-800 bg-red-950 p-3 text-xs shadow-xl"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="font-medium">{t.message}</p>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => editor.getState().dismissToast(t.id)}
            >
              ×
            </button>
          </div>
          {t.hint && <p className="mt-1 text-neutral-300">{t.hint}</p>}
          <details className="mt-1 text-neutral-500">
            <summary>Details</summary>
            <code>{t.code}</code>
          </details>
        </div>
      ))}
    </div>
  );
}

function LeftTabs() {
  const { ui } = useCtx();
  const tab = useUi((s) => s.leftTab);
  const b = (on: boolean) =>
    `px-3 py-1.5 text-xs ${on ? 'border-b-2 border-indigo-500 text-white' : 'text-neutral-400 hover:text-neutral-200'}`;
  return (
    <section
      id="media-panel"
      tabIndex={-1}
      aria-label="Media and styles"
      className="flex h-full min-h-0 flex-col bg-neutral-900"
    >
      <div role="tablist" className="flex border-b border-neutral-800">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'media'}
          className={b(tab === 'media')}
          onClick={() => ui.getState().set({ leftTab: 'media' })}
        >
          Media
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'subtitles'}
          className={b(tab === 'subtitles')}
          onClick={() => ui.getState().set({ leftTab: 'subtitles' })}
        >
          Subtitles
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'styles'}
          className={b(tab === 'styles')}
          onClick={() => ui.getState().set({ leftTab: 'styles' })}
        >
          Styles
        </button>
      </div>
      <div role="tabpanel" className="min-h-0 flex-1">
        {tab === 'styles' ? (
          <StylePanel />
        ) : tab === 'subtitles' ? (
          <SubtitlesPanel />
        ) : (
          <MediaBin />
        )}
      </div>
    </section>
  );
}

export function Editor(props: { onClose?: () => void; onOpenSetup?: () => void }) {
  useKeyboard();
  const { ui } = useCtx();
  const inspectorOpen = useUi((s) => s.inspectorOpen);
  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100" data-testid="editor">
      <TopBar {...props} />
      <div className="flex min-h-0 flex-[3]">
        <div className="flex w-60 shrink-0 flex-col border-r border-neutral-800">
          <div className="min-h-0 flex-1">
            <AgentPanel />
          </div>
          <JobsPanel />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <NextSteps />
          <div className="min-h-0 flex-1">
            <PreviewPanel />
          </div>
        </div>
        {inspectorOpen ? (
          <div className="relative w-80 shrink-0 border-l border-neutral-800">
            <button
              type="button"
              aria-label="Hide inspector"
              className="absolute top-2 right-2 z-10 rounded bg-neutral-800 px-1.5 text-xs"
              onClick={() => ui.getState().set({ inspectorOpen: false })}
            >
              ›
            </button>
            <Inspector />
          </div>
        ) : (
          <button
            type="button"
            aria-label="Show inspector"
            className="w-6 shrink-0 border-l border-neutral-800 bg-neutral-900 text-xs"
            onClick={() => ui.getState().set({ inspectorOpen: true })}
          >
            ‹
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-[2] border-t border-neutral-800">
        <div className="w-72 shrink-0 border-r border-neutral-800">
          <LeftTabs />
        </div>
        <div className="min-w-0 flex-1">
          <Timeline />
        </div>
      </div>
      <StyleGallery />
      <Toasts />
    </div>
  );
}
