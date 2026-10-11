# Phase 14g — FCPXML export

| Field | Value |
|---|---|
| Status | done (merged) |
| Started · Finished | 2026-10-12 05:45 · 2026-10-12 |
| Model | Sonnet 5.5 · high |
| Machine | M5, macOS 27; seven other phase agents ran at the same time (CPU load; full suite 174 s) |
| Branch | phase/14g-fcpxml-export (worktree `.worktrees/phase-14g`) |

## Pre-check
Prerequisite 13 merged on main (ee82856, D-60). GATE 2 did not need FCPXML (D-39), so phase 05 built no FCPXML engine side: 14g builds both the engine side and the dialog option. Review: self-review (token budget). Owner delegation (D-49, D-58): the "import in Final Cut Pro or Resolve" check is done by the AI with an automated stand-in, recorded as "not imported in an NLE" (neither app is installed).

## Plan summary
1. `py/vox_py/timeline.py`: `format` fcpxml, `width`/`height`, `mediaDurationFrames`; adapter output normalised (`_write_fcpxml`).
2. `exportTimeline` job arg `format`; layer folder `<name>-fcpxml-layers`; CLI `--format`; dialog checkbox.
3. `scripts/fcpxml-check.py`: DTD + structure stand-in for the import.
4. Tests first: pytest (timeline fcpxml write, checker positive and negative cases), engine `export/fcpxml.test.ts` (fake HyperFrames), CLI usage + export, dialog test.

## Checklist
- [x] adapter pinned (`otio-fcpx-xml-adapter==1.0.0`, `uv.lock`), R5 pin filled
- [x] py writer + request schema + pytest (`py/tests/test_timeline.py`)
- [x] checker script + pytest (`py/tests/test_fcpxml_check.py`: valid, missing file, bad ref, spine gap, wrong duration, entity refused, DTD rejects a foreign element)
- [x] engine job `format`, layer folder naming, both formats in one folder
- [x] CLI `--format otio|fcpxml`, usage error on `--format edl`
- [x] export dialog option + component test
- [x] UI gate screenshot (`docs/evidence/phase-14g/export-dialog.jpg`), no HIGH finding
- [x] review, verify, merge

## Files created / changed
- `py/vox_py/timeline.py`, `py/tests/schemas/timeline.request.json`, `py/pyproject.toml`, `py/uv.lock`, `py/tests/test_timeline.py`, `py/tests/test_fcpxml_check.py`, `scripts/fcpxml-check.py`.
- `packages/engine/src/export-api.ts` (`format`, `mediaDurationFrames`, layer folder name), `packages/engine/test/export/fcpxml.test.ts`.
- `packages/cli/src/main.ts`, `packages/cli/test/export.test.ts`.
- `apps/desktop/src/renderer/editor/ExportDialog.tsx`, `apps/desktop/test/renderer/export.test.tsx`.
- Docs on main: engine spec, app spec, R5, DECISIONS (D-64), `docs/evidence/phase-14g/`.

## Verify results
| Command | Result |
|---|---|
| `pnpm -C packages/engine test -- export/fcpxml` | 3 passed (writes `.fcpxml` + `-fcpxml-layers/`, check passes incl. DTD, second export `(2)`, both formats in one folder, default stays OTIO, `edl` refused) |
| root `pnpm test` (after `git merge main`) | 204 files, 2494 passed, 1 skipped, 0 failed (174 s) |
| `uv run --project py pytest py` (fixtures from `make.sh`) | 151 passed |
| `rtk proxy pnpm lint`, `pnpm typecheck`, `uv run ruff check` | clean |
| Real export through the engine job (fake HyperFrames layers), `scripts/fcpxml-check.py` | DTD valid, 1 spine clip, 4 clip refs (3 video, 1 audio), 3 assets, 3.0 s, 0 problems (`docs/evidence/phase-14g/fcpxml-check.json`) |
| App slow suite `editor-b-ui` (built app) | passes; the 11 failures of the slow run are `packaging` and `clean-install` needing `pnpm dist` (not built in the worktree), unrelated |

## Done when
- [x] FCPXML export works from the CLI (`--format fcpxml`) and the export dialog; tests above.
- [~] "Imports in Final Cut Pro or Resolve": **not imported in an NLE** (neither installed). Stand-in by owner delegation: DTD validation against Apple's FCPXML 1.8 DTD plus the structure check; the output passes both. Open optional owner item in TODO (real import, screenshot).

## Deviations
D-64 (design, adapter fixes, check stand-in). The DTD is not committed (Apple copyright); the DTD part of the tests runs when `~/.cache/vox-studio/FCPXMLv1_8.dtd` or `VOX_FCPXML_DTD` exists (`--fetch-dtd` once), else only that part is skipped.

## Review (self-review, token budget)
Focus: paths and XML. Output paths are absolute-only (`_file_url`), the extension must match `format`, XML is written by `ElementTree` (escaping), the checker refuses `<!ENTITY` before parsing (no entity expansion), no network at test time. No CRITICAL or HIGH finding. Listed: the adapter's audio `gap` duration is longer than its parent clip; transitions and effects are not written by the adapter.

## MANUAL STEPS
1. (optional, does not block; no FCP or Resolve here) import `<name>.fcpxml` in Final Cut Pro or Resolve, with its `<name>-fcpxml-layers/` folder next to it; save a screenshot as `docs/evidence/phase-14g/import.jpg` and report what is wrong. If it is rejected, the AI fixes `_write_fcpxml` (D-64).

## Handoff notes
- Apple's DTD is fetched by `uv run --project py python scripts/fcpxml-check.py <file> --fetch-dtd` into `~/.cache/vox-studio/`; CI without it runs the structure checks only.
- The `py-env` resync rule (D-12) applies: `uv.lock` changed (one new package), so an updated app resyncs on launch.
- `mediaDurationFrames` is optional in the writer request (default: the used part); the engine always passes the whole file length.
