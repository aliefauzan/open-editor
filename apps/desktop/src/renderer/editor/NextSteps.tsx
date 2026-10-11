// The bar above the preview after quick clips (app spec "Quick clips (start screen)"; plan D-11): Fix
// subtitles, Add style ("Captions only", or "Add style beats": a Stylize run with the editor model,
// phase 13), Export.
import { useState } from 'react';
import type { ResolvedStyleData, StyleSummaryData } from '../../shared/project.ts';
import { useAgent, useCtx, useEditor, useUi } from './context.tsx';
import type { OpCall } from './store.ts';

/** "Captions only": one batch of `updateSequence { styleId, overlays: [] }` + the style's preset. */
export function captionsOnlyOp(sequenceId: string, style: ResolvedStyleData): OpCall {
  const preset =
    style.style.captions?.default ?? Object.keys(style.captionPresets)[0] ?? 'base/plain';
  return {
    op: 'batch',
    args: {
      ops: [
        { op: 'updateSequence', args: { sequenceId, styleId: style.id, overlays: [] } },
        { op: 'setCaptions', args: { sequenceId, preset } },
      ],
    },
  };
}

export function NextSteps() {
  const { vox, editor, ui, agent, run } = useCtx();
  const show = useUi((s) => s.nextSteps);
  const note = useUi((s) => s.quickNote);
  const sequenceId = useEditor((s) => s.sequenceId);
  const [styles, setStyles] = useState<StyleSummaryData[] | null>(null);
  const hasModel = useAgent((s) => s.settings?.roles.editor !== undefined);
  if (!show) return null;
  /** "Add style beats": the clip takes the style, then a Stylize run adds its scenes (one run, D-11). */
  const styleBeats = async (id: string, name: string) => {
    if (!sequenceId) return;
    setStyles(null);
    try {
      const st = editor.getState();
      const seq = st.project?.sequences.find((q) => q.id === sequenceId);
      if (seq && seq.styleId !== id)
        await st.apply({ op: 'updateSequence', args: { sequenceId, styleId: id } });
      await agent.getState().send(`Add ${name} style beats to this clip`, {
        selection: [sequenceId],
        workflow: 'stylize',
      });
    } catch (e) {
      editor.getState().toast(e);
    }
  };
  const btn = 'rounded bg-neutral-800 px-2.5 py-1 text-xs hover:bg-neutral-700';
  const captionsOnly = async (id: string) => {
    if (!sequenceId) return;
    try {
      const style = (await vox.styles.get(id)) as ResolvedStyleData;
      await editor.getState().apply(captionsOnlyOp(sequenceId, style));
      setStyles(null);
    } catch (e) {
      editor.getState().toast(e);
    }
  };
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-neutral-800 bg-neutral-900 px-3 py-1.5"
      data-testid="next-steps"
    >
      <span className="text-xs text-neutral-400">Next steps:</span>
      <button
        type="button"
        className={btn}
        onClick={() => ui.getState().set({ leftTab: 'subtitles' })}
      >
        Fix subtitles
      </button>
      <div className="relative">
        <button
          type="button"
          className={btn}
          aria-expanded={styles !== null}
          onClick={() => {
            if (styles) return setStyles(null);
            void vox.styles.list().then(
              (l) => setStyles(l as StyleSummaryData[]),
              (e: unknown) => editor.getState().toast(e),
            );
          }}
        >
          Add style
        </button>
        {styles && (
          <div
            role="menu"
            aria-label="Add style"
            className="absolute top-full left-0 z-30 mt-1 w-72 rounded border border-neutral-700 bg-neutral-900 p-2 shadow-xl"
          >
            {styles.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2 py-1 text-xs">
                <span className="truncate">{s.name}</span>
                <span className="flex gap-1">
                  <button
                    type="button"
                    role="menuitem"
                    className={btn}
                    aria-label={`Captions only: ${s.name}`}
                    onClick={() => void captionsOnly(s.id)}
                  >
                    Captions only
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={`${btn} ${hasModel ? '' : 'opacity-50'}`}
                    disabled={!hasModel}
                    aria-label={`Add style beats: ${s.name}`}
                    title={
                      hasModel
                        ? 'The agent adds scenes from this style'
                        : 'needs a model — Settings'
                    }
                    onClick={() => void styleBeats(s.id, s.name)}
                  >
                    Add style beats
                  </button>
                </span>
              </div>
            ))}
            {!hasModel && (
              <p className="mt-1 text-[11px] text-neutral-400">
                &quot;Add style beats&quot; needs a model —{' '}
                <button type="button" className="underline" onClick={() => run('settings')}>
                  Settings
                </button>
                .
              </p>
            )}
          </div>
        )}
      </div>
      <button type="button" className={btn} onClick={() => ui.getState().set({ exportOpen: true })}>
        Export
      </button>
      {note && (
        <span className="text-xs text-amber-400" data-testid="quick-note">
          {note}
        </span>
      )}
      <button
        type="button"
        aria-label="Hide next steps"
        className="ml-auto text-xs text-neutral-400"
        onClick={() => ui.getState().set({ nextSteps: false })}
      >
        ×
      </button>
    </div>
  );
}
