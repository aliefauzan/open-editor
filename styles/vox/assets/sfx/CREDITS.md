# SFX candidates for the `vox` style (plan D-14, D-16)

Status: **accepted in phase 07** for `paper-pop`, `paper-slide`, `whoosh`, `stamp` and `thump-tap`: each passes
`vox audio-qa --kit vox` (run by `vox style validate vox`) and the sheet review of `previews/sfx-sheet.png`.
`typewriter.wav` was **removed from the kit** (file deleted; its row stays below for the record): its sheet shows steady tone lines (a margin bell, not a key strike),
so `style.json` does not list it until a real key strike is recorded for the project (licence `project`).
Every file is a real recording (nothing synthesised), cut from a Wikimedia Commons file; thresholds were never
loosened.

Fetched with User-Agent `VoxStudio-assets/0.0 (https://github.com/aliefauzan/open-editor)`, one file per
empty directory, inspected with `file` and `ffprobe` before use. Source files are not committed.

Processing for every file (`ffmpeg`, mono, 48 kHz, pcm_s16le WAV): `atrim` to the stated window, 5 ms fade in
and 5 ms fade out, gain so the sample peak is -1.0 dBFS (measured with `volumedetect`, then applied).

Phase 07 re-processing (the 5 ms fades left the first or last 5 ms above -40 dBFS, and a -1.0 dBFS peak sat on
the limit): from the files above, a 10 ms fade in and a 15 ms fade out, 6 ms of silence added at both ends, and
gain to a -1.2 dBFS sample peak. `paper-slide`: first 0.82 s only (drops the click cluster near the end),
fade out 60 ms. `whoosh`: first 0.82 s, shaped into one swell (quarter-sine fade in 0.45 s, fade out 0.37 s),
so it is no longer a flat noise bed. `thump-tap` is unchanged.

| File              | Type   | Source file on Commons (page URL)                                                    | Author                     | Licence on the file page            | Window used      | Source SHA-256                                                     | Known weaknesses for the kit check                                                                                                                                                                                                 |
| ----------------- | ------ | ------------------------------------------------------------------------------------ | -------------------------- | ----------------------------------- | ---------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paper-pop.wav`   | appear | <https://commons.wikimedia.org/wiki/File:Virada_de_Carta.ogg>                        | Rafael Tavares Juliani     | CC0                                 | 0.25 s + 0.20 s  | `73f3c00fbb7072f6c0894bc6a477b234da1511feadfaef630221857c8ae8c305` | a card flip rather than a paper pop; the source is peak-limited                                                                                                                                                                    |
| `paper-slide.wav` | move   | <https://commons.wikimedia.org/wiki/File:Turning_a_page.ogg>                         | planish (via PDSounds)     | Public domain (`CC0` in style.json) | 1.25 s + 1.20 s  | `e153d4e3ef5ce26eb0448f9333a37c8605269ed0488956a20cc66b13fc39b29f` | quiet source (gain +13 dB lifts hiss); a small click near the end                                                                                                                                                                  |
| `whoosh.wav`      | move   | <https://commons.wikimedia.org/wiki/File:Book_paper_pages_assorted.ogg>              | stephan (via PDSounds)     | Public domain (`CC0` in style.json) | 67.65 s + 0.90 s | `7725928b65296676cff33f2d2c6f1489e810acf27c1a48a9c452263c26fd2a08` | a fast page riffle: broadband noise, likely too flat; no true whoosh with a free licence was found. Replace or record                                                                                                              |
| `stamp.wav`       | land   | <https://commons.wikimedia.org/wiki/File:Hardcover_books_dropped.ogg>                | stilgar (via PDSounds)     | Public domain (`CC0` in style.json) | 0.04 s + 0.18 s  | `15ccbc260f6d297ca7ab61c8fe9db0e5029509fdbe508487548d8905a9ba1e8f` | a book dropped on a desk, first impact only; short, may carry two close transients                                                                                                                                                 |
| `typewriter.wav`  | appear | <https://commons.wikimedia.org/wiki/File:406243_stubb_typewriter-ding-near-mono.wav> | _stubb (Freesound 406243)  | CC0                                 | 0 s + 1.056 s    | `7e86d269c13cff5d8651718b39da728e612f22e58187780d6b098f9329d713eb` | the margin bell of a typewriter, a tonal ring: likely to fail "no single spectral peak above 90 %". No typewriter key strike with CC0 or public-domain terms was found. Record one for the project (licence `project`) if it fails |
| `thump-tap.wav`   | hero   | <https://commons.wikimedia.org/wiki/File:Dull_thud.ogg>                              | gregoryweir (via PDSounds) | Public domain (`CC0` in style.json) | 0 s + 0.391 s    | `5b91906d41bd57f1f6551e446d30fbff06ec59a39d22725140293ef4aec6cdb3` | a thud with a pitched ring-down, no separate tap; short                                                                                                                                                                            |

Licence mapping: the styles spec lists `licence: 'CC0' | 'project'` and D-14 allows "CC0 or public domain".
"Public domain" rows above are Wikimedia Commons PD-author files (PDSounds.org, authors dedicated them to
the public domain). Phase 07 decides whether `style.json` writes them as `CC0` (equivalent dedication) or
the enum gains `PD`; the true licence stays in this table either way.

Rejected on licence (not CC0 / not public domain, so not usable): Rubber seal dabbed on ink pad (CC BY 3.0),
Whip-sound (CC BY 3.0), Smith-Corona Prestige Auto 12 typing (CC BY 3.0), WWS Typewriter (CC BY 4.0), the
"Gravity Sound" set (CC BY 4.0), Pressing/Flicking by Jpb33zh (CC BY-SA 4.0).
