// Inspector (app spec "Main editor" → Inspector; D-14, D-15): the selected media clip (video: in/out,
// framing incl. stability, track speed and "Pin frame here"; image motion; transition; audio: in/out,
// volume, fades, denoise), scene clip (JSON-Schema form, template switcher, transition, sound cues
// with mute toggles) or, with nothing selected, the sequence's caption settings. Sliders and text
// fields send an op per change with coalesceKey `<field>:<itemId>` (D-15).
import { useEffect, useState } from 'react';
import type {
  CaptionTrack,
  Frame,
  FrameMode,
  Item,
  MediaClip,
  SceneClip,
  Sequence,
} from '../../shared/project.ts';
import { useCtx, useEditor } from './context.tsx';
import { mediaName, relink } from './MediaBin.tsx';
import { endOf, seqOf } from './editing.ts';
import { findItem } from './entities.ts';
import { SchemaForm } from './SchemaForm.tsx';
import { shortTime, snapMs } from './time.ts';
import { templateName, useResolvedStyle } from './use-styles.ts';

/** A stable empty list for selectors (a new [] each time would re-render forever). */
const NONE: never[] = [];

const input = 'w-full rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-100';
const h3 = 'mb-1 text-[11px] font-semibold tracking-wide text-neutral-400 uppercase';

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={props.title} className="space-y-2 border-b border-neutral-800 p-3">
      <h3 className={h3}>{props.title}</h3>
      {props.children}
    </section>
  );
}

function Row(props: { label: string; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-center gap-2 text-xs">
      <label htmlFor={props.htmlFor} className="text-neutral-400">
        {props.label}
      </label>
      <div>{props.children}</div>
    </div>
  );
}

/** A number field that commits on Enter / blur (one op). */
function NumberField(props: {
  id: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(props.value)), [props.value]);
  const commit = () => {
    const v = Number(text);
    if (Number.isFinite(v) && v !== props.value) props.onCommit(v);
    else setText(String(props.value));
  };
  return (
    <span className="flex items-center gap-1">
      <input
        id={props.id}
        type="number"
        className={input}
        value={text}
        min={props.min}
        max={props.max}
        step={props.step}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {props.suffix && <span className="text-neutral-500">{props.suffix}</span>}
    </span>
  );
}

/** A slider: one op per change, all with one coalesceKey (one undo entry per drag, D-15). */
function Slider(props: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <span className="flex items-center gap-2">
      <input
        id={props.id}
        type="range"
        aria-label={props.label}
        className="w-full accent-indigo-500"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <span className="w-12 text-right text-neutral-300 tabular-nums">
        {props.format ? props.format(props.value) : props.value}
      </span>
    </span>
  );
}

function useApply(s: Sequence, item: Item) {
  const { editor } = useCtx();
  const op = item.type === 'scene' ? 'updateScene' : 'updateClip';
  return {
    /** One op (a select, a button, a committed number). */
    now: (args: Record<string, unknown>) =>
      void editor.getState().apply({ op, args: { sequenceId: s.id, itemId: item.id, ...args } }),
    /** A slider or text change: coalesced per field and item. */
    field: (field: string, args: Record<string, unknown>) =>
      void editor
        .getState()
        .setField(field, item.id, { op, args: { sequenceId: s.id, itemId: item.id, ...args } }),
  };
}

function Timing(props: { s: Sequence; item: Item }) {
  const { editor } = useCtx();
  const { s, item } = props;
  const trim = (edge: 'start' | 'end', toMs: number) =>
    void editor.getState().apply({
      op: 'trimItem',
      args: { sequenceId: s.id, itemId: item.id, edge, toMs: snapMs(toMs, s.canvas.fps) },
    });
  const inMs = item.type === 'media' ? item.inMs : 0;
  return (
    <>
      <Row label="Start" htmlFor="in-start">
        <NumberField
          id="in-start"
          value={item.startMs}
          min={0}
          step={1}
          suffix="ms"
          onCommit={(v) =>
            void editor.getState().apply({
              op: 'moveItem',
              args: {
                sequenceId: s.id,
                itemId: item.id,
                startMs: snapMs(Math.max(0, v), s.canvas.fps),
              },
            })
          }
        />
      </Row>
      {item.type === 'media' && (
        <Row label="In point" htmlFor="in-in">
          <NumberField
            id="in-in"
            value={inMs}
            min={0}
            suffix="ms"
            onCommit={(v) => trim('start', item.startMs + (v - inMs))}
          />
        </Row>
      )}
      <Row label={item.type === 'media' ? 'Out point' : 'End'} htmlFor="in-out">
        <NumberField
          id="in-out"
          value={item.type === 'media' ? inMs + item.durationMs : endOf(item)}
          min={0}
          suffix="ms"
          onCommit={(v) => trim('end', item.type === 'media' ? item.startMs + (v - inMs) : v)}
        />
      </Row>
    </>
  );
}

