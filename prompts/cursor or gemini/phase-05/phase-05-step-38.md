Implement ONLY Global Step 38 of Fluxora:

# Global Step 38 — Graph Clustering / Level-of-Detail

First inspect the existing Step 34–37 implementation and architecture before changing anything, especially:
- apps/web/src/components/graph/
- apps/web/src/app/repositories/[repoId]/explorer/
- packages/shared-types/src/graph.ts
- docs/DESIGN.md
- learning/implementations/phase-05/
- learning/notes/
- learning/interviews/

## Goal

Add deterministic client-side graph clustering / level-of-detail behavior to the existing Architecture Explorer.

This is a PRESENTATION-layer feature only.

Do NOT modify:
- Step 30 recursive traversal
- Step 31 graph query API
- Step 32 graph.updated events
- Step 33 golden graph verification
- Step 34 GraphCanvas/node renderer architecture
- Step 35 explorer route/query flow
- Step 36 NodeInspectorPanel/EvidenceTrail behavior
- Step 37 GraphFilters behavior

Do NOT implement Step 39 WebSocket live updates.
Do NOT implement Step 40 loading/empty/error polish.
Do NOT add a new backend endpoint.
Do NOT import @fluxora/db or PostgreSQL code into apps/web.
Do NOT add a dependency unless absolutely necessary; prefer the existing React Flow APIs and current project dependencies.

## Required behavior

Implement a deterministic level-of-detail strategy tied to React Flow viewport zoom.

At lower zoom levels:
- reduce visual density;
- prioritize higher-level architectural nodes;
- avoid rendering every symbol-level detail when it becomes unreadable.

At higher zoom levels:
- progressively reveal more detailed nodes and edges;
- preserve the existing node renderer and node type styling;
- preserve graph semantics.

Where the existing graph data contains a reliable, stable parent/grouping relationship, use it for clustering.
Do NOT invent hierarchy from arbitrary string slicing or fragile heuristics.

If the current data model does not expose a reliable parent relationship, use deterministic node-type/depth-based LOD instead of fabricating clusters.

## Architectural requirements

- Keep the backend authoritative for traversal.
- Do NOT perform BFS/DFS or graph traversal in the browser.
- Treat the GraphQueryResponse as the source of truth.
- LOD/clustering must only change presentation.
- Filtering from Step 37 remains authoritative and must continue to work.
- Node selection from Step 36 must remain correct.
- EvidenceTrail must still use the real selected graph node, never a synthetic cluster node.
- Existing node IDs must remain stable.
- Never create nondeterministic IDs.
- Cluster identifiers, when required, must be derived deterministically from stable graph data.
- Avoid mutating the original API response.
- Preserve deterministic ordering.
- Preserve existing GraphCanvas public behavior unless a minimal extension is necessary.

## UX expectations

The graph should naturally move through detail levels as the user zooms:
- zoomed out → architectural overview / lower visual density
- medium zoom → module-level structure
- zoomed in → detailed symbol-level graph

Use sensible hysteresis/debouncing only when needed to prevent excessive rerenders.

Do not make the graph jump unpredictably when zooming.

When LOD hides nodes:
- do not break React Flow rendering;
- do not leave edges pointing to nonexistent rendered nodes;
- handle visibility consistently and deterministically.

When clustering is used:
- clearly distinguish aggregate/cluster visuals from real graph nodes;
- do not allow a synthetic cluster to masquerade as a real GraphNode;
- clicking a real node must continue to select the real node;
- do not route EvidenceTrail through a cluster object.

## Implementation shape

Prefer small pure helper functions for:
- determining the current LOD level from zoom;
- determining node visibility;
- determining edge visibility;
- computing stable cluster/group keys if actual clustering is supported;
- producing the rendered node/edge set.

Keep this logic testable outside the React component where practical.

Integrate it cleanly with the existing:
- GraphCanvas
- graph-mapping
- explorer-client
- node renderer
architecture.

Do not rewrite existing components unnecessarily.

## Tests

Add focused tests covering at minimum:
- deterministic LOD selection for representative zoom values;
- low zoom reduces detail;
- higher zoom reveals additional detail;
- stable results for identical input;
- filtered graph remains filtered after LOD;
- selected real node is not incorrectly converted into a synthetic cluster;
- no rendered edge references a hidden/non-rendered endpoint;
- cluster/group IDs are deterministic if clustering is used.

Preserve all existing Step 34–37 tests.

## Learning/documentation requirements

Create:

1. learning/implementations/phase-05/step-38-graph-clustering-and-level-of-detail.md

Include:
- objective
- scope
- architecture
- plain-English explanation
- why LOD/clustering is needed
- zoom → rendering flow
- data flow
- deterministic behavior
- node/edge visibility rules
- clustering rules if implemented
- interaction with Step 37 filters
- interaction with Step 36 selection/evidence
- performance considerations
- security/invariants
- limitations
- verification
- explicit confirmation that no Step 39/40 work was included

2. learning/notes/38. Graph Clustering and Level-of-Detail.md

Explain the concepts in plain English as personal learning notes.

3. learning/interviews/38. Step 38 Graph Clustering and Level-of-Detail Interview CheatSheet.md

Include:
- likely interview questions
- concise answers
- architecture explanation
- why client-side LOD is appropriate here
- complexity/performance discussion
- React Flow considerations
- deterministic rendering
- tradeoffs and limitations

4. Update docs/DESIGN.md

Add the Step 38 architecture/design section without deleting or rewriting previous Step 1–37 sections.

Use the same terminology, structure, and detail level already established in the Fluxora documentation.

## Verification

Before finishing, run and report:

- web tests
- web typecheck
- workspace typecheck
- lint
- evidence lint
- build
- git diff --check

Fix only issues introduced by Step 38.

## Final scope guard

The final diff must contain ONLY Step 38 changes plus the required learning/documentation updates.

No:
- Step 39 WebSocket work
- Step 40 UI polish
- backend graph-query changes
- database changes
- new API endpoints
- unrelated refactors
- unnecessary dependencies
- generated files
- secrets
- commits or pushes unless explicitly requested

At the end, summarize:
1. files created/modified
2. exact LOD/clustering behavior implemented
3. tests and verification results
4. confirmation that Steps 39–40 were not implemented