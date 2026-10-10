# Phase 10b — App: editor core B (quick clips, subtitles, bin, export, gallery, E2E) + GATE 5

| Field | Value |
|---|---|
| Track | app |
| Prereq | 10a |
| Spec § | app "Screens" (quick clips start screen, Subtitles panel, media bin, export dialog, style gallery), "Error handling", "Testing" (E2E without agent, E2E quick clips, performance), "Done when" 1 |
| Model | Sonnet 5.5 · high |
| Gate | **GATE 5** (4-core done) |
| Next | 13 |

Split from the old phase 10 (D-06). Quick clips and the Subtitles panel added by D-11.

## Goal

A user pastes a URL and gets captioned 9:16 clips with no AI key; wrong subtitles are fixed by hand;
the plain clip exports with subtitles burned in. Media also comes in through the bin, export works,
errors are recoverable from the UI, and both the manual-edit path and the quick path pass E2E and
install from a `.dmg` on a second Mac account. This is the "4-core" milestone: the app is a real editor
before the agent exists.

## Required reading

- App spec sections above; engine spec "Quick clips" and "Captions" (editing); DECISIONS D-11; phase 10a
  handoff notes; GATE 4 decision.

## Output

- **Quick clips (start screen)** per app spec: one field "Paste a video link or drop a file", "How many
  clips" (default 3), "Length" (default 30–60 s); "Make clips" creates a project and runs ingest →
  transcribe → facetrack → `quickClips` (05) with one progress view; then the editor opens with one
  sequence tab per clip and the next-steps bar: **Fix subtitles**, **Add style** ("Captions only" works
  now; "Add style beats" is disabled with "needs a model — Settings" until 13), **Export**. Recent
  projects and "New empty project" stay on the start screen.
- **Subtitles panel** (tab beside the media bin): every caption chunk with its time; click to seek;
  edit text in place (word overrides via `setCaptions`, several words allowed); find and replace across
  the sequence; nudge a word's start/end by frames; split a chunk at a word / merge with the next
  (`breakAfter`); hide a word (`text: null`); "Reset to transcript" per chunk or for all. Each edit is one
  undoable op and shows in the preview within the latency target.
- **Media bin**: grid/list, thumbnails, duration, tags; search (names, tags, descriptions, transcript
  text); filter by kind/origin; import (dialog, Finder drag, folders), "import URL"; archive search tab
  (licence + warnings, fetch/cutout); generated tab when a provider exists; "Replace in timeline with…".
- **Export dialog**: MP4 (quality, range, subtitles burned in or not → `render --captions burn|none`,
  batch all sequences, save dialog), SRT/VTT (with the subtitle edits), OTIO; progress; reveal in Finder.
  Wired to the top-bar Export button from 10a and the quick-clips "Export" button.
- **Style gallery** (without Part C): installed styles, previews via `vox-media://`, detail view, "Set as
  style for this sequence".
- **Error states**: offline media → red block + relink; job rows with hint + Retry; missing tools →
  "Set up" buttons; quick clips with fewer clips than asked → a note naming how many fit.
- Playwright E2E (manual-edit path and quick path, no model).
- CI latency bench job on `macos-14`: warning only above 1 s (CI hardware differs); the number measured
  on the M5 is the gate.

## Steps

### A. UI (component tests + UI gate screenshots each)

1. [ ] Quick clips start screen: URL/file input validation, count and length fields, progress view from
       `job.*` events, next-steps bar; "Captions only" = one `batch` of `updateSequence { styleId,
       overlays: [] }` + `setCaptions { preset: <style default> }` (no overlay turned on).
2. [ ] Subtitles panel: one component test per action (edit, multi-word edit, find and replace, nudge,
       split, merge, hide, reset one, reset all); each is one undo step; the preview shows the edit.
3. [ ] Media bin incl. archive tab and "Replace in timeline with…".
4. [ ] Export dialog incl. the subtitles burned-in option.
5. [ ] Style gallery.
6. [ ] Error states (offline media, job retry, missing tools, fewer quick clips).

### B. E2E and GATE 5

7. [ ] Playwright for Electron on the offline fixture: import media → drag to timeline (linked pair) →
       trim/split → add transition and text → add scene and edit its text → preview shows the change →
       export draft MP4 + SRT with correct duration; OTIO export exists.
8. [ ] Playwright quick path (no model configured): offline fixture media, Length 4–8 s → "Make clips" →
       (CI: the `VOX_E2E=1` build seeds the transcript from the checked-in
       `transcripts/talking-head-20s.json` by media hash and skips facetrack; M5: once unseeded, `slow`)
       3 captioned sequence tabs → fix a word and nudge its timing in the Subtitles panel → export MP4
       (burned in) + SRT; the SRT contains the fixed word, and a frame of the MP4 at that time differs
       from the same frame exported before the fix.
9. [ ] CI latency bench job (warning-only above 1 s).
10. [ ] Reveal tests: `projects.reveal` and `exports.reveal` reject paths outside the projects folder and
        the project's `exports/`; `media.importFiles({ paths })` is rejected in a release build.
11. [ ] `pnpm dist`; MANUAL STEP (owner): on the second Mac account, install, setup, open the fixture
        project, do the E2E path by hand, export MP4/SRT/OTIO; then paste a real URL into quick clips, fix
        one subtitle, export; evidence screenshots.
12. [ ] STOP for GATE 5.

## Verify

```bash
pnpm -C apps/desktop test
pnpm -C apps/desktop e2e                # manual-edit path + quick path
pnpm -C apps/desktop bench:latency      # op → visible update < 1000 ms on the 90 s fixture
```

## Done when (= app done-when 1)

- [ ] `.dmg` from `pnpm dist` installs on a second Mac account, completes setup, manual editing of the
      fixture project works end to end incl. MP4, SRT and OTIO export.
- [ ] Quick clips work with no provider configured: a URL becomes 3 captioned clips, a corrected
      subtitle shows in the preview, and MP4 (burned in) + SRT export with the correction (D-11).
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
| Second Mac account not available | GATE 5 waits; log it under TODO "Manual steps" |

## Handoff notes

- Phase 13 fills the agent panel and settings into this layout, enables "Add style beats" (Stylize from
  12) and the LLM scorer for quick clips, and extends the E2E with the agent path.
