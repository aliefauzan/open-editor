# R5 — Pinned versions and licences

Exact versions only. "TBD (phase NN)" means that phase picks and records it. A pin changes only when
that component's contract tests pass on the new version (engine "Testing": HyperFrames contract tests).
When a phase fills a row, it also updates the spec if the spec names a version.

## JavaScript

| Component | Pin | Licence | Set in | Notes |
|---|---|---|---|---|
| Node (dev) | 24.14.0 (`.nvmrc`) | MIT | 00 | |
| pnpm | 12.0.0 | MIT | 00 | `packageManager` field |
| TypeScript | 6.0.3 | Apache-2.0 | 00 | exact; typescript-eslint 8.71 supports `<6.1`, so TS 7 is not used yet |
| vitest | 5.0.3 | MIT | 00 | tiers by file name: `*.slow.test.ts` (`VOX_SLOW=1`), `*.local.test.ts` (never on CI) |
| ESLint, `@eslint/js`, typescript-eslint, eslint-config-prettier | 10.12.0, 10.0.1, 8.71.1, 10.1.8 | MIT / BSD-2 / Apache-2.0 | 00 | flat config `eslint.config.js` |
| Prettier | 3.9.10 | MIT | 00 | |
| `hyperframes` CLI + `@hyperframes/player` | 0.8.145 (exact; confirmed by GATE 1, D-29) | Apache-2.0 | 01 | player needs `sandbox-origin="opaque"`; `--strict-all` is a `render` flag, lint has `--json` only |
| GSAP | 3.15.0 (exact; vendored into builds) | GSAP standard licence (free, incl. commercial) | 01 | licence: `gsap/package.json` `license` field → https://gsap.com/standard-license (no licence file in the package) |
| Electron | 44.7.0 (exact; Chromium 152.0.7977.130) | MIT | 01 | same version in spike and app |
| electron-vite | not used (D-36) | MIT | 08 | peer vite ^5–7; the app builds with `scripts/build.ts` on vite 8.3.4 |
| electron-builder | 26.15.3 (exact, `apps/desktop`) | MIT | 08 | skeleton ad-hoc signed arm64 `.dmg` (D-36); phase 09 extends |
| React, react-dom | 19.3.0 (exact, `apps/desktop` devDependencies; `@types/react`, `@types/react-dom` 19.3.0) | MIT | 08 (early U1, D-19) | GATE 4 bench prototype; phase 08 keeps or bumps it for the app |
| Zustand | 5.0.15 (exact) | MIT | 08 | renderer store (D-36) |
| Tailwind CSS, `@tailwindcss/vite` | 4.3.3, 4.3.3 (exact) | MIT | 08 | |
| `@playwright/test` | 1.64.0 (exact, same as `playwright`) | Apache-2.0 | 08 | Electron E2E runner (D-36) |
| shadcn/ui | not used | MIT | 10a | the editor uses plain Tailwind components (D-42) |
| `@testing-library/react`, `@testing-library/dom`, jsdom | 16.3.3, 10.4.2, 30.1.2 (exact, `apps/desktop` devDependencies) | MIT | 10a | component tests (`// @vitest-environment jsdom` per file) |
| `@xzdarcy/react-timeline-editor` | 1.0.0 (exact, `apps/desktop`; candidate until GATE 4 is recorded) | MIT | 08 (early U1, D-19) | dropped if GATE 4 fails; bench `docs/evidence/phase-08/A1-timeline-bench.json` |
| zod | 4.6.5 (exact, `packages/agent`, `packages/engine`) | MIT | 11 (early N1, D-22); 04 (early E4) | Apple helper protocol schemas; `z.int()` limits are safe integers; engine: detections and shot list schemas |
| ajv | 8.20.0 (exact, `packages/engine`) | MIT | 04 (early E4) | `ajv/dist/2020.js`; test-only use: zod ↔ Python JSON Schema agreement (`py/tests/schemas/`) |
| `ai` (Vercel AI SDK) | 7.0.137 (exact, `packages/agent`) | Apache-2.0 | 11 (early G2) | `MockLanguageModelV4` from `ai/test`; pulls `@ai-sdk/gateway`, `@ai-sdk/provider-utils` 5.0.58, `@vercel/oidc`, `@workflow/serde` (Apache-2.0) |
| `@openrouter/ai-sdk-provider` | 3.1.0 (exact) | Apache-2.0 | 11 (early G2) | used with `compatibility: "strict"` and usage accounting |
| `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google` | 4.0.78, 4.0.91, 4.0.93 (exact) | Apache-2.0 | 11 (early G2) | all share `@ai-sdk/provider` 4.0.26 |
| `ollama-ai-provider-v2` | 4.0.1 (exact) | Apache-2.0 | 11 (early G2) | `num_ctx` forced by a middleware |
| `@ai-sdk/openai-compatible` | 3.0.67 (exact) | Apache-2.0 | 11 (early G2) | |
| `@ai-sdk/provider` | 4.0.26 (exact, direct dep for the `LanguageModelV4` types) | Apache-2.0 | 11 (early G2) | transitive: `json-schema` (AFL-2.1 OR BSD-3-Clause), `eventsource-parser`, `@standard-schema/spec` (MIT) |
| `d3-geo`, `topojson-client` | `d3-geo@3.1.1` (with `d3-array@3.2.4`, `internmap@2.0.3` inlined), `topojson-client@3.1.0`; bundled with `esbuild@0.25.10` (one file each, not minified) | ISC (d3-geo also carries GeographicLib MIT text) | 07 (vendored early by A1, D-19) | `styles/vox/templates/map-route/vendor/{d3-geo,topojson-client}.mjs` + `LICENSES.md` (tarball and file SHA-256); hooks are self-contained |
| OpenCode Zen, 9router, LM Studio presets | no package (`@ai-sdk/openai-compatible` with a base URL) | — | 11 | base URLs in the agent spec presets table |
| Playwright | 1.64.0 (exact, `apps/desktop`; Chromium 156.0.8078.4, browser revision 1248) | Apache-2.0 | 08 (early U1, D-19) | GATE 4 bench driver (headless shell); Electron E2E (first used by the 08 smoke test, D-16) |
| vite | 8.3.4 (exact, `apps/desktop`) | MIT | 08 (early U1, D-19) | builds the GATE 4 prototype and the app (`scripts/build.ts`, D-36) |

