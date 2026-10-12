#!/usr/bin/env node
// Fake `uv` for the mflux provider tests (phase 14d): behaves like `python -m vox_py.imagegen`.
// Records the request to $VOX_FAKE_UV_LOG; `install` writes the manifest and a stand-in weights file
// and leaves junk in cacheDir (the engine must delete it); `generate` copies $VOX_FAKE_IMAGE to output.
// Failure modes (D-69): $VOX_FAKE_FAIL fails before downloading; $VOX_FAKE_FAIL_AFTER_DOWNLOAD
// leaves a partial download (`.incomplete`, like huggingface_hub) and a `.part` folder, then fails;
// $VOX_FAKE_HANG_AFTER_DOWNLOAD leaves the partial download and waits to be cancelled;
// $VOX_FAKE_CRASH dies like a stale Python env (a traceback, no error JSON). The log's `resumed`
// says whether a partial download from an earlier try was there when the install started.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PARTIAL = 'snapshot.bin.incomplete';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const req = JSON.parse(input);
  const resumed = req.cacheDir ? existsSync(join(req.cacheDir, PARTIAL)) : false;
  if (process.env.VOX_FAKE_UV_LOG)
    writeFileSync(
      process.env.VOX_FAKE_UV_LOG,
      JSON.stringify({ argv: process.argv.slice(2), req, resumed }),
    );
  const progress = (p, m) =>
    process.stderr.write(JSON.stringify({ progress: p, message: m }) + '\n');
  const fail = (code, message) => {
    process.stderr.write(JSON.stringify({ error: { code, message } }) + '\n');
    process.exitCode = 1;
  };
  if (process.env.VOX_FAKE_CRASH) {
    process.stderr.write('Traceback (most recent call last):\n');
    process.stderr.write('  File "<frozen runpy>", line 189, in _run_module_as_main\n');
    process.stderr.write("ModuleNotFoundError: No module named 'mflux'\n");
    process.exitCode = 1;
    return;
  }
  if (req.action === 'install') {
    if (process.env.VOX_FAKE_FAIL) {
      fail(process.env.VOX_FAKE_FAIL, 'gated');
      return;
    }
    mkdirSync(req.cacheDir, { recursive: true });
    if (process.env.VOX_FAKE_FAIL_AFTER_DOWNLOAD || process.env.VOX_FAKE_HANG_AFTER_DOWNLOAD) {
      writeFileSync(join(req.cacheDir, PARTIAL), Buffer.alloc(4096));
      mkdirSync(`${req.modelDir}.part`, { recursive: true });
      writeFileSync(join(`${req.modelDir}.part`, 'half.bin'), Buffer.alloc(1024));
      progress(0.3, 'downloading');
      if (process.env.VOX_FAKE_HANG_AFTER_DOWNLOAD) {
        setInterval(() => {}, 1000);
        return;
      }
      fail(process.env.VOX_FAKE_FAIL_AFTER_DOWNLOAD, 'download failed: connection reset');
      return;
    }
    writeFileSync(join(req.cacheDir, 'snapshot.bin'), Buffer.alloc(4096));
    progress(0.4, 'downloading');
    mkdirSync(req.modelDir, { recursive: true });
    writeFileSync(join(req.modelDir, 'weights.bin'), Buffer.alloc(2048));
    writeFileSync(join(req.modelDir, 'vox-model.json'), JSON.stringify({ model: req.model }));
    progress(1, 'installed');
    process.stdout.write(JSON.stringify({ modelDir: req.modelDir, bytes: 2048, quantize: 8 }));
  } else {
    if (!existsSync(join(req.modelDir, 'vox-model.json'))) {
      fail('MODEL_MISSING', 'not installed');
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
