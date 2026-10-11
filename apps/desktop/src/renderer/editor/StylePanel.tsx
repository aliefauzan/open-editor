// Style panel (app spec "Main editor" → Style panel): the sequence style's templates, transitions,
// overlays and caption presets plus those of `base`, each with its fixture preview; items drag onto
// the timeline (templates as scene clips, transitions onto a cut, overlays and caption presets onto
// the sequence) or are added at the playhead with their button.
import type { DragEvent } from 'react';
import type { ResolvedStyleData, TemplateData } from '../../shared/project.ts';
import { useCtx, useEditor } from './context.tsx';
import { seqOf } from './editing.ts';
import { starterValue } from './SchemaForm.tsx';
import { dropOp, DRAG_TEMPLATE } from './Timeline.tsx';
import { previewUrl, templateColor, useResolvedStyle } from './use-styles.ts';

interface Entry {
  kind: 'scene' | 'transition' | 'overlay' | 'captionPreset';
  id: string;
  name: string;
  styleId: string;
  durationMs?: number;
  preview?: string;
  /** Starter variables of a scene template. */
  variables?: Record<string, unknown>;
}

/** The entries of the sequence style and of `base`, without duplicates. */
export function styleEntries(...styles: (ResolvedStyleData | null)[]): Entry[] {
  const out = new Map<string, Entry>();
  for (const st of styles) {
    if (!st) continue;
    for (const t of Object.values(st.templates) as TemplateData[]) {
      out.set(`${t.kind}:${t.id}`, {
        kind: t.kind,
        id: t.id,
        name: t.name,
        styleId: t.styleId,
        durationMs: t.durationMs.default,
        preview: previewUrl(t.id),
        ...(t.kind === 'scene'
          ? { variables: starterValue(t.variables) as Record<string, unknown> }
          : {}),
      });
    }
    for (const o of st.overlays)
      out.set(`overlay:${o.name}`, {
        kind: 'overlay',
        id: o.name,
        name: o.name,
        styleId: o.styleId,
      });
    for (const p of Object.values(st.captionPresets))
      out.set(`captionPreset:${p.id}`, {
        kind: 'captionPreset',
        id: p.id,
        name: p.name ?? p.id.slice(p.id.indexOf('/') + 1),
        styleId: p.styleId,
      });
  }
  return [...out.values()];
}

const GROUPS: { kind: Entry['kind']; title: string }[] = [
  { kind: 'scene', title: 'Templates' },
  { kind: 'transition', title: 'Transitions' },
  { kind: 'overlay', title: 'Overlays' },
  { kind: 'captionPreset', title: 'Caption presets' },
];

export function StylePanel() {
  const { editor } = useCtx();
  const s = useEditor((x) => seqOf(x.project, x.sequenceId));
  const own = useResolvedStyle(s?.styleId);
  const base = useResolvedStyle(s && s.styleId !== 'base' ? 'base' : undefined);
  const entries = styleEntries(own, base);
  const add = (e: Entry) => {
    const st = editor.getState();
    const seq = seqOf(st.project, st.sequenceId);
    if (!seq) return;
    const call = dropOp(seq, e, st.playheadMs, null);
    if (call) void st.apply(call);
  };
  if (!s) return <p className="p-3 text-xs text-neutral-500">Open a sequence to see its style.</p>;
  return (
    <div className="h-full space-y-3 overflow-y-auto p-2" data-testid="style-panel">
      <p className="text-[11px] text-neutral-400">
        Style: <span className="text-neutral-200">{own?.style.name ?? s.styleId}</span> · drag onto
        the timeline
      </p>
      {GROUPS.map((g) => {
        const list = entries.filter((x) => x.kind === g.kind);
        if (list.length === 0) return null;
        return (
          <section key={g.kind} aria-label={g.title}>
            <h3 className="mb-1 text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">
              {g.title}
            </h3>
            <ul className="grid grid-cols-2 gap-2">
              {list.map((e) => (
                <li
                  key={`${e.kind}:${e.id}`}
                  draggable
                  onDragStart={(ev: DragEvent) => {
                    ev.dataTransfer.setData(DRAG_TEMPLATE, JSON.stringify(e));
                    ev.dataTransfer.effectAllowed = 'copy';
                  }}
                  className="group overflow-hidden rounded border border-neutral-700 bg-neutral-800"
                  title={`${e.name} (${e.id})`}
                >
                  <div
                    className="relative aspect-[9/16] max-h-24 w-full"
                    style={{ background: templateColor(e.id) }}
                  >
                    {e.preview && (
                      <img
                        src={e.preview}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                        onError={(ev) => ((ev.target as HTMLImageElement).style.display = 'none')}
                      />
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-1 px-1.5 py-1">
                    <span className="truncate text-[11px]">{e.name}</span>
                    <button
                      type="button"
                      aria-label={`Add ${e.name}`}
                      className="rounded bg-neutral-700 px-1 text-[11px] hover:bg-indigo-600"
                      onClick={() => add(e)}
                    >
                      +
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