function TransitionRow(props: { s: Sequence; item: Item }) {
  const { editor } = useCtx();
  const style = useResolvedStyle(props.s.styleId);
  const transitions = Object.values(style?.templates ?? {}).filter((t) => t.kind === 'transition');
  const cur = props.item.transitionIn;
  return (
    <Row label="Transition in" htmlFor="in-tx">
      <select
        id="in-tx"
        className={input}
        value={cur?.template ?? ''}
        onChange={(e) => {
          const t = style?.templates[e.target.value];
          void editor.getState().apply({
            op: 'setTransition',
            args: {
              sequenceId: props.s.id,
              itemId: props.item.id,
              transition: t
                ? { template: t.id, durationMs: cur?.durationMs ?? t.durationMs.default }
                : null,
            },
          });
        }}
      >
        <option value="">None</option>
        {transitions.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </Row>
  );
}

const MODES: { id: FrameMode; label: string }[] = [
  { id: 'cover', label: 'Fill (cover)' },
  { id: 'contain', label: 'Fit (contain)' },
  { id: 'auto', label: 'Auto' },
  { id: 'facetrack', label: 'Face track' },
  { id: 'manual', label: 'Manual' },
];

/** The crop at `atMs` (item time): the nearest pin before it, else the static crop, else centre. */
export function cropAt(
  frame: Frame | undefined,
  atMs: number,
): { x: number; y: number; scale: number } {
  const pins = [...(frame?.keyframes ?? [])].sort((a, b) => a.atMs - b.atMs);
  const before = pins.filter((k) => k.atMs <= atMs).at(-1) ?? pins[0];
  if (before) return { x: before.x, y: before.y, scale: before.scale };
  return { x: frame?.x ?? 0.5, y: frame?.y ?? 0.5, scale: frame?.scale ?? 1 };
}

function Framing(props: { s: Sequence; item: MediaClip }) {
  const { s, item } = props;
  const a = useApply(s, item);
  const playheadMs = useEditor((x) => x.playheadMs);
  const frame: Frame = item.frame ?? { mode: 'cover' };
  const tracked = frame.mode === 'auto' || frame.mode === 'facetrack';
  const setFrame = (patch: Partial<Frame>) => a.now({ frame: { ...frame, ...patch } });
  const fieldFrame = (field: string, patch: Partial<Frame>) =>
    a.field(field, { frame: { ...frame, ...patch } });
  const rel = playheadMs - item.startMs;
  const inside = rel >= 0 && rel < item.durationMs;
  const pins = [...(frame.keyframes ?? [])].sort((x, y) => x.atMs - y.atMs);
  const crop = cropAt(frame, rel);
  return (
    <>
      <Row label="Framing" htmlFor="in-mode">
        <select
          id="in-mode"
          className={input}
          value={frame.mode}
          onChange={(e) => setFrame({ mode: e.target.value as FrameMode })}
        >
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </Row>
      {frame.mode === 'facetrack' && (
        <Row label="Face" htmlFor="in-face">
          <select
            id="in-face"
            className={input}
            value={frame.faceIndex ?? ''}
            onChange={(e) =>
              setFrame({ faceIndex: e.target.value === '' ? undefined : Number(e.target.value) })
            }
          >
            <option value="">Largest face</option>
            {[0, 1, 2, 3].map((i) => (
              <option key={i} value={i}>
                Face {i + 1}
              </option>
            ))}
          </select>
        </Row>
      )}
      {tracked && (
        <>
          <Row label="Stability" htmlFor="in-stab">
            <select
              id="in-stab"
              className={input}
              value={frame.stability ?? 'smooth'}
              onChange={(e) => setFrame({ stability: e.target.value as Frame['stability'] })}
            >
              <option value="locked">Locked</option>
              <option value="smooth">Smooth</option>
              <option value="follow">Follow</option>
            </select>
          </Row>
          <Row label="Track speed" htmlFor="in-speed">
            <select
              id="in-speed"
              className={input}
              value={frame.trackSpeed ?? 'normal'}
              onChange={(e) => setFrame({ trackSpeed: e.target.value as Frame['trackSpeed'] })}
            >
              <option value="slow">Slow</option>
              <option value="normal">Normal</option>
              <option value="fast">Fast</option>
            </select>
          </Row>
        </>
      )}
      {frame.mode === 'manual' && pins.length === 0 && (
        <>
          <Row label="Crop X" htmlFor="in-x">
            <Slider
              id="in-x"
              label="Crop X"
              min={0}
              max={1}
              step={0.01}
              value={frame.x ?? 0.5}
              format={(v) => v.toFixed(2)}
              onChange={(v) => fieldFrame('frame', { x: v })}
            />
          </Row>
          <Row label="Crop Y" htmlFor="in-y">
            <Slider
              id="in-y"
              label="Crop Y"
              min={0}
              max={1}
              step={0.01}
              value={frame.y ?? 0.5}
              format={(v) => v.toFixed(2)}
              onChange={(v) => fieldFrame('frame', { y: v })}
            />
          </Row>
          <Row label="Zoom" htmlFor="in-scale">
            <Slider
              id="in-scale"
              label="Zoom"
              min={1}
              max={4}
              step={0.05}
              value={frame.scale ?? 1}
              format={(v) => `${v.toFixed(2)}×`}
              onChange={(v) => fieldFrame('frame', { scale: v })}
            />
          </Row>
        </>
      )}
      {frame.mode !== 'cover' && frame.mode !== 'contain' && (
        <div className="space-y-1">
          <button
            type="button"
            disabled={!inside}
            title={inside ? 'Pin the crop at the playhead' : 'Move the playhead over this clip'}
            className="rounded bg-indigo-600 px-2 py-1 text-xs text-white disabled:opacity-40"
            onClick={() => {
              const atMs = snapMs(rel, s.canvas.fps);
              const keep = pins.filter((k) => k.atMs !== atMs);
              setFrame({ keyframes: [...keep, { atMs, ...crop }].sort((x, y) => x.atMs - y.atMs) });
            }}
          >
            Pin frame here
          </button>
          {pins.length > 0 && (
            <ul aria-label="Pinned frames" className="space-y-1">
              {pins.map((k) => (
                <li key={k.atMs} className="flex items-center justify-between text-xs">
                  <span className="tabular-nums">
                    {shortTime(k.atMs)} · {k.x.toFixed(2)}, {k.y.toFixed(2)} · {k.scale.toFixed(2)}×
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove pin at ${shortTime(k.atMs)}`}
                    className="text-red-300"
                    onClick={() => {
                      const rest = pins.filter((p) => p.atMs !== k.atMs);
                      setFrame({ keyframes: rest.length > 0 ? rest : undefined });
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

function MediaInspector(props: { s: Sequence; item: MediaClip; kind: 'video' | 'audio' }) {
  const { s, item } = props;
  const a = useApply(s, item);
  const media = useEditor((x) => x.project?.media.find((m) => m.id === item.mediaId));
  const offline = useEditor((x) => x.offline.includes(item.mediaId));
  const ctx = useCtx();
  const isImage = media?.kind === 'image';
  return (
    <Section title={props.kind === 'audio' ? 'Audio clip' : isImage ? 'Image clip' : 'Video clip'}>
      <p className="truncate text-xs text-neutral-300" title={media?.path}>
        {media && !offline ? mediaName(media) : 'Offline: the media file is missing'}
      </p>
      {offline && (
        <button
          type="button"
          className="rounded bg-red-800 px-2 py-0.5 text-xs text-white"
          onClick={() => void relink(ctx, item.mediaId)}
        >
          Relink…
        </button>
      )}
      <Timing s={s} item={item} />
      {props.kind === 'video' && <Framing s={s} item={item} />}
      {props.kind === 'video' && isImage && (
        <Row label="Motion" htmlFor="in-motion">
          <select
            id="in-motion"
            className={input}
            value={item.motion?.type ?? 'none'}
            onChange={(e) =>
              a.now({
                motion:
                  e.target.value === 'none'
                    ? null
                    : { type: e.target.value, amount: item.motion?.amount ?? 0.1 },
              })
            }
          >
            <option value="none">None</option>
            <option value="push-in">Push in</option>
            <option value="pan">Pan</option>
          </select>
        </Row>
      )}
      {props.kind === 'video' && <TransitionRow s={s} item={item} />}
      {props.kind === 'audio' && (
        <>
          <Row label="Volume" htmlFor="in-vol">
            <Slider
              id="in-vol"
              label="Volume"
              min={0}
              max={2}
              step={0.01}
              value={item.volume ?? 1}
              format={(v) => `${Math.round(v * 100)} %`}
              onChange={(v) => a.field('volume', { volume: v })}
            />
          </Row>
          <Row label="Fade in" htmlFor="in-fin">
            <Slider
              id="in-fin"
              label="Fade in"
              min={0}
              max={Math.min(5000, item.durationMs)}
              step={50}
              value={item.fadeInMs ?? 0}
              format={shortTime}
              onChange={(v) => a.field('fadeIn', { fadeInMs: v || null })}
            />
          </Row>
          <Row label="Fade out" htmlFor="in-fout">
            <Slider
              id="in-fout"
              label="Fade out"
              min={0}
              max={Math.min(5000, item.durationMs)}
              step={50}
              value={item.fadeOutMs ?? 0}
              format={shortTime}
              onChange={(v) => a.field('fadeOut', { fadeOutMs: v || null })}
            />
          </Row>
          <Row label="Denoise" htmlFor="in-dn">
            <select
              id="in-dn"
              className={input}
              value={item.denoise ?? 'off'}
              onChange={(e) => a.now({ denoise: e.target.value === 'off' ? null : e.target.value })}
            >
              <option value="off">Off</option>
              <option value="light">Light</option>
              <option value="strong">Strong</option>
            </select>
          </Row>
        </>
      )}
    </Section>
  );
}

function SceneInspector(props: { s: Sequence; item: SceneClip }) {
  const { s, item } = props;
  const a = useApply(s, item);
  const style = useResolvedStyle(s.styleId);
  const media = useEditor((x) => x.project?.media ?? NONE);
  const t = style?.templates[item.template];
  // compatible = scene templates of the same style chain (the switch keeps the variables it can)
  const scenes = Object.values(style?.templates ?? {}).filter((x) => x.kind === 'scene');
  const off = new Set(item.sfxOff ?? []);
  return (
    <Section title="Scene">
      <Row label="Template" htmlFor="in-tpl">
        <select
          id="in-tpl"
          className={input}
          value={item.template}
          onChange={(e) => {
            const next = style?.templates[e.target.value];
            if (!next) return;
            const keys = Object.keys(next.variables.properties ?? {});
            const vars = Object.fromEntries(
              Object.entries(item.variables).filter(([k]) => keys.includes(k)),
            );
            a.now({ template: next.id, variables: vars, sfxOff: [] });
          }}
        >
          {!t && <option value={item.template}>{templateName(undefined, item.template)}</option>}
          {scenes.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </Row>
      <Timing s={s} item={item} />
      <TransitionRow s={s} item={item} />
      {t ? (
        <SchemaForm
          schema={t.variables}
          value={item.variables}
          env={{ media, templates: style?.templates ?? {}, slots: t.slots }}
          onChange={(variables) => a.field('variables', { variables })}
        />
      ) : (
        <p className="text-xs text-neutral-500">Loading the template…</p>
      )}
      {(t?.sfxCues ?? []).length > 0 && (
        <div>
          <h4 className={h3}>Sound cues</h4>
          <ul className="space-y-1" aria-label="Sound cues">
            {t!.sfxCues!.map((c) => (
              <li key={c.name} className="flex items-center justify-between text-xs">
                <span>
                  {c.name} · {c.type} · {c.atMs === 'entrance' ? 'entrance' : shortTime(c.atMs)}
                </span>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={!off.has(c.name)}
                    aria-label={`Play cue ${c.name}`}
                    onChange={() => {
                      const next = new Set(off);
                      if (next.has(c.name)) next.delete(c.name);
                      else next.add(c.name);
                      a.now({ sfxOff: [...next].sort() });
                    }}
                  />
                  On
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function CaptionsInspector(props: { s: Sequence }) {
  const { editor } = useCtx();
  const { s } = props;
  const style = useResolvedStyle(s.styleId);
  const c: CaptionTrack | null = s.captions;
  const set = (args: Record<string, unknown>) =>
    void editor.getState().apply({ op: 'setCaptions', args: { sequenceId: s.id, ...args } });
  const field = (name: string, args: Record<string, unknown>) =>
    void editor
      .getState()
      .setField(name, s.id, { op: 'setCaptions', args: { sequenceId: s.id, ...args } });
  if (!c) {
    return (
      <Section title="Captions">
        <button
          type="button"
          className="rounded bg-neutral-800 px-2 py-1 text-xs"
          onClick={() => set({ enabled: true })}
        >
          Add captions
        </button>
      </Section>
    );
  }
  const presets = Object.values(style?.captionPresets ?? {});
  return (
    <Section title="Captions">
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={c.enabled} onChange={() => set({ enabled: !c.enabled })} />
        Show captions
      </label>
      <Row label="Preset" htmlFor="cap-preset">
        <select
          id="cap-preset"
          className={input}
          value={c.preset}
          onChange={(e) => set({ preset: e.target.value })}
        >
          {!presets.some((p) => p.id === c.preset) && <option value={c.preset}>{c.preset}</option>}
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name ?? p.id}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Words per chunk" htmlFor="cap-words">
        <NumberField
          id="cap-words"
          value={c.maxWords}
          min={1}
          max={20}
          onCommit={(v) => set({ maxWords: Math.round(v) })}
        />
      </Row>
      <Row label="Max lines" htmlFor="cap-lines">
        <NumberField
          id="cap-lines"
          value={c.maxLines}
          min={1}
          max={4}
          onCommit={(v) => set({ maxLines: Math.round(v) })}
        />
      </Row>
      <Row label="Chars per line" htmlFor="cap-chars">
        <NumberField
          id="cap-chars"
          value={c.maxCharsPerLine}
          min={1}
          max={200}
          onCommit={(v) => set({ maxCharsPerLine: Math.round(v) })}
        />
      </Row>
      <Row label="Gap fill" htmlFor="cap-gap">
        <Slider
          id="cap-gap"
          label="Gap fill"
          min={0}
          max={2000}
          step={50}
          value={c.gapFillMs}
          format={(v) => `${v} ms`}
          onChange={(v) => field('gapFill', { gapFillMs: v })}
        />
      </Row>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={c.autoEmphasis === true}
          onChange={() => set({ autoEmphasis: !c.autoEmphasis })}
        />
        Auto-emphasis (numbers, names)
      </label>
      <Row label="Position" htmlFor="cap-pos">
        <Slider
          id="cap-pos"
          label="Vertical position"
          min={0}
          max={100}
          step={1}
          value={c.position.yPct}
          format={(v) => `${v} %`}
          onChange={(v) => field('position', { position: { yPct: v } })}
        />
      </Row>
      <p className="text-[11px] text-neutral-500">The safe area comes from the preset.</p>
    </Section>
  );
}

export function Inspector() {
  const s = useEditor((x) => seqOf(x.project, x.sequenceId));
  const selection = useEditor((x) => x.selection);
  if (!s)
    return (
      <aside aria-label="Inspector" className="h-full w-full overflow-y-auto bg-neutral-900" />
    );
  // a linked pair: the clip on the video track leads; alt-select one to edit the other
  const found = selection
    .map((id) => findItem(s, id))
    .filter((x) => x !== undefined)
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'video' ? -1 : 1));
  const lead = found[0];
  const linkedOnly = found.every((f) => f.item.linkId && f.item.linkId === lead?.item.linkId);
  return (
    <aside
      id="inspector"
      aria-label="Inspector"
      className="h-full w-full overflow-y-auto bg-neutral-900"
    >
      {!lead && <CaptionsInspector s={s} />}
      {lead && found.length > 1 && !linkedOnly && (
        <p className="p-3 text-xs text-neutral-400">{found.length} items selected.</p>
      )}
      {lead && (found.length === 1 || linkedOnly) && lead.item.type === 'media' && (
        <MediaInspector key={lead.item.id} s={s} item={lead.item} kind={lead.kind} />
      )}
      {lead && (found.length === 1 || linkedOnly) && lead.item.type === 'scene' && (
        <SceneInspector key={lead.item.id} s={s} item={lead.item} />
      )}
      {lead && linkedOnly && found.length > 1 && found[1]!.item.type === 'media' && (
        <MediaInspector
          key={found[1]!.item.id}
          s={s}
          item={found[1]!.item as MediaClip}
          kind={found[1]!.kind}
        />
      )}
    </aside>
  );
}
