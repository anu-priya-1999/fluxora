# Step 45 — PR Impact Analysis API

## Objective & Role in Roadmap

Global Step 45 exposes the deterministic persisted impact-analysis capability through authenticated, tenant-scoped, and asynchronous HTTP REST endpoints in `apps/api` and coordinates background processing through the PostgreSQL job queue and worker harness in `apps/workers`.

This fulfills **Global Step 45** of **Phase 6: PR Impact Analysis** as defined by:
- `docs/architecture/17-implementation-roadmap.md` (Phase 6, Step 5: API endpoints)
- `docs/architecture/05-component-responsibilities.md` (§5.8 Evidence Writer, §5.9 Impact Analysis Engine, §5.14 Fluxora API, §5.16 Job Queue / Worker Coordination)
- `docs/architecture/06-database-schema.md` (PullRequest, AnalysisRun, ImpactAnalysis, Evidence, RLS / tenancy model)
- `docs/architecture/07-api-architecture.md` (PR impact analysis endpoint definitions, Bearer JWT, organization derived from auth, 202 for long-running analysis, Idempotency-Key, /api/v1 versioning, consistent error shape `{ error: { code, message, details? } }`)

---

## Exact Scope & Boundaries

### Modified Files:
- `packages/shared-types/src/jobs.ts`:
  - Added `PULL_REQUEST_IMPACT_ANALYSIS_JOB_TYPE = "pull_request.impact_analysis"`.
  - Added `PullRequestImpactAnalysisJobPayload` interface defining tenant-safe payload fields.
  - Added `pullRequestImpactAnalysisIdempotencyKey(pullRequestId, analysisRunId, clientKey?)` generator.
  - Added `parsePullRequestImpactAnalysisJobPayload(payload)` validator with UUID and options validation.
- `packages/shared-types/src/impact.ts`:
  - Added HTTP API response shapes: `ImpactAnalysisFindingResponse`, `ImpactAnalysisUnresolvedFileResponse`, `ImpactAnalysisExecutionMetricsResponse`, `ImpactAnalysisResponse`, `PullRequestAnalyzeImpactQueuedResponse`.
- `packages/db/src/repositories/impact-analysis-engine.ts`:
  - Extracted `resolveAnalysisRunForPullRequest` and `resolveAnalysisRunForPullRequestTx` helpers for validating pull request tenancy and resolving explicit or latest completed analysis run.
  - Reused helper across `analyzePullRequestImpact`.
- `packages/db/src/index.ts`:
  - Re-exported `resolveAnalysisRunForPullRequest` and `resolveAnalysisRunForPullRequestTx`.
- `apps/workers/src/handlers.ts`:
  - Registered `PULL_REQUEST_IMPACT_ANALYSIS_JOB_TYPE` handler in `createDefaultJobHandlers`.
  - Exported `pullRequestImpactAnalysisJobHandler`.
- `apps/api/src/http/server.ts`:
  - Registered route matching and dispatch for `POST /api/v1/pull-requests/:id/analyze-impact` and `GET /api/v1/impact-analyses/:id`.
  - Added `OPTIONS` CORS preflight handling for new routes.
  - Extended `CreateApiServerOptions` with `impactAnalysisDeps`.
  - Included paths in `isKnownPath`.
- `docs/DESIGN.md`:
  - Documented Global Step 45 architecture, endpoints, job queue orchestration, invariants, and boundaries.

### Created Files:
- `apps/workers/src/pull-request/impact-handler.ts`:
  - Implemented `processPullRequestImpactJob`, `createPullRequestImpactAnalysisHandler`, and `createProductionPullRequestImpactDependencies`.
  - Worker authenticates tenant ownership, executes Step 44 `persistPullRequestImpactAnalysis` (invoking Step 43 engine + Step 44 persistence + `EvidenceWriter`), and produces durable results.
- `apps/workers/src/pull-request/impact-handler.test.ts`:
  - Unit tests for worker job parsing, successful execution, failure propagation, and repository fallback.
- `apps/api/src/http/impact-analysis-request.ts`:
  - Added regex path matchers: `isPullRequestAnalyzeImpactPath`, `matchPullRequestAnalyzeImpactPath`, `isImpactAnalysisGetPath`, `matchImpactAnalysisGetPath`.
  - Added `parseAnalyzeImpactBody` validating options and explicitly rejecting client-supplied `organization_id` with 400.
  - Added `ImpactRequestValidationError`.
- `apps/api/src/http/impact-analysis-response.ts`:
  - Pure serialization mappers: `formatImpactAnalysisResponse`, `formatImpactFinding`, `formatExecutionMetrics`, `formatUnresolvedFile`.
- `apps/api/src/http/impact-analysis.ts`:
  - HTTP route handlers `handleAnalyzePullRequestImpact` and `handleGetImpactAnalysis`.
  - Enforces Bearer JWT authentication, derives `organization_id` exclusively from server session, resolves tenant-scoped PR and analysis run, enqueues async background job with `Idempotency-Key`, and returns 202 Accepted.
  - GET endpoint reads persisted `ImpactAnalysis` record from PostgreSQL without recomputing analysis, maps to public API format, and returns 200 OK.
