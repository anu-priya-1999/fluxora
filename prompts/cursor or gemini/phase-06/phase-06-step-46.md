Implement ONLY Fluxora Global Step 46: Change-Mode Overlay in the Architecture Explorer.

IMPORTANT:
- Step 43: Impact Analysis Engine — complete.
- Step 44: ImpactAnalysis Persistence + Evidence — complete.
- Step 45: PR Impact Analysis API — complete.
- Step 46 is FRONTEND change-mode visualization only.
- Do NOT implement Step 47 golden-fixture validation.
- Do NOT modify the backend impact-analysis engine, persistence, DB schema, worker logic, webhook handling, or API contracts unless a tiny frontend-facing compatibility fix is absolutely required.
- Do NOT add AI, simulation, telemetry, runtime observations, or Phase 7 work.
- Do NOT commit or push. I will commit separately.
- Preserve existing Fluxora terminology, component organization, testing patterns, visual language, and documentation style.

==================================================
1. READ THESE FIRST
==================================================

Before changing code, inspect:

1. docs/architecture/17-implementation-roadmap.md
   - Phase 6 — PR impact analysis
   - Step 6: change-mode overlay

2. docs/architecture/10-frontend-architecture.md
   - inspect the existing Architecture Explorer design
   - inspect graph rendering, node state, visual hierarchy, overlays,
     filters, selection, and large-graph/LOD behavior
   - use the actual documented conventions rather than inventing a second UI model

3. docs/architecture/07-api-architecture.md
   - PR impact analysis API
   - GET /api/v1/impact-analyses/:id

4. docs/architecture/06-database-schema.md
   - ImpactAnalysis
   - Evidence
   - AnalysisRun

5. docs/architecture/05-component-responsibilities.md
   - §5.9 Impact Analysis Engine
   - §5.15 Architecture Explorer

6. Read the actual existing Step 34–40 frontend implementation:
   - GraphCanvas
   - NodeRenderer
   - graph mapping
   - GraphFilters
   - LOD implementation
   - WebSocket/live update integration
   - Explorer route/page
   - Explorer client/state
   - NodeInspectorPanel
   - ExplorerStatus

7. Read the actual Step 45 API implementation:
   - impact-analysis request/response types
   - GET impact-analysis endpoint
   - response serialization
   - API client conventions
   - auth/token handling
   - error handling

Do not recreate existing utilities or bypass current abstractions.

==================================================
2. STEP 46 GOAL
==================================================

Add a frontend "change mode" to the existing Architecture Explorer.

The user should be able to select/view a pull request and see its persisted impact analysis overlaid on the existing graph.

Conceptually:

Pull Request
    ↓
GET persisted ImpactAnalysis
    ↓
map impact findings to graph node IDs
    ↓
Change Mode state
    ↓
GraphCanvas + NodeRenderer
    ↓
visualize:
  - directly changed nodes
  - downstream impacted nodes
  - affected APIs
  - affected events
  - confidence/depth
  - unresolved/truncated state

This must be a visualization layer over the existing graph, NOT a second graph.

The graph topology must remain the existing graph returned by /graph/query.

==================================================
3. CHANGE-MODE UX
==================================================

Implement a clear way to enter and exit change mode using the current Explorer UI architecture.

Before choosing the exact control:
- inspect the current Explorer page
- inspect existing query-parameter/state conventions
- inspect whether PR identifiers are already represented in the route or page state
- use the smallest change consistent with the current UI

Do not invent a large new PR-management screen.

Change mode should support:

A. OFF
- existing explorer behavior remains unchanged

B. LOADING
- impact analysis is being fetched

C. READY
- impact findings are available and visualized

D. EMPTY / NOT AVAILABLE
- no impact analysis exists yet or no findings are available

E. ERROR
- API fetch failed
- allow retry
- do not destroy the underlying graph

F. STALE / TRUNCATED indication where the persisted result says so
- make this visible to the user rather than hiding uncertainty

The existing ExplorerStatus/loading/error conventions should be reused.

==================================================
4. IMPACT VISUALIZATION
==================================================

Do not redesign NodeRenderer from scratch.

