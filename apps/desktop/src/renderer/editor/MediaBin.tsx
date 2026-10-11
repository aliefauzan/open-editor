// Media bin (bottom left; app spec "Media bin"): grid or list of the project's media with
// thumbnails, duration and tags; search over names, tags, descriptions and transcript text
// (`media.search`); filter by kind and origin; import by dialog, Finder drop (files or folders) or
// link; the archive tab searches Commons/Openverse (`assets.search` job; licence and warnings shown,
// fetch / cutout); right-click → "Replace in timeline with…" or "Relink…" for offline media. Items drag
// onto the timeline as `application/x-vox-media` (a linked pair when the video has audio).
import { useEffect, useMemo, useState, type DragEvent, type MouseEvent } from 'react';
import type { MediaItem } from '../../shared/project.ts';
import { useCtx, useEditor } from './context.tsx';
import type { JobRow } from './jobs.ts';
import { DRAG_MEDIA } from './Timeline.tsx';

export function mediaName(m: MediaItem): string {
  if (m.origin.url) {
    try {
      const u = new URL(m.origin.url);
      const last = u.pathname.split('/').filter(Boolean).pop();
      return decodeURIComponent(last ?? u.hostname);
    } catch {
      /* fall through */
    }
  }
  return m.description?.split('\n')[0]?.slice(0, 60) || (m.path.split('/').pop() ?? m.id);
}

