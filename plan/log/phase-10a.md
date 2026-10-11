# Phase 10a — App: editor core A (store, preview, timeline, inspector)

| Field | Value |
|---|---|
| Status | in progress |
| Started · Finished | 2026-10-11 17:29 · |
| Model | Opus 5.5 · high (phase agent, parallel run) |
| Machine | M5, macOS 27 |
| Branch | phase/10a-editor-core-a |

## Pre-check

Prerequisites 06 and 09 are [x] in PROGRESS (checked by the orchestrator). GATE 1 (D-29): whole-sequence
HyperFrames preview in the opaque sandbox, no Preview fallback, no pre-render cache (margin 20.8 %).
GATE 4 (D-35): the timeline keeps `@xzdarcy/react-timeline-editor` 1.0.0 (public props and events only).
Baseline `apps/desktop` vitest: 19 files, 194 tests pass. Phase 11 runs at the same time (CPU load).

## Plan summary

1. Shared project types (`src/shared/project.ts`, types only) and a renderer copy of the engine's
   entity map (normalise / apply change records / denormalise), since the renderer may not import the engine.
2. Editor store (Zustand): open project, versioned entity state, optimistic pending ops with
   `baseVersion`, `STALE` rebase (reload, re-run intent once, else revert + toast), coalesceKey helpers
   for sliders and text fields, linked selection, external edits → full reload, agent badge.
3. Engine host: preview pipeline (in-memory compile, 150 ms coalescing for keyed ops, scene-only →
   `patch` with instance HTML, structural → `reload`), `project.json` watcher, `media.importFiles`
   (`{ paths }` only with `VOX_E2E=1`), VFR media from the CFR copy (compile already does it; tested).
4. UI: layout shell, top bar + step bar + snapshots, native menus → renderer commands, keyboard map,
   preview controls, timeline (library) with track headers, tools, snapping, marquee, caption lane,
   style panel, inspector (media video/audio, JSON-Schema scene form, captions), agent placeholder.
5. `bench/latency.ts` + `bench:latency` (op → visible update, 90 s fixture, bench lock).

Test order: entities → store → keyboard map → engine-host preview pipeline → watcher/import → components
(top bar, preview controls, timeline helpers + component, style panel, inspector + schema form) →
Electron smoke + UI screenshots → latency bench.

## Checklist

- [ ] A1 store tests + store
- [ ] A2 preview pipeline + latency bench
- [ ] B3 layout shell, top bar, menus, keyboard
- [ ] B4 preview controls
- [ ] B5 timeline + caption lane + style panel
- [ ] B6 inspector + schema forms
- [ ] B7 agent panel placeholder
- [ ] Review (step 7), UI gate screenshots
- [ ] Verify

## Files created / changed

## Verify results

| Command | Result | Numbers |
|---|---|---|

## Done when

| # | Item | Evidence |
|---|---|---|

## Review findings

| Agent | Severity | Finding | Fixed? |
|---|---|---|---|

## Deviations

## MANUAL STEPS

None so far.

## Handoff notes
