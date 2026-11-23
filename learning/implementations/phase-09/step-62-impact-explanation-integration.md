# Step 62: End-to-End Impact Explanation Integration — Comprehensive Production Readiness Audit and Implementation Report

## 1. Executive Summary & Objective

In **Global Step 62** (Phase 9 Step 4), Fluxora implements and validates the complete production integration of its AI impact-explanation pipeline:

$$\text{Completed deterministic impact analysis} \longrightarrow \text{Tenant-scoped context assembly (Step 60)} \longrightarrow \text{Model Gateway (Step 59)} \longrightarrow \text{Structured output \& grounding validator (Step 61)} \longrightarrow \text{Durable AIAnalysis persistence (Migration 0028)} \longrightarrow \text{Authenticated API} \longrightarrow \text{AIExplanationPanel UI}$$

The primary objective is connecting the modular components implemented across Steps 59–61 into an operational user-facing feature while preserving Fluxora's fundamental invariant: **the deterministic graph and impact analysis engine remains the single source of truth for blast-radius reality (Principle P1/P10).** The Large Language Model (LLM) acts strictly as an evidence-grounded narrator over verified facts.

This report documents the rigorous production-readiness audit, root cause analysis of earlier verification anomalies, resolution of integration and test coverage gaps, and independent verification across all six quality gates.

---

## 2. Investigation of Original Verification Failures

During the initial execution log of Step 62, two commands returned exit code 1:
- `trim trailing blank lines and check git diff — Exited with code 1`
- `final multi-gate validation — Exited with code 1`

### 2.1 Evidenced Root Cause Analysis
1. **`trim trailing blank lines and check git diff` (Exit Code 1)**:
   - **Analysis**: `git diff --check` evaluates the working tree for whitespace errors, trailing whitespace characters, and trailing blank lines at the end of files. If any file contains trailing blank lines or whitespace violations, `git diff --check` terminates with exit code 1.
   - **Historical Context & Qualification**: The original runner terminal output was not persisted in workspace logs. While trailing whitespace or blank lines remain the standard and plausible cause of `git diff --check` failures, this cannot be conclusively proven from historical logs alone.
   - **Resolution**: Subsequent whitespace cleanup and reformatting eliminated all trailing blank lines across the repository. In this audit, `git diff --check` was executed independently on the current working tree and exited with code 0 (clean, zero whitespace anomalies).
2. **`final multi-gate validation` (Exit Code 1)**:
   - **Analysis**: The original multi-gate command bundled multiple workspace commands (`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:evidence`, `pnpm build`) into a chained shell sequence with `&&`. Any single test failure, compiler warning treated as error, timeout, or non-zero sub-process exit immediately terminated the entire compound command with exit code 1.
   - **Historical Context & Inconclusive Runner Logs**: The original runner logs from the predecessor agent turn were not saved in the repository or local filesystem. Consequently, the exact root cause of the earlier historical compound failure cannot be conclusively recovered or verified from historical artifacts.
   - **Reproduced Audit Gaps**: During the decoupled audit execution, two genuine compilation and typing issues were directly reproduced and resolved:
     - `TS2578` (unused `@ts-expect-error` directive in frontend test): fixed by aligning mock typing so the directive was not superfluous.
     - `TS2304` (`currentRecord` out of scope in the orchestrator catch block): fixed by hoisting `currentRecord` declaration outside the `try` block.
     While these were genuine errors identified and fixed during this audit, they are **not** claimed as conclusively proven causes of the earlier historical multi-gate failure, as runner output was absent. With all decoupled gates executed independently, all six gates pass with exit code 0.

---

## 3. Actual Implementation Architecture and Data Flow

The complete end-to-end data flow operates as follows:

