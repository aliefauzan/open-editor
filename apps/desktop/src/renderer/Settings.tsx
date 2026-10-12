// Settings (app spec "Settings"; plan phase 13; R4 S18, S33). Providers from the presets (and
// "OpenAI-compatible with base URL"), a write-only key field (the engine host puts a typed key in the
// Keychain; only the masked form ever comes back), "Test" (the probe) with capability badges, roles
// assignable only after a passing probe, budget limits, a per-provider note on where project content
// goes, the Apple helper's status, and Tools: setup status, "Update yt-dlp", repair, the Commons
// contact and the browser-cookies toggle (the only app path that writes
// `ingest.cookiesFromBrowser`). Opened from the editor's top bar, the start screen, and the
// "Open Settings" link of a LOGIN_REQUIRED hint (which focuses the cookies toggle).
import { useEffect, useRef, useState } from 'react';
import {
  COOKIE_BROWSERS,
  SETTINGS_ROLES,
  type ErrorData,
  type ImageGenData,
  type ProbedData,
  type SettingsData,
  type SettingsPatchData,
  type SettingsRole,
} from '../shared/api.ts';
import { useCtx, useJobs } from './editor/context.tsx';
import { useSetup } from './setup-store.ts';

const btn =
  'rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50';
const field = 'rounded bg-neutral-800 px-2 py-1 text-xs';
const section = 'space-y-2 border-t border-neutral-800 pt-3';

/** The "OpenAI-compatible with base URL" choice: an LM Studio-type entry with its own id and URL. */
const COMPATIBLE = 'compatible';

const asError = (e: unknown): ErrorData =>
  e && typeof e === 'object' && 'code' in e
    ? (e as ErrorData)
    : { code: 'INTERNAL', message: String(e), hint: '' };

const CHECKS = ['tools', 'loop', 'vision', 'plan'] as const;

function Badges(props: { probe: ProbedData }) {
  const p = props.probe;
  if (p.error)
    return (
      <p className="text-red-400" data-testid="probe-error">
        {p.error.message}{' '}
        {p.error.hint && <span className="text-neutral-400">({p.error.hint})</span>}
      </p>
    );
  const r = p.report ?? {};
  return (
    <div className="space-y-1">
      <ul className="flex flex-wrap gap-1" aria-label={`Probe of ${p.model}`}>
        {CHECKS.map((c) => {
          const v = r[c];
          if (!v) return null;
          const ok = v.status === 'pass';
          return (
            <li
              key={c}
              title={v.reason ?? v.status}
              data-check={c}
              data-status={v.status}
              className={`rounded px-1.5 text-[11px] ${ok ? 'bg-emerald-900 text-emerald-200' : 'bg-red-900 text-red-200'}`}
            >
              {ok ? '✓' : '✗'} {c}
            </li>
          );
        })}
        {r.context && (
          <li className="rounded bg-neutral-800 px-1.5 text-[11px]">
            context {r.context.contextTokens?.toLocaleString() ?? '?'}
          </li>
        )}
      </ul>
    </div>
  );
}

