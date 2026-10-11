// App state for the phase 08 shell: project list, the open project, its preview URL, the banner.
import { create } from 'zustand';
import type { ErrorData, OpenedProject, ProjectSummary } from '../shared/api.ts';

export interface ShellState {
  projects: ProjectSummary[];
  open: OpenedProject | null;
  sequenceId: string | null;
  previewUrl: string | null;
  banner: string | null;
  error: ErrorData | null;
  loadProjects(): Promise<void>;
  createProject(name: string): Promise<void>;
  openProject(id: string): Promise<void>;
  /** After an engine host restart: reload the open project from disk and show the banner. */
  hostRestarted(): Promise<void>;
  dismissBanner(): void;
}

const asError = (e: unknown): ErrorData =>
  e && typeof e === 'object' && 'code' in e
    ? (e as ErrorData)
    : { code: 'INTERNAL', message: String(e), hint: '' };

export const useShell = create<ShellState>((set, get) => ({
  projects: [],
  open: null,
  sequenceId: null,
  previewUrl: null,
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
      await window.vox.projects.create(name);
      await get().loadProjects();
    } catch (e) {
      set({ error: asError(e) });
    }
  },
  async openProject(id) {
    try {
      const open = await window.vox.projects.open(id);
      const seq = open.project.sequences[0]?.id ?? null;
      const previewUrl = seq ? await window.vox.preview.url(id, seq) : null;
      set({ open, sequenceId: seq, previewUrl, error: null });
    } catch (e) {
      set({ error: asError(e) });
    }
  },
  async hostRestarted() {
    set({ banner: 'The engine restarted. Your project was reloaded from disk.' });
    await get().loadProjects();
    const id = get().open?.project.id;
    if (id) await get().openProject(id);
  },
  dismissBanner() {
    set({ banner: null });
  },
}));
