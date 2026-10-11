# Phase 10b — App: editor core B (quick clips, subtitles, media bin, export, gallery, E2E) + GATE 5

| Field | Value |
|---|---|
| Status | waiting for GATE 5 (owner run; not merged) |
| Started · Finished | 2026-10-11 19:10 · |
| Model | Opus 5.5 · high (phase agent, parallel run; self-review (token budget), no subagents) |
| Machine | M5, macOS 27 |
| Branch | phase/10b-editor-core-b (worktree `.worktrees/phase-10b`, kept until GATE 5) |

## Pre-check

Prerequisite 10a is [x] (merged 58c4409; checked by the orchestrator). GATE 4 (D-35) keeps the
timeline library. 10a handoff read: media bin, export dialog and settings are stubs; timeline drops
accept `application/x-vox-media`; `bench:latency` exists (needs `VOX_FIXTURES` + bench lock); "Pin
frame here" uses the nearest pin / static crop / centre, so the E2E checks the pinned frame in a render.
Phase 11 waited in its own worktree (not touched). Other phase agents ran at the same time (load
averages 6–230 during the phase; the latency bench ran under the bench lock at load 5.5).

## Plan summary

1. Main: export targets (`exports.chooseTarget`, `exports.lastFolder` returns a registered default
   folder target, `exports.reveal` allow-list), `targetId → target` mapping in main before a job reaches
   the host, raw path keys (incl. `inputs`, `target`) rejected, dialog stub only with `VOX_E2E=1`,
   Finder drops through the preload (`webUtils.getPathForFile`, real dropped files only).
2. Engine host: `media.importUrl`, `media.search`, offline media list on `projects.open`, app job
   `makeClips` (shots → transcribe → facetrack → `quickClips`, one progress; `VOX_E2E=1` seeds by hash).
3. Renderer: quick-clips start screen + next-steps bar, Subtitles panel, media bin (+ archive tab,
   Replace in timeline), export dialog, style gallery, error states.
4. E2E (Playwright for Electron): manual-edit path, quick path (seeded; `local` unseeded), editing tools.
5. CI slow job: fixtures, E2E, `bench:latency` warning-only above 1 s; `pnpm dist` + clean-install rerun
   with a render part; GATE 5 owner steps.

Test order: main export-target/reveal guard → host handlers (importUrl, search, offline, makeClips
seeding, S36) → subtitle helpers → components → E2E specs → bench + CI → dist/clean-install.

## Checklist

- [x] A1 quick clips start screen + next-steps bar (`test/renderer/quick.test.tsx`, 7)
- [x] A2 Subtitles panel, one test per action (`test/renderer/subtitles.test.tsx`, 13)
- [x] A3 media bin + archive tab + Replace in timeline (`test/renderer/media-bin.test.tsx`, 8)
- [x] A4 export dialog: Save to, loudness, audio check (`test/renderer/export.test.tsx`, 6)
- [x] A5 style gallery, A6 error states incl. S36 (`test/renderer/gallery-errors.test.tsx`, 6;
      `test/engine-host/editor-b.test.ts`, 6)
- [x] B7 E2E manual-edit path (`e2e/editor.spec.ts`)
- [x] B8 E2E quick path (`e2e/quick.spec.ts`; seeded + `.mov`/`.webm`; unseeded run `VOX_LOCAL=1` passed once)
- [x] B9 E2E editing tools (`e2e/tools.spec.ts`, 4)
- [x] B10 CI latency job (`.github/workflows/ci.yml` slow job: fixtures → test:slow → E2E → bench, warning above 1 s)
- [x] B11 reveal + target tests (`test/main/exports.test.ts`, 9; packaged S32 test in `test/packaging.slow.test.ts`)
- [x] B12 `pnpm dist` + clean-install rerun with the full editor (render part); MANUAL STEP for the owner written
- [x] Review (step 7, self-review), UI gate screenshots (`docs/evidence/phase-10b/10b-*.jpg`)
- [x] Verify
- [ ] B13 GATE 5 (owner) — see MANUAL STEPS

## Files created / changed

