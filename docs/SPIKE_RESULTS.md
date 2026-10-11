# Spike results (phase 01, GATE 1)

Measured 2026-10-11 on the M5 (10 cores, 24 GB, macOS 27.0.1) with HyperFrames 0.8.145
(`hyperframes` CLI + `@hyperframes/player`), GSAP 3.15.0, Electron 44.7.0 (Chromium
152.0.7977.130) and the HyperFrames Chrome headless shell 152.0.7977.30. Every timing ran under the
bench lock. Other phases were running during attempts 1–3 (load averages 7–14 on 10 cores); the
final run (`pnpm -C spike bench:all`) had load averages 5.7–11.9. Rerun: `spike/README.md`.

Evidence: `docs/evidence/phase-01/` (final run at the top level; earlier preview attempts in
`attempt1-opaque/` and `attempt2-opaque/`).

**GATE 1 outcome: all pass.** HyperFrames renders whole sequences; preview runs in the opaque
sandbox (no `allow-same-origin`, no Preview fallback); NTSC go; heavy-scene fps margin 20.8 %, so
no pre-render cache.

## Pass bar

| # | Item | Result | Numbers (final run) | Evidence |
|---|---|---|---|---|
| 1 | Cut accuracy | pass | 2700/2700 frames, 43 cuts (incl. the VFR phone clip via its CFR copy), 2145 frames read, 0 mismatches, 0 grey/black frames | `B5-cuts.json` |
| 2 | A/V sync | pass | 21 flash/click pairs, max \|offset\| 0.35 ms, mean 0.09 ms (bar < 33.3 ms) | `B6-avsync.json` |
| 3 | Render speed | pass | 60.5 s for 90 s at `--quality draft --strict-all` = 0.67× real time (bar ≤ 5×, 450 s); attempt 2: 83.1 s, 0.92× at load 13.9 | `B7-render.json` |
| 4 | Preview (opaque) | pass | min fps 26.4 over 1 s windows (bar 24), max stall 83 ms (bar 200); seek to a cut: 80 seeks, 0 wrong frames, max 53 ms (bar 300); picture vs clock p95 16.3 ms, `<audio>` vs clock p95 0 ms during play; after 8 seek + play cycles picture p95 23.8 ms, audio p95 0 ms (bar 33.3); 0 network requests | `B9-preview-opaque.json`, `B10-seek-opaque.json` |
| 5 | Memory | pass | peak RSS of the render tree 2.07 GB (bar 12 GB) | `B8-memory.json` |
| 6 | Op → preview | pass | scene-only patch: p50 27 ms, max 31 ms; full reload: p50 719 ms, max 757 ms (both < 1 s) | `B11-op-preview-opaque.json` |
| 7 | Mechanisms | pass | see below | `B12-mechanisms-render.json`, `B12-mechanisms-preview-opaque.json` |
| 8 | Fillers | recorded | see below | `B-fillers.json` |
| 9 | NTSC 30000/1001 | pass | 540/540 frames, 10 cuts, 0 mismatches; 7 pairs, max \|offset\| 0.4 ms (frame 33.37 ms); render 15.1 s for 18 s | `B-ntsc.json` |
| — | Heavy-scene fps margin | 20.8 % | lowest 1 s window: `stack` 30 fps, video slot 29 fps → 29 fps = 20.8 % above 24 (same in attempts 2 and 3) | `B-fps-margin-opaque.json` |

### Preview attempts (item 4)

| Attempt | Load (1 min) | Min fps | Max stall | Seek max | Picture p95 after seeks | Result |
|---|---|---|---|---|---|---|
| 1 | 11.0 | 23.0 | 1034 ms | 1040 ms | 45.8 ms | fail |
| 2 | 7.3 | 28.2 | 83 ms | 44 ms | 27.7 ms | pass |
| 3 (margin within 10 % of its bar: re-run) | 8.6 | 28.0 | 84 ms | 67 ms | 26.4 ms | pass |
| final (`bench:all`) | 9.8 | 26.4 | 83 ms | 53 ms | 23.8 ms | pass |

