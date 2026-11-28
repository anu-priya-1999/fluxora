# Step 66: Deterministic Fallback Explanation — Implementation Report

## 1. Objective

Implement Phase 9, Step 66: a predictable, evidence-grounded, tenant-safe deterministic fallback explanation path for `impact_explanation` and `simulation_narration` when AI generation is unavailable or fails validation after permitted retries.

## 2. Implemented Architecture

1. **Deterministic Fallback Module (`apps/workers/src/ai/fallback/`)**:
   - `types.ts`: Contracts for `FallbackTriggerReason`, `FallbackEligibility`, `FallbackGenerationResult`, and prompt versions `impact-explain-fallback-v1` / `simulation-narrate-fallback-v1`.
   - `classifier.ts`: `classifyGatewayErrorForFallback` permits fallback only on `ModelGatewayError` codes `PROVIDER_UNAVAILABLE`, `TIMEOUT_ERROR`, `RATE_LIMIT_ERROR`, `INVALID_RESPONSE`, or `RETRIES_EXHAUSTED` with verified, homogeneous transient `primaryError`/`cause`/`attempts` provenance (bounded depth + cycle detection). Never masks `AUTHENTICATION_ERROR`, `CONFIGURATION_ERROR`, `ABORTED`, `INTERNAL_ERROR`, mixed histories, incomplete provenance, context/authorization errors, or programming errors (`TypeError`, `ReferenceError`, etc., normalized to `INTERNAL_ERROR` in `gateway.ts` and `anthropic-adapter.ts`).
   - `accounting.ts`: `extractGatewayFailureAccounting` and `combineInitialAndRetryFailureAccounting` preserve gateway attempt counts, latency, error categories, and initial-attempt usage on retry failures, explicitly setting `usageUnavailable` / `costUnavailable` in `metadata` when failed attempts omit usage/cost metrics:
     - Initial attempts use `ModelGatewayResponse.attemptCount`.
     - Corrective-retry attempts use the terminal gateway error's recorded attempt count.
     - The aggregate is their sum.
     - `usageUnavailable` and `costUnavailable` indicate incomplete aggregate accounting, even when partial numeric totals are available.
   - `impact-fallback.ts`: `generateImpactExplanationFallback` transforms `ImpactExplanationContext` into a validated `AIExplanationOutputDto` (`impact-explanation-output-v1`), deduplicating findings, restricting citations to `allowedEvidenceIds`, preserving truncation and unresolved-file caveats, and abstaining (`claims: []`, `confidence: "low"`) when no verified evidence exists.
   - `simulation-fallback.ts`: `generateSimulationNarrationFallback` transforms `SimulationNarrationContext` into a validated `AIExplanationOutputDto` (`simulation-narration-output-v1`), preserving exact `resultingState`, `ruleApplied`, `hopDistance`, and `confidence`, explicitly identifying synthetic scenarios, and abstaining when `simulation_state` evidence is missing.

2. **Orchestrator Integration (`apps/workers/src/ai/`)**:
   - `orchestrator.ts`: Routes terminal gateway failures and post-retry validation rejections to `generateImpactExplanationFallback` (when `enableFallback` is true, default). Persists `status: "completed"`, `validationStatus: "fallback"`, `modelUsed: null`, and provenance metadata without duplicating evidence writes or masking context/auth failures.
   - `simulation-orchestrator.ts`: Symmetric integration for `orchestrateSimulationNarration`.
   - `chat/orchestrator.ts`: Explicitly excluded per Step 66 roadmap scope.

3. **Observability & API Delivery**:
   - `packages/observability/src/signals.ts`: Added `recordAiFallbackExecution` (`fluxora.ai.fallback.executions` counter).
   - `apps/api/src/http/ai-analysis.ts`: Updated `formatAIAnalysisResponse` to deliver `output_text` and `output_structured` when `validationStatus` is `"passed"` or `"fallback"`, exposing safe provenance metadata (`deterministicFallback`, `fallbackReason`, `fallbackAbstained`) while withholding raw internal provider error strings.

## 3. Verification

- Focused tests: `apps/workers/src/ai/fallback/fallback.test.ts`, `orchestrator.test.ts`, `simulation-orchestrator.test.ts`, `eval/eval.test.ts`, and `apps/api/src/http/ai-analysis.test.ts`.
- Full workspace checks: `pnpm lint`, `pnpm lint:evidence`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check`.
