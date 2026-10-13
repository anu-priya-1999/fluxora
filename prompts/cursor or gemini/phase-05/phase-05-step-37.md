Implement ONLY Fluxora Global Step 37: GraphFilters.

CURRENT STATE

Fluxora has completed:
- Phase 3: Steps 18–26
- Phase 4: Steps 27–33
- Step 34: React Flow GraphCanvas + NodeRenderer
- Step 35: Architecture Explorer route + graph query fetching
- Step 36: NodeInspectorPanel + EvidenceTrail

Step 36 currently provides:
- typed graph-node selection
- NodeInspectorPanel
- EvidenceTrail
- deterministic evidence filtering/ordering
- inspector empty state
- no additional network request for evidence
- backend remains the source of graph truth

The current Explorer architecture must remain intact.

IMPORTANT ARCHITECTURAL RULES

- Do NOT import @fluxora/db into apps/web.
- Do NOT add PostgreSQL access to apps/web.
- Do NOT create a new backend graph endpoint.
- Do NOT modify Step 30 traversal semantics.
- Do NOT modify Step 31 graph-query semantics unless an absolutely necessary compatibility issue is discovered.
- Do NOT modify Step 32 graph.updated behavior.
- Do NOT modify Step 33 golden-fixture behavior.
- Do NOT redesign the Explorer.
- Do NOT implement Step 38 clustering/LOD.
- Do NOT implement Step 39 WebSocket/live updates.
- Do NOT implement Step 40 final polish.
- Do NOT introduce Zustand, Redux, Jotai, or another state-management library.
- Do NOT add unnecessary dependencies.

STEP 37 GOAL

Add graph filtering controls to the Architecture Explorer.

The user must be able to narrow the currently displayed graph using the existing graph-query/filter vocabulary without changing backend graph truth.

Filters should be represented as explicit typed UI state and applied through the existing graph-query contract where appropriate.

FIRST INSPECT THE ACTUAL CURRENT CODE

Inspect:

- apps/web/src/components/graph/GraphCanvas.tsx
- apps/web/src/components/graph/NodeRenderer.tsx
- apps/web/src/components/graph/graph-mapping.ts
- apps/web/src/components/graph/NodeInspectorPanel.tsx
- apps/web/src/components/graph/EvidenceTrail.tsx
- apps/web/src/app/repositories/[repoId]/explorer/page.tsx
- apps/web/src/app/repositories/[repoId]/explorer/explorer-client.tsx
- apps/web/src/app/repositories/[repoId]/explorer/explorer-data.ts
- packages/shared-types/src/graph.ts
- current Step 34/35/36 tests
- current Tailwind/shadcn conventions

Use the ACTUAL current interfaces.
Do not assume names from older implementations.

EXISTING GRAPH QUERY CONTRACT

The current shared GraphQueryRequest supports:

- analysis_run_id
- start_node_id
- direction
- max_depth
- edge_types
- node_types
- min_confidence
- include_evidence

Use this contract rather than inventing a new request shape.

STEP 37 SCOPE

Implement:

1. GraphFilters component
2. typed filter state in the Explorer
3. filter controls for currently supported graph-query filters
4. integration of filters with graph fetching/rendering
5. reset/clear filter behavior
6. deterministic behavior
7. focused tests
8. learning/interview/design documentation

FILTERS TO SUPPORT

At minimum support:

- node types
- edge types
- minimum confidence
- max depth where appropriate to the existing query contract

Preserve existing Explorer defaults:
- direction remains "both" unless the current architecture already exposes direction as a user filter
- analysis_run_id remains the resolved Step 35 analysis run
- start_node_id remains the current selected/default query starting point
- include_evidence remains compatible with NodeInspectorPanel + EvidenceTrail

Do NOT invent additional filter categories.

A. GRAPH FILTERS COMPONENT

Create:

apps/web/src/components/graph/GraphFilters.tsx

Keep it presentational and data-driven.

Responsibilities:
- render available filter controls
- receive typed filter state through props
- emit typed changes through callbacks
- support reset/clear
- do not fetch data directly
- do not access the database
- do not own global application state
- do not contain graph traversal logic

The component should provide a compact, usable filtering surface appropriate for the Explorer.