## External tools (first-run setup, phase 09; dev uses PATH)

| Tool | Pin | Licence | Hash source |
|---|---|---|---|
| uv | 0.11.19 (matches the dev lockfile writer); arm64 archive <https://github.com/astral-sh/uv/releases/download/0.11.19/uv-aarch64-apple-darwin.tar.gz> SHA-256 `d8f59c38e8c4168ee468d423cd63184be12fa6995a4283d41ee1a14d003c9453` (20810636 bytes) | MIT / Apache-2.0 | bundled; pins in `apps/desktop/src/engine-host/setup/manifest.json` (S1, D-19) |
| ffmpeg / ffprobe | Homebrew's current version (D-05); `vox doctor` records the version it ran with | LGPL/GPL (external binary, not redistributed) | Homebrew's own checks; the app never downloads it |
| yt-dlp + `yt-dlp-ejs` | latest at install; `yt-dlp -U` | Unlicense | yt-dlp verifies its own releases; the build must support `--impersonate` (TikTok, D-13; `vox doctor` checks it) |
| deno | 2.9.5; arm64 archive <https://github.com/denoland/deno/releases/download/v2.9.5/deno-aarch64-apple-darwin.zip> SHA-256 `b796aadd131f6930560c1ee040cf0d6f53933fbb987464e9ff46bd7ea4830615` (38511993 bytes) | MIT | SHA-256 (manifest.json) |
| Chrome for HyperFrames | the one the pinned HyperFrames CLI installs (0.8.145: chrome-headless-shell 152.0.7977.30) | BSD + others | HyperFrames' installer |

## Native (Swift)

| Component | Pin | Licence | Set in | Notes |
|---|---|---|---|---|
| Swift toolchain (Xcode or command-line tools) | any macOS 26+ SDK; built and tested with Swift 6.4, Xcode 27.0, macOS 27.0 SDK on the M5 | Apple SDK licence | 11 (early N1, D-22) | builds `native/apple-llm` (tools 6.0, Swift 6 mode, `.macOS(.v14)`); `local` tier, never on CI (D-16) |
| Apple Foundation Models framework | system framework, macOS 26+ | Apple SDK licence | 11 (early N1, D-22) | needs Apple Intelligence on; not redistributed; weak-linked (`-weak_framework`) so the helper starts on macOS 14/15; context 8,192 tokens on macOS 27 (4,096 before) |

## Python (`py/uv.lock`)

