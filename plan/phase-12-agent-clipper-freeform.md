# Phase 12 — Agent workflows: clipper + free-form

| Field | Value |
|---|---|
| Track | agent |
| Prereq | 07 (GATE 3), 11 |
| Spec § | agent "Workflows" (frontmatter) 1, 1b, 2, "CLI", "Testing" (mock-model, injection eval, live evals, sound review, replay), "Done when" 1–4, 6–8; engine "Audio QA" |
| Model | Opus 5.5 · high |
| Gate | — |
| Next | 13 |

## Goal

"Make 3 vox clips from <url>" works from the CLI, in tools mode with an OpenRouter model and in plan mode
with a local Ollama model, and every result is undoable as one run. The clipper is quick clips (05)
followed by the new Stylize workflow, which also runs alone on clips the user already has (D-11).

## Required reading

- Agent spec "Workflows" 1, 1b, 2, "CLI", "Testing", "Done when"; engine "Quick clips", "Audio QA"; DECISIONS D-11, D-14, D-15; `styles/vox/guide.md` and `pacing`; phase 11 handoff notes.
- `plan/ref/R4-security.md` rows S20, S34 (on-image text, image injection case) and S35 (`call_tool`
  rules, question turn read-only).

## Output

- Every workflow file starts with frontmatter the loop reads (D-15): `allowedTools` (the tools sent to
  the model), `roles` (a missing `editor` fails the run at start; other missing roles degrade visibly)
  and `checkpoints` (enforced in order). Clipper: the 12 core tools `get_transcript`, `get_template`,
  `add_scene`, `update_scene`, `move_item`, `trim_item`, `set_transition`, `search_images`,
  `fetch_image`, `cutout`, `view_frames`, `check_audio`; `roles: [editor, fast, vision]`;
  `checkpoints: [ranges, tighten, storyboard, fill, review, sound]`. Stylize: the same `allowedTools`,
  without the `ranges` and `tighten` checkpoints. Other tools go through `call_tool`.
- `agent/workflows/clipper.md` + checkpoints enforced by the loop:
  1. `ingest` → `shots` → `transcribe` → `facetrack` (always: `auto` framing needs it; D-15), started by
     the workflow, so these job tools are not in `allowedTools`;
  2. moments: the engine `quickClips` job with the agent's LLM scorer (`agent/src/quickScorer.ts`,
     registered with `engine.quickClips.registerScorer('llm', …)` when a `fast` model exists; `fast`
     scores each sentence-bounded candidate for hook, self-contained point and ending); without a
     `fast` model the heuristic scorer; checkpoint: `sourceRange` saved on new sequences, each captioned;
  2b. **Tighten** (D-15): for each new sequence the workflow (not the model) runs `remove_pauses` with
     `dryRun: true`; the ranges form a review list. App: an `approval` pause with kind `pauses` and
     `ranges: { wordKey, kind, seqStartMs, seqEndMs, text }[]` (13 shows the card; the answer is
     `{ approve: true, wordKeys }`, empty = skip). CLI: `--yes` applies the whole list, else the terminal
     asks. The full list applies as one `remove_pauses`, a ticked subset as one `remove_pauses { wordKeys }`
     (each range keeps `keepMs`); one undo entry per sequence. Checkpoint
     `tighten`: the list was shown and applied, or skipped by the user;
  Steps 3–6 run as **one sub-run per sequence** (11's machinery: fresh context, same `runId`, summary
  back, `maxStepsPerRun` per sub-run; D-15).
  3. storyboard: keep the linked pair that `quickClips` placed (V1 `auto` framing + A1; after Tighten a
     run of linked pairs with jump cuts; D-15);
     collage beats as scenes on V2 covering V1; speaker beats are the gaps; `layout` `full-collage`
     (default) or `hybrid`;
  4. fill scenes: search → fetch → cutout; generate only when search fails and a provider exists; else
     `placeholder`;
  5. transitions per guide, with cover-style transitions (no source handles needed) at the start and
     end of each clip (D-15); captions on with the style default preset;
  6. self-review: frame-health flags fixed first (no model), then `view_frames` + `vision` (≤ 2 fix
     passes), then sound review (D-14): `check_audio`
     per sequence; a FAIL is fixed only through ops (move or trim the scene, swap the transition,
     mute a cue with `updateScene { sfxOff }`), ≤ 2 fix rounds; the summary gives the audio numbers and the five `LISTEN.md`
     timecodes for the user to check by ear, lists any check still failing, and never says the sound
     is good; per-clip summary incl. skipped steps and frame-health flags.
