# Phase 01 — Spike + GATE 1

| Field | Value |
|---|---|
| Track | engine (+ a minimal Electron window) |
| Prereq | 00 |
| Spec § | engine "Spike (first implementation task)"; app "Untrusted HTML (`vox-media://`)", "Window security", "Preview pipeline" |
| Model | Opus 5.5 · high |
| Gate | **GATE 1** at the end |
| Next | 03 (needs GATE 1); 02 may already run in parallel |

## Goal

Prove or disprove, with numbers, that HyperFrames can render and preview a video-heavy 90 s 9:16
sequence inside the exact Electron security setup the app will use. GATE 1 then fixes three decisions:
export path (whole-sequence vs hybrid), preview strategy, and player sandbox mode. It also records two
D-15 results: NTSC (30000/1001) go or integer-rate fallback, and whether the preview pre-render cache is
needed (heavy-scene fps margin under 20 %).

## Required reading

- Engine spec "Spike" (pass bar 1–9 and outcomes; items 8 and 9 and the fps margin are D-15),
  "Compile" (instance files, `vox.vars`, tokens, DOM order), "Ingest analysis" (how the CFR copy is made).
- App spec "Window security" and "Untrusted HTML" (both CSPs, scheme flags).
- HyperFrames docs for the pinned version: composition format, `data-start`/`data-duration`/`data-media-start`,
  sub-compositions, `lint --json`, `render --strict-all`, `--quality`, `--format mov`, `@hyperframes/player`
  attributes (`sandbox-origin`).

## Output

- `spike/` (not shipped; its own `package.json`, added to `pnpm-workspace.yaml`):
  - `spike/make-project.ts`: builds the 90 s fixture composition by hand (≥ 40 V1 cuts of one source,
    8 scenes incl. a stand-in `stack` with 2 nested panels and one video-slot scene, an image with
    push-in, a crossfade, captions, A1 linked audio, and cuts of the VFR phone-style clip
    `phone-vfr-20s.mp4` on V1 through a CFR copy the script makes with the engine spec's ffmpeg
    arguments; D-15). Hand-written HTML; no engine yet. A second variant at 30000/1001 with
    `ntsc-2997-20s.mp4` on V1 (item 9, D-15).
  - `spike/electron/`: minimal Electron app on the pinned version: renderer page on `vox-app://`, build
    served from `vox-media://` with range requests and the exact CSPs from the app spec, player with
    `sandbox-origin="opaque"`, vendored runtime + GSAP, no CDN.
  - `spike/bench/`: scripts for each pass-bar item, each printing JSON.
  - `spike/README.md`: how to rerun the spike (used again on every HyperFrames upgrade).
- `docs/SPIKE_RESULTS.md`: table of the 9 pass-bar items: result, numbers, evidence path, notes; plus the
  mechanism checks of item 7, the patch-vs-reload numbers of item 6, the heavy-scene fps margin, the
  filler counts of item 8 and the NTSC result of item 9 (D-15; evidence per R7).
- Engine spec "Spike" section updated with the pinned HyperFrames version and the measured numbers.
- R5: HyperFrames and Electron pins.
- DECISIONS entry with the GATE 1 result: the outcome selected by the numbers (D-10).

## Steps

### A. Build the fixture (agent)

1. [ ] Install the candidate HyperFrames version (0.8.145) and its Chrome; confirm CLI flags exist as the
       spec says (`lint --json`, `render --strict-all --quality draft`, `--format mov`). Record any difference.
2. [ ] `make-project.ts` writes `spike/out/project/` from `spike-source-1080p.mp4` (proxy + original) and
       `phone-vfr-20s.mp4` (its CFR copy + proxy from the copy; D-15); the NTSC variant writes
       `spike/out/project-ntsc/`.
3. [ ] Per-instance scene files with `<script type="application/json" data-vox-vars>` and a tiny
       `vox-runtime.js` (`vox.vars(el)` via `closest('[data-composition-id]')`); `--tok-*` scoped styles.
4. [ ] `npx hyperframes lint --json` reports zero errors.

### B. Measure (agent; numbers on the M5)

Each item gets up to 3 measurement attempts; fixing the measuring script between attempts is allowed.
An item still unmeasured after the third attempt counts as failed (engine spec "Spike", D-10).

5. [ ] **Cut accuracy** (item 1): render draft; extract frames at every cut ±1 with ffmpeg; read the
       burnt-in counter (pixel diff vs reference frames); no ±1 errors, no grey/black frames. This
       includes the cuts on the VFR clip, read from its own counter (D-15).
6. [ ] **A/V sync** (item 2): detect click onsets in the muxed audio vs flash frames; < 1 frame.
7. [ ] **Render speed** (item 3): wall time at `--quality draft`; ≤ 5× real time (≤ 7.5 min).
8. [ ] **Memory** (item 5): peak RSS of the render process tree < 12 GB.
9. [ ] **Preview** (item 4) in `spike/electron/`: fps ≥ 24, no stall > 200 ms over a full play, seek to a
       cut shows the right frame within 300 ms; `<audio>` inside the composition stays within 1 frame
       of picture during play and after seeks (opaque mode drops the parent audio proxy). Also record
       the **heavy-scene fps margin** (D-15): the lowest fps over any 1 s window while the `stack`
       scene and the video-slot scene play, as a percentage above 24 fps; recorded even when item 4
       passes (`B-fps-margin.json`).
