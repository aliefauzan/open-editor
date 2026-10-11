// The setup screen (app spec "First-run setup"): each component with size, licence and status,
// install/repair buttons with progress, the ffmpeg-missing view (commands with copy buttons, "Check
// again"), the doctor result, and the green "Ready". The editor stays usable; stages that wait for a
// component are labelled there (`PendingStages`).
import { useState } from 'react';
import type { SetupComponentData, SetupStatusData } from '../shared/api.ts';
import { formatBytes, useSetup, type ComponentProgress } from './setup-store.ts';

const STATE_LABEL: Record<SetupComponentData['state'], string> = {
  ready: 'Ready',
  missing: 'Not installed',
  stale: 'Needs update',
  modified: 'Changed on disk',
};

/** Clipboard write without a permission grant (S15 denies them all): a selected textarea + copy. */
function copyText(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="rounded bg-neutral-800 px-2 py-0.5 text-xs hover:bg-neutral-700"
      onClick={() => {
        setDone(copyText(text));
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

function progressText(p: ComponentProgress | undefined): string {
  if (!p) return '';
  if (p.totalBytes && p.receivedBytes !== undefined)
    return `${p.phase} ${Math.floor((100 * p.receivedBytes) / p.totalBytes)}%`;
  return p.message ? `${p.phase}: ${p.message.slice(0, 80)}` : p.phase;
}

function Ffmpeg({ ff }: { ff: SetupStatusData['ffmpeg'] }) {
  const { refresh, checking } = useSetup();
  if (ff.state === 'ok')
    return (
      <li data-testid="component-ffmpeg" data-state="ready" className="flex gap-3 py-2">
        <span className="flex-1">ffmpeg (Homebrew)</span>
        <span className="text-xs text-neutral-400">{ff.version ?? ''}</span>
        <span className="text-green-400">Ready</span>
      </li>
    );
  return (
    <li data-testid="ffmpeg-missing" data-state={ff.state} className="space-y-2 py-2">
      <p>
        <strong>ffmpeg</strong> comes from Homebrew.{' '}
        {ff.state === 'brew-missing'
          ? 'Install Homebrew, then ffmpeg, in Terminal (Homebrew asks for your Mac password):'
          : 'Install it in Terminal:'}
      </p>
      {ff.commands.map((c) => (
        <div key={c} className="flex items-center gap-2">
          <code className="flex-1 truncate rounded bg-neutral-900 px-2 py-1 text-xs">{c}</code>
          <CopyButton text={c} />
        </div>
      ))}
      <button
        type="button"
        data-testid="check-again"
        disabled={checking}
        className="rounded bg-neutral-800 px-3 py-1 text-sm hover:bg-neutral-700"
        onClick={() => void refresh()}
      >
        {checking ? 'Checking…' : 'Check again'}
      </button>
    </li>
  );
}

export function SetupScreen() {
  const s = useSetup();
  const st = s.status;
  if (!st) {
    const err = s.errors['status'];
    return (
      <div className="space-y-2 p-8 text-sm">
        {err ? (
          <p role="alert" data-testid="setup-error" className="text-red-400">
            Setup check failed: {err.message}
          </p>
        ) : (
          <p className="text-neutral-400">Checking setup…</p>
        )}
        <button type="button" className="underline" onClick={() => void s.refresh()}>
          Check again
        </button>
      </div>
    );
  }
  const busy = (id: string) => s.installing.includes(id) || s.installing.includes('all');
  // ffmpeg (kind `external`, Homebrew) has its own row above: the app never installs it (D-05)
  const installable = st.components.filter((c) => c.kind !== 'external');
  const notReady = installable.filter((c) => c.state !== 'ready');
  return (
    <div data-testid="setup" className="mx-auto max-w-3xl space-y-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Setup</h1>
        {st.done ? (
          <span data-testid="setup-ready" className="rounded bg-green-600 px-3 py-1 text-white">
            Ready
          </span>
        ) : st.doctorRunning ? (
          <span data-testid="setup-checking" className="text-sm text-neutral-400">
            Running checks…
          </span>
        ) : st.ready ? (
          <span data-testid="setup-pending" className="text-sm text-red-400">
            Checks found problems
          </span>
        ) : (
          <span data-testid="setup-pending" className="text-sm text-amber-400">
            Some tools are missing
          </span>
        )}
      </header>
      <p className="text-sm text-neutral-400">
        Vox Studio downloads its pinned tools into your user folder and checks each file’s hash. The
        editor works meanwhile; steps that need a missing tool say so.
      </p>
      {notReady.length > 0 && (
        <button
          type="button"
          data-testid="install-all"
          disabled={busy('all')}
          className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-500 disabled:opacity-50"
          onClick={() => void s.install('all')}
        >
          {busy('all') ? 'Installing…' : `Install all (${notReady.length})`}
        </button>
      )}
      <ul className="divide-y divide-neutral-800">
        <Ffmpeg ff={st.ffmpeg} />
        {installable.map((c) => (
          <li
            key={c.id}
            data-testid={`component-${c.id}`}
            data-state={c.state}
            data-focus={s.focus === c.id || undefined}
            ref={(el) => {
              if (el && s.focus === c.id) el.scrollIntoView?.({ block: 'center' });
            }}
            className={`flex items-center gap-3 py-2 ${s.focus === c.id ? 'rounded ring-2 ring-indigo-500' : ''}`}
          >
            <span className="flex-1">
              {c.label}
              <span className="ml-2 text-xs text-neutral-500">
                {formatBytes(c.sizeBytes)} · {c.licence}
              </span>
              {s.errors[c.id] && (
                <span role="alert" className="block text-xs text-red-400">
                  {s.errors[c.id]!.message}
                </span>
              )}
              {busy(c.id) && (
                <span className="block text-xs text-neutral-400">
                  {progressText(s.progress[c.id])}
                </span>
              )}
            </span>
            <span className={c.state === 'ready' ? 'text-green-400' : 'text-amber-400'}>
              {STATE_LABEL[c.state]}
            </span>
            <button
              type="button"
              data-testid={`repair-${c.id}`}
              disabled={busy(c.id)}
              className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700 disabled:opacity-50"
              onClick={() => void s.install(c.id)}
            >
              {c.state === 'ready' ? 'Repair' : 'Install'}
            </button>
          </li>
        ))}
      </ul>
      {st.doctor && (
        <section data-testid="doctor">
          <h2 className="mb-2 font-semibold">Checks</h2>
          <ul className="space-y-1 text-sm">
            {st.doctor.checks
              .filter((c) => c.level !== 'ok')
              .map((c) => (
                <li
                  key={c.name}
                  className={c.level === 'error' ? 'text-red-400' : 'text-amber-400'}
                >
                  {c.name}: {c.detail}
                  {c.fix && <span className="block text-neutral-400">Fix: {c.fix}</span>}
                </li>
              ))}
            {st.doctor.checks.every((c) => c.level === 'ok') && (
              <li className="text-green-400">All {st.doctor.checks.length} checks pass.</li>
            )}
          </ul>
        </section>
      )}
      <button
        type="button"
        data-testid="setup-close"
        className="rounded bg-neutral-800 px-3 py-1 text-sm hover:bg-neutral-700"
        onClick={() => s.show(false)}
      >
        {st.done ? 'Open the editor' : 'Continue to the editor'}
      </button>
    </div>
  );
}

/** Editor strip: which steps wait for which tool, and the "New version" link. */
export function SetupNotices() {
  const s = useSetup();
  const st = s.status;
  if (!st) return null;
  const stages = Object.entries(st.disabledStages);
  return (
    <>
      {st.update.status === 'available' && (
        <div data-testid="update-banner" className="bg-blue-900 px-4 py-1 text-sm">
          New version {st.update.latest}:{' '}
          <a href={st.update.url} target="_blank" rel="noreferrer" className="underline">
            {st.update.name}
          </a>
        </div>
      )}
      {stages.length > 0 && (
        <div data-testid="pending-stages" className="bg-neutral-900 px-4 py-1 text-xs">
          Waiting for setup:{' '}
          {stages.map(([stage, ids]) => `${stage} (needs ${ids.join(', ')})`).join(' · ')}{' '}
          {[...new Set(stages.flatMap(([, ids]) => ids))].map((id) => (
            <button
              key={id}
              type="button"
              className="ml-1 rounded bg-neutral-700 px-1.5"
              onClick={() => s.show(true, id)}
            >
              Set up {st.components.find((c) => c.id === id)?.label ?? id}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
