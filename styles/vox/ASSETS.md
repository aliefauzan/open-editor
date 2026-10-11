# Assets of the `vox` style: sources and licences

Early package A1 (plan D-19). Phase 07 extends this file with anything it adds. Also recorded in
`plan/ref/R5-pins.md`. Network access used: github.com (Google Fonts repository), naturalearthdata.com,
npm registry, commons.wikimedia.org, with User-Agent `VoxStudio-assets/0.0 (https://github.com/aliefauzan/open-editor)`.

## Fonts (`assets/fonts/`)

See `assets/fonts/SOURCES.md` (per-file upstream path, SHA-256, licence text). All SIL OFL 1.1. Display
font kept: DM Serif Display (phase 07 rendered both on `kinetic-serif` and `stat`; Libre Caslon Display was too light next to the reference and was removed).

## Geo (`assets/geo/countries-50m.json`)

- Natural Earth 1:50m Admin 0 countries (public domain, <https://www.naturalearthdata.com/downloads/50m-cultural-vectors/>),
  as the TopoJSON redistribution `world-atlas@2.0.2` (npm, ISC for the packaging; the data is Natural Earth
  version 4.1.0), file `countries-50m.json`, unmodified. npm tarball SHA-256
  `032e7765f2ce00edaeafec23ff22bc3b77e42987c257da944cc585b452c05b97`; file SHA-256
  `04342cdc1e3016bcd7db1630de95684d67b79fe3c8c460321e87aef469502394`.
- Objects: `countries` (241 polygons, numeric ISO id, `properties.name`) and `land`. Quantised,
  spherical coordinates (decimal degrees), not projected.
- Natural Earth credit (courtesy, not required): "Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com."
  The `world-atlas` ISC licence text: Copyright 2013-2019 Michael Bostock, permission to use, copy, modify and distribute with
  the copyright notice (full text in the npm package `LICENSE`).

## Texture (`assets/textures/paper.jpg`)

- Source: "Papier aquarelle 100% coton, grain fin.png" by Les.aqua, Wikimedia Commons,
  <https://commons.wikimedia.org/wiki/File:Papier_aquarelle_100%25_coton,_grain_fin.png>, licence CC0 1.0
  (public domain dedication). Source file SHA-256 `b8e321c7c8ad5a016c1646fdaad354e4de4958106d8768c7ebf0a445dcd00a6a`
  (1359x1433 PNG).
- Change: centre crop 1024x1024 (offset 167,204), JPEG quality `-q:v 3` with ffmpeg (about 190 kB).
  Output SHA-256 `84c862e77d61309ab9015bf5bd0358799c5ab0ad4af9c04ab54905f0cefc2b15`.
- It is a warm grey watercolour-paper grain, not the `#EDE8DF` paper colour; phase 07 tints or blends it
  (for example `multiply` over `colors.paper`). It does not tile seamlessly.
- Other CC0 candidates looked at and not used: "Pergament.1.jpg" (blotchy parchment), "Old Paper texture.jpg"
  (AI-generated, so unclear status).

## Film grain (`assets/textures/grain-trix400.jpg`, GATE 3 round 2)

- Source: "Tri-x 400 grain2.jpg" by Wiley.andrew.r, Wikimedia Commons,
  <https://commons.wikimedia.org/wiki/File:Tri-x_400_grain2.jpg>, licence CC0 1.0. A real scan of Kodak Tri-X 400
  film grain. Source file SHA-256 `3022ddf4cb74af915ce4977e8b9eccc7b89f4fb88094c0997b2eafe88752fdd8` (5642x3671 grey).
- Change: crop 384x384 at (2400,1500), contrast stretched around the mean so mid grey is neutral in `overlay`
  blend (`lutyuv=y='clip((val-121)*4+128,0,255)'`), grey JPEG `-q:v 6` (about 42 kB).
  Output SHA-256 `b3f4bd8c622cb6b3827a869057bec1076d4c80e71d8a6bce8e9694b200a71345`.
- Used by `overlays/film-look.html`, inlined as a data URL by `scripts/sync-vox-inline.mjs` (the token contract
  only carries the paper texture).

## SFX (`assets/sfx/`)

Accepted in phase 07 (five files; `typewriter` removed), see `assets/sfx/CREDITS.md`.

## Vendored code (`templates/map-route/vendor/`)

`d3-geo@3.1.1` and `topojson-client@3.1.0`, ISC, bundled as ESM with `esbuild@0.25.10`; see
`templates/map-route/vendor/LICENSES.md` for versions, hashes and licence texts.
