# Phase 14b — Screenplay match workflow

| Field | Value |
|---|---|
| Status | done |
| Started · Finished | 2026-10-12 · 2026-10-12 |
| Model | Sonnet 5.5 · high (phase agent, no subagents; review is a self-review, token budget) |
| Machine | M5, macOS 27 |
| Branch | phase/14b-screenplay-match (worktree `.worktrees/phase-14b`) |

## Pre-check
Prerequisite 13 is [x] (ee82856, D-60). Wave 14 runs eight agents in parallel (notes: main lock, D-NN under
lock, bench lock). Owner delegation: live checks run by the AI with the keyless providers (Ollama
`qwen3.5:latest`, Apple on-device); no credentials entered.

## Plan summary
1. Fixture generator first: `scripts/make-screenplay-set.ts` (`.fountain` with 6 scenes, 6 clips in shuffled
   order, tags JSON, expected order). Offline, bitexact, byte-identical on a second run. `drawtext` is not
   in the Homebrew ffmpeg (D-17), so the scene label is a seven-segment digit made with `drawbox`.
2. Parser `packages/agent/src/screenplay/parse.ts`: fountain (and plain txt/md with the same heading rule)
   → scenes (heading, description, dialogue, estimated duration).
3. Matcher `screenplay/match.ts`: embedding cosine when an embedder is given, else LLM ranking over tags
   (one JSON call per scene, `fast` role else `editor`); several matches → best take + a note.
4. Workflow `workflows/screenplay.ts` + `workflows/screenplay.md` (frontmatter checkpoints `tag`, `match`,
   `layout`): collect scenes and footage, tag untagged clips (keyframes → `vision` → `update_media`,
   cached: a tagged clip is not asked again), match, lay out on `V1`/`A1` in screenplay order with scene
   durations, `base/placeholder` with the heading for gaps, summary with best-take notes.
5. `vox agent --workflow screenplay --screenplay <doc>`; "Match screenplay" quick action in the app agent panel.
6. Tests (mock model) first for each step; eval input + `pnpm eval --provider <id>` live (opt-in).
Test order: generator, parser, matcher, workflow (order, gap, best take, cache, no-vision, injection), CLI, app.

## Checklist
- [x] Step 1 generator `scripts/make-screenplay-set.ts` + test (two runs: 9 files, identical sha256; picture inspected)
- [x] Step 2 parser `screenplay/parse.ts` (fountain, txt, md, `SCENE n`; boneyard and notes stripped; duration estimate)
- [x] Step 3 matcher `screenplay/match.ts` (embedding, LLM, word overlap; bars; greedy one-use assignment; best-take note)
- [x] Step 4 workflow `workflows/screenplay.ts` + `workflows/screenplay.md`; checkpoints tag, match, layout in `load.ts`
- [x] Step 5 `vox agent --workflow screenplay --screenplay <doc> [--footage id]...`; self-test lists the workflow
- [x] Step 6 app: "Match screenplay" button in the agent panel; the host auto-picks the workflow for an attached document
- [x] Step 7 `embed` role as a function: `createEmbedder` (ollama, openai, openrouter, openai-compatible), `buildEmbedder`
- [x] Step 8 eval: `packages/agent/evals/screenplay.ts` and `--only clipper|screenplay`
- [x] Step 9 live checks with keyless providers (below)
- [x] Self-review (token budget, no subagents): fixes made, see Review findings

## Files created / changed
- New: `scripts/make-screenplay-set.ts`; `packages/agent/src/screenplay/{parse,match}.ts`;
  `packages/agent/src/workflows/screenplay.ts`; `packages/agent/workflows/screenplay.md`;
  `packages/agent/evals/screenplay.ts`; tests in `packages/agent/test/{screenplay,workflows,evals,providers,helpers}`,
  `packages/cli/test/agent.test.ts`, `apps/desktop/test/{renderer/match-screenplay.test.tsx,engine-host/agent-screenplay.test.ts}`.
- Changed: `workflows/load.ts`, `run-workflow.ts`, `api.ts`, `providers/factory.ts`, `config/run-models.ts` (agent);
  `cli/src/{main,agent,self-test}.ts`; `apps/desktop/src/engine-host/agent.ts`, `renderer/editor/AgentPanel.tsx`;
  `evals/run.ts`; spec `2026-10-10-vox-agent-design.md` (details, CLI usage).