```text
[Pull Request Webhook]
        │
        ▼
[Worker: processPullRequestImpactJob]
        │
        ├─► 1. Compute deterministic graph traversal (analyzePullRequestImpact)
        │
        ├─► 2. Persist ImpactAnalysis & Evidence (persistImpactAnalysis) ──► [PostgreSQL: impact_analyses, evidence]
        │
        ▼
[Failure Isolation Boundary (try / catch)]
        │
        ▼
[AI Orchestrator: orchestrateImpactExplanation]
        │
        ├─► 3. Check Idempotency: getAIAnalysisBySubject
        │       ├─ Completed: return cached record immediately
        │       ├─ Rejected: return rejected state (do not regenerate unless forceRetry=true)
        │       └─ Failed: return failed state if max attempts reached (unless forceRetry=true)
        │
        ├─► 4. Ensure Durable Pending Record: saveAIAnalysis(status: "pending")
        │       └─ Reuses existing pending record if already present
        │
        ├─► 5. Assemble Context (Step 60: loadImpactExplanationContext)
        │       └─ Extracts allowedEvidenceIds manifest, applies character budget
        │
        ├─► 6. Dispatch to Model Gateway (Step 59: createModelGateway)
        │       └─ Uses claude-sonnet-5-5 (or MockModelProvider in dev)
        │
        ├─► 7. Validate Output (Step 61: validateImpactExplanationWithRetry)
        │       ├─ Parse strict JSON
        │       ├─ Verify 4-field schema
        │       ├─ Ground claims against allowedEvidenceIds manifest
        │       └─ If invalid: 1 corrective retry with deterministic issue guidance
        │
        ├─► 8. Aggregate Metrics: tokenCount, costUsd, latencyMs across all attempts
        │
        └─► 9. Persist Durable Record (saveAIAnalysis) ──► [PostgreSQL: ai_analyses (RLS)]
                ├─ Completed: output_text & output_structured saved, validationStatus='passed'
                ├─ Rejected: output_text = null, output_structured = null, validationStatus='rejected'
                └─ Failed: output_text = null, output_structured = null, errorMessage saved

[Client: Architecture Explorer]
        │
        ├─► GET /api/v1/impact-analyses/:id ──► returns impact findings + ai_analysis_id
        │
        └─► GET /api/v1/ai-analyses/:id ─────► returns validated AIExplanationOutput
                │
                ▼
        [AIExplanationPanel]
                ├─ AI Narration Badge & Model Confidence
                ├─ Summary Text
                ├─ Claims with clickable EvidenceCitationList chips
                ├─ Caveats & Degradation States
                └─ Active cancellation & unmount cleanup
```

---

## 4. Pending-Record Creation Sequence and Recovery Behavior

### 4.1 Creation Sequence
1. The background worker calculates and durably commits the deterministic `impact_analyses` row and its associated `evidence` records.
2. Downstream of successful impact persistence, `processPullRequestImpactJob` calls `deps.explainImpact` within an isolated `try/catch` block.
3. `orchestrateImpactExplanation` immediately checks for existing records via `getAIAnalysisBySubject`.
4. If an existing `pending` record is already present, it is reused as `currentRecord` without emitting an unnecessary duplicate database write.
5. If no record exists, a durable `pending` row is written to `ai_analyses` with `status: 'pending'`, `prompt_version: 'impact-explain-v1'`, and `token_count: 0`.

### 4.2 API Discoverability, Discovery Race Resolution, and Bounded Recovery
- `GET /api/v1/impact-analyses/:id` performs a left-join/lookup for the associated `ai_analyses` record by `(organization_id, 'impact_analysis', impact_analysis_id)`.
- **The Race Window**: In the interval between deterministic impact completion and the worker's asynchronous creation of the initial `pending` record, `GET /api/v1/impact-analyses/:id` returns `ai_analysis_id: null`.
- **Bounded Automatic Discovery**:
  1. `AIExplanationPanel` detects when `impactAnalysisId` is present but `aiAnalysisId` is `null`.
  2. It activates a bounded discovery poller (`MAX_AI_DISCOVERY_ATTEMPTS = 5`, `AI_DISCOVERY_INTERVAL_MS = 2000`) that queries `GET /api/v1/impact-analyses/:id`.
  3. When the worker commits the pending row and `ai_analysis_id` appears in the response, `AIExplanationPanel` calls `onAIAnalysisDiscovered(discoveredId, discoveredStatus)`.
  4. This callback bubbles up through `ChangeModeBar` to `explorer-client.tsx`, which updates `changeModeState` with the discovered ID and status.
  5. The panel smoothly transitions from `unavailable` to `pending` without full page reloads.
  6. If no AI analysis record appears within 10 seconds (5 attempts), polling halts and the panel remains cleanly in the `unavailable` state.
  7. Deterministic impact findings, node counts, and slice metrics remain completely preserved and unmutated throughout the discovery sequence.
- **User-Triggered Bounded Recovery**:
  1. If the automatic 10-second discovery budget expires before a delayed worker creates the `AIAnalysis` record, the panel renders an accessible **Check again** button in the unavailable state.
  2. Clicking "Check again" initiates a fresh bounded discovery budget (strictly 5 attempts at 2000ms intervals = 10s).
  3. The action is guarded against rapid repeated clicks via `isDiscoveringRef`, preventing duplicate or overlapping discovery loops.
  4. When discovered during recovery, the panel transitions to `pending` and loads the AI explanation.
  5. If the record remains undiscovered after the recovery budget, the panel remains unavailable and re-enables "Check again".
  6. All active discovery timers are cleanly cancelled on component unmount.

### 4.3 Crash and Interruption Recovery
- If the worker process crashes before creating the pending record, the deterministic impact analysis remains fully intact. A redelivered job re-enters `processPullRequestImpactJob` and safely executes `orchestrateImpactExplanation`.
- If the worker crashes during model generation while the record is in `pending` status, subsequent job execution finds the existing pending record and proceeds with generation and atomic state transition.
- Deterministic analysis completion and AI analysis record creation are **not atomic** across database transactions; they are sequentially staged to guarantee that slow model calls or third-party outages never block or roll back deterministic graph traversal.

