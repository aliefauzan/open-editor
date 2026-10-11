/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder loads this hook with require() */
// electron-builder afterPack (before fuses and signing): drop Electron's default_app.asar, which a
// custom electronDist leaves in Resources. The app loads only its own app.asar (OnlyLoadAppFromAsar,
// R4 S27), so the default app is dead weight and one more thing to sign.
// Phase 13 (D-16): the Apple helper `bin/vox-apple-llm` gets its own ad-hoc signature here, before
// the app is sealed, so the app's seal covers the signed helper (signing it later would break it).
const { execFileSync } = require('node:child_process');
const { existsSync, rmSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  const app = `${context.packager.appInfo.productFilename}.app`;
  const resources = join(context.appOutDir, app, 'Contents', 'Resources');
  rmSync(join(resources, 'default_app.asar'), { force: true });
  const helper = join(resources, 'bin', 'vox-apple-llm');
  if (existsSync(helper)) {
    execFileSync('/usr/bin/codesign', [
      '--force',
      '--sign',
      '-',
      '--identifier',
      'app.vox.studio.apple-llm',
      helper,
    ]);
  }
};
