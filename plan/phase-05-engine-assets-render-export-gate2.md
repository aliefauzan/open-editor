# Phase 05 — Engine: assets, render, export, CLI + GATE 2

| Field | Value |
|---|---|
| Track | engine |
| Prereq | 03, 04 |
| Spec § | engine "Stages" (assets, render, frames, exports, credits, "Quick clips"), "Archive assets and licences", "Image generation provider", "Library API", "Testing" (integration, manual E2E), "Done when" |
| Model | Sonnet 5.5 · high |
| Gate | **GATE 2** at the end (engine done-when) |
| Next | 06/07, 09, 11 |

## Goal

The engine is complete for v1: archive images with licences, cutouts, final MP4 render, stills,
captions and OTIO export, credits, and a full `vox` CLI. From a real YouTube URL, CLI commands alone
produce a captioned 9:16 clip, and `vox quick <url>` does the simple path in one command: plain
captioned clips with editable subtitles and no AI key (D-11).

## Required reading

- Engine spec sections above incl. "Quick clips" and "Captions" (editing); R4 rows S7, S29; R5 rembg +
  opentimelineio rows; DECISIONS D-11.
- GATE 1 decision (whole-sequence vs hybrid export).

## Output

- `engine/src/stages/assets.ts`: Commons + Openverse search (allowlist CC0/PDM/BY/BY-SA; Openverse
  `license=cc0,pdm,by,by-sa`, `page_size` ≤ 20; Commons User-Agent with contact from `readConfig()`,
  10/min throttle without it; `Artist` HTML sanitised), results cached in `cache/assets/<queryHash>.json`;
  `fetch` (records licence/author, origin `archive`); `cutout` (rembg, pinned permissive model, refused
  for ND; transparent PNG as new media); `generate` via registered `ImageProvider` (fails with hint when none).
- `py/vox_py/cutout.py`, `py/vox_py/timeline.py` (OTIO).
- `engine/src/stages/render.ts`: picture via HyperFrames (silent, `--quality` passed explicitly) or the
  hybrid compositor, muxed with the audio graph (`-c:v copy`, audio AAC, per engine "Encoding");
  `--range-ms`; output in `renders/`.
- `engine.frames()` (compiled stills at canvas size, cached).
- Exports: `export-captions` (SRT/VTT from `deriveCaptions`), `export-timeline` (`.otio` referencing
  originals + layer MOVs), `credits`.
- `imageProviders.register/list`.
- `engine/src/stages/quickClips.ts` (D-11): job kind `quickClips` per engine "Quick clips" (sentence
  units, candidates in `[minMs, maxMs]`, heuristic scorer, top `count` without overlap, one `batch`
  creating `base` sequences with a linked `V1`/`A1` pair and `base/plain` captions);
  `engine.quickClips.registerScorer(id, fn)` / `scorers()`; a failing scorer falls back to the heuristic.
- `render --captions burn|none` (default `burn`).
- CLI: `vox assets search|fetch|cutout|generate`, `vox compile`, `vox preview`, `vox frames`,
  `vox render`, `vox export-captions`, `vox export-timeline`, `vox credits`, `vox quick` — every command
  `--json`.
- `scripts/make-offline-project.ts`: builds the offline fixture project (R7) from `talking-head-20s.mp4`
  and the checked-in `transcripts/talking-head-20s.json`, without network or mlx-whisper; used by the app
  E2E (10b, 13) and the agent mock-model tests (12).
- Integration test and `docs/evidence/phase-05/`.

## Steps

### A. Assets

1. [ ] Licence filter tests (S7): NC/ND/other dropped; BY-SA warning; ND cutout refused.
2. [ ] Search against recorded HTTP fixtures (no live network in tests); live smoke test tagged `slow`.
       S29: `fetch` of an archive URL whose host resolves to a private/loopback address, or that redirects
       to one, is refused by the in-process check (fake resolver, no internet).
3. [ ] Cutout on a fixture image produces alpha PNG; record the rembg model and quote its licence in the log.
       pytest for `cutout.py` and `timeline.py`: outputs validate against their JSON Schemas (as in 04).
4. [ ] `ImageProvider` interface + a fake provider test; `generate` without a provider → hint.

### B. Render and export

5. [ ] Render fixture: duration, resolution 1080×1920, audio stream, 3 non-blank sampled frames.
6. [ ] SRT/VTT export matches `deriveCaptions` chunks; timing on the frame grid.
7. [ ] OTIO export: schema-valid; clips reference originals; scene/caption layers as MOVs with alpha.
8. [ ] `credits` lists every archive asset used with author, licence and link.

### C. Integration (engine "Testing")

