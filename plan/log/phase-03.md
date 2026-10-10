# Phase 03 — Engine: styles loader, `base` style, compile, captions, audio

Status: not started; early steps done under D-19

## Early steps (D-19) — a1-assets-geo

Package A1 (assets and geo). Branch `early/a1-assets-geo`, **merged to main** (merge commit 1e1f0a5, pushed;
worktree removed). Verify in the worktree before merge: `pnpm typecheck`, `eslint .`, `prettier --check .`,
`vitest run` all green (7 files, 73 tests; 11 of them geo, 25 asset), `uv run --project py pytest` 4 passed.

**Steps done**: 5 (only the font files for `styles/base`), 16 (geo search, data and index; engine wiring left).

**Files**
- `styles/base/assets/fonts/`: `Inter-Variable.ttf` (display, body; variable opsz/wght), `IBMPlexMono-Regular.ttf`,
  `IBMPlexMono-Bold.ttf` (captions), `OFL-Inter.txt`, `OFL-IBMPlexMono.txt`, `SOURCES.md` (upstream path + SHA-256 per file;
  Google Fonts repo commit `bd8f81ddb5c7`). Files are byte-identical to upstream (TTF kept so OFL reserved names
  are not an issue); only the variable font's brackets were dropped from its name.
- `packages/engine/data/places.json` (518 kB, format `vox-places/1`, 7342 Natural Earth 5.1.2 populated places,
  columns `name, aliases, country, iso2, admin1, lat, lon, population, capital`), `build-places.mjs` (rebuild from the
  Natural Earth .dbf, deterministic), `NOTICE.md` (source URL, zip SHA-256, licence).
- `packages/engine/src/geo/search.ts`: pure, imports only `node:fs` (no `errors.ts`, no `api.ts`; a test asserts it).
  Exports `normalise`, `createPlaceIndex(file)`, `searchPlaces(index, query, { limit })`, `search(query, opts)` (default
  lazy index over `data/places.json`), types `Place`, `PlacesFile`. Query rules: case, diacritics and punctuation
  ignored; exact name > prefix > word prefix; primary name beats alias (Natural Earth `namepar`/`namealt`/`nameascii`,
  e.g. `bombay` -> Mumbai, `lisboa` -> Lisbon); bigger population and capitals rank first; `"portland, us"` or
  `"lisbon, portugal"` narrows by country, ISO code or admin1 prefix; default limit 10. Returns `Place`
  `{ name, country, iso2, admin1, lat, lon, population, capital }` (a `geo` slot stores only `{ name, lat, lon }`).
- Tests: `packages/engine/test/geo/search.test.ts` (11, includes `lisbon` offline), `packages/engine/test/assets/early-assets.test.ts`.
- Root `.prettierignore` gained `packages/engine/data/`, `styles/**/vendor/`, `styles/**/assets/geo/`.
- R1 got the `src/geo/` row and the `data/` description (R1 is plan/**).

**Left for phase 03**
- `engine.geo.search(query)` in `api.ts` (wrap `search` from `src/geo/search.ts`; map an empty or invalid query to the
  engine's own error handling), the agent's `search_places` tool is phase 11.
- Step 16's wording says "index built at install from bundled data": the index is built in memory at first use
  from the bundled `places.json` (about 10 ms for 7342 rows); no install-time step is needed.
- `styles/base/style.json` `fonts` entries (`family`, `file`, `weight`), `@font-face` copying, templates, fixtures, `guide.md`.
  Inter is a variable font: declare `font-weight: 100 900` for it in `@font-face`.

**Handoff**
- Natural Earth data is public domain; no attribution required. IBM Plex Mono OFL has reserved name "Plex": do not rename or subset the files.
- Format of fonts is TTF (no woff2 conversion; see SOURCES.md).

## Early steps (D-19) — e5-style-format

Package E5 (style format: schema, registry, tokens). Branch `early/e5-style-format` (commits 0fd46b9, 6fbe0f6),
shim swapped to `src/errors.ts` after 02 (codes STYLE_NOT_FOUND, STYLE_INVALID, STYLE_DUPLICATE); **merged to main as
bcaa07a**, worktree removed (post-merge verify: pnpm test 1378 passed / 1 skipped, pytest 109 passed). Decision: D-23. Verify in the worktree: `pnpm typecheck`, `pnpm lint`
(eslint + prettier) green; `pnpm test` 10 files, 213 tests (styles 3 files, 140); `uv run --project py pytest` 4 passed.
Reviewed twice (typescript-reviewer); fixes in 6fbe0f6 (self-declared trust, Ajv `$id` cache, `url()` in token
values, realpath containment on every read).

**Steps done**: 1 (format: `style.json`, `template.json`, caption preset `.json` from D-15, `sfx` from D-14,
`minEntranceMs`, variables schema checked with ajv), 2 (registry: search order, duplicates, `extends` chain,
merge, template identity `<styleId>/<name>`, S8 trust from the declaring style), the token-name part of 3
(`--tok-<group>-<name>`, sorted, byte-stable CSS).

**Files**
- `packages/engine/src/styles/schema.ts`, `registry.ts`, `tokens.ts`; `packages/engine/src/errors.pending.ts` (shim,
  byte-identical to the orchestrator copy).
- `packages/engine/package.json` dependencies `zod 4.6.5`, `ajv 8.20.0` (same pins as 02; exports/scripts unchanged),
  `pnpm-lock.yaml`.
- Tests `packages/engine/test/styles/{schema,registry,tokens}.test.ts`; test styles in
  `packages/engine/test/fixtures/styles/` (`builtin/base`, `builtin/paper`, `user/draft`, duplicate `user/base`).
  No `styles/**` content (A1 owns it).
- New error codes (append to `ERROR_CODES` at the shim swap): `STYLE_NOT_FOUND`, `STYLE_INVALID`, `STYLE_DUPLICATE`.

**Left for phase 03**
- Shim swap after 02 merges: `errors.pending.ts` imports to `../errors.ts`, codes appended to `ERROR_CODES`.
- Token scoping inside compile (GATE 1 item 7); compile passes `assetUrl` built from `files.texture.paper`
  (the real path) to `tokensCss`.
- Step 4: `registry.template()` behind 02's template lookup in ops; `vox new` picks the style; `engine.styles`
  in `api.ts` (`list`, `get`; `accept`/`remove` are 06).
- The real `styles/base/style.json` (with A1's fonts), templates, fixtures and `guide.md`.
- Optional: swap the local path-string checks in `schema.ts` for `paths.ts` helpers.

**Left for phase 06**: trust store behind the registry's `isTrusted(styleId, dir)` (`vox style trust`), the
`maxLength` rule for text variables in `vox style validate`.
