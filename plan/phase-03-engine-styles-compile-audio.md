# Phase 03 — Engine: styles loader, `base` style, compile, captions, audio

| Field | Value |
|---|---|
| Track | engine |
| Prereq | 01 (GATE 1 decided), 02 |
| Spec § | engine "Captions", "Transitions", "Base style", "Compile", "Audio", "Layer renderer"; styles "Part A" (`style.json`, tokens, `template.json`, compile hook, overlays, template rules, registry `list`/`get`) |
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
- Engine spec sections listed above; styles spec "Part A" up to "Style registry".
- `spike/` hand-written build (the reference this phase reproduces in code).

## Output

- `engine/src/styles/`: loader for `style.json` + `template.json` (zod), registry over `stylesDirs`
  (search order, duplicate id = error), `extends` resolution (child overrides; depth ≤ 4; cycles rejected),
  template identity `<styleId>/<name>`, token → `--tok-<group>-<name>` CSS, token scoping rule,
  `styles.list()`/`get()`. Plugs the real template-schema lookup into phase 02's ops. `vox new` now sets
  `styleId` to `vox` if installed, else `base`.
- `styles/base/`: templates `title`, `text-overlay`, `placeholder`; transitions `crossfade`,
  `dip-to-black`; caption preset `base/plain`; fonts Inter (display, body) and IBM Plex Mono (captions)
  with their OFL texts in `styles/base/assets/fonts/` (R5); fixtures (≥ 2 per template); `guide.md`.
- `engine/src/model/captions.ts`: `deriveCaptions` (pure) + `engine.captions()`.
- `engine/src/compile/`: `compile(projectId, sequenceId, { mode, range? }) → BuildResult` in memory,
  `writeBuild()`; layer order V1..Vn (+ transition layers), overlays, captions; muted `<video>`/`<img>`;
  facetrack framing as GSAP keyframes; image motion; per-instance scene files with `data-vox-vars`;
  shared `vox-runtime.js`; scoped tokens; trusted-only `build.mjs` hooks (`HOOK_UNTRUSTED` otherwise)
  with `ctx.seed` and `ctx.readAsset(path)` (style-relative, path rule applied; hooks import only
  relative vendored ESM, styles spec "Compile hook");
  `TEMPLATE_VERSION` major check; preview `<audio>` per audio clip (+ GSAP fade if the spike confirmed);
  SFX cues; `@font-face` + copied fonts; vendored runtime + GSAP in `build/vendor/`; hard links for media;
  `MEDIA_MISSING`.
- `engine/src/audio/`: ffmpeg filter graph (`atrim`, `adelay`, `volume`, `afade`, SFX, mutes, `amix`
  normalise off, limiter).
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

### C. Compile

7. [ ] Snapshot tests: fixture projects → in-memory build snapshots (byte-identical on rerun).
8. [ ] Hook context: `ctx.readAsset` reads a style file and rejects `..`/absolute paths; a hook with a
       relative vendored import loads; same `ctx.seed` → identical output.
9. [ ] Layer order, hidden tracks skipped, muted tracks skipped, `MEDIA_MISSING`, `TEMPLATE_VERSION`
       (major mismatch), `HOOK_UNTRUSTED` for an untrusted style's own template, a trusted parent's template
       used through an untrusted child style still runs its hook (S8), `stack` panels resolved recursively
       (test-only stand-in template). This phase owns these tests and the registry/token tests in 2–4.
10. [ ] No `http(s)` URL anywhere in a build (S9).
11. [ ] **HyperFrames contract tests** on the pinned version: `lint --json` zero errors on the emitted
       build; a 3 s fixture renders with `render --strict-all` and the expected frames.
12. [ ] Rebuild the spike's 90 s fixture through the engine, with captions from
        `transcripts/spike-90s.json` (R7); cuts match `spike/` (spike bench, cut-accuracy part). A/V sync
        needs the mux and is checked in phase 05.

### D. Audio and layers

13. [ ] Audio graph snapshot for a fixture timeline; an audio-only render of the mix has click-track
        onsets within 1 frame of their timeline times.
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

- [ ] Compile snapshots, contract tests and audio tests pass.
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
