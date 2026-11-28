# Phase 9, Step 66: Deterministic Fallback Explanation

## Objective

Implement the deterministic fallback explanation path (`apps/workers/src/ai/fallback/`) for when AI generation is unavailable or fails structured-output validation after permitted recovery attempts.

## Scope

- **Supported task types**: `impact_explanation` (`orchestrateImpactExplanation`) and `simulation_narration` (`orchestrateSimulationNarration`).
- **Explicit exclusion**: `chat_query` is excluded from Step 66 fallback.
- **Core invariants**:
  - Zero LLM or network calls during fallback generation.
  - Strict grounding in `allowedEvidenceIds` from trusted deterministic context (`ImpactExplanationContext` / `SimulationNarrationContext`).
  - Explicit abstention (`claims: []`, `confidence: "low"`) when verified evidence is missing.
  - Preservation of truncation, unresolved-file, missing-evidence, and synthetic-simulation caveats.
  - Failure classification (`classifyGatewayErrorForFallback`) never masks tenant authorization, ownership, invalid requests, policy/security rejections, caller aborts, or programming errors.
  - Transparent provenance (`validationStatus: "fallback"`, `modelUsed: null`, `metadata.deterministicFallback: true`, `metadata.fallbackReason`, `metadata.fallbackAbstained`) and OpenTelemetry counter `fluxora.ai.fallback.executions`.