---

## 5. Lifecycle State Definitions and Transitions

The `ai_analyses` table and domain model define four mutually exclusive lifecycle states:

| Lifecycle State | Validation Status | Output Fields (`output_text`, `output_structured`) | Semantics & Consumer Behavior |
|---|---|---|---|
| `pending` | `null` or `pending` | `null` | AI explanation is currently queued, context is loading, or gateway generation is in progress. Clients poll until terminal state. |
| `completed` | `passed` | Populated with validated summary and 4-field structured output DTO | Model output successfully complied with JSON schema and all cited evidence IDs were verified members of `allowedEvidenceIds`. |
| `rejected` | `rejected` | Strictly `null` (withheld per ADR-014) | Model output failed schema validation or cited ungrounded evidence IDs after bounded corrective retry. Raw output is withheld; error diagnostics are stored in `metadata.validationErrors`. |
| `failed` | `null` | Strictly `null` | Provider network timeout, 429 rate limit, 5xx error, or unrecoverable system exception. Safe, sanitized error message stored in `error_message`. |

Validation status (`passed` | `rejected`) remains strictly decoupled from lifecycle status (`pending` | `completed` | `rejected` | `failed`). A provider failure is marked `status: 'failed'` with `validation_status: null` because validation was never performed.

---

## 6. Worker Failure-Isolation Guarantees and Limitations

### 6.1 Isolation Guarantees
1. **Deterministic Authority**: Traversal results, node blast-radius metrics, and finding evidence records are persisted before the AI pipeline executes.
2. **Exception Containment**: In `apps/workers/src/pull-request/impact-handler.ts`, `deps.explainImpact` is enclosed in an isolated `try/catch` block. Any exception thrown by gateway timeouts, provider rate limits, network outages, or persistence errors is logged and swallowed, allowing `processPullRequestImpactJob` to return the successful deterministic result.
3. **No Recursive Job Retries**: AI failures do not bubble up as worker ingestion errors; background queue jobs are not retried repeatedly due to external LLM downtime.
4. **AI Persistence Failure Resilience**: If `saveAIAnalysis` itself fails due to transient database disconnection, `orchestrateImpactExplanation` catches the error, logs a sanitized diagnostic, and returns `{ status: "failed", error: "..." }` without failing the parent impact analysis job.

### 6.2 Limitations
- Deterministic impact findings will not display an AI explanation until a new PR event or manual re-analysis triggers worker execution if the AI generation step experiences a permanent failure.

---

## 7. Idempotency and Concurrency Behavior

### 7.1 Idempotency Key
- The uniqueness boundary is enforced at the database schema level via:
  `CREATE UNIQUE INDEX ai_analyses_org_subject_unique ON ai_analyses (organization_id, subject_type, subject_id);`
- Only one AI analysis record can exist per organization, subject type, and subject ID.

### 7.2 Repeated Processing & Redelivery
- If an impact analysis job is reprocessed after an AI explanation is already `completed`, `orchestrateImpactExplanation` detects the completed row via `getAIAnalysisBySubject` and returns `{ status: "already_completed", aiAnalysis: existing }` immediately without dispatching any requests to the Model Gateway.
- If a record is already `rejected`, `orchestrateImpactExplanation` returns `{ status: "rejected", aiAnalysis: existing, errors: ... }` without regenerating, unless explicitly instructed via `options.forceRetry: true`.
- If a record is `failed`, it allows bounded retry up to `options.maxRetries ?? 2` attempts before halting further generation attempts.

### 7.3 Concurrency Realities, Transactional Guarantees, and Exact Limitations
- In `saveAIAnalysis`, the `ON CONFLICT (organization_id, subject_type, subject_id) DO UPDATE SET` clause is protected with conditional `CASE` expressions across all columns:
  ```sql
  status = CASE
    WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.status
    ELSE EXCLUDED.status
  END,
  model_used = CASE
    WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.model_used
    ELSE COALESCE(EXCLUDED.model_used, ai_analyses.model_used)
  END,
  output_text = CASE
    WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.output_text
    ELSE EXCLUDED.output_text
  END,
  output_structured = CASE
    WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.output_structured
    ELSE EXCLUDED.output_structured
  END,
  validation_status = CASE
    WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.validation_status
    ELSE EXCLUDED.validation_status
  END,
  token_count = CASE
    WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.token_count
    ELSE EXCLUDED.token_count
  END,
  cost_usd = CASE
    WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.cost_usd
    ELSE EXCLUDED.cost_usd
  END,
  latency_ms = CASE
    WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.latency_ms
    ELSE EXCLUDED.latency_ms
  END,
  metadata = CASE
    WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.metadata
    ELSE ai_analyses.metadata || EXCLUDED.metadata
  END,
  error_message = CASE
    WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.error_message
    ELSE EXCLUDED.error_message
  END,
  updated_at = CASE
    WHEN ai_analyses.status = 'completed' AND EXCLUDED.status IN ('pending', 'failed', 'rejected') THEN ai_analyses.updated_at
    ELSE now()
  END
  ```
