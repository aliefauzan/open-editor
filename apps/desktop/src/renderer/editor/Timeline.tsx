// Timeline (app spec "Main editor" → Timeline; D-35): sequence tabs with per-sequence settings, track
// headers (lock / hide / mute / sync-lock, add / remove / reorder), the library timeline with our own
// marquee, multi-select, linked follow, snapping and drops, thumbnails and waveforms, scene colours,
// transition markers, audio fade handles and the caption lane.
import { Timeline as Library, type TimelineState } from '@xzdarcy/react-timeline-editor';
import '@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type {
  CaptionChunk,
  CaptionWord,
  Item,
  MediaItem,
  Sequence,
  Track,
} from '../../shared/project.ts';
import { sourceSpanMs } from '../../shared/project.ts';
import { CaptionLane } from './CaptionLane.tsx';
import { useCtx, useEditor, useEditorShallow, useUi } from './context.tsx';
import { mediaName } from './MediaBin.tsx';
import { endOf, seqOf } from './editing.ts';
import { findItem } from './entities.ts';
import { SequenceTabs } from './SequenceTabs.tsx';
import { createFollow, timelineHandlers, type Follow } from './timeline-handlers.ts';
import {
  CAPTION_ROW,
  CAPTION_ROW_HEIGHT,
  itemsInRect,
  ROW_HEIGHT,
  snapTime,
  toRows,
  type Row,
} from './timeline-model.ts';
import { templateColor, templateName, useResolvedStyle } from './use-styles.ts';

/** A stable empty list for selectors (a new [] each time would re-render forever). */
const NONE: never[] = [];

const START_LEFT = 16;
const EFFECTS = {
  media: { id: 'media', name: 'media' },
  scene: { id: 'scene', name: 'scene' },
  audio: { id: 'audio', name: 'audio' },
  caption: { id: 'caption', name: 'caption' },
};
const EDIT_AREA = '.timeline-editor-edit-area';
const ACTION = '.timeline-editor-action';
export const DRAG_TEMPLATE = 'application/x-vox-template';
export const DRAG_MEDIA = 'application/x-vox-media';

/** A readable ruler step: about 80 px between marks. */
function ruler(pxPerSec: number): { scale: number; scaleWidth: number; split: number } {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const scale = steps.find((s) => s * pxPerSec >= 80) ?? 600;
  return { scale, scaleWidth: scale * pxPerSec, split: scale >= 5 ? 5 : 10 };
}

export function useCaptions(): CaptionChunk[] {
  const { vox } = useCtx();
  const projectId = useEditor((s) => s.projectId);
  const sequenceId = useEditor((s) => s.sequenceId);
  const version = useEditor((s) => s.version);
  const [chunks, setChunks] = useState<CaptionChunk[]>([]);
  useEffect(() => {
    if (!projectId || !sequenceId) return setChunks([]);
    let live = true;
    vox.captions
      .get(projectId, sequenceId)
      .then((c) => live && setChunks(c as CaptionChunk[]))
      .catch(() => live && setChunks([]));
    return () => {
      live = false;
    };
  }, [vox, projectId, sequenceId, version]);
  return chunks;
}

function usePeaks(projectId: string | null, m: MediaItem | undefined): number[] | null {
  const { vox } = useCtx();
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    if (!projectId || !m?.peaksPath) return setPeaks(null);
    let live = true;
    vox.media
      .peaks(projectId, m.id)
      .then((p) => live && setPeaks((p as { peaks?: number[] } | null)?.peaks ?? null))
      .catch(() => live && setPeaks(null));
    return () => {
      live = false;
    };
  }, [vox, projectId, m?.id, m?.peaksPath]);
  return peaks;
}

