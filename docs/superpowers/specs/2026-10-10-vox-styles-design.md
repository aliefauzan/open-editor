# Vox Studio — Sub-project 2: Style System + Vox Style

Date: 2026-10-10
Status: Revision 3 (second review fixes; desktop app), approved 2026-10-10 (plan D-10)
Overview: [2026-10-10-vox-studio-overview.md](2026-10-10-vox-studio-overview.md)
Depends on: [engine spec](2026-10-10-vox-engine-design.md) (compile, SceneClip, captions, base style)

## Context

The product must support many visual styles, not only Vox. A style is a pluggable
folder: design tokens, scene templates, transitions, overlays, caption presets, sound
effects and an agent guide. This spec defines:

- **Part A — Style format**: what a style folder contains and how the engine and agent
  use it.
- **Part B — The `vox` style**: the first real style, based on the reference reel
  (Instagram reel DePNgrmToh9, Vox-style paper collage). v1 ships 4 of its 8 templates;
  the other 4 follow in v1.1.
- **Part C — Style from a reference video**: the user uploads a video they like, and
  the system drafts a new style from it by re-skinning existing templates. Built last
  (after the agent and UI). Authoring brand-new templates with an LLM is v2.

## Part A — Style format

```
styles/<styleId>/
  style.json
  guide.md                   # how the agent should edit in this style (prompt text)
  tokens.css                 # optional extra CSS; tokens come from style.json
  templates/<name>/
    template.html            # HyperFrames composition
    template.json            # metadata + variables schema
    build.mjs                # optional compile hook (trusted styles only)
    fixtures/*.json          # example variable sets for previews and tests
  captions/<preset>.html     # caption preset compositions
  captions/<preset>.json     # caption preset fields (case, stripPunctuation, safeArea)
  overlays/<name>.html       # full-frame overlays (grain, vignette, paper edge)
  assets/                    # textures, fonts (OFL), sfx (real recordings: CC0 or the project's own; sfx/CREDITS.md)
  previews/                  # rendered thumbnails + GIFs per template (generated)
```

Style directories are searched in order: built-in `styles/`, then `~/.vox/styles/`
(engine `stylesDirs`). An id may exist in only one directory, so a user style may not
reuse a built-in id; `vox style new` and
the loader reject it, so installing a user style never silently changes existing
projects.

### `style.json`

```ts
Style {
  id: string                 // folder name, [a-z0-9-]+
  name: string; version: string; description: string
  status: 'active' | 'draft' // extracted styles start as draft
  extends?: string           // every style except base extends a chain ending in 'base'
  source: { type: 'builtin' | 'extracted' | 'user'; reference?: string }
  trusted: boolean           // builtin: true; others false until `vox style trust`
  tokens: {
    colors: Record<string, string>      // e.g. paper, ink, accent, highlight, sea
    fonts: { display: Font; body: Font; caption: Font }   // Font = { family, file, weight }
    texture?: { paper?: string; grain?: number }          // asset path, 0..1
    motion: {
      easing: string                     // GSAP ease name
      frameHold: 1 | 2 | 3               // 2 = animate "on twos" (stop-motion feel)
      jitterPx: number                   // per-held-frame random offset
      entrance: string                   // 'pop', 'assemble' (pushed in from outside the frame, D-101); unknown: 'fade'
    }
  }
  captions: { default: string; presets: string[] }   // full ids, e.g. 'vox/mono-box'
  templates: string[]        // template names declared by this style
  transitions: string[]      // transition template names declared by this style
  overlays: { name: string; default: boolean }[]     // default ones apply to sequences using this style
  pacing: {
    beatMs: { min: number; target: number; max: number }
    speakerRatio: { min: number; max: number }   // share of runtime showing the speaker
  }
  imagery: {
    searchHints: string[]    // added to archive queries, e.g. "vintage photograph"
    generateSuffix: string   // appended to image-generation prompts
    cutoutStroke?: { color: string; widthPx: number }
  }
  sfx: Record<string, {         // name → sound, e.g. "pop" (plan D-14)
    path: string                // "assets/sfx/paper-pop.wav"
    type: 'cut' | 'move' | 'land' | 'appear' | 'hero'   // what it is for (engine "Sound cues")
    source: string              // URL or "recorded for this project"
    licence: 'CC0' | 'project'  // 'project' = recorded by contributors, MIT with the repo
  }>
}
```

