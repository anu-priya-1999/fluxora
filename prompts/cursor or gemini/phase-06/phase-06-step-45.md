Implement ONLY Fluxora Global Step 45: PR Impact Analysis API.

IMPORTANT:
- Step 44 (ImpactAnalysis persistence + Evidence) is complete.
- Step 45 is API exposure/orchestration only.
- Do NOT implement Step 46 frontend change-mode overlay.
- Do NOT implement Step 47 golden-fixture validation.
- Do NOT add AI reasoning, simulation, telemetry, new graph algorithms, or Phase 7 work.
- Preserve all existing architecture, terminology, security conventions, testing patterns, and documentation style.
- Do NOT commit or push anything. I will commit separately.

==================================================
1. READ THESE FIRST
==================================================

Before changing code, inspect the repository and understand:

1. docs/architecture/17-implementation-roadmap.md
   - Phase 6 — PR impact analysis
   - Step 5: API endpoints

2. docs/architecture/05-component-responsibilities.md
   - §5.8 Evidence Writer / Evidence Store
   - §5.9 Impact Analysis Engine
   - §5.14 Fluxora API
   - §5.16 Job Queue / Worker Coordination

3. docs/architecture/06-database-schema.md
   - PullRequest
   - AnalysisRun
   - ImpactAnalysis
   - Evidence
   - RLS / tenancy model

4. docs/architecture/07-api-architecture.md
   - PR impact analysis endpoint definitions
   - cross-cutting API conventions:
     - Bearer JWT
     - organization derived from auth
     - 202 for long-running analysis
     - Idempotency-Key
     - /api/v1 versioning
     - consistent error shape

5. The actual Step 43 implementation:
   - Impact Analysis Engine
   - analyzePullRequestImpact(...)
   - existing shared impact types

6. The actual Step 44 implementation:
   - ImpactAnalysis persistence repository
   - evidence persistence
   - idempotency behavior
   - RLS behavior
   - transaction handling

7. Existing API patterns:
   - apps/api/src/http/server.ts
   - existing request parser files
   - existing route handlers
   - existing auth helpers
   - existing JSON response helpers
   - existing job enqueue patterns
   - existing idempotency-key handling
   - existing repository/analysis endpoints
   - existing worker job handlers for PR/webhook work

Do not invent a parallel API architecture. Reuse established patterns.

==================================================
2. STEP 45 GOAL
==================================================

Expose the deterministic persisted impact-analysis capability through these endpoints:

POST /api/v1/pull-requests/:id/analyze-impact

GET  /api/v1/impact-analyses/:id

The API must remain:
- authenticated
- tenant-scoped
- deterministic
- evidence-backed
- idempotent
- consistent with existing Fluxora API conventions

The API must orchestrate the already-existing Step 43 + Step 44 implementation rather than reimplementing impact-analysis logic.

==================================================
3. POST ENDPOINT
==================================================

Implement:

POST /api/v1/pull-requests/:id/analyze-impact

Behavior:

1. Authenticate using the existing Bearer JWT / Clerk authentication mechanism.
2. Derive organization_id from the authenticated session.
3. NEVER trust organization_id from request body, query params, or client payload.
4. Validate the PR id as a UUID using the same conventions already used elsewhere.
5. Resolve the PR through existing tenant-scoped DB access.
6. Cross-tenant PRs must behave as inaccessible/not found.
7. Resolve the analysis run that the impact analysis should use using the existing Step 43 / Step 44 conventions.
   - Do not invent a new snapshot/run selection mechanism.
   - If the caller is expected to provide analysis_run_id, inspect existing architecture and types and expose only what the current design supports.
8. Reuse the existing Step 43 deterministic impact-analysis engine and Step 44 persistence path.
9. Do not duplicate traversal, changed-file resolution, evidence generation, or persistence logic inside the HTTP handler.
10. Respect the architecture rule that analysis work is not a blocking API operation.
    - Inspect the existing Fluxora job queue/job handler conventions.
    - Enqueue the appropriate impact-analysis job using the existing job system.
    - Return 202 Accepted with the job identifier rather than blocking the HTTP request.