Suggested conceptual structure:

Graph Filters
├── Node Types
├── Edge Types
├── Minimum Confidence
├── Max Depth
└── Reset Filters

Adapt this to the repository's existing UI conventions.

Do not create a new design system.

B. TYPED FILTER STATE

Use a focused typed structure.

Prefer reusing the existing GraphQueryRequest vocabulary rather than creating a second incompatible domain model.

The state should distinguish:
- selected node types
- selected edge types
- minimum confidence
- maximum depth

Avoid stringly-typed arbitrary filter names.

Do not use `any`.

C. FILTER OPTIONS

Derive filter options from existing shared graph vocabularies where possible.

Use the actual definitions in:

packages/shared-types/src/graph.ts

For example, existing node types include:
- application
- service
- package
- module
- symbol
- api
- event
- database

Existing edge types include:
- IMPORTS
- CALLS
- EXTENDS
- EXPOSES_ROUTE
- EMITS_EVENT
- CONSUMES_EVENT
- QUERIES_DB
- WRITES
- RESOLVES_TO

Do not invent additional types.

Unknown/future graph types should not cause the UI to crash.
However, do not silently fabricate labels or categories for types that are not in the current vocabulary.

D. FILTER APPLICATION

Preserve the backend-as-source-of-truth model.

Preferred flow:

GraphFilters
    ↓
typed filter state
    ↓
Explorer client
    ↓
GraphQueryRequest
    ↓
POST /api/v1/graph/query
    ↓
GraphQueryResponse
    ↓
existing graph mapping
    ↓
GraphCanvas

Do not implement a second client-side graph traversal algorithm.

Do not simply hide arbitrary nodes/edges in the browser if the existing API can express the filter.

Use:
- node_types
- edge_types
- min_confidence
- max_depth

through the existing GraphQueryRequest contract.

The backend remains responsible for traversal semantics.

E. FILTER CHANGES

Determine the smallest sensible fetch behavior from the current Explorer architecture.

When a filter changes:
- the active graph should reflect the new filter
- stale requests must not overwrite newer filter results
- preserve the current selected node only when it still exists in the new graph
- otherwise clear the selection safely
- NodeInspectorPanel should update consistently
- EvidenceTrail should reflect the currently displayed/selected node

Do not add React Query or another data-fetching library solely for this step.

Reuse the existing fetchGraphQuery path.

Avoid accidental duplicate requests caused by unstable objects/dependencies.

F. RESET FILTERS

Provide a deterministic reset operation.

Reset should restore the Explorer's baseline query behavior.

Do not reset:
- authentication
- repository identity
- analysis run identity

Reset only Step 37 filter state.

G. UI BEHAVIOR

The filter UI should clearly communicate active filters.

Requirements:
- current selections are visible
- reset is obvious
- empty selection means "no restriction"
- minimum confidence has a sensible typed representation
- max depth remains within the backend's hard traversal limit
- invalid values are prevented or normalized
- UI does not expose an unlimited depth option

Respect:

HARD_MAX_TRAVERSAL_DEPTH = 20

Do not allow the browser to construct a request exceeding that value.

Do not bypass backend validation.

H. NODE SELECTION + INSPECTOR COMPATIBILITY

Step 36 introduced:

selectedNodeId
    ↓
selectedNode
    ↓
NodeInspectorPanel
    ↓
EvidenceTrail

Step 37 must preserve that flow.

When filters remove the currently selected node:
- clear selectedNodeId
- inspector returns to its empty state
- graph remains usable

When the selected node remains in the graph:
- keep it selected
- keep inspector content synchronized

Do not create a second selection state.

I. URL STATE

Do NOT introduce URL query-parameter synchronization unless the current Explorer architecture already uses it for UI filters.

Step 35 already uses URL/search parameters for analysis-run/start-node context.

Do not repurpose those parameters for Step 37 filter state unless the repository already has an established convention.

Prefer local typed UI state for this step.

J. PERFORMANCE

Avoid unnecessary recomputation and duplicate network requests.

Use memoization only where it materially helps.

Do not introduce premature graph optimization.

Do not implement clustering or LOD.

Large-graph behavior remains bounded by the existing backend traversal/query constraints.