Colour grading and LUTs are out of scope (overview); a style's colour treatment is
limited to overlays and its own templates.

### Tokens

The engine injects a style's tokens as CSS custom properties named `--tok-<group>-<name>`
(`--tok-color-paper`, `--tok-font-display`, `--tok-motion-frame-hold`, …). The `tok`
prefix avoids confusion with the `vox` style and collisions with HyperFrames'
auto-injected `--<variableId>` properties. Tokens are scoped per scene (engine
compile): a template gets the sequence style's tokens when that style extends the
template's declaring style, and the declaring style's tokens otherwise. So inherited
templates (e.g. `base/text-overlay`) take on the sequence's look, and templates from an
unrelated style keep their own.

### `template.json`

```ts
Template {
  name: string; version: string        // semver; major bump = breaking variables
  kind: 'scene' | 'transition'
  description: string        // one paragraph the agent reads to choose templates
  useWhen: string[]          // e.g. ["a place is mentioned", "a journey or trade route"]
  durationMs: { min: number; default: number; max: number }
  variables: JSONSchema      // object schema; agent tool input and UI inspector form
  slots: Record<string, 'image' | 'cutout' | 'video' | 'geo' | 'template'>
  sfxCues?: { name: string; atMs: number | 'entrance'; sfx: string
              type: 'cut' | 'move' | 'land' | 'appear' | 'hero' }[]   // see engine "Sound cues"
  blendsShots?: boolean      // transitions: needs source handles (e.g. crossfade)
  minEntranceMs?: number     // scenes shorter than this skip the entrance (Template rules)
  panelAspect?: string       // e.g. "16:9"; only with a template slot: nested panels render at the
                             // canvas width and this ratio (D-71), else at the full canvas
}
```

- Variables use full JSON Schema (objects, arrays, enums). The engine passes them to the
  template as one resolved JSON object (`vox.vars()` from `vox-runtime.js`), not as
  HyperFrames variables, which allow scalars only.
- Slot paths use JSON Pointer-like keys (`items/*/media`, `photo`). `image`, `cutout`
  and `video` slots hold media ids that the engine resolves to file paths. `geo` slots
  hold plain `{ name, lat, lon }` data chosen with `engine.geo.search`. `template` slots
  (used by `stack`) hold `{ template, variables }`; the engine validates them against
  the named template, depth 1.
- **Template identity**: `<styleId>/<name>` always names the style that declares the
  template. A child style that inherits `vox/map-route` uses it as `vox/map-route`;
  overriding it means declaring its own `child/map-route`.
- **Versions**: a SceneClip records `templateVersion`, the template's full semver at
  placement. If the installed major version
  differs, compile fails with `TEMPLATE_VERSION` unless the template ships a
  `migrate(variables, fromVersion)` export in `build.mjs` (trusted styles only).

### Compile hook (`build.mjs`)

Optional. `export function build(vars, ctx) → { vars?, files? }` runs in Node at compile
time, e.g. to project map shapes to SVG or lay out `stack` panels. It must be pure and
deterministic (no network, no clock, no randomness without `ctx.seed`). Because it is
code running outside the browser sandbox, the engine runs hooks only for styles with
`trusted: true`: built-in styles, and user styles the user marks with
`vox style trust <id>`. Trust is decided by the style that declares the template, not
by the sequence's style: `vox/map-route` used through a draft style that extends `vox`
still runs its hook, because `vox` is trusted. Templates declared by an untrusted style,
including every extracted style, never run hooks.

Hooks are self-contained, so they work in the packaged app, where styles have no
`node_modules`: a library a hook uses is vendored as an ESM file inside the style folder
and imported by relative path (a bare import such as `d3-geo` fails `vox style validate`),
and data files are read with `ctx.readAsset(path)` (style-relative, path rule applied).
`vox style validate` also checks determinism: it runs each hook twice with the same
`ctx.seed` and compares the output, and rejects hook source that uses `Date`,
`Math.random`, `performance.now`, `process.hrtime`, `fetch` or network modules.

