Implement ONLY Fluxora Global Step 35: Architecture Explorer Route + Graph Query Fetching.

Do not implement Step 36 or any later Phase 5 work.

CURRENT STATE

Fluxora has completed:
- Phase 3: Steps 18–26
- Phase 4: Steps 27–33
- Step 34: React Flow integration, GraphCanvas, NodeRenderer, deterministic graph mapping, and graph UI tests

Step 34 created the rendering foundation in:
apps/web/src/components/graph/

GraphCanvas is intentionally presentational and does NOT perform API requests.

STEP 35 GOAL

Implement the Architecture Explorer route:

/repositories/[repoId]/explorer

The route must obtain the repository's current/latest usable analysis-run context and fetch graph data through the existing API contract:

POST /api/v1/graph/query

Then pass the returned graph into the existing Step 34 GraphCanvas.

The frontend must remain a consumer of backend graph truth.
Do not recreate graph logic in the browser.

ARCHITECTURAL SOURCE OF TRUTH

Before editing, inspect:
1. docs/architecture/17-implementation-roadmap.md
2. docs/architecture/10-frontend-architecture.md
3. docs/DESIGN.md
4. current apps/web structure
5. existing authentication patterns
6. existing API/client-fetch patterns
7. existing repository/analysis-run types
8. existing GraphQueryRequest / GraphQueryResponse shared types
9. existing Step 34 GraphCanvas and graph-mapping implementation
10. existing tests in apps/web

Reuse existing conventions.
Do not create a second frontend architecture.

STRICT STEP BOUNDARY

Step 35 MAY implement:
- /repositories/[repoId]/explorer route
- route-level graph loading
- authenticated graph API request
- obtaining the repository's relevant analysis-run identifier using existing backend/data contracts
- transforming the GraphQueryResponse into the Step 34 GraphCanvas input
- basic page-level loading/error/empty handling required for this route
- tests for the above

Step 35 MUST NOT implement:
- NodeInspectorPanel
- EvidenceTrail
- GraphFilters
- clustering
- level-of-detail
- WebSocket live updates
- graph.updated cache invalidation
- impact/change mode
- simulation mode
- AI UI
- Phase 6 PR impact analysis
- new backend graph algorithms
- changes to Step 30 traversal
- changes to Step 31 graph-query semantics
- changes to Step 32 events/diffs
- changes to Step 33 golden fixture behavior
- another graph rendering library
- a new state-management library

A. EXPLORER ROUTE

Create the route according to the current Next.js App Router conventions:

apps/web/src/app/repositories/[repoId]/explorer/page.tsx

Use the existing route/layout patterns in apps/web.

The page must:
- receive repoId from the route params
- resolve the repository's relevant/latest analysis context using existing application contracts
- request graph data through POST /api/v1/graph/query
- pass the resulting graph to the existing GraphCanvas
- keep browser-only React Flow behavior inside the existing client GraphCanvas boundary
- avoid putting backend business rules into the page

Do not duplicate graph traversal or graph construction logic in the web app.

B. AUTHENTICATED API REQUEST

Use the repository's existing Clerk authentication pattern.

The browser/server boundary must follow the current architecture.

Do not:
- expose secrets
- send organization_id from the browser
- invent a new authentication mechanism
- bypass the existing API

The API already derives tenant identity from the authenticated session.
The web client should provide only the information the existing API contract actually requires.

Use:
POST /api/v1/graph/query

Reuse the existing GraphQueryRequest shape from @fluxora/shared-types.

Do not alter the public Step 31 API contract unless an absolutely necessary compatibility issue is discovered.
If an existing contract is insufficient, stop and document the issue rather than silently redesigning Step 31.

C. ANALYSIS RUN RESOLUTION

The explorer needs an analysisRunId for graph queries.

Inspect the existing repository and analysis-run APIs/repositories before implementing this.

Prefer an already-existing read contract.

Do NOT create a new analysis-run backend feature as part of Step 35 unless the current architecture genuinely has no existing way to resolve the repository's analysis run.

If multiple completed runs exist:
- use the architecture's existing notion of the latest/current usable run
- do not invent arbitrary sorting rules
- reuse existing status semantics

If no usable analysis run exists:
- render a deterministic empty/not-ready state
- do not fabricate a graph

D. GRAPH REQUEST

The initial Explorer request should use the existing graph-query contract.

For the first implementation:
- query the relevant analysis run
- use a safe default start-node strategy consistent with the current graph-query API
- do not invent an API field
- do not add cluster_by
- do not add advanced filters
- do not query unlimited depth
- use the existing hard traversal limits

IMPORTANT:
The Explorer must not assume that every repository has a single arbitrary root node.

Inspect current graph node types and repository/analysis contracts and choose the smallest correct initial query strategy supported by the existing system.

If the current API intentionally requires a start_node_id and there is not yet an existing repository-root graph contract, implement the smallest route-level mechanism that resolves a valid initial graph node from existing graph data without modifying the graph architecture.

