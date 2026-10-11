# Phase 10a — App: editor core A (store, preview, timeline, inspector)

| Field | Value |
|---|---|
| Status | [x] merged 2026-10-11 19:05 (UI gate: spec-layout check accepted by owner delegation) |
| Started · Finished | 2026-10-11 17:29 · |
| Model | Opus 5.5 · high (phase agent, parallel run; self-review (token budget), no subagents) |
| Machine | M5, macOS 27 |
| Branch | phase/10a-editor-core-a |

## Pre-check

Prerequisites 06 and 09 are [x] in PROGRESS (checked by the orchestrator). GATE 1 (D-29): whole-sequence
HyperFrames preview in the opaque sandbox, no Preview fallback, no pre-render cache (margin 20.8 %).
GATE 4 (D-35): the timeline keeps `@xzdarcy/react-timeline-editor` 1.0.0 (public props and events only).
Baseline `apps/desktop` vitest: 19 files, 194 tests pass. Phase 11 ran at the same time (CPU load
averages 12–28 during this phase).

## Plan summary

1. Shared project types (`src/shared/project.ts`, types only) and a renderer copy of the engine's
   entity map (normalise / apply change records / denormalise), since the renderer may not import the engine.
2. Editor store (Zustand): open project, versioned entity state, optimistic pending ops with
   `baseVersion`, `STALE` rebase (reload, re-run intent once, else revert + toast), coalesceKey helpers
   for sliders and text fields, linked selection, external edits → full reload, agent badge.
3. Engine host: preview pipeline (in-memory compile, 150 ms coalescing for keyed ops, scene-only →
   `patch` with instance HTML, structural → `reload`), `project.json` watcher, `media.importFiles`
   (`{ paths }` only with `VOX_E2E=1`), VFR media from the CFR copy.
4. UI: layout shell, top bar + step bar + snapshots, native menus → renderer commands, keyboard map,
   preview controls, timeline (library) with track headers, tools, snapping, marquee, caption lane,
   style panel, inspector (media video/audio, JSON-Schema scene form, captions), agent placeholder.
5. `bench/latency.ts` + `bench:latency` (op → visible update, 90 s fixture, bench lock).

Test order: entities → store → keyboard map → engine-host preview pipeline → watcher/import → components
(top bar, preview controls, timeline helpers + component, style panel, inspector + schema form) →
Electron UI test + screenshots → latency bench.

## Checklist

- [x] A1 store tests + store (`test/renderer/store.test.ts`, 9 tests)
- [x] A2 preview pipeline (`test/engine-host/preview.test.ts`, 8) + watcher + latency bench
- [x] B3 layout shell, top bar, menus, keyboard (`keyboard.test.tsx`, 28: one test per shortcut + commands)
- [x] B4 preview controls (`components.test.tsx` "preview controls")
- [x] B5 timeline + caption lane + style panel (`timeline-model.test.ts`, `components.test.tsx`)
- [x] B6 inspector + schema forms (`components.test.tsx` "inspector", crop handle)
- [x] B7 agent panel placeholder
- [x] Review (step 7, self-review), UI gate screenshots (`docs/evidence/phase-10a/10a-*.png`)
- [x] Verify
- [x] UI gate: owner delegated the decision on 2026-10-11 ("u do it for me"); accepted the check against the app spec layout (agent left, preview top centre, media + styles bottom left, timeline bottom, inspector right), no HIGH findings. Not compared with an invideo screenshot (none given).

## Files created / changed

- `apps/desktop/src/shared/project.ts` (new: project, change, preview, style types), `commands.ts`
  (new: command + key table), `api.ts` (`media.peaks`, event `menu.command`).
