# Phase 08 — App shell + security + GATE 4

| Field | Value |
|---|---|
| Status | done |
| Started · Finished | 2026-10-11 08:17 · 2026-10-11 09:15 |
| Model | Opus 5.5 · high (single agent; owner asked to cut token cost) |
| Machine | M5, macOS 27 |
| Branch | phase/08-app-shell-security |

## Pre-check
01 [x] (D-29), 03 [x] (D-30), 06 [x] (D-34). Early U1 (A1, A2) on main. Phase 05 is [~] GATE 2 on an
unmerged branch: not used. Electron 44.7.0 (zip in the electron cache), Playwright 1.64.0, vite 8.3.4.

## Plan summary
1. A3: add `--browser electron` to the U1 bench, re-run GATE 4 inside Electron 44.7.0 under the bench
   lock, record numbers + DECISIONS entry.
2. Scaffold `apps/desktop/src/{main,preload,engine-host,shared,renderer}`. Build with vite 8 directly
   (electron-vite 5.0.0 accepts vite ≤ 7 only; R5 keeps vite 8.3.4) — DECISIONS entry.
3. Pure modules first, unit-tested (vitest): app/media protocol (CSP, headers, range, path rule from
   `@vox/engine/paths`), IPC sender guard + zod validation, `window.vox` schema, external-link
   allowlist, host RPC.
4. Engine host: `utilityProcess` + `MessagePort`, `openEngine` with `trustFile`, restart on crash.
5. Minimal React UI (project picker + `<hyperframes-player>` opaque) + Zustand.
6. Slow tests against the built app (Playwright `_electron`): security S10–S15, S28; engine host;
   `e2e/smoke.spec.ts`. 7. Skeleton `.dmg` (electron-builder, ad-hoc, arm64).
Test order: protocol → ipc guard → api schema → links → rpc → (build) → security.slow → host.slow → smoke.

## GATE 4 (step A3) — decided: PASS, keep the library (D-35)

Re-run inside Electron 44.7.0 (Chromium 152.0.7977.130), 2026-10-11 08:3x, under
`lockf -t 1800 .git/vox-bench.lock`; load average 2.6–2.8 (no other phase agent running).
`node bench/timeline.ts --browser electron --attempts 3 --gesture-ms 3000 --evidence-dir …`:
real 1920x1080 window (`enableLargerThanScreen`), DPR 2, ANGLE Metal on the M5, display awake at 120 Hz.

| Gesture | Median fps | Attempts | p95 frame | Frames > 20 ms |
|---|---|---|---|---|
| Drag | 119.7 | 119.6 / 119.7 / 119.7 | ≤ 9.6 ms | 0 / 0 / 0 |
| Trim right edge | 119.7 | 119.7 / 119.7 / 119.3 | ≤ 9.0 ms | 0 / 0 / 1 |
| Linked V1/A1 drag | 119.4 | 119.3 / 119.7 / 119.4 | ≤ 9.3 ms | 1 / 0 / 1 |

Linked 3/3, marquee 50 of 50 3/3, gestures moved 3/3 (updates = moves, 344–360). Bar 50 fps; not
within 10 % → decided by the numbers, no stop. Evidence `docs/evidence/phase-08/A3-timeline-bench-electron.json`.
Bench changes: `--browser electron` (Playwright `_electron`, CommonJS bench main
`bench/timeline-electron-main.cjs`; an ESM main made `_electron.launch` time out). A first try at the
laptop's work-area size (1512x835) put the trim clip off-screen (0 updates), hence the fixed 1920x1080 window.

## Checklist
- [x] 1–3 GATE 4: bench in Electron, prototype checks, PASS (D-35) — section above
- [x] 4 IPC: subframe / non-`vox-app://` sender rejected, invalid args → `ARGS_INVALID` (S11) —
      `test/main/guard.test.ts`, `test/shared/api.test.ts`, `test/security.slow.test.ts`
