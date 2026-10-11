#!/usr/bin/env node
// Wrapper around fake-apple-llm.mjs for restart tests: each spawn takes the next answer script.
//   VOX_FAKE_APPLE_SCRIPTS  JSON array of VOX_FAKE_APPLE_ANSWERS arrays, one per spawn
//   VOX_FAKE_APPLE_SPAWNS   counter file (created on first spawn); holds the number of spawns so far
//   VOX_FAKE_APPLE_ENVLOG   optional: write this process's environment variable names here
// `--status` spawns count too. Writes only the files named above.
import { readFileSync, writeFileSync } from 'node:fs';

const counterPath = process.env.VOX_FAKE_APPLE_SPAWNS;
let spawns = 0;
if (counterPath) {
  try {
    spawns = Number(readFileSync(counterPath, 'utf8')) || 0;
  } catch {
    spawns = 0;
  }
  writeFileSync(counterPath, String(spawns + 1));
}
if (process.env.VOX_FAKE_APPLE_ENVLOG) {
  writeFileSync(process.env.VOX_FAKE_APPLE_ENVLOG, Object.keys(process.env).sort().join('\n'));
}
const scripts = JSON.parse(process.env.VOX_FAKE_APPLE_SCRIPTS ?? '[]');
const script = scripts[Math.min(spawns, scripts.length - 1)] ?? [];
process.env.VOX_FAKE_APPLE_ANSWERS = JSON.stringify(script);
await import('./fake-apple-llm.mjs');