### Overlays

Full-frame HTML layers (grain, vignette, paper edges) mounted by compile above all video
tracks and below captions. A sequence uses its style's default overlays; the UI can
toggle them per sequence (engine field `sequence.overlays`).

### Caption presets (plan D-15)

A caption preset is `captions/<preset>.html` (a HyperFrames composition) plus
`captions/<preset>.json`:

```ts
CaptionPreset {
  name: string; description: string
  case: 'asis' | 'upper' | 'lower'
  stripPunctuation: boolean
  safeArea: { bottomPct: number; rightPct: number }   // default 20 / 12 on 9:16, 0 / 0 otherwise
  position: { yPct: number }                         // default for CaptionTrack.position
  behindSubject?: boolean                            // render only: on beats where the subject
                                                     // overlaps the caption, the subject is
                                                     // composited over it (D-91)
  track?: { maxWords?: number; maxLines?: number; maxCharsPerLine?: number; autoEmphasis?: boolean }
                                                     // taken by a sequence with the preset (D-93)
  tiered?: boolean                                   // two-tier layout (D-93)
}
```

- **Behind the subject** (additive, D-91): with `behindSubject: true` and burned-in
  captions, the final render also renders the picture without captions and runs
  `vox_py.behind`: at each caption beat it compares the two renders to find the caption
  pixels and takes the Apple Vision subject matte; when the subject covers 8-65 % of the
  caption, every frame of that beat gets the subject over the caption (mattes cached per
  frame in the project cache). Preview and SRT/VTT are not affected. Without Apple Vision
  the step is skipped and the captions stay in front. Only pixels brighter than the plain
  frame count as caption (a darker scrim does not), and the subject is never put over a
  beat where it would cover more than half of any one word (D-98).

- **Scene echoes** (D-99): the burned-in captions layer leaves out a chunk while a scene
  covers at least half its time and the scene's text holds 60 % of its words; the build's
  captions, `captions.srt` and SRT/VTT exports keep every chunk. A scene that echoes one chunk quotes
  the speaker and hides every chunk it covers by half (D-100).

- **Preset settings** (additive, D-93): when `setCaptions` changes a sequence's preset, the
  sequence takes the preset's `position` and `track` settings; fields the call gives itself
  win. "Set as style" also sets the style's default caption preset. With `tiered: true`,
  `deriveCaptions` lays chunks out in two tiers: auto emphasis also marks each phrase's
  closing key word (and a number's unit word), plain words and the emphasis run count apart
  against `maxWords`, the emphasis run takes its own line and a plain word after it starts a
  new chunk.

- **Input**: compile mounts the preset once per sequence as the captions
  sub-composition (engine "Compile") and injects the sequence's `CaptionChunk[]` (engine
  "Captions") as its variables, read with `vox.vars(el)` like a scene's. Each chunk has
  `startMs`, `endMs` and `lines`; each line has `words`; each `CaptionWord` has `key`,
  `text`, `startMs`, `endMs` and `emphasis`. Compile applies the preset's `case` and
  `stripPunctuation` to word text before it injects the chunks, so every preset gets
  them the same way. SRT/VTT export is not affected.
- **Time**: the sub-composition starts at 0 on the sequence, so its time equals timeline
  ms. The preset builds its GSAP timeline from the chunk and word times when it loads,
  and the HyperFrames runtime seeks that timeline like any other. A preset never reads a
  clock; the word states at a frame depend only on that frame.
- **Word states**: at time `t`, a word is unread (`t < startMs`), active
  (`startMs ≤ t < endMs`) or read (`t ≥ endMs`). Inside a chunk, a word's end always
  extends to the next word's start, so one word is active at a time while someone
  speaks. `gapFillMs` governs only gaps between chunks: a chunk's end extends to the
  next chunk's start when the gap is shorter than it (engine "Captions"). Every preset
  defines a look for all three states and for `emphasis` words. Read and unread may
  look the same.
