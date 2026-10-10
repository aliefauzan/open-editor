# Phase 10b — App: editor core B (quick clips, subtitles, bin, export, gallery, E2E) + GATE 5

| Field | Value |
|---|---|
| Track | app |
| Prereq | 10a |
| Spec § | app "Screens" (quick clips start screen, Subtitles panel, media bin, export dialog incl. "Save to" and audio check, style gallery), "Engine-host API" (`exports.*`, `media.classifyUrl`), "Error handling", "Testing" (E2E without agent, E2E quick clips, export targets, reveal, performance, editing tools), "Done when" 1 and 7 |
| Model | Sonnet 5.5 · high |
| Gate | **GATE 5** (4-core done) |
| Next | 13 |

Split from the old phase 10 (D-06). Quick clips and the Subtitles panel added by D-11.

## Goal

A user pastes a URL and gets captioned 9:16 clips with no AI key; wrong subtitles are fixed by hand;
the plain clip exports with subtitles burned in. Media also comes in through the bin, export works,
errors are recoverable from the UI, and both the manual-edit path and the quick path pass E2E and
work from a freshly installed `.dmg` (clean-install test plus the owner's run with a fresh `VOX_HOME`,
D-16). This is the "4-core" milestone: the app is a real editor
before the agent exists.

## Required reading

- App spec sections above; engine spec "Quick clips", "Captions" (editing), "Ingest sources", "Export
  targets", "Audio QA", "Edit operations" (`removePauses`, `removeWords`); DECISIONS D-11, D-13, D-14, D-15; R4 S32, S36 (app part); phase 10a handoff notes; GATE 4 decision.

## Output

- **Quick clips (start screen)** per app spec: one field "Paste a YouTube, Instagram or TikTok link, or drop
  a video file", a "Choose file…" button, a platform badge from `media.classifyUrl`, "How many clips"
  (default 3), "Length" (default 30–60 s); `LOGIN_REQUIRED` shows its hint with "Choose file…" (and "Open
  Settings" once 13 adds the cookies toggle, D-13); "Make clips" creates a project and runs ingest →
  shots → transcribe → facetrack → `quickClips` (05) with one progress view; the clips enter as one
  history entry, so one undo removes them all (D-15); then the editor opens with one
  sequence tab per clip and the next-steps bar: **Fix subtitles**, **Add style** ("Captions only" works
  now; "Add style beats" is disabled with "needs a model — Settings" until 13), **Export**. Recent
  projects and "New empty project" stay on the start screen.
- **Subtitles panel** (tab beside the media bin): every caption chunk with its time; click to seek;
  edit text in place (word overrides via `setCaptions`, several words allowed); find and replace across
  the sequence; nudge a word's start/end by frames; split a chunk at a word / merge with the next
  (`breakAfter`); hide a word (`text: null`); mark or clear emphasis (override `emphasis`); "Reset to
  transcript" per chunk or for all. Each edit is one undoable op and shows in the preview within the
  latency target. **Delete word** (D-15): selected words + delete → `removeWords { sequenceId, wordKeys }`,
  which cuts their time from the linked video and audio as one undo entry (hide only hides the caption).
  **Pauses & fillers** (D-15): "Minimum pause" slider (350 ms and up, default 350 ms; pause pseudo-words
  exist only for gaps ≥ 350 ms) and tick boxes for fillers and
  repeats; "Find" runs `removePauses` with `dryRun: true` and lists each range (time, kind, words; all
  ticked, click seeks); "Apply" sends the full list as one `removePauses`, or a ticked subset as one
  `removePauses { wordKeys }` (each range keeps `keepMs`), with the dry run's `baseVersion` (one undo
  entry); on `STALE` the list is found again.
- **Media bin**: grid/list, thumbnails, duration, tags; search (names, tags, descriptions, transcript
  text); filter by kind/origin; import (dialog, Finder drag, folders), "import URL"; archive search tab
  (licence + warnings, fetch/cutout); generated tab when a provider exists; "Replace in timeline with…".
