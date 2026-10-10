#!/usr/bin/env node
// Fake `uv` for the media job tests: answers `-m vox_py.<tool>` with canned results.
// VOX_FAKE_PY_STARTED: file written when the tool starts. VOX_FAKE_PY_GO: when set, waits for that file
// before answering (lets a test edit the project while the job runs). VOX_FAKE_PY_LOG: appends tool names.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const tool = (argv[argv.indexOf('-m') + 1] ?? '').replace(/^vox_py\./, '');
if (process.env.VOX_FAKE_PY_LOG) appendFileSync(process.env.VOX_FAKE_PY_LOG, `${tool}\n`);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const req = JSON.parse(input);
  if (process.env.VOX_FAKE_PY_STARTED)
    writeFileSync(process.env.VOX_FAKE_PY_STARTED, JSON.stringify(req));
  const answer = () => {
    if (tool === 'doctext') {
      process.stdout.write(JSON.stringify({ text: 'Slide one\n\nSlide two', pages: 2 }));
    } else if (tool === 'transcribe') {
      process.stderr.write(`${JSON.stringify({ progress: 0.5, message: 'whisper' })}\n`);
      process.stdout.write(
        JSON.stringify({
          language: 'en',
          words: [
            { text: 'Hello', startMs: 0, endMs: 300 },
            { text: 'um', startMs: 400, endMs: 600 },
            { text: 'world', startMs: 700, endMs: 1000 },
          ],
          speechRegions: [{ startMs: 0, endMs: 1000 }],
          dropped: { segments: 0, words: 0 },
          model: {
            repo: 'mlx-community/whisper-large-v3-turbo',
            revision: 'a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb',
          },
        }),
      );
    } else {
      process.stderr.write(
        `${JSON.stringify({ error: { code: 'VALIDATION', message: `no fake for ${tool}` } })}\n`,
      );
      process.exitCode = 1;
    }
  };
  const go = process.env.VOX_FAKE_PY_GO;
  if (!go) return answer();
  const t = setInterval(() => {
    if (existsSync(go)) {
      clearInterval(t);
      answer();
    }
  }, 20);
});
