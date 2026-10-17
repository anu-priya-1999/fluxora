# Step 43 — Impact Analysis Engine

## Objective & Role in Roadmap

Global Step 43 implements the **deterministic Impact Analysis Engine** for Fluxora. Taking a stored pull request's changed files, unified diffs, and the repository's current graph snapshot, the engine computes the pull request's blast radius across downstream architectural dependencies.

This fulfills **Global Step 43** of **Phase 6: PR Impact Analysis** as defined by `docs/architecture/17-implementation-roadmap.md` and `docs/architecture/05-component-responsibilities.md §5.9`.

---

## Exact Scope & Boundaries

### Modified Files:
- `packages/shared-types/src/index.ts`: Exported impact analysis types, interfaces, and constants.
- `packages/db/src/index.ts`: Exported `impact-analysis-engine.ts` functions (`analyzePullRequestImpact`, `computeImpactAnalysis`, `resolveFilesToSeeds`, `parsePatchModifiedLines`), error classes, and input/output types.

### Created Files:
- `packages/shared-types/src/impact.ts`: Domain models for impact analysis (`ImpactFinding`, `UnresolvedChangedFile`, `WorkflowImpactSummary`, `ImpactAnalysisExecutionMetrics`, `ImpactAnalysisResult`, `AnalyzePullRequestImpactOptions`, `ComputeImpactAnalysisInput`, and constants `DEFAULT_IMPACT_MAX_DEPTH = 5`, `HARD_MAX_IMPACT_DEPTH = 20`, `DEFAULT_CONFIDENCE_DECAY_PER_HOP = 0.9`).
- `packages/db/src/repositories/impact-analysis-engine.ts`: Core engine implementation encompassing diff hunk parsing, symbol resolution, BFS graph traversal with cycle prevention, classification, confidence decay, truncation detection, and multi-tenant PostgreSQL integration.
- `packages/db/src/repositories/impact-analysis-engine.test.ts`: 23 test suites covering all required scenarios: direct impact, multi-hop propagation, multi-seed deduplication, cycle termination, depth limit enforcement, truncation reporting, classification (APIs, events, services), deterministic sorting, confidence decay, unresolved files, validation errors, and PostgreSQL RLS integration.

### Strict Scope Boundary Against Steps 44–47:
- Step 43 does **NOT**:
  - Create the `impact_analyses` database table or execute database migrations (Step 44 owns this);
  - Persist `ImpactAnalysis` records or insert evidence rows into `evidence` (Step 44 owns this);
  - Expose impact analysis HTTP REST endpoints in `apps/api` (Step 45 owns this);
  - Modify the frontend or create the GraphCanvas change-mode overlay (Step 46 owns this);
  - Add AI/LLM narrative explanations or probabilistic edge inference (Step 48+);
  - Run golden-fixture PR impact validation (Step 47 owns this).

---

## Engine Architecture & Logical Pipeline

```
PullRequest + PullRequestFiles (from Step 42)
                    │
                    ▼
       1. Changed Files & Diffs
                    │
                    ▼
       2. Diff Hunk Line Parser (`parsePatchModifiedLines`)
          └─ Extract modified line numbers (oldLines / newLines)
                    │
                    ▼
       3. Changed-File → Changed-Symbol Resolution (`resolveFilesToSeeds`)
          ├─ Match line ranges against AST Symbol nodes (`lineStart` .. `lineEnd`)
          ├─ Fallback to file/module symbol matching if patch is missing/unaligned
          └─ Record unresolvable files as `UnresolvedChangedFile`
                    │
                    ▼
       4. Seed Initialization
          └─ Changed symbols become traversal seeds (depth = 0, initialConfidence = 1.0)
                    │
                    ▼
       5. Bounded Downstream Graph Traversal (`computeImpactAnalysis`)
          ├─ Reuses Step 30 `traverseGraph` or pure in-memory BFS
          ├─ Bounded depth: default 5 hops, hard maximum 20 hops
          ├─ Cycle tracking: Set<nodeId> prevents infinite loops
          └─ Multi-seed deduplication: keeps shallowest path (highest confidence)
                    │
                    ▼
       6. Taxonomy Classification & Categorization
          ├─ Direct Impacts (`depth === 1`)
          ├─ Downstream Impacts (`depth >= 2`)
          ├─ Affected APIs (`node_type === 'api_route'`)
          ├─ Affected Events (`event_producer` | `event_consumer` | `event`)
          ├─ Affected Services (`service`)
          └─ Workflow Impact Summary (aggregate stats, max depth, affected services)
                    │
                    ▼
       7. Confidence Decay & Truncation Calculation
          ├─ Confidence decays geometrically: C = initialConfidence * (0.9 ^ depth)
          └─ Truncation detected if frontier nodes at maxDepth have outgoing edges
                    │
                    ▼
       8. Deterministic Normalization & Sorting
          └─ Sorted deterministically: depth ASC, confidence DESC, nodeId ASC
```

---

## Technical Implementation Details

### 1. Changed-File to Changed-Symbol Resolution

Pull request files are resolved to AST graph nodes using unified diff information:
1. **Hunk Header Parsing**: `parsePatchModifiedLines` scans unified diff hunks matching standard git diff headers `@@ -<oldStart>,<oldCount> +<newStart>,<newCount> @@`.
2. **Line Range Extraction**: Lines starting with `+` (added/modified lines) or `-` (deleted lines) are recorded.
3. **Symbol Line Matching**: For each symbol node residing in the changed file path, the engine extracts `lineStart` and `lineEnd` from node metadata or attached evidence.
4. **Range Intersect**: If any modified line falls within `[lineStart, lineEnd]`, that symbol is marked as a seed.
5. **Fallback Strategy**: If a file has no hunk patch or if no symbol matches hunk lines (e.g., added file or whole-file refactor), all symbol nodes belonging to that file path are included.
6. **Unresolved Handling**: If a changed file has no corresponding graph symbols in the snapshot (e.g. documentation, configuration, or non-indexed assets), it is cataloged in `unresolvedFiles` with a specific reason (`no_symbols_found` or `deleted_file_no_longer_in_snapshot`).

