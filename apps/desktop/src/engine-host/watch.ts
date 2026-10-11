// External edits (app spec "Live updates" step 5): the engine host watches the open project's folder
// for `project.json` writes by another process (`vox op` in a terminal). Reading the project makes the
// engine notice the new file and announce it as `project.changed { actor: 'external' }`; the app's
// own writes leave the engine's file stamp unchanged, so they announce nothing.
import { watch, type FSWatcher } from 'node:fs';
import type { Engine } from '@vox/engine';

export function watchProject(
  engine: Engine,
  projectId: string,
  dir: string,
  o: { debounceMs?: number } = {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let w: FSWatcher | null = null;
  try {
    w = watch(dir, { persistent: false }, (_type, name) => {
      if (name !== null && name !== 'project.json') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        engine.getProject(projectId).catch(() => undefined);
      }, o.debounceMs ?? 50);
    });
    w.on('error', () => undefined);
  } catch {
    // the folder vanished; nothing to watch
  }
  return () => {
    if (timer) clearTimeout(timer);
    w?.close();
  };
}
