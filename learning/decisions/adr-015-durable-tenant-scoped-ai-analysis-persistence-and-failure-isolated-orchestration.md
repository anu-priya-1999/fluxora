# ADR-015: Durable Tenant-Scoped AIAnalysis Persistence and Failure-Isolated Pipeline Orchestration

**Status:** Accepted
**Date:** 2026-11-22
**Deciders:** Core Engineering Team
**Consulted:** Architecture Review
**Informed:** Phase 9 (AI Reasoning)

---

## 1. Context & Problem Statement

In **Global Step 62**, Fluxora implements its first end-to-end production AI integration:
$$\text{Deterministic impact analysis} \longrightarrow \text{Context assembly (Step 60)} \longrightarrow \text{Model Gateway (Step 59)} \longrightarrow \text{Validation (Step 61)} \longrightarrow \text{Durable persistence} \longrightarrow \text{Authenticated API} \longrightarrow \text{Frontend AIExplanationPanel}$$

Two primary architectural tensions arose during design:
1. **Persistence Boundary**: Should AI narrative explanations be embedded directly as columns/JSONB in the existing `impact_analyses` table, or stored in a dedicated, polymorphic `ai_analyses` table?
2. **Failure Isolation Boundary**: How should worker and API execution handle transient LLM outages, rate limits, network timeouts, or Step 61 validation rejections without compromising the authoritative, deterministic impact findings or causing infinite queue retry loops?

---

## 2. Decision

1. **Dedicated `ai_analyses` Persistence Table (Migration 0028)**:
   - Persist AI explanation records in a dedicated, tenant-isolated `ai_analyses` table with explicit lifecycle states (`pending`, `completed`, `rejected`, `failed`), distinct from validation status (`passed`, `rejected`).
   - Enforce multi-tenancy at the database engine boundary via `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` with `organization_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID`.
   - Enforce idempotency via `UNIQUE (organization_id, subject_type, subject_id)` and an index `idx_ai_analyses_org_subject`. Repeated job processing updates the existing record in-place rather than creating duplicate rows.
   - Strictly withhold unvalidated model output: On validation rejection or provider failure, `output_text` and `output_structured` remain `null`, storing only sanitized error diagnostics in `error_message` or `metadata`.

2. **Isolated Worker Pipeline Orchestration (`orchestrateImpactExplanation`)**:
   - The worker handler (`processPullRequestImpactJob`) computes and persists the deterministic `ImpactAnalysis` and finding evidence records first.
   - Downstream of successful persistence, `orchestrateImpactExplanation` is invoked inside an isolated `try/catch` block.
   - Provider exceptions (429 rate limits, 5xx server errors, timeouts) and Step 61 validation rejections record typed status without throwing, guaranteeing that deterministic PR impact analysis jobs succeed and persist without interruption.
   - Accurate aggregation of token counts (input + output), microdollar token costs, and latency across both initial and corrective retry attempts.

3. **Decoupled API & Frontend Delivery**:
   - `GET /api/v1/impact-analyses/:id` provides `ai_analysis_id` and `ai_analysis_status` for resource correlation without inlining heavy AI explanation objects.
   - Dedicated `GET /api/v1/ai-analyses/:id` provides authenticated, tenant-isolated explanation data with UUID validation.
   - `AIExplanationPanel` in explorer change mode renders summary, claims with interactive `EvidenceCitationList` chips, model confidence badge, caveats, and safe degradation states.

---

## 3. Alternatives Considered

### Alternative A: Inline AI generation inside the deterministic traversal transaction
- **Description:** Run LLM generation inside the same database transaction that calculates and persists impact findings.
- **Why rejected:** Violates Core Principle P1 and P10. Stalls database connections while waiting for third-party LLM network calls (up to 20s). Any LLM timeout or 429 rolls back the entire deterministic graph traversal, creating severe performance bottlenecks and coupling deterministic correctness to external API availability.

### Alternative B: Embedding AI fields into `impact_analyses` table
- **Description:** Add `ai_summary`, `ai_claims`, and `ai_status` columns directly to `impact_analyses`.
- **Why rejected:** Couples the deterministic data model to probabilistic AI narration. Prevents reusing the persistence model for other AI tasks (e.g. simulation narration in Step 63 or chat in Step 64). Complicates schema maintenance and violates separation of concerns.

### Alternative C: Failing the worker job when AI generation fails
- **Description:** Allow exceptions from the Model Gateway to bubble up and fail the worker job, triggering background job retries.
- **Why rejected:** Violates Core Principle P10 (fail-safe AI). An impact analysis job that successfully computed verified graph blast-radius findings should never be marked as failed simply because of transient LLM rate limits. Retrying the job would repeatedly recompute expensive deterministic traversals.

### Alternative D: Persisting raw ungrounded model output with warning flags
- **Description:** On Step 61 validation rejection, persist the raw model completion with a flag `is_unvalidated: true`.
- **Why rejected:** Violates ADR-014 and the product thesis. Serving ungrounded claims risks exposing hallucinations to customers. Raw unvalidated model completions must be withheld to preserve blast-radius integrity.

---

## 4. Consequences & Invariants

### Positive
- **Deterministic Core Preserved:** Blast-radius findings remain authoritative and durable regardless of AI availability.
- **Auditable Provenance:** Every AI record links exact `model_used`, `prompt_version`, `input_evidence_ids`, aggregated tokens, microdollar costs, and latency.
- **Tenant Isolation:** Database engine RLS prevents cross-tenant data leakage on all reads and writes.
- **Idempotency:** Re-running an impact job updates the existing AI record without generating redundant LLM calls.

### Negative / Trade-offs
- Two separate database reads required for full UI presentation (`GET /impact-analyses/:id` then `GET /ai-analyses/:id`), though the impact analysis endpoint provides the foreign ID directly to facilitate client caching.
