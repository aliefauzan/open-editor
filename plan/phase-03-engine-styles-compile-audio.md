# Phase 03 — Engine: styles loader, `base` style, compile, captions, audio

| Field | Value |
|---|---|
| Track | engine |
| Prereq | 01 (GATE 1 decided), 02 |
| Spec § | engine "Captions", "Transitions", "Base style", "Compile", "Audio", "Sound cues", "Layer renderer"; styles "Part A" (`style.json`, tokens, `template.json`, compile hook, overlays, caption presets, template rules, registry `list`/`get`) |
| Model | Opus 5.5 · high |
| Gate | — |
| Next | 05, 06, 08 |

## Goal

A sequence compiles, deterministically, to a HyperFrames build that passes lint and renders, exactly as
the spike proved. Styles load from folders; `base` ships. Captions derive from transcripts. Final audio
comes from an ffmpeg graph built from the model. If GATE 1 chose hybrid export, the layer renderer is
the export path.

## Required reading

- `docs/SPIKE_RESULTS.md` and the GATE 1 decision in DECISIONS (export path, preview mode, sandbox).
- Engine spec sections listed above; styles spec "Part A" up to "Style registry", incl. "Caption presets"
  and `minEntranceMs` under template rules (D-15).
- GATE 1 entries for NTSC (item 9) and the heavy-scene fps margin (D-15).
- `spike/` hand-written build (the reference this phase reproduces in code).

## Output

- `engine/src/styles/`: loader for `style.json` + `template.json` (zod), registry over `stylesDirs`
  (search order, duplicate id = error), `extends` resolution (child overrides; depth ≤ 4; cycles rejected),
  template identity `<styleId>/<name>`, token → `--tok-<group>-<name>` CSS, token scoping rule,
  `styles.list()`/`get()`. Plugs the real template-schema lookup into phase 02's ops. `vox new` now sets
  `styleId` to `vox` if installed, else `base`. D-15: `template.json` `minEntranceMs`; `skipEntrance` is
  a reserved variable; caption presets load from `captions/<preset>.html` + `captions/<preset>.json`
  (`case`, `stripPunctuation`, `safeArea` default 20 / 12 on 9:16 and 0 / 0 otherwise, `position`).
- `styles/base/`: templates `title`, `text-overlay`, `placeholder`; transitions `crossfade`,
  `dip-to-black`; caption preset `base/plain` (`case: 'asis'`, `stripPunctuation: false`, default safe area;
  active word bold, emphasis words 1.2× larger, read and unread look the same; D-15); fonts Inter (display, body) and IBM Plex Mono (captions)
  with their OFL texts in `styles/base/assets/fonts/` (R5); fixtures (≥ 2 per template); `guide.md`.
- `engine/src/model/captions.ts`: `deriveCaptions` (pure) → `CaptionChunk[]` with `lines` of `CaptionWord`
  `{ key, text, startMs, endMs, emphasis }` (D-15) + `engine.captions()`; reuses phase 02's word → range
  helper; fills `SequenceView.captions` (chunk text).
- `engine/src/compile/`: `compile(projectId, sequenceId, { mode, range? }) → BuildResult` in memory,
  `writeBuild()`; layer order V1..Vn (+ transition layers), overlays, captions; muted `<video>`/`<img>`;
  framing keyframes (`facetrack`, `auto`, `manual`) as GSAP keyframes on a CSS `transform` (translate +
  scale), not `object-position` (D-15; the tracked path comes from a path-provider interface, stubbed
  with a fixture path here; 04 builds the real path builder and phase 05 plugs it in); the CFR copy
  (`cfrPath`) instead of the original for a VFR video (D-15); image motion; per-instance scene files with `data-vox-vars`;
  shared `vox-runtime.js`; scoped tokens; trusted-only `build.mjs` hooks (`HOOK_UNTRUSTED` otherwise)
  with `ctx.seed` and `ctx.readAsset(path)` (style-relative, path rule applied; hooks import only
  relative vendored ESM, styles spec "Compile hook");
  `TEMPLATE_VERSION` major check; `skipEntrance: true` injected when an item is shorter than its
  template's `minEntranceMs` (D-15); the caption preset mounted once per sequence with the
  `CaptionChunk[]` in `vox.vars(el)`, after compile applied the preset's `case` and `stripPunctuation`
  (D-15); preview `<audio>` per audio clip (+ GSAP fade if the spike confirmed);
  SFX cues from the cue list (below); `@font-face` + copied fonts; vendored runtime + GSAP in `build/vendor/`; hard links for media;
  `MEDIA_MISSING`.
