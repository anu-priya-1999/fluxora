Implement ONLY Fluxora Global Step 34: React Flow Graph Canvas + Node Renderers.

Do not implement Step 35 or any later Phase 5 work.

CURRENT CONTEXT
Fluxora has completed:
- Phase 3 code intelligence Steps 18–26
- Phase 4 graph storage/builder/evidence/traversal Steps 27–29
- Step 30 bounded-depth recursive graph traversal
- Step 31 POST /api/v1/graph/query
- Step 32 graph.updated events + deterministic graph diffs
- Step 33 golden-fixture graph verification

Step 33 verified that the persisted graph is deterministic, canonical, evidence-backed, idempotent, and tenant/run isolated.

PHASE 5 STEP 34 SCOPE
The roadmap defines Step 34 as:
1. Integrate React Flow.
2. Implement GraphCanvas.
3. Implement per-node-type NodeRenderer.

The next step (Step 35) will create:
- /repositories/[repoId]/explorer
- API fetching through POST /graph/query

Therefore Step 34 MUST NOT implement:
- explorer route
- graph API fetching
- React Query graph queries
- WebSocket updates
- NodeInspectorPanel
- EvidenceTrail
- GraphFilters
- clustering / level-of-detail
- impact overlays
- simulation overlays
- AI UI
- Phase 6 functionality

IMPORTANT ARCHITECTURAL RULE
The frontend must visualize deterministic graph data returned by Fluxora.
The frontend must never invent graph relationships or become a second graph-building system.

BEFORE EDITING
1. Inspect the current apps/web structure and existing Next.js App Router implementation.
2. Inspect the current package.json files and existing frontend dependencies.
3. Inspect docs/architecture/10-frontend-architecture.md.
4. Inspect docs/architecture/17-implementation-roadmap.md.
5. Inspect docs/DESIGN.md.
6. Inspect existing shared graph types in @fluxora/shared-types.
7. Inspect existing graph-query response types/contracts.
8. Reuse the repository's existing frontend conventions and test setup.
9. Do NOT introduce a new testing framework as part of Step 34.
10. Do NOT migrate existing node:test tests to Vitest as part of this step.

IMPLEMENTATION

A. React Flow integration
- Add the appropriate React Flow React dependency using the project's existing package-manager conventions.
- Use the currently appropriate React Flow package for this repository rather than introducing a different graph library.
- Keep the integration isolated to apps/web.
- Do not create a parallel graph model unrelated to the shared graph contracts.

B. GraphCanvas
Create the graph canvas component at the architecture-aligned location:
apps/web/src/components/graph/GraphCanvas.tsx
(or the repository's established equivalent if the current web structure already has a component convention).

GraphCanvas responsibilities for Step 34:
- client-side React Flow wrapper
- accept typed graph nodes/edges as props
- map domain graph records into React Flow node/edge objects
- provide basic pan/zoom interaction
- render the graph deterministically
- define nodeTypes cleanly
- keep backend fetching completely outside this component
- keep business logic out of the canvas
- expose a small, typed component API suitable for Step 35+
- preserve a clear boundary between Fluxora domain graph data and React Flow rendering data

Do not add API requests inside GraphCanvas.

C. NodeRenderer
Create:
apps/web/src/components/graph/NodeRenderer.tsx

Implement per-node-type rendering for the node types that already exist in the shared graph domain.

The renderer must:
- use the existing GraphNode type/category vocabulary
- render node identity clearly
- visually distinguish node types
- expose important safe metadata available in the graph response
- support selected/active visual state through props
- remain presentational
- avoid fetching data
- avoid modifying graph state
- avoid embedding business rules

Do not invent additional graph node types.

D. Domain → React Flow mapping
Create the smallest appropriate mapping utility/helper if needed.

Requirements:
- deterministic node IDs
- deterministic edge IDs
- preserve source/target relationships
- preserve node type information
- preserve relevant metadata needed by NodeRenderer
- no random IDs
- no Date.now()
- no UUID generation for render identity
- no mutation of source API/domain objects

E. Layout
For Step 34, implement only a simple deterministic initial layout sufficient to make the graph usable.

Do NOT implement:
- clustering
- level-of-detail
- server-side aggregation
- advanced graph layout algorithms
- large-graph optimization

A straightforward deterministic layout is sufficient at this step.

F. Styling
Use the existing Fluxora frontend styling conventions:
- Tailwind
- existing design tokens/components where appropriate

The canvas must be visually understandable but does not need final product polish.

Keep node styling extensible for later:
- selected state
- confidence presentation
- change-mode overlays
- simulation-mode overlays

Do not implement those later modes now.

TESTING

Add component-focused tests using the repository's EXISTING web testing setup.

Tests must verify at minimum:
1. GraphCanvas renders supplied graph nodes.
2. GraphCanvas renders supplied edges.
3. NodeRenderer selects the correct presentation for each supported node type.
4. Domain IDs are preserved deterministically.
5. Empty graph renders without crashing.
6. A graph with multiple node types renders without crashing.
7. Rendering does not perform network requests.
8. No unexpected node/edge duplication is introduced during mapping.

Keep tests focused on Step 34 behavior.

Do not weaken existing tests.

DOCUMENTATION REQUIRED

Create:
- learning/implementations/phase-05/step-34-react-flow-graph-canvas.md
- learning/notes/34. React Flow Graph Canvas and Node Rendering.md
- learning/interviews/34. Step 34 React Flow Graph Canvas Interview CheatSheet.md

Update:
- docs/DESIGN.md

Do NOT delete or rewrite historical DESIGN.md content.
Add the Step 34 implementation state and make Step 35 the next step only after the implementation is actually complete.

DOCUMENTATION CONTENT

Explain in plain English:
- what Step 34 adds
- why React Flow is used
- GraphCanvas responsibility
- NodeRenderer responsibility
- domain graph data vs. rendering-library data
- how node/edge identity stays deterministic
- why fetching is intentionally not inside GraphCanvas
- client-component considerations in Next.js
- rendering boundaries and separation of concerns
- what Step 34 does NOT implement
- how Step 35 will build on this foundation
- testing strategy
- performance limitations at this stage
- likely senior-level interview questions and answers

IMPORTANT
Do not modify:
- apps/api graph query behavior
- apps/workers graph construction
- PostgreSQL graph schema
- Step 30 traversal
- Step 32 graph.updated event behavior
- Step 33 golden fixture semantics

Only make backend/shared-type changes when absolutely necessary to expose an already-existing contract cleanly to the frontend. Prefer no backend changes.

VERIFICATION

Run:
1. focused Step 34 web component tests
2. relevant existing web tests
3. pnpm typecheck
4. pnpm lint
5. pnpm lint:evidence
6. pnpm build
7. git diff --check

Do not claim success unless the commands actually pass.

FINAL REPORT

Report:
1. exact files created
2. exact files modified
3. dependency changes
4. tests run + results
5. typecheck/lint/build results
6. architectural decisions
7. assumptions
8. explicit confirmation:
   - Step 35 NOT implemented
   - no graph API fetching added
   - no WebSocket work added
   - no NodeInspectorPanel/EvidenceTrail/GraphFilters added
   - no clustering/LOD added
   - no Phase 6+ work added

Do NOT commit or push.