function Waveform(props: { peaks: number[]; fromMs: number; toMs: number }) {
  // 100 peaks per second (engine D-31); at most one bar per 2 px
  const a = Math.floor(props.fromMs / 10);
  const b = Math.min(props.peaks.length, Math.ceil(props.toMs / 10));
  const n = Math.max(1, b - a);
  const step = Math.max(1, Math.ceil(n / 400));
  const bars: string[] = [];
  for (let i = a, x = 0; i < b; i += step, x++) {
    const v = props.peaks[i] ?? 0;
    bars.push(`M${x} ${50 - v * 48}V${50 + v * 48}`);
  }
  return (
    <svg
      aria-hidden
      className="absolute inset-0 h-full w-full text-emerald-300/70"
      viewBox={`0 0 ${Math.max(1, bars.length)} 100`}
      preserveAspectRatio="none"
    >
      <path d={bars.join('')} stroke="currentColor" strokeWidth={0.8} fill="none" />
    </svg>
  );
}

/** Thumbnails from the sprite sheet (1 frame every 2 s, 90 px high, 10 columns; engine D-31). */
function Thumbs(props: {
  projectId: string;
  m: MediaItem;
  inMs: number;
  /** Source ms the clip shows (timeline length × speed). */
  durationMs: number;
  widthPx: number;
}) {
  const { m } = props;
  if (!m.thumbsPath || !m.durationMs || !m.width || !m.height) return null;
  const frames = Math.max(1, Math.ceil(m.durationMs / 2000));
  const columns = Math.min(10, frames);
  const rows = Math.ceil(frames / columns);
  const tw = Math.round((90 * m.width) / m.height / 2) * 2;
  const h = ROW_HEIGHT - 16;
  const w = (tw * h) / 90;
  const count = Math.max(1, Math.min(40, Math.ceil(props.widthPx / w)));
  const url = `vox-media://p/${props.projectId}/${m.thumbsPath.split('/').map(encodeURIComponent).join('/')}`;
  return (
    <div
      aria-hidden
      className="absolute inset-x-0 bottom-0 flex overflow-hidden opacity-70"
      style={{ height: h }}
    >
      {Array.from({ length: count }, (_, k) => {
        const t = props.inMs + (k * w * props.durationMs) / Math.max(1, props.widthPx);
        const idx = Math.min(frames - 1, Math.floor(t / 2000));
        return (
          <div
            key={k}
            style={{
              width: w,
              height: h,
              flex: 'none',
              backgroundImage: `url("${url}")`,
              backgroundSize: `${columns * w}px ${rows * h}px`,
              backgroundPosition: `${-(idx % columns) * w}px ${-Math.floor(idx / columns) * h}px`,
            }}
          />
        );
      })}
    </div>
  );
}

