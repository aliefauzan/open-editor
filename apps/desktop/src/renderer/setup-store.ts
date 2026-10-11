// First-run setup state for the setup screen (app spec "First-run setup"; plan phase 09 step 2).
import { create } from 'zustand';
import type { ErrorData, SetupProgressData, SetupStatusData } from '../shared/api.ts';

export interface ComponentProgress {
  phase: SetupProgressData['phase'];
  receivedBytes?: number;
  totalBytes?: number;
  message?: string;
}

export interface SetupState {
  status: SetupStatusData | null;
  /** Shown instead of the editor (a component missing or a doctor error, or opened by the user). */
  open: boolean;
  /** The user opened or closed the screen: automatic opening stops. */
  touched: boolean;
  checking: boolean;
  installing: string[];
  progress: Record<string, ComponentProgress>;
  errors: Record<string, ErrorData>;
  refresh(): Promise<void>;
  install(component: string): Promise<void>;
  onProgress(e: SetupProgressData): void;
  show(open: boolean): void;
}

const asError = (e: unknown): ErrorData =>
  e && typeof e === 'object' && 'code' in e
    ? (e as ErrorData)
    : { code: 'INTERNAL', message: String(e), hint: '' };

export const useSetup = create<SetupState>((set, get) => ({
  status: null,
  open: false,
  touched: false,
  checking: false,
  installing: [],
  progress: {},
  errors: {},
  async refresh() {
    set({ checking: true });
    try {
      const status = await window.vox.setup.status();
      // until the user chooses, the screen opens when something needs them: a missing component
      // or a doctor error (a running doctor alone does not open it)
      const needed = !status.ready || (status.doctor !== undefined && !status.doctor.ok);
      set((s) => ({ status, open: s.touched ? s.open : needed }));
    } catch (e) {
      set((s) => ({ errors: { ...s.errors, status: asError(e) } }));
    } finally {
      set({ checking: false });
    }
  },
  async install(component) {
    const errors = { ...get().errors };
    delete errors[component];
    set((s) => ({ installing: [...s.installing, component], errors }));
    try {
      const r = await window.vox.setup.install(component);
      const failed = Object.fromEntries(
        r.failed.map((f) => [f.id, { code: f.code, message: f.message, hint: '' } as ErrorData]),
      );
      set((s) => ({ errors: { ...s.errors, ...failed } }));
    } catch (e) {
      set((s) => ({ errors: { ...s.errors, [component]: asError(e) } }));
    } finally {
      set((s) => ({ installing: s.installing.filter((c) => c !== component) }));
      await get().refresh();
    }
  },
  onProgress(e) {
    if (e.component === 'doctor') {
      void get().refresh();
      return;
    }
    set((s) => ({
      progress: {
        ...s.progress,
        [e.component]: {
          phase: e.phase,
          ...(e.receivedBytes === undefined ? {} : { receivedBytes: e.receivedBytes }),
          ...(e.totalBytes === undefined ? {} : { totalBytes: e.totalBytes }),
          ...(e.message === undefined ? {} : { message: e.message }),
        },
      },
    }));
  },
  show(open) {
    set({ open, touched: true });
  },
}));

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}
