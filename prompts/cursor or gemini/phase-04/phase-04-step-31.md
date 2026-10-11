You are implementing ONLY Fluxora Global Step 31: POST /api/v1/graph/query.

Do not implement Global Step 32 or anything later.
Do not refactor unrelated code.
Do not redesign the graph schema.
Do not migrate the test framework.

==================================================
1. FIRST: INSPECT THE ACTUAL CURRENT REPOSITORY
==================================================

Before changing anything:

1. Inspect the latest git history and current git status.
2. Read:
   - docs/architecture/17-implementation-roadmap.md
   - docs/architecture/07-api-architecture.md
3. Inspect the actual current implementations of:
   - packages/shared-types/src/graph.ts
   - packages/db/src/repositories/graph.ts
   - packages/db/src/repositories/graph-storage.test.ts
   - apps/api/src/http/server.ts
   - apps/api/src/http/routes.ts
   - existing API route handlers
   - existing auth/session middleware
   - existing request validation/error conventions
   - existing API tests
   - existing tenant/RLS helpers
4. Inspect the existing Step 30 traversal implementation and tests.
5. Inspect Step 29 Evidence Writer implementation and CI lint.
6. Inspect docs/DESIGN.md and the Step 30 learning/interview/note files.
7. Inspect current package scripts and test commands.

Use the actual repository as the source of truth.
Do not assume older architecture from previous prompts.

==================================================
2. STEP 31 OBJECTIVE
==================================================

Implement:

POST /api/v1/graph/query

This endpoint is the API boundary over the reusable Step 30 graph traversal function.

The intended flow is:

HTTP request
    ↓
authenticate request
    ↓
derive organization_id from authenticated identity
    ↓
validate request body
    ↓
validate requested analysis run / graph scope
    ↓
call Step 30 traverseGraph(...)
    ↓
return stable JSON response

The endpoint must NOT duplicate the recursive CTE.
Reuse the existing Step 30 repository traversal implementation.

==================================================
3. API CONTRACT
==================================================

The endpoint is:

POST /api/v1/graph/query

Request body follows the architecture contract:

{
  "analysis_run_id": "run_7c3e...",
  "start_node_id": "node_paymentprovider",
  "direction": "downstream",
  "max_depth": 3,
  "edge_types": ["CALLS", "EMITS_EVENT", "CONSUMES_EVENT"],
  "min_confidence": 0.6
}

The current Step 30 repository API uses its established internal concepts.

Inspect the actual current types before mapping the HTTP request.

Where the external API says:

- downstream → map to the existing traversal direction convention
- upstream → map to incoming
- both → map to both

Do not change the Step 30 repository API merely to match the HTTP naming unless inspection proves it is necessary and safe.

==================================================
4. RESPONSE CONTRACT
==================================================

Return a stable JSON response suitable for the architecture described in 07-api-architecture.md.

The response should expose graph query information without leaking internal DB details.

At minimum represent:

- nodes
- edges
- evidence when requested/available
- depth/truncation information

The response should map internal GraphNode / GraphEdge / EvidenceRecord objects into API-safe JSON.

Use explicit response mapping rather than returning raw PostgreSQL rows.

Do not expose:

- database internals
- SQL
- internal stack traces
- credentials
- tenant identifiers unless already intentionally part of the public API contract
- unrelated internal metadata that should remain private

==================================================
5. MIN_CONFIDENCE
==================================================

The API architecture example includes:

"min_confidence": 0.6

Inspect Step 30's current traversal implementation.

If confidence filtering already exists internally, wire it through.

If Step 30 currently does NOT support confidence filtering:

- implement the smallest Step 31-compatible filtering layer necessary
- do not redesign traversal
- apply filtering deterministically to the returned graph data
- document exactly how the filter is applied
- do not silently ignore min_confidence

Prefer extending the existing traversal options only when required by the API contract.

Do not invent semantics beyond what the current architecture supports.

==================================================
6. DIRECTION MAPPING
==================================================

Public API:

- "downstream" = outgoing traversal
- "upstream" = incoming traversal
- "both" = both

Validate allowed values explicitly.

Invalid directions must produce the repository's standard API validation error shape.

Do not silently default invalid values.

==================================================
7. REQUEST VALIDATION
==================================================

Validate:

- analysis_run_id
- start_node_id
- direction
- max_depth
- edge_types
- min_confidence

Use the existing validation conventions where possible.

Requirements:

- max_depth must respect Step 30's server-side hard cap
- reject negative/non-integer max_depth
- reject confidence outside valid bounds
- reject malformed UUIDs where the current repository requires UUIDs
- reject malformed arrays/types
- reject unknown/invalid enum-style values where the existing contracts define them

