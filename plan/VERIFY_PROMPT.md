# Verify prompt — review the whole plan (read-only)

Paste the block below into any AI (Claude Code, Codex, …) at the repo root.

```text
<role>
You are an independent technical reviewer for "Vox Studio", a free, local, open-source agentic video
editor for macOS (Electron app, shared as a .dmg). Your job is to READ, UNDERSTAND and VERIFY the
plan. Do not create, change or delete any file. Do not commit. Do not run builds or installs.
Answer in English.
</role>

<reading>
Read in order and in full:
1. docs/superpowers/specs/2026-10-10-vox-studio-overview.md
2. docs/superpowers/specs/2026-10-10-vox-engine-design.md
3. docs/superpowers/specs/2026-10-10-vox-styles-design.md
4. docs/superpowers/specs/2026-10-10-vox-agent-design.md
5. docs/superpowers/specs/2026-10-10-vox-app-design.md
6. plan/README.md, plan/PROMPT.md, plan/PROGRESS.md, plan/TODO.md
7. plan/log/DECISIONS.md (newer decisions beat older text)
8. plan/phase-00 … plan/phase-15 (all, incl. phase-10a, phase-10b and the 14a–14g sub-phases
   inside phase-14)
9. plan/ref/R1 … R7 (all)
10. docs/research/2026-10-10-capcut-engine-teardown.md and
    docs/research/2026-10-10-capcut-agent-teardown.md (background for D-15: a static analysis of
    CapCut 9.4.1; they are evidence, not specs, and the specs win where they differ)
</reading>

<verify>
A. UNDERSTANDING. In your own words: the product, the four sub-projects, the build order, and the gates.
B. COVERAGE. Every "Done when" item and every "Testing" bullet in the five specs is owned by exactly
   one phase. List any that no phase owns, and any phase step that no spec asks for.
C. CONSISTENCY. Contradictions between specs and plan files, e.g. phase order vs overview build order,
   names (ops, events, error codes, CLI commands, schemes), versions in R5 vs specs, file paths vs R1.
D. DEPENDENCIES. Does each phase have everything it needs from earlier phases? Is the mermaid graph
   in README §4 the same as the "Prereq" column and each phase header?
E. GATES. Is each gate decidable from the evidence the phase produces? Is the fallback concrete?
F. SECURITY. Is every invariant in R4 tested in some phase's "Verify" section?
G. AUTOMATION. Can plan/PROMPT.md auto mode run without a human between gates? List ambiguous steps.
H. TEARDOWN. Every change proposed in the comparison sections of the two research reports is either
   in the specs as D-15 describes, or listed in D-15 as deferred. List any that is in neither, and
   any D-15 item that no spec or phase carries.
I. RISK. Where is the most risk (technical, scope, dependency on the owner)? Is every gate's fallback
   written down so the gate can be decided from evidence? (The plan has no time estimates, D-10.)
</verify>

<answer_format>
1. Summary of your understanding (max 12 bullets).
2. Verdict: READY / READY WITH NOTES / NOT READY, plus a one-sentence reason.
3. Findings table, most severe first:
   | # | Severity (CRITICAL/HIGH/MEDIUM/LOW) | File § section | Problem | Suggested fix |
   Max 25 rows. Each finding names a specific file and section. Do not guess.
4. Uncovered spec items (from B) and teardown changes in neither the specs nor the deferred list
   (from H), one bullet each.
5. The five biggest risks to shipping v1.0, each with a mitigation.
6. Questions the owner must answer before phase 00 (max 8).
If you could not verify something, say so plainly.
</answer_format>
```
