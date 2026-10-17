Implement ONLY Fluxora Global Step 43: Impact Analysis Engine.

IMPORTANT:
- Step 42 is already complete and pushed.
- Implement ONLY Step 43 from docs/architecture/17-implementation-roadmap.md.
- Do NOT implement Steps 44, 45, 46, or 47.
- Do NOT create the ImpactAnalysis database table yet.
- Do NOT persist ImpactAnalysis results yet.
- Do NOT add REST endpoints.
- Do NOT modify the frontend/change-mode UI.
- Do NOT add AI/LLM reasoning.
- Do NOT add golden-fixture PR validation yet.
- Do NOT add unrelated refactors or dependencies.

FIRST:
1. Inspect the current repository implementation and git history.
2. Read and follow the existing architecture/design conventions, especially:
   - docs/architecture/17-implementation-roadmap.md
   - docs/architecture/05-component-responsibilities.md §5.9
   - existing graph repository/traversal implementation from Steps 27–33
   - PullRequest + PullRequestFile implementation from Step 42
   - existing shared graph types and Evidence model
3. Reuse existing graph traversal/data-access primitives where appropriate. Do not duplicate the recursive graph traversal logic already implemented in Step 30 unless the existing API genuinely cannot support this engine.
4. Determine the correct package/module placement from the existing architecture before creating files.

STEP 43 RESPONSIBILITY:
Build a deterministic Impact Analysis Engine that takes a stored pull request's changed files/diffs plus the repository's current graph snapshot and computes the PR blast radius.

Required logical pipeline:

PullRequest
  ↓
PullRequestFile changed paths
  ↓
resolve changed files to graph nodes/symbols
  ↓
changed symbols become traversal seeds
  ↓
bounded downstream graph traversal
  ↓
classify affected results
  ├─ direct impacts
  ├─ downstream impacts
  ├─ affected APIs
  ├─ affected events
  └─ affected services/workflow-impact where supported by the existing graph taxonomy
  ↓
deterministic in-memory Impact Analysis result

REQUIREMENTS:

1. Changed-file → changed-symbol resolution
- Use the actual graph node metadata/taxonomy already present in Fluxora.
- Resolve a PullRequestFile path to the relevant module/symbol graph nodes using existing canonical file/path information.
- Prefer exact/canonical matches already produced by the ingestion pipeline.
- Do not invent a new symbol identity scheme.
- Handle files that have no resolvable graph symbol explicitly rather than silently fabricating one.
- Preserve enough information to report unresolved changed files in the result.

2. Graph traversal
- Traverse downstream from changed symbols using the existing graph representation.
- Use the existing bounded traversal implementation from Step 30 where possible.
- Step 43 default maximum depth MUST be 5 hops, as required by the architecture.
- The implementation may allow a caller-provided depth, but it must never exceed the system hard maximum.
- Track visited nodes/cycles so traversal always terminates.
- Avoid duplicate impact results when multiple changed symbols reach the same node.
- Make traversal deterministic: stable ordering and stable deduplication independent of database row order.

3. Classification
Classify discovered nodes according to the existing GraphNode taxonomy:
- direct impact
- downstream impact
- affected APIs
- affected events
- affected services / workflow impact when the existing taxonomy supports those categories

Do not invent new node types just to satisfy this requirement.

The engine should distinguish:
- changed nodes/seeds
- directly affected nodes
- farther downstream nodes

Use traversal depth as the source of that distinction.

4. Confidence
- Implement traversal-depth-based confidence decay.
- Follow the existing Fluxora confidence conventions if one already exists.
- Do NOT invent arbitrary domain semantics unrelated to the architecture.
- The result must expose depth and confidence for each affected finding.
- Deeper traversal must never increase confidence over a shallower equivalent path.
- Use deterministic confidence calculation.
- Record whether traversal was truncated because the depth ceiling was reached.

