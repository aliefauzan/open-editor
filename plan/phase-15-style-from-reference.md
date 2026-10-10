# Phase 15 — Styles Part C: style from a reference video

| Field | Value |
|---|---|
| Track | styles + agent + app |
| Prereq | 13 (v1.0) |
| Spec § | styles "Part C" (pipeline, limits), "Testing" (Part C), "Done when" 4; agent "Style extract", "Tools" (`extract_style`); app "Style gallery" (Part C flow), "Done when" 5 |
| Model | Opus 5.5 · high |
| Gate | **GATE 8**: blind A/B by the owner at the end |
| Next | — (v2 designed, not scheduled) |

## Goal

The user gives a video whose look they like; Vox Studio drafts a new style by re-skinning existing
templates (tokens, pacing, captions, overlays, guide), shows a report, and the user accepts or discards
it. No new templates (v2).

## Required reading

- Styles spec "Part C" in full; agent spec "Style extract" and job registration; app "Style gallery".
- R4 row S8 (extracted styles are untrusted: no hooks); DECISIONS D-13 (URL
  sources), D-14 (SFX), D-15 (`shots` stage; `pyobjc-framework-Vision` already in v1).

## Output

- `vox style extract <url|file> --name <id>`, `vox agent --workflow style-extract`, and job kind `style.extract` (registered by the agent package
  via `engine.jobs.register`); agent tool `extract_style`.
- Pipeline:
  1. ingest into a scratch project (`{ proxies: false }`);
  2. measure (no LLM): the engine `shots` stage (ffmpeg `scdet`, built in 04; D-15) → shot list +
     average shot length → `pacing.beatMs`; Part C runs no scene detection of its own; keyframes (one
     per shot + one per 2 s) → contact sheets; k-means (k = 8) palette; speaker share via `facetrack`;
     caption timing via Apple Vision OCR (`py/vox_py/ocr.py`, `VNRecognizeTextRequest` through
     `pyobjc-framework-Vision`, which is already a v1 dependency for facetrack saliency, so this phase adds
     no Python package and no `py-env` resync; D-15) at 4 fps → words per caption, position, case;
  3. describe (vision model): structured JSON (fonts, caption look, motion vocabulary, layouts, texture,
     closest existing templates);
  4. map: tokens; fonts → closest of a bundled ~40-font OFL catalogue with tags; `extends` closest base;
     caption preset + overlays; unmatched layouts listed; `guide.md` drafted;
  5. report: `report.html` with reference frames beside our fixture renders in the new style, tokens,
     unmatched layouts.
- Output style in `~/.vox/styles/<id>/` with `source.type: 'extracted'`, `status: 'draft'`, `trusted: false`;
  the reference video is never copied into style assets. The draft adds no sound files: it inherits the
  `extends` parent's SFX kit and cues (D-14); sound from the reference is never extracted.
- Style gallery: "New style from reference video" → file/URL → extract job → `report.html` in a sandboxed
  `vox-media://` frame → Accept (`styles.accept`) or Discard (`styles.remove`).
- Limits text shown to the user (approximation, free fonts, unmatched layouts listed not built).
- Quick action "Extract style" in the agent panel.

## Steps

1. [ ] Extend `make.sh` with `style-extract-10s.mp4` (known cuts, flat colour blocks, burnt-in captions
       via `drawtext`; deterministic, R7). Measurement tests on it: shot count (from the `shots` stage),
       palette within tolerance,
       caption words/position. pytest for `ocr.py` and the measure tools: outputs validate against their
       JSON Schemas (as in 04).
2. [ ] Describe + map with a mocked model returning fixed JSON → deterministic draft style.
3. [ ] Draft style passes `vox style validate`, rendering every inherited template's fixtures, including
       `vox/map-route` with its trusted hook; a `build.mjs` placed in the draft style itself never runs (S8;
       test file `packages/engine/test/styles/extract-untrusted-hook.test.ts`).
4. [ ] Report page served via `vox-media://` with the untrusted-HTML CSP.
5. [ ] Gallery flow E2E with the mocked model: create → report → accept → set as sequence style; discard
       removes it.
6. [ ] MANUAL STEP (owner): pick a real reference video; run extract with a real vision model.
7. [ ] Blind A/B: a script renders the same clip in `vox` and in the extracted style, randomises order,
       hides names; the owner picks which is closer to the reference; result recorded. STOP for GATE 8.

## Verify

```bash
pnpm -C packages/agent test -- style-extract
pnpm -C packages/engine test -- styles/extract-untrusted-hook          # S8
uv run --project py pytest -k "ocr or measure"
pnpm -C apps/desktop e2e -- style-gallery
```

## Done when (= styles done-when 4, app done-when 5 Part C)

- [ ] From a user-chosen reference video, a draft style + `report.html` are produced.
- [ ] GATE 8: in the blind A/B the owner picks the extracted style as closer to the reference.
- [ ] The gallery can create, accept and discard an extracted style.

## Risks and fallback

| Risk | Fallback |
|---|---|
| OCR misses stylised captions | Report says "caption style not detected"; keep the parent's preset |
| `shots` on a reference ingested with `{ proxies: false }` | The engine spec runs `shots` and `facetrack` on the original scaled to 360p when no proxy exists (D-15); phase 04 tests this path |
| A/B loses | Log which tokens drove the gap; iterate measure/describe/map rules (not templates) and repeat the A/B (GATE 8, no round limit); the owner may instead accept Part C as experimental (DECISIONS) |

## Handoff notes

- v2 (LLM-authored templates, review approval mode) stays designed but unscheduled.
