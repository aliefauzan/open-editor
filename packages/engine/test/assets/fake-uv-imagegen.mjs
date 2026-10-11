#!/usr/bin/env node
// Fake `uv` for the mflux provider tests (phase 14d): behaves like `python -m vox_py.imagegen`.
// Records the request to $VOX_FAKE_UV_LOG; `install` writes the manifest and a stand-in weights file
// and leaves junk in cacheDir (the engine must delete it); `generate` copies $VOX_FAKE_IMAGE to output.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const req = JSON.parse(input);
  if (process.env.VOX_FAKE_UV_LOG)
    writeFileSync(
      process.env.VOX_FAKE_UV_LOG,
      JSON.stringify({ argv: process.argv.slice(2), req }),
    );
  const progress = (p, m) =>
    process.stderr.write(JSON.stringify({ progress: p, message: m }) + '\n');
  if (req.action === 'install') {
    if (process.env.VOX_FAKE_FAIL) {
      process.stderr.write(
        JSON.stringify({ error: { code: process.env.VOX_FAKE_FAIL, message: 'gated' } }) + '\n',
      );
      process.exitCode = 1;
      return;
    }
    mkdirSync(req.cacheDir, { recursive: true });
    writeFileSync(join(req.cacheDir, 'snapshot.bin'), Buffer.alloc(4096));
    progress(0.4, 'downloading');
    mkdirSync(req.modelDir, { recursive: true });
    writeFileSync(join(req.modelDir, 'weights.bin'), Buffer.alloc(2048));
    writeFileSync(join(req.modelDir, 'vox-model.json'), JSON.stringify({ model: req.model }));
    progress(1, 'installed');
    process.stdout.write(JSON.stringify({ modelDir: req.modelDir, bytes: 2048, quantize: 8 }));
  } else {
    if (!existsSync(join(req.modelDir, 'vox-model.json'))) {
      process.stderr.write(
        JSON.stringify({ error: { code: 'MODEL_MISSING', message: 'not installed' } }) + '\n',
      );
      process.exitCode = 1;
      return;
    }
    progress(0.5, 'generating');
    copyFileSync(process.env.VOX_FAKE_IMAGE, req.output);
    process.stdout.write(
      JSON.stringify({
        output: req.output,
        width: req.width,
        height: req.height,
        seed: req.seed ?? 1,
      }),
    );
  }
});