- **Lines**: the preset renders each line of a chunk as one row. The engine has already
  split words into lines by `maxLines` and `maxCharsPerLine`; the preset never re-wraps.
- **Word elements**: each word's element carries `data-key="<CaptionWord.key>"`, so
  `vox style validate` reads each word's look and box (D-34).
- **Safe area**: on 9:16, platform buttons and titles cover the bottom and right edges.
  The caption box stays above `100 − bottomPct` % of the height and inside
  `rightPct` … `100 − rightPct` % of the width (symmetric, so centred text stays
  centred). If `position.yPct` would push the box into the safe area, the box moves up.
- `base/plain` (engine "Base style") follows the same contract: `case: 'asis'`,
  `stripPunctuation: false`, default safe area; the active word is set bold, emphasis
  words are set 1.2× larger, and read and unread words look the same.

### Template rules

- Pure HyperFrames composition; all timing derives from the frame number (no
  `setTimeout`, no `Date.now`, no network at render time).
- `npx hyperframes lint --json` reports zero errors, and fixtures render with
  `render --strict-all`.
- Must render every fixture without missing assets.
- Text variables declare `maxLength`; a test renders the longest fixture and checks the
  text's bounding box stays inside the 1080×1920 safe area: the default caption preset's
  `safeArea` (20 / 12 on 9:16), top edge included (D-34).
- Fonts and textures ship inside the style folder; no CDN at render time.
- Every built-in style ships `previews/` generated by `vox style validate`.
- A scene template may set `minEntranceMs` (plan D-15). When a scene's `durationMs` is
  below it, compile adds `skipEntrance: true` to the injected variables and the template
  starts in its resting state with no entrance animation (a short beat is never all
  entrance). `skipEntrance` is reserved: a template's variables schema may not declare it.

### SFX rules (plan D-14)

A style's SFX must be real recordings. `vox style validate` runs the engine's kit check
(`vox audio-qa --kit <styleId>`) on every file in `sfx`, and each file must pass:

- not synthesised: no single spectral peak holds more than 90 % of the energy (rejects
  sine beeps and clean tone lines on a physical sound);
- one event: one onset for `cut`, `appear`, `land` and `hero`; a `move` sound may swell
  but has no click transient inside it;
- not a steady noise bed: spectral flatness is not high for the whole file;
- clean edges: the first and last 5 ms stay below −40 dBFS (no click at start or end);
- peak ≤ −1 dBFS and length ≤ 3 s;
- listed in `assets/sfx/CREDITS.md` with a source and a licence of `CC0` or `project`.

Novelty or meme sounds are not used. The check also writes a sheet image with one
waveform and spectrogram per file, which a person or a vision model reviews.

### Style registry

- `engine.styles.list()` returns installed styles with status and preview thumbnails.
- `engine.styles.get(id)` resolves `extends` chains (child overrides parent tokens,
  pacing, imagery and guide sections; max depth 4; cycles rejected).
- `engine.styles.accept(id)` sets `status: 'active'`; `remove(id)` deletes a non-built-in
  style (not while another style extends it); `create`, `trust` and `validate` back the CLI
  commands below. Trust is stored outside the style, in `<VOX_HOME>/trust.json`, with a hash
  of the style's code files; editing them withdraws it (D-34).
- CLI (in `packages/cli`):
  - `vox style validate <styleId>`: schema check, lint every template, render all
    fixtures to a contact sheet at `previews/contact.jpg`; each caption preset renders a
    sample `CaptionChunk[]` into the same sheet;
  - `vox style new <styleId> [--extends vox]`: scaffold a user style;
  - `vox style trust <styleId>`: allow its compile hooks, after a confirmation prompt;
  - `vox style extract …` (Part C).

## Part B — The `vox` style

Derived from the reference reel's frames (paper collage, cutouts with red outline,
yellow-on-blue maps, serif kinetic type, yellow label tags, black-boxed mono captions).
`extends: base`.

### Tokens

