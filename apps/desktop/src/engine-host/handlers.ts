// The engine host's window.vox handlers (app spec "Engine-host API"). Arguments were validated by
// main (zod, S11); handlers map them onto the engine API. Methods of later phases are absent and
// answer NOT_AVAILABLE (rpc.ts). Main-only methods (dialogs, reveal) never reach the host.
import { classifyUrl, type Engine, type OpCall } from '@vox/engine';
import type { EventName, Method, MethodArgs } from '../shared/api.ts';
import type { Handlers } from './rpc.ts';

type A<M extends Method> = MethodArgs<M>;

/** `vox-media://` URL of a project file (path segments encoded). */
export function mediaUrl(projectId: string, rel: string): string {
  return `vox-media://p/${projectId}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

export function createHandlers(engine: Engine): Handlers {
  const user = { actor: 'user' as const };
  return {
    'projects.list': async () => engine.listProjects(),
    'projects.create': async (name: A<'projects.create'>[0]) => engine.createProject(name),
    'projects.open': async (id: A<'projects.open'>[0]) => {
      const project = await engine.getProject(id);
      return { project, version: project.version };
    },
    'ops.apply': async (a: A<'ops.apply'>[0]) =>
      engine.applyOp(a.projectId, { op: a.op, args: a.args } as unknown as OpCall, {
        ...user,
        baseVersion: a.baseVersion,
        ...(a.coalesceKey ? { coalesceKey: a.coalesceKey } : {}),
      }),
    'history.undo': async (id: A<'history.undo'>[0]) => engine.undo(id, user),
    'history.redo': async (id: A<'history.redo'>[0]) => engine.redo(id, user),
    'history.list': async (id: A<'history.list'>[0], since?: A<'history.list'>[1]) =>
      engine.history(id, since === undefined ? {} : { sinceVersion: since }),
    'snapshots.list': async (id: A<'snapshots.list'>[0]) => engine.listSnapshots(id),
    'snapshots.create': async (id: A<'snapshots.create'>[0], name: A<'snapshots.create'>[1]) =>
      engine.snapshot(id, name),
    'captions.get': async (id: A<'captions.get'>[0], seq: A<'captions.get'>[1]) =>
      engine.captions(id, seq),
    'media.classifyUrl': async (url: A<'media.classifyUrl'>[0]) => classifyUrl(url),
    'jobs.start': async (kind: A<'jobs.start'>[0], args: A<'jobs.start'>[1]) =>
      engine.jobs.start(kind, args),
    'jobs.get': async (id: A<'jobs.get'>[0]) => engine.jobs.get(id),
    'jobs.cancel': async (id: A<'jobs.cancel'>[0]) => engine.jobs.cancel(id),
    'preview.url': async (id: A<'preview.url'>[0], seq: A<'preview.url'>[1]) => {
      const build = await engine.compile(id, seq, { mode: 'preview' });
      await engine.writeBuild(build);
      return mediaUrl(id, `build/${seq}/index.html`);
    },
    'styles.list': async () => engine.styles.list(),
    'styles.get': async (id: A<'styles.get'>[0]) => engine.styles.get(id),
    'styles.accept': async (id: A<'styles.accept'>[0]) => engine.styles.accept(id),
    'styles.remove': async (id: A<'styles.remove'>[0]) => engine.styles.remove(id),
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