function FadeHandle(props: { side: 'in' | 'out'; item: Item; pxPerSec: number }) {
  const { editor } = useCtx();
  const [drag, setDrag] = useState<number | null>(null);
  const it = props.item;
  if (it.type !== 'media') return null;
  const cur = (props.side === 'in' ? it.fadeInMs : it.fadeOutMs) ?? 0;
  const ms = drag ?? cur;
  const px = (ms / 1000) * props.pxPerSec;
  const onDown = (e: ReactPointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    let last = cur;
    const move = (ev: PointerEvent) => {
      const dx = (props.side === 'in' ? 1 : -1) * (ev.clientX - x0);
      last = Math.max(0, Math.min(it.durationMs, Math.round(cur + (dx / props.pxPerSec) * 1000)));
      setDrag(last);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      setDrag(null);
      const s = editor.getState();
      if (last !== cur && s.sequenceId)
        void editor.getState().apply({
          op: 'updateClip',
          args: {
            sequenceId: s.sequenceId,
            itemId: it.id,
            [props.side === 'in' ? 'fadeInMs' : 'fadeOutMs']: last || null,
          },
        });
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };
  return (
    <>
      {ms > 0 && (
        <svg
          aria-hidden
          className="pointer-events-none absolute top-0 h-full text-black/40"
          style={{ [props.side === 'in' ? 'left' : 'right']: 0, width: px }}
          viewBox="0 0 10 10"
          preserveAspectRatio="none"
        >
          <path d={props.side === 'in' ? 'M0 0H10L0 10Z' : 'M0 0H10V10Z'} fill="currentColor" />
        </svg>
      )}
      <div
        role="slider"
        aria-label={props.side === 'in' ? 'Fade in' : 'Fade out'}
        aria-valuenow={ms}
        aria-valuemin={0}
        aria-valuemax={it.durationMs}
        tabIndex={-1}
        onPointerDown={onDown}
        className="absolute top-0 z-10 h-2.5 w-2.5 cursor-ew-resize rounded-full border border-white bg-emerald-500"
        style={{ [props.side === 'in' ? 'left' : 'right']: Math.max(0, px - 5) }}
      />
    </>
  );
}

function ClipView(props: { itemId: string; rowId: string; follow: Follow }) {
  const offs = useSyncExternalStore(
    (l) => {
      props.follow.listeners.add(l);
      return () => props.follow.listeners.delete(l);
    },
    () => props.follow.offsets.get(props.itemId),
  );
  const projectId = useEditor((s) => s.projectId);
  const found = useEditorShallow((s) => {
    const q = seqOf(s.project, s.sequenceId);
    return q ? findItem(q, props.itemId) : undefined;
  });
  const media = useEditor((s) =>
    found?.item.type === 'media'
      ? s.project?.media.find((m) => m.id === (found.item as { mediaId: string }).mediaId)
      : undefined,
  );
  const selected = useEditor((s) => s.selection.includes(props.itemId));
  const agent = useEditor((s) => s.agentItems[props.itemId]);
  const styleId = useEditor((s) => seqOf(s.project, s.sequenceId)?.styleId);
  const style = useResolvedStyle(styleId);
  const pxPerSec = useUi((s) => s.pxPerSec);
  const offlineIds = useEditor((s) => s.offline);
  const peaks = usePeaks(projectId, found?.kind === 'audio' ? media : undefined);
  if (!found) return null;
  const it = found.item;
  const audio = found.kind === 'audio';
  // the media entry is gone, or its file is missing on disk (moved or deleted)
  const offline = it.type === 'media' && (!media || offlineIds.includes(it.mediaId));
  const widthPx = (it.durationMs / 1000) * pxPerSec;
  const shift = offs
    ? { left: (offs[0] / 1000) * pxPerSec, right: -(offs[1] / 1000) * pxPerSec }
    : {};
  const label =
    it.type === 'scene'
      ? templateName(style?.templates[it.template], it.template)
      : media
        ? mediaName(media)
        : it.mediaId;
  const bg = offline
    ? 'bg-red-700'
    : it.type === 'scene'
      ? ''
      : audio
        ? 'bg-emerald-800'
        : 'bg-sky-800';
  return (
    <div
      data-item-id={it.id}
      data-selected={selected || undefined}
      title={offline ? `${label} (offline: the media file is missing)` : label}
      className={`absolute inset-0 overflow-hidden rounded border text-[11px] leading-tight text-white ${bg} ${
        selected ? 'border-amber-300 ring-1 ring-amber-300' : 'border-black/40'
      }`}
      style={{
        ...shift,
        ...(it.type === 'scene' && !offline ? { background: templateColor(it.template) } : {}),
      }}
    >
      {it.type === 'media' && media && !audio && projectId && (
        <Thumbs
          projectId={projectId}
          m={media}
          inMs={it.inMs}
          durationMs={sourceSpanMs(it)}
          widthPx={widthPx}
        />
      )}
      {audio && peaks && it.type === 'media' && (
        <Waveform peaks={peaks} fromMs={it.inMs} toMs={it.inMs + sourceSpanMs(it)} />
      )}
      <div className="relative flex items-center gap-1 px-1.5 pt-0.5">
        {it.linkId && (
          <span
            aria-label="Linked"
            title="Linked: selects and moves with its pair"
            className="opacity-80"
          >
            🔗
          </span>
        )}
        {agent && (
          <span
            className="rounded bg-violet-600 px-1 text-[9px] uppercase"
            title={`Changed by agent run ${agent}`}
          >
            agent
          </span>
        )}
        <span className="truncate">{offline ? `Offline · ${label}` : label}</span>
      </div>
      {it.transitionIn && (
        <span
          aria-label={`Transition ${it.transitionIn.template}`}
          title={`Transition: ${it.transitionIn.template}`}
          className="absolute top-0 left-0 h-full border-l-4 border-fuchsia-400"
          style={{
            width: (it.transitionIn.durationMs / 1000) * pxPerSec,
            background: 'rgb(232 121 249 / 0.25)',
          }}
        />
      )}
      {audio && <FadeHandle side="in" item={it} pxPerSec={pxPerSec} />}
      {audio && <FadeHandle side="out" item={it} pxPerSec={pxPerSec} />}
    </div>
  );
}

type Rect = { x0: number; y0: number; x1: number; y1: number };

function Marquee(props: {
  timeline: React.RefObject<TimelineState | null>;
  rows: Row[];
  scroll: React.RefObject<{ left: number; top: number }>;
  children: ReactNode;
}) {
  const { editor, ui } = useCtx();
  const [rect, setRect] = useState<Rect | null>(null);
  const onPointerDownCapture = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    const area = props.timeline.current?.target?.querySelector(EDIT_AREA);
    if (e.button !== 0 || !area || !area.contains(target) || target.closest(ACTION)) return;
    if (ui.getState().tool !== 'select') return;
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      moved = true;
      setRect({ x0: start.x, y0: start.y, x1: ev.clientX, y1: ev.clientY });
    };
    const up = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      setRect(null);
      if (!moved) return;
      const box = area.getBoundingClientRect();
      const c = (x: number, y: number) => ({
        x: x - box.left + props.scroll.current.left,
        y: y - box.top + props.scroll.current.top,
      });
      const a = c(start.x, start.y);
      const b = c(ev.clientX, ev.clientY);
      const ids = itemsInRect(
        { pxPerSec: ui.getState().pxPerSec, startLeft: START_LEFT, rows: props.rows },
        { x0: a.x, y0: a.y, x1: b.x, y1: b.y },
      );
      const add = ev.shiftKey || ev.metaKey;
      editor.getState().setSelection(add ? [...editor.getState().selection, ...ids] : ids);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };
  return (
    <div className="relative min-h-0 flex-1" onPointerDownCapture={onPointerDownCapture}>
      {props.children}
      {rect && (
        <div
          data-testid="marquee"
          className="pointer-events-none fixed z-40 border border-sky-300 bg-sky-300/15"
          style={{
            left: Math.min(rect.x0, rect.x1),
            top: Math.min(rect.y0, rect.y1),
            width: Math.abs(rect.x1 - rect.x0),
            height: Math.abs(rect.y1 - rect.y0),
          }}
        />
      )}
    </div>
  );
}

