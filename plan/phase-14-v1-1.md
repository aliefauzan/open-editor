# Phase 14 — v1.1

| Field | Value |
|---|---|
| Track | all |
| Prereq | 13 (v1.0) |
| Spec § | overview "Build order" step 7; styles "Part B" v1.1 templates, "Done when" 3; agent "Screenplay match", "Claude Code skill", "Done when" 5; engine "Non-goals" (v1.1 items), "Audio" (ducking), "Image generation provider" (mflux); app "Settings" (v1.1) |
| Model | Sonnet 5.5 · high (14e clip speed: Opus 5.5 · high) |
| Gate | **GATE 6** (14a sheet), **GATE 7** (14e design); other sub-phases have their own done-when |
| Next | — |

## Goal

Finish the features deferred from v1, each as a small, separately mergeable sub-phase. Each sub-phase
gets its own row in PROGRESS (14a…14g), its own branch `phase/14x-<slug>`, and its own log.

## Sub-phases

| Id | Builds | Spec § | Done when |
|---|---|---|---|
| 14a | `vox` templates `year-card`, `framed-portrait`, `newspaper`, `stack` (nested panels, depth 1); `guide.md` updated with their rules | styles "Part B" v1.1 table | `vox style validate vox` passes for all 8; side-by-side sheet for the 4 new ones approved by the owner (GATE 6, no round limit) |
| 14b | Screenplay match workflow (parse scenes; tag footage with `vision` → `update_media`, cached; match by `embed` model or LLM ranking; lay out in screenplay order; `base/placeholder` for gaps; best-take note); "Match screenplay" quick action; `vox agent --workflow screenplay` | agent "Screenplay match" | fixture screenplay set → clips in screenplay order (agent done-when 5, part 1) |
| 14c | Claude Code skill `.claude/skills/vox-studio/SKILL.md` using `vox … --json` and the shared workflow prompts + checkpoints; `vox frames` for self-review | agent "Claude Code skill" | skill runs the clipper end to end via the CLI (agent done-when 5, part 2) |
| 14d | Local image generation: `mflux` provider with Z-Image-Turbo (default, not gated), FLUX.1-schnell optional (HF token, terms explained by `vox doctor`); settings toggle showing size + licence before download | engine "Image generation provider"; app "Settings" v1.1 | `vox assets generate` works offline after download; app toggle works |
| 14e | Clip speed: design note first (`speed` field with a `schemaVersion` bump and load-time migration, duration rule `inMs + durationMs × speed`, audio `atempo`), spike on HyperFrames `playbackRate`, then op + compile + audio + inspector field | engine "Non-goals" (clip speed) | design approved (GATE 7); spike result recorded; 0.5× and 2× clips render in sync (A/V < 1 frame) |
| 14f | Audio ducking: `sidechaincompress` per track in the mix graph; inspector toggle | engine "Audio" | mix-graph snapshot test; speech-over-music fixture ducks |
| 14g | FCPXML export via `otio-fcpx-xml-adapter` plus the export dialog option (if GATE 2 already needed FCPXML, phase 05 built the engine side and 14g only adds the dialog option) | overview step 7 | FCPXML imports in Final Cut Pro or Resolve (owner check) |

## Required reading

- The spec section of the sub-phase; its parent phase log (07 for 14a, 12 for 14b/14c, 05 for 14d/14g,
  03 for 14e/14f).

## Steps (per sub-phase)

1. [ ] Take the sub-phase's PROGRESS row (14a–14g are listed there, each with prereq 13); read; plan;
       tests first (as in PROMPT.md).
2. [ ] For 14a: build the side-by-side sheet for the 4 new templates and STOP for GATE 6.
       For 14e: write the design note into the engine spec (new subsection), run the `playbackRate` spike,
       and STOP for GATE 7 (owner approves the design before code). Other sub-phases do not stop.
3. [ ] Build, review, verify, log, merge.

## Verify

```bash
pnpm test
pnpm -C packages/cli exec vox style validate vox --json     # 14a
pnpm eval --provider <id>                                   # 14b, live opt-in, per configured provider
```

## Done when

- [ ] Every sub-phase row in PROGRESS is [x] with its own done-when evidence.
- [ ] Styles done-when 3 and agent done-when 5 are met.

## Risks and fallback

| Risk | Fallback |
|---|---|
| HyperFrames `playbackRate` unreliable | 14e renders speed-changed clips via ffmpeg pre-processing into a cached media file |
| Embedding model not configured | LLM ranking over tags (spec fallback) |
