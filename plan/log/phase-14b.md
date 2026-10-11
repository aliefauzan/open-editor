# Phase 14b — Screenplay match workflow

| Field | Value |
|---|---|
| Status | in progress |
| Started · Finished | 2026-10-12 · — |
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
- [ ] Step 1 generator + test (deterministic twice)