- **Simultaneous Initial Pending Creation**: When two workers process the same PR simultaneously, PostgreSQL serializes the inserts on the unique index `ai_analyses_org_subject_unique`. `ON CONFLICT` prevents duplicate key errors, resulting in exactly one row.
- **Concurrent Gateway Invocation Limitation (No Distributed Exactly-Once Claimed)**: Without distributed locking or worker leader election, two workers executing simultaneously at the exact same millisecond before either completes will both invoke the Model Gateway. We explicitly do not introduce distributed locks or external coordination infrastructure per project architecture constraints. Fluxora makes no claim of distributed exactly-once model execution.
- **State Preservation Guarantees**:
  - **Late Rejected Write Protection**: If Worker A completes and writes `status: 'completed'`, and concurrent Worker B exhausts corrective retries and writes `status: 'rejected'`, the database refuses to overwrite Worker A's validated result. Every column—including validation status, output text/structured, token metrics, metadata, and timestamps—is strictly preserved.
  - **Late Failed Write Protection**: If Worker 2 hits a transient timeout/rate limit and writes `status: 'failed'`, the `ON CONFLICT` conditional `CASE` expression preserves Worker 1's `completed` row and discards Worker 2's `failed` update.
  - **Late Pending Write Protection**: If a late worker attempts to write `pending`, the database refuses to downgrade `completed` back to `pending`.
  - **Metadata Pollution Prevention**: `metadata` is not merged with validation error lists or retry counters from stale writes.
  - **Competing Successful Writes**: When two concurrent workers both succeed with valid explanations, the updates update in-place safely without corrupting the record or invalidating output fields.
  - **Orchestrator Concurrency Resolution**: When a worker attempts to persist `rejected` or `failed` but the database returns an already `completed` row (won by another worker), `orchestrateImpactExplanation` detects `saved.status === 'completed'` and returns `{ status: "already_completed", aiAnalysis: saved }`.
  - Once a row is `completed`, any subsequent worker run short-circuits at `getAIAnalysisBySubject` with `status: 'already_completed'` and makes zero gateway calls.

### 7.4 Step 61 Retry Contract vs Worker Redelivery Bounds
- **Worker Redelivery Tolerance**: `options.maxRetries?: number` on `orchestrateImpactExplanation` controls job-level redelivery tolerance for failed records. If a subject has failed `maxRetries` times (default 2), the orchestrator refuses to call the gateway again and returns the existing failed state.
- **Step 61 Validation Attempt Invariant**: `maxRetries` does **not** alter the Step 61 schema/grounding validation attempt ceiling. `validateImpactExplanationWithRetry` enforces a hard limit of at most 2 response attempts (1 initial response + at most 1 corrective response). Step 62 cannot exceed this boundary.
- **Gateway Retries vs Validation Retries**: Gateway-internal provider retries (for transient network 503s) remain distinct from validation corrective attempts.
- **Usage Aggregation**: Token usage and cost aggregation count each gateway response attempt exactly once.

---

## 8. Database Schema, Migration, Tenant Isolation, and RLS

### 8.1 Schema & Migration 0028
- Migration file: `packages/db/migrations/0028_ai_analyses_storage.sql`.
- Applied forward-only through `packages/db/src/migrate/runner.ts`.
- Defines check constraints:
  - `ai_analyses_subject_type_check`: `subject_type IN ('impact_analysis', 'simulation', 'chat_query')`
  - `ai_analyses_status_check`: `status IN ('pending', 'completed', 'rejected', 'failed')`
  - `ai_analyses_validation_status_check`: `validation_status IS NULL OR validation_status IN ('pending', 'passed', 'rejected', 'fallback')`
  - Non-negative constraints on `token_count`, `cost_usd`, `latency_ms`.

### 8.2 Multi-Tenant Security & RLS
- Enforces multi-tenancy at the database engine level:
  - `ALTER TABLE ai_analyses ENABLE ROW LEVEL SECURITY;`
  - `ALTER TABLE ai_analyses FORCE ROW LEVEL SECURITY;`
- Strict tenant policies for `SELECT`, `INSERT`, `UPDATE`, and `DELETE` bound to `fluxora_current_org_id()`.
- All repository methods (`saveAIAnalysis`, `getAIAnalysisById`, `getAIAnalysisBySubject`) operate exclusively inside `withTenant(pool, organizationId, ...)`.
- Cross-tenant queries return `null` without disclosing the existence of records belonging to other organizations.

---

## 9. API Responses for All Lifecycle States

The authenticated endpoint `GET /api/v1/ai-analyses/:id` validates UUID format, verifies Clerk JWT sessions, enforces tenant isolation, and formats safe responses:

