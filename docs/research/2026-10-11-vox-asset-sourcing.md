# Vox style: asset inventory and sourcing (owner request)

Date: 2026-10-11. Owner request: "we need more assets to make it cooler, find everything we need; there are
places to download or create the assets". References: TikTok accounts `@metro.media.house3` and
`@attentioncompound` (downloaded for reference only, gitignored).

Scope: research only. Nothing in `styles/` or on any phase branch was changed. Phase 07 is at GATE 3;
everything below is a proposal for phase 07 (or a later style pass) to adopt.

## 1. Method

- References: `docs/evidence/phase-07/reference/` (gitignored). This pass added the next 10 videos of
  `@attentioncompound` (`--playlist-items 6-15`) and the 3 remaining older videos of `@metro.media.house3`
  (the account only has 8 public videos, so items 6-15 returned 3). Other sessions also added older
  `@attentioncompound` videos to the same folder; they were included in the audio analysis.
- Contact sheets: one per video in `reference/sheets/` (4x4 tiles, 320 px wide, one frame every
  max(5 s, duration/16)). 35 sheets made. 15 were examined closely in this pass (metro: 4, attention: 11),
  in addition to the 29 single frames in `docs/evidence/phase-07/ref-frames/` from round 1. Counts in
  section 2 are "seen in N of the 15 examined sheets".
- Audio: `ffmpeg` `ebur128` (integrated loudness I, loudness range LRA), `silencedetect` (-40 dB, 0.3 s),
  scene cuts (`select='gt(scene,0.3)'`), and a 25 ms RMS envelope of the >2.5 kHz band (`astats`). A
  "transient" is a rise of at least 8 dB above the median of the previous 0.3 s. "hit@cut" is the share of
  cuts with a transient within ±120 ms; "hit@rnd" is the same for 400 random times (the baseline).
  44 videos analysed.
- Licences: every source's own licence page was fetched in this pass (list in section 4). Per-file
  Commons licences were read from the file page metadata (`extmetadata.LicenseShortName`) and spot-checked
  on the file page.

## 2. Inventory of what the references use

Labels: M = metro.media.house3 (16:9 landscape), A = attentioncompound (9:16 portrait).