| Package / model | Pin | Licence | Set in |
|---|---|---|---|
| Python | 3.12.x (00: `py/.python-version` 3.12; resolved 3.12.13 on the M5; hatchling + pytest 9.1.1 + ruff 0.17.0 in `py/uv.lock`) | PSF | 00/04 |
| mlx-whisper + `mlx-community/whisper-large-v3-turbo` (revision hash) | mlx-whisper 0.4.3; revision `a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb`; `weights.safetensors` SHA-256 `951ed3fc1203e6a62467abb2144a96ce7eafca8fa77e3704fdb8635ff3e7f8a6` (checked each run; pulls torch 2.14.1) | MIT | 04 |
| mediapipe + full-range face detector `.tflite` (URL + SHA-256) | mediapipe 1.0.0 (1.0.1 aborts in FaceDetector, D-21); <https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite> SHA-256 `3698b18f063835bc609069ef052228fbe86d9c9a6dc8dcb7c7c2d69aed2b181b` | Apache-2.0 | 04 |
| rembg + permissive model (never `bria-rmbg`) | rembg 2.0.85; `u2net.onnx` <https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx> SHA-256 `8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491` (licences quoted in `log/phase-05.md`) | MIT + Apache-2.0 (U^2-Net) | 05 |
| opentimelineio | 0.18.1 | Apache-2.0 | 05 |
| pypdf (document text) | 6.19.0 | BSD-3-Clause | 04 |
| onnxruntime (Silero VAD speech gate; no torch, D-15) | 1.30.0 | MIT | 04 |
| Silero VAD `silero_vad.onnx`, vendored at `py/vox_py/models/` with its licence (upstream release URL + SHA-256, D-15) | v6.2.3, commit `5cd7945676eb32225748052e2e6a0580e4686a08`, <https://github.com/snakers4/silero-vad/blob/v6.2.3/src/silero_vad/data/silero_vad.onnx>; SHA-256 `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3` | MIT | 04 |
| numpy (audio QA analysis; `qa.png` and the kit sheet drawn with numpy and written with `zlib`, no Pillow, D-27) | 2.5.3 (exact in `py/pyproject.toml`; already in `py/uv.lock` for onnxruntime and mediapipe) | BSD-3-Clause | 05 (set early, p2-audioqa) |
| `otio-fcpx-xml-adapter` | TBD (05 if GATE 2 needs it, else 14) | Apache-2.0 | 05 / 14 |
| mflux + Z-Image-Turbo | TBD (14) | MIT + Apache-2.0 | 14 |
| `pyobjc-framework-Vision` (facetrack body + saliency fallback in v1; Part C OCR reuses it, D-15) | 12.2.2 | MIT | 04 |
| cryptography (pypdf AES-encrypted PDFs) | 50.0.1 | Apache-2.0 OR BSD-3-Clause | 04 |
| jsonschema (dev only: pytest schema checks) | 4.26.0 | MIT | 04 |

## Assets

| Asset | Source | Licence | Set in |
|---|---|---|---|
| Natural Earth 1:50m countries + populated places | countries: `world-atlas@2.0.2` `countries-50m.json` (NE 4.1.0 as TopoJSON, 241 countries, 739 kB, SHA-256 `04342cdc1e3016bcd7db1630de95684d67b79fe3c8c460321e87aef469502394`) in `styles/vox/assets/geo/`; places: `https://naciscdn.org/naturalearth/10m/cultural/ne_10m_populated_places_simple.zip` v5.1.2 (zip SHA-256 `2963ee08f7743f13f37d5243acd77a2f7a510e26a36c7e04b920f1b381f2b251`) → `packages/engine/data/places.json` (518 kB, 7342 places); see `packages/engine/data/NOTICE.md`, `styles/vox/ASSETS.md` | public domain (world-atlas packaging ISC) | 03 (geo search), 07 (map); data added early by A1 (D-19) |
| Test portraits `face-a.jpg`, `face-b.jpg` (checked-in fixtures) | Wikimedia Commons, CC0 only, URL recorded in `fixtures/assets/LICENSES.md` | CC0 | 00 |
| Test SFX `fixtures/assets/sfx/tap.wav` (checked-in fixture, `base` tests) | Wikimedia Commons, CC0 or public domain, fetched with the portraits, URL in `fixtures/assets/LICENSES.md` (D-16) | CC0 / PD | 00 |
| Fonts `base`: Inter (display, body), IBM Plex Mono (captions) | github.com/google/fonts commit `bd8f81ddb5c74d5c8897b36ad88b440266245103`, `ofl/inter` (variable TTF), `ofl/ibmplexmono` (Regular, Bold TTF); hashes in `styles/base/assets/fonts/SOURCES.md` | OFL 1.1 (texts `OFL-*.txt` beside the files) | 03 (files added early by A1, D-19; `style.json` entries are phase 03) |
| Fonts (`vox`: display, body, caption; ~40 OFL catalogue for Part C) | same Google Fonts commit: Libre Caslon Display + DM Serif Display (both display candidates; phase 07 keeps one), Libre Caslon Text (variable), IBM Plex Mono Regular + Bold; hashes in `styles/vox/assets/fonts/SOURCES.md` | OFL 1.1 | 07 (files added early by A1), 15 |
| Paper texture | Wikimedia Commons "Papier aquarelle 100% coton, grain fin.png" by Les.aqua, `https://commons.wikimedia.org/wiki/File:Papier_aquarelle_100%25_coton,_grain_fin.png`; cropped 1024x1024 JPEG `styles/vox/assets/textures/paper.jpg` (190 kB); details in `styles/vox/ASSETS.md` | CC0 | 07 (added early by A1) |
| SFX `paper-pop`, `paper-slide`, `whoosh`, `stamp`, `typewriter`, `thump-tap` (hero) | real recordings only: CC0 / public domain from Wikimedia Commons first (URL recorded), Freesound only if the owner downloads it, or recorded for the project (licence `project`); never synthesised (D-14, D-16); listed in `style.json` `sfx` and `styles/vox/assets/sfx/CREDITS.md` | CC0 / project | 07 (6 candidates added early by A1; acceptance is phase 07 + kit check; weakest: `whoosh`, `typewriter`, `thump-tap`, see CREDITS.md) |