- Main: `src/main/exports.ts` (new: targets, last folder, reveal allow-list, dialog stub answer),
  `src/main/index.ts` (chooseTarget / lastFolder / reveal, job target mapping, `vox:drop`, test dialog queue).
- Preload: `vox.dropFiles`. Shared: `src/shared/api.ts` (`media.search`, `chooseTarget.projectId`,
  raw-path keys, job kinds with a dot, `offline` on open, `dropFiles` type).
- Engine host: `quick.ts` (new: `AppJobs`/`makeClips`, E2E seeds), `handlers.ts` (importUrl, search,
  offline, app-job routing), `index.ts`, `setup/bins.ts` (unique temp link).
- Renderer (new): `QuickStart.tsx`, `quick-flow.ts`, `NextSteps.tsx`, `SubtitlesPanel.tsx`,
  `subtitles.ts`, `MediaBin.tsx`, `ExportDialog.tsx`, `StyleGallery.tsx`, `JobsPanel.tsx`, `jobs.ts`;
  changed `App.tsx`, `Editor.tsx`, `TopBar.tsx`, `Timeline.tsx` (offline block, `useCaptions` export),
  `Inspector.tsx` (relink, pin coalescing), `StylePanel.tsx`, `store.ts` (`offline`, `openError`,
  `applyAt`), `ui-store.ts`, `context.tsx`, `Setup.tsx` + `setup-store.ts` ("Set up" buttons).
- Engine: `export-api.ts` (HyperFrames env keeps `ELECTRON_RUN_AS_NODE`; tools read at use),
  `audio/graph.ts` + `api.ts` (the mix uses the resolved ffmpeg), `compile/write.ts` (build swap by
  rename; preview skips missing media) + tests.
- Tests: listed in the checklist; `e2e/helpers.ts`; `test/editor-b-ui.slow.test.ts`;
  `test/clean-install.slow.test.ts` (render part), `test/helpers/packaged.ts` (`VOX_EVIDENCE_DIR`).
- CI: `.github/workflows/ci.yml`.

## Verify results

Run in the worktree (branch head 8c7fe0f; `git merge main` happens after GATE 5).

| Command | Result | Numbers |
|---|---|---|
| `pnpm -C apps/desktop test` | pass | 34 files, 324 tests passed, 0 failed (one run under load had a 150 ms coalescing-timing failure in `preview.test.ts`; re-run 8/8) |
| `pnpm -C apps/desktop e2e` | pass | 7 passed (smoke, manual-edit path 1.2 min, quick path seeded, tools 4), 1 skipped (`local`) in 2.5 min |
| `VOX_LOCAL=1` quick path unseeded | pass | 1/1 (13.7 s) |
| `pnpm -C apps/desktop bench:latency --runs 10` (bench lock) | PASS | patch p50 53 / p95 87 / max 87 ms; reload p50 196 / p95 435 / max 435 ms; load 5.5 → `docs/evidence/phase-10b/latency.json` |
| `VOX_SLOW=1 vitest run` editor-b-ui, editor-ui, engine-host, security slow | pass | 4 files, 31 tests |
| `pnpm dist` | pass | `Vox-Studio-0.0.0-arm64.dmg` 189.5 MB (ad-hoc signed) |
| clean-install slow test (rerun on the new dmg) | pass | 4/4: quarantine + spctl rejected (expected), ffmpeg-missing view, setup Ready, installed app renders the fixture to MP4 (20 s) + SRT + OTIO |
| packaging slow test | pass | 6/6 incl. S31 bundle unchanged and the new S32 release test |
| `pnpm -C packages/engine test` | pass | 104 files, 1302 tests (a `.local` framing test failed once under load; re-run passed) |
| `VOX_SLOW=1` engine `test/audio/mix.slow.test.ts` | pass | 7/7 |
| `pnpm lint`, `pnpm typecheck` | pass | 0 errors |

## Done when

