/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder loads this hook with require() */
// electron-builder afterSign (phase 13, D-16): checks the signed app. When build-info.json says the
// build has the Apple helper, `bin/vox-apple-llm` must exist and carry a valid signature, and the app
// seal must verify; a release build never ships an unsigned or missing helper.
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterSign(context) {
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = join(app, 'Contents', 'Resources');
  const info = JSON.parse(readFileSync(join(resources, 'build-info.json'), 'utf8'));
  const helper = join(resources, 'bin', 'vox-apple-llm');
  if (info.appleHelper === true) {
    if (!existsSync(helper))
      throw new Error('afterSign: build-info says appleHelper but bin/vox-apple-llm is missing');
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', helper]);
  } else if (existsSync(helper)) {
    throw new Error('afterSign: a no-apple build must not contain bin/vox-apple-llm');
  }
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
};
