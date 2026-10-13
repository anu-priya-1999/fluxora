Implement ONLY Fluxora Global Step 36: NodeInspectorPanel + EvidenceTrail.

CURRENT STATE

Fluxora has completed:
- Phase 3: Steps 18–26
- Phase 4: Steps 27–33
- Step 34: React Flow GraphCanvas + NodeRenderer
- Step 35: Architecture Explorer route + authenticated graph query fetching

The Step 35 stale file
apps/web/src/app/repositories/[repoId]/explorer/resolve-context.server.ts
has been removed.

Do NOT recreate it.
Do NOT add @fluxora/db to apps/web.
Do NOT add any database access to apps/web.

STEP 36 GOAL

When the user selects a graph node in the Architecture Explorer, show a right-side inspector containing:

1. NodeInspectorPanel
2. EvidenceTrail

The existing backend graph query response remains the source of truth.

ACTUAL SHARED GRAPH QUERY CONTRACT

Inspect and reuse the existing types in:
packages/shared-types/src/graph.ts

The current GraphQueryResponse contains:

GraphQueryResponseNode:
- id
- type
- name
- canonical_id
- depth
- confidence
- path
- metadata

GraphQueryResponseEdge:
- id
- source
- target
- type
- confidence
- provenance
- evidence_id
- canonical_id
- metadata

GraphQueryResponseEvidence:
- id
- subject_type
- subject_id
- file_path
- symbol_id
- line_start
- line_end
- column_start
- column_end
- relationship_description
- confidence
- metadata

GraphQueryResponse:
- nodes
- edges
- max_depth_reached
- truncated
- evidence

Use these actual field names.
Do not invent alternate evidence models.

BEFORE EDITING

Inspect the actual current implementation of:

- apps/web/src/components/graph/GraphCanvas.tsx
- apps/web/src/components/graph/NodeRenderer.tsx
- apps/web/src/components/graph/graph-mapping.ts
- apps/web/src/app/repositories/[repoId]/explorer/page.tsx
- apps/web/src/app/repositories/[repoId]/explorer/explorer-client.tsx
- apps/web/src/app/repositories/[repoId]/explorer/explorer-data.ts
- packages/shared-types/src/graph.ts
- current web tests
- current Tailwind/shadcn conventions

Do not assume the current GraphCanvas API.
Adapt to the actual implementation with the smallest coherent change.

STRICT STEP BOUNDARY

Step 36 MAY implement:
- selected-node state in the Explorer
- GraphCanvas node selection callback/wiring
- NodeInspectorPanel
- EvidenceTrail
- selected-node metadata rendering
- selected-node evidence rendering
- inspector empty state
- safe empty/error handling for evidence
- focused frontend tests
- required learning/interview/design documentation

Step 36 MUST NOT implement:
- GraphFilters
- clustering
- level-of-detail
- WebSocket/live updates
- graph.updated subscriptions
- impact analysis
- simulation UI
- AI UI
- new graph traversal
- new graph API endpoints
- repository/analysis-run endpoints
- database access from apps/web
- @fluxora/db dependency/import in apps/web
- new state-management libraries
- Step 37+
- Phase 6+

A. NODE SELECTION

Extend the existing GraphCanvas integration so selecting a node produces a typed selected-node value available to the Explorer.

Requirements:
- clicking a node selects it
- clicking another node replaces the selection
- the selected node can be cleared
- the selected state is owned at the smallest shared boundary needed by GraphCanvas and NodeInspectorPanel
- do not introduce Zustand or another state library
- do not duplicate the graph domain model

Prefer a small API such as a typed callback from GraphCanvas rather than moving state into the rendering layer.

GraphCanvas remains responsible for graph interaction/rendering.
Explorer coordinates selection state.

B. NODE INSPECTOR PANEL

Create:

apps/web/src/components/graph/NodeInspectorPanel.tsx

Responsibilities:
- render the selected node
- render a clear empty state when nothing is selected
- show safe fields from GraphQueryResponseNode
- do not fetch data
- do not access the database
- do not reconstruct graph relationships

Render at minimum:
- node type
- node name
- stable node ID
- canonical ID
- depth
- confidence
- path when available

Render metadata carefully:
- only display metadata that is actually present
- do not invent semantic meanings for arbitrary metadata keys
- keep the output readable for objects/arrays/primitives
- avoid dumping huge/unbounded objects directly into the UI

C. EVIDENCE TRAIL

Create:

apps/web/src/components/graph/EvidenceTrail.tsx

The component should receive evidence data from the selected node's existing GraphQueryResponse.

Evidence association must be explicit:

selected node id
    ↓
evidence.subject_type === "graph_node"
AND
evidence.subject_id === selectedNode.id

Do NOT display evidence belonging to:
- another node
- an edge
- another subject type
- another analysis run

Do not make a second API request.

