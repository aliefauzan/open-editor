// Engine resource folders inside a packaged app (plan R1 "Packaged app"); shared by the engine host
// and the bundled `vox` CLI, which both run the bundled engine (its `import.meta` paths point into
// the bundle, so the folders are set explicitly).
import { join } from 'node:path';
import type { ResourceDirs } from '@vox/engine';

export function packagedResourceDirs(resources: string): ResourceDirs {
  return {
    data: join(resources, 'engine-data'),
    runtime: join(resources, 'engine-data', 'runtime'),
    modules: join(resources, 'hyperframes'),
    py: join(resources, 'py'),
  };
}
