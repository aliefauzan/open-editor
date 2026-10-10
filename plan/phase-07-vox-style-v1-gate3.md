# Phase 07 — `vox` style v1 + GATE 3

| Field | Value |
|---|---|
| Track | styles |
| Prereq | 05 (GATE 2), 06 (05 builds `vox frames`, `render`, `assets cutout` and `audio-qa`, which the sheet and the kit check use; D-12) |
| Spec § | styles "Part B" (tokens, v1 templates, transitions, overlays, caption presets, SFX, guide, quality bar), Part A "Caption presets" (D-15), "SFX rules", "Done when" 1–2; engine "Sound cues", "Audio QA", "Captions" |
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
- Overlay `vox/paper-grain` (default). Caption presets `vox/mono-box` (default), `vox/serif-lower`, each
  `captions/<preset>.html` + `captions/<preset>.json` on the Part A contract (D-15): word times from the
  injected `CaptionChunk[]`, read / active / unread states, `emphasis`, one row per line (never
  re-wrapped), default safe area 20 / 12 on 9:16.
  - `vox/mono-box`: `case: 'upper'`, `stripPunctuation: true`; unread and read words white, the active
    word yellow (`highlight`), emphasis words on a red (`accent`) box instead of black.
  - `vox/serif-lower`: `case: 'asis'`, `stripPunctuation: false`; unread words at 60 % opacity, active
    and read words full white, emphasis words yellow (`highlight`).
- SFX kit (D-14): `paper-pop` (appear), `paper-slide` (move), `whoosh` (move), `stamp` (land),
  `typewriter` (appear), `thump-tap` (hero) — real recordings only: CC0 or public domain, sourced by the AI from
  Wikimedia Commons first (no account; source URL recorded); a Freesound file only if the owner downloads
  it (optional MANUAL STEP, Freesound needs a login), or recorded for the project (licence `project`; D-16); never synthesised, no meme sounds; each in
  `style.json` `sfx` with `type`, `source`, `licence`, and in `styles/vox/assets/sfx/CREDITS.md`; trimmed
  with 5 ms fades, peak −1 dBFS. Templates and transitions declare `sfxCues` with `name` and `type`, at the
  times their own animation produces the event (the pop lands, the tear crosses, the card stops); at most
  one `hero` cue per template.
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
8. [ ] Transitions, overlay, caption presets. The presets pass 06's caption preset checks in
       `vox style validate vox` (D-15): at a frame inside word 2, word 2 has the active look and words 1 and
       3 the read and unread looks; the emphasis word has its own look at every state; word boxes stay in
       the safe area, also with `position.yPct` 95; a backwards seek gives a byte-identical frame; the SRT of
       a `mono-box` sequence keeps its original case and punctuation.
8b. [ ] SFX kit (D-14): wire `vox audio-qa --kit` (05) into `vox style validate` with the sheet at
        `previews/sfx-sheet.png`; test: a test style whose `sfx` holds a generated sine beep fails with the
        rule named. Then source or record each sound; run `vox audio-qa --kit vox` and look at
        `previews/sfx-sheet.png` (vision review in the log: one event per file, no click inside a whoosh,
        no tone line); replace any file that fails, never loosen a threshold. Add `sfxCues` to every
        template and transition; `vox style validate vox` checks cue timing against measured motion.

### C. Checks

9. [ ] Add `styles/vox` to phase 03's token-scoping test fixtures and keep it green (`base/text-overlay`
       in a `vox` sequence carries `vox` tokens; a `vox` template in a `base` sequence keeps them). The
       test itself is owned by 03.
10. [ ] A sequence mixing `vox` and `base` templates compiles and renders (styles done-when 2).
11. [ ] Safe-area check passes on longest fixtures; no network in any build (S9).

### D. GATE 3 (owner)

12. [ ] Build the side-by-side sheet and a 20 s demo render using all 4 templates over the talking-head
        fixture. The sheet includes each caption preset at a frame with an active word, so the karaoke
        state (read / active / unread, one emphasis word) is visible next to the reference (D-15). Run `vox audio-qa` on the demo (all checks pass; `qa.json`, `qa.png`, `LISTEN.md` into
        `docs/evidence/phase-07/`) and describe `qa.png` at each hero cue in the log. Ask the owner to
        listen at the five `LISTEN.md` timecodes and approve or name what sounds wrong. STOP for GATE 3. Iterate on feedback; each round logged. After 3 rounds without
        approval, ask the owner to choose (a) keep iterating or (b) accept the style as the v1 look, with
        the open notes written to the phase log as backlog. Never accept on the owner's behalf (D-16).

## Verify

```bash
pnpm -C packages/cli exec vox style validate vox --json
pnpm -C packages/engine test -- styles/vox
pnpm -C packages/cli exec vox audio-qa <demo project> --json      # all checks pass on the GATE 3 demo
pnpm -C packages/cli exec vox audio-qa --kit vox --json
```

## Done when

- [ ] `vox style validate vox` passes; 4 templates, 2 transitions, overlay and 2 caption presets render;
      both presets pass the word-state, emphasis and safe-area checks (D-15).
- [ ] A mixed `vox` + `base` sequence compiles and renders.
- [ ] SFX kit passes the SFX rules; every template/transition cue passes cue timing; demo audio QA green.
- [ ] GATE 3: owner approved the side-by-side sheet (incl. the active-word caption frames) and the ear
      check at the five `LISTEN.md` timecodes (DECISIONS entry).
- [ ] All asset sources and licences recorded in R5, `styles/vox/ASSETS.md` and `assets/sfx/CREDITS.md`.

## Risks and fallback

| Risk | Fallback |
|---|---|
| Stop-motion feel reads as low frame rate | Frame hold applies only to entrances, not camera moves; test both |
| Map projection slow in `build.mjs` | Pre-project at 3 zoom levels at build time and cache by place set |
| No CC0 recording fits a sound type | Record it for the project (paper, stamp, desk thump with a phone mic; licence `project`); never synthesise |
| Owner rejects the look repeatedly | Narrow to the single worst template per round; keep the rest frozen; after 3 rounds the owner chooses keep iterating or accept with backlog notes (D-16) |

## Handoff notes

- 10a no longer waits for this phase (D-16); its style panel lists `vox` once this phase is merged. 12
  needs 07, and 13 checks the gallery shows `base` and `vox`.
- Phase 12's clipper reads `guide.md` and `pacing`; keep the guide's rules testable (template choice
  by keyword).
- v1.1 templates (`year-card`, `framed-portrait`, `newspaper`, `stack`) are phase 14.
