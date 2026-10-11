# Phase 10b — App: editor core B (quick clips, subtitles, media bin, export, gallery, E2E) + GATE 5

| Field | Value |
|---|---|
| Status | in progress |
| Started · Finished | 2026-10-11 19:10 · |
| Model | Opus 5.5 · high (phase agent, parallel run; self-review (token budget), no subagents) |
| Machine | M5, macOS 27 |
| Branch | phase/10b-editor-core-b |

## Pre-check

Prerequisite 10a is [x] (merged 58c4409; checked by the orchestrator). GATE 4 (D-35) keeps the
timeline library. 10a handoff read: media bin, export dialog and settings are stubs; timeline drops
accept `application/x-vox-media`; `bench:latency` exists (needs `VOX_FIXTURES` + bench lock); "Pin
frame here" uses the nearest pin / static crop / centre, so the E2E checks the pinned frame in a render.
Phase 11 waits in its own worktree (not touched).

## Plan summary

1. Main: export targets (`exports.chooseTarget`, `exports.lastFolder` returns a registered default
   folder target, `exports.reveal` allow-list), `targetId → target` mapping in main before a job reaches
   the host, raw path keys (incl. `inputs`, `target`) rejected, dialog stub only with `VOX_E2E=1`,
   Finder drops through the preload (`webUtils.getPathForFile`, real dropped files only).
2. Engine host: `media.importUrl`, `media.search` (names, tags, descriptions, transcript text),
   offline media list on `projects.open`, app job `makeClips` (shots → transcribe → facetrack →
   `quickClips`, one progress; `VOX_E2E=1` seeds the checked-in transcript/shots/facetrack by media hash).
3. Renderer: quick-clips start screen + next-steps bar ("Captions only" batch), Subtitles panel
   (every action + Delete word + Pauses & fillers), media bin (+ archive tab, Replace in timeline),
   export dialog (formats, Save to, loudness, audio check), style gallery, error states (offline block +
   relink, job rows with Retry / `JOB_CONFLICT` items, Set up buttons, fewer-clips note, `SCHEMA_TOO_NEW`).
4. E2E (Playwright for Electron): manual-edit path, quick path (seeded; `local` unseeded), editing tools.
5. CI slow job: `bench:latency` warning-only above 1 s; `pnpm dist` + clean-install rerun; GATE 5 owner steps.

Test order: main export-target/reveal guard → host handlers (importUrl, search, offline, makeClips
seeding, S36) → subtitle helpers → components (quick start, subtitles one test per action, media bin,
export dialog, gallery, error states) → E2E specs → bench + CI → dist/clean-install.

## Checklist

- [ ] A1 quick clips start screen + next-steps bar
- [ ] A2 Subtitles panel (one test per action)
- [ ] A3 media bin + archive tab + Replace in timeline
- [ ] A4 export dialog (Save to, loudness, audio check)
- [ ] A5 style gallery
- [ ] A6 error states (+ S36 test)
- [ ] B7 E2E manual-edit path
- [ ] B8 E2E quick path
- [ ] B9 E2E editing tools
- [ ] B10 CI latency job
- [ ] B11 reveal + target tests (S32)
- [ ] B12 `pnpm dist` + clean-install rerun; MANUAL STEP for the owner
- [ ] Review (step 7, self-review), UI gate screenshots
- [ ] Verify
- [ ] B13 GATE 5 (owner)
