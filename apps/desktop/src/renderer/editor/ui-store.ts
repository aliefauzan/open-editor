// View state of the editor that the engine never sees: tool, zoom, in/out loop, safe area, panels,
// clipboard, dialogs. One store per editor window.
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Item } from '../../shared/project.ts';

export type Tool = 'select' | 'blade';
export type Stage = 'upload' | 'describe' | 'review' | 'export';
export type LeftTab = 'styles' | 'media' | 'subtitles';

export interface UiState {
  tool: Tool;
  /** Timeline pixels per second. */
  pxPerSec: number;
  snapping: boolean;
  inMs: number | null;
  outMs: number | null;
  loop: boolean;
  safeArea: boolean;
  /** Preview fit to the panel, or a fixed zoom (1 = 100 %). */
  previewZoom: 'fit' | number;
  playing: boolean;
  rate: number;
  stage: Stage;
  leftTab: LeftTab;
  inspectorOpen: boolean;
  snapshotsOpen: boolean;
  exportOpen: boolean;
  settingsOpen: boolean;
  /** What the Settings dialog scrolls to and focuses (a LOGIN_REQUIRED hint: the cookies toggle). */
  settingsFocus: 'cookies' | null;
  galleryOpen: boolean;
  /** The gallery opens on "New style from reference video" (the agent panel's Extract style action). */
  galleryExtract: boolean;
  /** The quick-clips next-steps bar above the preview (10b), and its note (fewer clips than asked). */
  nextSteps: boolean;
  quickNote: string | null;
  /** Copied items with their track ids, times relative to the first one. */
  clipboard: { trackId: string; item: Item }[];
  /** A "render this frame" still (vox-media URL), shown over the preview. */
  still: string | null;
  set(patch: Partial<Omit<UiState, 'set' | 'zoom'>>): void;
  zoom(dir: 1 | -1): void;
}

export const ZOOM_MIN = 5;
export const ZOOM_MAX = 800;

export type UiStore = StoreApi<UiState>;

export function createUiStore(): UiStore {
  return createStore<UiState>()((set, get) => ({
    tool: 'select',
    pxPerSec: 40,
    snapping: true,
    inMs: null,
    outMs: null,
    loop: false,
    safeArea: false,
    previewZoom: 'fit',
    playing: false,
    rate: 1,
    stage: 'review',
    leftTab: 'styles',
    inspectorOpen: true,
    snapshotsOpen: false,
    exportOpen: false,
    settingsOpen: false,
    settingsFocus: null,
    galleryOpen: false,
    galleryExtract: false,
    nextSteps: false,
    quickNote: null,
    clipboard: [],
    still: null,
    set: (patch) => set(patch),
    zoom(dir) {
      const next = dir > 0 ? get().pxPerSec * 1.5 : get().pxPerSec / 1.5;
      set({ pxPerSec: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)) });
    },
  }));
}