- [x] 5 `vox-media://`: media CSP with `connect-src 'none'`, `attachment` + `nosniff`, 206/416 ranges,
      traversal (encoded `..`, absolute, NUL, symlink out) refused (S1, S13) — `test/main/protocol.test.ts`,
      security slow test
- [x] 6 hostile template fixture: `fetch`, `parent.vox`, `window.top.location` get nothing (S14) —
      security slow test (`hostileProject`)
- [x] 7 renderer http(s)/ws blocked, `will-navigate` / `window.open` denied, permissions denied (log
      asserted), effective `webPreferences` asserted, app CSP with `frame-ancestors 'none'`,
      allowlisted external links only (S10, S12, S15, S28) — security slow test, `guard.test.ts`
- [x] 8 engine host: projects list/create/open, `ops.apply` with `baseVersion` + `coalesceKey`, per-op
      `results`, stale → `conflicted`/`STALE` (D-28), events forwarded through the redactor, crash →
      restart + reload + banner — `test/engine-host/handlers.test.ts`, `test/engine-host.slow.test.ts`
- [x] 9 minimal UI (project picker + opaque-sandbox preview) and `e2e/smoke.spec.ts`: the 90 s fixture
      plays, current time advances, no console errors
- [x] 10 skeleton `.dmg` (ad-hoc signed arm64, 123 MB): `pnpm -C apps/desktop dist` builds it; the app
      launched from `/Applications` (Playwright drove the installed binary: picker loads, create project
      round-trips through the bundled engine host, no console errors, `__voxTest` absent).
      Screenshot `docs/evidence/phase-08/B10-packaged-app.png`. MANUAL STEP (optional) in TODO.

## What was built
- `apps/desktop/src/shared/api.ts`: the `window.vox` method table as zod tuples (37 methods), events,
  app error codes, `parseCall`. `src/preload/index.ts` builds `window.vox` from it.
- `src/main/`: `protocol.ts` (`vox-app://`, `vox-media://`, CSPs, headers, ranges, path rule from
  `@vox/engine/paths`), `guard.ts` (sender check, zod, external-link allowlist), `host.ts` (engine host
  in a `utilityProcess` on a `MessageChannelMain`, restart ≤ 5/min), `index.ts` (schemes, session
  hardening, navigation / window / webview / permission handlers, IPC, test hooks only when
  `!app.isPackaged && VOX_E2E=1`).
- `src/engine-host/`: `rpc.ts` (MessagePort RPC; error replies redacted), `handlers.ts` (window.vox →
  engine API; later-phase methods answer `NOT_AVAILABLE`), `index.ts` (opens the engine with
  `trustFile`).
- `src/renderer/`: React 19 + Zustand + Tailwind 4; project picker, `<hyperframes-player
  sandbox-origin="opaque">` preview, host-restart banner.
- `scripts/build.ts` (vite 8, D-36), `electron-builder.yml` (skeleton), `e2e/` (Playwright for
  Electron), `test/helpers/{app,fixture}.ts`, bench `--browser electron` (A3).

## Decisions
D-35 (GATE 4 pass, keep the library), D-36 (plain vite 8 build, no electron-vite; CJS main for
Playwright; shell pins; shadcn/ui deferred to 10a), D-37 (`vox-media://` CORS-enabled, `ACAO: *` on
fonts only; app spec "Untrusted HTML" edited). R5 rows filled.

## Review
self-review (owner asked to cut token cost). Security focus (R4 S1, S10–S15, S19, S28; R6):
- HIGH, fixed: engine-host error replies passed `Error.message` through unredacted (only events went
  through the redactor); a provider error could carry a key to the renderer. `serve()` now redacts
  error replies; test with the R4 canary key (`handlers.test.ts`).