function TrackHeader(props: { s: Sequence; track: Track; kind: 'video' | 'audio' }) {
  const { editor } = useCtx();
  const { s, track } = props;
  const list = props.kind === 'video' ? s.videoTracks : s.audioTracks;
  const idx = list.findIndex((t) => t.id === track.id);
  const toggle = (field: 'locked' | 'hidden' | 'muted' | 'syncLock') =>
    void editor.getState().apply({
      op: 'updateTrack',
      args: { sequenceId: s.id, trackId: track.id, [field]: !track[field] },
    });
  const reorder = (dir: -1 | 1) => {
    const ids = list.map((t) => t.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j]!, ids[idx]!];
    void editor
      .getState()
      .apply({ op: 'reorderTracks', args: { sequenceId: s.id, kind: props.kind, trackIds: ids } });
  };
  const b = (on: boolean) =>
    `h-5 min-w-5 rounded px-1 text-[10px] ${on ? 'bg-amber-500 text-black' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'}`;
  return (
    <div
      role="group"
      aria-label={`Track ${track.id}`}
      className="flex items-center gap-0.5 border-b border-neutral-800 px-1 text-xs"
      style={{ height: ROW_HEIGHT }}
    >
      <span className="w-6 font-mono text-neutral-300" title={track.name ?? track.id}>
        {track.id}
      </span>
      <button
        type="button"
        className={b(track.locked)}
        aria-pressed={track.locked}
        aria-label={`Lock ${track.id}`}
        onClick={() => toggle('locked')}
      >
        L
      </button>
      {props.kind === 'video' ? (
        <button
          type="button"
          className={b(track.hidden)}
          aria-pressed={track.hidden}
          aria-label={`Hide ${track.id}`}
          onClick={() => toggle('hidden')}
        >
          H
        </button>
      ) : (
        <button
          type="button"
          className={b(track.muted)}
          aria-pressed={track.muted}
          aria-label={`Mute ${track.id}`}
          onClick={() => toggle('muted')}
        >
          M
        </button>
      )}
      <button
        type="button"
        className={b(track.syncLock)}
        aria-pressed={track.syncLock}
        aria-label={`Sync-lock ${track.id}`}
        onClick={() => toggle('syncLock')}
      >
        S
      </button>
      <button
        type="button"
        className={b(false)}
        aria-label={`Move ${track.id} up`}
        onClick={() => reorder(props.kind === 'video' ? 1 : -1)}
      >
        ↑
      </button>
      <button
        type="button"
        className={b(false)}
        aria-label={`Move ${track.id} down`}
        onClick={() => reorder(props.kind === 'video' ? -1 : 1)}
      >
        ↓
      </button>
      <button
        type="button"
        className={b(false)}
        aria-label={`Remove ${track.id}`}
        disabled={list.length <= 1}
        onClick={() =>
          void editor
            .getState()
            .apply({ op: 'removeTrack', args: { sequenceId: s.id, trackId: track.id } })
        }
      >
        ×
      </button>
    </div>
  );
}