Between attempts 1 and 2:
- The 1034 ms "stall" was a measuring error. The pre-cue (below) shows a clip's first frame up to
  1 s before the clip starts, while the clip is still hidden. The analysis counted that frame as
  on screen. Frames now count only once the clock is within one frame of them.
- Seek outliers (about 1 in 40 seeks, about 1.03 s): the runtime hides inactive clips with
  `visibility:hidden`. A paused `<video>` that became visible again after a seek kept showing an
  older picture of that element for about 1 s. rVFC already reported the right frame. The preview
  build now keeps inactive videos visible at opacity 0 (`vox-preview.js`); 0 outliers in 240 seeks
  since.
- Attempt 1's 23 fps window and the post-seek picture lag did not recur at the lower load; no change
  was made for them.

The same-origin rerun (plan step 12) was not needed.

### Item 6: patch vs reload

The scene-only patch (`player.setRuntimeData('vox-patch', …)` remounts one instance file in place)
is about 25× faster than a full reload. A reload costs about one template mount per scene: the
runtime mounts inline templates after the player's `ready` event, and a seek sent earlier is lost,
so `vox-preview.js` re-seeks to the saved playhead (`vox-playhead`) once every scene is mounted.

### Item 7: mechanisms

| Mechanism | Render | Preview |
|---|---|---|
| `data-vox-vars` with 8 scenes + 2 nested panels mounted (10 instances) | works (worst colour distance 4) | works (4) |
| scoped `--tok-*` tokens per instance | works (3) | works (1) |
| muted `<video>` + separate `<audio>` | works (click amplitude 0.977 × source, no doubled audio) | works (50 muted videos, 49 audios) |
| GSAP volume tween on `<audio>` (1 → 0.1) | works (ratio 0.406, expected 0.4) | works (gain 0.4 at 88 s; the runtime routes `<audio>` through WebAudio, so `el.volume` reads 1 and the gain node carries the tween) |

### Item 8: fillers (recorded only)

`speech-fillers.wav` (spoken: one "um", one "uh", one repeat) with mlx-whisper 0.4.3 and
`mlx-community/whisper-large-v3-turbo`: both "um" and "uh" survive with and without the filler
`initial_prompt` (the repeat survives too). Without the prompt the text has no
punctuation or capitals; with it, it does. For phase 04: the prompt is not needed to keep fillers on
this fixture, but it gives punctuation.

## Findings for later phases

- **Frame-exact preview seeks need a +1 ms video bias.** Chromium stores `currentTime` as truncated
  whole microseconds, so a seek to exactly `k/30` showed frame k−1 in 17 of 40 seeks. Preview builds
  write `data-media-start` 1 ms late for video (render and audio stay exact).
- **Runtime media sync tolerances (HyperFrames 0.8.145):** a paused element is re-seeked only when it
  is more than 0.5 s off on the first sync, or 40 ms off for two ticks. `vox-preview.js` adds:
  pre-cue (park the next clip on its in-point 1 s ahead, else in-points under 0.5 s start from 0)
  and paused exact-frame sync (hold active videos within half a frame while paused, else a clip
  parked on its out-point shows one frame too late).
- **Template mount is asynchronous after `ready`.** See item 6; `vox.mount` claims each instance's
  marker so two instances of one template never share a mount.
- **Lint:** the render builds lint clean (`lint --json`: 0 errors, 0 warnings). The preview build
  (inline templates) reports `gsap_timeline_not_registered` and `composition_file_too_large`;
  lint cannot see registration inside inline templates. The preview build is never rendered.
- **CLI flags as in the spec:** `lint --json`, `render --strict-all`, `--quality draft`,
  `--format mov` all exist in 0.8.145.
- The `vox-preview.js` helpers depend on runtime internals: the `visibility: hidden` inline style,
  the out-point parking, the sync tolerances. Re-run the spike on every HyperFrames upgrade
  (`pnpm -C spike bench:all`).