11. Honor the existing Idempotency-Key convention for POST requests.
    - Repeated requests with the same logical operation/key must not create duplicate work.
    - Reuse existing idempotency infrastructure instead of creating a new mechanism.
12. Ensure job payload is tenant-safe and contains only validated identifiers/options.
13. Do not place secrets or auth tokens into job payloads.
14. Preserve the existing impact-analysis options supported by Step 43/44 only:
    - analysis run selection
    - max depth
    - traversal direction
    - edge-type filtering
    - node-type filtering
    - confidence decay if already part of the supported public contract
    - evidence inclusion only if already designed for the API
15. Do NOT expose arbitrary internal DB fields merely because they exist.

Use the existing error contract:

{
  "error": {
    "code": "...",
    "message": "...",
    "details": {}
  }
}

Expected categories should follow existing project conventions, for example:
- invalid request / invalid UUID
- authentication required
- PR not found or inaccessible
- analysis run unavailable
- duplicate/idempotency conflict only where existing semantics require it
- internal error

Do not invent status codes unless justified by existing conventions.

==================================================
4. POST REQUEST / RESPONSE CONTRACT
==================================================

Use docs/architecture/07-api-architecture.md as the source of truth for endpoint naming and conventions.

The request body must contain only fields that are actually supported by the existing Step 43/44 types and architecture.

The API must NOT accept organization_id from the client.

For a successful queued request, return:

HTTP 202

with a compact response consistent with the existing job APIs, such as:

{
  "status": "queued",
  "job_id": "...",
  "pull_request_id": "...",
  "idempotency_key": "..."
}

Do NOT invent extra response fields unless the existing job API pattern requires them.

If the existing system's job response has a different established shape, reuse that exact shape.

==================================================
5. JOB ORCHESTRATION
==================================================

Because API architecture requires long-running analysis work to be queued:

- inspect existing job type definitions
- inspect existing job enqueue repository/functions
- inspect existing worker dispatch/handler structure
- add the minimum new job type/handler necessary for Step 45
- reuse Step 43 + Step 44 functions
- do not move impact-analysis logic into the worker if it already exists in the DB/shared package

The worker-side flow should conceptually be:

queued impact-analysis job
    ↓
authenticate/validate tenant-owned PR + analysis run
    ↓
Step 43 deterministic impact calculation
    ↓
Step 44 persistence + evidence transaction
    ↓
job completed / failed

Preserve existing at-least-once/idempotency semantics.

If Step 44 already exposes a combined "analyze + persist" function, use it rather than recreating the sequence.

The worker must not accept an organization_id that bypasses normal tenant validation.

==================================================
6. GET ENDPOINT
==================================================

Implement:

GET /api/v1/impact-analyses/:id

Behavior:

1. Authenticate with the existing Bearer JWT / Clerk mechanism.
2. Derive organization_id from the authenticated session.
3. Look up the ImpactAnalysis using the existing Step 44 repository/persistence layer.
4. Enforce tenant isolation through existing DB/RLS conventions.
5. A cross-tenant or nonexistent impact-analysis must not leak whether the record exists.
6. Return the persisted ImpactAnalysis in a stable API representation.
7. Include evidence identifiers already associated with impact findings.
8. Preserve:
   - pull_request_id
   - analysis_run_id
   - status
   - direct impact
   - downstream impact
   - hop distance/depth
   - confidence
   - affected APIs
   - affected events
   - affected services if already part of Step 43/44
   - workflow impact summary
   - unresolved files
   - truncation state/reason
   - max depth reached
   - execution metrics where the public API is intended to expose them
   - created_at
9. Do not expose internal/private database implementation details unnecessarily.
10. Do not recompute the analysis on GET.
11. GET must read persisted state only.

Follow the documented response shape from docs/architecture/07-api-architecture.md and adapt it to the actual Step 43/44 persisted types rather than inventing a second model.

==================================================
7. ROUTING / HTTP LAYER
==================================================

Follow the existing native node:http architecture.

Do not introduce Express, Fastify, Hono, Next API routes, or another HTTP framework.

Add the route using the same layering used by existing endpoints:

