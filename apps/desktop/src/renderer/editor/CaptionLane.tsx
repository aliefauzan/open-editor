// Caption lane (app spec "Timeline"; D-15): the chunks of the sequence's captions with their words,
// emphasis words marked. Double-click a word to edit it; the word menu sets "break here"
// (`breakAfter`) or toggles emphasis. Every edit is one `setCaptions` override (one undo entry).
import { useState } from 'react';
import type { CaptionChunk, CaptionWord } from '../../shared/project.ts';
import { useCtx, useEditor } from './context.tsx';

function override(seqId: string, patch: { wordKey: string; [k: string]: unknown }) {
  return { op: 'setCaptions', args: { sequenceId: seqId, overrides: [patch] } };
}

export function Word(props: { w: CaptionWord; seqId: string; breakAfter: boolean }) {
  const { editor } = useCtx();
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [text, setText] = useState(props.w.text);
  const apply = (patch: Record<string, unknown>) =>
    void editor.getState().apply(override(props.seqId, { wordKey: props.w.key, ...patch }));
  if (editing) {
    return (
      <input
        aria-label={`Edit word ${props.w.text}`}
        autoFocus
        className="w-20 rounded bg-white px-0.5 text-[11px] text-black"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            setEditing(false);
            const t = text.trim();
            if (t && t !== props.w.text) apply({ text: t });
          } else if (e.key === 'Escape') {
            setEditing(false);
            setText(props.w.text);
          }
        }}
        onBlur={() => {
          setEditing(false);
          setText(props.w.text);
        }}
      />
    );
  }
  return (
    <span className="relative">
      <button
        type="button"
        data-word-key={props.w.key}
        title="Double-click to edit; right-click for more"
        className={`rounded px-0.5 hover:bg-white/20 ${
          props.w.emphasis ? 'font-bold text-amber-300 underline' : ''
        }`}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setText(props.w.text);
          setEditing(true);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {props.w.text}
      </button>
      {props.breakAfter && (
        <span aria-label="Line break after" className="text-sky-300">
          ⏎
        </span>
      )}
      {menu && (
        <span
          role="menu"
          style={{ left: menu.x, top: menu.y - 56 }}
          className="fixed z-50 flex flex-col rounded border border-neutral-600 bg-neutral-900 text-[11px] whitespace-nowrap shadow-lg"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseLeave={() => setMenu(null)}
        >
          <button
            type="button"
            role="menuitem"
            className="px-2 py-1 text-left hover:bg-neutral-700"
            onClick={() => {
              setMenu(null);
              apply({ breakAfter: !props.breakAfter });
            }}
          >
            {props.breakAfter ? 'Remove break' : 'Break here'}
          </button>
          <button
            type="button"
            role="menuitem"
            className="px-2 py-1 text-left hover:bg-neutral-700"
            onClick={() => {
              setMenu(null);
              apply({ emphasis: !props.w.emphasis });
            }}
          >
            {props.w.emphasis ? 'Clear emphasis' : 'Emphasis'}
          </button>
        </span>
      )}
    </span>
  );
}

export function CaptionLane(props: { chunk: CaptionChunk | undefined }) {
  const seqId = useEditor((s) => s.sequenceId);
  const breaks = useEditor((s) => {
    const seq = s.project?.sequences.find((q) => q.id === s.sequenceId);
    return seq?.captions?.overrides;
  });
  if (!props.chunk || !seqId) return null;
  const broken = new Set((breaks ?? []).filter((o) => o.breakAfter).map((o) => o.wordKey));
  return (
    <div
      data-testid="caption-chunk"
      className="absolute inset-0 flex items-center gap-0.5 overflow-hidden rounded border border-yellow-700/60 bg-yellow-900/50 px-1 text-[11px] text-yellow-50"
    >
      {props.chunk.lines
        .flatMap((l) => l.words)
        .map((w) => (
          <Word key={w.key} w={w} seqId={seqId} breakAfter={broken.has(w.key)} />
        ))}
    </div>
  );
}