Extend the existing node rendering/state model with change-mode information.

At minimum distinguish:

1. Direct impact / changed nodes
   - strongest visual emphasis

2. Downstream impacted nodes
   - visually distinct from direct changes
   - use hop distance to provide progressively weaker emphasis where appropriate

3. Unaffected nodes
   - may be visually de-emphasized while change mode is active
   - do not make them disappear from the underlying graph unless existing LOD behavior explicitly requires it

4. Affected APIs
   - distinguish API nodes that appear in the impact result

5. Affected events
   - distinguish event nodes that appear in the impact result

6. Selected node
   - existing selection behavior must remain stronger/higher priority than change-mode styling

7. Low-confidence findings
   - do not display them as equally certain as high-confidence findings
   - reuse existing confidence semantics where possible

Do not use arbitrary colors if the existing design system already has semantic tokens for success/warning/error/info/selection.
Follow the current project's styling conventions.

The exact visual treatment should come from the existing frontend architecture/design system where possible.

==================================================
5. CHANGE-MODE DATA MODEL
==================================================

Create a small frontend-only normalized representation for change-mode state.

For example, conceptually:

ChangeModeState
- enabled
- pullRequestId
- impactAnalysisId
- status
- directNodeIds
- downstreamNodeIds
- affectedApiNodeIds
- affectedEventNodeIds
- hopDistanceByNodeId
- confidenceByNodeId
- evidenceIdsByNodeId
- unresolvedFiles
- truncated
- truncationReason

Do not copy the entire backend response into every component.

Normalize once and pass a compact view model into the graph layer.

Keep pure transformation functions separate from React components when practical.

They must be deterministic and easy to unit test.

==================================================
6. API FETCHING
==================================================

Use the existing frontend API-client/authentication abstraction.

Call:

GET /api/v1/impact-analyses/:id

Do NOT:
- call the Step 43 engine directly from the browser
- query PostgreSQL from the browser
- reconstruct impact by traversing the graph client-side
- infer impact based on node names
- recompute changed files or diff ranges
- call GitHub directly from the frontend

The persisted server result is authoritative.

If the Step 45 API returns a queued/running result, the frontend should represent that state using the existing polling/live-update architecture rather than adding a new backend mechanism.

Reuse existing WebSocket/live-update infrastructure where appropriate.

Do not add a second WebSocket implementation.

==================================================
7. MAPPING IMPACT TO THE EXISTING GRAPH
==================================================

Impact findings already contain graph node identity.

Use stable node IDs/canonical IDs already used by GraphCanvas and graph-mapping.

Do not match nodes by:
- display name only
- filename only
- array position
- React key
- fuzzy matching

If an impact finding references a node that is not currently present in the loaded graph slice:

- do not fabricate a graph node
- retain the finding in state
- surface an appropriate partial-data condition where useful
- respect the existing GraphFilters/LOD model

Do not modify server graph-query semantics in Step 46 just to force every impacted node into the graph.

==================================================
8. LOD + FILTER INTERACTION
==================================================

This is important because Steps 37–38 already established filtering and LOD.

Change mode must cooperate with them.

Requirements:

- GraphFilters remain functional.
- LOD remains functional.
- Selecting a node continues to work.
- Change-mode styling must survive zoom transitions.
- Selected nodes remain selected across rerenders.
- Do not implement a second client-side graph traversal.
- Do not invent synthetic clusters merely to display impact.
- Do not disable LOD globally just because change mode is active.

If an impacted node is hidden by current LOD/filter settings, preserve its impact information in state rather than silently deleting it.

The UI may provide an indicator/count that some impacted nodes are currently hidden by filters/LOD if the existing architecture has a suitable pattern for this.

==================================================
9. LEGEND / SUMMARY
==================================================

Add a compact change-mode summary/legend using existing UI primitives.

It should make the meaning of the visual overlay understandable without opening the code.

At minimum communicate:

- direct changes
- downstream impact
- affected APIs/events where relevant
- confidence/depth semantics
- truncated analysis warning when applicable

Also show useful counts where they are already available from the persisted result:

- direct count
- downstream count
- affected APIs
- affected events
- unresolved files
- truncated indicator