| # | Item | Evidence |
|---|---|---|
| 1 | `.dmg` passes the clean-install test and, on the owner's account with a fresh `VOX_HOME`, completes setup; manual editing incl. MP4/SRT/OTIO into a chosen folder | automated part: `docs/evidence/phase-10b/clean-install.txt`, `setup-ready.png`, `clean-install-editor.png`; E2E `e2e/editor.spec.ts`. **Owner part open (GATE 5, MANUAL STEP 1)** |
| 2 | Quick clips with no provider: link or dropped file → 3 captioned clips, corrected subtitle in the preview, MP4 (burned in) + SRT with the correction | `e2e/quick.spec.ts` (seed file; SRT has the fix, MP4 frame differs); real YouTube / Instagram / TikTok links: **owner, MANUAL STEP 1** |
| 3 | S32 app tests | `test/main/exports.test.ts` (9), packaged S32 test (raw paths, raw target, unknown targetId, reveal, no hooks with `VOX_E2E=1`) |
| 4 | S36 app test | `test/engine-host/editor-b.test.ts` "S36", `test/renderer/gallery-errors.test.tsx` "SCHEMA_TOO_NEW" (files byte-identical) |
| 5 | App done-when 7: Pauses & fillers one entry, slider one entry, Pin frame holds the crop, loudness targets pass | `e2e/tools.spec.ts` 4/4 (loudness PASS at −14, −12, −23 LUFS targets) |
| 6 | Latency on the M5; CI warns above 1 s | patch max 87 ms, reload max 435 ms; ci.yml slow job step |
| 7 | UI gate screenshots reviewed, HIGH fixed | `docs/evidence/phase-10b/10b-*.jpg` (14) reviewed against the app spec layout (no invideo screenshot in the repo; same delegation as 10a): HIGH next-steps bar leaking into another project → fixed |
| 8 | GATE 5 recorded | **open** |

## Review findings

Self-review (token budget): code, React, TypeScript, a11y (R6 list) and R4 S32 / S36.

| Agent | Severity | Finding | Fixed? |
|---|---|---|---|
| code | HIGH | App renders and OTIO exports failed: the HyperFrames child lost `ELECTRON_RUN_AS_NODE` (Electron helper started as Chromium) | yes (engine env keep + test) |
| code | HIGH | The audio mix ran bare `ffmpeg` from PATH (an installed app's PATH has no Homebrew); export tools were captured at engine open | yes (resolved path, read at use + test) |
| code | HIGH | Offline media broke the whole preview (`MEDIA_MISSING` at build write) | yes (preview skips the missing file; render still fails) |
| code | HIGH | Setup race: two checks in one host collided on `bin/<tool>.<pid>.tmp` (clean install stuck "not ready") | yes (unique temp name + concurrency test) |
| code | MEDIUM | Build folder deleted before rewrite: an open preview logged 404s | yes (swap by rename) |
| react | HIGH | Export dialog called a hook after an early return; a render-time side effect re-requested the last folder | yes |
| ui | HIGH | Next-steps bar stayed visible in the next project | yes (reset on close; UI test asserts) |
| ui | MEDIUM | Export progress only appeared after every job finished | yes (rows as jobs start) |
| a11y | HIGH | Media bin items were drag-only | yes (Enter / "Add at playhead"; test) |
| a11y | MEDIUM | Two "Close" buttons in the export dialog | yes ("Done") |
| a11y | MEDIUM | Inspector repeats element ids (`#in-out`, `#in-tx`) when a linked pair shows video and audio sections (10a code) | no (listed) |
| a11y | MEDIUM | Audio fade handles pointer-only (10a) | no (inspector sliders cover it) |
| ui | MEDIUM | Subtitles panel: at 900 px height the chunk list gets little room under the toolbars | no |
| ui | LOW | Clip and bin names of uploads show the stored file name (`m_….mp4`); the original name is not kept by ingest | no |
| security | — | S32: renderer never sends a path (schema rejects 11 path keys; targets mapped in main; drops only real files via preload; reveal by real path allow-list; dialog stub and `{ paths }` only unpackaged + `VOX_E2E=1`, packaged test proves it); S36 byte-identical; no `dangerouslySetInnerHTML`; archive text rendered as text | — |

## Deviations

- D-45 (all choices): export targets in main (phase file wording; spec said engine host), `lastFolder`
  returns a folder target, additive `window.vox` (`media.search`, `chooseTarget.projectId`, `offline`),
  `vox.dropFiles`, `makeClips` app job and seeds, subtitle rules, pin coalescing, archive without
  thumbnails, engine fixes (HyperFrames env, build swap, preview with offline media). Found after D-45
  was written and fixed the same way: the audio mix's ffmpeg path and the setup bin-link race (listed
  in the review table).