Do not trust organization_id from the request body.

The API must derive tenant identity from authentication.

==================================================
8. AUTHENTICATION / TENANT ISOLATION
==================================================

Follow the existing API authentication architecture.

The organization must come from the authenticated user/session.

The client MUST NOT be able to select another organization by sending organization_id.

Use the existing auth middleware/helpers.

Then invoke graph traversal using the authenticated organization scope.

Cross-tenant graph access must remain impossible.

Do not weaken RLS.

Do not introduce a second authentication mechanism.

==================================================
9. ANALYSIS-RUN / START-NODE SCOPE
==================================================

The requested start node must belong to the requested analysis run and authenticated tenant.

Reuse the Step 30 behavior.

Expected safe behavior for inaccessible/cross-scope data should match the established repository semantics.

Do not leak whether another tenant owns a node.

Avoid turning "not accessible" into a distinguishable cross-tenant error if existing architecture intentionally treats it as not found.

Follow current project conventions after inspection.

==================================================
10. ERROR CONTRACT
==================================================

Use the API convention:

{
  "error": {
    "code": "...",
    "message": "...",
    "details": {}
  }
}

Inspect existing endpoints and reuse the project's real error helper/types.

At minimum distinguish:

- unauthenticated
- forbidden/unauthorized according to current auth conventions
- invalid request
- invalid traversal options
- missing/inaccessible graph start node where the API contract requires it
- internal database failure

Never return raw SQL errors.

Never expose stack traces or secrets.

Do not invent a parallel error framework.

==================================================
11. HTTP STATUS CODES
==================================================

Follow existing API conventions.

Expected shape should be approximately:

200 for successful graph query

400 for malformed/invalid input

401/403 according to the existing authentication/authorization conventions

404 only where the existing API architecture intentionally exposes a missing resource

500 for unexpected internal failures

Do not introduce nonstandard codes without repository justification.

==================================================
12. EVIDENCE
==================================================

Step 30 already supports evidence retrieval.

Expose evidence in a stable API-safe format.

Preserve:

- evidence id
- subject
- file path
- symbol id
- source line/column information
- relationship description
- confidence
- relevant metadata

Do not fabricate evidence.

Do not generate new evidence during graph querying.

Graph query is read-only.

Do not write GraphNode, GraphEdge, or Evidence records.

==================================================
13. READ-ONLY GUARANTEE
==================================================

Step 31 is strictly a query endpoint.

The implementation MUST NOT:

- mutate graph_nodes
- mutate graph_edges
- mutate evidence
- create analysis runs
- trigger ingestion
- enqueue jobs
- modify repository state

The endpoint should be safe to call repeatedly.

==================================================
14. PERFORMANCE / SAFETY
==================================================

Reuse Step 30's bounded-depth traversal.

Do not add unbounded recursion.

Do not load the whole graph into application memory before traversing.

Respect:

HARD_MAX_TRAVERSAL_DEPTH

Do not introduce N+1 queries where the existing traversal implementation already avoids them.

Keep the endpoint thin:
HTTP validation/mapping → repository traversal → response mapping.

Do not add caching in Step 31.

Do not add pagination unless the current architecture already requires it for graph queries.

Do not implement large graph visualization logic.

==================================================
15. TESTS
==================================================

Add focused Step 31 API tests.

At minimum test:

1. Valid downstream graph query returns 200.
2. Valid upstream query maps correctly.
3. Valid both-direction query works.
4. max_depth is honored.
5. hard traversal depth cap is enforced.
6. edge_types filter is honored.
7. node_types filter is honored if exposed by the API.
8. min_confidence is honored according to the chosen implementation.
9. malformed request is rejected with the standard error shape.
10. invalid direction is rejected.
11. invalid confidence is rejected.
12. unauthenticated request is rejected.
13. cross-tenant access is rejected/hidden according to existing security semantics.
14. inaccessible start node does not leak cross-tenant information.
15. evidence is returned correctly.
16. successful query performs no graph writes.
17. database/repository failures are converted to safe API errors.
18. deterministic response ordering remains stable across repeated identical queries.

Reuse existing API test helpers and auth test patterns.

Do NOT rewrite all API tests.

Do NOT migrate node:test → Vitest.

==================================================
16. ROUTING
==================================================

Inspect the existing native node:http routing architecture.

Register:

POST /api/v1/graph/query

using the project's existing routing style.

Do not introduce Express, Fastify, Hono, Next API routes, or another framework.

Use the existing native node:http architecture.

==================================================
17. CONTENT TYPE / BODY HANDLING
==================================================

Use the existing request-body parser and JSON handling conventions.

