# Phase 08 — App shell + security + GATE 4

Status: not started; early steps done under D-19

## Early steps (D-19) — u1-timeline-bench

Package U1 (GATE 4 timeline library benchmark). Branch `early/u1-timeline-bench`, merged to main
with `git merge --no-ff` right after this log entry (commit "Merge early/u1-timeline-bench", pushed;
worktree removed). No engine code touched.
Verify in the worktree after merging main: `pnpm install --frozen-lockfile`, `pnpm typecheck`,
ESLint clean, `pnpm test` 20 files, 440 passed, 1 skipped; `uv run --project py pytest` 109 passed
(after `make.sh`); the slow prototype test passes. Root `pnpm lint` fails only on Prettier for
`py/tests/schemas/audioqa.result.json`, which came from main (p2-audioqa), not from this package.

**Steps done**: A1 (benchmark) and A2 (prototype with both automated checks). A3 is NOT done: GATE 4
is not recorded and there is no DECISIONS entry; phase 08 decides it. Would-be outcome from the
numbers below: **PASS, keep `@xzdarcy/react-timeline-editor`** (not the custom canvas fallback).

**Files**
- `apps/desktop/package.json`: now `"type": "module"`, scripts `bench:timeline`, `typecheck`;
  devDependencies (exact) React, react-dom, `@types/react`, `@types/react-dom`, the timeline editor,
  Playwright, vite. Still private. `apps/desktop/tsconfig.json` (DOM libs, `react-jsx`).
- `apps/desktop/bench/timeline.ts` (CLI: `--attempts`, `--gesture-ms`, `--evidence-dir`,
  `--browser shell|chromium`, `--headed`; prints JSON, then a one-line summary; exit 0 pass,
  2 fail, 1 error; evidence needs at least 3 attempts and 3000 ms gestures).
- `apps/desktop/bench/timeline-runner.ts` (vite build in production mode, vite preview on
  127.0.0.1, Playwright driver), `bench/timeline-stats.ts` (frame stats, median, pass rule).
- `apps/desktop/bench/timeline-proto/{index.html,main.tsx,model.ts,marquee.ts}`: the throwaway
  prototype. It uses only public props, events and the ref (`onActionMoving`, `onActionMoveEnd`,
  `onActionResizing`, `onActionResizeEnd`, `getActionRender`, `onScroll`, `gridSnap`, ref `target`).
  The library has no marquee; the app draws it over empty edit-area space.
- Tests: `apps/desktop/test/bench/{timeline-model,timeline-marquee,timeline-stats}.test.ts`
  (33 tests) and `timeline-proto.slow.test.ts` (1 attempt in a real browser, asserts both checks;
  skipped on CI because CI has no Playwright browser yet).
- Evidence: `docs/evidence/phase-08/A1-timeline-bench.json`. The early brief named
  `B-timeline-bench.json`; the name follows R7 `<step>-<what>` (step A1) instead.

**Numbers** (2026-10-11, M5, 10 cores, 24 GB; under `lockf -t 3600 .git/vox-bench.lock`; 3 attempts,
3000 ms per gesture, 1,000 items on 8 tracks, 1920x1080 at DPR 2, production React build;
Playwright 1.64.0 Chromium 156.0.8078.4 headless shell, SwiftShader GPU):

| Gesture | Median fps | Attempts | p95 frame | Frames > 20 ms |
|---|---|---|---|---|
| Drag (`it_V2_10`, 300 px sweep) | 60.0 | 60.0 / 60.0 / 60.0 | 16.7 ms | 0 |
| Trim right edge (`it_V2_20`) | 60.0 | 60.0 / 60.0 / 60.0 | 16.7 ms | 0 |
| Linked V1/A1 drag (`it_V1_7`) | 60.0 | 60.0 / 60.0 / 60.0 | 16.7 ms | 0 |

- Linked check: drag `it_V1_12` +150 px; A1 partner follows during the drag (within 1 px) and both
  end with equal `startMs` (+5000 ms), 3/3. Marquee check: 0.8 s on V3 to 60.8 s on V2 selects
  exactly `it_V3_0..24` + `it_V2_0..24` = 50, model and DOM, 3/3.
- Every gesture moved the clip: library updates equal the mouse moves (about 180 each).
- Bar 50 fps; 60 is 20 % above it, so no re-run was needed (not within 10 %).
- CPU load during the run: 1-minute load 11.1 at start, 11.1 to 9.5 across the attempts (10 cores):
  other phase and early-package agents (node processes) and NotificationCenter were busy.

**How it measures, and limits**
- fps = rAF callbacks per second on the renderer main thread while real mouse input (about one
  move per frame) drags or trims; the window ends after the drop has rendered.
- Full Chromium (headed and new headless) follows the macOS display link, which runs at 30 Hz while
  the display sleeps: an empty page also gave 31 fps. The headless shell runs fixed 60 Hz frames,
  so 60 fps is its ceiling: the result means no dropped frames at 60 Hz, not a 120 Hz figure.
  Raster cost is not timed separately (software compositing). `--browser chromium` is kept for a
  run with the display awake.
- Linked follow design: the dragged clip is moved by the library; the partner follows through
  offsets on our own `getActionRender` node (a small external store, one re-render), and both land
  in the model at the drop (`flushSync` before the preview clears). Re-rendering the whole timeline
  on every move instead gave about 35 fps.

**Left for phase 08**
- Step A3: record GATE 4 (log verdict + DECISIONS entry with these numbers) and tick the steps.
- Re-run the bench inside Electron once Electron is pinned (phase 01), ideally with the display awake.
- Not measured: left-edge trim, linked trim (the model handles both; the bench drives right-edge
  trim only).
- `apps/desktop` has no `test` script yet; phase 08's Verify line `pnpm -C apps/desktop test` needs
  one. Playwright browsers on CI come with the Electron E2E.
- The rest of phase 08 (Electron shell, protocols, `window.vox`, security tests) is untouched.
- The prototype is throwaway: phase 10a builds the editor; reuse `model.ts`/`marquee.ts` only as
  reference.