- R4 S32 "reused `targetId` rejected" is read as "from a previous session" (D-45).
- `test/shared/api.test.ts` spec-table list gains `media.search` (spec table changed with D-45).

## MANUAL STEPS

1. **GATE 5 owner run** (required; your own account, D-16). Prepared: the `.dmg` at
   `.worktrees/phase-10b/apps/desktop/dist/Vox-Studio-0.0.0-arm64.dmg` (189.5 MB, ad-hoc signed).
   a. Quit any running Vox Studio (dev or installed).
   b. Open the `.dmg`, drag Vox Studio to Applications; first launch: right-click → Open, or System
      Settings → Privacy & Security → "Open Anyway" (or `xattr -dr com.apple.quarantine "/Applications/Vox Studio.app"`).
   c. Make the fixture project in a fresh home (from the repo root):
      `node scripts/make-offline-project.ts --projects-dir "$HOME/vox-gate5/Projects" --name "GATE 5 fixture"`
   d. Start the installed app with a fresh `VOX_HOME` and that projects folder:
      `VOX_HOME="$HOME/vox-gate5/.vox" VOX_PROJECTS_DIR="$HOME/vox-gate5/Projects" "/Applications/Vox Studio.app/Contents/MacOS/Vox Studio"`
   e. Run setup to "Ready" (Setup link on the start screen).
   f. Open "GATE 5 fixture"; by hand: import a video (Media → Import…), drag it to the timeline, trim,
      split (B), add a transition, add text and a title scene and edit their text; check the preview.
      Export MP4 + SRT + OTIO into a folder you choose (Export → Change…), and "Show in Finder".
   g. Back on the start screen (‹ Projects): paste the YouTube, Instagram and TikTok links from TODO
      "Inputs" (one each, "Make clips"), and drop one downloaded video file on the field. In one result:
      Fix subtitles → edit a word, then Export MP4 (subtitles burned in) + SRT to a folder you choose.
   h. Screenshots of f and g into `docs/evidence/phase-10b/gate5/` (≤ 500 kB each, no personal paths).
   i. Answer `GATE 5: pass` or `GATE 5: <what failed>`. A platform link that fails with a clear hint
      while its downloaded file works counts as a pass for that platform (GATE 2 fallback, D-16).

## GATE 5 (evidence and recommendation)

Automated parts all pass: clean-install test with the render part (MP4 20 s, SRT, OTIO from the
installed app), packaging + S32/S31, manual-edit / quick / tools E2E, latency patch max 87 ms / reload
max 435 ms. Recommendation: pass once the owner run (MANUAL STEP 1) works; the AI then merges.

## Handoff notes

- Phase 13: Settings replaces the TopBar stub; add "Open Settings" to the `LOGIN_REQUIRED` hint on the
  start screen (`QuickStart.tsx`); enable "Add style beats" in `NextSteps.tsx`; a generated-images tab
  belongs in `MediaBin.tsx` once an image provider exists; the agent path joins the E2E (`e2e/helpers.ts`).
- App jobs: `AppJobs` in `src/engine-host/quick.ts` (ids `job_app…`), routed by `jobs.start/get/cancel`.
- Test hooks: `__voxTest.answerDialog(answer)` answers the next native dialog (files for open, a folder
  for save/folder pickers); `VOX_E2E_NO_SEED=1` turns off quick-clip seeds.
- Export targets: `src/main/exports.ts`; `<VOX_HOME>/export-folders.json` holds the last folder per project.
- Coalesced edits show in `history.list` as entries with `replaces`; count undo entries by dropping
  replaced versions (E2E helper does).
- Uploads have no original file name in the model; a later phase may add a `name` to media.
