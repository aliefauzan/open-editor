# Phase 12 — Agent workflows: clipper + free-form

| Field | Value |
|---|---|
| Track | agent |
| Prereq | 07 (GATE 3), 11 |
| Spec § | agent "Workflows" 1, 1b, 2, "CLI", "Testing" (mock-model, injection eval, live evals), "Done when" 1–4 |
| Model | Opus 5.5 · high |
| Gate | — |
| Next | 13 |

## Goal

"Make 3 vox clips from <url>" works from the CLI, in tools mode with an OpenRouter model and in plan mode
with a local Ollama model, and every result is undoable as one run. The clipper is quick clips (05)
followed by the new Stylize workflow, which also runs alone on clips the user already has (D-11).

## Required reading

- Agent spec "Workflows" 1, 1b, 2, "CLI", "Testing", "Done when"; engine "Quick clips"; DECISIONS D-11; `styles/vox/guide.md` and `pacing`.

## Output

- `agent/workflows/clipper.md` + checkpoints enforced by the loop:
  1. `ingest` → `transcribe` → `facetrack` (if a face);
  2. moments: the engine `quickClips` job with the agent's LLM scorer (`agent/src/quickScorer.ts`,
     registered with `engine.quickClips.registerScorer('llm', …)` when a `fast` model exists; `fast`
     scores each sentence-bounded candidate for hook, self-contained point and ending); without a
     `fast` model the heuristic scorer; checkpoint: `sourceRange` saved on new sequences, each captioned;
  3. storyboard: keep the continuous linked pair that `quickClips` placed (V1 `facetrack` framing + A1);
     collage beats as scenes on V2 covering V1; speaker beats are the gaps; `layout` `full-collage`
     (default) or `hybrid`;
  4. fill scenes: search → fetch → cutout; generate only when search fails and a provider exists; else
     `placeholder`;
  5. transitions per guide; captions on with the style default preset;
  6. self-review with `view_frames` + `vision` (≤ 2 fix passes); per-clip summary incl. skipped steps.
- `agent/workflows/stylize.md` (agent spec 1b): clipper steps 3–6 on given sequences; keeps the `V1`/`A1`
  pair, `sourceRange` and every caption override; switches `styleId` and caption preset; one run.
  `agent/workflows/clipper.md` = steps 1–2 above, then Stylize on the new sequences.
- `agent/workflows/edit.md`: free-form with the UI selection (sequence, items, playhead ms) as context.
- `vox agent <project> ["<instruction>"] [--workflow clipper|stylize|edit] [--seq id]... [--style id]
  [--layout full-collage|hybrid] [--mode tools|plan]
  [--max-usd 2] [--yes-sources]`, terminal approval prompt, `vox agent undo <project> <runId>`.
- `agent/evals/`: `models.json` (reference models incl. the local plan-mode model: the first candidate
  Ollama model that passes the `plan` probe from 11), 2 fixture inputs, scorecard (checkpoints,
  violations, cost, time), injection transcript (from 11); `pnpm eval [--provider <id>]` runs on any
  configured provider (`claude`, `openrouter`, `opencode-zen`, `9router`, `ollama`, `lmstudio`, `apple`
  for `fast`), each run capped by `maxUsdPerRun` (opt-in, not CI).

## Steps

1. [ ] Mock-model test, tools mode, clipper on the offline fixture (length 4–8 s; the
       fixture is 20 s): 3 sequences; durations within bounds;
       no overlaps; captions on; every scene variable valid; speaker share within `speakerRatio`; V1/A1
       linked with equal offsets.
2. [ ] Same with a scripted `ClipPlan` in plan mode.
3. [ ] Checkpoint enforcement: a run that skips `sourceRange` fails with a clear message.
4. [ ] Free-form mock tests: "make this longer" on a selected item → `trimItem` on that item.
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
9. [ ] MANUAL STEP (owner keys): `pnpm eval --provider <id>` live on both fixture inputs for every provider
       the owner configured (at least OpenRouter and Ollama); paste scorecards in the log.
10. [ ] MANUAL STEP: real URL, OpenRouter tools mode → 3 sequences + cost; Ollama plan mode → checkpoints pass.

## Verify

```bash
pnpm -C packages/agent test
pnpm eval --provider openrouter                        # live, opt-in; repeat per configured provider
export VOX_PROJECTS_DIR="$(mktemp -d)"
pnpm -C packages/cli exec vox new demo --json
pnpm -C packages/cli exec vox agent demo "make 3 vox clips from <url>" --json
```

## Done when (= agent done-when 1–4, 6)

- [ ] 1 probe reports capabilities for an OpenRouter and an Ollama model (from 11).
- [ ] 2 `vox agent … "make 3 vox clips from <url>"` → 3 sequences meeting checkpoints, cost reported,
      OpenRouter tools mode.
- [ ] 3 same command in plan mode with the Ollama model from `evals/models.json`; checkpoints pass.
- [ ] 4 undo-run restores or reports conflicts correctly.
- [ ] 6 if Apple Intelligence is on: a clipper run with `fast` = `apple` passes the checkpoints; else the
      skip reason is logged.
- [ ] Mock injection test passes in CI; live injection eval result recorded in the log.
- [ ] Stylize and LLM-scorer mock tests pass (D-11).

## Risks and fallback

| Risk | Fallback |
|---|---|
| Local model cannot produce a valid `ClipPlan` | Smaller plan (one sequence per `ClipPlan` call); pick a stronger local model in `models.json` |
| Archive search finds nothing usable | `placeholder` scenes, reported in the summary (never silent) |
| Cost of long transcripts | `fast` model scoring + compaction; budget pause |

## Handoff notes

- Phase 13 surfaces runs, pauses and undo in the app; phase 14 adds screenplay + Claude Code skill
  reusing these prompt files.