### 9.1 Completed State (HTTP 200)
```json
{
  "id": "77777777-7777-4777-8777-777777777777",
  "subject_type": "impact_analysis",
  "subject_id": "88888888-8888-4888-8888-888888888888",
  "status": "completed",
  "model_used": "claude-sonnet-5-5",
  "prompt_version": "impact-explain-v1",
  "input_evidence_ids": ["ev_1001"],
  "output_text": "Validated summary.",
  "output_structured": {
    "summary": "Validated summary.",
    "claims": [
      {
        "text": "Direct change to payment service.",
        "evidence_ids": ["ev_1001"]
      }
    ],
    "confidence": "high",
    "caveats": []
  },
  "validation_status": "passed",
  "token_count": 250,
  "cost_usd": 0.002,
  "latency_ms": 800,
  "schema_version": "impact-explanation-output-v1",
  "error_message": null,
  "created_at": "2026-11-23T10:00:00.000Z",
  "updated_at": "2026-11-23T10:00:00.800Z"
}
```

### 9.2 Pending State (HTTP 200)
```json
{
  "id": "66666666-6666-4666-8666-666666666666",
  "subject_type": "impact_analysis",
  "subject_id": "88888888-8888-4888-8888-888888888888",
  "status": "pending",
  "model_used": null,
  "prompt_version": "impact-explain-v1",
  "input_evidence_ids": [],
  "output_text": null,
  "output_structured": null,
  "validation_status": null,
  "token_count": 0,
  "cost_usd": 0,
  "latency_ms": 0,
  "schema_version": null,
  "error_message": null,
  "created_at": "2026-11-23T10:00:00.000Z",
  "updated_at": "2026-11-23T10:00:00.000Z"
}
```

### 9.3 Rejected State (HTTP 200)
```json
{
  "id": "55555555-5555-4555-8555-555555555555",
  "subject_type": "impact_analysis",
  "subject_id": "88888888-8888-4888-8888-888888888888",
  "status": "rejected",
  "model_used": "claude-sonnet-5-5",
  "prompt_version": "impact-explain-v1",
  "input_evidence_ids": ["ev_1001"],
  "output_text": null,
  "output_structured": null,
  "validation_status": "rejected",
  "token_count": 200,
  "cost_usd": 0.0015,
  "latency_ms": 500,
  "schema_version": "impact-explanation-output-v1",
  "error_message": null,
  "created_at": "2026-11-23T10:00:00.000Z",
  "updated_at": "2026-11-23T10:00:00.500Z"
}
```

### 9.4 Failed State (HTTP 200)
```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "subject_type": "impact_analysis",
  "subject_id": "88888888-8888-4888-8888-888888888888",
  "status": "failed",
  "model_used": "claude-sonnet-5-5",
  "prompt_version": "impact-explain-v1",
  "input_evidence_ids": ["ev_1001"],
  "output_text": null,
  "output_structured": null,
  "validation_status": null,
  "token_count": 0,
  "cost_usd": 0,
  "latency_ms": 150,
  "schema_version": null,
  "error_message": "Model provider gateway request timed out after 20000ms.",
  "created_at": "2026-11-23T10:00:00.000Z",
  "updated_at": "2026-11-23T10:00:00.150Z"
}
```

---

## 10. Frontend State Handling, Citations, and Polling Termination

### 10.1 UI Lifecycle States in `AIExplanationPanel`
1. **Waiting for Impact**: Displayed when `impactStatus` is `pending` or `running`.
2. **Generating (Pending)**: Displayed when `isLoading` or `data.status === "pending"`. Renders animated spinner and polling indicator.
3. **Completed**: Displays AI Narration badge, model confidence badge (`high` | `medium` | `low`), summary narrative, and claims array with clickable evidence citations.
4. **Validation Rejected (ADR-014)**: Displays rejection banner explaining that cited evidence was outside verified manifest; confirms deterministic blast-radius findings remain valid; suppresses all raw ungrounded model output.
5. **Provider Failure**: Displays clean unavailability card explaining provider/system error; confirms deterministic findings are unaffected.
6. **Unavailable**: Displayed when no AI analysis ID is linked.

### 10.2 Polling Termination and In-Flight Request Cleanup
- **Polling Start**: Polling triggers only when `data.status === "pending"` and `aiAnalysisId` is present.
- **Terminal Polling Stop**: Polling timers are cancelled and never rescheduled once the state transitions to `completed`, `rejected`, `failed`, `unavailable` (or discovery attempts exhaust), or fetch error.
- **Unmount Cleanup**: `useEffect` cleanup hook invokes `clearPollTimer()`, `clearDiscoveryTimer()`, and marks `isMountedRef.current = false`.
- **Stale Response Discarding**: Uses `activeRequestIdRef` to tag each dispatch. Responses from superseded requests or unmounted components are discarded, preventing stale network responses from overwriting the active view state when IDs change.
- **Request Overlap Prevention**: `inFlightIdRef` tracks the active request ID to prevent duplicate overlapping network requests for the same AIAnalysis ID while permitting immediate dispatches when the target ID changes.

