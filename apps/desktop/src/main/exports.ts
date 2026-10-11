// Export targets (app spec "Export dialog", "Engine-host API" `exports.*`; plan D-13; R4 S32).
// Main opens the save dialog / folder picker and keeps `targetId → path` for this session only; the
// renderer only ever holds the `targetId` and a display path. A job's `targetId` becomes the engine's
// `target` here, after the zod check rejected any raw path from the renderer. The folder last used per
// project is remembered across sessions (a plain path in `<VOX_HOME>/export-folders.json`); its
// targetId is new each session. `exports.reveal` accepts only a project's `renders/` or a path
// written into a target chosen this session.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ErrorData } from '../shared/api.ts';

export type TargetMode = 'file' | 'folder';

interface Target {
  mode: TargetMode;
  path: string;
}

export interface ChosenTarget {
  targetId: string;
  displayPath: string;
}

function targetError(message: string): ErrorData {
  return {
    code: 'EXPORT_TARGET',
    message,
    hint: 'Choose where to save in the export dialog ("Change…") and export again.',
  };
}

/** `/Users/me/Movies/x` → `~/Movies/x` (display only). */
export function displayPath(path: string, home: string): string {
  return home && (path === home || path.startsWith(home + sep))
    ? `~${path.slice(home.length)}`
    : path;
}

/**
 * The real path of the deepest existing ancestor plus the rest, so a symlink cannot widen the
 * allow-list and a file not written yet compares like its folder.
 */
function real(path: string): string {
  const p = resolve(path);
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(real(parent), basename(p));
  }
}

const inside = (child: string, parent: string): boolean => {
  const r = relative(parent, child);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
};

export class ExportTargets {
  private readonly targets = new Map<string, Target>();
  private last: Record<string, string>;

  private readonly o: { stateFile: string; defaultFolder: string; home: string };

  constructor(
    o: {
      /** `<VOX_HOME>/export-folders.json` */
      stateFile: string;
      /** `~/Movies` */
      defaultFolder: string;
      home: string;
    },
  ) {
    this.o = o;
    try {
      const raw = JSON.parse(readFileSync(o.stateFile, 'utf8')) as unknown;
      this.last =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? Object.fromEntries(
              Object.entries(raw).filter(
                (e): e is [string, string] => typeof e[1] === 'string' && isAbsolute(e[1]),
              ),
            )
          : {};
    } catch {
      this.last = {};
    }
  }

  /** A path the user picked in a dialog (or the remembered folder) → a new session targetId. */
  register(mode: TargetMode, path: string): ChosenTarget {
    if (!isAbsolute(path)) throw targetError(`Export target is not an absolute path: ${path}`);
    const targetId = `t_${randomBytes(8).toString('hex')}`;
    this.targets.set(targetId, { mode, path: resolve(path) });
    return { targetId, displayPath: displayPath(resolve(path), this.o.home) };
  }

  /** The folder last used for this project (else the default), registered as a folder target. */
  lastFolder(projectId: string): ChosenTarget {
    return this.register('folder', this.last[projectId] ?? this.o.defaultFolder);
  }

  /** The folder a target writes into (the dialog's default for the next export). */
  folderOf(targetId: string): string | undefined {
    const t = this.targets.get(targetId);
    return t && (t.mode === 'folder' ? t.path : dirname(t.path));
  }

  remember(projectId: string, folder: string): void {
    this.last = { ...this.last, [projectId]: folder };
    mkdirSync(dirname(this.o.stateFile), { recursive: true });
    const tmp = `${this.o.stateFile}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(this.last, null, 2)}\n`);
    renameSync(tmp, this.o.stateFile);
  }

  /**
   * `jobs.start` args from the renderer → engine args: `targetId` becomes `target` (`{ file }` with
   * `overwrite`, since the save dialog already asked; or `{ dir }`, where the engine adds ` (2)`).
   * An unknown or previous-session targetId is rejected.
   */
  mapJobArgs(args: Record<string, unknown>): Record<string, unknown> {
    if (args['targetId'] === undefined) return args;
    const id = args['targetId'];
    const t = typeof id === 'string' ? this.targets.get(id) : undefined;
    if (!t) throw targetError(`Unknown export target ${String(id)} (targets last one session)`);
    const { targetId: _drop, ...rest } = args;
    const projectId = typeof args['projectId'] === 'string' ? args['projectId'] : undefined;
    if (projectId) this.remember(projectId, t.mode === 'folder' ? t.path : dirname(t.path));
    return t.mode === 'file'
      ? { ...rest, target: { file: t.path }, overwrite: true }
      : { ...rest, target: { dir: t.path } };
  }

  /**
   * `exports.reveal(path)`: a file under `<projectsDir>/<projectId>/renders/`, the file of a file
   * target, or a file directly inside a folder target chosen this session.
   */
  revealAllowed(path: string, projectsDir: string): boolean {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return false;
    if (resolve(path) !== path) return false; // `..` or `.` segments
    const p = real(path);
    const projects = real(projectsDir);
    if (inside(p, projects)) {
      const [projectId, folder, ...rest] = relative(projects, p).split(sep);
      if (/^p_[a-z0-9]+$/.test(projectId ?? '') && folder === 'renders' && rest.length > 0)
        return true;
    }
    for (const t of this.targets.values()) {
      const target = real(t.path);
      // a file target is replaced in place (the save dialog asked); only folders get ` (2)` names
      if (t.mode === 'folder' ? dirname(p) === target : p === target) return true;
    }
    return false;
  }
}

/** The test build's dialog stub: a folder answer → `<folder>/<suggestedName>` in file mode. */
export function stubAnswer(mode: TargetMode, folder: string, suggestedName?: string): string {
  return mode === 'folder' ? folder : join(folder, basename(suggestedName ?? 'export'));
}