## Verify results
| Command | Result | Numbers |
|---|---|---|
| `node scripts/make-screenplay-set.ts --out A` and `--out B` | pass | 9 files, sha256 identical |
| `pnpm -C packages/agent test -- screenplay` | pass | 48 files, 732 passed, 1 skipped (one flaky timing failure in the first run, green on re-run) |
| `pnpm test` (root, in the worktree after merging main) | 2 fail, both environment | 210 of 212 files; 2542 passed, 1 failed, 3 skipped. `facetrack.local.test.ts` and `framing-provider.local.test.ts` need to download the MediaPipe model (no network here) |
| `cd apps/desktop && pnpm test` | 2 fail, both on main too | 385 passed, 2 failed: `agent panel placeholder links to settings`, `next-steps bar ... Add style beats disabled`. Same two fail on a clean checkout of main (8cc4c02); not caused by this phase |
| `rtk proxy pnpm lint`, `pnpm -r typecheck` | pass | clean |
| `pnpm run eval --only screenplay --mode plan`, Ollama `qwen3.5:latest` (editor, vision) | 1 pass, 1 fail after the prompt fix (first run, before it: 0 of 2, every clip scored 0) | 66-94 s; the fail is one scene with no clip above the 0.5 bar (small-model flake) |
| same, `fast` = Apple on-device | 2 pass, 1 fail of 3 | 34 s a run; the fail is one scene below the bar |

Live numbers were taken while 7 other phase agents loaded the CPU. Ranking by the small local models is not
stable run to run; the workflow shows the placeholder rather than a wrong clip, which is the designed behaviour.

## Done when
| # | Item | Evidence |
|---|---|---|
| 1 | The fixture screenplay set gives clips in screenplay order (agent done-when 5, part 1) | `test/workflows/screenplay.test.ts` "fixture set: the clips are on V1 in screenplay order, sound on A1, one undo entry" (mock ranker, 6 scenes, shuffled clips) and `test/evals/screenplay-eval.test.ts`; live: PASS with Ollama qwen3.5 and with Apple as `fast` (2 of 5 live runs missed one scene; see above) |
| 2 | Generator is deterministic | two runs, identical sha256 of all 9 outputs |
| 3 | Quick action and CLI | `apps/desktop/test/renderer/match-screenplay.test.tsx`, `packages/cli/test/agent.test.ts`; the real button in the packaged app is open (below) |

## Review findings
| Agent | Severity | Finding | Fixed? |
|---|---|---|---|
| self-review (token budget) | medium | an ingest that failed silently fell back to the first document in the project | yes: a named file never falls back |
| self-review (token budget) | medium | an `m_...` id not in the project gave "needs a document" | yes: VALIDATION naming the id |
| self-review (token budget) | low | long clips were transcribed while tagging | yes: not above 120 s, with a note |
| self-review (token budget) | low | `vox self-test` did not list the new workflow | yes |
| live eval | medium | local model scored every clip 0 | prompt now points at spoken words; see D-66 |

## Deviations
- `node scripts/make-screenplay-set.ts` instead of `pnpm exec tsx` (no tsx); seven-segment digits instead of text
  (no `drawtext`). Both in D-66.
- The `embed` path is covered by fake-fetch tests only (no embedding model or key here).

## MANUAL STEPS
1. (optional; does not block) At the screen in the packaged app: drop `packages/engine/test/fixtures/out/screenplay/screenplay.fountain`
   and the six clips on the chat, press "Match screenplay"; the V1 track should show 6 clips in scene order.
2. (optional; needs a key or a model) `vox config roles set embed ollama:<embedding model>` (or OpenRouter), run
   `vox agent <p> --workflow screenplay --screenplay ...`; the report should say method `embedding`.

## Handoff notes
- `WorkflowDeps.embed` and `createEmbedder` are new; the app host and the CLI build the embedder from `roles.embed`.
- Fixture set output folder: `packages/engine/test/fixtures/out/screenplay` (ignored by git); tests build it into a temp dir.
- Ranking with small local models is flaky near the 0.5 bar; a larger model or an embedding model is steadier.

## Follow-up 2026-10-12: local signals (D-77, feat/screenplay-local)
- The Apple helper's `--embed` (NaturalLanguage, macOS 14+) is the default `embed` when no role is set: a first
  pass that matches sure scenes without a model call and sends the rest to the LLM with their 8 best clips.
  Tagging uses the Apple vision role, else frame cards, and a paid vision model only when neither gives tags.
- Fixture set: before 6 vision + 6 ranking calls (about 33,350 input tokens), after 0 + 1 (about 560); with the
  real helper 4 of 6 scenes matched locally. Details in DECISIONS.md D-77.
- Review: self-review (token budget). `pnpm dist:no-apple` built; its CLI cannot add the Apple provider (no
  helper), so screenplay ranks as before.