function Toolbar(props: { s: Sequence }) {
  const { ui, editor, run } = useCtx();
  const tool = useUi((x) => x.tool);
  const snapping = useUi((x) => x.snapping);
  const b = (on = false) =>
    `rounded px-2 py-0.5 text-xs ${on ? 'bg-indigo-600 text-white' : 'bg-neutral-800 hover:bg-neutral-700'}`;
  return (
    <div
      role="toolbar"
      aria-label="Timeline tools"
      className="flex items-center gap-1 border-b border-neutral-800 px-2 py-1"
    >
      <button
        type="button"
        className={b(tool === 'select')}
        aria-pressed={tool === 'select'}
        onClick={() => ui.getState().set({ tool: 'select' })}
      >
        Select
      </button>
      <button
        type="button"
        className={b(tool === 'blade')}
        aria-pressed={tool === 'blade'}
        onClick={() => ui.getState().set({ tool: 'blade' })}
        title="Blade (B splits at the playhead)"
      >
        Blade
      </button>
      <button
        type="button"
        className={b()}
        onClick={() => run('rippleDelete')}
        title="Ripple delete (⇧⌫)"
      >
        Ripple delete
      </button>
      <button
        type="button"
        className={b(snapping)}
        aria-pressed={snapping}
        onClick={() => ui.getState().set({ snapping: !snapping })}
      >
        Snap
      </button>
      <span className="mx-1 h-4 w-px bg-neutral-700" />
      <button type="button" className={b()} onClick={() => run('addText')}>
        Add text
      </button>
      <button
        type="button"
        className={b()}
        onClick={() =>
          void editor
            .getState()
            .apply({ op: 'addTrack', args: { sequenceId: props.s.id, kind: 'video' } })
        }
      >
        + Video track
      </button>
      <button
        type="button"
        className={b()}
        onClick={() =>
          void editor
            .getState()
            .apply({ op: 'addTrack', args: { sequenceId: props.s.id, kind: 'audio' } })
        }
      >
        + Audio track
      </button>
      <span className="flex-1" />
      <button type="button" className={b()} aria-label="Zoom out" onClick={() => run('zoomOut')}>
        −
      </button>
      <button type="button" className={b()} aria-label="Zoom in" onClick={() => run('zoomIn')}>
        +
      </button>
    </div>
  );
}