- `apps/desktop/src/renderer/editor/*` (new): `entities.ts`, `optimistic.ts`, `store.ts`, `ui-store.ts`,
  `time.ts`, `editing.ts`, `commands.ts`, `keyboard.ts`, `context.tsx`, `Editor.tsx`, `TopBar.tsx`,
  `PreviewPanel.tsx`, `CropHandle.tsx`, `Timeline.tsx`, `timeline-model.ts`, `timeline-handlers.ts`,
  `SequenceTabs.tsx`, `CaptionLane.tsx`, `StylePanel.tsx`, `use-styles.ts`, `Inspector.tsx`,
  `SchemaForm.tsx`, `AgentPanel.tsx`; `App.tsx`, `store.ts` (shell) rewritten around the editor.
- `apps/desktop/src/engine-host/preview.ts`, `watch.ts` (new); `handlers.ts` (pipeline, watcher,
  `media.importFiles`, `media.peaks`); `index.ts` (pipeline wired).
- `apps/desktop/src/main/index.ts` (native menu bar, import dialog), `guard.ts` (`importPathsError`).
- `apps/desktop/bench/latency.ts` (new), `package.json` (`bench:latency`, test deps),
  `vitest.config.ts` (`.test.tsx`).
- `packages/engine/src/compile/compile.ts` (VFR without proxy previews from the CFR copy) + test.
- Tests: `test/renderer/{entities,store,timeline-model}.test.ts`, `{keyboard,components}.test.tsx`,
  helpers `engine-fixture.ts`, `fake-vox.ts`, `ctx.ts`; `test/engine-host/{preview,watch}.test.ts`;
  `test/editor-ui.slow.test.ts`; `handlers.test.ts`, `guard.test.ts`, `api.test.ts` extended.

## Verify results

Run in the worktree after `git merge main` (clean).

| Command | Result | Numbers |
|---|---|---|
| `pnpm -C apps/desktop test` | pass | 26 files, 268 tests passed, 0 failed (9.7 s) |
| `pnpm -C apps/desktop bench:latency --runs 10` (bench lock) | PASS | patch p50 59 / p95 194 / max 194 ms; reload p50 174 / p95 421 / max 421 ms; every update found in the player's document; load 11.6–15.8 (phase 11 running) → `docs/evidence/phase-10a/latency.json` |
| earlier trial run (3 runs, load 28) | pass | patch max 488 ms, reload max 924 ms (within 10 % of the bar, so re-run above under the bench lock) |
| `VOX_SLOW=1 vitest run test/editor-ui.slow.test.ts` | pass | 5/5; screenshots in `docs/evidence/phase-10a/` |
| `VOX_SLOW=1 vitest run test/engine-host.slow.test.ts test/security.slow.test.ts` | pass | 18/18 |
| `playwright test -c e2e/playwright.config.ts` (smoke) | pass | 1/1 |
| `pnpm -C packages/engine test` | pass | 101 files, 1297 tests (a first run under load average ~28 had 1 failure that was not captured; the re-run passed fully) |
| `tsc --noEmit -p apps/desktop`, `pnpm lint` | pass | 0 errors |

## Done when

| # | Item | Evidence |
|---|---|---|
| 1 | Store, preview pipeline, top bar, keyboard, preview, timeline and inspector component tests pass | `test/renderer/*`, `test/engine-host/preview.test.ts`: store 9, preview 8, keyboard 28, components 17, timeline model 6, entities 2 — all pass |
| 2 | Latency bench < 1000 ms on the 90 s fixture | patch max 194 ms, reload max 421 ms (`latency.json`) |
| 3 | UI gate screenshots reviewed against `docs/reference/invideo-layout.png`; HIGH fixed | **open**: screenshots taken (`10a-editor.png`, `10a-topbar.png`, `10a-preview.png`, `10a-timeline.png`, `10a-inspector-*.png`) and reviewed against the app spec layout (agent left, preview top centre, media/styles bottom left, timeline bottom, inspector right: matches, no HIGH); the reference screenshot is not in the repo (TODO "Inputs"), so the comparison with it waits for MANUAL STEP 1 |

## Review findings

Self-review (token budget): code, React, TypeScript, a11y and the UI rows of R4 (S10–S14).

