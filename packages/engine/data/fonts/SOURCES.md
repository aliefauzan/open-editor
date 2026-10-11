# Font catalogue (Styles Part C, phase 15)

The free fonts an extracted style may use (`catalogue.json`, read by `src/styles/extract/catalogue.ts`).
The map step picks the closest entry for each font role a vision model describes and copies the file and
its licence into the draft style's `assets/fonts/`.

- Source: the Google Fonts repository <https://github.com/google/fonts>, commit
  `bd8f81ddb5c74d5c8897b36ad88b440266245103`, folder `ofl/<family>/`.
- Licence: every file is SIL Open Font License 1.1. Each family's `OFL.txt` is kept beside its fonts as
  `OFL-<family>.txt` (lower case, no spaces). The font files are unmodified (no subsetting, no renaming),
  so the Reserved Font Name clauses do not apply.
- 39 families, 50 files, about 11 MB. Variable fonts are kept as one file with their weight range
  (`weights.min`–`weights.max`); static families keep a Regular and a Bold (Poppins also Black).
- `catalogue.json`: `{ source, commit, fonts: [{ family, file, weights, classification, tags, licence,
  licenceFile, sha256 }] }`; `classification` is one of serif, sans, slab, mono, script; `tags` describe the
  look (condensed, geometric, didone, typewriter, handwritten, …) and are matched against the tags a
  vision model gives. `sha256` is the SHA-256 of the font file.
- Left out for size: Merriweather, Source Serif 4, Cormorant Garamond, EB Garamond (large variable files).
