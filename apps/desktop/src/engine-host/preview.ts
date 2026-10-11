// Preview pipeline in the engine host (app spec "Preview pipeline"; GATE 1 / D-29: whole-sequence
// HyperFrames preview, opaque sandbox, no pre-render cache). After a change to the sequence being
// previewed it compiles in memory: scene-only changes write the build's text files and emit
// `preview.updated { kind: 'patch' }` with each changed instance's HTML (the player remounts them
// through `vox-patch`); anything structural writes the full build and emits `kind: 'reload'` (the
// player reloads and seeks to the saved playhead through `vox-playhead`). Single ops compile at once;
// keyed ops (sliders, typing; `coalesceKey`) coalesce for 150 ms.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BuildResult, Engine } from '@vox/engine';
import type { EventName } from '../shared/api.ts';
import type { Change, PreviewPatch, PreviewUpdated, ProjectChanged } from '../shared/project.ts';
import { mediaUrl } from './handlers.ts';

export const COALESCE_MS = 150;

type Kind = 'patch' | 'reload';

interface Active {
  projectId: string;
  sequenceId: string;
  /** Changes waiting for the next build: reload wins over patch; patch ids collect. */
  kind: Kind | null;
  ids: Set<string>;
  version: number;
  timer: ReturnType<typeof setTimeout> | null;
  building: Promise<void> | null;
  /** index.html of the last build (patch guard). */
  html: string;
  /** Seq of the build URL (`?v=`), so the player sees a new src on each reload. */
  builds: number;
}

/**
 * The kind of preview update a set of change records needs for one sequence, or null when none.
 * Scene-only: every touched entity is a scene item of this sequence that existed before and after,
 * on the same track and without a transition change (transitions are separate instances).
 */
export function classify(
  changes: readonly Change[],
  sequenceId: string,
): { kind: Kind; ids: string[] } | null {
  let kind: Kind | null = null;
  const ids: string[] = [];
  const mine = (key: string) => {
    const slash = key.indexOf('/');
    const colon = key.indexOf(':');
    const seq = slash < 0 ? key.slice(colon + 1) : key.slice(colon + 1, slash);
    return seq === sequenceId;
  };
  for (const c of changes) {
    if (c.key === 'project') continue; // name only
    if (c.key.startsWith('media:')) {
      kind = 'reload'; // a clip of this sequence may use it
      continue;
    }
    if (!mine(c.key)) continue;
    if (c.key.startsWith('item:')) {
      const b = c.before as { type?: string; trackId?: string; transitionIn?: unknown } | null;
      const a = c.after as { type?: string; trackId?: string; transitionIn?: unknown } | null;
      const sceneOnly =
        b?.type === 'scene' &&
        a?.type === 'scene' &&
        b.trackId === a.trackId &&
        JSON.stringify(b.transitionIn) === JSON.stringify(a.transitionIn);
      if (sceneOnly) {
        ids.push(c.key.slice(c.key.indexOf('/') + 1));
        kind ??= 'patch';
        continue;
      }
    }
    kind = 'reload';
  }
  return kind === null ? null : { kind, ids };
}

/** The inner HTML of `<template id="<id>-template">` in a preview `index.html`. */
export function instanceHtml(indexHtml: string, id: string): string | null {
  const open = `<template id="${id}-template">`;
  const i = indexHtml.indexOf(open);
  if (i < 0) return null;
  const j = indexHtml.indexOf('</template>', i + open.length);
  return j < 0 ? null : indexHtml.slice(i + open.length, j);
}

export class PreviewPipeline {
  private active: Active | null = null;
  /** projectId → coalesceKey of the op being applied (set by the ops.apply handler). */
  private keyed = new Map<string, string | undefined>();
  private readonly off: () => void;
  private readonly coalesceMs: number;

  private readonly engine: Engine;
  private readonly emit: (name: EventName, payload: unknown) => void;

  constructor(
    engine: Engine,
    emit: (name: EventName, payload: unknown) => void,
    o: { coalesceMs?: number } = {},
  ) {
    this.engine = engine;
    this.emit = emit;
    this.coalesceMs = o.coalesceMs ?? COALESCE_MS;
    this.off = engine.on('project.changed', (e) => this.onChanged(e as unknown as ProjectChanged));
  }

  /** Compiles and writes the sequence's preview build; it becomes the sequence that follows edits. */
  async open(projectId: string, sequenceId: string): Promise<string> {
    if (this.active?.timer) clearTimeout(this.active.timer);
    const build = await this.engine.compile(projectId, sequenceId, { mode: 'preview' });
    await this.engine.writeBuild(build);
    const prev = this.active;
    const builds =
      prev && prev.projectId === projectId && prev.sequenceId === sequenceId ? prev.builds + 1 : 0;
    this.active = {
      projectId,
      sequenceId,
      kind: null,
      ids: new Set(),
      version: 0,
      timer: null,
      building: null,
      builds,
      html: textOf(build),
    };
    return this.url(this.active);
  }

