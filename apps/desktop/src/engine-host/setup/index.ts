// Setup modules (phase 09, built early as S1 under D-19). The engine host wires these to IPC.
export * from './errors.ts';
export * from './types.ts';
export * from './version.ts';
export * from './paths.ts';
export * from './manifest.ts';
export * from './http.ts';
export * from './hash.ts';
export * from './download.ts';
export * from './extract.ts';
export * from './install.ts';
export * from './pyenv.ts';
export * from './ffmpeg.ts';
export * from './ytdlp.ts';
export * from './update.ts';
export * from './stages.ts';
export { getSetupStatus, installAll, repairComponent, resolveUv } from './setup.ts';
export type {
  ComponentStateName,
  ComponentStatus,
  Delegate,
  InstallAllResult,
  SetupContext,
  SetupStatus,
} from './setup.ts';