export function duration(ms: number | undefined): string {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const mediaUrl = (projectId: string, rel: string) =>
  `vox-media://p/${projectId}/${rel.split('/').map(encodeURIComponent).join('/')}`;

/** The first frame of the sprite sheet (10 columns, 90 px high; engine D-31). */
function Thumb(props: { projectId: string; m: MediaItem; offline: boolean }) {
  const { m } = props;
  const w = m.width && m.height ? Math.round((90 * m.width) / m.height) : 160;
  if (props.offline) {
    return (
      <div className="flex aspect-video items-center justify-center bg-red-800 text-[10px] font-semibold text-white">
        offline
      </div>
    );
  }
  if (m.kind === 'video' && m.thumbsPath) {
    return (
      <div
        aria-hidden
        className="aspect-video bg-neutral-800 bg-no-repeat"
        style={{
          backgroundImage: `url("${mediaUrl(props.projectId, m.thumbsPath)}")`,
          backgroundSize: `${w * 10}px auto`,
          backgroundPosition: '0 0',
        }}
      />
    );
  }
  if (m.kind === 'image') {
    return (
      <img
        alt=""
        className="aspect-video w-full bg-neutral-800 object-contain"
        src={mediaUrl(props.projectId, m.proxyPath ?? m.path)}
      />
    );
  }
  return (
    <div className="flex aspect-video items-center justify-center bg-neutral-800 text-[10px] uppercase text-neutral-400">
      {m.kind}
    </div>
  );
}

type Menu = { x: number; y: number; mediaId: string; replace: boolean };

/** Relink offline media: import a new file, then `replaceMedia` (one op) to the new media. */
export async function relink(ctx: ReturnType<typeof useCtx>, mediaId: string): Promise<void> {
  const { vox, editor, jobs } = ctx;
  const id = editor.getState().projectId;
  if (!id) return;
  try {
    const started = (await vox.media.importFiles(id)) as { jobId?: string } | null;
    if (!started?.jobId) return;
    const row = await jobs.getState().track(started.jobId, 'ingest', 'Relink');
    const media = (row.result as { media?: { mediaId: string }[] } | undefined)?.media ?? [];
    const next = media[0]?.mediaId;
    if (row.status !== 'done' || !next) return;
    await editor.getState().reload();
    await editor.getState().apply({ op: 'replaceMedia', args: { mediaId, withMediaId: next } });
    await editor.getState().reload();
  } catch (e) {
    editor.getState().toast(e);
  }
}

const archiveCache = new Map<string, unknown>();

interface Candidate {
  id: string;
  title: string;
  license: string;
  licenseVersion?: string;
  author: string;
  attribution: string;
  warning?: string;
  pageUrl: string;
}

function ArchiveTab() {
  const { jobs, editor } = useCtx();
  const projectId = useEditor((s) => s.projectId);
  const [q, setQ] = useState('');
  const [result, setResult] = useState<{ candidates: Candidate[]; message?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<JobRow['error'] | null>(null);
  const search = async () => {
    if (!projectId || !q.trim()) return;
    const k = `${projectId}\n${q.trim().toLowerCase()}`;
    const hit = archiveCache.get(k);
    if (hit) return setResult(hit as typeof result);
    setBusy(true);
    setError(null);
    const row = await jobs
      .getState()
      .start('assets.search', { projectId, query: q.trim() }, `Archive: ${q.trim()}`);
    setBusy(false);
    if (row.status === 'done') {
      archiveCache.set(k, row.result);
      setResult(row.result as typeof result);
    } else setError(row.error ?? null);
  };
  const fetchOne = async (c: Candidate) => {
    if (!projectId) return;
    const row = await jobs
      .getState()
      .start('assets.fetch', { projectId, candidateId: c.id }, `Fetch: ${c.title}`);
    if (row.status === 'done') await editor.getState().reload();
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2 text-xs" data-testid="archive-tab">
      <form
        className="flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input
          aria-label="Search archive images"
          className="min-w-0 flex-1 rounded bg-neutral-800 px-1 py-0.5"
          placeholder="Search Wikimedia Commons and Openverse"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit" className="rounded bg-neutral-800 px-2" disabled={busy}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>
      {error && (
        <p role="alert" className="text-red-300">
          {error.message} {error.hint && <span className="text-neutral-400">({error.hint})</span>}
        </p>
      )}
      {result?.message === 'no results' && <p className="text-neutral-400">No results.</p>}
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto" aria-label="Archive results">
        {result?.candidates.map((c) => (
          <li key={c.id} className="rounded bg-neutral-900 p-1.5">
            <p className="truncate font-medium" title={c.title}>
              {c.title}
            </p>
            <p className="text-neutral-400">
              {c.license}
              {c.licenseVersion ? ` ${c.licenseVersion}` : ''} · {c.author}
            </p>
            {c.warning && <p className="text-amber-400">{c.warning}</p>}
            <button
              type="button"
              className="mt-1 rounded bg-neutral-800 px-2"
              onClick={() => void fetchOne(c)}
            >
              Fetch
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MediaBin() {
  const ctx = useCtx();
  const { vox, editor, jobs } = ctx;
  const projectId = useEditor((s) => s.projectId);
  const media = useEditor((s) => s.project?.media);
  const offline = useEditor((s) => s.offline);
  const version = useEditor((s) => s.version);
  const [tab, setTab] = useState<'library' | 'archive'>('library');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Set<string> | null>(null);
  const [kind, setKind] = useState('all');
  const [origin, setOrigin] = useState('all');
  const [url, setUrl] = useState('');
  const [menu, setMenu] = useState<Menu | null>(null);

  useEffect(() => {
    if (!projectId || !q.trim()) return setHits(null);
    let live = true;
    const t = setTimeout(() => {
      void vox.media.search(projectId, q).then(
        (ids) => live && setHits(new Set(ids as string[])),
        () => live && setHits(new Set()),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [vox, projectId, q, version]);

  const list = useMemo(
    () =>
      (media ?? []).filter(
        (m) =>
          (kind === 'all' || m.kind === kind) &&
          (origin === 'all' || m.origin.type === origin) &&
          (!hits || hits.has(m.id)),
      ),
    [media, kind, origin, hits],
  );
  if (!projectId) return null;

  const follow = async (started: unknown, label: string) => {
    const jobId = (started as { jobId?: string } | null)?.jobId;
    if (!jobId) return;
    const row = await jobs.getState().track(jobId, 'ingest', label);
    if (row.status === 'done') await editor.getState().reload();
  };
  const importFiles = () =>
    vox.media.importFiles(projectId).then(
      (r) => follow(r, 'Import'),
      (e: unknown) => editor.getState().toast(e),
    );
  const importUrl = () => {
    if (!url.trim()) return;
    void vox.media.importUrl(projectId, url.trim()).then(
      (r) => {
        setUrl('');
        return follow(r, 'Import link');
      },
      (e: unknown) => editor.getState().toast(e),
    );
  };
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer?.files?.length || !vox.dropFiles) return;
    e.preventDefault();
    void vox.dropFiles(projectId, e.dataTransfer.files).then(
      (r) => follow(r, 'Import'),
      (err: unknown) => editor.getState().toast(err),
    );
  };
  const openMenu = (e: MouseEvent, mediaId: string) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, mediaId, replace: false });
  };
  const target = menu && media?.find((m) => m.id === menu.mediaId);
  const tabBtn = (on: boolean) => `px-2 py-1 ${on ? 'text-white' : 'text-neutral-400'}`;

  return (
    <div
      className="flex h-full min-h-0 flex-col text-xs"
      data-testid="media-bin"
      onDragOver={(e) => e.dataTransfer?.types.includes('Files') && e.preventDefault()}
      onDrop={onDrop}
      onClick={() => setMenu(null)}
    >
      <div role="tablist" aria-label="Media sources" className="flex border-b border-neutral-800">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'library'}
          className={tabBtn(tab === 'library')}
          onClick={() => setTab('library')}
        >
          Library
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'archive'}
          className={tabBtn(tab === 'archive')}
          onClick={() => setTab('archive')}
        >
          Archive
        </button>
      </div>
      {tab === 'archive' ? (
        <ArchiveTab />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1 border-b border-neutral-800 p-1.5">
            <input
              aria-label="Search media"
              placeholder="Search names, tags, transcripts"
              className="min-w-0 flex-1 rounded bg-neutral-800 px-1 py-0.5"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <select
              aria-label="Kind"
              className="rounded bg-neutral-800"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              {['all', 'video', 'audio', 'image', 'document'].map((k) => (
                <option key={k} value={k}>
                  {k === 'all' ? 'All kinds' : k}
                </option>
              ))}
            </select>
            <select
              aria-label="Origin"
              className="rounded bg-neutral-800"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
            >
              {['all', 'upload', 'url', 'archive', 'generated'].map((k) => (
                <option key={k} value={k}>
                  {k === 'all' ? 'All origins' : k}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label={view === 'grid' ? 'List view' : 'Grid view'}
              className="rounded bg-neutral-800 px-1"
              onClick={() => setView(view === 'grid' ? 'list' : 'grid')}
            >
              {view === 'grid' ? '☰' : '▦'}
            </button>
          </div>
          <div className="flex items-center gap-1 border-b border-neutral-800 p-1.5">
            <button
              type="button"
              className="rounded bg-neutral-800 px-2 py-0.5"
              onClick={() => void importFiles()}
            >
              Import…
            </button>
            <input
              aria-label="Import link"
              placeholder="or paste a link"
              className="min-w-0 flex-1 rounded bg-neutral-800 px-1 py-0.5"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') importUrl();
              }}
            />
          </div>
          <ul
            aria-label="Media"
            className={`min-h-0 flex-1 overflow-y-auto p-1.5 ${view === 'grid' ? 'grid grid-cols-2 gap-1.5' : 'flex flex-col gap-0.5'}`}
          >
            {list.length === 0 && (
              <li className="col-span-2 p-2 text-neutral-400">
                {media?.length ? 'No media matches.' : 'Import media or drop files here.'}
              </li>
            )}
            {list.map((m) => {
              const off = offline.includes(m.id);
              return (
                <li
                  key={m.id}
                  data-media-id={m.id}
                  draggable={!off}
                  title={mediaName(m)}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(
                      DRAG_MEDIA,
                      JSON.stringify({ kind: 'media', id: m.id, hasAudio: m.hasAudio === true }),
                    );
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onContextMenu={(e) => openMenu(e, m.id)}
                  className={`cursor-grab rounded bg-neutral-900 ${view === 'list' ? 'flex items-center gap-2 p-1' : 'p-1'} ${off ? 'ring-1 ring-red-600' : ''}`}
                >
                  <div className={view === 'list' ? 'w-16 shrink-0' : ''}>
                    <Thumb projectId={projectId} m={m} offline={off} />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate">{mediaName(m)}</p>
                    <p className="text-neutral-400">
                      {m.kind} {duration(m.durationMs)}
                      {m.tags.length > 0 && ` · ${m.tags.join(', ')}`}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {menu && target && (
        <div
          role="menu"
          aria-label="Media actions"
          className="fixed z-50 flex min-w-48 flex-col rounded border border-neutral-700 bg-neutral-900 py-1 text-xs shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {!menu.replace ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="px-3 py-1 text-left hover:bg-neutral-800"
                onClick={() => setMenu({ ...menu, replace: true })}
              >
                Replace in timeline with…
              </button>
              {offline.includes(target.id) && (
                <button
                  type="button"
                  role="menuitem"
                  className="px-3 py-1 text-left hover:bg-neutral-800"
                  onClick={() => {
                    setMenu(null);
                    void relink(ctx, target.id);
                  }}
                >
                  Relink…
                </button>
              )}
              {target.kind === 'image' && (
                <button
                  type="button"
                  role="menuitem"
                  className="px-3 py-1 text-left hover:bg-neutral-800"
                  onClick={() => {
                    setMenu(null);
                    void jobs
                      .getState()
                      .start('assets.cutout', { projectId, mediaId: target.id }, 'Cut out')
                      .then(async (r) => {
                        if (r.status === 'done') await editor.getState().reload();
                      });
                  }}
                >
                  Cut out
                </button>
              )}
            </>
          ) : (
            (media ?? [])
              .filter((x) => x.id !== target.id && x.kind === target.kind)
              .map((x) => (
                <button
                  key={x.id}
                  type="button"
                  role="menuitem"
                  className="px-3 py-1 text-left hover:bg-neutral-800"
                  onClick={() => {
                    setMenu(null);
                    void editor.getState().apply({
                      op: 'replaceMedia',
                      args: { mediaId: target.id, withMediaId: x.id },
                    });
                  }}
                >
                  {mediaName(x)}
                </button>
              ))
          )}
        </div>
      )}
    </div>
  );
}
