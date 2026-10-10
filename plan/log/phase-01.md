# Phase 01 — Spike + GATE 1

| Field | Value |
|---|---|
| Status | done |
| Started · Finished | 2026-10-11 00:18 · 2026-10-11 03:13 |
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
- [x] A1 install HyperFrames 0.8.145 + Chrome; check CLI flags (`lint --json`, `render --strict-all`, `--quality draft`, `--format mov` all exist; no difference)
- [x] A2 `make-project.ts` (main + NTSC variants, CFR copy)
- [x] A3 per-instance vars + `vox-runtime.js` + scoped tokens
- [x] A4 `hyperframes lint --json` zero errors (render builds: 0 errors, 0 warnings)
- [x] B5 cut accuracy (item 1)
- [x] B6 A/V sync (item 2)
- [x] B7 render speed (item 3)
- [x] B8 memory (item 5)
- [x] B9 preview in Electron (item 4) + heavy-scene fps margin
- [x] B10 op → preview, patch vs reload (item 6)
- [x] B11 mechanisms (item 7)
- [x] B12 opaque fallback rerun: not needed (item 4 passes in opaque mode)
- [x] B12b fillers (item 8)
- [x] B12c NTSC (item 9)
- [x] C13 `docs/SPIKE_RESULTS.md` + outcome
- [x] C14 DECISIONS (D-29), engine spec "Spike", TODO gate table, R5 pins

## Files created / changed
- `spike/` (workspace package): `make-project.ts`, `lib/` (model, compile, frames, barcode, probes,
  proc, gate), `templates/` (scene templates, `vox-runtime.js`, `vox-preview.js`), `bench/`
  (render, analyze, mechanisms, fillers, preview, all, lib), `electron/` (main, protocol, page, probes,
  tests), `test/` (6 files, 45 tests), `README.md`.
- `pnpm-workspace.yaml` (+ spike), `vitest.config.ts` (spike tests), `pnpm-lock.yaml` (pnpm install).
- On main: `docs/SPIKE_RESULTS.md`, `docs/evidence/phase-01/`, engine spec "Spike" (measured
  numbers), `plan/ref/R5-pins.md` (HyperFrames, GSAP, Electron, HyperFrames Chrome).

## Measurements (all under the bench lock)
Other phases ran during attempts 1–3 (load averages in each evidence file). Preview (item 4):
| Run | Load (1/5/15 min) | Min fps | Max stall | Seek max | Picture p95 after seeks | Margin | Result |
|---|---|---|---|---|---|---|---|
| attempt 1 | 11.0/10.3/12.8 | 23.0 | 1034 ms | 1040 ms | 45.8 ms | −4.2 % | fail |
| attempt 2 | 7.3/9.4/12.1 | 28.2 | 83 ms | 44 ms | 27.7 ms | 20.8 % | pass |
| attempt 3 (margin within 10 % of the bar) | 8.6/8.7/11.4 | 28.0 | 84 ms | 67 ms | 26.4 ms | 20.8 % | pass |
| final `bench:all` | 9.8/9.3/10.5 | 26.4 | 83 ms | 53 ms | 23.8 ms | 20.8 % | pass |

Debugging (superpowers:systematic-debugging) between attempts 1 and 2:
- 1034 ms stall at frame 691 / 2581: a measuring error. The pre-cue shows a clip's first frame
  about 1 s before the clip starts, while it is hidden. A media-event trace showed smooth playback.
  Fix: a frame counts as on screen only once the clock is within one frame of it.
- About 1.03 s seek outliers (1 in 40): the media-state trace showed the element seeked, at the right
  `currentTime`, and rVFC reported the right frame within 7 ms, while the window showed the clip's
  older pre-cue picture for about 1 s. Not the runtime's 1 s seek hold (no `seekHoldCap`
  diagnostics, no images due). Fix: inactive videos stay visible at opacity 0 instead of
  `visibility:hidden`. 0 outliers in 240 seeks since.
- Attempt 1's 23 fps window at the `stack` scene and the post-seek picture lag (p50 about 34 ms;
  the runtime's rate correction starts at 40 ms) did not recur at the lower load; no code change.
- Earlier (before attempt 1): +1 ms preview video bias (17 of 40 seeks showed frame k−1), `vox.mount`
  marker claiming, pre-cue, paused exact-frame sync, playhead after mount (reload 1.1–1.3 s → < 0.8 s).

Render items (1, 2, 3, 5, 9, 7-render) passed in render attempt 2 (load 13.9: 0.92× real time) and
again in the final run (0.67×). Item 8 recorded. Same-origin mode was not measured (not needed).

## Verify results
| Command | Result | Numbers |
|---|---|---|
| `pnpm -C spike bench:all` | pass | one line per item 1–9 + margin + `gate-1`: all pass, outcome "whole-sequence render; NTSC go; no pre-render cache" |
| `hyperframes lint --json spike/out/project` | pass | 0 errors, 0 warnings (also `project-ntsc`) |
| `pnpm typecheck` | pass | 0 errors (after `git merge main`) |
| `pnpm lint` | pass | eslint 0 errors, prettier clean |
| `pnpm test` | pass | 94 files, 1504 passed, 1 skipped (spike: 6 files, 45 tests) |

## Done when
| # | Item | Evidence |
|---|---|---|
| 1 | All 9 items have a result and numbers | `docs/SPIKE_RESULTS.md`, `docs/evidence/phase-01/` |
| 2 | Patch vs reload latency recorded | patch max 31 ms, reload max 757 ms (`B11-op-preview-opaque.json`) |
| 3 | Fps margin recorded; NTSC go; cache not needed | 20.8 %; `B-ntsc.json`; `B-fps-margin-opaque.json` |
| 4 | GATE 1 in DECISIONS; engine spec "Spike" has version and numbers | D-29; engine spec "Spike" → "Measured" |
| 5 | `spike/README.md` reruns everything with one command | `pnpm -C spike bench:all` |

## Review findings
Self-review (owner asked to cut token cost; no review agents).
| Agent | Severity | Finding | Fixed? |
|---|---|---|---|
| self | MEDIUM | `bench:all --reuse` skips items 3 and 5, so the gate line would select the hybrid export | yes: the line is marked `partial` |
| self | MEDIUM | `vox-preview.js` depends on runtime internals (`visibility: hidden` inline style, out-point parking, sync tolerances) | noted in SPIKE_RESULTS; rerun the spike on every upgrade |
| self | LOW | slow-seek diagnostics call into the frame during polling, adding a few ms only to seeks already wrong after 30 ms | accepted |
| self | LOW | the preview build lint reports `gsap_timeline_not_registered` (inline templates) | recorded; the preview build is never rendered |

## Handoff notes
- Phase 03 compile and 10a preview: carry over the `vox-preview.js` helpers listed in D-29 (+1 ms
  video bias in preview builds only; audio exact).
- The heavy-scene margin (20.8 %) is close to the bar; 10a should re-measure with the real styles.
- Reload costs about one template mount per scene (p50 0.44–0.72 s with 12 scenes); keep the patch path.
- The runtime routes preview `<audio>` through WebAudio: `el.volume` reads 1, the gain node carries tweens.
