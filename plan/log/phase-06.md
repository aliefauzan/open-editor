# Phase 06 — Style tooling (Part A rest)

Status: [x] done 2026-10-11 (single agent, worktree `.worktrees/phase-06`, branch
`phase/06-style-tooling`; owner asked to cut token cost: no subagents, self-review)

## Pre-check
Prereq 03 [x] (D-30). No early steps (D-19) for 06. 05 is [~] waiting GATE 2, unmerged: 06 does not use
its code (no `audio-qa --kit`; SFX kit rules join `validate` in 07).

## Plan summary
1. Engine `src/styles/manage.ts`: `newStyle` (scaffold, rejects built-in/existing ids), trust store
   (`<voxHome>/trust.json`, id + content hash of the style folder), `accept`, `remove` (non-built-in).
2. Compile: `migrate(variables, fromVersion)` from trusted `build.mjs` on a major mismatch; untrusted
   → `HOOK_UNTRUSTED`.
3. `src/styles/validate.ts`: schema, static rules (text `maxLength`, reserved `skipEntrance`,
   `minEntranceMs`, hook source + import check, hook determinism, missing assets, SFX credits),
   one render of every fixture (lint + `--strict-all` draft), Chrome DOM checks (safe area of the
   longest text fixture, `minEntranceMs` resting state, caption presets), cue timing (per-frame pixel
   difference), previews (contact sheet, thumbnail + GIF per template).
4. CLI `vox style validate|new|trust|accept|remove`; `engine.styles.accept/remove`.
5. `styles/base/previews/` generated; R2 style + caption preset formats frozen.
Test order: new/trust/remove → migrate → hook static + determinism → static rules → caption preset
schema → safe area → minEntranceMs → caption checks → cue timing + credits → validate base (CLI).

## Checklist
- [x] 1 `vox style new` + template identity through a chain — `test/styles/manage.test.ts`
- [x] 2 `TEMPLATE_VERSION` migration (S8 `migrate`) — `test/compile/migrate.test.ts`
- [x] 3 hook purity (determinism + static check + self-contained imports) — `test/styles/hookcheck.test.ts`
- [x] 4 safe-area check (longest text fixture, DOM boxes) — `validate.slow.test.ts` (`vunsafe/low`)
- [x] 5 `validate base` passes and writes previews; `new` + `trust` + `remove` round trip —
      CLI verify, `packages/cli/test/style.test.ts`, `manage.test.ts`
- [x] 5b `minEntranceMs` in validate (1500 / 3000 ms; `skipEntrance` rule named) — `validate.slow.test.ts`,
      `validate.test.ts`
- [x] 5c caption presets in validate (no `.json`, bad `case`; one contact cell per preset at 600 ms,
      inside word 2; states, emphasis, seek, safe area at default `yPct` and 95) — both validate tests
- [x] 6 cue timing and credits in validate — `validate.test.ts` (credits, synthetic frames),
      `validate.slow.test.ts` (`vlate` 4 frames late fails, `vgood` passes)
- [x] `styles/base/previews/` generated (contact sheet, JPEG + GIF per template and transition)

## What was built
- `engine/src/styles/manage.ts` (new, accept, remove, trust store, code hash), `hookcheck.ts`,
  `validate.ts`, `validate-dom.ts` (Chrome harness via HyperFrames' puppeteer-core and Chrome),
  `cue-timing.ts`; compile `runMigrate` + `placedVariables`.
- `Engine.styles.create/accept/remove/trust/validate`; `EngineOptions.trustFile`.
- CLI `vox style validate <id> [--no-render] [--no-dom] | new <id> [--extends] [--name] |
  trust <id> [--yes] | accept <id> | remove <id>`; the CLI passes `<VOX_HOME>/trust.json`.
- `base/title` and `base/text-overlay` side margins widened so text stays in the safe area
  (compile snapshots updated: margin lines only).
- Test styles `test/fixtures/styles/validate/` (README) and `tooling/`.

## Decisions
- D-34: trust store, `new` scaffold, migrate, hook import scope, scene safe area, validation project,
  `minEntranceMs` durations, cue thresholds, caption word `data-key` (spec edit), previews, credits.
- R2: style format and caption preset format rows marked frozen 2026-10-11.

## Review
Step 7: self-review (owner asked to cut token cost). Checked: `remove` only deletes a folder found by
`readdir` in a non-built-in styles folder (no path built from the id); a copied folder cannot trust
itself (trust lives in `trust.json`, keyed by a code hash); hooks of untrusted styles are never
imported (migrate, determinism); text output strips control characters; no personal paths or secrets
in fixtures. Fixed in review: `STYLE_NOT_FOUND` hint named a `vox style list` command that does not
exist; the `minEntranceMs` "entrance never runs" message wording. Known limit: `remove` checks children
among styles that load; a broken child that extends the style is not counted.

## Verify (2026-10-11)
- `pnpm -C packages/engine test -- styles`: 8 files, 172 tests passed.
- `pnpm -C packages/cli exec vox style validate base --json`: exit 0, `ok: true`, 0 problems, 22.3 s;
  checks: lint 1, render 1, blank-frame 8, safe-area 3, min-entrance 2, caption-preset 1,
  caption-safe-area 2, caption-states 1; wrote `styles/base/previews/` (contact.jpg + 5 JPEG/GIF pairs).
- Fast suite (`pnpm exec vitest run`): 116 files, 1669 passed, 1 skipped. (Under `npx`, the yt-dlp proxy
  env test sees `npm_config_noproxy` from npx itself; it passes under pnpm.)
- Slow (`VOX_SLOW=1`, styles + compile): 5 files, 15 tests passed (`validate.slow.test.ts` ~40 s).
- `pnpm lint` and `pnpm typecheck` clean. No Python changed (pytest not needed).

## Handoff
- 07: `vox style validate vox` runs every check here; add the SFX kit rules (05 `audio-qa --kit`) once
  05 merges. Caption presets must put `data-key` on word elements. Scene text must stay inside the
  default preset's safe area (12 % sides on 9:16).
- 05 merge: `packages/cli/src/main.ts` gains a `style` command, `voxHomeOf` and `trustFile`
  (small hunks near USAGE, OPTIONS, `stylesDirs`, `engineFor` and the end of `command`).
- 08/10a: `Engine.styles.trust` needs `trustFile`; the app should open the engine with
  `<VOX_HOME>/trust.json` and confirm before trusting.