request/path recognition
    ↓
request parsing / validation
    ↓
auth
    ↓
tenant-scoped service/repository access
    ↓
job orchestration or persisted read
    ↓
stable JSON response

Keep path recognition separate if that is the established pattern.

For example, follow the existing style of:
- *-request.ts
- * handler.ts
- server.ts route registration
- dedicated test files

Do not make server.ts contain the complete business logic.

==================================================
8. AUTHENTICATION / TENANCY
==================================================

This is critical.

The API must enforce:

Bearer JWT
    ↓
authenticated user
    ↓
organization from server-side auth/session
    ↓
tenant-scoped PR / ImpactAnalysis / AnalysisRun access

Never:

client organization_id
    ↓
trust
    ↓
query

RLS remains defense in depth.

Test:
- authenticated tenant A can access tenant A data
- authenticated tenant A cannot access tenant B PR
- authenticated tenant A cannot access tenant B impact analysis
- cross-tenant access returns the established safe 404/not-found behavior
- no organization data leaks in error responses

==================================================
9. IDEMPOTENCY
==================================================

POST /analyze-impact is a state-changing analysis-trigger endpoint.

Use the existing Idempotency-Key convention.

Test at minimum:

1. First request with key K enqueues one logical analysis.
2. Repeating the same request with key K does not enqueue duplicate work.
3. Same PR with a different valid key follows the existing system's defined behavior.
4. Idempotency state remains tenant-safe.
5. No duplicate ImpactAnalysis/evidence is created by repeated execution.
6. Same PR analyzed against different AnalysisRun values remains independent.

Do not invent an in-memory idempotency cache.

Use the existing durable mechanism.

==================================================
10. ANALYSIS-RUN SELECTION
==================================================

This endpoint must respect the existing architecture around immutable AnalysisRun versions.

Do not silently select an arbitrary graph snapshot.

Use the existing Step 43 / Step 44 behavior for:
- explicitly supplied analysis_run_id, if supported
- otherwise the project's established "current/latest completed usable run" resolution

A PR impact analysis must always be tied to the exact AnalysisRun used for traversal.

The response must make that run visible.

Different AnalysisRun values must remain independent.

==================================================
11. STATUS HANDLING
==================================================

Use the status model already created in Step 44:

pending
running
completed
failed

Do not add a new state machine in Step 45.

POST should represent queueing/triggering work.

GET should expose the persisted status.

Do not fake a completed result before the worker actually persists it.

==================================================
12. TESTING
==================================================

Add focused API tests covering:

A. POST route recognition
B. POST request parsing
C. malformed PR UUID rejection
D. authentication rejection
E. tenant scoping
F. PR not found / inaccessible behavior
G. analysis-run validation
H. successful 202 response
I. correct job payload
J. correct tenant identity in queued job
K. Idempotency-Key handling
L. duplicate trigger behavior
M. GET route recognition
N. GET authentication
O. GET successful persisted result
P. GET not found behavior
Q. cross-tenant GET isolation
R. response mapping preserves impact fields
S. evidence IDs are preserved
T. failed/queued/running/completed/failed status mapping where relevant
U. stable error shape
V. no recomputation during GET

Where practical, mock/inject job and DB dependencies rather than requiring a real external GitHub call.

Follow existing Vitest patterns and dependency injection style.

Do not weaken existing tests to make Step 45 pass.

Also add or extend worker/job tests only where the new Step 45 job orchestration requires them.

==================================================
13. API CONTRACT TESTING
==================================================

Verify that the implementation matches:

POST
/api/v1/pull-requests/:id/analyze-impact

GET
/api/v1/impact-analyses/:id

Verify:
- correct HTTP methods
- correct paths
- correct authentication
- correct status codes
- correct error contract
- correct tenant behavior
- correct idempotency behavior
- correct persisted result representation

Do not implement frontend calls in Step 45.

==================================================
14. DOCUMENTATION
==================================================

Continue the exact Fluxora learning/documentation pattern used in Steps 41–44.

Create:

learning/implementations/phase-06/step-45-pr-impact-analysis-api.md

learning/notes/45. PR Impact Analysis API.md

