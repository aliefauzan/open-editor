# Vox style

Vox-like paper collage for 9:16 explainers: the speaker on camera, cut against archive cutouts on warm
paper, yellow-on-blue maps, big serif statements and black-boxed mono captions. Entrances pop and hold
on twos, so the scenes feel cut from paper, not animated by a computer.

## Opening

Open on the speaker (the hook) unless the first line names a place, a year or an object; then open on
that scene.

## Choosing a scene

Cut from the speaker to a scene when the speech says one of these, and pick the template by the rule:

- a place, city, country, journey or route → `vox/map-route` (places from `engine.geo.search`; `route`
  on when the speaker moves from one place to another; `zoom` `world` for continents, `region` for
  countries, `city` for one city);
- a number, amount or percentage → `vox/stat` (`value` is the number, `line2` the rest of the
  sentence, `tag` the source or context; add `bgPhoto` when an archive photo of the subject exists);
- a list of things, objects or places, or a montage → `vox/paper-collage` (1–6 cutouts, spread over
  the frame, one `label` naming the group);
- a year, decade or date that anchors an event or invention → `vox/year-card` (`year` short, `tag` names
  the subject, `photo` an archive picture; an optional `blueprint` line drawing (dark lines on a light
  ground, for example a side view of the machine) replaces the generic one);
- a named person, portrait or famous artwork → `vox/framed-portrait` (`frame` `gold` for art and
  history, `polaroid` for modern or personal, `none` for a bare photo; `zoomTo` x and y in percent to
  zoom into a detail such as the eyes; `stamp` a short verdict such as GONE or FOUND, at most 14
  characters, when the story has one; `empty` true when the picture itself went missing, so the frame
  shows the bare wall before the stamp);
- a headline, news report or front page, quoted or paraphrased → `vox/newspaper` (`headline` at most 60
  characters, optional `subhead`, `photo` and `date`; `language` is the language of the headline, for
  example `fr`, so it is hyphenated correctly);
- two or three parallel things said in one breath (a comparison, a before and after, a year plus a number
  plus a person) → `vox/stack` (2–3 `panels`, each `{ template, variables }` with any other scene
  template of this style except `vox/stack`; panels share the stack's duration, so give it 3–5 s and keep
  each panel short; panels are drawn as full-width 16:9 bands, so each scene uses its landscape layout);
- a punchline, quote or key claim → `vox/kinetic-serif` (at most 60 characters; put the one or two
  words that carry it in `emphasis`).

If none fits, stay on the speaker.

## Transitions

- `vox/paper-tear` between the speaker and a scene, in either direction.
- `vox/slide-paper` between two scenes of the same story.
- Hard cuts inside a run of collage scenes.
- Inherited from `base`: `base/crossfade` (needs source handles) and `base/dip-to-black` between topics.

## Captions

- `vox/mono-box` (default): uppercase mono on a black box at mid height; the active word turns yellow,
  emphasis words sit on a red box.
- `vox/serif-lower`: white serif low in the frame, for sequences where most beats are full collage and
  the centre is busy.
- `vox/word-reveal`: no box, word by word at mid height (unread words hidden), emphasis words in a large
  italic serif; for documentary-style edits that are mostly b-roll and archive footage.

## Pacing

Keep each scene between 1.2 s and 5 s, about 2.5 s on average. The speaker is on screen for 15–35 %
of the runtime: most of the clip is scenes.

## Imagery

Prefer archive images (vintage photographs, engravings, black and white). Generate an image only when
the search finds nothing usable and an image provider is configured. Cutouts get a red outline.

## Sound

Every scene and transition carries its own sound cue: a scissors snip on `vox/paper-collage`, a
typewriter key on `vox/kinetic-serif`, a low timpani hit on the reveal of a `vox/stat`, a pop on
`vox/map-route`, a paper pop on `vox/year-card` and `vox/stack`, a paper slide on `vox/newspaper`, a
thud when the frame of a `vox/framed-portrait` lands, paper slides and whooshes on the transitions. Use them as accents, not on every cut:
about one cut in three to five gets a sound (big reveals, `stat` numbers, collage drops). Switch the
other scene cues off with `sfxOff`; prefer hard cuts, and add a transition only where its sound is the
accent (a transition's cue cannot be switched off). A quiet edit, when the user asks: `sfx` off.

## Looks

- Archive or dark scenes: add the `film-look` overlay (real film grain, flicker, vignette).
- A whole front page or news report: `vox/newspaper`. Quoting a headline or article among other objects: `vox/paper-collage` with `clipping` and `highlight` set to the phrase
  the speaker stresses; `grade: bw` or `sepia` for old pictures, `faded` for colour film, `vhs` for
  1980s–90s footage.
- `vox/word-reveal` captions mix an italic serif with a bold grotesk on emphasis words.