### 10.3 Citation Trust Boundary
- Evidence citations are rendered via `EvidenceCitationList` referencing `evidencePool`.
- Clicking a citation chip highlights the exact source file and line range in the code viewer.
- Unresolved evidence citations are rendered safely as unlinked badges without fabricating evidence URLs or provenance links.

---

## 11. Exact Test Coverage Matrix

| Area | Requirement / Scenario | Test File | Verified Status |
|---|---|---|---|
| **Worker** | Initial generation & validation success | `apps/workers/src/ai/orchestrator.test.ts` | Passed |
| **Worker** | Bounded corrective retry with metric aggregation | `apps/workers/src/ai/orchestrator.test.ts` | Passed |
| **Worker** | Validation rejection without raw model text | `apps/workers/src/ai/orchestrator.test.ts` | Passed |
| **Worker** | Provider exception isolation (503/429) | `apps/workers/src/ai/orchestrator.test.ts` | Passed |
| **Worker** | Idempotency on completed record | `apps/workers/src/ai/orchestrator.test.ts` | Passed |
| **Worker** | Idempotency on rejected record (suppress regeneration) | `apps/workers/src/ai/orchestrator.test.ts` | **Added & Passed** |
| **Worker** | Database persistence failure isolation | `apps/workers/src/ai/orchestrator.test.ts` | **Added & Passed** |
| **Worker** | Safe reuse of existing pending record | `apps/workers/src/ai/orchestrator.test.ts` | **Added & Passed** |
| **Worker** | Concurrent worker execution preserves completed state | `apps/workers/src/ai/orchestrator.test.ts` | **Added & Passed** |
| **Worker** | Enforces Step 61 validation retry ceiling (max 2 attempts) | `apps/workers/src/ai/orchestrator.test.ts` | **Added & Passed** |
| **Worker** | Impact handler invokes explainImpact on completed | `apps/workers/src/pull-request/impact-handler.test.ts` | Passed |
| **Worker** | Impact handler isolates AI exception from impact job | `apps/workers/src/pull-request/impact-handler.test.ts` | Passed |
| **Worker** | Impact handler skips AI explain on non-completed impact | `apps/workers/src/pull-request/impact-handler.test.ts` | **Added & Passed** |
| **Database** | Migration 0028 schema and RLS policies | `packages/db/src/repositories/ai-analysis.test.ts` | Passed |
| **Database** | Create pending record and UUID validation | `packages/db/src/repositories/ai-analysis.test.ts` | Passed |
| **Database** | Update to completed with structured output | `packages/db/src/repositories/ai-analysis.test.ts` | Passed |
| **Database** | Persist rejection without raw model text | `packages/db/src/repositories/ai-analysis.test.ts` | Passed |
| **Database** | Persist provider failure state cleanly | `packages/db/src/repositories/ai-analysis.test.ts` | Passed |
| **Database** | RLS cross-tenant isolation enforcement | `packages/db/src/repositories/ai-analysis.test.ts` | Passed |
| **Database** | Unique constraint idempotency update | `packages/db/src/repositories/ai-analysis.test.ts` | Passed |
| **Database** | Prevent pending/failed write from overwriting completed | `packages/db/src/repositories/ai-analysis.test.ts` | **Added & Passed** |
| **Database** | Concurrent initial pending creation under unique index | `packages/db/src/repositories/ai-analysis.test.ts` | **Added & Passed** |
| **Database** | Competing completed writes under unique index | `packages/db/src/repositories/ai-analysis.test.ts` | **Added & Passed** |
| **Database** | Competing completed vs failed writes under unique index | `packages/db/src/repositories/ai-analysis.test.ts` | **Added & Passed** |
| **API** | 400 invalid UUID parameter | `apps/api/src/http/ai-analysis.test.ts` | Passed |
| **API** | 401 unauthenticated session | `apps/api/src/http/ai-analysis.test.ts` | Passed |
| **API** | 404 non-existent record | `apps/api/src/http/ai-analysis.test.ts` | Passed |
| **API** | 200 completed explanation response | `apps/api/src/http/ai-analysis.test.ts` | Passed |
| **API** | 200 pending explanation response | `apps/api/src/http/ai-analysis.test.ts` | Passed |
| **API** | 200 rejected explanation response | `apps/api/src/http/ai-analysis.test.ts` | Passed |
| **API** | 200 failed explanation response | `apps/api/src/http/ai-analysis.test.ts` | **Added & Passed** |
| **API** | Tenant isolation: Org B cannot read Org A record | `apps/api/src/http/ai-analysis.test.ts` | Passed |
| **API** | Impact analysis response includes AI analysis link | `apps/api/src/http/impact-analysis.test.ts` | Passed |
| **API** | Impact analysis response resilience on AI lookup error | `apps/api/src/http/impact-analysis.test.ts` | **Added & Passed** |
| **Frontend** | Renders grounded explanation with claims & citations | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | Passed |
| **Frontend** | Renders waiting for deterministic impact state | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | Passed |
| **Frontend** | Renders pending generation spinner | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | Passed |
| **Frontend** | Renders validation rejected state without raw text | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | Passed |
| **Frontend** | Renders provider failure state cleanly | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | Passed |
| **Frontend** | Renders unavailable state when no AI ID is present | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | Passed |
| **Frontend** | Renders empty claims indicator | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | Passed |
| **Frontend** | fetchAIAnalysis validates ID and handles errors | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | **Added & Passed** |
| **Frontend** | Discovery race: transitions unavailable to pending on discovery | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | **Added & Passed** |
| **Frontend** | Discovery poller halts after max attempts (5) | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | **Added & Passed** |
| **Frontend** | Polling stops on pending -> completed transition | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | **Added & Passed** |
| **Frontend** | Polling stops on pending -> rejected transition | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | **Added & Passed** |
| **Frontend** | Polling stops on pending -> failed without leaking unvalidated output | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | **Added & Passed** |
| **Frontend** | Renders persisted failed state cleanly without raw text | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | **Added & Passed** |
| **Frontend** | Discards stale request response from old ID | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | **Added & Passed** |
| **Frontend** | Cleans up polling timers on unmount | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | **Added & Passed** |
| **Frontend** | User-triggered retry starts a new bounded discovery cycle | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | **Added & Passed** |
| **Frontend** | Record discovered during retry transitions to pending | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | **Added & Passed** |
| **Frontend** | Repeated clicks cannot create overlapping discovery loops | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | **Added & Passed** |
| **Frontend** | Unmount cancels active discovery timer during retry | `apps/web/src/components/ai/AIExplanationPanel.test.tsx` | **Added & Passed** |
| **Database** | Late rejected write cannot overwrite completed result | `packages/db/src/repositories/ai-analysis.test.ts` | **Added & Passed** |
| **Database** | Late failed write cannot overwrite completed result | `packages/db/src/repositories/ai-analysis.test.ts` | **Added & Passed** |
| **Database** | Late pending write cannot overwrite completed result | `packages/db/src/repositories/ai-analysis.test.ts` | **Added & Passed** |
| **Database** | Completed result remains readable with original output and metadata | `packages/db/src/repositories/ai-analysis.test.ts` | **Added & Passed** |
| **Database** | Completed update with non-empty manifest replaces previous manifest | `packages/db/src/repositories/ai-analysis.test.ts` | **Added & Passed** |
| **Database** | Completed update with empty manifest stores empty array | `packages/db/src/repositories/ai-analysis.test.ts` | **Added & Passed** |
| **Database** | Late rejected write cannot overwrite completed record with empty manifest | `packages/db/src/repositories/ai-analysis.test.ts` | **Added & Passed** |
| **Database** | Late failed write cannot overwrite completed record with empty manifest | `packages/db/src/repositories/ai-analysis.test.ts` | **Added & Passed** |
| **Database** | Late pending write cannot overwrite completed record with empty manifest | `packages/db/src/repositories/ai-analysis.test.ts` | **Added & Passed** |
| **Database** | Stored output, validation, metadata, usage, timestamps consistent with policy | `packages/db/src/repositories/ai-analysis.test.ts` | **Added & Passed** |
| **Workers** | Late rejection preserves concurrently completed result and returns already_completed | `apps/workers/src/ai/orchestrator.test.ts` | **Added & Passed** |

