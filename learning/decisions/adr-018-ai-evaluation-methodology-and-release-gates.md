# ADR-018: AI Evaluation Methodology, Semantic Groundedness Separation, and Release Gates

**Status:** Accepted
**Date:** 2026-11-27
**Deciders:** Core Engineering Team
**Informed:** Phase 9 (AI Reasoning)

---

## 1. Context & Problem Statement

Steps 59–64 established the Model Gateway, Context Assemblers, Structured-Output Validators, and Tool-Calling Chat. However, structured-output validation only proves JSON schema compliance and evidence-manifest membership—not that natural-language claims are semantically supported by the cited evidence, free of fabricated entities, or resistant to repository prompt injection.

## 2. Decision

1. **Three-Level Grounding Separation**:
   - Preserve explicit separation between structural evidence association (Steps 60/63/64), manifest membership (Step 61), and semantic evidence support (Step 65).
2. **Versioned Golden & Adversarial Datasets**:
   - Maintain `fixtures/golden/ai-eval-dataset.json` (`ai-eval-dataset-v1`) and `fixtures/golden/adversarial-injection-fixture.json` (`golden-taxonomy-adversarial-v1`) using stable evidence selectors rather than mutable database UUIDs.
3. **Honest Denominators & Statistical Confidence**:
   - Classify claims as `supported`, `unsupported`, `contradicted`, or `ambiguous`. Never classify `ambiguous` as `supported`.
   - Treat `<2%` hallucination rate as a live prompt-promotion target requiring `>= 20` evaluated claims; report `ci_mock` or undersized runs as `inconclusive`.
4. **Offline-First CI with Opt-In Live Mode**:
   - `pnpm test` and default `pnpm eval:ai` run in `ci_mock` mode without network calls or API keys, never fabricating mock token/cost metrics (`null`).
   - `live` mode requires explicit opt-in (`--mode=live` + `USE_REAL_LLM=true`) and enforces hard case/token/cost/time budgets.
5. **Explicit Baseline Approval**:
   - Recorded baselines (`fixtures/golden/ai-eval-baseline.json`) cannot be overwritten during normal test runs without explicit `--update-baseline` / `approved: true`.

## 3. Consequences

- **Positive:** Continuous regression detection for citations, retries, entities, and prompt injection without flaky or expensive live LLM calls in CI.
- **Trade-offs:** Deterministic lexical/selector semantic checks have bounded recall compared to human review; optional held-out LLM judges remain subordinate to deterministic contradictions and human reference labels.
