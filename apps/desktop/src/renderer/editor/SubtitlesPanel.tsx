// Subtitles panel (tab beside the media bin; app spec "Subtitles panel"; plan D-11, D-15): every
// caption chunk with its time (click seeks), words edited in place, find and replace, nudge a word's
// start/end by frames, split / merge, hide, emphasis, reset per chunk or all, Delete word
// (`removeWords`) and "Pauses & fillers" (`removePauses` dry run → tick → apply). Each edit is one op,
// so one undo entry; the preview updates through the normal pipeline.
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type { ErrorData } from '../../shared/api.ts';
import { useCtx, useEditor } from './context.tsx';
import type { OpCall } from './store.ts';
import {
  applyPausesOp,
  breakOp,
  clock,
  findReplaceOp,
  findSeq,
  hiddenWords,
  nudgeOp,
  overrideOp,
  panelWords,
  removePausesOp,
  removeWordsOp,
  resetOp,
  userBreakAfter,
  type PanelWord,
  type PauseKind,
  type PauseRange,
} from './subtitles.ts';
import { useCaptions } from './Timeline.tsx';

const btn = 'rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] hover:bg-neutral-700 disabled:opacity-40';

function PausesAndFillers(props: { sequenceId: string; words: PanelWord[] }) {
  const { editor } = useCtx();
  const [minPauseMs, setMin] = useState(350);
  const [kinds, setKinds] = useState<Record<PauseKind, boolean>>({
    pause: true,
    filler: true,
    repeat: true,
  });
  const [found, setFound] = useState<{ version: number; ranges: PauseRange[] } | null>(null);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  const query = {
    sequenceId: props.sequenceId,
    minPauseMs,
    kinds: (Object.keys(kinds) as PauseKind[]).filter((k) => kinds[k]),
  };
  const text = useMemo(() => new Map(props.words.map((w) => [w.key, w.text])), [props.words]);

  const find = async (why?: string) => {
    if (query.kinds.length === 0) return;
    const version = editor.getState().version;
    const r = await editor.getState().applyAt(removePausesOp(query, { dryRun: true }), version);
    if (r.error) {
      editor.getState().toast(r.error);
      return;
    }
    const ranges = ((r.report as { ranges?: PauseRange[] } | undefined)?.ranges ?? []) as PauseRange[];
    setFound({ version, ranges });
    setTicked(new Set(ranges.map((_, i) => i)));
    setNote(why ?? null);
  };

  const apply = async () => {
    if (!found) return;
    const call = applyPausesOp(query, found.ranges, ticked);
    if (!call) return;
    const r = await editor.getState().applyAt(call, found.version);
    if (r.error?.code === 'STALE') {
      await find('The project changed, so the list was found again. Check it and apply.');
      return;
    }
    if (r.error) {
      editor.getState().toast(r.error);
      return;
    }
    setFound(null);
    setNote(null);
  };

  return (
    <details className="border-b border-neutral-800 p-2" data-testid="pauses-fillers">
      <summary className="cursor-pointer text-xs font-medium">Pauses &amp; fillers</summary>
      <div className="mt-2 flex flex-col gap-2 text-[11px]">
        <label className="flex items-center gap-2">
          Minimum pause
          <input
            type="range"
            aria-label="Minimum pause"
            min={350}
            max={2000}
            step={50}
            value={minPauseMs}
            onChange={(e) => setMin(Number(e.target.value))}
          />
          <span>{minPauseMs} ms</span>
        </label>
        <div className="flex gap-3">
          {(['pause', 'filler', 'repeat'] as const).map((k) => (
            <label key={k} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={kinds[k]}
                onChange={(e) => setKinds({ ...kinds, [k]: e.target.checked })}
              />
              {k === 'pause' ? 'Pauses' : k === 'filler' ? 'Fillers' : 'Repeats'}
            </label>
          ))}
        </div>
        <div className="flex gap-2">
          <button type="button" className={btn} onClick={() => void find()}>
            Find
          </button>
          <button
            type="button"
            className={btn}
            disabled={!found || ticked.size === 0}
            onClick={() => void apply()}
          >
            Apply
          </button>
        </div>
        {note && <p className="text-amber-400">{note}</p>}
        {found && (
          <ul aria-label="Found pauses and fillers" className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
            {found.ranges.length === 0 && <li className="text-neutral-400">Nothing found.</li>}
            {found.ranges.map((r, i) => (
              <li key={`${r.startMs}-${i}`} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={`Remove ${r.kind} at ${clock(r.startMs)}`}
                  checked={ticked.has(i)}
                  onChange={(e) => {
                    const next = new Set(ticked);
                    if (e.target.checked) next.add(i);
                    else next.delete(i);
                    setTicked(next);
                  }}
                />
                <button
                  type="button"
                  className="flex flex-1 gap-2 text-left hover:text-white"
                  onClick={() => editor.getState().setPlayhead(r.startMs)}
                >
                  <span className="font-mono">{clock(r.startMs)}</span>
                  <span className="text-neutral-400">{r.kind}</span>
                  <span className="truncate">
                    {r.kind === 'pause'
                      ? `${((r.endMs - r.startMs) / 1000).toFixed(2)} s`
                      : r.wordKeys.map((k) => text.get(k) ?? '').join(' ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

function WordButton(props: {
  w: PanelWord;
  selected: boolean;
  onSelect(add: boolean): void;
  onEdit(text: string): void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(props.w.text);
  if (editing) {
    return (
      <input
        aria-label={`Edit word ${props.w.text}`}
        autoFocus
        className="w-28 rounded bg-white px-0.5 text-[11px] text-black"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            setEditing(false);
            const t = text.trim();
            if (t && t !== props.w.text) props.onEdit(t);
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
    <button
      type="button"
      data-word-key={props.w.key}
      aria-pressed={props.selected}
      title="Click to select (⇧/⌘ adds); double-click to edit"
      className={`rounded px-0.5 ${props.selected ? 'bg-indigo-600 text-white' : 'hover:bg-white/10'} ${
        props.w.emphasis ? 'font-bold text-amber-300' : ''
      }`}
      onClick={(e) => props.onSelect(e.shiftKey || e.metaKey)}
      onDoubleClick={() => {
        setText(props.w.text);
        setEditing(true);
      }}
    >
      {props.w.text}
    </button>
  );
}

export function SubtitlesPanel() {
  const { editor } = useCtx();
  const chunks = useCaptions();
  const sequenceId = useEditor((s) => s.sequenceId);
  const project = useEditor((s) => s.project);
  const seq = findSeq(project, sequenceId);
  const words = useMemo(() => panelWords(chunks), [chunks]);
  const [sel, setSel] = useState<string[]>([]);
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  useEffect(() => setSel([]), [sequenceId]);

  if (!seq || !sequenceId) return <p className="p-3 text-xs text-neutral-400">No sequence.</p>;
  if (!seq.captions?.enabled) {
    return (
      <div className="p-3 text-xs text-neutral-400">
        <p>Captions are off for this sequence.</p>
        <button
          type="button"
          className={`${btn} mt-2`}
          onClick={() => void editor.getState().apply({ op: 'setCaptions', args: { sequenceId, enabled: true } })}
        >
          Turn captions on
        </button>
      </div>
    );
  }
  const run = (call: OpCall | null) => {
    if (call) void editor.getState().apply(call);
  };
  const one = sel.length === 1 ? words.find((w) => w.key === sel[0]) : undefined;
  const oneFirst = one && words.find((w) => w.key === one.key);
  const oneLast = one && [...words].reverse().find((w) => w.key === one.key);
  const lastOfChunk = (w: PanelWord) =>
    !words.some((x) => x.chunk === w.chunk && words.indexOf(x) > words.indexOf(w) && x.key !== w.key);
  const hidden = hiddenWords(seq);
  const allKeys = (seq.captions.overrides ?? []).map((o) => o.wordKey);
  const notice = (e: ErrorData) => editor.getState().toast(e);

  const onKey = (e: KeyboardEvent) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      run(removeWordsOp(sequenceId, sel));
      setSel([]);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col text-xs" data-testid="subtitles-panel">
      <div className="flex flex-wrap items-center gap-1 border-b border-neutral-800 p-2">
        <input
          aria-label="Find"
          placeholder="Find"
          className="w-24 rounded bg-neutral-800 px-1 py-0.5"
          value={find}
          onChange={(e) => setFind(e.target.value)}
        />
        <input
          aria-label="Replace with"
          placeholder="Replace"
          className="w-24 rounded bg-neutral-800 px-1 py-0.5"
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
        />
        <button
          type="button"
          className={btn}
          disabled={!find.trim()}
          onClick={() => {
            const call = findReplaceOp(sequenceId, chunks, find, replace);
            if (!call) notice({ code: 'NOT_FOUND', message: `No caption contains “${find}”`, hint: '' });
            run(call);
          }}
        >
          Replace all
        </button>
        <button
          type="button"
          className={`${btn} ml-auto`}
          disabled={allKeys.length === 0}
          onClick={() => run(resetOp(sequenceId, allKeys))}
        >
          Reset all to transcript
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1 border-b border-neutral-800 p-2" aria-label="Word actions">
        <span className="text-neutral-400">{sel.length ? `${sel.length} selected` : 'Select words'}</span>
        <button type="button" className={btn} disabled={!one} onClick={() => one && run(overrideOp(sequenceId, one.key, { text: null }))}>
          Hide
        </button>
        <button
          type="button"
          className={btn}
          disabled={!one}
          onClick={() => one && run(overrideOp(sequenceId, one.key, { emphasis: !one.emphasis }))}
        >
          {one?.emphasis ? 'Clear emphasis' : 'Emphasis'}
        </button>
        {(['start', 'end'] as const).map((edge) =>
          ([-1, 1] as const).map((d) => (
            <button
              key={`${edge}${d}`}
              type="button"
              className={btn}
              disabled={!one}
              aria-label={`${edge === 'start' ? 'Start' : 'End'} ${d < 0 ? 'one frame earlier' : 'one frame later'}`}
              onClick={() => {
                const w = edge === 'start' ? oneFirst : oneLast;
                if (!w) return;
                const call = nudgeOp(seq, w, edge, d);
                if (!call) notice({ code: 'VALIDATION', message: 'The word cannot move there', hint: '' });
                run(call);
              }}
            >
              {edge === 'start' ? 'Start' : 'End'} {d < 0 ? '−1f' : '+1f'}
            </button>
          )),
        )}
        <button
          type="button"
          className={btn}
          disabled={!oneLast || lastOfChunk(oneLast)}
          onClick={() => oneLast && run(breakOp(sequenceId, oneLast.key, true))}
        >
          Split after
        </button>
        <button
          type="button"
          className={btn}
          disabled={sel.length === 0}
          onClick={() => {
            run(removeWordsOp(sequenceId, sel));
            setSel([]);
          }}
        >
          Delete words
        </button>
      </div>
      <PausesAndFillers sequenceId={sequenceId} words={words} />
      <ol className="min-h-0 flex-1 overflow-y-auto p-1" aria-label="Captions" onKeyDown={onKey}>
        {chunks.map((c, i) => {
          const cw = words.filter((w) => w.chunk === i);
          const last = cw.at(-1);
          const canMerge = last !== undefined && i + 1 < chunks.length && userBreakAfter(seq, last.key);
          return (
            <li key={`${c.startMs}-${i}`} className="group flex items-start gap-2 rounded px-1 py-1 hover:bg-neutral-900" data-testid="subtitle-chunk">
              <button
                type="button"
                className="shrink-0 font-mono text-neutral-400 hover:text-white"
                aria-label={`Seek to ${clock(c.startMs)}`}
                onClick={() => editor.getState().setPlayhead(c.startMs)}
              >
                {clock(c.startMs)}
              </button>
              <span className="flex flex-1 flex-wrap gap-0.5">
                {cw.map((w, k) => (
                  <WordButton
                    key={`${w.key}-${k}`}
                    w={w}
                    selected={sel.includes(w.key)}
                    onSelect={(add) =>
                      setSel(add ? (sel.includes(w.key) ? sel.filter((x) => x !== w.key) : [...sel, w.key]) : [w.key])
                    }
                    onEdit={(t) => run(overrideOp(sequenceId, w.key, { text: t }))}
                  />
                ))}
              </span>
              <span className="flex shrink-0 gap-1 opacity-60 group-hover:opacity-100">
                {canMerge && (
                  <button type="button" className={btn} onClick={() => run(breakOp(sequenceId, last.key, false))}>
                    Merge with next
                  </button>
                )}
                <button
                  type="button"
                  className={btn}
                  aria-label={`Reset ${clock(c.startMs)} to transcript`}
                  disabled={!cw.some((w) => allKeys.includes(w.key))}
                  onClick={() => run(resetOp(sequenceId, cw.map((w) => w.key)))}
                >
                  Reset
                </button>
              </span>
            </li>
          );
        })}
        {hidden.length > 0 && (
          <li className="mt-2 px-1 text-neutral-400">
            Hidden words: {hidden.length}{' '}
            <button type="button" className={btn} onClick={() => run(resetOp(sequenceId, hidden))}>
              Show all
            </button>
          </li>
        )}
      </ol>
    </div>
  );
}