- `engine/src/audio/`: ffmpeg filter graph (`atrim`, `afftdn` when `denoise` is `light` or `strong`, a
  per-clip gain-to-target of (target − `integratedLufs`) dB for media with `loudness`, `adelay`, `volume`,
  `afade`, SFX, mutes, `amix` normalise off, limiter, two-pass `loudnorm` to the loudness target /
  −1 dBTP); the target is a parameter: `youtube` −14 LUFS (default), `tiktok` −12, `broadcast` −23
  (D-15); `stems` option writing speech, other-audio and SFX WAVs without `loudnorm` (engine "Audio", D-14).
- `engine/src/audio/cues.ts` (D-14): cue list per engine "Sound cues" — template and transition
  `sfxCues` (with `name` and `type`) at item start + offset on the frame grid; `sfxOff` and
  `sequence.sfx` mutes; 120 ms spacing and 4 s hero spacing drops, all listed; written to
  `build/<seq>/audio/cues.json`. The `sfx` field of `style.json` uses the object form (`path`, `type`,
  `source`, `licence`).
- `engine/src/render/layers.ts`: `renderLayers()` to ProRes 4444 MOV with alpha (`--format mov`); if
  GATE 1 = hybrid, also the ffmpeg `overlay` compositor in compile layer order.
- `engine.geo.search(query)`: offline Natural Earth populated places index; data in `packages/engine/data/`.

## Steps

### A. Styles

1. [ ] Schemas for `style.json` and `template.json` exactly as styles spec Part A.
2. [ ] Registry tests: search order, duplicate id across dirs rejected, `extends` chain, cycle, depth > 4.
3. [ ] Token CSS + scoping tests (styles spec "Testing" token-scoping bullet) using `base` and a test-only
       child style in `test/fixtures/styles/`.
