// The `vox` CLI bundled in Vox Studio (`Resources/cli/vox.mjs`, run by `Resources/cli/vox` with
// ELECTRON_RUN_AS_NODE=1): the repo CLI with the app's Resources (styles, engine data, HyperFrames,
// `py/`, uv) instead of repo paths.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultIo, run } from '@vox/cli';
import { setResourceDirs } from '@vox/engine';
import { packagedResourceDirs } from '../engine-host/packaged.ts';

const resources = dirname(dirname(fileURLToPath(import.meta.url)));
setResourceDirs(packagedResourceDirs(resources));
process.exitCode = await run(process.argv.slice(2), { ...defaultIo, resources });