### 2. Bounded Downstream Graph Traversal

- **Algorithm**: Breadth-First Search (BFS) starting from all resolved seed nodes.
- **Direction**: Traverses `downstream` dependencies (`source_node_id` $\to$ `target_node_id`).
- **Depth Ceiling**: Defaults to 5 hops (`DEFAULT_IMPACT_MAX_DEPTH`), with a hard system maximum of 20 hops (`HARD_MAX_IMPACT_DEPTH`). Any caller-provided depth is clamped to `HARD_MAX_IMPACT_DEPTH`.
- **Cycle Prevention**: A `visited` set records processed node IDs. If a cycle exists ($A \to B \to C \to A$), cyclic edges are skipped, guaranteeing termination.
- **Multi-Seed Deduplication**: When multiple changed symbols or paths reach the same downstream node, the engine retains the **shallowest path** (the shortest hop distance from any seed). Because BFS explores layer-by-layer, the first encounter of a node is guaranteed to have minimal depth and therefore maximum confidence.

### 3. Classification of Affected Findings

Discovered nodes are categorized according to Fluxora's canonical `GraphNodeType` taxonomy:
- **`directImpacts`**: Immediate dependencies at `depth === 1`.
- **`downstreamImpacts`**: Indirect transitive dependencies at `depth >= 2`.
- **`affectedApis`**: Nodes with `node_type === 'api_route'`.
- **`affectedEvents`**: Nodes with `node_type === 'event_producer' | 'event_consumer' | 'event'`.
- **`affectedServices`**: Nodes with `node_type === 'service'`.
- **`workflowImpactSummary`**: Aggregates the total affected nodes, unique services affected, count of affected endpoints and events, and the maximum depth reached.

### 4. Deterministic Confidence Decay

Confidence decays deterministically per hop:
$$\text{confidence} = \text{initialConfidence} \times (\text{decayFactor})^d$$
Where:
- $\text{initialConfidence} = 1.0$ (for seed nodes).
- $\text{decayFactor} = 0.9$ (`DEFAULT_CONFIDENCE_DECAY_PER_HOP`).
- $d = \text{traversal depth}$ (hop count from nearest seed).

Deeper nodes strictly receive lower confidence scores than shallower nodes.

### 5. Explicit Truncation Reporting

If the graph has unexplored downstream branches beyond `maxDepth`, the engine marks `truncated: true`:
- At the node level: `ImpactFinding.truncated = true` indicates a frontier node at `depth === maxDepth` that possesses outgoing downstream edges.
- At the result level: `ImpactAnalysisResult.truncated = true` informs downstream consumers and future UI overlays that the blast radius extends beyond the search horizon.

### 6. Multi-Tenant Row-Level Security (RLS) Safety

All database operations run within `withTenant(pool, organizationId, ...)`:
- Sets `SET LOCAL app.current_organization_id = $organizationId`.
- Evaluates against `FORCE ROW LEVEL SECURITY` on `repositories`, `repository_snapshots`, `graph_nodes`, `graph_edges`, and `pull_requests`.
- Enforces cross-check between repository tenant and pull request tenant.
- Guarantees zero cross-tenant contamination.

### 7. Absolute Determinism

Results are strictly deterministic regardless of PostgreSQL query order or iteration order:
- Findings are sorted by `depth ASC`, `confidence DESC`, `nodeId ASC`.
- Seed nodes are sorted by `nodeId ASC`.
- Unresolved files are sorted by `path ASC`.
- Affected APIs, events, and services lists are sorted by `nodeId ASC`.

---

## Limitations & False-Negative Risks

1. **Dynamic Invocations**: Reflection, runtime `eval()`, dynamic service dispatch, and string-interpolated message broker queues cannot be detected statically and will result in false negatives unless annotated via explicit edges.
2. **Whitespace / Comment Hunks**: If a PR diff changes comments or whitespace within an AST symbol's line range, that symbol will be selected as a seed. (Future AST-aware semantic diffing can prune non-semantic changes).
3. **Patch Truncation**: Extremely large diffs flagged as `patch_truncated = true` by Step 42 may lack detailed line ranges, falling back to whole-file symbol matching.
4. **Multi-Repo Boundaries**: External repositories or unindexed microservices without graph edge linkages cannot be traversed.

---

## Verification Summary

All 23 test suites in `packages/db/src/repositories/impact-analysis-engine.test.ts` pass cleanly:
- Single changed symbol with direct downstream impact
- Multi-hop downstream propagation
- Multiple changed files
- Multiple changed symbols resolving to the same downstream node (deduplication)
- Cyclic graph termination
- Depth limit enforcement (default 5 hops, caller-defined hops, hard cap 20 hops)
- Explicit truncation reporting (`truncated: true` and `truncated: false`)
- API classification (`api_route`)
- Event classification (`event_producer`, `event_consumer`, `event`)
- Service and workflow summary classification
- Deterministic output ordering
- Deterministic geometric confidence decay
- Unresolved changed file handling
- Empty PR changed-file set handling
- Patch diff hunk line range parsing
- Input validation error handling
- Multi-tenant RLS isolation in PostgreSQL

