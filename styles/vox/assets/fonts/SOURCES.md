# Fonts of the `vox` style

Unmodified copies from the Google Fonts upstream repository (<https://github.com/google/fonts>, commit
`bd8f81ddb5c74d5c8897b36ad88b440266245103`, folder `ofl/<family>/`), SIL Open Font License 1.1, each with
its licence text. Only the two variable fonts were renamed (brackets removed). Fetched with User-Agent
`VoxStudio-assets/0.0 (https://github.com/aliefauzan/open-editor)`.

Styles spec Part B: phase 07 rendered both display candidates on `kinetic-serif` and `stat` and kept
DM Serif Display; Libre Caslon Display (too light next to the reference) was deleted with its row.

| File                           | Family, role                                             | Upstream path                                                                                                        | SHA-256                                                            | Licence text              |
| ------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------- |
| `DMSerifDisplay-Regular.ttf`   | DM Serif Display, `fonts.display`                        | `ofl/dmserifdisplay/DMSerifDisplay-Regular.ttf`                                                                      | `8cc3643535edf039aa5d95440a8542735e9197e4f4b8d9303e980fefbf5ab616` | `OFL-DMSerifDisplay.txt`  |
| `LibreCaslonText-Variable.ttf` | Libre Caslon Text, body (variable `wght` 400-700, roman) | `ofl/librecaslontext/LibreCaslonText[wght].ttf`                                                                      | `c11809dbfd5445886293d89b32bfc2584075c80e77750cf1c284113e36b8b3f4` | `OFL-LibreCaslonText.txt` |
| `IBMPlexMono-Regular.ttf`      | IBM Plex Mono, captions, 400                             | `ofl/ibmplexmono/IBMPlexMono-Regular.ttf`                                                                            | `6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46` | `OFL-IBMPlexMono.txt`     |
| `IBMPlexMono-Bold.ttf`         | IBM Plex Mono, captions, 700                             | `ofl/ibmplexmono/IBMPlexMono-Bold.ttf`                                                                               | `ac27abd6450a64dd94467580a02fe6235156d5b92f2926ebbc8e7489df64e0be` | `OFL-IBMPlexMono.txt`     |
| `LibreCaslonText-Italic.ttf`   | Libre Caslon Text, body italic (variable `wght` 400-700) | `ofl/librecaslontext/LibreCaslonText-Italic[wght].ttf`                                                               | `60ca1a3aade61c8c381800ca85b9b2f0fb341d89ebe065e12cd6ec2ee2e53e54` | `OFL-LibreCaslonText.txt` |
| `Inter-ExtraBold-subset.woff2` | Inter, `word-reveal` emphasis (derived, see below)       | `ofl/inter/Inter[opsz,wght].ttf` (source SHA-256 `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031`) | `40dc57e43ef3343e03f109e696c9a92969adea0b75952cd4d5de0f42a58fd43b` | `OFL-Inter.txt`           |

Body: Libre Caslon Text was taken (the other spec option, Source Serif 4, is not bundled). Caption: IBM Plex
Mono (the other option, JetBrains Mono, is not bundled). A `vox` style that falls back to the `base` fonts
would also work, but the spec asks for its own copies so the folder is self-contained.

GATE 3 round 2 (mixed-family emphasis in `captions/word-reveal`): the italic sits next to the roman, so the
compiler gives the body family an italic face (same-prefix sibling file). The emphasis grotesk is not a token
font (the token contract has three roles), so the preset inlines it as a data URL
(`scripts/sync-vox-inline.mjs`). It is a modified version under OFL 1.1 (instanced and subset; the reserved
font name is not used, the face is declared as `Vox Grotesk`):
`fonttools varLib.instancer Inter[opsz,wght].ttf wght=800 opsz=32`, then
`pyftsubset --unicodes=U+0020-007E,U+00A0-00FF,U+2013-2014,U+2018-201F,U+2026,U+20AC --flavor=woff2
--layout-features=kern,liga` (fonttools 4.66.1).

GATE 6 round 3 (phase 14a, plan D-71): the newspaper headline is a condensed grotesque like the reel's front
page. `Anton-subset.woff2` is a modified version of Anton under OFL 1.1 (subset; the reserved font name is not
used, the face is declared as `Vox Condensed`), licence text `OFL-Anton.txt`. Source
`ofl/anton/Anton-Regular.ttf` from the Google Fonts repository (<https://github.com/google/fonts/tree/main/ofl/anton>),
source SHA-256 `a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab`:
`pyftsubset Anton-Regular.ttf --unicodes=U+0020-007E,U+00A0-00FF,U+0152-0153,U+2013-2014,U+2018-201F,U+2026,U+20AC
--flavor=woff2 --layout-features=kern,liga` (fonttools 4.66.1 with brotli), output SHA-256
`3223e164ccf2d8d3f543c044fcc75d69d1de56265e88345bdbcc7e2b95830c73`. The Inter subset above also sets the yellow
tags of `year-card` and `framed-portrait` (inlined there too).
