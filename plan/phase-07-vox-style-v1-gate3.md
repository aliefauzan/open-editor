# Phase 07 — `vox` style v1 + GATE 3

| Field | Value |
|---|---|
| Track | styles |
| Prereq | 05, 06 |
| Spec § | styles "Part B" (tokens, v1 templates, transitions, overlays, caption presets, SFX, guide, quality bar), "Done when" 1–2 |
| Model | Opus 5.5 · high |
| Gate | **GATE 3**: the owner approves the side-by-side sheet |
| Next | 10a, 12 |

## Goal

The first real style: Vox-like paper collage, close enough to the reference reel (instagram.com/reel/
DePNgrmToh9) that the owner approves it from a side-by-side sheet.

## Required reading

- Styles spec "Part B" in full; "Template rules".
- Reference frames: the owner's reel (frames extracted at the start of this phase into
  `docs/evidence/phase-07/reference/`, for analysis only, never placed in style assets).
- `plan/ref/R5-pins.md` asset rows (fonts, textures, SFX, Natural Earth, d3-geo).

## Output

- `styles/vox/style.json` with the token table (colours, fonts, texture, motion, pacing, imagery, sfx).
- Fonts: render both display candidates (Libre Caslon Display, DM Serif Display) on `kinetic-serif` and
  `stat`; pick one; record in DECISIONS. Body and caption fonts per spec. OFL files + licence texts in
  `styles/vox/assets/fonts/`.
- Paper texture (CC0, source URL recorded) + grain.
- Templates (each with ≥ 2 fixtures, variables JSON Schema with `maxLength` on text, `useWhen`,
  `durationMs`, `sfxCues`): `paper-collage`, `map-route` (Natural Earth 1:50m TopoJSON in
  `styles/vox/assets/geo/`, read with `ctx.readAsset`; `d3-geo` and `topojson-client` vendored as ESM in
  `templates/map-route/vendor/` and imported by relative path from `build.mjs`; no tile servers),
  `kinetic-serif`, `stat`. All accept `bg`.
- `styles/vox/assets/motion.js`: the style's motion helpers (below). `vox-runtime.js` stays unchanged
  (frozen contract, R2).
- Transitions `vox/paper-tear`, `vox/slide-paper` (cover style, no handles).
- Overlay `vox/paper-grain` (default). Caption presets `vox/mono-box` (default), `vox/serif-lower`.
- SFX `paper-pop`, `paper-slide`, `whoosh`, `stamp`, `typewriter` (original or CC0, sources recorded).
- `styles/vox/guide.md` listing only installed (v1) templates.
- `docs/evidence/phase-07/side-by-side.jpg`: reference frames vs our fixture frames, per template.

## Steps

### A. Look development

0. [ ] MANUAL STEP (owner): put the reference reel file at `docs/evidence/phase-07/reference/reel.mp4`
       (gitignored; only extracted frames are committed). The AI does not download it.
1. [ ] Extract ~20 reference frames (one per distinct look) with timestamps; note each look's template.
2. [ ] Tokens + fonts + texture; one test composition showing palette, type and grain.
3. [ ] Motion vocabulary as helpers in `styles/vox/assets/motion.js` (copied into the build like other
       style assets; `vox-runtime.js` is not extended): `pop` entrance with `back.out(1.6)`, frame hold on
       twos, jitter 2 px, slow push-in. Deterministic (seeded jitter).

### B. Templates (one at a time; each ends with `vox style validate vox` green)

4. [ ] `kinetic-serif` (word-by-word reveal, `emphasis` words larger).
5. [ ] `stat` (big value, `line2`, faded `bgPhoto`, yellow `tag`).
6. [ ] `paper-collage` (1–6 cutouts with red 10 px stroke, staggered pop, push-in, label).
7. [ ] `map-route` (yellow land, blue sea, black pin tags, route line drawn, zoom levels; `geo` slots).
8. [ ] Transitions, overlay, caption presets, SFX cues.

### C. Checks

9. [ ] Add `styles/vox` to phase 03's token-scoping test fixtures and keep it green (`base/text-overlay`
       in a `vox` sequence carries `vox` tokens; a `vox` template in a `base` sequence keeps them). The
       test itself is owned by 03.
10. [ ] A sequence mixing `vox` and `base` templates compiles and renders (styles done-when 2).
11. [ ] Safe-area check passes on longest fixtures; no network in any build (S9).

### D. GATE 3 (owner)

12. [ ] Build the side-by-side sheet and a 20 s demo render using all 4 templates over the talking-head
        fixture. STOP for GATE 3. Iterate on feedback until approved, with no round limit (D-10); each
        round logged.

## Verify

```bash
pnpm -C packages/cli exec vox style validate vox --json
pnpm -C packages/engine test -- styles/vox
```

## Done when

- [ ] `vox style validate vox` passes; 4 templates, 2 transitions, overlay and 2 caption presets render.
- [ ] A mixed `vox` + `base` sequence compiles and renders.
- [ ] GATE 3: owner approved the side-by-side sheet (DECISIONS entry).
- [ ] All asset sources and licences recorded in R5 and `styles/vox/ASSETS.md`.

## Risks and fallback

| Risk | Fallback |
|---|---|
| Stop-motion feel reads as low frame rate | Frame hold applies only to entrances, not camera moves; test both |
| Map projection slow in `build.mjs` | Pre-project at 3 zoom levels at build time and cache by place set |
| Owner rejects the look repeatedly | Narrow to the single worst template per round; keep the rest frozen |

## Handoff notes

- Phase 12's clipper reads `guide.md` and `pacing`; keep the guide's rules testable (template choice
  by keyword).
- v1.1 templates (`year-card`, `framed-portrait`, `newspaper`, `stack`) are phase 14.
