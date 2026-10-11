# `vox style validate` test styles (phase 06)

Each folder is a style that extends `base`, loaded together with the repo `styles/` folder.

- `vgood`: passes every check. Template `pop` has `minEntranceMs` 2000, an `appear` cue at 500 ms
  with a credited SFX, and two caption presets (`base/plain`, `vgood/loud`).
- `vlate`: the same template with its cue at 633 ms, 4 frames after the dot appears (cue timing).
- `vnocredit`: `assets/sfx/CREDITS.md` has no entry for `pop.wav`.
- `vnojson`: caption preset `bare` has no `.json`.
- `vbadcase`: caption preset `odd` has `case: "title"`.
- `vskip`: a variables schema declares the reserved `skipEntrance`.
- `vunsafe`: `low` puts text below the safe area, has a text variable without `maxLength` and
  references a missing `pic.png`; `noskip` ignores `skipEntrance`.

The slow test copies this folder to a temp folder, so the previews it writes stay out of the repo.
