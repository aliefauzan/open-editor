# Engine data

## `places.json` (offline place search, `src/geo/search.ts`)

- Source: Natural Earth `ne_10m_populated_places_simple` v5.1.2 (7342 populated places),
  <https://naciscdn.org/naturalearth/10m/cultural/ne_10m_populated_places_simple.zip>
  (SHA-256 of the zip: `2963ee08f7743f13f37d5243acd77a2f7a510e26a36c7e04b920f1b381f2b251`),
  page <https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-populated-places/>.
- Licence: public domain (Natural Earth terms of use: no permission needed, no attribution required;
  credit "Made with Natural Earth" is courtesy).
- Built with `node packages/engine/data/build-places.mjs <path to the .dbf from the zip>`; deterministic output.
- Format `vox-places/1`: `{ format, source, columns, rows }`. Columns:
  `name, aliases ("|"-joined: Natural Earth namepar, namealt, nameascii), country, iso2, admin1, lat, lon (4 decimals), population (pop_max), capital (1 = country capital)`.
  Rows are sorted by population, largest first.
- SHA-256 of `places.json`: `dfb4767af7fed2ca2a2c26e1bbc119f76cbcc17e4ebdee0b909a7bedf9d4d650`.

## `fonts/` (style extraction font catalogue, `src/styles/extract/catalogue.ts`)

- 46 families (64 files) from the Google Fonts repository, SIL Open Font License 1.1; sources, commit and file
  hashes in `fonts/SOURCES.md` and `fonts/catalogue.json`; each family's licence is `fonts/OFL-*.txt`.
