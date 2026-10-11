// Preview (app spec "Main editor" → Preview, "Preview pipeline"): `<hyperframes-player>` in the opaque
// sandbox with play/pause, frame step, in/out loop, timecode, fit/zoom, safe-area overlay and "render
// this frame". `preview.updated` patches scenes in place (`vox-patch`) or reloads the build and seeks
// back to the playhead once the scenes are mounted (`vox-playhead`; D-29).
import { useEffect, useRef, useState } from 'react';
import type { PreviewUpdated } from '../../shared/project.ts';
import { CropHandle } from './CropHandle.tsx';
import { useCtx, useEditor, useUi } from './context.tsx';
import { seqOf } from './editing.ts';
import { frameOf, timecode } from './time.ts';

type PlayerEl = HTMLElement & {
  play(): void;
  pause(): void;
  seek(sec: number): void;
  setRuntimeData(channel: string, payload: unknown): void;
  currentTime: number;
  paused: boolean;
  playbackRate: number;
  loop: boolean;
  rangeStart: number | null;
  rangeEnd: number | null;
};

/** Fired on window when an update is visible in the player (latency bench, tests). */
export const APPLIED_EVENT = 'vox-preview-applied';

function Btn(props: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      data-testid={props.testId}
      onClick={props.onClick}
      className={`rounded px-2 py-1 text-xs hover:bg-neutral-700 ${
        props.pressed ? 'bg-neutral-700 text-white' : 'bg-neutral-800 text-neutral-200'
      }`}
    >
      {props.children}
    </button>
  );
}

