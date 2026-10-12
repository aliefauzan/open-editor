# Font catalogue (Styles Part C, phase 15)

The free fonts an extracted style may use (`catalogue.json`, read by `src/styles/extract/catalogue.ts`).
The map step picks the closest entry for each font role a vision model describes and copies the file and
its licence into the draft style's `assets/fonts/`.

- Source: the Google Fonts repository <https://github.com/google/fonts>, commit
  `bd8f81ddb5c74d5c8897b36ad88b440266245103`, folder `ofl/<family>/`.
- Licence: every file is SIL Open Font License 1.1. Each family's `OFL.txt` is kept beside its fonts as
  `OFL-<family>.txt` (lower case, no spaces). The font files are unmodified (no subsetting, no renaming),
  so the Reserved Font Name clauses do not apply.
- 46 families, 64 files, about 15 MB. Variable fonts are kept as one file with their weight range
  (`weights.min`–`weights.max`); static families keep a Regular and a Bold (Poppins also Black). A
  variable file `<Family>[wght].ttf` is stored as `<Family>-Variable.ttf`, an italic one
  `<Family>-Italic[wght].ttf` as `<Family>-Italic-Variable.ttf` (file name only; the font is unchanged).
- `catalogue.json`: `{ source, commit, fonts: [{ family, file, weights, classification, tags, licence,
  licenceFile, sha256, italic? }] }`; `classification` is one of serif, sans, slab, mono, script; `tags` describe the
  look (condensed, geometric, didone, typewriter, handwritten, …) and are matched against the tags a
  vision model gives. `sha256` is the SHA-256 of the font file.
- Left out for size: Merriweather, Source Serif 4, Cormorant Garamond, EB Garamond (large variable files).
- Added in phase 15 GATE 8 round 3 (same commit, for the measured caption font match): Instrument Serif
  (Regular, Italic), VT323, Silkscreen (Regular, Bold), Pixelify Sans (variable), Micro 5, Jersey 10, and the
  italic files of Crimson Pro, DM Serif Display, Libre Caslon Text, Lora and Playfair Display; DotGothic16
  (a dot-matrix face; `ofl/dotgothic16/DotGothic16-Regular.ttf`). An italic file
  is its own entry with `italic: true` and the family name of its upright sibling; the map step never picks
  it on its own but copies it with the family, so compile serves a real italic face. Download URLs:
  `https://raw.githubusercontent.com/google/fonts/<commit>/ofl/<family>/<file>` (e.g.
  `ofl/instrumentserif/InstrumentSerif-Italic.ttf`, `ofl/vt323/VT323-Regular.ttf`,
  `ofl/pixelifysans/PixelifySans[wght].ttf`); SHA-256 per file in `catalogue.json`.
