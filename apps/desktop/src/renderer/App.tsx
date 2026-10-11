import { useEffect, useRef, useState } from 'react';
import { useShell } from './store.ts';

type PlayerEl = HTMLElement & { play(): void; pause(): void; currentTime: number };

function Preview({ url }: { url: string }) {
  const ref = useRef<PlayerEl | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const tick = () => setTime(el.currentTime ?? 0);
    el.addEventListener('timeupdate', tick);
    return () => el.removeEventListener('timeupdate', tick);
  }, [url]);
  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (playing) el.pause();
    else el.play();
    setPlaying(!playing);
  };
  return (
    <div className="flex h-full flex-col items-center gap-2 p-4">
      <hyperframes-player
        ref={ref}
        key={url}
        src={url}
        width="1080"
        height="1920"
        sandbox-origin="opaque"
        data-testid="player"
        style={{ height: 'calc(100% - 48px)', aspectRatio: '9 / 16' }}
      />
      <div className="flex items-center gap-3 text-sm">
        <button
          type="button"
          data-testid="play"
          className="rounded bg-neutral-800 px-3 py-1 hover:bg-neutral-700"
          onClick={toggle}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <span data-testid="time" className="font-mono tabular-nums">
          {time.toFixed(2)} s
        </span>
      </div>
    </div>
  );
}

export function App() {
  const s = useShell();
  const [name, setName] = useState('');
  useEffect(() => {
    void s.loadProjects();
    return window.vox.on('host.restarted', () => void useShell.getState().hostRestarted());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once on mount
  }, []);
  return (
    <div className="flex h-full flex-col">
      {s.banner && (
        <div
          role="status"
          data-testid="banner"
          className="flex items-center justify-between bg-amber-500 px-4 py-2 text-sm text-black"
        >
          <span>{s.banner}</span>
          <button type="button" onClick={s.dismissBanner} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {s.error && (
        <div role="alert" className="bg-red-900 px-4 py-2 text-sm">
          {s.error.message} {s.error.hint && <span className="opacity-70">({s.error.hint})</span>}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-neutral-800 p-4">
          <h1 className="mb-3 text-lg font-semibold">Projects</h1>
          <form
            className="mb-4 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) void s.createProject(name.trim()).then(() => setName(''));
            }}
          >
            <input
              aria-label="New project name"
              className="min-w-0 flex-1 rounded bg-neutral-900 px-2 py-1 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New project"
            />
            <button type="submit" className="rounded bg-neutral-800 px-2 py-1 text-sm">
              Create
            </button>
          </form>
          <ul className="space-y-1" data-testid="projects">
            {s.projects.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  data-project-id={p.id}
                  className={`w-full rounded px-2 py-1 text-left text-sm hover:bg-neutral-800 ${
                    s.open?.project.id === p.id ? 'bg-neutral-800' : ''
                  }`}
                  onClick={() => void s.openProject(p.id)}
                >
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <main className="min-w-0 flex-1">
          {s.previewUrl ? (
            <Preview url={s.previewUrl} />
          ) : (
            <p className="p-8 text-sm text-neutral-400">
              {s.open ? 'This project has no sequence yet.' : 'Open a project to preview it.'}
            </p>
          )}
        </main>
      </div>
    </div>
  );
}
