// Sequence tabs (app spec "Timeline"): one tab per sequence, "+" to add or duplicate, and the
// sequence's canvas, style, overlay and sound-effect settings.
import { useState } from 'react';
import { agentScope } from './agent-store.ts';
import { useAgent, useCtx, useEditor } from './context.tsx';
import { seqOf } from './editing.ts';
import { useResolvedStyle, useStyleList } from './use-styles.ts';

/** A stable empty list for selectors (a new [] each time would re-render forever). */
const NONE: never[] = [];

const CANVASES = [
  { label: '9:16 · 1080×1920', width: 1080, height: 1920 },
  { label: '16:9 · 1920×1080', width: 1920, height: 1080 },
  { label: '1:1 · 1080×1080', width: 1080, height: 1080 },
  { label: '4:5 · 1080×1350', width: 1080, height: 1350 },
];

function SequenceSettings(props: { onClose: () => void }) {
  const { editor } = useCtx();
  const s = useEditor((x) => seqOf(x.project, x.sequenceId));
  const styles = useStyleList();
  const style = useResolvedStyle(s?.styleId);
  if (!s) return null;
  const apply = (args: Record<string, unknown>) =>
    void editor.getState().apply({ op: 'updateSequence', args: { sequenceId: s.id, ...args } });
  const overlays = new Set(
    s.overlays ?? style?.overlays.filter((o) => o.default).map((o) => o.name) ?? [],
  );
  return (
    <div
      role="dialog"
      aria-label="Sequence settings"
      className="absolute top-8 left-2 z-40 w-72 space-y-2 rounded border border-neutral-700 bg-neutral-900 p-3 text-xs shadow-xl"
    >
      <label className="flex items-center justify-between gap-2">
        Name
        <input
          className="w-40 rounded bg-neutral-800 px-1 py-0.5"
          defaultValue={s.name}
          onBlur={(e) =>
            e.target.value.trim() &&
            e.target.value !== s.name &&
            apply({ name: e.target.value.trim() })
          }
        />
      </label>
      <label className="flex items-center justify-between gap-2">
        Canvas
        <select
          className="w-40 rounded bg-neutral-800 px-1 py-0.5"
          value={`${s.canvas.width}x${s.canvas.height}`}
          onChange={(e) => {
            const [w, h] = e.target.value.split('x').map(Number);
            apply({ canvas: { width: w, height: h } });
          }}
        >
          {CANVASES.map((c) => (
            <option key={c.label} value={`${c.width}x${c.height}`}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between gap-2">
        Style
        <select
          className="w-40 rounded bg-neutral-800 px-1 py-0.5"
          value={s.styleId}
          onChange={(e) => apply({ styleId: e.target.value })}
        >
          {styles.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="space-y-1">
        <legend className="text-neutral-400">Overlays</legend>
        {(style?.overlays ?? []).length === 0 && (
          <p className="text-neutral-500">This style has no overlays.</p>
        )}
        {(style?.overlays ?? []).map((o) => (
          <label key={o.name} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={overlays.has(o.name)}
              onChange={() => {
                const next = new Set(overlays);
                if (next.has(o.name)) next.delete(o.name);
                else next.add(o.name);
                apply({ overlays: [...next] });
              }}
            />
            {o.name}
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={s.sfx} onChange={() => apply({ sfx: !s.sfx })} />
        Sound effects
      </label>
      <button type="button" className="rounded bg-neutral-800 px-2 py-0.5" onClick={props.onClose}>
        Close
      </button>
    </div>
  );
}

export function SequenceTabs() {
  const { editor } = useCtx();
  const sequences = useEditor((x) => x.project?.sequences ?? NONE);
  const current = useEditor((x) => x.sequenceId);
  // the "agent editing" marker (D-15): sequences in an active run's latest step scope (a string,
  // so the selector result is stable between renders)
  const editing = useAgent((x) => [...agentScope(x)].sort().join(' '));
  const marked = new Set(editing ? editing.split(' ') : []);
  const [menu, setMenu] = useState(false);
  const [settings, setSettings] = useState(false);
  return (
    <div className="relative flex h-8 shrink-0 items-center gap-1 border-b border-neutral-800 px-2">
      <div
        role="tablist"
        aria-label="Sequences"
        className="flex min-w-0 items-center gap-1 overflow-x-auto"
      >
        {sequences.map((q) => (
          <button
            key={q.id}
            type="button"
            role="tab"
            aria-selected={q.id === current}
            onClick={() => editor.getState().setSequence(q.id)}
            className={`rounded-t px-3 py-1 text-xs whitespace-nowrap ${
              q.id === current
                ? 'bg-neutral-800 text-white'
                : 'text-neutral-400 hover:bg-neutral-800/60'
            }`}
          >
            {q.name}
            {marked.has(q.id) && (
              <span
                className="ml-1.5 rounded bg-indigo-700 px-1 text-[10px] text-white"
                data-testid="agent-editing"
                title="The agent is editing this sequence; you can still edit it"
              >
                agent editing
              </span>
            )}
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-label="New or duplicate sequence"
        aria-expanded={menu}
        className="rounded px-2 text-sm hover:bg-neutral-800"
        onClick={() => setMenu(!menu)}
      >
        +
      </button>
      {current && (
        <button
          type="button"
          aria-expanded={settings}
          className="rounded px-2 text-xs text-neutral-400 hover:bg-neutral-800"
          onClick={() => setSettings(!settings)}
        >
          Sequence settings
        </button>
      )}
      {menu && (
        <div
          role="menu"
          className="absolute top-8 left-2 z-40 flex flex-col rounded border border-neutral-700 bg-neutral-900 text-xs shadow-xl"
        >
          <button
            type="button"
            role="menuitem"
            className="px-3 py-1.5 text-left hover:bg-neutral-800"
            onClick={() => {
              setMenu(false);
              void editor
                .getState()
                .apply({ op: 'addSequence', args: { name: `Sequence ${sequences.length + 1}` } });
            }}
          >
            New sequence
          </button>
          {current && (
            <button
              type="button"
              role="menuitem"
              className="px-3 py-1.5 text-left hover:bg-neutral-800"
              onClick={() => {
                setMenu(false);
                void editor
                  .getState()
                  .apply({ op: 'duplicateSequence', args: { sequenceId: current } });
              }}
            >
              Duplicate this sequence
            </button>
          )}
        </div>
      )}
      {settings && <SequenceSettings onClose={() => setSettings(false)} />}
    </div>
  );
}
