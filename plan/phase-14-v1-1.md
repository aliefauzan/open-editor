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
| 14a | `vox` templates `year-card`, `framed-portrait`, `newspaper`, `stack` (nested panels, depth 1), each with `sfxCues` from the existing kit (D-14); `guide.md` updated with their rules | styles "Part B" v1.1 table, "SFX rules" | `vox style validate vox` passes for all 8 (incl. cue timing); side-by-side sheet for the 4 new ones approved by the owner (GATE 6; after 3 rounds without approval the owner chooses keep iterating or accept with backlog notes, D-16) |
| 14b | Screenplay fixture generator first: `scripts/make-screenplay-set.ts` writes a short `.fountain` (6 scenes) and 6 generated clips (`testsrc2` + `drawtext` scene label + `say` line), with tags in a JSON file, deterministic and offline (R7); then the screenplay match workflow (parse scenes; tag footage with `vision` → `update_media`, cached; match by `embed` model or LLM ranking; lay out in screenplay order; `base/placeholder` for gaps; best-take note); "Match screenplay" quick action; `vox agent --workflow screenplay` | agent "Screenplay match" | fixture screenplay set → clips in screenplay order (agent done-when 5, part 1) |
| 14c | Claude Code skill `.claude/skills/vox-studio/SKILL.md` using `vox … --json` and the shared workflow prompts + checkpoints; `vox frames` for self-review | agent "Claude Code skill" | skill runs the clipper end to end via the CLI (agent done-when 5, part 2) |
| 14d | Local image generation: `mflux` provider with Z-Image-Turbo (default, not gated), FLUX.1-schnell optional (HF token, terms explained by `vox doctor`); settings toggle showing size + licence before download; `mflux` added to `uv.lock`, so an app update triggers the py-env resync (D-12) | engine "Image generation provider"; app "Settings" v1.1 | `vox assets generate` works offline after download; app toggle works; an app built from 13 then updated to 14d resyncs `py-env` on launch (lock hash changed) |
| 14e | Clip speed: design note first (`speed` field with a `schemaVersion` bump and load-time migration, duration rule `inMs + durationMs × speed`, audio `atempo`), spike on HyperFrames `playbackRate`, then op + compile + audio + inspector field | engine "Non-goals" (clip speed) | design approved (GATE 7); spike result recorded; 0.5× and 2× clips render in sync (A/V < 1 frame) |
| 14f | Audio ducking: `sidechaincompress` per track in the mix graph, after each clip's gain-to-target and before `amix`, so it ducks level-matched sources (D-15); inspector toggle | engine "Audio", "Audio QA" | mix-graph snapshot test; speech-over-music fixture ducks; `vox audio-qa` passes on it with unchanged thresholds |
| 14g | FCPXML export via `otio-fcpx-xml-adapter` plus the export dialog option (if GATE 2 already needed FCPXML, phase 05 built the engine side and 14g only adds the dialog option) | overview step 7 | FCPXML imports in Final Cut Pro or Resolve (owner check) |

## Required reading

- The spec section of the sub-phase; its parent phase log (07 for 14a, 12 for 14b/14c, 05 for 14d/14g,
  03 for 14e/14f).

## Steps (per sub-phase)

1. [ ] Take the sub-phase's PROGRESS row (14a–14g are listed there, each with prereq 13); read; plan;
       tests first (as in PROMPT.md).
2. [ ] For 14a: build the side-by-side sheet for the 4 new templates and STOP for GATE 6 (3-round exit as
       in GATE 3, D-16).
       For 14e: write the design note into the engine spec (new subsection), run the `playbackRate` spike,
       and STOP for GATE 7 (owner approves the design before code). Other sub-phases do not stop.
3. [ ] Build, review, verify, log, merge.

## Verify

Each sub-phase runs `pnpm test` plus its own block. Live and owner steps are MANUAL STEPs (PROMPT.md
step 6g).

14a:

```bash
pnpm -C packages/cli exec vox style validate vox --json        # all 8 templates, cue timing included
pnpm -C packages/cli exec vox audio-qa --kit vox --json
```

14b:

```bash
pnpm exec tsx scripts/make-screenplay-set.ts                     # from the repo root (R1, D-16); twice; outputs byte-identical on the same machine
pnpm -C packages/agent test -- screenplay                        # mock model: clips in screenplay order
pnpm eval --provider <id>                                        # live, opt-in, per configured provider
```

14c:

```bash
pnpm -C packages/agent test -- skill        # SKILL.md commands exist in `vox --help --json`
# MANUAL STEP (owner): in Claude Code, "make 3 vox clips from <url>" with the skill; paste the run summary
```

14d:

```bash
pnpm -C packages/engine test -- assets/generate      # provider contract with a fake mflux
pnpm -C packages/engine test:slow -- mflux            # real model, after download; offline run
pnpm -C apps/desktop test -- settings/imagegen pyenv-resync
```

14e:

```bash
pnpm -C packages/engine test -- ops/speed model/migrate audio/atempo
pnpm -C packages/engine test:slow -- render/speed    # 0.5× and 2× fixtures, A/V offset < 1 frame
```

14f:

```bash
pnpm -C packages/engine test -- audio/duck
pnpm -C packages/cli exec vox audio-qa <speech-over-music fixture project> --json
```

14g:

```bash
pnpm -C packages/engine test -- export/fcpxml        # adapter output validates against the FCPXML DTD
# MANUAL STEP (owner): import the file in Final Cut Pro or Resolve; screenshot in evidence
```

## Done when

- [ ] Every sub-phase row in PROGRESS is [x] with its own done-when evidence.
- [ ] Styles done-when 3 and agent done-when 5 are met.

## Risks and fallback

| Risk | Fallback |
|---|---|
| HyperFrames `playbackRate` unreliable | 14e renders speed-changed clips via ffmpeg pre-processing into a cached media file |
| Embedding model not configured | LLM ranking over tags (spec fallback) |