Require JSON request content where the project already enforces content types.

Handle malformed JSON safely.

Do not allow oversized request bodies beyond existing API limits.

Do not build a second body parser.

==================================================
18. SHARED TYPES
==================================================

Only add shared API request/response types if the existing architecture benefits from them.

Prefer a small explicit contract.

Potential types:

GraphQueryDirection
GraphQueryRequest
GraphQueryResponse

But inspect the current shared-types structure first.

Do not duplicate GraphTraversalOptions unnecessarily.

Keep internal traversal types separate from the public HTTP contract when their semantics differ.

==================================================
19. LEARNING DOCUMENTATION — REQUIRED
==================================================

Continue the EXACT learning pattern from Steps 18–30.

Create:

learning/implementations/phase-04/step-31-graph-query-api.md

Create/update the next engineering note under:

learning/notes/

Create:

learning/interviews/31. Step 31 Graph Query API Interview CheatSheet.md

Update:

docs/DESIGN.md

Do NOT delete previous documentation.

==================================================
20. IMPLEMENTATION DOCUMENTATION
==================================================

Explain in plain English:

A. What Step 31 does
B. Why Step 30 is an internal query primitive
C. Why Step 31 adds an HTTP boundary
D. Request → auth → validation → traversal → response flow
E. Public direction mapping
F. max-depth protection
G. tenant/RLS enforcement
H. analysis-run scoping
I. confidence filtering semantics
J. evidence exposure
K. read-only guarantees
L. API error handling
M. deterministic response behavior
N. security considerations
O. testing strategy
P. limitations
Q. explicit Step 31 boundary

Include architecture/data-flow diagrams consistent with previous implementation documents.

==================================================
21. ENGINEERING NOTES
==================================================

Teach:

- API boundary vs repository/query layer
- request validation
- authenticated tenant derivation
- mapping public API concepts to internal traversal concepts
- bounded graph querying
- confidence filtering
- evidence as part of trustworthy graph results
- read-only query semantics
- API error contracts
- why graph traversal logic should not be duplicated in an HTTP handler
- how Step 31 prepares for later graph.updated/diff functionality

Use plain English first, then technical terminology.

==================================================
22. INTERVIEW CHEATSHEET
==================================================

Cover:

- Why separate Step 30 and Step 31?
- Why keep recursive CTE logic out of the HTTP layer?
- How is tenant isolation enforced?
- How do you prevent traversal abuse?
- Why does max_depth have both default and hard limits?
- How do downstream/upstream map to the internal graph?
- How does evidence reach the API?
- How do you avoid leaking cross-tenant graph information?
- How do you validate min_confidence?
- What happens on malformed requests?
- Why is the endpoint read-only?
- What would you cache later and why is it excluded now?
- What are the main scalability limitations?

Provide concise interview-ready answers followed by deeper explanations.

==================================================
23. docs/DESIGN.md
==================================================

Add/update the Step 31 section.

Document:

- POST /api/v1/graph/query
- authentication
- tenant derivation
- request validation
- traversal delegation
- direction mapping
- depth limits
- confidence filtering
- evidence response
- error contract
- read-only guarantee
- performance/safety boundaries
- Step 31 → Step 32 transition

Do not rewrite unrelated DESIGN.md sections.

==================================================
24. STRICT STEP BOUNDARY
==================================================

DO NOT IMPLEMENT:

- graph.updated events
- graph diff summaries
- previous-run graph delta calculation
- WebSocket graph update broadcasting
- PR impact analysis
- golden-fixture graph verification
- graph UI
- React Flow
- graph caching
- AI explanations
- vector search
- simulations
- Vitest migration
- broad API refactors

Those belong to later steps.

==================================================
25. VERIFICATION
==================================================

Run focused Step 31 API tests first.

Then run:

pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm lint:evidence
git diff --check

Verify:

- Step 30 tests remain green
- Step 28 tests remain green
- Step 29 evidence lint remains green
- no new test skips are introduced
- no graph writes occur during API queries
- build succeeds
- no type errors
- no lint errors

If any test is skipped, identify exactly why.

==================================================
26. FINAL REPORT
==================================================

Report:

1. Files created
2. Files modified
3. Endpoint implementation
4. Request contract
5. Response contract
6. Authentication/tenant handling
7. Step 30 integration
8. Confidence-filtering behavior
9. Evidence behavior
10. Error behavior
11. Tests added
12. Exact verification commands/results
13. Any environment/migration requirements
14. Explicit confirmation that Step 32+ was not implemented
15. Recommended git commit message

Recommended commit message:

feat(api): add graph query endpoint

Do not create a commit automatically unless explicitly instructed.