function ProviderRow(props: {
  p: SettingsData['providers'][number];
  label: string;
  probes: ProbedData[];
  apple: SettingsData['apple'];
  save(patch: SettingsPatchData): Promise<boolean>;
  probe(ref: string): Promise<void>;
  testing: string | null;
}) {
  const p = props.p;
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(p.baseUrl ?? '');
  const [model, setModel] = useState(p.type === 'apple' ? 'apple-on-device' : (p.models[0] ?? ''));
  const ref = `${p.id}:${model.trim()}`;
  const probe = props.probes.find((x) => x.providerId === p.id && x.model === model.trim());
  const editableUrl = p.type === 'ollama' || p.preset === 'lmstudio' || p.preset === '9router';
  return (
    <li className="space-y-2 rounded border border-neutral-800 p-2" data-provider={p.id}>
      <div className="flex items-center gap-2">
        <span className="font-medium">{props.label}</span>
        {p.id !== p.preset && <span className="text-neutral-500">({p.id})</span>}
        <button
          type="button"
          className="ml-auto text-[11px] text-neutral-400 hover:text-white"
          onClick={() => void props.save({ removeProvider: p.id })}
        >
          Remove
        </button>
      </div>
      <p className="text-[11px] text-neutral-400" data-testid="data-note">
        {p.local
          ? 'Runs on this Mac: project content stays here.'
          : `Project content (transcripts, frames, your messages) is sent to ${props.label} when the agent runs.`}
      </p>
      {p.type === 'apple' && props.apple && (
        <p data-testid="apple-status" data-status={props.apple.status}>
          Apple on-device: <strong>{props.apple.status}</strong>
          {props.apple.hint && <span className="text-neutral-400"> — {props.apple.hint}</span>}
        </p>
      )}
      {p.keyRef !== 'none' || !p.local ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!key) return;
            void props.save({ provider: { id: p.id, apiKey: key } }).then((ok) => ok && setKey(''));
          }}
        >
          <label className="flex flex-1 items-center gap-2">
            Key
            <input
              type="password"
              autoComplete="off"
              aria-label={`API key for ${props.label}`}
              className={`${field} min-w-0 flex-1`}
              value={key}
              placeholder={p.keyMasked ?? (p.keyRef === 'env' ? 'from the environment' : 'not set')}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <button type="submit" className={btn} disabled={!key}>
            Save key
          </button>
        </form>
      ) : null}
      {editableUrl && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (baseUrl.trim() && baseUrl.trim() !== p.baseUrl)
              void props.save({ provider: { id: p.id, baseUrl: baseUrl.trim() } });
          }}
        >
          <label className="flex flex-1 items-center gap-2">
            Base URL
            <input
              aria-label={`Base URL for ${props.label}`}
              className={`${field} min-w-0 flex-1`}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          <button type="submit" className={btn}>
            Save
          </button>
        </form>
      )}
      <div className="flex items-center gap-2">
        <label className="flex flex-1 items-center gap-2">
          Model
          <input
            aria-label={`Model for ${props.label}`}
            className={`${field} min-w-0 flex-1`}
            list={`models-${p.id}`}
            value={model}
            disabled={p.type === 'apple'}
            onChange={(e) => setModel(e.target.value)}
          />
          <datalist id={`models-${p.id}`}>
            {p.models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <button
          type="button"
          className={btn}
          disabled={!model.trim() || props.testing === ref}
          onClick={() => void props.probe(ref)}
        >
          {props.testing === ref ? 'Testing…' : 'Test'}
        </button>
      </div>
      {probe && <Badges probe={probe} />}
      {probe && !probe.error && (
        <div className="flex flex-wrap gap-1">
          {SETTINGS_ROLES.map((role) => {
            const v = probe.roles.find((x) => x.role === role);
            const ok = v?.assignable === true;
            return (
              <button
                key={role}
                type="button"
                className={btn}
                disabled={!ok}
                title={
                  ok
                    ? `Use ${model} as the ${role} model${v?.mode ? ` (${v.mode} mode)` : ''}`
                    : (v?.failures.map((f) => `${f.check}: ${f.reason}`).join('; ') ??
                      'not probed for this role')
                }
                onClick={() =>
                  void props.save({ role: { role, providerId: p.id, model: model.trim() } })
                }
              >
                Use as {role}
              </button>
            );
          })}
        </div>
      )}
    </li>
  );
}

