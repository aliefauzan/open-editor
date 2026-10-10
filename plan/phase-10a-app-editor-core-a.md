# Phase 10a — App: editor core A (data flow, preview, timeline, inspector)

| Field | Value |
|---|---|
| Track | app |
| Prereq | 06, 09 (D-16: the editor core needs the style format and `base`, not the `vox` sheet) |
| Spec § | app "Live updates and editing flow", "Preview pipeline" (+ "Preview fallback" if GATE 1 chose it), "Screens" (main editor: top bar, preview, timeline, style panel, inspector), "Testing" (component, performance) |
| Model | Sonnet 5.5 · high |
| Gate | none (GATE 5 is in 10b) |
| Next | 10b |

Split from the old phase 10 (D-06). 10a builds the editing core; 10b adds the media bin, export, style
gallery, error states, E2E, the `.dmg` and GATE 5.

## Goal

Every timeline edit can be done by hand in the InVideo-like layout, and each edit shows in the preview in
under 1 s.

## Required reading

- App spec sections above; GATE 1 decision (preview strategy, patch vs reload) and GATE 4 decision.
- Engine ops table (every UI action maps to one op or a `batch`); engine "Coalescing" and framing fields; DECISIONS D-15.

## Output

- **Store** (Zustand): project state from `projects.open`; applies change records from
  `project.changed`; optimistic pending ops with `baseVersion`; `STALE` rebase (apply newer changes,
  re-run the user's intent once, else revert + toast); agent badge on agent changes (used in 13);
  a drag sends one op on drop, never one per mouse move; sliders and text fields send an op per change
  with `coalesceKey` `<field>:<itemId>`, so one slider drag or one typed word is one undo entry (D-15);
  the engine host watches `project.json`, so external edits (`actor: 'external'`, e.g. `vox op` in a
  terminal) trigger a full reload.
- **Preview pipeline** in the engine host: in-memory compile after each change (150 ms coalescing during
  drags); scene-only changes → write instance files + `preview.updated { kind: 'patch' }`; structural →
  full build + `kind: 'reload'` + seek to saved playhead. If GATE 1 selected the app spec "Preview
  fallback", build that instead (pooled native media elements + scene-only player). VFR sources
  (`vfr: true`) always play from their CFR copy (`MediaItem.cfrPath`); the player never loads a VFR
  file (D-15). Pre-render cache (`renderLayers` into `cache/prerender/<hash>.mp4`, keyed by instance
  file hash; live scene until ready) only if GATE 1 recorded a heavy-scene fps margin under 20 % (D-15).
- **Top bar**: project name, step bar (Upload footage · Describe edit · Review cut · Export) that
  highlights the current stage and jumps to its panel, undo/redo, snapshots menu, settings, Export
  (opens the dialog built in 10b; a stub until then). Native menu bar with the same commands.
- **Keyboard** shortcuts per spec, with component tests for each shortcut.
- **Preview**: play/pause, frame step, in/out loop, timecode, fit/zoom, safe-area overlay, "render this frame".
- **Timeline**: sequence tabs (+ new/duplicate; per-sequence canvas, style and overlay toggles), V1..Vn above A1..An with lock/hide/mute/sync-lock,
  add/remove/reorder tracks; thumbnails + waveforms; link badge + linked selection (alt-click one);
  scene clips with template name/colour; transition markers; select/blade/ripple-delete tools; snapping
  (playhead, edges, transcript words, frame grid); zoom; marquee; multi-select move; copy/paste/duplicate;
  drag media (linked pair), templates and transitions from the style panel; "Add text"; audio fade
  handles; caption lane (edit word, "break here", emphasis words marked; D-15).
- **Style panel** (tab beside the media bin area): the sequence style's templates, transitions, overlays
  and caption presets plus `base`'s, with fixture previews via `vox-media://`; drag onto the timeline.
  Tests use `base` and a test style from 06; the panel lists `vox` once 07 is merged, with no code change
  (D-16).
- **Inspector**: media clip (video: in/out, framing mode `cover`/`contain`/`auto`/`facetrack`/`manual`
  incl. facetrack face picker and manual drag handle on the preview; for `auto` and `facetrack`
  stability locked/smooth/follow and track speed slow/normal/fast; "Pin frame here" adds a
  `frame.keyframes` entry at the playhead (`atMs` relative to the item start) that the user drags on the
  preview, pins listed with time and remove (D-15); image motion, transition); media clip (audio:
  in/out, volume, fades, denoise off/light/strong, D-15); scene clip
  (form generated from the template's JSON Schema: `maxLength` counters, media pickers, place search for
  `geo`, nested forms for `template` slots, arrays; template switcher; transition; sound cues with a mute
  toggle each → `updateScene { sfxOff }`, D-14); captions (preset,
  words per chunk, max lines, max characters per line, gap fill, auto-emphasis, position, on/off; the
  safe area comes from the preset, D-15).
- **Agent panel placeholder** with a link to settings.
- `apps/desktop/bench/latency.ts` and `bench:latency` script.

## Steps

### A. Data flow (tests first)

1. [ ] Store tests: change-record application, `STALE` rebase success and revert, linked selection,
       external edit → full reload; a drag sends one op on drop; 20 slider changes within 1 s carry one
       `coalesceKey` and make one history entry (D-15).
2. [ ] Preview pipeline: patch vs reload decision per change kind; latency bench on the 90 s fixture;
       a VFR fixture clip is served from its CFR copy; the pre-render cache only if GATE 1 required it
       (a changed instance file never shows a stale clip) (D-15).

### B. UI, panel by panel (component tests + UI gate screenshots each)

3. [ ] Layout shell + top bar + menus + keyboard (component test per shortcut).
4. [ ] Preview controls.
5. [ ] Timeline (library or custom canvas per GATE 4) incl. caption lane, and the style panel. Media for
       drag tests is imported with `media.importFiles({ paths })`, which only test builds (`VOX_E2E=1`)
       accept; the bin UI is 10b.
6. [ ] Inspector incl. JSON-Schema form generation (`template` and `geo` slots tested); scene sound-cue
       list: muting a cue is one undoable `updateScene { sfxOff }` and drops it from `cues.json` (D-14);
       framing `auto`, stability, track speed and "Pin frame here" (keyframe at the playhead, relative
       `atMs`, one undo entry); audio `denoise`; caption track settings (D-15).
7. [ ] Agent panel placeholder.

## Verify

```bash
pnpm -C apps/desktop test
pnpm -C apps/desktop bench:latency      # op → visible update < 1000 ms on the 90 s fixture
```

## Done when

- [ ] Store, preview pipeline, top bar, keyboard, preview, timeline and inspector component tests pass.
- [ ] Latency bench on this Mac: op → visible update < 1000 ms on the 90 s fixture (number in the log).
- [ ] UI gate screenshots of top bar, preview, timeline and inspector reviewed against
      `docs/reference/invideo-layout.png`; HIGH findings fixed.

## Risks and fallback

| Risk | Fallback |
|---|---|
| Patch path flickers or loses playhead | Use reload for that change kind; keep latency target |
| JSON-Schema forms get complex (`stack`) | Only depth-1 nested forms (matches `stack` depth 1) |
| Waveforms/thumbs slow with long media | Lazy-load per visible range from sprite sheets and peaks |
| Custom canvas timeline (GATE 4) grows the phase | Move marquee/snapping polish to 10b if needed (log D-NN); done-when unchanged |

## Handoff notes

- 10b adds the media bin (with "Replace in timeline with…"), the export dialog behind the top-bar
  Export button, the style gallery, error states, Playwright E2E, the CI latency bench and the `.dmg`.
  The coalesced slider and "Pin frame here" built here are checked end to end in 10b (app done-when 7).
- Phase 13 fills the agent panel and settings into this layout.
