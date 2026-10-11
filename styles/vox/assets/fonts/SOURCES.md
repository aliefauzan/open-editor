# Fonts of the `vox` style

Unmodified copies from the Google Fonts upstream repository (<https://github.com/google/fonts>, commit
`bd8f81ddb5c74d5c8897b36ad88b440266245103`, folder `ofl/<family>/`), SIL Open Font License 1.1, each with
its licence text. Only the two variable fonts were renamed (brackets removed). Fetched with User-Agent
`VoxStudio-assets/0.0 (https://github.com/aliefauzan/open-editor)`.

Styles spec Part B: phase 07 rendered both display candidates on `kinetic-serif` and `stat` and kept
DM Serif Display; Libre Caslon Display (too light next to the reference) was deleted with its row.

| File                           | Family, role                                             | Upstream path                                   | SHA-256                                                            | Licence text              |
| ------------------------------ | -------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ | ------------------------- |
| `DMSerifDisplay-Regular.ttf`   | DM Serif Display, `fonts.display`                        | `ofl/dmserifdisplay/DMSerifDisplay-Regular.ttf` | `8cc3643535edf039aa5d95440a8542735e9197e4f4b8d9303e980fefbf5ab616` | `OFL-DMSerifDisplay.txt`  |
| `LibreCaslonText-Variable.ttf` | Libre Caslon Text, body (variable `wght` 400-700, roman) | `ofl/librecaslontext/LibreCaslonText[wght].ttf` | `c11809dbfd5445886293d89b32bfc2584075c80e77750cf1c284113e36b8b3f4` | `OFL-LibreCaslonText.txt` |
| `IBMPlexMono-Regular.ttf`      | IBM Plex Mono, captions, 400                             | `ofl/ibmplexmono/IBMPlexMono-Regular.ttf`       | `6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46` | `OFL-IBMPlexMono.txt`     |
| `IBMPlexMono-Bold.ttf`         | IBM Plex Mono, captions, 700                             | `ofl/ibmplexmono/IBMPlexMono-Bold.ttf`          | `ac27abd6450a64dd94467580a02fe6235156d5b92f2926ebbc8e7489df64e0be` | `OFL-IBMPlexMono.txt`     |

Body: Libre Caslon Text was taken (the other spec option, Source Serif 4, is not bundled). Caption: IBM Plex
Mono (the other option, JetBrains Mono, is not bundled). A `vox` style that falls back to the `base` fonts
would also work, but the spec asks for its own copies so the folder is self-contained.
