# Phase log format

The AI creates `log/phase-NN.md` when it starts a phase and keeps it current while it works.
If a session ends mid-phase, the next session resumes from this file.

```markdown
# Phase NN — <title>

| Field | Value |
|---|---|
| Status | in progress / waiting for GATE n / waiting for manual step / done |
| Started · Finished | YYYY-MM-DD HH:MM · YYYY-MM-DD HH:MM |
| Model | e.g. Opus 5.5 · high |
| Machine | e.g. M5, macOS 27.0 |
| Branch | phase/NN-<slug> |
| Resume from | step x (only when stopped mid-phase) |

## Pre-check
Prerequisites [x] in PROGRESS, open decisions read, tools present (versions).

## Plan summary
≤ 15 lines, plus the test order.

## Checklist
- [x] A1 …
- [ ] A2 …

## Files created / changed
## Verify results
| Command | Result | Numbers |
|---|---|---|

## Done when
| # | Item | Evidence |
|---|---|---|

## Review findings
| Agent | Severity | Finding | Fixed? |
|---|---|---|---|

## Deviations
Each with a link to its D-NN.

## MANUAL STEPS
Numbered, copied to plan/TODO.md.

## Handoff notes
What the next phases must know.
```