5. Truncation
- If the traversal reaches the hard depth limit, explicitly report truncation.
- The result must include enough information to communicate that additional nodes may exist beyond the configured depth.
- Never silently omit this condition.
- Do not perform unbounded traversal.

6. Evidence boundary
Step 43 consumes graph/evidence data and should produce an evidence-ready deterministic result, but Step 44 owns ImpactAnalysis persistence and evidence linking.

Therefore:
- Do NOT create ImpactAnalysis persistence.
- Do NOT insert impact evidence rows.
- Do NOT call a new ImpactAnalysis EvidenceWriter persistence path.
- Reuse existing evidence metadata only when needed to preserve provenance in the in-memory result.
- Do not turn Step 43 into Step 44.

7. Tenant/run isolation
- Every database-backed lookup must remain tenant-scoped using existing Fluxora RLS/withTenant conventions.
- The engine must operate against the correct repository/analysis run.
- Never trust client-supplied organization IDs.
- Never mix graph nodes across organizations or analysis runs.
- Reuse the existing repository-level authorization/scoping patterns rather than adding a parallel security layer.

8. Determinism
For identical:
- organization
- repository
- pull request changed-file snapshot
- analysis run
- traversal configuration

the engine must return the same logical result and stable ordering.

Sort/deduplicate outputs deterministically.
Do not rely on PostgreSQL incidental row order.

9. Error handling
Explicitly distinguish cases such as:
- pull request not found / inaccessible
- repository or analysis snapshot unavailable
- changed file cannot be resolved to graph nodes
- malformed/missing required identifiers
- empty changed-file set
- traversal truncation

Use existing Fluxora error conventions where applicable.

10. Testing
Add focused Step 43 tests covering at minimum:
- single changed symbol with direct downstream impact
- multi-hop downstream propagation
- multiple changed files
- multiple changed symbols resolving to the same downstream node
- cycles terminate correctly
- maximum depth is enforced
- truncation is explicitly reported
- API classification
- event classification
- service/workflow classification if supported by current taxonomy
- deterministic ordering
- deterministic confidence decay
- unresolved changed file handling
- empty changed-file input
- tenant isolation
- analysis-run isolation

Use Vitest conventions already adopted by the workspace.
Do not weaken existing tests or replace existing test infrastructure.

11. Documentation
Follow the exact documentation pattern used in Steps 1–42.

Create/update:
- learning/implementations/phase-06/step-43-impact-analysis-engine.md
- learning/notes/43. Impact Analysis Engine.md
- learning/interviews/43. Step 43 Impact Analysis Engine Interview CheatSheet.md
- docs/DESIGN.md

Documentation must explain:
- what Step 43 does
- changed file → symbol resolution
- traversal algorithm
- depth semantics
- cycle prevention
- classification
- confidence decay
- truncation
- tenant/RLS safety
- determinism
- why persistence/API/UI are intentionally excluded
- limitations and false-negative risks
- interview questions and answers

Preserve all previous DESIGN sections. Append/update Step 43 only.

12. Verification
Run the narrowest useful tests first, then:
- relevant package tests
- pnpm test
- pnpm typecheck
- pnpm lint
- pnpm lint:evidence
- pnpm build
- git diff --check

Fix only issues caused by Step 43.
Do not make unrelated cleanup changes.

13. FINAL SCOPE CHECK
Before finishing, verify that:
- Step 43 is implemented.
- Step 44 is NOT implemented.
- Step 45 is NOT implemented.
- Step 46 is NOT implemented.
- Step 47 is NOT implemented.
- no ImpactAnalysis persistence table/model was added
- no impact-analysis REST endpoint was added
- no frontend change-mode overlay was added
- no AI reasoning was added
- no golden-fixture PR validation was added

FINAL REPORT:
Provide:
1. files created/modified
2. exact engine flow
3. traversal/depth/confidence behavior
4. classification behavior
5. tests added and results
6. verification results
7. explicit confirmation that Steps 44–47 were not implemented
8. whether any git commit/push was performed (do NOT commit or push)