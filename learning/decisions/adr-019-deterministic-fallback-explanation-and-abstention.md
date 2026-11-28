# ADR-019: Deterministic Fallback Explanation, Failure Classification, and Abstention

**Status:** Accepted

**Date:** 2026-11-27

**Deciders:** Core Engineering Team
**Informed:** Phase 9 (AI Reasoning)

---

## 1. Context & Problem Statement

Steps 59–65 established the Model Gateway, Context Assemblers, Structured-Output Validators, Tool-Calling Chat, and AI Evaluation Suite. However, when the external LLM provider is unavailable, times out, or produces ungrounded/invalid JSON after the permitted corrective retry, `orchestrateImpactExplanation` and `orchestrateSimulationNarration` previously left `AIAnalysis` in a `failed` or `rejected` state with no user-facing explanation—even though Fluxora already holds verified deterministic findings and evidence.

## 2. Decision

1. **Orchestrator-Level Terminal Fallback (`apps/workers/src/ai/fallback/`)**:
   - Operationalize ADR-010 for `impact_explanation` and `simulation_narration` at the orchestrator terminal failure boundary, leaving `ModelGateway` and Step 61/63 validators decoupled from fallback generation.
   - Explicitly exclude `chat_query` from Step 66 fallback.
2. **Strict Failure Classification (`classifyGatewayErrorForFallback`)**:
   - Trigger fallback only for `PROVIDER_UNAVAILABLE`, `TIMEOUT_ERROR`, `RATE_LIMIT_ERROR`, `RETRIES_EXHAUSTED`, `INVALID_RESPONSE`, or `validation_failed_after_retries`.
   - Never mask tenant authorization, ownership mismatches, invalid requests, `AUTHENTICATION_ERROR`, `CONFIGURATION_ERROR`, `ABORTED`, or programming errors.
3. **Evidence Grounding, Caveat Preservation, and Abstention**:
   - Restrict all fallback claim citations to `context.allowedEvidenceIds` and self-validate against the canonical output schemas (`impact-explanation-output-v1` / `simulation-narration-output-v1`).
   - Preserve truncation, unresolved-file, missing-evidence, and synthetic-simulation caveats.
   - Explicitly abstain (`claims: []`, `confidence: "low"`, `fallbackAbstained: true`) when no verified evidence records exist.
4. **Transparent Provenance**:
   - Persist `status: "completed"`, `validationStatus: "fallback"`, `modelUsed: null`, `promptVersion: "*-fallback-v1"`, and safe metadata (`deterministicFallback`, `fallbackReason`, `fallbackAbstained`), without requiring any database schema migration.

## 3. Consequences

- **Positive:** Users receive reliable, evidence-grounded explanations during LLM outages or persistent validation failures without compromising tenant isolation or hallucination defenses.
- **Trade-offs:** Template-based fallback explanations are structured and factual rather than conversational prose, and `chat_query` remains dependent on live/mock model availability.
