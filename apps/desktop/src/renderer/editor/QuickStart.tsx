// The start screen (app spec "Quick clips (start screen)"; plan D-11, D-13): one field for a link or a
// dropped video, "Choose file…", a platform badge, "How many clips" and "Length", one progress view;
// below it the recent projects and "New empty project".
import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { ErrorData, ProjectSummary } from '../../shared/api.ts';
import { useCtx } from './context.tsx';
import {
  isLink,
  lengthRange,
  makeQuickClips,
  type QuickInput,
  type QuickOutcome,
  type QuickProgress,
} from './quick-flow.ts';

const BADGE: Record<string, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  other: 'Link',
};

export interface QuickStartProps {
  projects: ProjectSummary[];
  onOpen(id: string): void;
  onCreate(name: string): void;
  onDone(o: Extract<QuickOutcome, { ok: true }>): void;
  onOpenSetup?(): void;
}

export function QuickStart(props: QuickStartProps) {
  const { vox, jobs } = useCtx();
  const [text, setText] = useState('');
  const [badge, setBadge] = useState<string | null>(null);
  const [count, setCount] = useState(3);
  const [minS, setMinS] = useState(30);
  const [maxS, setMaxS] = useState(60);
  const [busy, setBusy] = useState<QuickProgress | null>(null);
  const [error, setError] = useState<ErrorData | null>(null);
  const [name, setName] = useState('');
  const retryProject = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!isLink(text)) {
      setBadge(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void vox.media.classifyUrl(text.trim()).then(
        (k) => live && setBadge(BADGE[k as string] ?? null),
        () => live && setBadge(null),
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [text, vox]);

  const range = lengthRange(minS, maxS);
  const countOk = Number.isInteger(count) && count >= 1 && count <= 20;

  const run = async (input: QuickInput) => {
    if (!range || !countOk) return;
    setError(null);
    setBusy({ progress: 0, message: 'Starting' });
    const o = await makeQuickClips(
      vox,
      jobs,
      input,
      { count, ...range },
      setBusy,
      retryProject.current,
    );
    setBusy(null);
    if (o.ok) {
      retryProject.current = undefined;
      props.onDone(o);
      return;
    }
    // keep the project for a second attempt (e.g. choose the file after LOGIN_REQUIRED)
    retryProject.current = o.projectId;
    if (!o.cancelled) setError(o.error);
  };

  const submit = () => {
    if (!isLink(text)) {
      setError({
        code: 'VALIDATION',
        message: 'That is not a link',
        hint: 'Paste an http(s) link from YouTube, Instagram or TikTok, or choose a file.',
      });
      return;
    }
    void run({ kind: 'url', url: text });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (busy) return;
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) void run({ kind: 'drop', files: Array.from(files) });
  };

  const field = 'rounded bg-neutral-900 px-2 py-1 text-sm';
  return (
    <main
      className="mx-auto flex h-full w-full max-w-2xl flex-col gap-6 overflow-y-auto p-8"
      data-testid="quick-start"
    >
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Quick clips</h1>
        {props.onOpenSetup && (
          <button
            type="button"
            data-testid="open-setup"
            className="text-xs text-neutral-400 underline"
            onClick={props.onOpenSetup}
          >
            Setup
          </button>
        )}
      </div>
      <form
        className="flex flex-col gap-3 rounded-lg border border-dashed border-neutral-700 p-4"
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex items-center gap-2">
          <input
            aria-label="Link or video file"
            className={`${field} min-w-0 flex-1`}
            placeholder="Paste a YouTube, Instagram or TikTok link, or drop a video file"
            value={text}
            disabled={busy !== null}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
          />
          {badge && (
            <span
              data-testid="platform-badge"
              className="rounded bg-indigo-700 px-2 py-0.5 text-xs font-medium"
            >
              {badge}
            </span>
          )}
          <button
            type="button"
            className="rounded bg-neutral-800 px-3 py-1 text-sm"
            disabled={busy !== null || !range || !countOk}
            onClick={() => void run({ kind: 'file' })}
          >
            Choose file…
          </button>
        </div>
        <div className="flex flex-wrap items-end gap-4 text-xs text-neutral-300">
          <label className="flex flex-col gap-1">
            How many clips
            <input
              type="number"
              min={1}
              max={20}
              className={`${field} w-20`}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            />
          </label>
          <fieldset className="flex items-end gap-1">
            <legend className="mb-1">Length (seconds)</legend>
            <input
              aria-label="Shortest clip (s)"
              type="number"
              min={1}
              max={600}
              className={`${field} w-20`}
              value={minS}
              onChange={(e) => setMinS(Number(e.target.value))}
            />
            <span className="pb-1">–</span>
            <input
              aria-label="Longest clip (s)"
              type="number"
              min={1}
              max={600}
              className={`${field} w-20`}
              value={maxS}
              onChange={(e) => setMaxS(Number(e.target.value))}
            />
          </fieldset>
          <button
            type="submit"
            className="ml-auto rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            disabled={busy !== null || !range || !countOk}
          >
            Make clips
          </button>
        </div>
        {(!range || !countOk) && (
          <p className="text-xs text-amber-400">
            Clips: 1–20; length: 1–600 s with the shortest not above the longest.
          </p>
        )}
        {busy && (
          <div className="flex flex-col gap-1" data-testid="quick-progress">
            <div
              role="progressbar"
              aria-label="Making clips"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(busy.progress * 100)}
              className="h-2 overflow-hidden rounded bg-neutral-800"
            >
              <div
                className="h-full bg-indigo-500"
                style={{ width: `${Math.round(busy.progress * 100)}%` }}
              />
            </div>
            <p className="text-xs text-neutral-400">{busy.message}</p>
          </div>
        )}
        {error && (
          <div role="alert" className="rounded bg-red-950 p-2 text-xs" data-testid="quick-error">
            <p className="font-medium">{error.message}</p>
            {error.hint && <p className="mt-1 text-neutral-300">{error.hint}</p>}
            {error.code === 'LOGIN_REQUIRED' && (
              <button
                type="button"
                className="mt-2 rounded bg-neutral-800 px-2 py-1"
                onClick={() => void run({ kind: 'file' })}
              >
                Choose file…
              </button>
            )}
          </div>
        )}
      </form>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Recent projects</h2>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) {
              props.onCreate(name.trim());
              setName('');
            }
          }}
        >
          <input
            aria-label="New project name"
            className={`${field} min-w-0 flex-1`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
          />
          <button type="submit" className="rounded bg-neutral-800 px-3 py-1 text-sm">
            New empty project
          </button>
        </form>
        <ul className="space-y-1" data-testid="projects">
          {props.projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                data-project-id={p.id}
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-800"
                onClick={() => props.onOpen(p.id)}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