K. TESTING

Use the EXISTING web test setup.

Add focused Step 37 tests covering at minimum:

1. GraphFilters renders the supported filter categories.
2. Selecting node types updates typed filter state.
3. Selecting edge types updates typed filter state.
4. Changing minimum confidence updates filter state.
5. Changing max depth updates filter state.
6. Reset restores the default filter state.
7. Empty node-type selection means no node-type restriction.
8. Empty edge-type selection means no edge-type restriction.
9. max depth cannot exceed HARD_MAX_TRAVERSAL_DEPTH.
10. GraphQueryRequest uses the existing field names:
    - node_types
    - edge_types
    - min_confidence
    - max_depth
11. organization_id is not added to the request.
12. analysis_run_id and start_node_id remain preserved.
13. changing filters causes the Explorer to request the updated graph.
14. stale/obsolete results do not replace newer filter results.
15. selected node is cleared when filters remove it.
16. selected node remains selected when still present.
17. NodeInspectorPanel remains synchronized after filtering.
18. EvidenceTrail remains synchronized after filtering.
19. existing Step 34 tests continue to pass.
20. existing Step 35 tests continue to pass.
21. existing Step 36 tests continue to pass.
22. no database/network logic is introduced into GraphFilters itself.

Do not weaken existing tests.
Do not skip failures.
Do not use `any`.

L. SECURITY / ARCHITECTURE CHECKS

Verify explicitly:

- apps/web does not import @fluxora/db
- no PostgreSQL access exists in the frontend
- no tenant/org identifier is sent by the browser
- no authentication mechanism is changed
- no backend endpoint was added
- no graph traversal logic was copied into the frontend
- filters are bounded and validated
- backend remains authoritative for graph query semantics

M. DOCUMENTATION

Follow the SAME documentation pattern as Steps 1–36.

Create:

learning/implementations/phase-05/step-37-graph-filters.md

learning/notes/37. Graph Filters.md

learning/interviews/37. Step 37 Graph Filters Interview CheatSheet.md

Update:

docs/DESIGN.md

Do not delete historical content.

Explain in plain English:
- what GraphFilters adds
- why filters belong at the Explorer/UI boundary
- filter-state data flow
- GraphFilters responsibility
- Explorer responsibility
- how filters become GraphQueryRequest fields
- why filtering should remain backend-aware
- node-type filtering
- edge-type filtering
- minimum-confidence filtering
- max-depth filtering
- reset behavior
- selected-node interaction
- inspector/evidence interaction
- request race/stale-response handling
- determinism
- performance limitations
- security/tenant boundaries
- why no new backend endpoint was needed
- exactly what Step 37 does NOT implement
- how Step 38 will build on this foundation
- senior-level interview questions and answers

N. DESIGN.md

Append/update the Step 37 living implementation state.

Advance the roadmap state to Step 38 only after implementation and verification are actually complete.

Do not rewrite historical Step 34–36 information.

O. VERIFICATION

Run:

1. focused Step 37 tests
2. pnpm --filter @fluxora/web test
3. pnpm --filter @fluxora/web typecheck
4. pnpm typecheck
5. pnpm lint
6. pnpm lint:evidence
7. pnpm build
8. git diff --check

Do not claim a command passed unless it actually passed.

P. FINAL REPORT

Report:

1. exact files created
2. exact files modified
3. dependency changes
4. exact tests and results
5. typecheck result
6. lint result
7. evidence-lint result
8. build result
9. filter state architecture
10. GraphQueryRequest mapping
11. stale-request handling
12. selected-node/inspector behavior under filtering
13. architectural decisions
14. assumptions/limitations

Explicitly confirm:

- GraphFilters implemented
- node-type filtering implemented
- edge-type filtering implemented
- minimum-confidence filtering implemented
- max-depth filtering implemented
- reset implemented
- NodeInspectorPanel compatibility preserved
- EvidenceTrail compatibility preserved
- no @fluxora/db import in apps/web
- no PostgreSQL access from apps/web
- no new backend endpoint
- no new state-management dependency
- no clustering/LOD
- no WebSocket/live updates
- no simulation/impact/AI UI
- no Phase 6+ functionality
- no commit
- no push