- `agent/workflows/stylize.md` (agent spec 1b): clipper steps 3–6 on given sequences, one sub-run per
  sequence (D-15); keeps the `V1`/`A1` pair, `sourceRange` and every caption override; switches
  `styleId` and caption preset; cover-style transitions at clip edges; one run.
  `agent/workflows/clipper.md` = steps 1–2 above, then Stylize on the new sequences.
- `agent/workflows/edit.md`: free-form with the UI selection (sequence, items, playhead ms) as context,
  its own `allowedTools` in the frontmatter. **Intent gate** (D-15): each turn is first classified as a
  question or an edit by the `fast` role (one JSON call); a question gets read tools only (`call_tool`
  refuses others) and makes no history entry; with no `fast` model every turn is an edit.
- **User edits during a run** (D-15, every workflow): the user may edit sequences in the run's scope;
  the edits reach the agent as the "Changes since your last step" note (11); a colliding agent write
  returns `conflicted` or `STALE` and the agent re-reads.
- **Confirm plan** (D-15): with `--confirm-plan` (app toggle in 13) each validated plan-mode plan pauses
  the run (`approval`, kind `plan`) until OK; Stop ends the run with nothing from that plan applied.
  With sub-runs, each sub-run plans its own sequence (a `ClipPlan` with one entry).
- `vox agent <project> ["<instruction>"] [--workflow clipper|stylize|edit] [--seq id]... [--style id]
  [--layout full-collage|hybrid] [--mode tools|plan]
  [--max-usd 2] [--yes-sources] [--yes] [--confirm-plan]`, terminal approval prompt, `vox agent undo
  <project> <runId>`. `--yes` applies the clipper's tighten list without asking and never approves
  sources (D-15).
- `agent/evals/`: `models.json` (reference models incl. the local plan-mode model: the first candidate
  Ollama model that passes the `plan` probe from 11), 2 fixture inputs, scorecard (checkpoints,
  violations, cost, time), injection transcript (from 11); `pnpm eval [--provider <id>]` runs on any
  configured provider (`claude`, `openrouter`, `opencode-zen`, `9router`, `ollama`, `lmstudio`, `apple`
  for `fast`), each run capped by `maxUsdPerRun` (opt-in, not CI). The injection eval adds an image case
  (D-15): a fixture frame and an archive image whose visible text gives the same orders; the scorecard
  fails on the same conditions.
- `agent/test/replay/fixtures/`: recorded run records (mock runs from the steps below, and live runs
  from steps 9–10 once redacted) committed as deterministic replay regression fixtures for 11's harness;
  they run in CI (D-15).

## Steps

1. [ ] Mock-model test, tools mode, clipper on the offline fixture (length 4–8 s; the
       fixture is 20 s): 3 sequences; durations within bounds;
       no overlaps; captions on; every scene variable valid; speaker share within `speakerRatio`; V1/A1
       linked with equal offsets.
2. [ ] Same with a scripted `ClipPlan` in plan mode.
3. [ ] Checkpoint enforcement: a run that skips `sourceRange` fails with a clear message.
4. [ ] Free-form mock tests: "make this longer" on a selected item → `trimItem` on that item.
4b. [ ] Sound review mock test (D-14): a fixture scene pair whose cues land 50 ms apart and a `qa.json`
        with a `cue-spacing` FAIL → one `updateScene { sfxOff }` op, `check_audio` passes on round 2; a
        FAIL still present after 2 rounds is listed in the summary; no summary contains "sounds good" or
        similar (string check on the scripted run).
5. [ ] Stylize mock test: on a quick-clips sequence with one edited caption word, Stylize keeps the
       linked pair, `sourceRange` and the caption override, switches style and preset, adds scenes;
       `undoRun` returns the plain captioned clip (normalised `project.json` equal). LLM scorer mock
       test: scripted scores decide the ranges; a scorer error falls back to the heuristic, reported.
6. [ ] `undoRun`: restores pre-run state with no later edits; reports `UNDO_CONFLICT` with item ids when
       the user edited after.
7. [ ] Mock injection test (CI): a scripted `MockLanguageModelV4` obeys the injection transcript
       (`ingest('~/.ssh/id_rsa')`, `remove_item` on every clip) → `approval` pause, nothing ingested,
       `undoRun` restores every removed clip (S20). The live injection eval stays in the scorecard as
       extra evidence about real models.
