# 22. Definition of Done — "Portfolio-Ready"

Fluxora is portfolio-ready when **all** of the following are true, not when a subjective sense of "polished enough" is reached.

## Functional completeness (Phases 1–9)

- [ ] A real, non-trivial GitHub TypeScript/Next.js repository can be connected end-to-end by a stranger following the README, without hand-holding.
- [ ] The Architecture Explorer renders a real, interactive dependency graph for that repository.
- [ ] At least 3 real PRs from that repository's history have been run through impact analysis, with output hand-verified against what an experienced reader of that repo would expect (direct + one-hop downstream).
- [ ] At least 2 simulation scenarios run cleanly end-to-end with internally consistent propagation.
- [ ] AI explanations are generated for impact and simulation results, and every claim is clickable through to real evidence.
- [ ] The deterministic-fallback explanation path has been manually triggered and verified (e.g., by temporarily disabling the LLM call) to confirm the product degrades gracefully, not silently or confusingly.

## Trust mechanism verification (this is what makes it *this* product, not a generic AI wrapper)

- [ ] Every user-facing claim in the Architecture Explorer, Impact Report, and Simulation view has a working evidence citation.
- [ ] The evidence-coverage CI lint check (`12-testing-strategy.md §12.1`) is green and has caught at least one real gap during development (proof it actually works, not just exists).
- [ ] The AI evaluation suite (`12-testing-strategy.md §12.5`) has been run against the golden-fixture repos with recorded groundedness/hallucination-rate numbers you can quote from memory in an interview.
- [ ] An adversarial prompt-injection fixture has been tested and the result documented.

## Engineering rigor

- [ ] Unit test coverage exists for AST parsing edge cases, graph traversal (including cycles and depth limits), and the simulation rule table.
- [ ] The full CI/CD pipeline (lint → test → preview deploy → E2E) runs on every PR and has actually caught a real bug at least once.
- [ ] The system has been load-tested against at least one repository significantly larger than your primary demo repo, with results documented (even if the result is "here's where it started to slow down, and here's what I'd do about it").
- [ ] Local development works from a clean clone in under 10 minutes, verified by literally trying it on a clean machine or asking someone else to try it.

## Narrative readiness

- [ ] You can explain, unprompted and without notes, why the LLM doesn't own the dependency graph — and why that was the hardest and most important decision in the system.
- [ ] You can name one thing you got wrong during development, how you found out, and what you changed.
- [ ] You can answer at least 20 of the 39 questions in `20-interview-questions.md` with genuine understanding, not recitation.
- [ ] The demo script (`21-demo-script.md`) has been run live, end to end, at least 3 times without a fatal failure.
- [ ] The public repository has a README that includes the architecture diagrams, an honest "known limitations" section, and a working local-setup guide.

## Explicit non-requirements (do not gate on these)

- Multi-language support beyond TypeScript/JavaScript — documented as future work, not required.
- Runtime telemetry integration (Phase 10) — strengthens the story but is not required for done.
- Production-scale load handling (Phase 11) — a documented scaling story is sufficient; you do not need to have actually run 10,000 repositories through it.
- Pixel-perfect UI polish — functional, clean, and honest beats decorative.

**The single highest-leverage thing to get right before calling this done:** the evidence trail and the deterministic/AI boundary, demonstrated live, under questioning. Everything else in this package supports that one demonstration.