/** Drop of a template, transition, overlay, caption preset or media from a panel onto the timeline. */
export function dropOp(
  s: Sequence,
  payload: {
    kind: string;
    id: string;
    durationMs?: number;
    hasAudio?: boolean;
    variables?: Record<string, unknown>;
  },
  atMs: number,
  rowId: string | null,
): { op: string; args: Record<string, unknown> } | null {
  const videoRow = rowId && rowId.startsWith('V') ? rowId : (s.videoTracks.at(-1)?.id ?? 'V1');
  switch (payload.kind) {
    case 'scene':
      return {
        op: 'addScene',
        args: {
          sequenceId: s.id,
          trackId: videoRow,
          startMs: atMs,
          ...(payload.durationMs ? { durationMs: payload.durationMs } : {}),
          template: payload.id,
          variables: payload.variables ?? {},
        },
      };
    case 'transition': {
      // onto the cut nearest the drop: the clip that starts there gets the transition in
      const track = s.videoTracks.find((t) => t.id === videoRow) ?? s.videoTracks[0];
      const next = track?.items
        .filter((i) => i.startMs > 0)
        .sort((a, b) => Math.abs(a.startMs - atMs) - Math.abs(b.startMs - atMs))[0];
      if (!next) return null;
      return {
        op: 'setTransition',
        args: {
          sequenceId: s.id,
          itemId: next.id,
          transition: { template: payload.id, durationMs: payload.durationMs ?? 500 },
        },
      };
    }
    case 'overlay': {
      const cur = s.overlays ?? [];
      if (cur.includes(payload.id)) return null;
      return { op: 'updateSequence', args: { sequenceId: s.id, overlays: [...cur, payload.id] } };
    }
    case 'captionPreset':
      return { op: 'setCaptions', args: { sequenceId: s.id, preset: payload.id } };
    case 'media':
      return {
        op: 'placeClip',
        args: {
          sequenceId: s.id,
          trackId: rowId && rowId.startsWith('A') ? rowId : videoRow,
          mediaId: payload.id,
          startMs: atMs,
          ...(payload.hasAudio ? { withAudio: true } : {}),
        },
      };
    default:
      return null;
  }
}