E. DATA MAPPING

Reuse:
apps/web/src/components/graph/graph-mapping.ts

Do not create a second domain→React Flow mapper.

Flow should conceptually be:

repository route
    ↓
resolve repository / analysis run
    ↓
POST /api/v1/graph/query
    ↓
GraphQueryResponse
    ↓
existing graph mapping
    ↓
GraphCanvas
    ↓
React Flow

The API response remains the source of truth.

F. LOADING / EMPTY / ERROR STATES

Implement only the route-level states necessary for Step 35:

Loading:
- clear loading indication while graph/repository context is being resolved

Empty:
- repository exists but there is no usable graph/analysis result
- explain that graph analysis is not ready yet

Error:
- repository unavailable
- analysis unavailable
- graph API failure
- authentication failure

Do not build the final Step 40 polish system yet.

Keep the state handling simple and accessible.

G. SERVER VS CLIENT BOUNDARY

Follow the current Next.js App Router pattern.

Prefer:
- server-side data resolution where appropriate
- client-side interactivity only where needed
- GraphCanvas remains the client component

Do not mark the entire Explorer page as "use client" unless the existing architecture proves that necessary.

Do not move Clerk/backend logic into a browser-only component unnecessarily.

H. TESTING

Add Step 35-focused tests using the EXISTING web testing setup.

At minimum verify:

1. /repositories/[repoId]/explorer resolves the expected repository/analysis context.
2. The graph query request targets POST /api/v1/graph/query.
3. The request uses the existing GraphQueryRequest contract.
4. No organization_id / organizationId is invented or sent from the client.
5. A successful GraphQueryResponse is mapped into GraphCanvas input.
6. The GraphCanvas receives deterministic graph data.
7. Empty graph/analysis state renders correctly.
8. Graph API errors render a safe error state.
9. Authentication failures do not leak sensitive information.
10. No network logic is introduced into GraphCanvas itself.
11. Existing Step 34 graph mapping tests continue to pass.

Mock network/API boundaries rather than requiring a real external deployment.

Do not skip failing tests.
Do not weaken existing assertions.

I. COMPONENT STRUCTURE

Use the smallest reasonable structure.

Possible shape:

apps/web/src/app/repositories/[repoId]/explorer/
  page.tsx
  loading.tsx          (only if consistent with current app conventions)
  error.tsx            (only if useful and consistent)

Create additional helper/client files only when they provide a real separation of responsibility.

Do not prematurely create Step 36 components.

J. DOCUMENTATION REQUIRED

Create:

learning/implementations/phase-05/step-35-architecture-explorer-route.md

learning/notes/35. Architecture Explorer Route and Graph API Fetching.md

learning/interviews/35. Step 35 Architecture Explorer Interview CheatSheet.md

Update:

docs/DESIGN.md

Do not delete historical content.

The Step 35 documentation must explain in plain English:
- what the Architecture Explorer route is
- why the route exists separately from GraphCanvas
- server/client boundary
- how repository → analysis run → graph query works
- how authentication is preserved
- why the browser does not construct graph truth
- how GraphQueryResponse becomes GraphCanvas input
- loading/error/empty handling
- why analysis-run resolution matters
- determinism and tenant-security considerations
- what Step 35 does NOT implement
- how Step 36 will build on this foundation
- testing strategy
- senior-level interview questions and answers

K. DESIGN.md

Add the Step 35 state to the living implementation snapshot.

Update the next step to Step 36 only after implementation and verification are actually complete.

Do not rewrite historical Phase 5 information.

L. IMPORTANT BACKEND RULE

Avoid backend changes.

Step 35 is primarily a web/application integration step.

Do NOT modify:
- graph-builder logic
- graph traversal SQL
- graph persistence
- evidence writer
- graph.updated events
- Step 31 response semantics
- Step 33 fixture contracts

Only modify shared types/backend code if an existing public contract has a clearly demonstrated integration gap.
Prefer adapting the web route to the existing contracts.

M. VERIFICATION

Run, in a sensible order:

1. focused Step 35 web tests
2. pnpm --filter @fluxora/web test
3. pnpm --filter @fluxora/web typecheck
4. pnpm typecheck
5. pnpm lint
6. pnpm lint:evidence
7. pnpm build
8. git diff --check

Do not claim a command passed unless it actually passed.

N. FINAL REPORT

Report:
1. exact files created
2. exact files modified
3. dependency changes, if any
4. exact tests run + results
5. typecheck/lint/evidence-lint/build results
6. repository/analysis-run resolution approach
7. authentication/data-flow approach
8. assumptions
9. explicit scope confirmation

Explicitly confirm:
- Step 36 NOT implemented
- NodeInspectorPanel NOT implemented
- EvidenceTrail NOT implemented
- GraphFilters NOT implemented
- clustering/LOD NOT implemented
- WebSocket/live updates NOT implemented
- impact/simulation/AI UI NOT implemented
- no Phase 6+ functionality implemented

DO NOT COMMIT OR PUSH.