Render available fields:
- relationship_description
- file_path
- symbol_id when present
- line_start / line_end when present
- column_start / column_end when present
- confidence
- metadata when useful and safe

Use deterministic ordering.
Prefer a stable ordering derived from the existing evidence fields, such as:
1. file_path
2. line_start
3. line_end
4. id

Do not invent timestamps or ranking rules.

Handle:
- no evidence
- one evidence item
- many evidence items
- partial coordinate information
- long relationship descriptions
- long file paths
- metadata that is absent

without crashing or breaking the layout.

D. INSPECTOR / GRAPH LAYOUT

Integrate the inspector into the existing Architecture Explorer without redesigning the page.

Target structure:

┌──────────────────────────────────┬────────────────────────┐
│                                  │                        │
│          GraphCanvas             │ NodeInspectorPanel      │
│                                  │                        │
│                                  │ node metadata           │
│                                  │                        │
│                                  │ EvidenceTrail           │
│                                  │                        │
└──────────────────────────────────┴────────────────────────┘

Requirements:
- graph remains usable when inspector is open
- inspector has a scrollable content region where needed
- evidence does not cause uncontrolled page growth
- selected node remains visibly selected using existing NodeRenderer capabilities where possible
- do not implement final Step 40 visual polish

E. DATA FLOW

Preserve this architecture:

POST /api/v1/graph/query
        ↓
GraphQueryResponse
        ↓
Explorer state
        ↓
selected node
        ↓
NodeInspectorPanel
        ↓
EvidenceTrail

The browser does not create graph truth.

Do not add:
- extra graph fetching
- client-side graph reconstruction
- direct DB reads
- new backend endpoints

F. SECURITY / TENANT BOUNDARY

Preserve the existing model:
- API authenticates the user
- API derives organization/tenant identity
- browser does not send organization_id
- apps/web does not import @fluxora/db
- apps/web does not connect to PostgreSQL
- GraphQueryResponse is the backend source of truth
- evidence is filtered by subject_id in the already-returned response
- no sensitive server secrets are exposed

Do not modify Steps 30–35 backend behavior.

G. TESTING

Use the existing web test setup.

Add focused tests covering at minimum:

1. selecting a node updates Explorer selection state
2. selecting a node renders NodeInspectorPanel
3. clearing selection renders inspector empty state
4. selected node metadata renders correctly
5. selected node ID/canonical ID/depth/confidence/path render correctly
6. EvidenceTrail filters evidence to the selected node
7. evidence for edges or other node IDs is not displayed
8. evidence ordering is deterministic
9. empty evidence state renders correctly
10. partial coordinates render safely
11. changing node selection updates the inspector evidence
12. existing Step 34 graph tests continue to pass
13. existing Step 35 Explorer tests continue to pass
14. no network request is performed by NodeInspectorPanel
15. no network request is performed by EvidenceTrail

Do not weaken existing assertions.
Do not use `any` to bypass TypeScript errors.

H. DOCUMENTATION

Follow the exact documentation pattern used in previous Fluxora steps.

Create:

learning/implementations/phase-05/step-36-node-inspector-panel-and-evidence-trail.md

learning/notes/36. Node Inspector Panel and Evidence Trail.md

learning/interviews/36. Step 36 Node Inspector Panel and Evidence Trail Interview CheatSheet.md

Update:

docs/DESIGN.md

Do not delete historical content.

Explain in plain English:
- what Step 36 adds
- why node selection exists
- GraphCanvas → Explorer selection flow
- NodeInspectorPanel responsibility
- EvidenceTrail responsibility
- exact evidence association rule
- how selected-node evidence is filtered
- deterministic evidence ordering
- empty states
- database/API boundary
- security considerations
- performance/large-evidence limitations
- test strategy
- senior-level interview questions/answers
- exactly what Step 36 does NOT implement
- how Step 37 will extend this foundation

I. VERIFICATION

Run:

1. focused Step 36 web tests
2. pnpm --filter @fluxora/web test
3. pnpm --filter @fluxora/web typecheck
4. pnpm typecheck
5. pnpm lint
6. pnpm lint:evidence
7. pnpm build
8. git diff --check

Do not claim success unless the command actually passes.

J. FINAL REPORT

Report:
1. exact files created
2. exact files modified
3. dependency changes, if any
4. exact tests and results
5. typecheck result
6. lint result
7. evidence-lint result
8. build result
9. selected-node data flow
10. evidence filtering/ordering logic
11. architectural decisions
12. assumptions/limitations

Explicitly confirm:
- NodeInspectorPanel implemented
- EvidenceTrail implemented
- no @fluxora/db import added to apps/web
- no new backend endpoint added
- no new state-management dependency added
- GraphFilters NOT implemented
- clustering/LOD NOT implemented
- WebSocket/live updates NOT implemented
- impact/simulation/AI UI NOT implemented
- no Phase 6+ functionality implemented
- no commit
- no push