- `apps/api/src/http/impact-analysis-request.test.ts`:
  - Unit tests covering route pattern matching and request body parsing/validation.
- `apps/api/src/http/impact-analysis.test.ts`:
  - Comprehensive integration test suite covering requirements A through V.

### Strict Scope Boundary Against Steps 46–47:
- Step 45 does **NOT**:
  - Implement frontend components or the change-mode visual overlay on GraphCanvas in `apps/web` (Step 46 owns this);
  - Execute golden-fixture PR impact validation (Step 47 owns this);
  - Add AI narrative explanations or simulation (Step 48+).

---

## Architectural Workflow & Conceptual Flow

```
1. Client POST Request
   POST /api/v1/pull-requests/:id/analyze-impact
   Authorization: Bearer <JWT>
   Idempotency-Key: <client-key>
   { "analysis_run_id": "...", "max_depth": 3, "direction": "outgoing" }
                    │
                    ▼
2. HTTP API Server (`apps/api`)
   ├─ Authenticate Bearer JWT & resolve authenticated user session
   ├─ Derive organizationId from session (reject if body contains organization_id)
   ├─ Validate pullRequestId format (UUID regex)
   ├─ Resolve PR & AnalysisRun inside tenant scope (`resolveAnalysisRunForPullRequest`)
   │  └─ Returns 404 pull_request_not_found if PR belongs to another tenant
   ├─ Compute deterministic impactAnalysisId & idempotencyKey
   ├─ Enqueue job into PostgreSQL `jobs` table (type: "pull_request.impact_analysis")
   │  └─ Deduplication via unique idempotencyKey
   └─ Return HTTP 202 Accepted:
      {
        "status": "queued",
        "job_id": "...",
        "pull_request_id": "...",
        "idempotency_key": "..."
      }
                    │
                    ▼
3. Distributed Worker Harness (`apps/workers`)
   ├─ Dequeue job payload (`parsePullRequestImpactAnalysisJobPayload`)
   ├─ Validate tenant-scoped pull request & analysis run
   ├─ Execute `persistPullRequestImpactAnalysis`:
   │  ├─ Step 43 Deterministic Impact Analysis Engine (`analyzePullRequestImpact`)
   │  ├─ Step 44 Evidence Generation (`EvidenceWriter.createImpactFindingEvidence`)
   │  └─ Step 44 Atomic Persistence (`INSERT INTO impact_analyses ... ON CONFLICT DO UPDATE`)
   └─ Mark job completed
                    │
                    ▼
4. Client GET Request
   GET /api/v1/impact-analyses/:id
   Authorization: Bearer <JWT>
                    │
                    ▼
5. Read-Only Retrieval (`apps/api`)
   ├─ Authenticate Bearer JWT & derive organizationId
   ├─ Retrieve persisted record via `getImpactAnalysisById(pool, organizationId, id)`
   │  └─ Evaluated against PostgreSQL Row-Level Security (RLS)
   ├─ If cross-tenant or missing, return 404 impact_analysis_not_found
   ├─ Pure formatting via `formatImpactAnalysisResponse` (NO recomputation)
   └─ Return HTTP 200 OK with full finding taxonomy and evidence IDs
```

---

## Core Invariants Enforced

1. **Deterministic Core vs. Probabilistic Edge**:
   All change-impact analysis and blast-radius determinations are computed deterministically by the Step 43 engine and persisted durably by Step 44. No generative models or non-deterministic heuristics are involved.
2. **Asynchronous Non-Blocking HTTP Boundary**:
   Per architectural guidelines, graph traversal and blast-radius computation are never executed synchronously within HTTP request cycles. The API enqueues a background job and responds immediately with `202 Accepted`.
3. **Strict Tenancy & Authorization**:
   `organization_id` is derived solely from the authenticated Bearer token session. Client attempts to provide `organization_id` in request payloads are rejected with `400 invalid_request`. Cross-tenant queries return `404` without leaking resource existence.
4. **Idempotency & Deduplication**:
   POST requests respect `Idempotency-Key` headers. Combined with tenant, PR, and analysis run IDs, duplicate concurrent or repeated requests reuse the established job without creating duplicate background work or redundant database records.
5. **Read-Only GET Idempotency**:
   `GET /api/v1/impact-analyses/:id` strictly reads persisted data from PostgreSQL. It performs zero graph traversals, AST parsing, or diff calculations.

---

## Verification Summary

All verification suites pass cleanly across packages:
1. `apps/api/src/http/impact-analysis-request.test.ts` (13 tests): Route matching, option parsing, and input validation.
2. `apps/api/src/http/impact-analysis.test.ts` (19 tests): Comprehensive API integration tests covering routes, authentication, tenancy scoping, error codes, 202 queued responses, and 200 persisted GET responses.
3. `apps/workers/src/pull-request/impact-handler.test.ts` (5 tests): Worker job handling, failure cases, and persistence delegation.
4. `packages/db/src/repositories/impact-analysis-engine.test.ts` (23 tests): Algorithmic traversal, seed resolution, and PostgreSQL end-to-end integration.
5. Workspace-wide verification: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:evidence`, and `pnpm build`.