9. [ ] Fixture → ingest (local) → transcribe → place linked clips + one `base/title` scene → captions →
       render draft → assert duration, resolution, audio, 3 non-blank frames, SRT export.

10. [ ] `make-offline-project.ts` runs in CI (no network) and the result opens, compiles and renders a
        draft.
11. [ ] A/V sync (moved here from 03): `render` the engine-compiled 90 s spike fixture (picture + mux);
        click-track onsets vs burnt-in flash frames < 1 frame (spike bench reused). Numbers in the log.

### C2. Quick clips (D-11)

12. [ ] `quickClips` tests on the offline project with `{ count: 3, minMs: 4000, maxMs: 8000 }`: 3
        clips; each starts and ends on a sentence boundary and fits the bounds; no overlaps; same input
        → same ranges; too few candidates → fewer clips, reported; each sequence has `styleId: 'base'`,
        `sourceRange`, a linked `V1`/`A1` pair with equal offsets (framing `cover`, since the offline
        project has no face track; `facetrack` when the test adds a stub face-track result), captions
        `base/plain` with `maxWords` 3, and no scenes. A registered fake scorer changes the pick; a
        throwing scorer falls back to the heuristic and the result names the scorer used.
13. [ ] Caption edit round trip: one `setCaptions` override replaces a word's text and nudges its
        `startMs` → `export-captions` SRT shows the new word and time; the compiled caption layer at
        that time contains the new word (DOM text check); `render --captions none` has no caption
        layer; `vox quick <fixture path> --count 3 --length 4-8 --render` writes 3 MP4 + 3 SRT.

### D. GATE 2 (owner + agent)

14. [ ] Real URL run (agent prepares one script `scripts/gate2.sh <url>`, URL from TODO): ingest →
        transcribe → facetrack → `vox new` + ops for a face-tracked speaker clip, one `base/title`, a
        transition, captions → render + SRT. Evidence: MP4 + 3 frames + SRT head in `docs/evidence/phase-05/`.
        The same script then runs `vox quick <url> --render` (3 captioned clips), edits one caption
        word with `vox op … setCaptions` and re-renders; evidence: SRT head and a frame with the edit
        (done-when 7).
15. [ ] MANUAL STEP: open the `.otio` in DaVinci Resolve 18.5+; screenshot clips + layer MOVs (with alpha)
        in place. Fallback chain (D-10), prepared before asking: if Resolve rejects the OTIO, the agent adds
        FCPXML export through `otio-fcpx-xml-adapter` (pinned in R5; 14g then only adds the app option)
        and the owner tries that; if both fail, the agent writes README steps that put the layer MOVs in
        place by hand and the owner follows them once. Any of the three passes item 5.
16. [ ] Check engine done-when 1–7, then STOP for GATE 2.

## Verify

```bash
pnpm test
pnpm -C packages/engine test:slow -- integration
bash scripts/gate2.sh "<owner-chosen URL>"   # uses its own temp projects folder unless --projects-dir is given
```

## Done when (= engine spec "Done when")

- [ ] 1 spike result and pin in the engine spec (from 01).
- [ ] 2 `vox doctor` passes on the M5.
- [ ] 3 `pnpm test` passes from a clean checkout.
- [ ] 4 Real YouTube URL → 9:16 MP4 with face-tracked speaker, `base/title`, transition, captions + SRT.
- [ ] 5 `.otio` opens in Resolve with clips and layer MOVs in place (owner screenshot), or the FCPXML /
      manual-import fallback passed (D-10).
- [ ] 6 Recovery test (from 02) passes.
- [ ] 7 `vox quick <url>` with no provider → 3 captioned 9:16 clips (MP4 + SRT with `--render`); an
      edited caption word shows in the SRT and the MP4 (D-11).
- [ ] A/V sync < 1 frame on the 90 s fixture after the mux (step 11).
- [ ] S7 and S29 tests pass; security review clean of CRITICAL/HIGH.
- [ ] GATE 2 answered and recorded.

## Risks and fallback

| Risk | Fallback |
|---|---|
| Resolve does not import OTIO with MOV alpha as expected | Step 15 fallback chain: FCPXML via `otio-fcpx-xml-adapter`, then documented manual import (D-10) |
| No permissive rembg model fits | Ship cutout disabled with a clear hint; `paper-collage` uses rectangles with red border |
| Commons rate limits | Contact from TODO; throttle; cache |

## Handoff notes

- Phase 07 templates use `assets.*` fixtures; phase 11 agent job tools map 1:1 to these jobs.
- 10b builds the Quick clips start screen and the Subtitles panel on `quickClips` and `setCaptions`;
  12 registers the LLM scorer and adds the Stylize workflow (D-11).
- Engine API, events and engine CLI are frozen after GATE 2 (R2; PROGRESS milestone "frozen after 05").