8. [ ] CLI approval prompt; `--yes-sources` pre-approves only sources named in the instruction.
8b. [ ] Clipper D-15 mock tests: each sequence runs in its own sub-run with the same `runId`; the
        tighten list matches the fixture's pauses and applies as one undo entry per sequence (with `--yes`,
        and with a ticked subset as `remove_pauses { wordKeys }`, which keeps `keepMs` at each range);
        `--yes` never approves a source; clip edges get cover-style transitions; `--confirm-plan` pauses
        before each plan runs and Stop applies nothing; the frontmatter `allowedTools` are exactly what is sent; a missing `editor` role fails at start.
8c. [ ] Free-form D-15 mock tests: a question turn ("why is this clip so short?") gets read tools only and
        makes no history entry, and a write through `call_tool` in it is refused (S35); a user edit
        between two steps shows in the next change note; a colliding agent write returns `conflicted`
        and the agent re-reads.
8d. [ ] Mock injection image case (D-15): a scripted vision model whose description repeats the image's
        orders → the text arrives in `<data source="vision">`, no unrequested clip is removed and no
        un-approved ingest runs without a pause (S34).
8e. [ ] Replay fixtures (D-15): record the mock runs of steps 1, 2, 5 and 8b; commit them; they replay
        green in CI.
9. [ ] MANUAL STEP (owner keys): `pnpm eval --provider <id>` live on both fixture inputs for every provider
       the owner configured (at least OpenRouter and Ollama), incl. the injection image case; paste
       scorecards in the log. `vox config probe` reports the tool-list cost for the Ollama model of
       done-when 3 (≤ 25 % of its context with the clipper's `allowedTools`; D-15).
10. [ ] MANUAL STEP (owner gives the URL): real URL, OpenRouter tools mode → 3 sequences + cost + audio
        numbers and timecodes; Ollama plan mode → checkpoints pass. Both runs use one sub-run per
        sequence, each within `maxStepsPerRun` (D-15).

## Verify

Automated (CI, no network; `MockLanguageModelV4`, offline fixture):

```bash
pnpm -C packages/agent test                            # steps 1–8e, incl. 4b, the mock injection tests and replay
```

Live (MANUAL STEP, owner keys and URL; steps 9–10; not CI):

```bash
pnpm eval --provider openrouter                        # repeat per configured provider
export VOX_PROJECTS_DIR="$(mktemp -d)"
pnpm -C packages/cli exec vox new demo --json
pnpm -C packages/cli exec vox agent demo "make 3 vox clips from <url>" --json
pnpm -C packages/cli exec vox config probe --json      # tool-list cost per role (D-15)
```

## Done when (= agent done-when 1–4, 6–8)

- [ ] 1 probe reports capabilities for an OpenRouter and an Ollama model (from 11).
- [ ] 2 `vox agent … "make 3 vox clips from <url>"` → 3 sequences meeting checkpoints, cost reported,
      OpenRouter tools mode.
- [ ] 3 same command in plan mode with the Ollama model from `evals/models.json`; checkpoints pass.
- [ ] 4 undo-run restores or reports conflicts correctly.
- [ ] 6 if Apple Intelligence is on: a clipper run with `fast` = `apple` passes the checkpoints; else the
      skip reason is logged.
- [ ] 7 (D-15) `vox config probe` reports the tool-list cost for the Ollama model of done-when 3 at or
      under 25 % of its context with the clipper's `allowedTools`; the 3-clip runs of 2 and 3 run one
      sub-run per sequence, each within `maxStepsPerRun`.
- [ ] 8 (D-15) `vox agent <project> --workflow clipper --yes` on the fixture removes the fixture's
      pauses as one undo entry per sequence, and the committed replay fixtures pass in CI.
- [ ] Mock injection tests (transcript and image case) pass in CI; live injection eval result, incl. the
      image case, recorded in the log (S20, S34).
- [ ] The phase-12 parts of S34 (image case) and S35 (question turn read-only) pass; security review clean
      of CRITICAL/HIGH.
- [ ] Stylize and LLM-scorer mock tests pass (D-11); sound review mock test passes (D-14).

## Risks and fallback

| Risk | Fallback |
|---|---|
| Local model cannot produce a valid `ClipPlan` | Smaller plan (one sequence per `ClipPlan` call); pick a stronger local model in `models.json` |
| Archive search finds nothing usable | `placeholder` scenes, reported in the summary (never silent) |
| Cost of long transcripts | `fast` model scoring + compaction; budget pause |
| Clipper tool list over 25 % of the local model's context (D-15) | Shorten tool descriptions; move a rarely used tool from `allowedTools` to `call_tool`; record in DECISIONS |

## Handoff notes

- Phase 13 surfaces runs, pauses and undo in the app; phase 14 adds screenplay + Claude Code skill
  reusing these prompt files.