export function Timeline() {
  const ctx = useCtx();
  const { editor, ui, player } = ctx;
  const s = useEditor((x) => seqOf(x.project, x.sequenceId));
  const media = useEditor((x) => x.project?.media ?? NONE);
  const selection = useEditor((x) => x.selection);
  const playheadMs = useEditor((x) => x.playheadMs);
  const pxPerSec = useUi((x) => x.pxPerSec);
  const tool = useUi((x) => x.tool);
  const captions = useCaptions();
  const captionsRef = useRef(captions);
  captionsRef.current = captions;
  const timeline = useRef<TimelineState | null>(null);
  const scroll = useRef({ left: 0, top: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const follow = useMemo(createFollow, []);
  const handlers = useMemo(
    () => timelineHandlers(ctx, follow, () => captionsRef.current),
    [ctx, follow],
  );
  const sel = useMemo(() => new Set(selection), [selection]);
  const rows = useMemo(() => (s ? toRows(s, media, sel, captions) : []), [s, media, sel, captions]);
  const r = ruler(pxPerSec);
  const chunkOf = (actionId: string) => captions[Number(actionId.slice(4))];

  // the library's cursor follows the playhead
  useEffect(() => {
    timeline.current?.setTime(playheadMs / 1000);
  }, [playheadMs]);

  const seek = (sec: number) => {
    if (!s) return;
    const ms = snapTime(sec * 1000, [], 0, s.canvas.fps);
    editor.getState().setPlayhead(ms);
    player.current?.seekMs(ms);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!s) return;
    const raw = e.dataTransfer.getData(DRAG_TEMPLATE) || e.dataTransfer.getData(DRAG_MEDIA);
    if (!raw) return;
    e.preventDefault();
    const area = timeline.current?.target?.querySelector(EDIT_AREA);
    const box = area?.getBoundingClientRect();
    const x = box ? e.clientX - box.left + scroll.current.left - START_LEFT : 0;
    const y = box ? e.clientY - box.top + scroll.current.top : 0;
    let top = 0;
    let rowId: string | null = null;
    for (const row of rows) {
      if (y >= top && y < top + row.rowHeight) rowId = row.id;
      top += row.rowHeight;
    }
    const atMs = snapTime(Math.max(0, (x / pxPerSec) * 1000), [], 0, s.canvas.fps);
    try {
      const call = dropOp(s, JSON.parse(raw) as { kind: string; id: string }, atMs, rowId);
      if (call) void editor.getState().apply(call);
    } catch {
      // not ours
    }
  };

  if (!s) {
    return (
      <section
        id="timeline"
        tabIndex={-1}
        aria-label="Timeline"
        className="flex h-full flex-col bg-neutral-900"
      >
        <SequenceTabs />
        <p className="p-4 text-sm text-neutral-400">Add a sequence to start editing.</p>
      </section>
    );
  }

  const trackOf = (rowId: string) =>
    s.videoTracks.find((t) => t.id === rowId) ?? s.audioTracks.find((t) => t.id === rowId);

  return (
    <section
      id="timeline"
      tabIndex={-1}
      aria-label="Timeline"
      className="flex h-full min-h-0 flex-col bg-neutral-900"
      onDragOver={(e) => {
        if (
          e.dataTransfer.types.includes(DRAG_TEMPLATE) ||
          e.dataTransfer.types.includes(DRAG_MEDIA)
        )
          e.preventDefault();
      }}
      onDrop={onDrop}
      onWheel={(e) => {
        if (!e.ctrlKey) return;
        ui.getState().zoom(e.deltaY < 0 ? 1 : -1);
      }}
    >
      <SequenceTabs />
      <Toolbar s={s} />
      <div className="flex min-h-0 flex-1">
        <div
          className="w-44 shrink-0 overflow-hidden border-r border-neutral-800"
          style={{ paddingTop: 32 }}
        >
          <div style={{ transform: `translateY(${-scrollTop}px)` }}>
            {rows.map((row) => {
              if (row.id === CAPTION_ROW)
                return (
                  <div
                    key={row.id}
                    className="flex items-center border-b border-neutral-800 px-2 text-xs text-neutral-400"
                    style={{ height: CAPTION_ROW_HEIGHT }}
                  >
                    Captions
                  </div>
                );
              const t = trackOf(row.id);
              return t ? (
                <TrackHeader key={row.id} s={s} track={t} kind={row.kind as 'video' | 'audio'} />
              ) : null;
            })}
          </div>
        </div>
        <Marquee timeline={timeline} rows={rows} scroll={scroll}>
          <Library
            ref={timeline}
            editorData={rows as never}
            effects={EFFECTS}
            scale={r.scale}
            scaleWidth={r.scaleWidth}
            scaleSplitCount={r.split}
            startLeft={START_LEFT}
            rowHeight={ROW_HEIGHT}
            autoScroll
            dragLine
            style={{ width: '100%', height: '100%', background: 'transparent' }}
            getActionRender={(action, row) =>
              row.id === CAPTION_ROW ? (
                <CaptionLane chunk={chunkOf(action.id)} />
              ) : (
                <ClipView itemId={action.id} rowId={row.id} follow={follow} />
              )
            }
            onClickTimeArea={(time) => {
              seek(time);
              return true;
            }}
            onCursorDrag={(time) => seek(time)}
            onClickActionOnly={(e, { action, row, time }) => {
              if (row.id === CAPTION_ROW) return;
              if (tool === 'blade') {
                const found = findItem(s, action.id);
                if (!found) return;
                const at = snapTime(time * 1000, [], 0, s.canvas.fps);
                if (at > found.item.startMs && at < endOf(found.item))
                  void editor.getState().apply({
                    op: 'splitItem',
                    args: { sequenceId: s.id, itemId: action.id, atMs: at },
                  });
                return;
              }
              editor.getState().select(action.id, { alt: e.altKey, add: e.shiftKey || e.metaKey });
            }}
            onClickRow={(e) => {
              if (!(e.target as Element).closest(ACTION) && !e.shiftKey)
                editor.getState().setSelection([]);
            }}
            onActionMoving={({ action, start }) => {
              handlers.onMoving(action.id, start);
            }}
            onActionMoveEnd={({ action, start }) => handlers.onMoveEnd(action.id, start)}
            onActionResizing={({ action, start, end, dir }) => {
              handlers.onResizing(action.id, start, end, dir);
            }}
            onActionResizeEnd={({ action, start, end, dir }) =>
              handlers.onResizeEnd(action.id, start, end, dir)
            }
            onScroll={({ scrollLeft, scrollTop }) => {
              scroll.current = { left: scrollLeft, top: scrollTop };
              setScrollTop(scrollTop);
            }}
          />
        </Marquee>
      </div>
    </section>
  );
}

export type { CaptionWord };
