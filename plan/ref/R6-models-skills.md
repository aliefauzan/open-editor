# R6 — Models, skills and review agents per phase

Model choice is a recommendation; the owner can switch in the app's model picker. Opus 5.5 for phases
with hard invariants (history, security, spike measurements, agent loop); Sonnet 5.5 for well-specified
building work.

| Phase | Model · effort | Skills to load | Review agents (step 7 of PROMPT) | Security review |
|---|---|---|---|---|
| 00 | Sonnet 5.5 · medium | superpowers:test-driven-development | code-reviewer, typescript-reviewer | — |
| 01 | Opus 5.5 · high | superpowers:systematic-debugging (for failures), hyperframes docs | code-reviewer, typescript-reviewer | — (measures only) |
| 02 | Opus 5.5 · high | superpowers:test-driven-development | code-reviewer, typescript-reviewer, type-design-analyzer | yes (S1, S25) |
| 03 | Opus 5.5 · high | superpowers:test-driven-development | code-reviewer, typescript-reviewer | S8, S9 |
| 04 | Opus 5.5 · high | superpowers:test-driven-development | code-reviewer, typescript-reviewer, python-reviewer, silent-failure-hunter | yes (S2–S6; S17, S19 engine parts) |
| 05 | Sonnet 5.5 · high | superpowers:test-driven-development | code-reviewer, typescript-reviewer, python-reviewer | yes (S7, S29) |
| 06 | Sonnet 5.5 · medium | superpowers:test-driven-development | code-reviewer, typescript-reviewer | S8 |
| 07 | Opus 5.5 · high | frontend-design (template look), hyperframes docs | code-reviewer, typescript-reviewer | S9 |
| 08 | Opus 5.5 · high | superpowers:test-driven-development | code-reviewer, typescript-reviewer, react-reviewer | yes (S1, S10–S15, S28) |
| 09 | Sonnet 5.5 · high | — | code-reviewer, typescript-reviewer, silent-failure-hunter | yes (S16, S27, S31) |
| 10a | Sonnet 5.5 · high | frontend-design, superpowers:test-driven-development | code-reviewer, react-reviewer, typescript-reviewer, a11y-architect | UI only |
| 10b | Sonnet 5.5 · high | frontend-design, superpowers:test-driven-development | code-reviewer, react-reviewer, typescript-reviewer, a11y-architect | UI only |
| 11 | Opus 5.5 · high | superpowers:test-driven-development, claude-api (AI SDK) | code-reviewer, typescript-reviewer, swift-reviewer (`native/apple-llm`), silent-failure-hunter | yes (S17–S24, S30) |
| 12 | Opus 5.5 · high | superpowers:test-driven-development | code-reviewer, typescript-reviewer | yes (S20 eval) |
| 13 | Sonnet 5.5 · high | frontend-design | code-reviewer, react-reviewer, e2e-runner | yes (full R4 pass) |
| 14 | Sonnet 5.5 · high | per sub-item | code-reviewer, typescript-reviewer, python-reviewer | as touched |
| 15 | Opus 5.5 · high | — | code-reviewer, typescript-reviewer, python-reviewer | S8 (extracted styles untrusted; inherited trusted templates keep hooks) |

## Notes

- Agent names refer to the installed plugins (ECC: `ecc:code-reviewer`, `ecc:typescript-reviewer`,
  `ecc:security-reviewer`, `ecc:react-reviewer`, `ecc:python-reviewer`, `ecc:silent-failure-hunter`,
  `ecc:type-design-analyzer`, `ecc:e2e-runner`, `ecc:a11y-architect`, `ecc:swift-reviewer`). If one is missing, use the general
  `code-reviewer` with the same focus written into its prompt.
- Do not spawn extra subagents beyond the review step unless the owner asks.