| Asset type                                                       | Seen in (of 15) | Notes and where                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bold grotesk single-word captions, centred, small                | 10              | Both accounts; one word or two at a time, white, soft shadow; Inter / Helvetica-like                                                                                                                              |
| Serif italic captions                                            | 9               | A (Rockefeller, Cartier, Red Bull, Bogle, sunscreen, McKinsey): small white serif italic, often the only caption style                                                                                             |
| Mixed line: serif italic + bold sans in one phrase               | 6               | "They run **GOOGLE**", "year on **marketing.**", "has a *receipt*", "noticing a *pattern*": the emphasis word switches family                                                                                    |
| Film grain, vignette, darkened edges                             | 9               | Almost every A video; M uses a dark vignette frame around inset footage                                                                                                                                           |
| Newspaper clippings, article screenshots, headlines              | 7               | M (a16z article), A (Rockefeller article card, Cartier book page, Federer headline, Bogle front page, BlackRock web headline, "$50,000 MRR" newsprint)                                                             |
| Archive footage / old photos (B/W, sepia, colourised, tape-era)  | 6               | A (Rockefeller newsreel, Santos-Dumont, Bogle C-SPAN tapes, radio/newspaper history), M (inverted factory footage)                                                                                                |
| Globe / Earth / space plates                                     | 5               | A (Cartier night Earth, McKinsey globe, BlackRock shuttle), M (galaxy, Moon, Earth UI)                                                                                                                             |
| Data UI: bar chart, table, stock chart, counter ring, lower third | 5              | M (benchmark bar chart, table, "12,000 impressions" ring), A (stock chart, analytics screenshot, name lower third)                                                                                               |
| Cutout photos with white border and drop shadow on light paper    | 4              | M (Cluely: cutouts on grey paper, floating photo cards), A (Cartier collage, stacked inset cards)                                                                                                                 |
| Lone word on black, or on a flat colour plate                    | 4 + 3           | Black: A (McKinsey, Red Bull, gifted, BlackRock). Colour: M blue grid plate, A red plate, A purple grain gradient                                                                                                 |
| Split-screen grids / stacked panels                              | 4               | A (Federer grid, gifted stacked 16:9 strips), M (three faces), A (OS montage)                                                                                                                                     |
| Highlighter (yellow) over text                                   | 3               | M (a16z article), A (Cartier book, Federer headline)                                                                                                                                                             |
| Old CRT TV frame around footage                                  | 3               | A (Red Bull twice, sunscreen twice, curved-CRT Federer headline)                                                                                                                                                 |
| Halftone / dot-matrix / engraving look                           | 4               | M (dot-matrix "Creation of Adam" hands, engraved hands), A (engraved dollar bill), A (dot network)                                                                                                                |
| Big display words                                                | 4               | M "BLINK" (pink grotesk), "€20,000", M "In 2017" (mono, huge), A "STORIES" (condensed, image-filled), A "$50,000 MRR" (condensed newsprint serif)                                                                 |
| Glitch / VHS / tape artefacts                                    | 3               | M (code glitch, RGB split), A (Bogle tape noise, camcorder date stamp, TV static)                                                                                                                                 |
| 16:9 inserts with black bars inside 9:16                         | 3               | A (portrait card on black, stacked strips, inset cards)                                                                                                                                                         |
| Typewriter cursor captions ("Link in bio_")                       | 2               | M (both end cards)                                                                                                                                                                                              |
| Light leak / flare                                               | 2               | A (warm flare, stadium flare); also every A end card is a glowing logo (brand outro, not an asset to copy)                                                                                                       |
| Corkboard + push-pin + paper note                                | 1               | M (Analytics note pinned on cork)                                                                                                                                                                                |
| Gilded picture frame, old notebook/book page, red route line     | 1 each          | A (Rockefeller framed portrait), A (Cartier notebook), M (red line across paper)                                                                                                                                 |
| Brand logos, celebrity photos, film stills                       | most            | Not an asset type we can ship. At runtime they come from the user's own media or archive search with an allowed licence                                                                                          |

Fonts seen: serif italic display (closest open match: Instrument Serif Italic, Libre Caslon Text Italic),
bold neo-grotesk (Inter), typewriter/mono (Courier Prime, IBM Plex Mono already in the style), condensed
display (Anton) and a condensed newsprint serif.

### Sound

| Measure                                   | Median (44 videos) | Range         |
| ----------------------------------------- | ------------------ | ------------- |
| Integrated loudness                       | -19.5 LUFS         | -33.8 to -8.7 |
| Loudness range (LRA)                      | 4.4 LU             | 2.4 to 8.9    |
| Silences (< -40 dB, ≥ 0.3 s) per video     | 0                  | 0 to 3        |
| Visual cuts per minute                    | 63                 | 20 to 143     |
| High-band transients per minute           | 107                | 58 to 144     |
| Share of cuts with a transient (±120 ms)  | 0.44               | 0.18 to 0.77  |
| Same share at random times (baseline)     | 0.41               | 0.22 to 0.55  |

Reading:

- A continuous, compressed bed: music never drops out (no silences in 34 of 44), LRA around 4 LU, voice on
  top. Loudness is moderate (-19.5 LUFS median), not the -14 LUFS of loud TikTok edits.
- Cuts are very fast (about one per second) but SFX are not put on every cut: at the median the hit rate at
  cuts (0.44) is barely above chance (0.41). A few videos accent cuts clearly (reel 0.77, attention
  `…7663172910` 0.72, metro `…7691389719` 0.67). The rule to copy: a sound accent on roughly one cut in
  three to five (reveals, numbers, collage drops), and the music bed carries the rest. This matches the
  `pacing` block already in the style and argues against an SFX on every transition.
- Accent sounds heard: paper movement, camera shutter clicks, soft low hits under numbers, typing ticks
  under mono text, tape/static under TV inserts. No meme sounds.

