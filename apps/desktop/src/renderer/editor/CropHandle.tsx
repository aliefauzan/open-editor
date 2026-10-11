// Drag handle on the preview for the crop of the selected video clip (app spec "Inspector": manual
// framing "with a drag handle on the preview"; "Pin frame here" pins the user then drags, D-15). It
// edits the static crop (`manual` without pins) or the pin at the playhead. Drags are coalesced into
// one undo entry (`frame:<itemId>`).
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Frame, MediaClip } from '../../shared/project.ts';
import { useCtx, useEditorShallow } from './context.tsx';
import { seqOf } from './editing.ts';
import { findItem } from './entities.ts';
import { frameOf } from './time.ts';

export function CropHandle() {
  const { editor } = useCtx();
  const target = useEditorShallow((s) => {
    const q = seqOf(s.project, s.sequenceId);
    if (!q || s.selection.length === 0) return null;
    const f = s.selection
      .map((id) => findItem(q, id))
      .find((x) => x?.kind === 'video' && x.item.type === 'media');
    if (!f) return null;
    const clip = f.item as MediaClip;
    const frame = clip.frame;
    if (!frame || frame.mode === 'cover' || frame.mode === 'contain') return null;
    const rel = s.playheadMs - clip.startMs;
    if (rel < 0 || rel >= clip.durationMs) return null;
    const pins = frame.keyframes ?? [];
    // the pin on the playhead's frame, else the static crop of a manual clip
    const pin = pins.find((k) => frameOf(k.atMs, q.canvas.fps) === frameOf(rel, q.canvas.fps));
    if (!pin && (frame.mode !== 'manual' || pins.length > 0)) return null;
    return { seqId: q.id, clip, frame, pinAt: pin?.atMs };
  });
  if (!target) return null;
  const { frame, clip } = target;
  const pin =
    target.pinAt === undefined ? undefined : frame.keyframes!.find((k) => k.atMs === target.pinAt);
  const x = pin?.x ?? frame.x ?? 0.5;
  const y = pin?.y ?? frame.y ?? 0.5;
  const clamp = (v: number) => Math.min(1, Math.max(0, Math.round(v * 1000) / 1000));
  const send = (nx: number, ny: number) => {
    const next: Frame =
      pin === undefined
        ? { ...frame, x: nx, y: ny }
        : {
            ...frame,
            keyframes: frame.keyframes!.map((k) =>
              k.atMs === pin.atMs ? { ...k, x: nx, y: ny } : k,
            ),
          };
    void editor.getState().setField('frame', clip.id, {
      op: 'updateClip',
      args: { sequenceId: target.seqId, itemId: clip.id, frame: next },
    });
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const x0 = e.clientX;
    const y0 = e.clientY;
    // dragging the picture right moves the crop centre left
    const move = (ev: PointerEvent) =>
      send(clamp(x - (ev.clientX - x0) / box.width), clamp(y - (ev.clientY - y0) / box.height));
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };
  return (
    <div
      role="slider"
      aria-label={pin ? 'Pinned crop' : 'Crop'}
      aria-valuetext={`${x.toFixed(2)}, ${y.toFixed(2)}`}
      tabIndex={0}
      data-testid="crop-handle"
      onPointerDown={onDown}
      onKeyDown={(e) => {
        // arrow keys pan the picture by 1 % (and do not step frames)
        const d = {
          ArrowLeft: [0.01, 0],
          ArrowRight: [-0.01, 0],
          ArrowUp: [0, 0.01],
          ArrowDown: [0, -0.01],
        }[e.key as 'ArrowLeft'];
        if (!d) return;
        e.preventDefault();
        send(clamp(x + d[0]!), clamp(y + d[1]!));
      }}
      className="absolute z-10 h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-move rounded-full border-2 border-white bg-indigo-500/70 shadow"
      // the crop centre is always the middle of the frame: the handle pans the picture under it
      style={{ left: '50%', top: '50%' }}
    />
  );
}
