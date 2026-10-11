# Phase 14c — Claude Code skill

| Field | Value |
|---|---|
| Status | done (merged); one optional open item: repeat the run inside Claude Code itself |
| Started · Finished | 2026-10-12 · 2026-10-12 |
| Model | Sonnet 5.5 (phase agent, no subagents; self-review (token budget)) |
| Machine | M5, macOS 27; seven other phase agents ran at the same time (load average 15 to 28) |
| Branch | phase/14c-claude-skill (worktree `.worktrees/phase-14c`) |

## Pre-check
Prerequisite 13 is [x] (ee82856, D-60), checked by the orchestrator. Tools present: ffmpeg 8.1.2, yt-dlp
2026.08.19, deno 2.9.5, uv 0.11.19, node 24.14.0 (`vox doctor --quick`).

## Plan summary
1. Study what the in-app clipper does (`workflows/clipper.md`, `stylize.md`, `stylize.ts`, `checkpoints.ts`)
   and which `vox` commands cover each tool: `get_transcript` (no CLI command: project files + `jq`),
   `get_template` (the template's `template.json`), write tools (`vox op`), `search_images`/`fetch_image`/
   `cutout` (`vox assets`), `view_frames` (`vox frames`), `check_audio` (`vox audio-qa`).
2. Run the whole chain by hand with the real CLI on the owner's test video, learning each gotcha.
3. Write `.claude/skills/vox-studio/SKILL.md` from what worked.
4. Test first for what can be checked: every command, flag, op name, template and file the skill names
   exists (`packages/agent/test/skill.test.ts`, `pnpm -C packages/agent test -- skill`).

## Checklist
- [x] A1 Manual run of the skill steps with real `vox ... --json` commands (see "Manual run" below)
- [x] A2 `.claude/skills/vox-studio/SKILL.md` (nine steps, six checkpoints, rules, report format)
- [x] A3 `packages/agent/test/skill.test.ts` (9 tests)
- [x] A4 Self-review
- [x] A5 Verify, merge

## Files created / changed
- `.claude/skills/vox-studio/SKILL.md` (new). The root checkout lists `.claude/` in `.git/info/exclude`
  (local only, not in `.gitignore`), so the file was added with `git add -f`; clones get it tracked.
- `packages/agent/test/skill.test.ts` (new).
- No change to the CLI, the engine or the workflow files (the skill reads the workflow files, it does not copy them).

## Manual run (stand-in for the MANUAL STEP; D-49 owner delegation)
The headless `claude -p` login is expired, so I could not start the skill inside Claude Code. I followed
SKILL.md myself, step by step, with the real commands on https://www.youtube.com/watch?v=rtcMRI3ARck, in a
scratch projects folder (`--projects-dir`), `--actor agent` and one `--run-id` per clip. Not run by Claude
Code's skill loader, so "Claude Code reads the skill and picks the commands itself" is not proven here.

| Step | What ran | Result |
|---|---|---|
| 1 ranges | `vox quick '<url>' --count 3 --length 30-60 --json` | 4 min 50 s; 3 clips (37.5 s, 46.6 s, 31.5 s), heuristic scorer, 558 candidates, captions on |
| 2 tighten | `removePauses` dry run, then applied | clip 1: 9 pauses cut (37.5 s to 32.4 s); clip 2: 38.9 s; clip 3: 22.8 s (below the 30 s floor after tightening; the user asked for tight) |
| 3 style | `updateSequence styleId vox`, `setCaptions vox/mono-box` | ok x3 |
| 4 storyboard | jq recipe for sequence-time words; `batch` of `addScene` on `V2`: 7 + 7 + 4 scenes (`vox/stat`, `vox/kinetic-serif`, `vox/paper-collage`) | ok; one stat `line2` too long (wrapped), shortened with `updateScene` |
| 5 fill | `assets search`/`fetch`/`cutout`: CC0 gold coins (`Two 20kr gold coins`), CC0 market vendor; rembg cutouts 42 s and 25 s | 2 cutouts reused across clips; one search ("handshake charity donation") returned nothing, not needed |
| 6 transitions | `setTransition vox/paper-tear` 500 ms into collage scenes, none at clip edges | ok |
| 7 review | `vox frames` at scene midpoints, tiled into one sheet, read the sheet | text fits, slots filled; collage sits a little low (note) |
| 8 sound | `vox audio-qa --seq` | first pass FAIL `sfxUnderSpeech` on all 3 clips (margins 0.73, -1.22, -0.78 LU; limit 6); muted the `reveal` cue on the kinetic-serif scenes with `updateScene sfxOff`; second pass PASS (5 of 5 checks) on all 3 |
| 9 deliver | `vox render --all --quality draft --out-dir` | 3 MP4 (32.4 s, 38.9 s, 22.8 s), 5 min 9 s under load; `--out-dir` must exist (first call failed with `EXPORT_PATH` after rendering) |

Checkpoints per clip: ranges met, tighten met (applied), storyboard met, fill met, review met, sound met
(after one fix round). Frame review was by eye on tiled stills; audio was not heard, only measured.

Gotchas found and written into SKILL.md: quote URLs (zsh breaks on `?`); `vox audio-qa` refuses `--kit`
with `--seq`; `--out-dir` must exist; `vox frames` returns only paths (no health flags, unlike the in-app
`view_frames`); there is no CLI command for the sequence-time transcript (jq recipe in the skill); `vox
--help --json` prints the plain usage text and exits 2 (the test reads both streams).

## Verify results
| Command | Result | Numbers |
|---|---|---|
| `pnpm -C packages/agent test -- skill` | pass | 9 passed, 0 failed |
| `pnpm lint` | pass | eslint + prettier clean |
| `pnpm -C packages/agent typecheck` | pass | |
| `pnpm test` (before merging main) | 2491 passed, 1 skipped | first run 4 failed: 3 local-model tests killed with exit 143 and `framing-provider.local` under load average 28; re-run alone: 4 of 4 passed |
| `pnpm test` (after merging main) | 2498 passed, 1 skipped, 1 failed | `history/cursor.test.ts` "undo depth is 500 entries" timed out at 60 s under load average 15 to 28; re-run alone: 7 of 7 passed. `pnpm lint` clean |
| MANUAL STEP | stand-in done (above) | |

## Done when
- [x] Skill runs the clipper end to end via the CLI (agent done-when 5, part 2): the manual run above went
  from a URL to 3 rendered, QA-passing clips with only `vox ... --json` commands and file reads.
- [x] SKILL.md commands exist in `vox --help --json` (`skill.test.ts`).

## Deviations
- The manual step was done by me following SKILL.md, not inside Claude Code (login expired). See D-63.

## MANUAL STEPS
1. (optional; does not block merge) In Claude Code at the repo root, type "make 3 vox clips from
   https://www.youtube.com/watch?v=rtcMRI3ARck" with the skill, paste the run summary here.

## Review (self-review (token budget); focus code-reviewer, typescript-reviewer, security)
- Skill: no key or token handling, no `rm`, writes only through `vox`; destructive undo only per run id. OK.
- Fixed: the jq recipe needs the project folder as cwd (sentence added).
- Test: reads the CLI help once; the template check ignores file paths (`styles/vox/guide.md`).
- Open (low): the skill cannot use `vox agent` or workflow `screenplay` (14b adds it; the skill covers clipper
  and stylize only). The tests cannot prove the model follows the text; only the manual run does.

## Handoff notes
- `vox frames` gives no frame-health flags; the skill reviews by eye. A later `--health` flag would match the
  in-app tool.
- A CLI command for the sequence-time transcript (what `get_transcript` returns) would replace the jq recipe.
- 14b: add a screenplay section to the skill when `vox agent --workflow screenplay` lands.
