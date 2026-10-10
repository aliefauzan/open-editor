# Phase 00 — Foundation

| Field | Value |
|---|---|
| Status | in progress |
| Started · Finished | 2026-10-10 · |
| Model | Sonnet 5.5 · medium |
| Machine | M5, macOS 27.0.1, Node 24.14.0, pnpm 12.0.0, ffmpeg 8.1.2, uv 0.11.19 |
| Branch | main (phase 00 works on main, no worktree) |
| Resume from | |

## Pre-check
TODO "Before phase 00" ticked. Repo exists (3 commits, origin in sync). Step A1 already satisfied.
LICENSE holder was a personal name; changed to "Vox Studio contributors" (2026).
Finding: Homebrew ffmpeg 8.1.2 has NO `drawtext` (no libfreetype). See deviation below.

## Plan summary
1. Root tooling (package.json, workspace, tsconfig, eslint, prettier, vitest workspace, .nvmrc).
2. Packages engine/agent/cli + apps/desktop placeholder, one passing test each (test first).
3. py/ uv project + wheel package-data test.
4. Fetch CC0 portraits + tap from Commons (fresh dir, inspect, ffmpeg process), LICENSES.md.
5. make.sh (+ --seed-media), fixture tests, seed hash test, speech-fillers transcript.
6. CI workflow, push, check run.
Test order: version tests, cli, lint-rule test, pytest + wheel test, seed hash, make.sh slow test.

## Checklist
(see below, updated as work proceeds)

## Deviations
