# Phase 08 — App shell + security + GATE 4

| Field | Value |
|---|---|
| Track | app |
| Prereq | 01 (GATE 1), 03 |
| Spec § | app "Architecture", "Window security", "Untrusted HTML (`vox-media://`)", "Engine-host API", "Timeline implementation" (gate), "Error handling" (engine-host restart), "Testing" (main / engine-host) |
| Model | Opus 5.5 · high |
| Gate | **GATE 4** (timeline benchmark) as the first UI task |
| Next | 09 |

## Goal

A secure, empty desktop app: the window, both custom schemes with their CSPs, the engine running in a
`utilityProcess`, and the typed `window.vox` bridge, all proven by the security tests. Before any editor
UI, GATE 4 decides whether the timeline uses `@xzdarcy/react-timeline-editor` or a custom canvas.

## Required reading

- App spec sections above; `spike/electron/` (the proven protocol + CSP setup) and the GATE 1 decision.
- `plan/ref/R4-security.md` rows S1, S10–S15, S28; R1 app tree; R2 `window.vox` and path-rule rows.

## Output

- `apps/desktop` scaffold: electron-vite, React 19, Zustand, Tailwind + shadcn/ui, pinned Electron (same as spike).
- `src/main/`: window with the security flags; `vox-app://` (bundled files) with the app CSP incl.
  `frame-ancestors 'none'` (S28); `vox-media://`
  (`standard`, `secure`, `stream`, `corsEnabled: false`) with the path rule imported from
  `@vox/engine/paths` (main never imports the engine main entry),
  HTML CSP, `attachment` + `nosniff` for non-media, range requests; navigation and `window.open` denied;
  external links via an allowlist; renderer `http(s)` blocked at the session; permission requests denied.
- `src/engine-host/`: `utilityProcess` running `openEngine`; `MessagePort` to main; restart on crash
  with a banner and project reload.
- `src/shared/api.ts`: the one zod schema for every `window.vox` method and event (app spec table);
  `src/preload/` generated typed bridge; main validates args and sender for every call.
- Player component: `<hyperframes-player>` with `sandbox-origin` per GATE 1, pointed at `preview.url()`.
- `apps/desktop/bench/timeline.ts` + a throwaway prototype for GATE 4.
- Security tests (main / engine-host) from the app spec "Testing".
- Skeleton packaging: minimal electron-builder config (ad-hoc signed, arm64 `.dmg`) that phase 09 extends.

## Steps

### A. GATE 4 first (timeline library)

1. [ ] Benchmark: 1,000 items on 8 tracks, drag and trim, measure fps on the M5 (≥ 50 required).
2. [ ] Prototype on the benchmark data, using only the library's public props and events (no fork or
       patch of its source): dragging one clip of a linked V1/A1 pair moves both, with equal `startMs`
       after the drop; a marquee over 50 items selects exactly those 50. Both are automated checks.
3. [ ] Pass = fps ≥ 50 and both prototype checks pass (app spec "Timeline implementation"). Write
       numbers + verdict to the log and a DECISIONS entry. STOP for the owner only if it fails or lands
       within 10 % of the bar (README §5); otherwise continue.

### B. Shell and security (tests first)

4. [ ] IPC: call from a subframe → rejected; from a non-`vox-app://` sender → rejected; invalid args →
       zod error (S11).
5. [ ] `vox-media://`: CSP header on HTML incl. `connect-src 'none'`; `attachment` + `nosniff` on other
       types; range request returns 206; traversal rejected (encoded `..`, absolute, NUL, symlink out) (S1, S13).
6. [ ] Hostile template fixture: `fetch('https://example.com')`, `parent.vox`, `window.top.location` all
       get nothing (S14).
7. [ ] Renderer `fetch('https://…')` blocked; `will-navigate` and `window.open` denied; permissions
       denied; window `webPreferences` asserted (`contextIsolation`, `sandbox`, `nodeIntegration: false`,
       `nodeIntegrationInSubFrames: false`, `webSecurity`); `vox-app://` responses carry the app CSP with `frame-ancestors 'none'`; external
       links open only for allowlisted hosts (S10, S12, S15, S28).
8. [ ] Engine host: projects list/create/open, `ops.apply` with `baseVersion`, events forwarded; crash
       → restart + reload + banner.
9. [ ] Minimal UI: project picker + a preview pane playing the 90 s fixture build from `vox-media://`.
       Playwright for Electron smoke test `e2e/smoke.spec.ts`: the app starts, opens the fixture, the player's
       current time advances during play, no console errors.
10. [ ] Skeleton `.dmg`: minimal electron-builder config, ad-hoc signed arm64; `pnpm dist` builds it and
        the app launches from `/Applications` on this account. MANUAL STEP (owner, optional — does not block
        merge): open it once on the second account to surface Gatekeeper issues early (phase 09 has the
        required run).

## Verify

```bash
pnpm -C apps/desktop test
pnpm -C apps/desktop bench:timeline
pnpm -C apps/desktop e2e -- smoke             # app starts, fixture plays in the preview pane
pnpm -C apps/desktop test:slow -- security    # S10–S15, S28 against the built app
```

## Done when

- [ ] GATE 4 decided (DECISIONS entry with numbers).
- [ ] All main / engine-host security tests pass incl. S28 (part of app done-when #4).
- [ ] Skeleton `.dmg` builds and launches.
- [ ] The fixture build plays in the app under the production CSP and sandbox mode.
- [ ] `window.vox` schema frozen once phase 05 is also done (it wraps the engine API, which freezes after
      05); additive changes only after that. PROGRESS milestone marked when both hold.

## Risks and fallback

| Risk | Fallback |
|---|---|
| GATE 4 fails | Phase 10a builds a custom canvas timeline (same store and ops); 10a's scope grows, its done-when stays |
| `utilityProcess` cannot spawn uv/ffmpeg with the right env | Pass explicit `ToolPaths` (engine `openEngine` option) and a minimal env |

## Handoff notes

- Phase 09 adds setup, full resources and fuses to this shell and the skeleton packaging config;
  phase 10a builds the editor on the GATE 4 choice.