| Agent | Severity | Finding | Fixed? |
|---|---|---|---|
| react | HIGH | Selectors that built a new object (`findItem`, crop target, `?? []`) re-rendered forever (React #185) | yes: `useEditorShallow`, stable empty list |
| react | HIGH | After a reload the player's `timeupdate` 0 overwrote the playhead; paused-player time echoes undid frame steps | yes: restore guard, the store owns the playhead while paused (UI test asserts 00:00:05:00 after a split) |
| code | HIGH | Caption chunk shape was `lines: { words }[]`, not `CaptionWord[][]`: the lane showed no words | yes (type + UI test) |
| code | HIGH | Scenes added from the style panel had `{}` variables (validation error) | yes: starter variables |
| code | MEDIUM | Two scenes in one patch could lose one (runtime data per channel) | yes: one scene per patch, else reload (test) |
| a11y | MEDIUM | Crop handle not keyboard operable | yes: arrow keys (test) |
| a11y | MEDIUM | Audio fade handles are pointer-only (`tabIndex -1`); the inspector fade sliders cover keyboard users | no (listed) |
| a11y | LOW | Small `text-neutral-500` hints on `neutral-900` are low contrast | no |
| ui | LOW | Clip labels show the media file name (`m_….mp4`); caption words crowd at low zoom | no (10b media bin adds names) |
| security | — | No `dangerouslySetInnerHTML`; instance HTML only goes to the opaque player (S14); `vox-media://` URLs are encoded; `media.peaks` uses the path rule; `{ paths }` import only in test builds; menu commands only to app windows and checked against the command list | — |

## Deviations

- D-42: `preview.updated` payload, one scene per patch, `media.peaks`, `menu.command`, J/L behaviour,
  no shadcn/ui, Pin-frame crop source, no pre-render cache re-measure, starter variables.
- `test/engine-host/handlers.test.ts`: the phase 08 assertion "`media.importFiles` has no handler"
  now checks another main-only method (`exports.chooseTarget`); 10a builds `media.importFiles` by
  design, and a new test covers it.
- The geo picker component test stubs `geo.search` (jsdom's `URL` breaks the engine's data-file
  lookup in that environment); the engine's place search has its own tests.

## MANUAL STEPS

1. ~~**Reference layout screenshot**~~ (closed 2026-10-11: owner delegated; spec-layout check accepted instead) (required for done-when 3): put the invideo editor screenshot at
   `docs/reference/invideo-layout.png` (gitignored), then send `done: 10a layout screenshot`. The AI
   then compares `docs/evidence/phase-10a/10a-*.png` with it, fixes HIGH findings, re-runs Verify and
   merges. (Already listed under TODO "Inputs".)

## Handoff notes

- Store: `createEditorStore(vox)` (`src/renderer/editor/store.ts`); `apply(call, { coalesceKey, intent })`,
  `setField(field, itemId, call)` for sliders/text (`<field>:<itemId>`), `agentItems` for the agent badge
  (phase 13). The renderer's entity map must follow any change to the engine's `normalise.ts`.
- Commands: `src/shared/commands.ts` + `createCommandRunner`; export (`export`) and settings
  (`settings`) open stubs in the top bar — 10b/13 replace them.
- Media bin tab is a placeholder (10b). Timeline drops accept `application/x-vox-media`
  `{ kind: 'media', id, hasAudio }` (placeClip, linked pair with `withAudio`).
- `preview.updated` reload URLs carry `?v=<n>`; the renderer fires `vox-preview-applied` on window when
  an update is in the player (used by `bench:latency`; 10b's CI latency job can reuse the bench).
- "Pin frame here" uses the nearest pin / static crop / centre, not the tracked path; 10b's E2E should
  check the pinned frame in a render.
- Fade handles and the crop handle send coalesced ops; one gesture is one undo entry only within the
  engine's 1 s coalescing window.
- `bench:latency` needs the generated fixtures (`VOX_FIXTURES` or `make.sh`); run it under the bench lock.
- The UI slow test writes screenshots to `VOX_EVIDENCE_DIR` (default: a temp folder).
