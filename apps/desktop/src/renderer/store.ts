// App shell state: the project list, the banner and errors. The open project lives in the editor
// store (editor/store.ts).
import { create } from 'zustand';
import type { ErrorData, ProjectSummary } from '../shared/api.ts';

export interface ShellState {
  projects: ProjectSummary[];
  banner: string | null;
  error: ErrorData | null;
  loadProjects(): Promise<void>;
  createProject(name: string): Promise<string | null>;
  /** After an engine host restart: show the banner and reload the list. */
  hostRestarted(): Promise<void>;
  dismissBanner(): void;
}

const asError = (e: unknown): ErrorData =>
  e && typeof e === 'object' && 'code' in e
    ? (e as ErrorData)
    : { code: 'INTERNAL', message: String(e), hint: '' };

export const useShell = create<ShellState>((set, get) => ({
  projects: [],
  banner: null,
  error: null,
  async loadProjects() {
    try {
      set({ projects: await window.vox.projects.list(), error: null });
    } catch (e) {
      set({ error: asError(e) });
    }
  },
  async createProject(name) {
    try {
      const p = await window.vox.projects.create(name);
      await get().loadProjects();
      return p.id;
    } catch (e) {
      set({ error: asError(e) });
      return null;
    }
  },
  async hostRestarted() {
    set({ banner: 'The engine restarted. Your project was reloaded from disk.' });
    await get().loadProjects();
  },
  dismissBanner() {
    set({ banner: null });
  },
}));