10. [ ] **Op → preview** (item 6): simulate one `trimItem` (edit the in-memory build), measure to
        visible update for (a) scene-only patch (replace one instance file + remount) and (b) full reload.
11. [ ] **Mechanisms** (item 7): 8 scenes mounted at once each read their own vars; scoped tokens;
        muted `<video>` + separate `<audio>`; GSAP volume tween on `<audio>`. Record works / does not work.
12. [ ] If item 4 fails only in opaque mode: rerun with `allow-same-origin` on `vox-media://` and record.
12b. [ ] **Fillers** (item 8, recorded, not a pass condition; D-15): `spike/bench/fillers` transcribes
        `speech-fillers.wav` with mlx-whisper (candidate repo `mlx-community/whisper-large-v3-turbo`, run
        through `uv run --with`, not added to `py/`) with and without an `initial_prompt` that contains
        fillers; record how many "um"/"uh" survive in each (`B-fillers.json`).
12c. [ ] **NTSC rate** (item 9; D-15): render the 30000/1001 variant; cut accuracy (item 1 method, on the
        29.97 source's counter) and A/V sync (item 2 method) must hold (`B-ntsc.json`).

### C. GATE 1 (decided by the numbers, D-10)

13. [ ] Write `docs/SPIKE_RESULTS.md` and select the outcome from the engine spec "Spike" list:
        - all pass → whole-sequence render;
        - 1, 3 or 5 fail → hybrid export through the layer renderer (phase 03 builds it as the export path);
        - 2 fails → re-measure with silent picture + ffmpeg-mixed click track; still failing counts as item 1;
        - 7 fails → the per-mechanism alternative from the spec, written into engine "Compile";
        - 4 fails in both sandbox modes, or 6 fails → the app spec "Preview fallback" (already written;
          no new design);
        - 4 fails only in opaque mode and passes with `allow-same-origin` (step 12) → item 4 passes with
          the sandbox fallback; the Preview fallback is not used;
        - 9 fails (HyperFrames cannot render 30000/1001 frame-exactly) → NTSC fallback: `canvas.fps`
          keeps only the integer rates and NTSC sources conform to the nearest integer rate through the
          CFR copy (D-15); 9 passes → NTSC go;
        - 4 passes but the heavy-scene fps margin is under 20 % → the pre-render cache is built (by 10a,
          app spec "Preview pipeline"); 20 % or more → no cache (D-15).
        Item 8 selects nothing; its counts go to phase 04 (transcribe `initial_prompt`).
14. [ ] Record the result as a DECISIONS entry (GATE 1), update the engine spec "Spike" (version +
        numbers, fps margin, filler counts, NTSC result) and, if 7 failed, "Compile"; if 9 failed, the
        engine spec "Time and the frame grid" (integer rates only; D-15); mark the app spec "Preview fallback" as active if 4 failed in
        both sandbox modes or 6 failed. Add the result to TODO's gate table for the owner to read (no answer needed; the owner may
        overrule later). Continue to step 11 of PROMPT (merge).

## Verify

```bash
pnpm -C spike bench:all          # prints one JSON line per pass-bar item (1–9) plus the fps margin
npx hyperframes lint --json spike/out/project | jq '.errors | length'   # 0
```

## Done when

- [ ] All 9 items have a recorded result and numbers (fail is a valid result; item 8 is recorded only).
- [ ] Patch vs reload latency recorded.
- [ ] Heavy-scene fps margin recorded; GATE 1 states NTSC go or fallback and pre-render cache needed or
      not (D-15).
- [ ] GATE 1 decision recorded in DECISIONS; engine spec "Spike" has the pinned version and numbers.
- [ ] `spike/README.md` lets a future upgrade rerun everything with one command.

## Risks and fallback

| Risk | Fallback |
|---|---|
| Many `<video>` elements on one file stutter in preview | Test a pooled-video strategy (one `<video>` per source, seek on cut) and record it as the preview option |
| CDN auto-injection cannot be disabled | Patch via the player's documented option; else serve runtime from `vox-media://` and record |
| Opaque sandbox breaks playback | Documented fallback `allow-same-origin` on `vox-media://` (still no preload, no IPC, `connect-src 'none'`) |
| Render > 7.5 min | Hybrid export; preview unaffected |
| HyperFrames cannot render 30000/1001 frame-exactly | NTSC fallback from the spec: integer rates only, NTSC sources conformed through the CFR copy (D-15) |

## Handoff notes

- Phase 03 implements compile exactly as the spike's hand-written HTML proved (layer order, vars, tokens,
  vendored runtime), plus the export path chosen at GATE 1.
- Phase 08 copies the spike's protocol + CSP setup into the real app.
- Phase 03 drops the 1001 rates if item 9 failed; phase 04 uses the item 8 counts and makes CFR copies
  as the spike did; phase 10a builds the pre-render cache only if the margin is under 20 % (D-15).