learning/interviews/45. Step 45 PR Impact Analysis API Interview CheatSheet.md

Update:

docs/DESIGN.md

Documentation must explain in plain English:

1. Why the API is split into POST trigger + GET result.
2. Why POST returns 202 rather than blocking.
3. Request/response contracts.
4. Job orchestration flow.
5. How Step 43 and Step 44 are reused.
6. How Idempotency-Key prevents duplicate logical work.
7. How AnalysisRun versioning is preserved.
8. How authentication and RLS enforce tenant boundaries.
9. Why organization_id is never trusted from the client.
10. GET behavior for pending/running/completed/failed results.
11. Error handling.
12. Testing strategy.
13. Important limitations.
14. Interview questions and answers:
    - Why async 202?
    - Why not run impact analysis inside the HTTP request?
    - Where does tenant identity come from?
    - How does idempotency work?
    - What happens if the worker retries?
    - Why does ImpactAnalysis reference AnalysisRun?
    - How is cross-tenant leakage prevented?
    - Why should GET never recompute?
    - How are deterministic Step 43 results exposed safely through an API?

Use the same organization, terminology, depth, and engineering-learning style as prior Step 41–44 docs.

==================================================
15. DESIGN.md
==================================================

Update docs/DESIGN.md with Step 45 architecture only.

Document the flow:

Client
  ↓
POST /pull-requests/:id/analyze-impact
  ↓
Clerk/Bearer authentication
  ↓
tenant resolution
  ↓
PR validation
  ↓
idempotent job enqueue
  ↓
202 Accepted
  ↓
worker
  ↓
Step 43 Impact Analysis Engine
  ↓
Step 44 ImpactAnalysis + Evidence persistence
  ↓
GET /impact-analyses/:id
  ↓
tenant-scoped persisted result

Include security and failure boundaries.

Do not rewrite unrelated architecture sections.

==================================================
16. SECURITY REQUIREMENTS
==================================================

Explicitly protect against:

- forged organization_id
- cross-tenant PR lookup
- cross-tenant ImpactAnalysis lookup
- unauthorized AnalysisRun selection
- duplicate job creation
- duplicate persisted analysis
- leaking existence of another tenant's analysis
- secrets in logs/job payloads
- recomputation from untrusted request data
- IDOR-style access to impact-analysis ids

Use existing redaction/logging conventions.

==================================================
17. STRICT SCOPE
==================================================

DO NOT implement:

- React Flow changes
- changed/affected node highlighting
- Step 46 frontend change mode
- Step 47 golden PR fixture
- AI explanation
- LLM calls
- simulation
- telemetry
- runtime observation
- new graph algorithms
- new traversal semantics
- new evidence model
- new persistence model
- new database schema unless a migration is genuinely required by the API/job contract and the existing Step 44 design cannot support it
- GraphQL
- Express/Fastify/Hono
- background cron processing

Reuse the existing Step 43/44 implementation.

==================================================
18. VERIFICATION
==================================================

Run and report:

1. focused API tests
2. worker tests if Step 45 adds/changes a worker job handler
3. pnpm test
4. pnpm typecheck
5. pnpm lint
6. pnpm lint:evidence
7. pnpm build
8. git diff --check

Also manually verify:
- POST returns 202
- job is enqueued exactly once for the idempotent request
- GET returns persisted ImpactAnalysis
- wrong tenant receives safe not-found behavior
- GET does not recompute anything
- analysis_run_id remains explicit
- existing Step 43/44 behavior remains unchanged

Do not modify unrelated failing tests or suppress errors.

==================================================
19. FINAL REPORT
==================================================

At the end, report:

- exact files created
- exact files modified
- any migration created (only if genuinely necessary)
- route paths
- request format
- response format
- job type/handler added
- how Step 43 is reused
- how Step 44 is reused
- authentication flow
- tenant/RLS behavior
- idempotency behavior
- AnalysisRun selection behavior
- GET status behavior
- tests added
- exact verification commands/results
- any known limitation
- confirmation that Step 46/47 were not implemented
- confirmation that no commit/push was performed

Do not commit or push.