## 3. Licence rules applied

- Style SFX: real recordings, CC0 or public domain only (spec `licence: 'CC0' | 'project'`); never
  synthesised; no meme sounds. Owner recordings use `project`.
- Textures and overlays shipped in the style: CC0 or public domain.
- Fonts: SIL OFL 1.1, or a similarly free licence (Apache 2.0) with the licence file kept next to the font.
- Runtime archive media (fetched per project): CC0, PDM, CC BY, CC BY-SA only (R4 S7).

## 4. Sources

| Asset type                         | Source                                                         | Licence (verified on the source's own page)                                                                      | Account needed?          | API without account?                                                             |
| ---------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| Style SFX                          | Wikimedia Commons (`filetype:audio`, PDSounds and Freesound CC0 mirrors) | Per file; take only `CC0` or `Public domain` on the file page                                                     | No                       | Yes, MediaWiki API (`action=query&generator=search`), send a User-Agent          |
| Style SFX                          | Freesound (CC0 filter)                                         | Per sound: CC0, CC BY, CC BY-NC (Sampling+ legacy); only CC0 is usable                                           | Yes (login to download)  | Key needed. Owner MANUAL STEP only                                               |
| Style SFX                          | Owner recordings                                               | `project`                                                                                                        | n/a                      | n/a                                                                              |
| Paper, cardboard, cork, tape       | ambientCG                                                      | CC0 1.0 for all assets ("All ambientCG assets are provided under the Creative Commons CC0 1.0 Universal License") | No                       | Yes, `api/v2/full_json`, downloads via `get?file=<id>_1K-JPG.zip`                |
| PBR textures (few paper ones)      | Poly Haven                                                     | CC0 for all assets                                                                                               | No                       | Yes, `api.polyhaven.com` (separate API terms)                                    |
| Film grain scans, props, old print | Wikimedia Commons                                              | Per file (CC0 / PD only for shipped assets)                                                                      | No                       | Yes                                                                              |
| Fonts                              | Google Fonts repository (`github.com/google/fonts`)            | OFL 1.1 (`ofl/…/OFL.txt`) or Apache 2.0 (`apache/…/LICENSE.txt`)                                                 | No                       | Raw files over HTTPS                                                             |
| Archive photos, footage, audio     | Wikimedia Commons                                              | Mixed per file; filter to CC0 / PDM / BY / BY-SA                                                                 | No                       | Yes                                                                              |
| Archive photos, maps, newspapers   | Library of Congress (`loc.gov`)                                | Not stated on the API page; per-item rights statement; accept only "no known restrictions" / public domain as PDM | No                       | Yes, JSON API, "no API key or authentication required", rate limited             |
| Space, Earth                       | NASA (`images-api.nasa.gov`)                                   | Generally not under US copyright; credit NASA; logos/insignia excluded; no implied endorsement                   | No                       | Yes (checked: keyless search returns results)                                    |
| Museum objects, engravings         | The Met Open Access                                            | Dataset CC0; Open Access images described as public domain                                                       | No                       | Yes, keyless, max 80 requests/s                                                  |
| Museum objects                     | Smithsonian Open Access                                        | CC0 for Open Access items (site blocked automated fetch in this pass; not re-verified)                             | Free api.data.gov key    | No: the API answers `API_KEY_MISSING` without a key                              |
| Museum objects, Dutch history      | Rijksmuseum                                                    | Public-domain works: "Public Domain or CC0"; other material CC BY 4.0                                            | No                       | Yes, `data.rijksmuseum.nl/search/collection` (Linked Art) answered without a key |
| Old film footage                   | Internet Archive, Prelinger Archives                           | Per item: in a 200-item sample 31 carry the CC public-domain URL and 169 carry none; accept only marked items    | No                       | Yes, `advancedsearch.php`, `metadata/<id>`                                       |
| Maps                               | Natural Earth                                                  | Public domain ("All versions of Natural Earth raster + vector map data … are in the public domain")              | No                       | Direct downloads (already used by `map-route`)                                   |

Rejected (licence is not on the allowed list):

- Pixabay: own "Content License", not CC0; no standalone redistribution.
- Pexels: own licence, not CC0; no redistribution of unaltered files, no reuse on other platforms.
- Mixkit: own "Mixkit License" per item type, not CC0.
- Unsplash: own "Unsplash License", not CC0; no compiling images to replicate a similar service.
- Commons files under CC BY / BY-SA are fine for runtime archive media but not for shipped style assets.

## 5. Create instead of download

| Asset                          | How                                                                                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Film grain                     | Prefer the real CC0 grain scans below (tile and loop a crop, `blend=overlay`); fallback `noise=alls=12:allf=t+u` on a grey plate                                                              |
| Vignette, darkened edges       | `ffmpeg vignette=PI/5`, or a radial gradient in the overlay HTML                                                                                                                                |
| Light leaks                    | Procedural: a few soft radial gradients in warm hues, `gblur`, slow drift and hue rotation, `blend=screen` at 20-40 %; or CSS radial gradients with `mix-blend-mode: screen`                  |
| Dust and scratches             | Procedural: sparse random specks plus 1 px vertical lines with short lifetimes (`geq` / canvas). Real alternative: crop the leader and gaps from public-domain 16 mm scans on Commons          |
| Gate weave, flicker            | `crop` with small sine offsets, `eq=brightness` jitter                                                                                                                                          |
| Halftone / dot-matrix          | Shader or CSS mask (`radial-gradient` dot grid, threshold by luminance) in the template; matches `imagery.generateSuffix` ("vintage halftone photograph")                                        |
| Torn edges                     | SVG `feTurbulence` + `feDisplacementMap` on the paper mask (the `paper-tear` transition approach)                                                                                               |
| Tape strips                    | ambientCG `Tape004` atlas (colour + opacity) cut into strips, or a CSS strip with a jagged clip-path and multiply blend                                                                          |
| Highlighter / marker strokes   | SVG path with a rough edge, `stroke-dasharray` draw-on, `mix-blend-mode: multiply`, highlighter yellow and the style red                                                                       |
| Circles, arrows, underlines    | Hand-drawn style SVG paths (slight wobble, two passes), animated draw-on                                                                                                                         |
| Stamps                         | SVG text in a box, distressed with a noise mask, rotated 3-8°, paired with the existing `stamp` SFX                                                                                              |
| CRT TV frame, VHS look         | SVG rounded-rect bezel + `lenscorrection` barrel + scanlines; VHS: `rgbashift`, `noise`, small mono date stamp                                                                                  |
| Waveform overlay               | From the voice track: `showwaves` (animated) or `showwavespic` (still), coloured with style tokens                                                                                               |
| Colour grade looks             | Built-in presets with `curves` / `colorbalance` / `hue=s=0`, or a generated `.cube` for `lut3d`: B/W archive, warm sepia, cool teal night, faded colour film                                      |
| Isolated objects and props     | Local image generation with mflux (plan phase 14d), using `imagery.generateSuffix`; then the existing cutout stroke                                                                             |
| Whoosh, riser, typewriter keys | Owner-recorded real sounds, licence `project` (cloth or thin stick swish close to the mic for a whoosh; a real typewriter if one is available). No CC0 recording was found; never synthesise |
| Icons                          | Simple self-drawn SVG in the style's line weight; never brand logos                                                                                                                              |

## 6. Downloaded starter set (gitignored, not committed, untrimmed)

`docs/evidence/phase-07/reference/asset-candidates/` with `MANIFEST.json`
(`file, type, sourceUrl, licence, licenceUrl, author, notes, bytes, sha256`). 36 files, 58.5 MB.

- SFX (10, Commons): Holga shutter (PD), Canon 5D III shutter burst (CC0, Polecatz), camera focus click
  (CC0), IBM Model M typing (CC0), scissors cutting a letter (PD), food-wrapper crumple (PD), timpani hit with
  yarn mallet (CC0), mechanical tack (PD), karabiner click (CC0), electronic interference (PD).
- Textures (7): Kodak Tri-X 400 and Ultramax 400 grain scans (CC0, Commons), kraft paper tileable (PD),
  crumpled paper (PD), ambientCG `Paper005`, `Cardboard004`, `Cork002` colour maps (CC0).
- Overlays (3): ambientCG `Tape004` colour + opacity (CC0), a public-domain film leader (Commonwealth Film
  Unit, Commons).
- Props (3): vintage TV photo (CC0; the TV is small in frame, so a weak candidate), gilded frame engraving
  (Meissonnier, The Met, CC0), red push-pin photo (CC0).
- Archive (1): 1907 newspaper page (PD), as a clipping backdrop.
- Fonts (12): Instrument Serif Regular + Italic, Libre Caslon Text Italic (the style has the roman only;
  its OFL file is already in `styles/vox/assets/fonts/`), Inter variable, Courier Prime Regular, Special
  Elite (Apache 2.0), Anton, with their licence files.

Looked at and dropped: a "Push-pin" British Museum print (a caricature, not a pin), ambientCG `Tape001`
(hazard tape), two torn-poster photos (wide street scenes with third-party poster artwork), a "braam"
(designed from sampled instruments, too close to synthesised), "Paper Radio - Typewriters" (a talk show).

## 7. Proposal: what to add first

Ranked by visual gain per effort, mapped to what the style already has (templates `kinetic-serif`,
`stat`, `paper-collage`, `map-route`; transitions `paper-tear`, `slide-paper`; caption presets
`mono-box`, `serif-lower`, `word-reveal`; overlay `paper-grain`; SFX `paper-pop`, `paper-slide`, `stamp`,
`thump-tap`, `whoosh`).

1. **Mixed-family emphasis in `word-reveal`** (seen 6 + 9 + 10 of 15). Serif italic for most words, the
   emphasis word in bold grotesk (or the reverse). Needs one italic (Libre Caslon Text Italic keeps the
   current family; Instrument Serif Italic is closer to the references) and Inter. Effort: small.
2. **Film look overlay** next to `paper-grain` (9 of 15): real Tri-X grain scan + vignette + light
   flicker, for dark and archive scenes. Effort: small (one overlay, assets downloaded).
3. **Clipping + highlighter template** (7 + 3 of 15): article/newsprint card, headline in a condensed or
   serif face, yellow marker draw-on over a phrase, optional circle/arrow. Built from SVG strokes plus the
   1907 newsprint / kraft textures. Could start as a `paper-collage` variant. Effort: medium.
4. **Archive grade presets for runtime media** (6 of 15): B/W, sepia, faded colour, VHS, applied to
   archive search results (Commons, LoC, Prelinger, NASA, Met) together with the grain overlay. Effort:
   small to medium (ffmpeg filter presets).
5. **Accent SFX set + accent rule**: add shutter, typing, crumple, scissors, low timpani hit as
   candidates (run `vox audio-qa --kit vox` on them), and place SFX on about one cut in three to five
   (reveals, `stat` numbers, collage drops), not on every transition. Effort: small.
6. Frame inserts template (CRT TV bezel, gilded frame, letterboxed 16:9 card in 9:16) (3-4 of 15).
   Effort: medium.
7. `mono-box` variant with a blinking typewriter cursor ("Link in bio_") in Courier Prime or IBM Plex
   Mono (2 of 15). Effort: small.
8. Corkboard backdrop for `paper-collage`: ambientCG cork, tape atlas, push-pin cutout (1 of 15 plus the
   round-1 references). Effort: small.
9. Halftone/dot-matrix treatment for cutouts, matching the existing `imagery.generateSuffix` (4 of 15).
   Effort: medium (shader).
10. Image-filled display word for `kinetic-serif` (Anton, clip-path over footage) (1-2 of 15). Effort:
    small.

Owner manual steps (optional): a Freesound login to look for CC0 whoosh, riser and typewriter-key
recordings (search with the CC0 licence filter, record the sound URL and author); or record a whoosh and
typewriter keys at home (licence `project`).