- **Export dialog**: MP4 (quality, range, subtitles burned in or not → `render --captions burn|none`,
  batch all sequences), SRT/VTT (with the subtitle edits), OTIO; **Save to** row (D-13): one file → native
  save dialog with the name prefilled, several files → folder picker with "New Folder", default = last
  folder for this project, else `~/Movies`, via `exports.chooseTarget` → `targetId` (main keeps
  `targetId → path` for the session; the renderer never sends a raw path); **Loudness target** (D-15):
  YouTube −14 LUFS (default) / TikTok −12 / Broadcast −23, sent to `render` and `audioQa` as `loudness`;
  **Audio check** (D-14): runs `audioQa` with the chosen target (±1 LU) before an MP4 export, shows each
  check with its number, `qa.png`, and the five listen
  timecodes as seek buttons, warns on FAIL without blocking; progress; reveal in Finder for each written
  path.
  Wired to the top-bar Export button from 10a and the quick-clips "Export" button.
- **Style gallery** (without Part C): installed styles, previews via `vox-media://`, detail view, "Set as
  style for this sequence".
- **Error states**: offline media → red block + relink; job rows with hint + Retry; missing tools →
  "Set up" buttons; quick clips with fewer clips than asked → a note naming how many fit;
  `SCHEMA_TOO_NEW` → "This project was made with a newer version of Vox Studio. Update the app to open
  it." and the project is not opened; `JOB_CONFLICT` → the job row lists the conflicting items (each
  clickable) and Retry runs the job on the current state (D-15).
- Playwright E2E (manual-edit path, quick path and the D-15 editing tools, no model).
- CI latency bench job on `macos-14`: warning only above 1 s (CI hardware differs); the number measured
  on the M5 is the gate.

## Steps

### A. UI (component tests + UI gate screenshots each)

1. [ ] Quick clips start screen: URL/file input validation, count and length fields, progress view from
       `job.*` events, next-steps bar; "Captions only" = one `batch` of `updateSequence { styleId,
       overlays: [] }` + `setCaptions { preset: <style default> }` (no overlay turned on).
2. [ ] Subtitles panel: one component test per action (edit, multi-word edit, find and replace, nudge,
       split, merge, hide, emphasis, reset one, reset all, delete word, Pauses & fillers find/untick/apply
       and `STALE` re-find); each is one undo step; the preview shows the edit (D-15 actions marked).
3. [ ] Media bin incl. archive tab and "Replace in timeline with…".
4. [ ] Export dialog incl. the subtitles burned-in option, "Save to" (file and folder modes, cancel keeps
       the old target, last folder remembered per project), the loudness target (sent to `render` and
       `audioQa`; D-15) and the audio check panel (a FAIL fixture shows the warning; a listen timecode
       button seeks the preview).
5. [ ] Style gallery.
6. [ ] Error states (offline media, job retry, missing tools, fewer quick clips, `SCHEMA_TOO_NEW`,
       `JOB_CONFLICT`; D-15). Test: opening a fixture with a higher `schemaVersion` shows the message and
       leaves `project.json` and `history.jsonl` byte-identical (S36).

### B. E2E and GATE 5

7. [ ] Playwright for Electron on the offline fixture: import media → drag to timeline (linked pair) →
       trim/split → add transition and text → add scene and edit its text → preview shows the change →
       export draft MP4 + SRT with correct duration; OTIO export exists.
