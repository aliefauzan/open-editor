# Phase 14d — Local image generation (mflux)

| Field | Value |
|---|---|
| Status | done, merged (see PROGRESS) |
| Started · Finished | 2026-10-12 · 2026-10-12 |
| Model | Sonnet 5.5 · high (phase agent, no subagents; self-review (token budget)) |
| Machine | M5, 24 GB, macOS 27, eight phase agents running in parallel (CPU and network load) |
| Branch | phase/14d-local-imagegen (worktree `.worktrees/phase-14d`) |

## Plan
Python tool + lock → engine provider/jobs → doctor → CLI → desktop toggle → pyenv-resync test → real model → review → verify → merge. Decision: D-68.

## Checklist
- [x] `mflux==0.22.0` in `py/pyproject.toml`, `py/uv.lock` (re-locked after merging 14g's `otio-fcpx-xml-adapter`, `uv lock --check` ok)
- [x] `py/vox_py/imagegen.py` (actions `install`, `generate`), schemas, `py/tests/test_imagegen.py`
- [x] `packages/engine/src/imagegen.ts`: model table, status, providers `mflux` / `mflux-flux1-schnell`, jobs `imagegen.install` / `imagegen.remove`; `ImageProvider.available()` / `disposable`
- [x] `vox doctor` checks `image-z-image-turbo`, `image-flux1-schnell`; CLI `vox imagegen status|install|remove`
- [x] App: `settings.get` → `imagegen`, Settings switch with size + licence confirm, progress, remove
- [x] `test/setup/pyenv-resync.test.ts` (13 lock hash → 14d lock: one sync)
- [x] Real model, offline generate (see "Deviations")

## Files
Engine: `src/imagegen.ts`, `src/assets-api.ts`, `src/api.ts`, `src/doctor.ts`, `src/py.ts` (hints); tests `test/assets/generate.test.ts`, `test/assets/fake-uv-imagegen.mjs`, `test/assets/mflux.slow.test.ts`, `test/doctor.test.ts`. CLI: `src/main.ts`, `test/imagegen.test.ts`. Desktop: `src/shared/api.ts`, `src/engine-host/settings.ts`, `src/engine-host/index.ts`, `src/renderer/Settings.tsx`, `test/settings/imagegen.test.tsx`, `test/setup/pyenv-resync.test.ts`. Py: `vox_py/imagegen.py`, `tests/test_imagegen.py`, `tests/schemas/imagegen.*.json`.

## Verify
- `pnpm test` (worktree, after merging main): 208 files, 2514 passed, 1 skipped, 0 failed. (One earlier run had 4 failures that needed generated fixtures in the worktree; passed once `packages/engine/test/fixtures/out` was present.)
- `pnpm -C packages/engine test -- assets/generate`: 7 passed (fake mflux tool).
- `pnpm -C packages/engine test:slow -- mflux` with `VOX_TOOLS_DIR` pointing at the installed model and a dead `HTTPS_PROXY`: 1 passed, 34 s (576×1024, offline).
- `pnpm -C apps/desktop test -- settings/imagegen pyenv-resync`: 5 + 2 passed.
- py: `uv run pytest` 157 passed (with the fixtures out dir), incl. `test_imagegen.py` 7 (1 real-model local test, 55 s).
- `pnpm lint` clean, `tsc` clean (engine, cli, desktop); `ruff` clean on the new files.
- Real run: `vox assets generate <p> "a paper-cut red teapot…" --provider mflux` → 1080×1920 PNG in 71 s under load (8 agents running). Evidence: `docs/evidence/phase-14d/teapot-zimage-4bit-270w.png` (downscaled).

## Done when
- `vox assets generate` works offline after download: yes (slow test with a dead proxy, plus the CLI run above).
- App toggle works: component tests (size + licence shown before any download, install job and progress, failure hint, remove asks first).
- App built from 13, updated to 14d, resyncs `py-env`: `pyenv-resync` test (lock hash 65bccc65… of 13 vs the 14d lock; exactly one `uv sync --frozen --no-editable`). No packaged `.dmg` update was run (no second build).

## Deviations (D-68)
- The 33 GB official download did not finish: the shared network stalled it repeatedly (22 GB fetched over about two hours, then the owner stopped processes). The real-model checks ran on the pre-quantized mirror `filipstrand/Z-Image-Turbo-mflux-4bit` (5.9 GB, 4-bit) placed in `<tools>/models/mflux/z-image-turbo/` with a `vox-model.json`. So the real `generate` path is verified; the real `install` action (download + 8-bit quantize on a 24 GB Mac, peak memory unknown) is verified only against a fake tool and by code reading. Open owner item below.
- The mirror's card says `tongyi-qianwen-license`, not Apache-2.0, so it is not the product default (D-68).

## MANUAL STEPS (optional, do not block merge)
1. Run `vox imagegen install` once on a machine with a good connection and at least 45 GB free; confirm `vox imagegen status` shows it installed and the 8-bit quantize finished (watch memory; if the 24 GB Mac swaps hard, say so and we switch the default to a 4-bit save).
2. FLUX.1-schnell: accept the terms at huggingface.co/black-forest-labs/FLUX.1-schnell, create a read token, run `HF_TOKEN=<token> vox imagegen install --model flux1-schnell`, then `vox assets generate … --provider mflux-flux1-schnell`. Not run by the AI (no credentials).

## Review (self-review, token budget)
Security: no shell use (argv arrays, JSON on stdin); download folder deleted by the engine only inside `<models>/mflux/`; `HF_` env passes the bridge allow-list, tokens are redacted by the engine redactor; generation sets offline mode before any Hugging Face import; prompt max 2000 chars; output must be a `.png` in an existing folder. No HIGH findings. Rest: install peak RAM on 24 GB unverified (manual step 1); `list()` hides unavailable providers, so an agent started before an install does not see `generate_image` until the next run.

## Handoff
- `py/uv.lock` changed: other phases that touch it must `uv lock`, never hand-merge.
- First-run py-env sync after this update downloads transformers, opencv and others (torch was already there).
- Fixture-dependent tests (`packages/engine/test/fixtures/out`) need `bash packages/engine/test/fixtures/make.sh` in a fresh worktree.