Keep this compact. Do not turn Step 46 into a full impact report page.

==================================================
10. NODE INSPECTOR INTEGRATION
==================================================

Integrate change-mode information with the existing NodeInspectorPanel/EvidenceTrail.

When a user selects an impacted node:

- existing node inspection must continue to work
- show whether the node is directly changed or downstream affected
- show hop distance where present
- show confidence where present
- preserve existing evidence IDs/evidence trail behavior
- do not duplicate the full impact result inside the inspector

Do not redesign the NodeInspectorPanel.

Use the existing component/data model and add only the minimum Step 46 information.

==================================================
11. EVIDENCE
==================================================

Evidence remains authoritative from Step 44.

The frontend must not fabricate evidence.

Where a finding has evidence IDs:
- preserve them
- pass them into existing evidence UI flows where appropriate

Where evidence is absent:
- do not invent file/line references
- show the finding without pretending it has stronger provenance than it does

==================================================
12. ROUTE / STATE PERSISTENCE
==================================================

Use the current Explorer routing/state architecture.

A refresh should not unexpectedly destroy the user's selected change mode if the existing route/query-param conventions support persistence.

Prefer URL state when the existing Explorer already uses URL/query state for filters or view configuration.

Do not create a second competing source of truth between:
- URL
- React local state
- server response

Follow the established Explorer pattern.

==================================================
13. ERROR / EMPTY / PARTIAL STATES
==================================================

Handle these separately:

1. No PR/change mode selected
2. Impact analysis not generated yet
3. Impact analysis pending
4. Impact analysis running
5. Impact analysis completed with zero downstream findings
6. Impact analysis completed with findings
7. Impact analysis truncated
8. Some changed files unresolved
9. API request failed
10. Impact result references nodes absent from current graph slice

Do not present "no impact" when the real state is "analysis unavailable."

Do not present "analysis complete" while status is pending/running.

Reuse Step 40 status semantics and wording conventions.

==================================================
14. COMPONENT STRUCTURE
==================================================

Follow the existing frontend organization.

Likely responsibilities should be separated into:

- pure impact/change-mode mapping utility
- change-mode state/data hook or client helper
- change-mode overlay/summary/legend component
- minimal GraphCanvas/NodeRenderer integration

Do not create a monolithic Explorer component.

Keep server-only code out of client bundles.

Do not import @fluxora/db into apps/web.

Do not introduce backend/database dependencies into the web package.

==================================================
15. TESTING
==================================================

Add focused Vitest coverage.

Test pure mapping/state transformation first.

At minimum cover:

A. persisted ImpactAnalysis → normalized change-mode state
B. direct impact classification
C. downstream impact classification
D. hop-distance preservation
E. confidence preservation
F. affected API classification
G. affected event classification
H. evidence ID preservation
I. unresolved files preservation
J. truncated state preservation
K. deterministic ordering
L. duplicate node IDs handled deterministically
M. missing graph nodes do not create fake nodes
N. selected-node priority
O. change mode disabled = existing graph behavior
P. filter interaction
Q. LOD interaction
R. loading state
S. pending/running state
T. completed-empty state
U. API error state
V. retry behavior
W. toggling change mode off restores normal rendering

Add component tests for the important visible states.

Do not weaken existing GraphCanvas, NodeRenderer, GraphFilters, LOD, WebSocket, or inspector tests.

Run existing web tests as part of the verification.

==================================================
16. PERFORMANCE
==================================================

Do not perform O(nodes × findings) work on every render if a normalized Map/Set can be created once.

Prefer:

Set<string> directNodeIds
Set<string> downstreamNodeIds
Map<string, number> hopDistanceByNodeId
Map<string, number> confidenceByNodeId
Map<string, readonly string[]> evidenceIdsByNodeId

Memoize derived view state where appropriate.

Do not introduce unnecessary state updates while panning/zooming.

Change-mode styling must remain cheap enough for the existing LOD/React Flow graph.

==================================================
17. DESIGN / VISUAL CONSISTENCY
==================================================

