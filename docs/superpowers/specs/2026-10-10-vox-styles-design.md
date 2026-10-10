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
  overlays/<name>.html       # full-frame overlays (grain, vignette, paper edge)
  assets/                    # textures, fonts (OFL), sfx (CC0 or original)
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
      entrance: string                   // e.g. 'pop'; templates fall back to 'fade' if unknown
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
  sfx: Record<string, string>   // name → asset path, e.g. "pop": "assets/sfx/paper-pop.wav"
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
  sfxCues?: { atMs: number | 'entrance'; sfx: string }[]
  blendsShots?: boolean      // transitions: needs source handles (e.g. crossfade)
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

### Template rules

- Pure HyperFrames composition; all timing derives from the frame number (no
  `setTimeout`, no `Date.now`, no network at render time).
- `npx hyperframes lint --json` reports zero errors, and fixtures render with
  `render --strict-all`.
- Must render every fixture without missing assets.
- Text variables declare `maxLength`; a test renders the longest fixture and checks the
  text's bounding box stays inside the 1080×1920 safe area.
- Fonts and textures ship inside the style folder; no CDN at render time.
- Every built-in style ships `previews/` generated by `vox style validate`.

### Style registry

- `engine.styles.list()` returns installed styles with status and preview thumbnails.
- `engine.styles.get(id)` resolves `extends` chains (child overrides parent tokens,
  pacing, imagery and guide sections; max depth 4; cycles rejected).
- `engine.styles.accept(id)` sets `status: 'active'`; `remove(id)` deletes a non-built-in
  style.
- CLI (in `packages/cli`):
  - `vox style validate <styleId>`: schema check, lint every template, render all
    fixtures to a contact sheet at `previews/contact.jpg`;
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
| imagery.generateSuffix | "vintage halftone photograph, isolated object, plain background, high contrast" |
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
| `year-card` | "1952" + blueprint line drawing + framed photo + yellow tag | `year`, `tag`, `photo`, `blueprint?` |
| `framed-portrait` | halftone face, iris zoom into eye; gold frame + "GONE" stamp | `media`, `frame: 'none' \| 'gold' \| 'polaroid'`, `zoomTo?: {x, y}`, `stamp?` |
| `newspaper` | "LA JOCONDE A DISPARU" clipping slides in | `headline`, `subhead?`, `photo?`, `date?`, `language` |
| `stack` | 2–3 panels stacked vertically, each a mini-scene | `panels: {template, variables}[] (2–3)` (template slots) |

`map-route` uses Natural Earth 1:50m country shapes (public domain) bundled as TopoJSON
in `styles/vox/assets/geo/`; its `build.mjs` projects them to SVG at compile time with
`d3-geo` and `topojson-client`, vendored as ESM in `templates/map-route/vendor/`. No tile
servers. `stack` mounts its panels as nested sub-compositions, depth 1; panel duration
equals the host's.

### Transitions

- `vox/paper-tear`: a torn-paper sheet wipes across the cut (cover style, no handles).
- `vox/slide-paper`: the next shot slides in on a paper card (cover style).
- Inherited from `base`: `crossfade`, `dip-to-black`.

### Overlays

- `vox/paper-grain` (default): grain at `texture.grain` plus a slight vignette.

### Caption presets

- `vox/mono-box` (default): uppercase mono, white on black box, 1–3 words, centred at
  50 % height, cut on word (no fade).
- `vox/serif-lower`: white serif with soft shadow at 78 % height, for full-collage
  sequences where the centre is busy.

### SFX

Small original or CC0 set: `paper-pop`, `paper-slide`, `whoosh`, `stamp`, `typewriter`.
Template `sfxCues` reference these. The engine mixes them into the final audio; the
`sequence.sfx` flag turns them off.

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
   - Shot boundaries via ffmpeg scene detection → shot list, average shot length
     → `pacing.beatMs`.
   - Keyframes: one per shot plus one per 2 s → contact sheets.
   - Colour palette: k-means (k = 8) over keyframes → candidate colour tokens.
   - Speaker share: faces detected per shot (engine `facetrack`) → `speakerRatio`.
   - Caption timing: on-screen text via Apple Vision OCR (`VNRecognizeTextRequest`
     through `pyobjc-framework-Vision`, MIT) on keyframes at 4 fps; text regions over
     time → words per caption, position, case.
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

- **Schema tests**: `style.json` / `template.json` validation, `extends` resolution,
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

## Done when

1. Parts A and B (v1): `vox style validate vox` passes; the 4 v1 templates, 2
   transitions, overlay and 2 caption presets render; the user approves the
   side-by-side sheet against the reference reel.
2. A sequence can mix `vox` and `base` templates and compile.
3. v1.1: the remaining 4 templates pass the same bar.
4. Part C: from a user-chosen reference video it produces a draft style plus
   `report.html`. In a blind A/B (the same clip rendered in `vox` and in the extracted
   style, order randomised), the user picks the extracted style as closer to the
   reference.
