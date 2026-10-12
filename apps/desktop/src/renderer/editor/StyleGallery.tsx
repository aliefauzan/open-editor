// Style gallery (app spec "Style gallery"): installed styles with animated previews and
// status badges; the detail view lists templates and transitions (fixture previews over
// `vox-media://styles/…`), overlays and caption presets; "Set as style for this sequence" is one
// `updateSequence` op, batched with the style's default caption preset when the sequence shows
// captions in another preset (D-93: the preset brings its position). "New style from reference video" (Part C, phase 15) runs one `style.extract`
// job and shows its static report in a sandboxed frame before Accept or Discard.
import { useState } from 'react';
import { useStore } from 'zustand';
import type { ResolvedStyleData, StyleSummaryData } from '../../shared/project.ts';
import { useCtx, useEditor, useUi } from './context.tsx';
import type { OpCall } from './store.ts';
import { previewUrl, templateColor, useResolvedStyle, useStyleList } from './use-styles.ts';

/** "Set as style for this sequence": the style, and its default caption preset (D-93). */
export function setStyleOp(
  sequenceId: string,
  style: Pick<ResolvedStyleData, 'id' | 'style'>,
  captions: { enabled: boolean; preset: string } | null | undefined,
): OpCall {
  const set: OpCall = { op: 'updateSequence', args: { sequenceId, styleId: style.id } };
  const preset = style.style.captions?.default;
  if (!captions?.enabled || !preset || captions.preset === preset) return set;
  return {
    op: 'batch',
    args: { ops: [set, { op: 'setCaptions', args: { sequenceId, preset } }] },
  };
}

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
  const captions = useEditor(
    (s) => s.project?.sequences.find((q) => q.id === s.sequenceId)?.captions,
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
            sequenceId && void editor.getState().apply(setStyleOp(sequenceId, style, captions))
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

/** What a finished `style.extract` job returns (agent `StyleExtractResult`, the fields shown here). */
interface ExtractResult {
  styleId: string;
  extends: string;
  validate: { ok: boolean; problems: string[] };
  unmatchedLayouts: string[];
  limits: string;
}

const LIMITS_NOTE =
  'The draft re-skins existing templates with the measured colours, pacing and captions and the closest free fonts. It copies no footage, images, brand marks or sound. A draft never runs its own code.';

/**
 * "New style from reference video" (Part C): a link or a local file, a name, one `style.extract` job
 * with progress, then the static report in a sandboxed frame with Accept and Discard.
 */
function Extract(props: { onDone(id: string | null): void; onChanged(): void }) {
  const { vox, jobs } = useCtx();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractResult | null>(null);
  const row = useStore(jobs, (s) => (jobId ? s.rows.find((r) => r.id === jobId) : undefined));
  const running = jobId !== null && result === null && row?.status !== 'failed';

  async function start(link: string | undefined) {
    setError(null);
    setResult(null);
    try {
      const r = (await vox.styles.extract({
        name: name.trim(),
        ...(link ? { url: link } : {}),
      })) as { jobId: string } | null;
      if (!r) return;
      setJobId(r.jobId);
      const done = await jobs.getState().track(r.jobId, 'style.extract', `Style: ${name.trim()}`);
      if (done.status === 'done') {
        setResult(done.result as ExtractResult);
        props.onChanged();
      } else {
        setError(done.error?.message ?? 'The extraction stopped.');
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function settle(accept: boolean) {
    if (!result) return;
    try {
      if (accept) await vox.styles.accept(result.styleId);
      else await vox.styles.remove(result.styleId);
      props.onChanged();
      props.onDone(accept ? result.styleId : null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const ready = name.trim().length > 0 && !running;
  return (
    <section
      aria-label="New style from reference video"
      className="flex flex-col gap-2 rounded border border-neutral-700 p-3 text-xs"
    >
      <h3 className="text-sm font-semibold">New style from reference video</h3>
      {!result && (
        <>
          <p className="text-neutral-400">{LIMITS_NOTE}</p>
          <label className="flex items-center gap-2">
            <span className="w-24">Name</span>
            <input
              aria-label="Style name"
              className="flex-1 rounded bg-neutral-800 px-2 py-1"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="w-24">Video link</span>
            <input
              aria-label="Reference video link"
              className="flex-1 rounded bg-neutral-800 px-2 py-1"
              placeholder="https://…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded bg-indigo-600 px-2 py-1 text-white disabled:opacity-50"
              disabled={!ready || !/^https?:\/\//i.test(url.trim())}
              onClick={() => void start(url.trim())}
            >
              Extract from link
            </button>
            <button
              type="button"
              className="rounded bg-neutral-700 px-2 py-1 disabled:opacity-50"
              disabled={!ready}
              onClick={() => void start(undefined)}
            >
              Choose video file…
            </button>
          </div>
        </>
      )}
      {running && (
        <div role="status" aria-label="Extraction progress">
          <progress className="w-full" max={1} value={row?.progress ?? 0} />
          <p className="text-neutral-400">{row?.message ?? 'Starting…'}</p>
        </div>
      )}
      {error && (
        <p role="alert" className="rounded bg-red-950 p-2">
          {error}
        </p>
      )}
      {result && (
        <div className="flex flex-col gap-2" data-testid="extract-result">
          <p>
            Draft <strong>{result.styleId}</strong> (from {result.extends}):{' '}
            {result.validate.ok
              ? 'checks passed.'
              : `${result.validate.problems.length} problem(s) found.`}
          </p>
          <iframe
            title="Style report"
            sandbox=""
            className="h-80 w-full rounded border border-neutral-700 bg-white"
            src={`vox-media://styles/${encodeURIComponent(result.styleId)}/report.html`}
          />
          <p className="text-neutral-400">{result.limits}</p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded bg-indigo-600 px-2 py-1 text-white"
              onClick={() => void settle(true)}
            >
              Accept style
            </button>
            <button
              type="button"
              className="rounded bg-neutral-700 px-2 py-1"
              onClick={() => void settle(false)}
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function StyleGallery() {
  const { ui } = useCtx();
  const open = useUi((s) => s.galleryOpen);
  const extract = useUi((s) => s.galleryExtract);
  const [version, setVersion] = useState(0);
  const list = useStyleList(version);
  const [detail, setDetail] = useState<string | null>(null);
  const setExtract = (on: boolean) => ui.getState().set({ galleryExtract: on });
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
          {!extract && !detail && (
            <button
              type="button"
              className="mr-3 ml-auto rounded bg-neutral-800 px-2 py-0.5 text-xs"
              onClick={() => setExtract(true)}
            >
              New style from reference video
            </button>
          )}
          <button
            type="button"
            aria-label="Close"
            onClick={() => ui.getState().set({ galleryOpen: false, galleryExtract: false })}
          >
            ×
          </button>
        </div>
        {extract && (
          <Extract
            onChanged={() => setVersion((v) => v + 1)}
            onDone={(id) => {
              setExtract(false);
              setDetail(id);
            }}
          />
        )}
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