---

## 12. Quality Gates — Independent Verification Execution

All six quality gates were executed independently with individual command invocations:

| Gate | Exact Command | Exit Code | Verification Details | Result |
|---|---|:---:|---|:---:|
| **1. Unit/Integration Tests** | `pnpm test` | **0** | **1,364 passed, 9 skipped** (1,373 total tests across 92 test files):<br>• `packages/infrastructure`: 7 passed<br>• `apps/web`: 309 passed<br>• `packages/db`: 394 passed, 5 skipped<br>• `apps/api`: 200 passed<br>• `apps/workers`: 454 passed, 4 skipped | **PASSED** |
| **2. TypeScript Compilation** | `pnpm typecheck` | **0** | Clean compilation across all 7 workspace packages with zero type errors (`tsc --noEmit`). | **PASSED** |
| **3. Code Style & Linting** | `pnpm lint` | **0** | Clean ESLint verification across entire repository with 0 errors and 0 warnings. | **PASSED** |
| **4. Evidence AST Lint** | `pnpm lint:evidence` | **0** | Verified all 5 conclusion-producing targets invoke `EvidenceWriter`. | **PASSED** |
| **5. Production Build** | `pnpm build` | **0** | Next.js 16.3.6 (Turbopack) production build completed; compiled all static and dynamic routes. | **PASSED** |
| **6. Git Hygiene** | `git diff --check` | **0** | Clean working tree; zero trailing whitespace, trailing blank line, or conflict marker errors. | **PASSED** |