function AddProvider(props: {
  presets: SettingsData['presets'];
  existing: string[];
  save(patch: SettingsPatchData): Promise<boolean>;
}) {
  const [choice, setChoice] = useState('');
  const [id, setId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const options = props.presets.filter((p) => !props.existing.includes(p.id));
  const add = () => {
    if (choice === COMPATIBLE) {
      if (!id.trim() || !baseUrl.trim()) return;
      void props.save({ provider: { id: id.trim(), preset: 'lmstudio', baseUrl: baseUrl.trim() } });
    } else if (choice) {
      void props.save({ provider: { preset: choice as never } });
    }
    setChoice('');
    setId('');
    setBaseUrl('');
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Add a provider"
        className={field}
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
      >
        <option value="">Add a provider…</option>
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
        <option value={COMPATIBLE}>OpenAI-compatible (base URL)</option>
      </select>
      {choice === COMPATIBLE && (
        <>
          <input
            aria-label="Provider id"
            placeholder="id, e.g. my-server"
            className={field}
            value={id}
            onChange={(e) => setId(e.target.value)}
          />
          <input
            aria-label="Base URL"
            placeholder="http://localhost:8080/v1"
            className={field}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </>
      )}
      <button type="button" className={btn} disabled={!choice} onClick={add}>
        Add
      </button>
    </div>
  );
}

const gb = (bytes: number) => `${Math.round(bytes / 1e8) / 10} GB`;

/**
 * Local image generation (phase 14d): a switch that shows the download size and the licence before
 * anything is fetched, then runs the `imagegen.install` job; switching it off removes the model.
 * FLUX.1-schnell (gated on Hugging Face) is set up in a terminal: `vox doctor` explains the terms.
 * A failed or cancelled install keeps its partial download for the next try (D-69): the row shows
 * its size and offers to delete it (`imagegen.remove`), so the space is never hidden.
 */
function ImageGenSection(props: { data: ImageGenData; reload(): Promise<void> }) {
  const { jobs } = useCtx();
  const model = props.data.models.find((m) => m.id === 'z-image-turbo');
  const [ask, setAsk] = useState<'install' | 'remove' | 'discard' | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const row = useJobs((s) => s.rows.find((r) => r.id === jobId));
  const status = row?.status;
  useEffect(() => {
    if (status && status !== 'running') void props.reload();
  }, [status]);
  if (!model) return null;
  const running = row?.status === 'running';
  const start = (kind: 'imagegen.install' | 'imagegen.remove') => {
    setAsk(null);
    void jobs
      .getState()
      .start(
        kind,
        { model: model.id },
        `${kind === 'imagegen.install' ? 'Installing' : 'Removing'} ${model.label}`,
        setJobId,
      );
  };
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2">
        <input
          id="imagegen-toggle"
          type="checkbox"
          checked={model.installed}
          disabled={running}
          onChange={() => setAsk(model.installed ? 'remove' : 'install')}
        />
        Local image generation ({model.label})
      </label>
      <p className="pl-6 text-[11px] text-neutral-400">
        Makes pictures on this Mac with {model.label}; once installed it works offline. Licence:{' '}
        {model.license}.{model.installed && ` Installed, ${gb(model.sizeOnDisk)} on disk.`}
      </p>
      {model.partialBytes > 0 && !running && (
        <p className="pl-6 text-[11px] text-neutral-400">
          {gb(model.partialBytes)} downloaded so far is kept, so the next install resumes it.{' '}
          <button type="button" className={btn} onClick={() => setAsk('discard')}>
            Delete partial download
          </button>
        </p>
      )}
      {ask === 'install' && (
        <div
          role="alertdialog"
          aria-label="Download image model"
          className="ml-6 space-y-1 rounded bg-neutral-800 p-2 text-[11px]"
        >
          <p>
            Download about {gb(model.downloadBytes)} from Hugging Face ({model.label}, licence{' '}
            {model.license}); about {gb(model.installedBytes)} stay on disk afterwards. You need
            that much free space while it installs. It runs once and can take a while.
            {model.partialBytes > 0 &&
              ` It resumes the ${gb(model.partialBytes)} already downloaded.`}
          </p>
          <div className="flex gap-2">
            <button type="button" className={btn} onClick={() => start('imagegen.install')}>
              Download {gb(model.downloadBytes)}
            </button>
            <button type="button" className={btn} onClick={() => setAsk(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {ask === 'remove' && (
        <div
          role="alertdialog"
          aria-label="Remove image model"
          className="ml-6 space-y-1 rounded bg-neutral-800 p-2 text-[11px]"
        >
          <p>
            Remove {model.label} and free {gb(model.sizeOnDisk + model.partialBytes)}? You can
            download it again later.
          </p>
          <div className="flex gap-2">
            <button type="button" className={btn} onClick={() => start('imagegen.remove')}>
              Remove
            </button>
            <button type="button" className={btn} onClick={() => setAsk(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {ask === 'discard' && (
        <div
          role="alertdialog"
          aria-label="Delete partial download"
          className="ml-6 space-y-1 rounded bg-neutral-800 p-2 text-[11px]"
        >
          <p>
            Delete the {gb(model.partialBytes)} partial download of {model.label}? The next install
            then starts from the beginning.
          </p>
          <div className="flex gap-2">
            <button type="button" className={btn} onClick={() => start('imagegen.remove')}>
              Delete
            </button>
            <button type="button" className={btn} onClick={() => setAsk(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {running && row && (
        <p className="pl-6 text-[11px] text-neutral-300" role="status">
          {row.label}: {Math.round(row.progress * 100)}%{row.message ? ` (${row.message})` : ''}
        </p>
      )}
      {row?.status === 'failed' && row.error && (
        <p className="pl-6 text-[11px] text-red-400" role="alert">
          {row.error.message} {row.error.hint}
        </p>
      )}
    </div>
  );
}

function ToolsSection(props: {
  data: SettingsData;
  save(patch: SettingsPatchData): Promise<boolean>;
  reload(): Promise<void>;
  focusCookies: boolean;
}) {
  const { vox } = useCtx();
  const setup = useSetup();
  const [contact, setContact] = useState(props.data.contact ?? '');
  const [ytdlp, setYtdlp] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cookiesRef = useRef<HTMLInputElement>(null);
  const cookies = props.data.ingest.cookiesFromBrowser;
  useEffect(() => {
    if (props.focusCookies) {
      cookiesRef.current?.focus();
      cookiesRef.current?.scrollIntoView?.({ block: 'center' });
    }
  }, [props.focusCookies]);
  useEffect(() => {
    if (!useSetup.getState().status) void useSetup.getState().refresh();
  }, []);
  return (
    <section className={section} aria-label="Tools">
      <h3 className="font-semibold">Tools</h3>
      <ul className="space-y-0.5" data-testid="tools-status">
        {(setup.status?.components ?? []).map((c) => (
          <li key={c.id} className="flex justify-between">
            <span>{c.label}</span>
            <span className={c.state === 'ready' ? 'text-emerald-400' : 'text-amber-400'}>
              {c.state}
              {c.version && ` ${c.version}`}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={btn}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void vox.setup
              .updateYtDlp()
              .then(
                (r) => setYtdlp(`yt-dlp ${r.version}`),
                (e: unknown) => setYtdlp(asError(e).message),
              )
              .finally(() => {
                setBusy(false);
                void setup.refresh();
              });
          }}
        >
          {busy ? 'Updating…' : 'Update yt-dlp'}
        </button>
        <button type="button" className={btn} onClick={() => setup.show(true)}>
          Repair…
        </button>
        {ytdlp && <span className="text-neutral-400">{ytdlp}</span>}
      </div>
      <label className="flex items-center gap-2">
        Wikimedia Commons contact
        <input
          aria-label="Commons contact"
          className={`${field} min-w-0 flex-1`}
          placeholder="an email or URL for the API user agent"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          onBlur={() => {
            if (contact.trim() !== (props.data.contact ?? ''))
              void props.save({ contact: contact.trim() || null });
          }}
        />
      </label>
      <div className="space-y-1">
        <label className="flex items-center gap-2">
          <input
            ref={cookiesRef}
            id="cookies-toggle"
            type="checkbox"
            checked={cookies !== null}
            onChange={(e) =>
              void props.save({ cookiesFromBrowser: e.target.checked ? 'safari' : null })
            }
          />
          Use browser cookies for Instagram/TikTok
        </label>
        {cookies !== null && (
          <label className="flex items-center gap-2 pl-6">
            Browser
            <select
              aria-label="Cookies browser"
              className={field}
              value={cookies}
              onChange={(e) =>
                void props.save({
                  cookiesFromBrowser: e.target.value as (typeof COOKIE_BROWSERS)[number],
                })
              }
            >
              {COOKIE_BROWSERS.map((b) => (
                <option key={b} value={b}>
                  {b[0]!.toUpperCase() + b.slice(1)}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="pl-6 text-[11px] text-neutral-400">
          yt-dlp reads the cookies of the browser you are logged in with, only for links that need a
          login. Off by default; only this switch (or `vox config` in a terminal) turns it on.
        </p>
      </div>
      {props.data.imagegen && <ImageGenSection data={props.data.imagegen} reload={props.reload} />}
    </section>
  );
}

export function SettingsDialog(props: { onClose(): void; focus?: 'cookies' | null }) {
  const { vox, agent } = useCtx();
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState<ErrorData | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [limits, setLimits] = useState({ usd: '', steps: '' });
  const load = (d: SettingsData) => {
    setData(d);
    setLimits({ usd: String(d.limits.maxUsdPerRun), steps: String(d.limits.maxStepsPerRun) });
  };
  useEffect(() => {
    vox.settings.get().then(load, (e: unknown) => setError(asError(e)));
  }, [vox]);
  const reload = async () => {
    try {
      load(await vox.settings.get());
    } catch (e) {
      setError(asError(e));
    }
  };
  const save = async (patch: SettingsPatchData): Promise<boolean> => {
    setError(null);
    try {
      load(await vox.settings.save(patch));
      void agent.getState().loadSettings();
      return true;
    } catch (e) {
      setError(asError(e));
      return false;
    }
  };
  const probe = async (ref: string) => {
    setTesting(ref);
    setError(null);
    try {
      await vox.settings.probe(ref);
      load(await vox.settings.get());
    } catch (e) {
      setError(asError(e));
    } finally {
      setTesting(null);
    }
  };
  const label = (id: string, preset?: string) =>
    data?.presets.find((p) => p.id === (preset ?? id))?.label ?? id;
  // Escape closes the dialog like Close, wherever the focus is (as the export dialog)
  const { onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="w-[560px] max-w-full space-y-3 rounded border border-neutral-700 bg-neutral-900 p-4 text-xs shadow-2xl"
      >
        <div className="flex items-center">
          <h2 className="text-sm font-semibold">Settings</h2>
          <button type="button" className={`${btn} ml-auto`} onClick={props.onClose}>
            Close
          </button>
        </div>
        {error && (
          <div role="alert" className="rounded bg-red-950 p-2">
            <p>{error.message}</p>
            {error.hint && <p className="text-neutral-300">{error.hint}</p>}
          </div>
        )}
        {!data ? (
          <p className="text-neutral-400">Loading…</p>
        ) : (
          <>
            <section className="space-y-2" aria-label="Models">
              <h3 className="font-semibold">Models</h3>
              <ul className="space-y-1" data-testid="roles">
                {SETTINGS_ROLES.map((role: SettingsRole) => {
                  const r = data.roles[role];
                  return (
                    <li key={role} className="flex items-center gap-2" data-role={role}>
                      <span className="w-14 text-neutral-400">{role}</span>
                      <span className="flex-1 truncate">
                        {r ? `${label(r.providerId)} · ${r.model}` : 'not set'}
                      </span>
                      {role === 'editor' && r && data.mode && (
                        <span className="text-neutral-400">{data.mode} mode</span>
                      )}
                      {r && (
                        <button
                          type="button"
                          className="text-[11px] text-neutral-400 hover:text-white"
                          onClick={() => void save({ clearRole: role })}
                        >
                          Clear
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              <p className="text-[11px] text-neutral-400">
                Press Test on a model; a role can be given only to a model that passed its checks.
              </p>
            </section>
            <section className={section} aria-label="Providers">
              <h3 className="font-semibold">Providers</h3>
              <ul className="space-y-2">
                {data.providers.map((p) => (
                  <ProviderRow
                    key={p.id}
                    p={p}
                    label={label(p.id, p.preset)}
                    probes={data.probes}
                    apple={data.apple}
                    save={save}
                    probe={probe}
                    testing={testing}
                  />
                ))}
              </ul>
              <AddProvider
                presets={data.presets}
                existing={data.providers.map((p) => p.id)}
                save={save}
              />
              {!data.appleHelper && (
                <p className="text-[11px] text-neutral-500">
                  This build has no Apple on-device helper (built without the macOS 26+ SDK).
                </p>
              )}
            </section>
            <section className={section} aria-label="Budget">
              <h3 className="font-semibold">Budget</h3>
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const usd = Number(limits.usd);
                  const steps = Number(limits.steps);
                  void save({
                    limits: {
                      ...(usd > 0 && { maxUsdPerRun: usd }),
                      ...(Number.isInteger(steps) && steps > 0 && { maxStepsPerRun: steps }),
                    },
                  });
                }}
              >
                <label className="flex items-center gap-1">
                  Max $ per run
                  <input
                    aria-label="Max dollars per run"
                    className={`${field} w-20`}
                    inputMode="decimal"
                    value={limits.usd}
                    onChange={(e) => setLimits({ ...limits, usd: e.target.value })}
                  />
                </label>
                <label className="flex items-center gap-1">
                  Max steps
                  <input
                    aria-label="Max steps per run"
                    className={`${field} w-16`}
                    inputMode="numeric"
                    value={limits.steps}
                    onChange={(e) => setLimits({ ...limits, steps: e.target.value })}
                  />
                </label>
                <button type="submit" className={btn}>
                  Save limits
                </button>
              </form>
            </section>
            <ToolsSection
              data={data}
              save={save}
              reload={reload}
              focusCookies={props.focus === 'cookies'}
            />
          </>
        )}
      </div>
    </div>
  );
}
