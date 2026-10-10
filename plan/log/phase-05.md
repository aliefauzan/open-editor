# Phase 05 — Engine: assets, render, export, CLI + GATE 2

Status: not started; early steps done under D-19

## Early steps (D-19) — e3-media-export

- **Steps done**: 8c core (export targets, S32): `{ file }` / `{ dir }` / project `renders/`;
  absolute path, existing writable folder, else `EXPORT_PATH`; hidden short temp in the target folder,
  atomic no-replace move (`link` + `unlink`, placeholder + `rename` without hard links); `{ file }`
  needs `overwrite`, `{ dir }` adds ` (2)`, `renders/` adds `-2`; a temp swapped meanwhile is refused;
  failed or cancelled exports leave nothing; temps of a killed engine (this host, pid gone) are swept
  by the next export. Decision: D-25.
- **Files** (branch `early/e3-media-export`): `packages/engine/src/export/target.ts`,
  `src/fs/no-replace.ts`, test `packages/engine/test/export/target.test.ts`.
- **Tests**: 39 (targets, every `EXPORT_PATH` case incl. null and string targets, read-only folder,
  no silent replace, a file appearing mid-export, cancel during a running ffmpeg → `CANCELLED`, ffmpeg
  killed → `TOOL_FAILED`, a SIGKILLed engine process's temp swept, host/pid sweep rules, symlink and
  file swaps of the temp, 255-byte names, `safeStem`). All in the root `pnpm test` (242 passed).
- **Error codes**: `EXPORT_PATH` (new, in the shim), `CANCELLED`.
- **Left for phase 05**: shim → `errors.ts`; render / `exportCaptions` / `exportTimeline` wiring onto
  `writeExport` (pass the signal to ffmpeg via `produce`); OTIO `<name>-layers/` folder; `--all`; CLI
  flags (`--out`, `--overwrite`); the app's save dialog passes `{ file, overwrite: true }`.
- **Branch**: `early/e3-media-export` at a4d3a88, pushed; worktree kept. Merge state: ready, waiting
  for 02 (merge after 02).
