export type SetupPhase = 'download' | 'verify' | 'extract' | 'install' | 'sync' | 'done' | 'error';

/** The `setup.progress` event the engine host emits to the setup screen. */
export interface SetupProgressEvent {
  type: 'setup.progress';
  component: string;
  phase: SetupPhase;
  receivedBytes?: number;
  totalBytes?: number;
  message?: string;
}

export type ProgressSink = (event: SetupProgressEvent) => void;

export function progress(
  sink: ProgressSink | undefined,
  component: string,
  phase: SetupPhase,
  extra: Omit<SetupProgressEvent, 'type' | 'component' | 'phase'> = {},
): void {
  sink?.({ type: 'setup.progress', component, phase, ...extra });
}
