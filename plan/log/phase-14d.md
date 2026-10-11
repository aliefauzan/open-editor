# Phase 14d — Local image generation (mflux)

| Field | Value |
|---|---|
| Status | in progress |
| Started · Finished | 2026-10-12 · — |
| Model | Sonnet 5.5 · high (phase agent, no subagents; self-review (token budget)) |
| Machine | M5, macOS 27, eight phase agents running in parallel (CPU load) |
| Branch | phase/14d-local-imagegen (worktree `.worktrees/phase-14d`) |

## Plan (≤ 15 lines)
1. Python: `mflux==0.22.0` (MIT) pinned in `py/pyproject.toml`, `uv lock`; new tool `vox_py.imagegen`
   with actions `install` (download pinned snapshot, quantize to 8-bit, save, drop the big cache) and
   `generate` (offline, `HF_HUB_OFFLINE=1`). Z-Image-Turbo = `Tongyi-MAI/Z-Image-Turbo` (Apache-2.0,
   not gated); FLUX.1-schnell = optional, needs `HF_TOKEN` (never entered by the agent).
2. Engine: `imagegen.ts` (model table, status, install/remove jobs, `mflux` ImageProvider with `ready()`);
   `assets.generate` picks the newest provider that is ready; CLI `vox imagegen status|install|remove`;
   `vox doctor` explains the FLUX terms and shows the Z-Image state.
3. Desktop: settings toggle "Local image generation" (size + licence confirm before download, progress,
   remove), `imagegen.status|install|remove` over `window.vox`.
4. `pyenv-resync` test: lock hash change (13 → 14d) resyncs once.
Test order: py tool protocol (fake mflux) → engine provider contract (fake mflux) → doctor → CLI →
desktop settings → pyenv-resync → slow real-model test after download.

## Checklist
- [ ] 1 py + lock  - [ ] 2 engine  - [ ] 3 CLI/doctor  - [ ] 4 desktop  - [ ] 5 real model  - [ ] 6 review/verify/merge