4. [ ] Scene variable validation through the real registry (replacing 02's fixture lookup): `addScene`
       and `updateScene` reject invalid variables, incl. inside a nested `stack` panel (test-only stand-in);
       `vox new` picks `vox` when a test `vox` style is installed, else `base`.
5. [ ] `styles/base` templates + fixtures; each passes `hyperframes lint --json` and renders a fixture.

### B. Captions

6. [ ] `deriveCaptions` tests: midpoint rule, shift + clamp, zero-length words, overlap trim, overrides by
       `wordKey`, orphans after re-transcription, chunking (`maxWords`, 300 ms pauses, clip boundaries,
       `breakAfter`), lower track index wins, no-space languages (`maxWords × 4` chars); D-11 overrides:
       multi-word `text` split evenly over the word's time and chunked as separate words, `text: null`
       hides the word, `startMs`/`endMs` retime it (shift + clamp + frame grid like any word).
6b. [ ] D-15 caption tests: lines by `maxCharsPerLine` and `maxLines` (a longer word gets its own line; the
       word that does not fit starts the next chunk); gap fill (a 300 ms gap is filled, a 500 ms gap is
       not, with `gapFillMs` 400); word ends extended to the next word's start inside a chunk; override
       `emphasis` over `autoEmphasis` (numbers and capitalised non-initial words); no pause pseudo-words
       in captions (fillers and repeats stay until cut). SRT/VTT: one cue per chunk, one text line per
       chunk line, preset `case`/`stripPunctuation` not applied.

### C. Compile

7. [ ] Snapshot tests: fixture projects → in-memory build snapshots (byte-identical on rerun).
8. [ ] Hook context: `ctx.readAsset` reads a style file and rejects `..`/absolute paths; a hook with a
       relative vendored import loads; same `ctx.seed` → identical output.
8b. [ ] `NO_HANDLES` re-test with the real registry (D-12): a `base/crossfade` (`blendsShots: true`) on a
        cut without source handles fails; `dip-to-black` on the same cut passes. (02 tested it with stub
        metadata only.)
9. [ ] Layer order, hidden tracks skipped, muted tracks skipped, `MEDIA_MISSING`, `TEMPLATE_VERSION`
       (major mismatch), `HOOK_UNTRUSTED` for an untrusted style's own template, a trusted parent's template
       used through an untrusted child style still runs its hook (S8), `stack` panels resolved recursively
       (test-only stand-in template). This phase owns these tests and the registry/token tests in 2–4.
9b. [ ] D-15 compile snapshots: `skipEntrance` on a scene shorter than its template's `minEntranceMs`;
        a preset's `case`/`stripPunctuation` applied in the build but not in the SRT; facetrack, `auto` and
        `manual` keyframes as a `transform`; a VFR media item compiles to its `cfrPath`.
9c. [ ] `base/plain` caption preset tests (styles spec "Testing", caption presets): a fixture
        `CaptionChunk[]` (two lines, one emphasis word, a 200 ms gap) on 9:16; at a frame inside word 2,
        word 2 has the active look and words 1 and 3 the read and unread looks (computed styles from the
        DOM + a pixel check); the same frame reached by seeking backwards is byte-identical; the emphasis
        word has its own look at every state; every word box stays inside the safe area, also with
        `position.yPct` 95.
10. [ ] No `http(s)` URL anywhere in a build (S9).
11. [ ] **HyperFrames contract tests** on the pinned version: `lint --json` zero errors on the emitted
       build; a 3 s fixture renders with `render --strict-all` and the expected frames.
12. [ ] Rebuild the spike's 90 s fixture through the engine, with captions from
        `transcripts/spike-90s.json` (R7); cuts match `spike/` (spike bench, cut-accuracy part). A/V sync
        needs the mux and is checked in phase 05.

### D. Audio and layers

13. [ ] Audio graph snapshot for a fixture timeline; an audio-only render of the mix has click-track
        onsets within 1 frame of their timeline times. `loudnorm` result: the chosen target ±1 LU (each of
        `youtube`, `tiktok`, `broadcast` in the graph snapshot; one render per preset checked with ffmpeg
        `ebur128`), true peak ≤ −1 dBTP; stems are written and sum (before `loudnorm`) to the mix.
13b. [ ] Per-source level and denoise (D-15): two sources whose `loudness` is 10 LU apart mix within 1 LU of
        each other; `denoise` `light` and `strong` appear as their fixed `afftdn` strengths in the graph
        snapshot; `off` adds no filter.
13c. [ ] Cue list tests (D-14): numeric and `entrance` offsets, transition cues at the cut, `sfxOff`
        and `sequence.sfx: false` drop as `muted`, two cues 50 ms apart → the second dropped as
        `spacing`, two hero cues 3 s apart → `hero-spacing`; `cues.json` byte-identical on rerun.
14. [ ] `renderLayers` produces a MOV with alpha (ffprobe `pix_fmt` has alpha).
15. [ ] If hybrid: composited export vs player frames within tolerance (engine spec "Layer renderer").

### E. Geo

16. [ ] `geo.search("lisbon")` returns name + lat/lon offline; index built at install from bundled data.

## Verify

```bash
pnpm -C packages/engine test
pnpm -C packages/engine test:slow -- compile/contract     # lint + render on the pinned version
```

## Done when

- [ ] Compile snapshots, contract tests, audio tests (incl. loudness presets, per-source gain, denoise,
      stems) and cue-list tests pass.
- [ ] `deriveCaptions` returns `CaptionChunk[]` with lines, gap fill and emphasis; `base/plain` passes the
      caption preset tests (step 9c; D-15).
- [ ] `NO_HANDLES` passes against the real `base` registry (step 8b).
- [ ] The engine-compiled 90 s spike fixture renders with correct cuts (spike bench reused; sync is
      proven in 05 after the mux).
- [ ] `base` templates pass lint and render their fixtures.
- [ ] S8 and S9 tests pass.

## Risks and fallback

| Risk | Fallback |
|---|---|
| GSAP volume tweens do not work in preview | Preview without fades (spec allows); final mix still has fades |
| Fonts differ between preview and render | Fonts are always copied into `build/fonts/`; contract test renders text and compares |

## Handoff notes

- Phase 05 builds `render` (picture via HyperFrames + mux with the audio graph) and `export-timeline` on
  `renderLayers`, and owns the A/V sync check on the 90 s fixture.
- Phase 06 finishes Part A tooling (`validate`, `new`, `trust`, migrations, previews).
- Phase 08/10a use `compile()` in memory for preview patching.
- Pre-render cache (D-15): not built here. The app's engine host owns it (app spec "Preview pipeline"),
  so phase 10a builds it on `renderLayers`, and only if GATE 1 recorded a heavy-scene fps margin under
  20 %. This phase only keeps `renderLayers` usable per scene instance.
- If GATE 1 recorded the NTSC fallback (item 9), this phase removes the 1001 rates from the fixed set in
  `engine/src/model/` (02's frozen schema; the GATE 1 DECISIONS entry is the R2 change record), and 04
  makes CFR copies of NTSC sources at the nearest integer rate (D-15).
- Phase 04 builds and tests the facetrack path builder standalone; phase 05 plugs it into the compile
  path-provider interface.
- Phase 06 checks `minEntranceMs`, the reserved `skipEntrance` and the caption preset schema in
  `vox style validate`; phase 07 builds the `vox` presets on the same contract.
