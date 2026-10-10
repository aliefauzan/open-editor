# Phase 06 — Style tooling (Part A rest)

Status: [~] in progress (2026-10-11, single agent, worktree `.worktrees/phase-06`, branch
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
- [ ] 1 `vox style new` + template identity through a chain
- [ ] 2 `TEMPLATE_VERSION` migration (S8 `migrate`)
- [ ] 3 hook purity (determinism + static check + self-contained imports)
- [ ] 4 safe-area check (longest text fixture, DOM boxes)
- [ ] 5 `validate base` passes and writes previews; `new` + `trust` + `remove` round trip
- [ ] 5b `minEntranceMs` in validate
- [ ] 5c caption presets in validate
- [ ] 6 cue timing and credits in validate