| Token | Value |
|---|---|
| colors.paper | `#EDE8DF` |
| colors.ink | `#141414` |
| colors.accent (red) | `#D7261E` |
| colors.highlight (yellow) | `#F5C518` |
| colors.sea (blue) | `#1D4FA0` |
| colors.dark (bg) | `#1B1A17` |
| fonts.display | a free serif with an editorial feel (candidates: Libre Caslon Display, DM Serif Display; pick during build by rendering both) |
| fonts.body | Libre Caslon Text or Source Serif 4 |
| fonts.caption | IBM Plex Mono or JetBrains Mono, uppercase |
| texture.paper | scanned paper texture, CC0, plus grain 0.15 |
| motion | easing `back.out(1.6)` for entrances, `power2.inOut` for camera; frameHold 2; jitterPx 2; entrance `pop` |
| pacing.beatMs | min 1200, target 2500, max 5000 |
| pacing.speakerRatio | 0.15 – 0.35 |
| imagery.searchHints | "vintage photograph", "archival", "black and white", "engraving" |
| imagery.generateSuffix | a torn paper collage look: flat craft-paper cutouts, rough white torn edges, hard shadows, beige paper background, not a photograph (D-101) |
| imagery.cutoutStroke | `#D7261E`, 10 px |

### Templates

Each template lists its main variables; all also accept `bg: 'paper' | 'dark' | 'highlight'`.

**v1 (built with Part A):**

| Template | Seen in reel as | Main variables |
|---|---|---|
| `paper-collage` | Bengaluru collage: cutouts scattered on paper, staggered pop-in, slow push-in | `items: {media, x, y, scale, rotate}[] (1–6)`, `label?`, `labelPos?` |
| `map-route` | yellow land on blue sea, black pin tags, route line drawn, zoom | `places: {name, lat, lon}[] (1–4)` (geo), `route: boolean`, `zoom: 'world' \| 'region' \| 'city'`, `palette: 'vox' \| 'paper'` |
| `kinetic-serif` | "without animating a single frame" word-by-word reveal | `text (≤ 60 chars)`, `emphasis: string[]` (words set larger), `align` |
| `stat` | "2 billion cups. Every single day." over faded photo | `value`, `line2?`, `bgPhoto?`, `tag?` |

**v1.1:**

| Template | Seen in reel as | Main variables |
|---|---|---|
| `year-card` | "1952" + blueprint line drawing + framed photo + yellow tag | `year`, `tag`, `photo`, `blueprint?` (image slot) |
| `framed-portrait` | halftone face, iris zoom into eye; gold frame + "GONE" stamp | `media`, `frame: 'none' \| 'gold' \| 'polaroid'`, `zoomTo?: {x, y}`, `stamp?`, `tag?`, `empty?` (the painting leaves the frame before the stamp, D-71) |
| `newspaper` | "LA JOCONDE A DISPARU" clipping slides in | `headline`, `subhead?`, `photo?`, `date?`, `language?` (BCP 47 tag, default `en`) |
| `stack` | 2–3 full-width 16:9 bands stacked vertically with thin dark gaps, each a mini-scene | `panels: {template, variables}[] (2–3)` (template slots), `bg?` |

`map-route` uses Natural Earth 1:50m country shapes (public domain) bundled as TopoJSON
in `styles/vox/assets/geo/`; its `build.mjs` projects them to SVG at compile time with
`d3-geo` and `topojson-client`, vendored as ESM in `templates/map-route/vendor/`. No tile
servers. `stack` mounts its panels as nested sub-compositions, depth 1; panel duration
equals the host's. Its `panelAspect: "16:9"` renders each panel at the canvas width and a 16:9
height (1080x608 in a 1080x1920 sequence), so panel templates use their landscape layout (D-71).

### Transitions

- `vox/paper-tear`: a torn-paper sheet wipes across the cut (cover style, no handles).
- `vox/slide-paper`: the next shot slides in on a paper card (cover style).
- Inherited from `base`: `crossfade`, `dip-to-black`.

### Overlays

- `vox/paper-grain` (default): grain at `texture.grain` plus a slight vignette.

### Caption presets

