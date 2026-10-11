#!/usr/bin/env node
// Fake `uv` for the Python bridge tests. Records argv + uv env to $VOX_FAKE_UV_LOG, then acts like a
// vox_py tool: reads one JSON request on stdin and behaves according to `request.mode`.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const log = process.env.VOX_FAKE_UV_LOG;
if (log) {
  const env = {};
  for (const k of [
    'UV_PROJECT_ENVIRONMENT',
    'UV_CACHE_DIR',
    'UV_PYTHON_INSTALL_DIR',
    'OPENROUTER_API_KEY',
    'ORT_DISABLE_TELEMETRY',
    'HF_HUB_DISABLE_TELEMETRY',
    'DO_NOT_TRACK',
  ]) {
    env[k] = process.env[k] ?? null;
  }
  writeFileSync(log, JSON.stringify({ argv: process.argv.slice(2), env }));
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const req = JSON.parse(input);
  switch (req.mode) {
    case 'echo':
      process.stdout.write(JSON.stringify({ echo: req.payload }));
      break;
    case 'progress':
      process.stderr.write('uv: resolved 3 packages\n');
      process.stderr.write(JSON.stringify({ progress: 0.5, message: 'half' }) + '\n');
      process.stderr.write(JSON.stringify({ progress: 1 }) + '\n');
      process.stdout.write(JSON.stringify({ echo: 'done' }));
      break;
    case 'wrong-shape':
      process.stdout.write(JSON.stringify({ unexpected: true }));
      break;
    case 'garbage':
      process.stdout.write('this is not json');
      break;
    case 'fail': {
      for (let i = 0; i < req.lines; i++) process.stderr.write(`err line ${i} ${req.secret}\n`);
      process.exitCode = 3;
      break;
    }
    case 'tool-error': {
      process.stderr.write('Traceback-like noise\n');
      process.stderr.write(
        `${JSON.stringify({ error: { code: req.code, message: 'pdf is encrypted' } })}\n`,
      );
      process.exitCode = 1;
      break;
    }
    case 'hang': {
      // a grandchild in the same process group, like uv → python
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      writeFileSync(req.pidFile, JSON.stringify({ uv: process.pid, python: child.pid }));
      setInterval(() => {}, 1000);
      break;
    }
    default:
      process.stderr.write(`unknown mode ${req.mode}\n`);
      process.exitCode = 2;
  }
});
