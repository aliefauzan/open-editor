#!/usr/bin/env node
// Fake `vox-apple-llm --highlights <videoPath>` for engine tests (D-75): the same one-line answer
// as native/apple-llm. Never touches the network; writes a file only when VOX_FAKE_HIGHLIGHTS_LOG
// is set (it appends the arguments as one JSON line).
//
// VOX_FAKE_HIGHLIGHTS:
//   ok (default)  one highlight 4.5–14.5 s, 0.5 s level steps over 20 s, key frame 4 s
//   partial       the key frame analysis failed: keyFrameMs null and an `errors` entry
//   unavailable   {"error":{"code":"unavailable"}} (below macOS 27), exit 1
//   error         {"error":{"code":"generation"}} (analysis failed, e.g. a VP9 file), exit 1
//   old           a helper older than D-75: usage on stderr, exit 2
//   garbage       a line that is not JSON, exit 0
//   invalid       JSON that is not a highlights answer, exit 0
//   hang          never answers
import { appendFileSync } from 'node:fs';

const exitAfterFlush = (code) =>
  new Promise(() => {
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
  });

const args = process.argv.slice(2);
if (process.env.VOX_FAKE_HIGHLIGHTS_LOG)
  appendFileSync(process.env.VOX_FAKE_HIGHLIGHTS_LOG, `${JSON.stringify(args)}\n`);
const mode = process.env.VOX_FAKE_HIGHLIGHTS ?? 'ok';
const line = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);

if (mode === 'old' || args[0] !== '--highlights' || args.length !== 2) {
  process.stderr.write(`unknown argument: ${args[0] ?? ''}\nusage: vox-apple-llm [--status]\n`);
  await exitAfterFlush(2);
}
const levels = Array.from({ length: 40 }, (_, k) => ({
  startMs: k * 500,
  endMs: (k + 1) * 500,
  level: k >= 9 && k < 29 ? 8 : 3,
}));
switch (mode) {
  case 'ok':
    line({ highlights: [{ startMs: 4500, endMs: 14500 }], levels, keyFrameMs: 4000 });
    await exitAfterFlush(0);
    break;
  case 'partial':
    line({
      highlights: [{ startMs: 4500, endMs: 14500 }],
      levels,
      keyFrameMs: null,
      errors: [{ request: 'keyFrame', message: 'failed' }],
    });
    await exitAfterFlush(0);
    break;
  case 'unavailable':
    line({ error: { code: 'unavailable', message: 'video highlights need macOS 27' } });
    await exitAfterFlush(1);
    break;
  case 'error':
    line({ error: { code: 'generation', message: 'Analysis failed to complete' } });
    await exitAfterFlush(1);
    break;
  case 'garbage':
    process.stdout.write('not json\n');
    await exitAfterFlush(0);
    break;
  case 'invalid':
    line({ highlights: 'none' });
    await exitAfterFlush(0);
    break;
  case 'hang':
    setInterval(() => undefined, 1 << 30);
    break;
  default:
    process.stderr.write(`fake-apple-highlights: unknown mode ${mode}\n`);
    await exitAfterFlush(3);
}