- `vox/mono-box` (default): mono, white on black box, 1–3 words, centred at 50 % height,
  cut on word (no fade). `case: 'upper'`, `stripPunctuation: true`. Unread and read
  words are white; the active word is yellow (`highlight`); emphasis words sit on a red
  (`accent`) box instead of black.
- `vox/serif-lower`: white serif with soft shadow at 78 % height, for full-collage
  sequences where the centre is busy. `case: 'asis'`, `stripPunctuation: false`.
  Unread words are at 60 % opacity; active and read words are full white; emphasis
  words are yellow (`highlight`).

Both use the default safe area (20 / 12 on 9:16) and the contract in Part A "Caption
presets" (plan D-15).

### SFX

Small set of real recordings (CC0, or recorded for the project): `paper-pop` (appear),
`paper-slide` (move), `whoosh` (move), `stamp` (land), `typewriter` (appear), plus one
`hero` sound (`thump-tap`: a low thump with a light tap, for a scene's one big reveal).
Template `sfxCues` reference these by name and type. The engine places them from the
timeline (engine "Sound cues") and mixes them into the final audio; the `sequence.sfx`
flag turns them off, and a scene's `sfxOff` mutes single cues. Every file is listed in
`assets/sfx/CREDITS.md` with its source and licence, and passes the SFX rules (Part A).

### Agent guide (`guide.md`)

Plain-language rules the agent (spec 3) loads with this style, e.g.:

- Open on the speaker (hook) unless the first line names a place, year or object.
- Cut to a scene when the speech mentions a place (`map-route`), a number (`stat`), a
  list of things (`paper-collage`), or a punchline (`kinetic-serif`). With v1.1: a year
  (`year-card`), a named person (`framed-portrait`), an event or headline
  (`newspaper`), parallel items (`stack`).
- Keep each scene within `pacing.beatMs`; keep speaker share within `speakerRatio`.
- Prefer archive images; generate only when the search yields nothing usable and an
  image provider is configured.
- Use `paper-tear` between speaker and collage beats; hard cuts inside collage runs.

The guide lists only templates that are installed, so v1 does not mention v1.1 ones.

### Quality bar

- Each template has at least 2 fixtures; `vox style validate vox` renders them all.
- A side-by-side sheet (reference reel frames vs our fixture frames) is produced during
  the build and reviewed by the user before Part B is accepted.

## Part C — Style from a reference video

User story: "Here is a video whose look I like. Make a style from it." Input: a URL or
file. Output: a new draft style in `~/.vox/styles/<id>/` with `source.type: 'extracted'`,
`status: 'draft'`, `trusted: false`. Scope is a **re-skin**: new tokens, pacing,
captions, overlays and guide over existing templates. No new templates in this version.

### Pipeline (`vox style extract <url|file> --name <id>`, also an agent job)

1. **Ingest** the reference into a scratch project (engine `ingest` with
   `{ proxies: false }`).
2. **Measure** (no LLM):
   - Shot boundaries from the engine `shots` stage (ffmpeg `scdet`) → shot list,
     average shot length → `pacing.beatMs`.
   - Keyframes: one per shot plus one per 2 s → contact sheets.
   - Colour palette: k-means (k = 8) over keyframes → candidate colour tokens.
   - Speaker share: faces detected per shot (engine `facetrack`) → `speakerRatio`.
   - Caption timing: on-screen text via Apple Vision OCR (`VNRecognizeTextRequest`
     through `pyobjc-framework-Vision`, MIT) on keyframes at 4 fps; text regions over
     time → words per caption, position, case. `pyobjc-framework-Vision` is already a
     v1 dependency (facetrack saliency, plan D-15), so Part C adds no Python package
     for OCR.
3. **Describe** (vision LLM via the agent's provider config, spec 3): send contact
   sheets plus measurements and ask for structured JSON: font classification (serif /
   sans / mono, weight, case), caption look, motion vocabulary (frame hold, entrances,
   camera moves), recurring layouts, texture, and which existing templates each
   recurring layout resembles.
4. **Map** the description onto a style:
   - tokens from measurements + description; fonts mapped to the closest bundled free
     font (a local catalogue of ~40 OFL fonts with tags);
   - `extends` the closest base style; picks its caption preset and overlays and
     lists layouts with no matching template;
   - `guide.md` drafted from the description.
5. **Report**: `report.html` with reference frames beside our renders of every
   template's fixtures in the new style, the extracted tokens, and unmatched layouts.

### Limits stated to the user

- The result approximates the reference's look; it does not copy its footage, images
  or brand marks. The reference is used for analysis only and never placed in the
  style's assets.
- Fonts are matched to free fonts, so lettering will differ when the original uses a
  commercial typeface.
- Layouts that no existing template matches are listed, not built.

### v2 (not in this spec's scope)

LLM-authored templates for unmatched layouts, with lint, render and compare-with-
reference repair loops. They would run untrusted (no `build.mjs`).

## Testing

- **Schema tests**: `style.json` / `template.json` / `captions/<preset>.json`
  validation, `extends` resolution,
  cycle rejection, built-in id collision rejected, template identity through a chain,
  `TEMPLATE_VERSION` and migration.
- **Template tests**: lint + render every fixture of every built-in template (draft
  quality); assert no missing assets, non-blank frames, and longest-text fixtures stay
  inside the safe area (bounding-box check via the composition's DOM).
- **Token scoping**: in a `vox` sequence, a `base` template's instance file carries
  `vox` tokens; in a `base` sequence, a `vox` template's instance file carries `vox`
  tokens.
- **Hooks**: an untrusted style with `build.mjs` compiles with `HOOK_UNTRUSTED` instead
  of running it; a trusted parent's template used through an untrusted child style still
  runs its hook.
- **Part C**: measurement steps on a fixture video with known cuts, colours and burnt-in
  captions; LLM steps with a mocked model returning fixed JSON.
- **SFX (plan D-14)**: the kit check passes on every built-in style's SFX and fails on
  generated bad samples (sine beep, noise bed, click at start, two hits in one file);
  `CREDITS.md` lists every file.
- **Cue timing**: for every template fixture with `sfxCues`, the rendered frames are
  measured (per-frame pixel difference): a `cut` or `appear` cue sits within 1 frame of a
  difference spike, a `land` cue within 1 frame of where motion falls below the
  threshold, a `move` cue within 2 frames of peak motion.
- **Caption presets (plan D-15)**: every built-in preset, `base/plain` included, renders
  a fixture `CaptionChunk[]` (two lines, one emphasis word, a 200 ms gap) on 9:16:
  - active word: at a frame inside word 2's time, word 2 has the active look and words 1
    and 3 have the read and unread looks (computed styles from the composition's DOM,
    plus a pixel check of the word boxes); the same frame reached by seeking backwards
    is byte-identical;
  - emphasis: the emphasis word has its own look at every state;
  - gap: in the 200 ms gap after chunk 1 no caption text is visible (D-91);
  - safe area: every word box stays above `100 − bottomPct` and inside the
    `rightPct` margins, also with `position.yPct` set to 95;
  - `case` and `stripPunctuation` change the injected text and SRT export does not
    change.
- **`minEntranceMs`**: a fixture template with `minEntranceMs: 2000` rendered at 1500 ms
  shows its resting state at frame 0 (every element the entrance animates has its final
  opacity and transform, read from the DOM); rendered at 3000 ms, frame 0 differs from
  the 1500 ms frame 0 (the entrance runs). A variables schema that declares
  `skipEntrance` fails `vox style validate`.

## Done when

1. Parts A and B (v1): `vox style validate vox` passes (including the SFX rules and cue
   timing); the 4 v1 templates, 2 transitions, overlay and 2 caption presets render; the
   user approves the side-by-side sheet against the reference reel and, by ear, the
   five `LISTEN.md` timecodes of the sheet's audio QA.
2. A sequence can mix `vox` and `base` templates and compile.
3. v1.1: the remaining 4 templates pass the same bar.
4. Part C: from a user-chosen reference video it produces a draft style plus
   `report.html`. In a blind A/B (the same clip rendered in `vox` and in the extracted
   style, order randomised), the user picks the extracted style as closer to the
   reference.
