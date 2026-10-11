#!/usr/bin/env node
// Fake yt-dlp for ingest tests: records argv + proxy env, then acts per FAKE_YTDLP_MODE.
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const log = process.env.FAKE_YTDLP_LOG;
const proxyEnv = Object.keys(process.env).filter((k) => /proxy/i.test(k));
if (log) appendFileSync(log, `${JSON.stringify({ args, proxyEnv })}\n`);
const modes = (process.env.FAKE_YTDLP_MODE ?? 'ok').split(',');
let n = 0;
const counter = process.env.FAKE_YTDLP_COUNTER;
if (counter) {
  n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
  writeFileSync(counter, String(n + 1));
}
const mode = modes[Math.min(n, modes.length - 1)];
if (mode.startsWith('stderr:')) {
  process.stderr.write(readFileSync(mode.slice(7), 'utf8'));
  process.exit(1);
}
const out = args[args.indexOf('-o') + 1];
const count = Number(process.env.FAKE_YTDLP_COUNT ?? 1);
const items = args.includes('--playlist') || !args.includes('--playlist-items') ? count : 1;
for (let i = 1; i <= items; i++) {
  const file = out.replace('%(playlist_index)s', String(i)).replace('%(ext)s', 'mp4');
  copyFileSync(process.env.FAKE_YTDLP_SOURCE, file);
  process.stdout.write('vox-progress 50 100\nvox-progress 100 100\n');
  process.stdout.write(
    `vox-result ${JSON.stringify({ filepath: file, id: `v${i}`, playlist_count: count, playlist_index: i })}\n`,
  );
}
