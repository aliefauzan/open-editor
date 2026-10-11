import type { VoxApi } from '../shared/api.ts';

declare global {
  interface Window {
    vox: VoxApi;
  }
}
