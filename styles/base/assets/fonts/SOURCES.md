# Fonts of the `base` style

All files are unmodified copies from the Google Fonts upstream repository
(<https://github.com/google/fonts>, commit `bd8f81ddb5c74d5c8897b36ad88b440266245103`, folder `ofl/<family>/`),
SIL Open Font License 1.1. Each family's licence text sits next to the files. The only change is the
file name of the two variable fonts (brackets removed). Fetched with User-Agent
`VoxStudio-assets/0.0 (https://github.com/aliefauzan/open-editor)`.

| File                      | Family, role                                                     | Upstream path                             | SHA-256                                                            | Licence text          |
| ------------------------- | ---------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ | --------------------- |
| `Inter-Variable.ttf`      | Inter, display and body (variable: `opsz` 14-32, `wght` 100-900) | `ofl/inter/Inter[opsz,wght].ttf`          | `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031` | `OFL-Inter.txt`       |
| `IBMPlexMono-Regular.ttf` | IBM Plex Mono, captions, weight 400                              | `ofl/ibmplexmono/IBMPlexMono-Regular.ttf` | `6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46` | `OFL-IBMPlexMono.txt` |
| `IBMPlexMono-Bold.ttf`    | IBM Plex Mono, captions (active word), weight 700                | `ofl/ibmplexmono/IBMPlexMono-Bold.ttf`    | `ac27abd6450a64dd94467580a02fe6235156d5b92f2926ebbc8e7489df64e0be` | `OFL-IBMPlexMono.txt` |

Format: TrueType (`.ttf`), chosen so the files stay byte-identical to upstream (OFL reserved font names
forbid renamed derivatives; a format conversion would be a modification). Chrome loads them through
`@font-face` without conversion. Phase 03 writes the `style.json` `fonts` entries (`family`, `file`, `weight`).
