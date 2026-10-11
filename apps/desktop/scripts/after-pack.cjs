/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder loads this hook with require() */
// electron-builder afterPack (before fuses and signing): drop Electron's default_app.asar, which a
// custom electronDist leaves in Resources. The app loads only its own app.asar (OnlyLoadAppFromAsar,
// R4 S27), so the default app is dead weight and one more thing to sign.
const { rmSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  const app = `${context.packager.appInfo.productFilename}.app`;
  rmSync(join(context.appOutDir, app, 'Contents', 'Resources', 'default_app.asar'), {
    force: true,
  });
};
