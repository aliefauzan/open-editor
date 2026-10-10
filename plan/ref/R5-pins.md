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
| `hyperframes` CLI + `@hyperframes/player` | 0.8.145 (candidate; confirmed by GATE 1) | Apache-2.0 | 01 | player needs `sandbox-origin="opaque"`; `--strict-all` is a `render` flag, lint has `--json` only |
| GSAP | version bundled with the pinned HyperFrames (vendored) | GSAP standard licence (free, incl. commercial) | 03 | record exact version and licence text location |
| Electron | TBD (01) | MIT | 01 | same version in spike and app |
| electron-vite, electron-builder | TBD (08, 09) | MIT | 08/09 | |
| React | 19.x (exact TBD 08) | MIT | 08 | |
| Zustand, Tailwind, shadcn/ui | TBD (08) | MIT | 08 | |
| `@xzdarcy/react-timeline-editor` | TBD (08, GATE 4) | MIT | 08 | dropped if GATE 4 fails |
| `ai` (Vercel AI SDK) | 7.0.x (exact TBD 11) | Apache-2.0 | 11 | |
| `@openrouter/ai-sdk-provider` | 3.x (exact TBD 11) | Apache-2.0 | 11 | |
| `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google` | 4.x (exact TBD 11) | Apache-2.0 | 11 | |
| `ollama-ai-provider-v2` | 4.x (exact TBD 11) | Apache-2.0 | 11 | |
| `@ai-sdk/openai-compatible` | 3.x (exact TBD 11) | Apache-2.0 | 11 | |
| `d3-geo`, `topojson-client` | `d3-geo@3.1.1` (with `d3-array@3.2.4`, `internmap@2.0.3` inlined), `topojson-client@3.1.0`; bundled with `esbuild@0.25.10` (one file each, not minified) | ISC (d3-geo also carries GeographicLib MIT text) | 07 (vendored early by A1, D-19) | `styles/vox/templates/map-route/vendor/{d3-geo,topojson-client}.mjs` + `LICENSES.md` (tarball and file SHA-256); hooks are self-contained |
| OpenCode Zen, 9router, LM Studio presets | no package (`@ai-sdk/openai-compatible` with a base URL) | — | 11 | base URLs in the agent spec presets table |
| Playwright | TBD (08) | Apache-2.0 | 08 | Electron E2E (first used by the 08 smoke test, D-16) |

## External tools (first-run setup, phase 09; dev uses PATH)

| Tool | Pin | Licence | Hash source |
|---|---|---|---|
| uv | TBD (09) | MIT / Apache-2.0 | bundled |
| ffmpeg / ffprobe | Homebrew's current version (D-05); `vox doctor` records the version it ran with | LGPL/GPL (external binary, not redistributed) | Homebrew's own checks; the app never downloads it |
| yt-dlp + `yt-dlp-ejs` | latest at install; `yt-dlp -U` | Unlicense | yt-dlp verifies its own releases; the build must support `--impersonate` (TikTok, D-13; `vox doctor` checks it) |
| deno | TBD (09) | MIT | SHA-256 |
| Chrome for HyperFrames | the one the pinned HyperFrames CLI installs | BSD + others | HyperFrames' installer |

## Native (Swift)

| Component | Pin | Licence | Set in | Notes |
|---|---|---|---|---|
| Swift toolchain (Xcode or command-line tools) | 26.x or newer (macOS 26+ SDK; the M5 has Xcode 27.0) | Apple SDK licence | 11 | builds `native/apple-llm`; `local` tier, never on CI (D-16) |
| Apple Foundation Models framework | system framework, macOS 26+ | Apple SDK licence | 11 | needs Apple Intelligence on; not redistributed (our helper links it) |

## Python (`py/uv.lock`)

| Package / model | Pin | Licence | Set in |
|---|---|---|---|
| Python | 3.12.x (00: `py/.python-version` 3.12; resolved 3.12.13 on the M5; hatchling + pytest 9.1.1 + ruff 0.17.0 in `py/uv.lock`) | PSF | 00/04 |
| mlx-whisper + `mlx-community/whisper-large-v3-turbo` (revision hash) | TBD (04) | MIT | 04 |
| mediapipe + full-range face detector `.tflite` (URL + SHA-256) | TBD (04) | Apache-2.0 | 04 |
| rembg + permissive model (never `bria-rmbg`) | TBD (05; licence verified and quoted in log) | MIT + model licence | 05 |
| opentimelineio | TBD (05) | Apache-2.0 | 05 |
| pypdf (document text) | TBD (04) | BSD-3-Clause | 04 |
| onnxruntime (Silero VAD speech gate; no torch, D-15) | TBD (04) | MIT | 04 |
| Silero VAD `silero_vad.onnx`, vendored at `py/vox_py/models/` with its licence (upstream release URL + SHA-256, D-15) | TBD (04); SHA-256 filled in by phase 04 | MIT | 04 |
| numpy (audio QA analysis; `qa.png` drawn with ffmpeg `showspectrumpic`/`showwavespic`) | TBD (05) | BSD-3-Clause | 05 |
| `otio-fcpx-xml-adapter` | TBD (05 if GATE 2 needs it, else 14) | Apache-2.0 | 05 / 14 |
| mflux + Z-Image-Turbo | TBD (14) | MIT + Apache-2.0 | 14 |
| `pyobjc-framework-Vision` (facetrack body + saliency fallback in v1; Part C OCR reuses it, D-15) | TBD (04) | MIT | 04 |

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