export function PreviewPanel() {
  const { vox, editor, ui, player, run } = useCtx();
  const projectId = useEditor((s) => s.projectId);
  const sequenceId = useEditor((s) => s.sequenceId);
  const seq = useEditor((s) => seqOf(s.project, s.sequenceId));
  const playheadMs = useEditor((s) => s.playheadMs);
  const playing = useUi((s) => s.playing);
  const safeArea = useUi((s) => s.safeArea);
  const zoom = useUi((s) => s.previewZoom);
  const inMs = useUi((s) => s.inMs);
  const outMs = useUi((s) => s.outMs);
  const loop = useUi((s) => s.loop);
  const still = useUi((s) => s.still);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<PlayerEl | null>(null);
  const pendingReload = useRef<number | null>(null);
  // the playhead a reload returns to: the new document reports time 0 until `vox-playhead` lands
  const restore = useRef<{ ms: number; until: number } | null>(null);
  const fps = seq?.canvas.fps ?? { num: 30, den: 1 };
  const hasSeq = seq !== undefined;

  // build the preview when the sequence changes
  useEffect(() => {
    if (!projectId || !sequenceId || !hasSeq) {
      setUrl(null);
      return;
    }
    let live = true;
    setError(null);
    vox.preview
      .url(projectId, sequenceId)
      .then((u) => live && setUrl(u))
      .catch((e: unknown) => {
        if (!live) return;
        setUrl(null);
        setError((e as { message?: string }).message ?? String(e));
      });
    return () => {
      live = false;
    };
  }, [vox, projectId, sequenceId, hasSeq]);

  // live updates from the engine host
  useEffect(() => {
    return vox.on('preview.updated', (raw) => {
      const e = raw as PreviewUpdated;
      const el = ref.current;
      if (
        e.projectId !== editor.getState().projectId ||
        e.sequenceId !== editor.getState().sequenceId
      )
        return;
      if (e.kind === 'patch' && el) {
        for (const p of e.patches) el.setRuntimeData('vox-patch', p);
        window.dispatchEvent(
          new CustomEvent(APPLIED_EVENT, { detail: { version: e.version, kind: 'patch' } }),
        );
        return;
      }
      if (e.kind === 'reload') {
        const at = editor.getState().playheadMs;
        restore.current = { ms: at, until: Date.now() + 5000 };
        el?.setRuntimeData('vox-playhead', at / 1000);
        pendingReload.current = e.version;
        setUrl(e.url);
      }
    });
  }, [vox, editor]);

  // player events → store; the player handle for commands
  useEffect(() => {
    const el = ref.current;
    if (!el || !url) return;
    player.current = {
      play(rate = 1) {
        el.playbackRate = rate;
        el.play();
      },
      pause: () => el.pause(),
      seekMs: (ms) => el.seek(ms / 1000),
      isPlaying: () => !el.paused,
    };
    // while paused the store owns the playhead (frame steps, clicks); a late timeupdate from an
    // earlier seek must not move it back
    const onTime = () => {
      if (el.paused) return;
      const ms = Math.round((el.currentTime ?? 0) * 1000);
      const r = restore.current;
      if (r) {
        if (Math.abs(ms - r.ms) > 50 && Date.now() < r.until) return;
        restore.current = null;
      }
      if (Math.abs(ms - editor.getState().playheadMs) >= 1) editor.getState().setPlayhead(ms);
    };
    const onPlay = () => ui.getState().set({ playing: true });
    const onPause = () => {
      ui.getState().set({ playing: false, rate: 1 });
      if (!restore.current) editor.getState().setPlayhead(Math.round((el.currentTime ?? 0) * 1000));
    };
    const onReady = () => {
      const v = pendingReload.current;
      if (v === null) return;
      pendingReload.current = null;
      window.dispatchEvent(
        new CustomEvent(APPLIED_EVENT, { detail: { version: v, kind: 'reload' } }),
      );
    };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ready', onReady);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ready', onReady);
      if (player.current) player.current = null;
    };
  }, [url, editor, ui, player]);

  // in/out loop on the player's range
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.rangeStart = loop && inMs !== null ? inMs / 1000 : null;
    el.rangeEnd = loop && outMs !== null ? outMs / 1000 : null;
    el.loop = loop;
  }, [loop, inMs, outMs, url]);

  const size =
    zoom === 'fit'
      ? { height: '100%', maxWidth: '100%' }
      : { height: `${Math.round((seq?.canvas.height ?? 1920) * zoom * 0.5)}px` };

  return (
    <section aria-label="Preview" className="flex h-full min-h-0 flex-col bg-neutral-950">
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
        {url ? (
          <div
            className="relative"
            style={{
              ...size,
              aspectRatio: `${seq?.canvas.width ?? 9} / ${seq?.canvas.height ?? 16}`,
            }}
          >
            <hyperframes-player
              ref={ref}
              src={url}
              width={String(seq?.canvas.width ?? 1080)}
              height={String(seq?.canvas.height ?? 1920)}
              sandbox-origin="opaque"
              data-testid="player"
              style={{ width: '100%', height: '100%' }}
            />
            <CropHandle />
            {safeArea && (
              <div
                data-testid="safe-area"
                aria-hidden
                className="pointer-events-none absolute border border-dashed border-amber-400/80"
                style={{ left: '6%', right: '6%', top: '10%', bottom: '20%' }}
              />
            )}
            {still && (
              <figure className="absolute inset-0 bg-black/80 p-2" data-testid="still">
                <img src={still} alt="Rendered frame" className="h-full w-full object-contain" />
                <button
                  type="button"
                  className="absolute top-2 right-2 rounded bg-neutral-800 px-2 text-xs"
                  onClick={() => ui.getState().set({ still: null })}
                >
                  Close
                </button>
              </figure>
            )}
          </div>
        ) : (
          <p className="text-sm text-neutral-400">
            {error ?? (seq ? 'Building the preview…' : 'This project has no sequence yet.')}
          </p>
        )}
      </div>
      <div
        role="toolbar"
        aria-label="Preview controls"
        className="flex flex-wrap items-center gap-1 border-t border-neutral-800 px-3 py-1.5"
      >
        <Btn label="Previous frame" onClick={() => run('frameBack')}>
          ◀︎|
        </Btn>
        <Btn label={playing ? 'Pause' : 'Play'} testId="play" onClick={() => run('playPause')}>
          {playing ? 'Pause' : 'Play'}
        </Btn>
        <Btn label="Next frame" onClick={() => run('frameForward')}>
          |▶︎
        </Btn>
        <span
          data-testid="time"
          className="mx-2 font-mono text-xs text-neutral-200 tabular-nums"
          title={`frame ${frameOf(playheadMs, fps)}`}
        >
          {timecode(playheadMs, fps)}
        </span>
        <Btn label="Mark in" onClick={() => run('markIn')} pressed={inMs !== null}>
          In
        </Btn>
        <Btn label="Mark out" onClick={() => run('markOut')} pressed={outMs !== null}>
          Out
        </Btn>
        <Btn
          label="Loop in to out"
          pressed={loop}
          onClick={() => ui.getState().set({ loop: !ui.getState().loop })}
        >
          Loop
        </Btn>
        <span className="flex-1" />
        <label className="flex items-center gap-1 text-xs text-neutral-300">
          <span className="sr-only">Preview zoom</span>
          <select
            aria-label="Preview zoom"
            className="rounded bg-neutral-800 px-1 py-0.5"
            value={String(zoom)}
            onChange={(e) =>
              ui.getState().set({
                previewZoom: e.target.value === 'fit' ? 'fit' : Number(e.target.value),
              })
            }
          >
            <option value="fit">Fit</option>
            <option value="0.25">25 %</option>
            <option value="0.5">50 %</option>
            <option value="1">100 %</option>
          </select>
        </label>
        <Btn label="Safe area" pressed={safeArea} onClick={() => run('toggleSafeArea')}>
          Safe
        </Btn>
        <Btn label="Render this frame" onClick={() => run('renderFrame')}>
          Still
        </Btn>
      </div>
    </section>
  );
}
