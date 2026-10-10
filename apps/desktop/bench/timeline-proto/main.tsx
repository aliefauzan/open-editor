// GATE 4 throwaway prototype (phase 08 steps A1–A2, D-19 early package U1).
// @xzdarcy/react-timeline-editor with 1,000 items on 8 tracks. Linked V1/A1 drag and marquee are
// built only on the library's public props, events and ref (no fork or patch of its source).
// window.__bench is the hook the Playwright driver (bench/timeline-runner.ts) uses.
import { Timeline, type TimelineState } from '@xzdarcy/react-timeline-editor';
import '@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css';
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { itemsInMarquee, marqueeRange } from './marquee.ts';
import {
  BENCH_GEOMETRY,
  BENCH_TRACKS,
  type BenchItem,
  type BenchModel,
  makeBenchData,
  moveItem,
  type PartnerPreview,
  partnerPreview,
  toEditorData,
  trimItem,
} from './model.ts';

export interface BenchHooks {
  actionCount(): number;
  startFrames(): void;
  stopFrames(): number[];
  updates(): number;
  item(id: string): BenchItem | undefined;
  selected(): string[];
  gpuRenderer(): string;
}

declare global {
  interface Window {
    __bench?: BenchHooks;
  }
}

const EFFECTS = { clip: { id: 'clip', name: 'clip' } };
const EDIT_AREA = '.timeline-editor-edit-area';
const ACTION = '.timeline-editor-action';
const PX_PER_SEC = BENCH_GEOMETRY.scaleWidth / BENCH_GEOMETRY.scale;

// Read by window.__bench outside React.
const live = {
  model: makeBenchData(),
  selected: new Set<string>(),
  updates: 0,
  scrollLeft: 0,
  scrollTop: 0,
};

// Live follow of linked partners during a drag or trim: offsets on our own clip node, so one
// partner re-renders instead of the whole timeline. The store changes only at the drop.
const preview = new Map<string, PartnerPreview>();
const previewListeners = new Set<() => void>();
function setPreview(list: PartnerPreview[]) {
  if (list.length === 0 && preview.size === 0) return;
  preview.clear();
  for (const p of list) preview.set(p.id, p);
  for (const l of previewListeners) l();
}
const subscribePreview = (l: () => void) => {
  previewListeners.add(l);
  return () => {
    previewListeners.delete(l);
  };
};

function Clip(props: { id: string; audio: boolean }) {
  const p = useSyncExternalStore(subscribePreview, () => preview.get(props.id));
  return (
    <div
      className={props.audio ? 'clip audio' : 'clip'}
      data-item-id={props.id}
      style={p ? { left: p.dStartPx, right: -p.dEndPx } : undefined}
    >
      {props.id.slice(3)}
    </div>
  );
}

// rAF timestamps of the current recording; the generation stops a stale chain from pushing.
let frames: number[] | null = null;
let frameGen = 0;
function recordFrames(gen: number) {
  const onFrame = (ts: number) => {
    if (!frames || gen !== frameGen) return;
    frames.push(ts);
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);
}

const isLinked = (id: string) => live.model.items[id]?.linkId != null;

function gpuRenderer(): string {
  const gl = document.createElement('canvas').getContext('webgl');
  if (!gl) return 'no webgl';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
}

type Rect = { x0: number; y0: number; x1: number; y1: number };

/**
 * Marquee over empty edit-area space. Owns its own state, so drawing the rectangle never
 * re-renders the timeline (children keep their element identity).
 */