  close(): void {
    if (this.active?.timer) clearTimeout(this.active.timer);
    this.active = null;
    this.off();
  }

  /** Called by `ops.apply` before the op runs: a keyed op's change coalesces. */
  noteOp(projectId: string, coalesceKey?: string): void {
    this.keyed.set(projectId, coalesceKey);
  }

  private url(a: Active): string {
    const base = mediaUrl(a.projectId, `build/${a.sequenceId}/index.html`);
    return a.builds === 0 ? base : `${base}?v=${a.builds}`;
  }

  private onChanged(e: ProjectChanged): void {
    const a = this.active;
    if (!a || e.projectId !== a.projectId) return;
    const c = classify(e.changes, a.sequenceId);
    if (!c) return;
    a.kind = a.kind === 'reload' || c.kind === 'reload' ? 'reload' : 'patch';
    for (const id of c.ids) a.ids.add(id);
    a.version = Math.max(a.version, e.version);
    const keyed = this.keyed.get(e.projectId) !== undefined;
    this.keyed.delete(e.projectId);
    if (a.timer) return; // a coalesced build is already scheduled
    if (keyed) {
      a.timer = setTimeout(() => {
        a.timer = null;
        void this.run(a);
      }, this.coalesceMs);
    } else void this.run(a);
  }

  /** One build at a time; changes that arrive meanwhile build once more after it. */
  private async run(a: Active): Promise<void> {
    if (a.building) {
      await a.building;
      if (a.kind === null || this.active !== a) return;
      return this.run(a);
    }
    a.building = this.build(a).finally(() => (a.building = null));
    return a.building;
  }

  private async build(a: Active): Promise<void> {
    const kind = a.kind;
    const ids = [...a.ids];
    const version = a.version;
    a.kind = null;
    a.ids.clear();
    if (kind === null) return;
    let build: BuildResult;
    try {
      build = await this.engine.compile(a.projectId, a.sequenceId, { mode: 'preview' });
    } catch {
      return; // the next good change rebuilds; the op's own result already reported its error
    }
    if (this.active !== a) return;
    const html = build.files.get('index.html');
    // one scene per patch: the player delivers runtime data per channel, a second payload sent
    // before the first lands could replace it
    if (kind === 'patch' && ids.length === 1 && typeof html === 'string') {
      const patches = this.patches(html, ids, a);
      if (patches && sameOutside(a.html, html, ids)) {
        a.html = html;
        this.writeTextFiles(build);
        this.send({
          projectId: a.projectId,
          sequenceId: a.sequenceId,
          version,
          kind: 'patch',
          patches,
        });
        return;
      }
    }
    try {
      await this.engine.writeBuild(build);
    } catch {
      return;
    }
    a.html = textOf(build);
    a.builds++;
    this.send({
      projectId: a.projectId,
      sequenceId: a.sequenceId,
      version,
      kind: 'reload',
      url: this.url(a),
    });
  }

  /** Patch payloads for the scene ids, or null when one cannot be found (then reload). */
  private patches(html: string, ids: string[], a: Active): PreviewPatch[] | null {
    const out: PreviewPatch[] = [];
    for (const id of ids) {
      const inner = instanceHtml(html, id);
      const timing = new RegExp(
        `id="${id}"[^>]*data-start="([0-9.]+)"[^>]*data-duration="([0-9.]+)"`,
      ).exec(html);
      if (inner === null || !timing) return null;
      out.push({ id, start: Number(timing[1]), duration: Number(timing[2]), html: inner });
    }
    return out.length > 0 || a.kind === null ? out : null;
  }

  /** Scene-only: the generated files change (index, cues), the linked media do not. */
  private writeTextFiles(build: BuildResult): void {
    const dir = join(build.projectDir, 'build', build.sequenceId);
    for (const [rel, content] of build.files) {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      const tmp = `${p}.tmp-${process.pid}`;
      writeFileSync(tmp, content);
      renameSync(tmp, p);
    }
  }

  private send(e: PreviewUpdated): void {
    this.emit('preview.updated', e);
  }
}

function textOf(build: BuildResult): string {
  const html = build.files.get('index.html');
  return typeof html === 'string' ? html : '';
}

/**
 * True when two builds differ only inside the given scene instances (their `<template>` and their
 * host's timing). Anything else (SFX `<audio>`, the sequence duration, other layers) needs a reload.
 */
export function sameOutside(before: string, after: string, ids: readonly string[]): boolean {
  const strip = (html: string) => {
    let out = html;
    for (const id of ids) {
      const inner = instanceHtml(out, id);
      if (inner !== null) out = out.replace(inner, '');
      out = out.replace(
        new RegExp(`(id="${id}"[^>]*data-start=")[0-9.]+("[^>]*data-duration=")[0-9.]+"`),
        '$1$2"',
      );
    }
    return out;
  };
  return strip(before) === strip(after);
}
