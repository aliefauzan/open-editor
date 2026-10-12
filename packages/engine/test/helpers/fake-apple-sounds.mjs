#!/usr/bin/env node
// Fake `vox-apple-llm --sounds` for engine tests (D-83): reads the one-line request on stdin and
// answers like native/apple-llm. Never touches the network; writes a file only when
// VOX_FAKE_SOUNDS_LOG is set (it appends {args, request} as one JSON line).
//
// VOX_FAKE_SOUNDS:
//   ok (default)  laughter 6–7.5 s (0.8) and applause 7.5–9 s (0.6), 1.5 s windows
//   empty         no window with a reaction
//   unavailable   {"error":{"code":"unavailable"}}, exit 1
//   error         {"error":{"code":"generation"}}, exit 1
//   old           a helper older than D-83: usage on stderr, exit 2
//   crash         no answer, exit 134 (SoundAnalysis aborting on a file it cannot decode)
//   garbage       a line that is not JSON, exit 0
//   invalid       JSON that is not a sounds answer, exit 0
//   hang          never answers
import { appendFileSync } from 'node:fs';

const exitAfterFlush = (code) =>
  new Promise(() => {
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
  });

const args = process.argv.slice(2);
const mode = process.env.VOX_FAKE_SOUNDS ?? 'ok';
const line = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);

if (mode === 'old' || args[0] !== '--sounds' || args.length !== 1) {
  process.stderr.write(`unknown argument: ${args[0] ?? ''}\nusage: vox-apple-llm [--status]\n`);
  await exitAfterFlush(2);
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (process.env.VOX_FAKE_SOUNDS_LOG)
  appendFileSync(process.env.VOX_FAKE_SOUNDS_LOG, `${JSON.stringify({ args, request })}\n`);

switch (mode) {
  case 'ok':
    line({
      windows: [
        { startMs: 6000, endMs: 7500, labels: [{ id: 'laughter', confidence: 0.8 }] },
        { startMs: 7500, endMs: 9000, labels: [{ id: 'applause', confidence: 0.6 }] },
      ],
      windowMs: 1500,
    });
    await exitAfterFlush(0);
    break;
  case 'empty':
    line({ windows: [], windowMs: 1500 });
    await exitAfterFlush(0);
    break;
  case 'unavailable':
    line({ error: { code: 'unavailable', message: 'no sound classifier' } });
    await exitAfterFlush(1);
    break;
  case 'error':
    line({ error: { code: 'generation', message: 'analysis failed' } });
    await exitAfterFlush(1);
    break;
  case 'crash':
    process.stderr.write(
      "*** Terminating app due to uncaught exception 'com.apple.coreaudio.avfaudio'\n",
    );
    await exitAfterFlush(134);
    break;
  case 'garbage':
    process.stdout.write('not json\n');
    await exitAfterFlush(0);
    break;
  case 'invalid':
    line({ windows: 'none' });
    await exitAfterFlush(0);
    break;
  case 'hang':
    setInterval(() => {}, 1 << 30);
    break;
}