---

## 13. Audit Changes and File Modifications

### Files Modified During Audit
1. `packages/db/src/repositories/ai-analysis.ts`:
   - Updated `ON CONFLICT` clause in `saveAIAnalysis` with comprehensive conditional `CASE` expressions protecting all columns against stale `pending`, `failed`, and `rejected` writes when an authoritative `completed` record exists.
2. `packages/db/src/repositories/ai-analysis.test.ts`:
   - Added concurrency integration tests against real PostgreSQL verifying that simultaneous pending creation (`Promise.all`), competing completed writes, late rejected writes, late failed writes, and late pending writes cannot overwrite completed records, and verifying completed records remain intact and readable.
3. `apps/workers/src/ai/orchestrator.ts`:
   - Added `forceRetry` and `maxRetries` options to `OrchestrateImpactExplanationOptions` with explicit JSDoc defining retry invariant boundaries.
   - Prevented unnecessary gateway calls on existing `rejected` records unless `forceRetry` is explicitly set.
   - Reused existing `pending` records safely without redundant database writes.
   - Hoisted `currentRecord` scope to ensure failure catch updates the existing record ID.
   - Concurrency resolution: when saving `rejected` or `failed` returns an already `completed` row (won by a concurrent worker), returns `{ status: "already_completed", aiAnalysis: record }`.
   - Added `provider` and `usageBreakdown` metadata to completed records.
4. `apps/workers/src/ai/orchestrator.test.ts`:
   - Added tests for idempotent reuse of rejected records, failure isolation when database persistence fails, safe pending record reuse, concurrent worker processing (late rejection preserving completed record), and enforcement of the Step 61 validation retry ceiling.
5. `apps/workers/src/pull-request/impact-handler.test.ts`:
   - Added test verifying `deps.explainImpact` is skipped when deterministic impact status is not completed.
6. `apps/api/src/http/ai-analysis.test.ts`:
   - Added test for the `failed` lifecycle state on `GET /api/v1/ai-analyses/:id` (confirming status 200, safe error message, null output fields).
7. `apps/api/src/http/impact-analysis.test.ts`:
   - Added test verifying `GET /api/v1/impact-analyses/:id` resilience when AI analysis lookup fails or throws.
8. `apps/web/src/components/ai/AIExplanationPanel.tsx`:
   - Added bounded discovery poller (`MAX_AI_DISCOVERY_ATTEMPTS = 5`, `AI_DISCOVERY_INTERVAL_MS = 2000`) for resolving pending record race.
   - Added user-triggered bounded recovery ("Check again" button) in unavailable state with protection against overlapping loops and full unmount timer cleanup.
   - Added `onAIAnalysisDiscovered` callback.
   - Added `inFlightIdRef` to prevent overlapping requests for the same ID while permitting instant switching.
   - Added `isMountedRef` and `activeRequestIdRef` to prevent unmount leaks and discard stale responses.
9. `apps/web/src/components/ai/AIExplanationPanel.test.tsx`:
   - Added comprehensive tests for discovery race transition, discovery timeout cutoff, user-triggered retry starting a fresh bounded cycle, record discovered during retry transitioning to pending, overlapping loop protection, unmount timer cancellation, terminal polling halts (`completed`, `rejected`, `failed`), failed-state rendering without raw text, and stale ID discard.
10. `apps/web/src/components/graph/ChangeModeBar.tsx`:
    - Wired `onAIAnalysisDiscovered` callback through to the explorer client.
11. `apps/web/src/app/repositories/[repoId]/explorer/explorer-client.tsx`:
    - Handled `handleAIAnalysisDiscovered` to update `changeModeState` with discovered AIAnalysis ID and status while preserving deterministic findings and slice metrics.
12. `docs/DESIGN.md`:
    - Updated Step 62 concurrency safety documentation, bounded discovery recovery, and verification suite metrics with exact test counts.
13. `learning/implementations/phase-09/step-62-impact-explanation-integration.md`:
    - Updated implementation report with full 15-section audit documentation.

---

## 14. Remaining Risks and Next Step Boundaries

### Remaining Architectural Boundaries
- **No LLM Blast-Radius Inference**: LLMs must never compute graph dependencies. The deterministic engine remains the sole source of truth.
- **Scope Discipline**: Simulation narration (Step 63), tool-calling chat (Step 64), AI evaluation benchmarking (Step 65), and deterministic template fallback (Step 66) remain intentionally unimplemented in Step 62.

---

## 15. Commit-Readiness Recommendation

**Recommendation: Fully Commit-Ready.**
- All requirements of Global Step 62 are implemented and verified.
- The original verification discrepancies are investigated and resolved with empirical evidence.
- All six quality gates (`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:evidence`, `pnpm build`, `git diff --check`) pass with exit code 0.
- All working tree changes remain unstaged per git discipline instructions.