function Marquee(props: {
  timeline: RefObject<TimelineState | null>;
  onSelect: (ids: string[]) => void;
  children: ReactNode;
}) {
  const [rect, setRect] = useState<Rect | null>(null);

  const onPointerDownCapture = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    const area = props.timeline.current?.target?.querySelector(EDIT_AREA);
    // Clips belong to the library (move/trim); the marquee starts only on empty edit-area space.
    if (e.button !== 0 || !area || !area.contains(target) || target.closest(ACTION)) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    setRect({ x0: start.x, y0: start.y, x1: start.x, y1: start.y });
    const move = (ev: PointerEvent) =>
      setRect({ x0: start.x, y0: start.y, x1: ev.clientX, y1: ev.clientY });
    const stop = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', stop);
      setRect(null);
    };
    const up = (ev: PointerEvent) => {
      stop();
      const box = area.getBoundingClientRect();
      const toContent = (x: number, y: number) => ({
        x: x - box.left + live.scrollLeft,
        y: y - box.top + live.scrollTop,
      });
      const a = toContent(start.x, start.y);
      const b = toContent(ev.clientX, ev.clientY);
      const range = marqueeRange(
        { x0: a.x, y0: a.y, x1: b.x, y1: b.y },
        BENCH_GEOMETRY,
        BENCH_TRACKS.length,
      );
      props.onSelect(itemsInMarquee(live.model, range));
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', stop);
  };

  return (
    <div onPointerDownCapture={onPointerDownCapture}>
      {props.children}
      {rect && (
        <div
          className="marquee"
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

function App() {
  const [model, setModel] = useState<BenchModel>(live.model);
  const [selected, setSelected] = useState<ReadonlySet<string>>(live.selected);
  const timeline = useRef<TimelineState | null>(null);
  useLayoutEffect(() => {
    live.model = model;
  }, [model]);

  const editorData = useMemo(() => toEditorData(model, selected), [model, selected]);

  const timelineElement = useMemo(
    () => (
      <Timeline
        ref={timeline}
        editorData={editorData}
        effects={EFFECTS}
        scale={BENCH_GEOMETRY.scale}
        scaleWidth={BENCH_GEOMETRY.scaleWidth}
        scaleSplitCount={BENCH_GEOMETRY.scaleSplitCount}
        startLeft={BENCH_GEOMETRY.startLeft}
        rowHeight={BENCH_GEOMETRY.rowHeight}
        gridSnap
        style={{ width: '100%', height: 420 }}
        getActionRender={(action, row) => <Clip id={action.id} audio={row.id.startsWith('A')} />}
        // The library moves or trims the dragged clip itself; a linked partner follows on screen
        // (preview offsets) and both land in the store on the same frame at the drop. flushSync
        // commits the store before the preview clears, so the partner never paints back.
        onActionMoving={({ action, start, end }) => {
          live.updates++;
          if (isLinked(action.id))
            setPreview(partnerPreview(live.model, action.id, start, end, PX_PER_SEC));
        }}
        onActionMoveEnd={({ action, start }) => {
          flushSync(() => setModel((m) => moveItem(m, action.id, start)));
          setPreview([]);
        }}
        onActionResizing={({ action, start, end }) => {
          live.updates++;
          if (isLinked(action.id))
            setPreview(partnerPreview(live.model, action.id, start, end, PX_PER_SEC));
        }}
        onActionResizeEnd={({ action, start, end }) => {
          flushSync(() => setModel((m) => trimItem(m, action.id, start, end)));
          setPreview([]);
        }}
        onScroll={({ scrollLeft, scrollTop }) => {
          live.scrollLeft = scrollLeft;
          live.scrollTop = scrollTop;
        }}
      />
    ),
    [editorData],
  );

  return (
    <Marquee
      timeline={timeline}
      onSelect={(ids) => {
        live.selected = new Set(ids);
        setSelected(live.selected);
      }}
    >
      {timelineElement}
    </Marquee>
  );
}

window.__bench = {
  actionCount: () => document.querySelectorAll(ACTION).length,
  startFrames() {
    frames = [];
    recordFrames(++frameGen);
  },
  stopFrames() {
    const out = frames ?? [];
    frames = null;
    return out;
  },
  updates: () => live.updates,
  item: (id) => live.model.items[id],
  selected: () => [...live.selected],
  gpuRenderer,
};

createRoot(document.getElementById('root')!).render(<App />);
