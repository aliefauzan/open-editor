# Phase 01 — Spike + GATE 1

| Field | Value |
|---|---|
| Status | in progress |
| Started · Finished | 2026-10-11 00:18 · |
| Model | Opus 5.5 · high |
| Machine | M5 (10 cores, 24 GB), macOS 27.0.1, Node 24.14.0, pnpm 12.0.0, ffmpeg 8.1.2 |
| Branch | phase/01-spike-gate1 (worktree `.worktrees/phase-01`) |
| Resume from | |

## Pre-check
Phase 00 is [x]. D-10, D-15, D-16, D-17 read. Phase 02 runs in parallel in `.worktrees/phase-02`
(CPU load): every timing/fps/latency number is taken under the bench lock (`.git/vox-bench.lock`).

## Plan summary
1. `spike/` workspace package (own `package.json`, added to `pnpm-workspace.yaml`); pin HyperFrames 0.8.145
   (`hyperframes` CLI + `@hyperframes/player`) and Electron; install the HyperFrames Chrome.
2. `spike/make-project.ts` writes `spike/out/project/` (90 s, 1080x1920, 30 fps; ≥ 40 V1 cuts of the
   spike source, 8 scene instances incl. a `stack` with 2 nested panels and a video-slot scene, image with
   push-in, crossfade, captions, A1 linked audio, VFR phone clip through a CFR copy) and
   `spike/out/project-ntsc/` (30000/1001, NTSC source). Hand-written HTML, vendored runtime + GSAP,
   per-instance `data-vox-vars`, `vox-runtime.js`, `--tok-*` scoped tokens. An edit-list JSON is written
   next to each build so the bench scripts know every cut's expected source frame.
3. `spike/bench/*`: one script per pass-bar item, each prints one JSON line and writes evidence to
   `docs/evidence/phase-01/` (`--evidence-dir`). Frame reading uses the D-17 barcode decoder.
4. `spike/electron/`: `vox-app://` renderer + `vox-media://` protocol (range requests, CSPs from the app
   spec), player with `sandbox-origin="opaque"`; preview fps/stall/seek, A/V drift, heavy-scene margin,
   patch vs reload latency, mechanisms (item 7); opaque → `allow-same-origin` rerun only if needed.
5. Fillers (mlx-whisper via `uv run --with`), NTSC render.
6. `docs/SPIKE_RESULTS.md`, engine spec "Spike" numbers, R5 pins, DECISIONS (GATE 1 outcome).

Test order: barcode decoder + edit-list/expected-frame helpers (unit, vitest in `spike/`), protocol path
rule + range handler (unit), then the measurement scripts themselves (each item gets ≤ 3 attempts).

## Checklist
- [ ] A1 install HyperFrames 0.8.145 + Chrome; check CLI flags
- [ ] A2 `make-project.ts` (main + NTSC variants, CFR copy)
- [ ] A3 per-instance vars + `vox-runtime.js` + scoped tokens
- [ ] A4 `hyperframes lint --json` zero errors
- [ ] B5 cut accuracy (item 1)
- [ ] B6 A/V sync (item 2)
- [ ] B7 render speed (item 3)
- [ ] B8 memory (item 5)
- [ ] B9 preview in Electron (item 4) + heavy-scene fps margin
- [ ] B10 op → preview, patch vs reload (item 6)
- [ ] B11 mechanisms (item 7)
- [ ] B12 opaque fallback rerun (only if item 4 fails in opaque mode)
- [ ] B12b fillers (item 8)
- [ ] B12c NTSC (item 9)
- [ ] C13 `docs/SPIKE_RESULTS.md` + outcome
- [ ] C14 DECISIONS, engine spec "Spike", TODO gate table
