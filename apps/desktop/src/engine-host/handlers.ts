// The engine host's window.vox handlers (app spec "Engine-host API"). Arguments were validated by
// main (zod, S11); handlers map them onto the engine API. Methods of later phases are absent and
// answer NOT_AVAILABLE (rpc.ts). Main-only methods (dialogs, reveal) never reach the host.
import { classifyUrl, VoxError, type Engine, type OpCall } from '@vox/engine';
import { projectDirFor, resolveProjectPath } from '@vox/engine/paths';
import { access, readFile } from 'node:fs/promises';
import type { EventName, Method, MethodArgs, SetupStatusData } from '../shared/api.ts';
import { join } from 'node:path';
import type { AgentHost } from './agent.ts';
import type { AppSetup } from './app-setup.ts';
import type { PreviewPipeline } from './preview.ts';
import type { SettingsHost } from './settings.ts';
import { APP_JOB_KINDS, type AppJobs } from './quick.ts';
import type { Handlers } from './rpc.ts';
import { watchProject } from './watch.ts';

type A<M extends Method> = MethodArgs<M>;

/** `vox-media://` URL of a project file (path segments encoded). */
export function mediaUrl(projectId: string, rel: string): string {
  return `vox-media://p/${projectId}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/** Editor parts of the host (phase 10a): the preview pipeline and the open project's watcher. */
export interface EditorHost {
  preview?: PreviewPipeline;
  /** Watch the open project's folder for external edits (default true when `preview` is set). */
  watch?: boolean;
  /** App jobs beside the engine's runner (`makeClips`, phase 10b). */
  appJobs?: AppJobs;
  /** Agent runs (phase 13). */
  agent?: AgentHost;
  /** Provider settings, keys (Keychain), roles, cookies opt-in (phase 13). */
  settings?: SettingsHost;
  /** `styles.extract` (phase 15): the `style.extract` job is registered; `render: false` in test builds. */
  styleExtract?: { render: boolean };
}

type ProjectMedia = Awaited<ReturnType<Engine['getProject']>>['media'][number];

/** Media whose file is gone from disk (moved or deleted): the timeline shows them offline. */
async function offlineMedia(dir: string, media: readonly ProjectMedia[]): Promise<string[]> {
  const out: string[] = [];
  for (const m of media) {
    try {
      await access(await resolveProjectPath(dir, m.path));
    } catch {
      out.push(m.id);
    }
  }
  return out;
}

/** The media bin search: names, tags, descriptions and transcript text (app spec "Media bin"). */
async function searchMedia(dir: string, media: readonly ProjectMedia[], q: string) {
  const needle = q.trim().toLowerCase();
  if (!needle) return media.map((m) => m.id);
  const hits: string[] = [];
  for (const m of media) {
    const fields = [
      m.path.split('/').pop() ?? '',
      m.origin.url ?? '',
      m.description ?? '',
      ...m.tags,
    ];
    let found = fields.some((x) => x.toLowerCase().includes(needle));
    if (!found && m.transcriptPath) {
      try {
        const t = JSON.parse(
          await readFile(await resolveProjectPath(dir, m.transcriptPath), 'utf8'),
        ) as { words?: { text?: string }[] };
        found = (t.words ?? [])
          .map((w) => w.text ?? '')
          .join(' ')
          .toLowerCase()
          .includes(needle);
      } catch {
        found = false;
      }
    }
    if (found) hits.push(m.id);
  }
  return hits;
}

export function createHandlers(
  engine: Engine,
  setup?: AppSetup,
  editor: EditorHost = {},
): Handlers {
  const user = { actor: 'user' as const };
  const preview = editor.preview;
  const appJobs = editor.appJobs;
  const isAppKind = (k: string) => (APP_JOB_KINDS as readonly string[]).includes(k);
  const watching = { id: '', stop: () => undefined as void };
  const watchOpen = (id: string) => {
    if (!(editor.watch ?? preview !== undefined) || watching.id === id) return;
    watching.stop();
    watching.id = id;
    watching.stop = watchProject(engine, id, join(engine.projectsDir, id));
  };
  return {
    'projects.list': async () => engine.listProjects(),
    'projects.create': async (name: A<'projects.create'>[0]) => engine.createProject(name),
    'projects.open': async (id: A<'projects.open'>[0]) => {
      const project = await engine.getProject(id);
      watchOpen(id);
      const offline = await offlineMedia(projectDirFor(engine.projectsDir, id), project.media);
      return { project, version: project.version, offline };
    },
    'ops.apply': async (a: A<'ops.apply'>[0]) => {
      preview?.noteOp(a.projectId, a.coalesceKey);
      return engine.applyOp(a.projectId, { op: a.op, args: a.args } as unknown as OpCall, {
        ...user,
        baseVersion: a.baseVersion,
        ...(a.coalesceKey ? { coalesceKey: a.coalesceKey } : {}),
      });
    },
    'history.undo': async (id: A<'history.undo'>[0]) => engine.undo(id, user),
    'history.redo': async (id: A<'history.redo'>[0]) => engine.redo(id, user),
    'history.list': async (id: A<'history.list'>[0], since?: A<'history.list'>[1]) =>
      engine.history(id, since === undefined ? {} : { sinceVersion: since }),
    'snapshots.list': async (id: A<'snapshots.list'>[0]) => engine.listSnapshots(id),
    'snapshots.create': async (id: A<'snapshots.create'>[0], name: A<'snapshots.create'>[1]) =>
      engine.snapshot(id, name),
    'captions.get': async (id: A<'captions.get'>[0], seq: A<'captions.get'>[1]) =>
      engine.captions(id, seq),
    // main adds `paths` (from the native dialog, or the test build's `{ paths }`, VOX_E2E=1 only)
    'media.importFiles': async (id: A<'media.importFiles'>[0], o?: A<'media.importFiles'>[1]) => {
      if (!o?.paths) throw new Error('media.importFiles needs the chosen paths from main');
      return { jobId: engine.jobs.start('ingest', { projectId: id, inputs: o.paths }) };
    },
    'media.peaks': async (id: A<'media.peaks'>[0], mediaId: A<'media.peaks'>[1]) => {
      const m = (await engine.getProject(id)).media.find((x) => x.id === mediaId);
      if (!m?.peaksPath) return null;
      const file = await resolveProjectPath(projectDirFor(engine.projectsDir, id), m.peaksPath);
      return JSON.parse(await readFile(file, 'utf8')) as unknown;
    },
    'media.classifyUrl': async (url: A<'media.classifyUrl'>[0]) => classifyUrl(url),
    // a link (YouTube, Instagram, TikTok, any yt-dlp URL); plain text never starts a job
    'media.importUrl': async (id: A<'media.importUrl'>[0], url: A<'media.importUrl'>[1]) => {
      if (classifyUrl(url) === 'invalid') {
        throw {
          code: 'VALIDATION',
          message: 'That is not a link',
          hint: 'Paste an http(s) link from YouTube, Instagram or TikTok, or choose a file.',
        };
      }
      return { jobId: engine.jobs.start('ingest', { projectId: id, inputs: [url] }) };
    },
    'media.search': async (id: A<'media.search'>[0], q: A<'media.search'>[1]) =>
      searchMedia(projectDirFor(engine.projectsDir, id), (await engine.getProject(id)).media, q),
    'jobs.start': async (kind: A<'jobs.start'>[0], args: A<'jobs.start'>[1]) => {
      // the reference of a style extraction comes from styles.extract (a native dialog or a link)
      if (kind === 'style.extract')
        throw new VoxError(
          'VALIDATION',
          'Start a style extraction with styles.extract',
          'Use the style gallery.',
        );
      return appJobs && isAppKind(kind) ? appJobs.start(kind, args) : engine.jobs.start(kind, args);
    },
    'jobs.get': async (id: A<'jobs.get'>[0]) =>
      appJobs?.has(id) ? appJobs.get(id) : engine.jobs.get(id),
    'jobs.cancel': async (id: A<'jobs.cancel'>[0]) =>
      appJobs?.has(id) ? appJobs.cancel(id) : engine.jobs.cancel(id),
    'preview.url': async (id: A<'preview.url'>[0], seq: A<'preview.url'>[1]) => {
      if (preview) return preview.open(id, seq);
      const build = await engine.compile(id, seq, { mode: 'preview' });
      await engine.writeBuild(build);
      return mediaUrl(id, `build/${seq}/index.html`);
    },
    'styles.list': async () => engine.styles.list(),
    'styles.get': async (id: A<'styles.get'>[0]) => engine.styles.get(id),
    'styles.accept': async (id: A<'styles.accept'>[0]) => engine.styles.accept(id),
    'styles.remove': async (id: A<'styles.remove'>[0]) => engine.styles.remove(id),
    ...(editor.styleExtract === undefined
      ? {}
      : {
          'styles.extract': async (o: A<'styles.extract'>[0]) => {
            const source = o.url ?? o.path;
            if (!source) {
              throw new VoxError(
                'VALIDATION',
                'No reference video',
                'Choose a video file or paste a link.',
              );
            }
            const jobId = engine.jobs.start('style.extract', {
              source,
              name: o.name,
              ...(!editor.styleExtract!.render && { render: false }),
            });
            return { jobId };
          },
        }),
    'geo.search': async (q: A<'geo.search'>[0]) => engine.geo.search(q),
    ...(editor.agent === undefined
      ? {}
      : {
          'agent.run': async (a: A<'agent.run'>[0]) => editor.agent!.run(a),
          'agent.runs': async (id: A<'agent.runs'>[0]) => editor.agent!.runs(id),
          'agent.stop': async (runId: A<'agent.stop'>[0]) => editor.agent!.stop(runId),
          'agent.decide': async (runId: A<'agent.decide'>[0], d: A<'agent.decide'>[1]) =>
            editor.agent!.decide(runId, d),
          'agent.undoRun': async (runId: A<'agent.undoRun'>[0]) => editor.agent!.undoRun(runId),
        }),
    ...(editor.settings === undefined
      ? {}
      : {
          'settings.get': async () => editor.settings!.get(),
          'settings.save': async (patch: A<'settings.save'>[0]) => editor.settings!.save(patch),
          'settings.probe': async (ref: A<'settings.probe'>[0]) => editor.settings!.probe(ref),
        }),
    ...(setup === undefined
      ? {}
      : {
          'setup.status': async (): Promise<SetupStatusData> => setup.status(),
          'setup.install': async (c: A<'setup.install'>[0]) => setup.install(c),
          'setup.updateYtDlp': async () => setup.updateYtDlp(),
        }),
  } as Handlers;
}

/** Engine events → main, through the engine's secret redactor (S19). Returns the unsubscribe. */
export function forwardEvents(
  engine: Engine,
  emit: (name: EventName, payload: unknown) => void,
): () => void {
  const names = [
    'project.changed',
    'job.started',
    'job.progress',
    'job.done',
    'job.failed',
    'job.cancelled',
  ] as const;
  const offs = names.map((n) =>
    engine.on(n, (payload: unknown) => emit(n, engine.redactor.redact(payload))),
  );
  return () => offs.forEach((off) => off());
}