Use the existing:
- typography
- spacing
- borders
- shadows
- semantic tokens
- component primitives
- badges
- buttons
- status indicators

Do not introduce a new styling framework.

Do not redesign the entire explorer.

Change mode should feel like a mode of the existing Architecture Explorer, not a second application.

==================================================
18. STRICT SCOPE
==================================================

DO NOT implement:

- Step 47 golden-fixture PR validation
- backend impact-analysis changes
- new DB tables
- migrations
- new API endpoints
- new worker jobs
- GitHub webhook changes
- new graph traversal
- graph-query backend changes
- AI explanations
- simulation
- telemetry
- runtime observations
- evidence schema changes
- Phase 7 evidence hardening
- full impact report page
- PR management UI
- commenting/review functionality

Only frontend change-mode overlay and the minimum frontend tests/docs required for it.

==================================================
19. DOCUMENTATION
==================================================

Create:

learning/implementations/phase-06/step-46-change-mode-overlay.md

learning/notes/46. Change Mode Overlay.md

learning/interviews/46. Step 46 Change Mode Overlay Interview CheatSheet.md

Update:

docs/DESIGN.md

Documentation must explain in plain English:

1. What change mode is.
2. Why it is an overlay instead of a second graph.
3. How persisted ImpactAnalysis data reaches the frontend.
4. How direct vs downstream impact is represented.
5. How hop distance and confidence affect display.
6. How affected APIs/events are identified.
7. How evidence IDs are preserved.
8. How unresolved/truncated analysis is shown.
9. How filters and LOD interact with change mode.
10. How selection and NodeInspectorPanel continue to work.
11. Why the browser does not recompute impact.
12. Why the frontend does not access DB/GitHub directly.
13. Performance considerations.
14. Accessibility/clarity considerations.
15. Failure and empty states.
16. Testing strategy.
17. Important limitations.

Interview cheat sheet should cover:

- Why overlay the existing graph?
- Why not recompute impact on the client?
- How do you map persisted findings to nodes?
- How do you represent direct vs downstream impact?
- How does hop distance affect confidence?
- How does change mode interact with filters?
- How does it interact with LOD?
- What happens if an impacted node is not loaded?
- How do you avoid rerendering the whole graph unnecessarily?
- How does evidence remain trustworthy?
- Why is the API result authoritative?
- How would you extend this later for a full impact report?

==================================================
20. DESIGN.md
==================================================

Add a Step 46 section documenting:

PR Impact Analysis
      ↓
GET /api/v1/impact-analyses/:id
      ↓
frontend normalization
      ↓
ChangeModeState
      ↓
GraphCanvas / NodeRenderer overlay
      ↓
selection + inspector + evidence

Also document:
- data ownership
- state ownership
- visual priority
- filters/LOD interaction
- error states
- no client-side traversal
- no backend changes in Step 46

Do not rewrite unrelated DESIGN.md sections.

==================================================
21. VERIFICATION
==================================================

Run:

1. focused Step 46 web tests
2. pnpm --filter @fluxora/web test
3. pnpm test
4. pnpm typecheck
5. pnpm lint
6. pnpm lint:evidence
7. pnpm build
8. git diff --check

Also manually inspect:

- normal explorer without change mode
- enabling change mode
- loading state
- completed impact state
- direct vs downstream visual distinction
- confidence/depth display
- affected API/event display
- inspector integration
- filters
- LOD
- selecting/unselecting nodes
- disabling change mode
- API failure + retry
- truncated analysis
- unresolved files
- graph node missing from current slice

Do not claim browser verification unless it was actually performed.

Do not modify unrelated failures just to make Step 46 pass.

==================================================
22. FINAL REPORT
==================================================

Report:

- exact files created
- exact files modified
- change-mode data model
- API integration
- route/state mechanism
- visual behavior
- direct/downstream/API/event handling
- confidence/hop handling
- evidence handling
- filter/LOD interaction
- NodeInspector integration
- loading/empty/error/truncated behavior
- tests added
- exact verification command results
- any limitation
- confirmation that Step 47 was NOT implemented
- confirmation that no backend/schema/API contract changes were made
- confirmation that no commit/push was performed

Do not commit or push.