8. [ ] Playwright quick path (no model configured): offline fixture media, Length 4–8 s → "Make clips" →
       (CI slow suite: the `VOX_E2E=1` build seeds the transcript from the checked-in
       `transcripts/talking-head-20s.json` by media hash of the checked-in seed media (D-16) and uses the
       seeded shots and facetrack files (`shots/<mediaId>.json`, `facetracks/<mediaId>.json`); M5: once
       unseeded, tagged `local`)
       3 captioned sequence tabs → fix a word and nudge its timing in the Subtitles panel → export MP4
       (burned in) + SRT into a folder chosen in the export dialog (the `VOX_E2E=1` build stubs the
       dialog's answer with a temp folder); the files are in that folder, the SRT contains the fixed word,
       and a frame of the MP4 at that time differs from the same frame exported before the fix. Also: a
       `.mov` and a `.webm` copy of the fixture via "Choose file…" each make clips (D-13).
9. [ ] Playwright editing tools on the offline fixture (app spec "Testing", D-15): Pauses & fillers
       ("Find" lists the fixture's known pauses; untick one → "Apply" → the sequence is shorter by exactly
       the ticked ranges, the unticked pause stays, captions stay on their words; one cmd+Z restores it all;
       `history.list` grew by one); coalesced slider (20 volume values within 1 s → one history entry; one
       cmd+Z restores the start value); pin frame (on an `auto` clip, "Pin frame here" + drag → keyframe
       at the playhead with relative `atMs`, the preview frame shows the pinned crop, moving the clip keeps
       it on the same source frame, one cmd+Z removes it); an export at each loudness target passes the
       audio check's loudness test against that target.
10. [ ] Latency bench in the CI slow suite (`workflow_dispatch` and weekly, warning-only above 1 s; R3,
        D-16).
11. [ ] Reveal and target tests (app spec "Testing", D-12, D-13): `projects.reveal` rejects paths outside the
        projects folder; `exports.reveal` accepts a path under the project's `renders/` and a path recorded
        from this session's export dialog, and rejects any other path; `jobs.start('render', …)` with a raw
        `path`/`file`/`dir` is rejected; an unknown or previous-session `targetId` is rejected; the dialog
        stub works only with `VOX_E2E=1`; `media.importFiles({ paths })` is rejected in a release build (S32).
12. [ ] `pnpm dist`; rerun the 09 clean-install test with the full editor. MANUAL STEP (owner, own
        account, D-16): quit the dev app, start the installed app with a fresh `VOX_HOME` (the log gives
        the exact command), run setup, open the fixture project, do the E2E path by hand, export MP4/SRT/OTIO into a folder of their choice and render the
        fixture (app spec packaging smoke test, render part, D-12); then paste the YouTube, Instagram and
        TikTok URLs from TODO into quick clips (one each), and drop one downloaded video file; fix one
        subtitle, export to a chosen folder; evidence screenshots.
13. [ ] STOP for GATE 5.

## Verify

```bash
pnpm -C apps/desktop test
pnpm -C apps/desktop e2e                # manual-edit path + quick path
pnpm -C apps/desktop bench:latency      # op → visible update < 1000 ms on the 90 s fixture
```

## Done when (= app done-when 1 and 7)

- [ ] `.dmg` from `pnpm dist` passes the clean-install test and, on the owner's account with a fresh
      `VOX_HOME` (D-16), completes setup; manual editing of the
      fixture project works end to end incl. MP4, SRT and OTIO export into a chosen folder.
- [ ] Quick clips work with no provider configured: a YouTube, Instagram or TikTok link, or a dropped
      video file, becomes 3 captioned clips, a corrected subtitle shows in the preview, and MP4 (burned in)
      + SRT export with the correction (D-11, D-13).
- [ ] S32 app tests pass (raw paths rejected, `targetId` only from this session's dialog).
- [ ] S36 app test passes (a newer `schemaVersion` shows `SCHEMA_TOO_NEW`; files byte-identical).
- [ ] App done-when 7 (D-15): "Pauses & fillers" removes the ticked ranges as one undo entry, a slider
      drag is one undo entry, "Pin frame here" holds the crop at the playhead, and an export at each
      loudness target passes the audio check's loudness test against that target (step 9 E2E).
- [ ] Latency target met on the M5 (number in the log); CI warns above 1 s.
- [ ] UI gate screenshots of all screens reviewed against `docs/reference/invideo-layout.png`; HIGH
      findings fixed.
- [ ] GATE 5 recorded.

## Risks and fallback

| Risk | Fallback |
|---|---|
| Archive tab slow or rate-limited | Debounce search; cache results per query for the session |
| Playwright for Electron flaky on drag | Drive drags through `window.vox` test hooks for the op, assert the UI result |
| Subtitles panel lags on long sequences | Virtualised list; edits stay one op each |
| A platform link fails at GATE 5 | Same platform fallback as GATE 2 (D-16): the local file of that video passes and the link shows a clear `VoxError` hint; logged as a known issue |

## Handoff notes

- Phase 13 fills the agent panel and settings into this layout, enables "Add style beats" (Stylize from
  12) and the LLM scorer for quick clips, and extends the E2E with the agent path.