- MEDIUM, fixed: Playwright `test-results/` was tracked; now ignored.
- LOW, accepted: `vox-media://p/...` is one origin for every project, so one project's build could
  embed another project's files by URL; it cannot read or send them (`connect-src 'none'`, no network,
  no CORS on non-fonts). Revisit if per-project hosts are cheap in 10a.
- LOW, for 09: the skeleton bundle still has Electron's `default_app.asar`, and fuses are not set yet
  (S27 is a phase 09 step).
- Checked, no finding: sender check needs main frame + `vox-app://app` + an app window; zod on every
  call; `projects.reveal` id validated twice; test hooks absent in the packaged app; `will-navigate`,
  `will-redirect`, window open, webview attach all denied; permission request and check handlers
  deny; app CSP `frame-ancestors 'none'`; ACAO only on fonts.
- TypeScript / React: typecheck now covers tests, e2e and scripts (it did not before; 22 errors
  fixed: erasable-syntax parameter property, RPC message typing, handler arg types); the effect in
  `App.tsx` reads store actions through `getState()` (no stale deps).
- UI review: the minimal shell is not the editor (10a), so there is nothing to compare with the
  reference layout yet (`docs/reference/invideo-layout.png` is not in place either). Dark, readable,
  no overflow at 1280×820 (screenshot above).

## Verify (2026-10-11)
- `pnpm -C apps/desktop test`: 7 files, 99 passed.
- `pnpm -C apps/desktop bench:timeline` (bench lock, headless shell): 60 / 60 / 60 fps, linked 3/3,
  marquee 3/3 → PASS. In Electron (A3, evidence): 119.7 / 119.7 / 119.4 fps.
- `pnpm -C apps/desktop e2e -- smoke` (`VOX_FIXTURES` = engine fixtures): 1 passed (4.4 s).
- `pnpm -C apps/desktop test:slow -- security`: 3 files, 19 passed (security 16, engine-host 2,
  prototype 1).
- `pnpm typecheck` (desktop), `pnpm lint` clean; root `pnpm test` 120 files, 1734 passed, 1 skipped.

## Done when
| Item | State |
|---|---|
| GATE 4 decided (DECISIONS with numbers) | yes, D-35 |
| Main / engine-host security tests pass incl. S28 | yes (security slow test 16/16) |
| Skeleton `.dmg` builds and launches | yes (from `/Applications`) |
| Fixture plays under the production CSP and sandbox mode | yes (smoke e2e) |
| `window.vox` schema frozen once 05 is also done | not yet: 05 is `[~]` (GATE 2); PROGRESS milestone stays open |

## Deviations
- No electron-vite (D-36). Main and preload are CommonJS bundles.
- `vox-media://` is CORS-enabled for fonts (D-37; the spec said `corsEnabled: false`).
- `media.importFiles`, `exports.*`, `setup.*`, `agent.*` answer `NOT_AVAILABLE` until their phases.
- `getUserMedia` for the microphone never answers in Electron 44 when denied (no reject); the test
  waits 5 s and asserts it is not granted, plus the permission log.

## Manual steps
- Optional (does not block the merge): open the `.dmg` once through Gatekeeper ("Open Anyway"); see
  `plan/TODO.md` "Manual steps".

## Handoff
- pnpm does not run Electron's postinstall unless allowed: `pnpm-workspace.yaml` `allowBuilds` has
  `electron: true` now; on an existing checkout run `node install.js` in
  `apps/desktop/node_modules/electron` (and `spike/`) once. CI needs the same.
- Phase 09: engine-host resources (data files, vendored runtime, tools) in the bundle; fuses (S27);
  drop `default_app.asar`; icon; size. Packaged builds run `out/engine-host/index.mjs`.
- Phase 10a: trust confirmation UI (`styles.accept` exists; ask the user before trusting, as 06
  said); shadcn/ui; the editor layout. Playwright's Electron launcher needs a CommonJS main.
- Phase 05 merge: re-run `pnpm -C apps/desktop test` and the security slow test; then mark the
  `window.vox` freeze milestone.

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
