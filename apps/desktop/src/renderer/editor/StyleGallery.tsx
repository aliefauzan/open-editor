// Style gallery (app spec "Style gallery", without Part C): installed styles with animated previews and
// status badges; the detail view lists templates and transitions (fixture previews over
// `vox-media://styles/…`), overlays and caption presets; "Set as style for this sequence" is one
// `updateSequence` op.
import { useState } from 'react';
import type { ResolvedStyleData, StyleSummaryData } from '../../shared/project.ts';
import { useCtx, useEditor, useUi } from './context.tsx';
import { previewUrl, templateColor, useResolvedStyle, useStyleList } from './use-styles.ts';

/** The style's card image: its contact sheet, else its first preview file. */
export function coverUrl(s: StyleSummaryData): string | null {
  const files = (s.previews ?? []).map((p) => p.split('/').pop() ?? p);
  const pick =
    files.find((f) => f === 'contact.jpg') ?? files.find((f) => /\.(gif|jpg|png)$/.test(f));
  return pick
    ? `vox-media://styles/${encodeURIComponent(s.id)}/previews/${encodeURIComponent(pick)}`
    : null;
}

function Preview(props: { id: string; name: string }) {
  const [gif, setGif] = useState(true);
  return (
    <figure className="overflow-hidden rounded border border-neutral-700 bg-neutral-800">
      <div className="aspect-[9/16] max-h-40" style={{ background: templateColor(props.id) }}>
        <img
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          src={previewUrl(props.id, gif ? 'gif' : 'jpg')}
          onError={(e) => {
            if (gif) setGif(false);
            else (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
      </div>
      <figcaption className="truncate px-1.5 py-1 text-[11px]">{props.name}</figcaption>
    </figure>
  );
}

function Detail(props: { id: string; onBack(): void }) {
  const { editor } = useCtx();
  const style: ResolvedStyleData | null = useResolvedStyle(props.id);
  const sequenceId = useEditor((s) => s.sequenceId);
  const current = useEditor(
    (s) => s.project?.sequences.find((q) => q.id === s.sequenceId)?.styleId,
  );
  if (!style) return <p className="p-4 text-xs text-neutral-400">Loading…</p>;
  const templates = Object.values(style.templates);
  const group = (kind: 'scene' | 'transition') => templates.filter((t) => t.kind === kind);
  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="style-detail">
      <div className="flex items-center gap-2">
        <button type="button" className="rounded bg-neutral-800 px-2 py-0.5" onClick={props.onBack}>
          ‹ All styles
        </button>
        <h3 className="text-sm font-semibold">{style.style.name}</h3>
        <span className="text-neutral-400">({style.chain.join(' → ')})</span>
        <button
          type="button"
          className="ml-auto rounded bg-indigo-600 px-2 py-1 text-white disabled:opacity-50"
          disabled={!sequenceId || current === style.id}
          onClick={() =>
            sequenceId &&
            void editor
              .getState()
              .apply({ op: 'updateSequence', args: { sequenceId, styleId: style.id } })
          }
        >
          {current === style.id ? 'Style of this sequence' : 'Set as style for this sequence'}
        </button>
      </div>
      {(['scene', 'transition'] as const).map((k) => (
        <section key={k} aria-label={k === 'scene' ? 'Templates' : 'Transitions'}>
          <h4 className="mb-1 font-semibold text-neutral-400 uppercase">
            {k === 'scene' ? 'Templates' : 'Transitions'}
          </h4>
          <div className="grid grid-cols-4 gap-2">
            {group(k).map((t) => (
              <Preview key={t.id} id={t.id} name={t.name} />
            ))}
          </div>
        </section>
      ))}
      <section aria-label="Overlays">
        <h4 className="mb-1 font-semibold text-neutral-400 uppercase">Overlays</h4>
        <p>
          {style.overlays
            .map((o) => `${o.name}${o.default ? ' (on by default)' : ''}`)
            .join(', ') || 'None'}
        </p>
      </section>
      <section aria-label="Caption presets">
        <h4 className="mb-1 font-semibold text-neutral-400 uppercase">Caption presets</h4>
        <p>
          {Object.values(style.captionPresets)
            .map((c) => c.name ?? c.id)
            .join(', ') || 'None'}
        </p>
      </section>
    </div>
  );
}

export function StyleGallery() {
  const { ui } = useCtx();
  const open = useUi((s) => s.galleryOpen);
  const list = useStyleList();
  const [detail, setDetail] = useState<string | null>(null);
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-label="Style gallery"
      aria-modal
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
    >
      <div className="flex max-h-[90vh] w-[760px] flex-col gap-3 overflow-y-auto rounded-lg bg-neutral-900 p-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Styles</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={() => ui.getState().set({ galleryOpen: false })}
          >
            ×
          </button>
        </div>
        {detail ? (
          <Detail id={detail} onBack={() => setDetail(null)} />
        ) : (
          <ul className="grid grid-cols-3 gap-3" aria-label="Installed styles">
            {list.map((s) => {
              const cover = coverUrl(s);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className="w-full overflow-hidden rounded border border-neutral-700 bg-neutral-800 text-left hover:border-indigo-500"
                    onClick={() => setDetail(s.id)}
                  >
                    <div
                      className="aspect-video bg-neutral-950"
                      style={{ background: templateColor(s.id) }}
                    >
                      {cover && <img alt="" className="h-full w-full object-cover" src={cover} />}
                    </div>
                    <div className="flex items-center gap-2 p-2 text-xs">
                      <span className="flex-1 truncate font-medium">{s.name}</span>
                      {s.status && (
                        <span
                          data-testid={`status-${s.id}`}
                          className="rounded bg-neutral-700 px-1.5 text-[10px] uppercase"
                        >
                          {s.status}
                        </span>
                      )}
                    </div>
                    {s.description && (
                      <p className="line-clamp-2 px-2 pb-2 text-[11px] text-neutral-400">
                        {s.description}
                      </p>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
