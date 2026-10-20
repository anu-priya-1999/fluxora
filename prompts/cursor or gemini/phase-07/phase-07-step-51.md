You are implementing Fluxora Phase 7, Step 51 only.

STEP 51: ANALYSIS-COVERAGE VIEW

Goal:
Provide a clear frontend view showing how much of the analyzed graph/impact surface has evidence coverage, where evidence is missing, and what analysis scope the coverage represents.

This is the final step of Phase 7.

Phase 7 progression:
- Step 48 = evidence completeness guarantees
- Step 49 = clickable evidence citations/provenance
- Step 50 = confidence-based visual weighting
- Step 51 = analysis/evidence coverage view

IMPORTANT:
- Inspect the actual current repository before changing anything.
- Start from the current Step 50 implementation.
- Reuse existing evidence, graph, impact, analysis-run, and frontend contracts.
- Do NOT redesign the application.
- Do NOT change evidence-writing behavior.
- Do NOT change confidence calculations.
- Do NOT change graph traversal.
- Do NOT change impact-analysis semantics.
- Do NOT implement simulation.
- Do NOT implement runtime telemetry.
- Do NOT implement AI reasoning.
- Do NOT invent coverage values.

==================================================
1. FIRST: READ THE EXISTING ARCHITECTURE
==================================================

Inspect:

- docs/architecture/17-implementation-roadmap.md
- docs/architecture/01-product-thesis.md
- docs/architecture/03-core-invariants.md
- docs/architecture/05-component-responsibilities.md
- docs/architecture/06-database-schema.md
- docs/architecture/08-frontend-application.md
- docs/architecture/10-frontend-architecture.md
- docs/architecture/12-testing-strategy.md
- docs/DESIGN.md

Then inspect the current implementation:

- apps/web/src/components/graph/GraphCanvas.tsx
- apps/web/src/components/graph/NodeRenderer.tsx
- apps/web/src/components/graph/graph-mapping.ts
- apps/web/src/components/graph/node-inspector-data.ts
- apps/web/src/components/graph/EvidenceCitation.tsx
- apps/web/src/components/graph/evidence-citation-data.ts
- apps/web/src/components/graph/confidence-data.ts
- apps/web/src/components/graph/ChangeModeBar.tsx
- apps/web/src/components/graph/change-mode-data.ts
- apps/web/src/app/repositories/[repoId]/explorer/explorer-client.tsx
- relevant graph/impact/evidence shared types
- existing analysis-run APIs
- existing graph query APIs
- existing impact analysis APIs
- existing tests

Determine:
1. what existing data can support coverage,
2. what the frontend already receives,
3. whether an existing backend coverage/analysis summary contract exists,
4. whether a new read-only endpoint is actually necessary.

Do not assume that a coverage API is missing until the repository has been inspected.

==================================================
2. PRODUCT QUESTION
==================================================

The coverage view should answer:

"How much of the analyzed surface has verified evidence, and where are the gaps?"

The UI should distinguish:

- analyzed
- evidence-backed
- missing evidence
- unsupported/unavailable where appropriate

Coverage must always be scoped to a clearly identified analysis snapshot/run.

Do NOT present a repository-wide percentage unless the underlying data truly represents repository-wide coverage.

==================================================
3. DEFINE COVERAGE PRECISELY
==================================================

Use an explicit deterministic definition.

The preferred conceptual model is:

Evidence Coverage
=
evidence-backed analyzed conclusions
/
analyzed conclusions in the selected scope

But before implementing:
- inspect the existing architecture for the intended unit of coverage,
- use the existing graph/evidence model,
- document the exact numerator and denominator.

Possible covered subjects include:
- graph edges
- graph nodes with provenance obligations
- impact findings

Do not automatically combine unrelated denominators.

A graph-edge coverage metric and an impact-finding coverage metric should remain distinguishable.

If the existing architecture specifies a single coverage unit, follow it exactly.

Do not silently create a novel metric.

==================================================
4. ANALYSIS-RUN SCOPING
==================================================

Coverage must be tied to a specific analysis run/snapshot.

Display enough context to make the scope clear, such as:
- analysis run identifier or human-readable run metadata already available,
- repository context,
- snapshot/commit context when already available,
- analysis status where already exposed.

Do not invent:
- latest commit
- branch name
- run status
- snapshot identifiers

Use existing authoritative fields.

Coverage must never combine evidence from unrelated analysis runs.

==================================================
5. DATA SOURCE
==================================================

Prefer existing read-only data already exposed by the API.

Architecture:

authoritative persisted evidence
          +
authoritative analyzed subject set
          ↓
coverage calculation
          ↓
Coverage View

The frontend must NOT:
- inspect the database,
- call @fluxora/db,
- query PostgreSQL directly,
- reconstruct evidence from raw repository files,
- recompute graph analysis.

If the existing API already exposes all required data:
- derive the coverage presentation from that contract.

If a missing read-only coverage summary is genuinely required:
- implement the smallest backend/API read path needed,
- use existing authentication,
- derive organization from authenticated context,
- enforce tenant isolation,
- scope by analysis run,
- do not mutate data,
- do not create a second evidence model.

==================================================
6. COVERAGE SUMMARY
==================================================

Create a reusable presentation model only if one does not already exist.

Suggested conceptual structure:

AnalysisCoverage
- analysisRunId
- scope
- total
- covered
- uncovered
- percentage
- categories

Where categories may include existing supported subject classes such as:
- graph edges
- impact findings
- API findings
- event findings
- service findings

Do NOT invent categories that have no underlying data.

Coverage percentage must be calculated from authoritative counts.

Do not hard-code values.

Use deterministic integer/percentage formatting.

==================================================
7. UI / LOCATION
==================================================

Integrate the coverage view into the existing Explorer experience.

Do NOT create an unrelated application/page.

Prefer a compact panel/card/section consistent with the existing Explorer.

Conceptual layout:

Analysis Coverage
────────────────────────
Scope: analysis snapshot ...
Covered:       842
Missing:        31
Coverage:      96.5%

[existing category breakdown]

[view/filter uncovered items]

The exact UI should match the current Fluxora design system.

Do not overwhelm the graph.

==================================================
8. COVERAGE VISUALIZATION
==================================================

Provide a clear visual representation.

A simple progress indicator, segmented bar, or equivalent is acceptable.

Requirements:
- exact numeric percentage shown,
- covered vs uncovered distinguishable,
- color is not the only signal,
- accessible text accompanies the visualization.

Do NOT implement a heatmap unless the architecture explicitly requires it.

Do NOT introduce unnecessary charts.

==================================================
9. UNCOVERED ITEMS
==================================================

The most useful part of Step 51 is making gaps actionable.

When the underlying data permits it, allow the user to inspect/filter uncovered subjects.

For example:

Coverage
  ↓
Uncovered: 31
  ↓
list of missing-evidence items
  ↓
select item
  ↓
existing graph/inspector view

Do not fabricate missing evidence.

An item belongs in "uncovered" only when the authoritative data establishes:
- it is inside the analyzed scope,
- and no qualifying evidence exists for it.

Do not mark an item uncovered merely because an API response omitted optional data unless that omission semantically means "no evidence."

==================================================
10. GRAPH INTEGRATION
==================================================

When uncovered graph relationships can be identified safely:

- allow navigation/highlighting to the corresponding existing graph entity,
- preserve existing selection behavior,
- reuse existing GraphCanvas and NodeInspectorPanel.

Do not change graph topology.

Do not hide covered/uncovered graph edges automatically.

Do not change confidence styling from Step 50.

Coverage is an analytical overlay/view, not a replacement for graph rendering.

==================================================
11. IMPACT INTEGRATION
==================================================

When impact-analysis evidence coverage can be determined safely:

Show a breakdown for the existing impact categories.

For example:

Direct impact       12 / 12 covered
Downstream impact   21 / 24 covered
Affected APIs        4 /  5 covered
Affected events      3 /  3 covered
Affected services    2 /  2 covered

ONLY render categories for which the backend provides authoritative data.

Do not compute coverage from confidence.

Do not consider high confidence equivalent to evidence coverage.

==================================================
12. CRITICAL DISTINCTION
==================================================

Do NOT confuse:

confidence
with
coverage

Confidence asks:
"How strong is this conclusion?"

Coverage asks:
"Does the analyzed conclusion have evidence?"

Therefore:

High confidence + evidence
    = covered, high-confidence conclusion

Low confidence + evidence
    = covered, low-confidence conclusion

No evidence
    = uncovered

Never substitute confidence for evidence.

==================================================
13. FILTERING / INTERACTION
==================================================

A useful Step 51 interaction may include:

- All
- Covered
- Uncovered

Or an equivalent existing filter pattern.

If category filters already exist:
- extend them carefully.

Do not implement a second unrelated filter framework.

Filtering must be deterministic.

Selecting an uncovered item should reuse existing graph/inspector selection pathways.

==================================================
14. ACCESSIBILITY
==================================================

Coverage must be understandable without relying on color.

For every visual coverage indicator provide:
- numeric percentage,
- covered count,
- total count,
- accessible label.

Example:

"Evidence coverage: 96.5 percent, 842 of 873 analyzed conclusions have evidence."

For uncovered lists:
- semantic buttons/links,
- keyboard accessibility,
- visible focus state,
- useful screen-reader labels.

Do not make hover the only way to understand coverage.

==================================================
15. EMPTY / LOADING / ERROR STATES
==================================================

Handle:

1. no analysis selected
2. analysis not ready
3. coverage loading
4. coverage available
5. coverage unavailable
6. zero analyzed subjects
7. 100% coverage
8. 0% coverage
9. partial coverage
10. stale analysis

Do not report "0% coverage" when coverage data simply failed to load.

Distinguish:

No data
from
zero coverage.

==================================================
16. DETERMINISM
==================================================

Coverage calculations must be deterministic.

Do not use:
- randomness
- timestamps for ordering
- unstable object iteration
- client-side graph traversal
- confidence as an implicit coverage proxy

When listing uncovered items:
use stable ordering such as existing file path + line + subject ID/canonical ID conventions.

Reuse existing deterministic ordering helpers where possible.

==================================================
17. SECURITY / TENANT ISOLATION
==================================================

Coverage is tenant-sensitive analysis data.

Requirements:
- authenticated organization scoping,
- analysis-run scoping,
- no cross-tenant aggregation,
- no client-controlled organization authority,
- no direct DB access from web,
- no exposure of unrelated evidence.

If a new backend read path is added:
- follow existing auth middleware,
- follow existing API error conventions,
- follow existing tenant isolation/RLS conventions,
- read-only only.

==================================================
18. PERFORMANCE
==================================================

Do not fetch every evidence record individually.

Avoid N+1 requests.

Prefer:
- one existing graph/analysis response,
- or one small coverage-summary response,
- plus existing detail APIs only when the user intentionally opens an item.

Do not load entire repository evidence datasets if bounded/summarized data is sufficient.

Keep the Explorer responsive.

==================================================
19. TESTING
==================================================

Add focused tests for Step 51.

A. Coverage calculation
- correct numerator
- correct denominator
- correct percentage
- 0%
- 100%
- partial coverage
- zero analyzed subjects
- deterministic result

B. Scope isolation
- different analysis runs do not mix
- coverage is scoped correctly
- tenant isolation is preserved

C. Category coverage
- graph edge coverage where supported
- impact finding coverage where supported
- direct/downstream/API/event/service coverage only when authoritative

D. Missing evidence
- uncovered items are identified only when supported by authoritative data
- no false uncovered results from optional/missing response fields

E. UI
- summary renders
- numeric percentage renders
- covered/uncovered counts render
- empty state
- loading state
- error state
- zero coverage
- full coverage

F. Interaction
- covered/uncovered filter
- uncovered item selection
- navigation/highlight where supported

G. Accessibility
- coverage understandable without color
- semantic controls
- keyboard interaction
- aria labels

H. Regression
- Step 48 evidence tests
- Step 49 evidence-citation tests
- Step 50 confidence tests
- graph explorer tests
- change-mode tests

Do not weaken existing tests.

==================================================
20. DOCUMENTATION / LEARNING ARTIFACTS
==================================================

Create:

learning/implementations/phase-07/step-51-analysis-coverage-view.md

learning/notes/51. Analysis Coverage View.md

learning/interviews/51. Step 51 Analysis Coverage View Interview CheatSheet.md

Update:

docs/DESIGN.md

Use the same Fluxora learning pattern and level of detail as Steps 48–50.

Documentation must explain:

- Step 51 objective
- exact definition of coverage
- numerator/denominator
- analysis-run scoping
- data flow
- backend/API dependency if any
- graph coverage
- impact coverage
- uncovered-item semantics
- UI architecture
- filtering/navigation
- empty/loading/error states
- accessibility
- security
- performance
- deterministic ordering
- confidence vs coverage distinction
- limitations
- Phase 7 completion
- what belongs to later phases

Do not document speculative functionality as implemented.

==================================================
21. DESIGN.MD
==================================================

Update docs/DESIGN.md with the actual implemented Step 51 architecture.

Include:
- coverage definition
- authoritative data source
- analysis-run scoping
- frontend presentation model
- UI integration
- uncovered-item interaction
- security/invariants
- accessibility
- limitations

Do not rewrite unrelated architecture.

==================================================
22. STRICT SCOPE BOUNDARY
==================================================

DO NOT IMPLEMENT:

- new evidence generation
- changes to EvidenceWriter
- confidence calculation changes
- graph traversal changes
- impact-analysis algorithm changes
- simulation
- runtime telemetry
- AI reasoning
- new graph semantics
- unrelated dashboard redesign
- predictive coverage
- heuristic "probably covered" scoring
- repository-wide metrics unsupported by the underlying data

Step 51 is a READ-ONLY coverage presentation layer over authoritative analysis/evidence data.

==================================================
23. PHASE 7 COMPLETION CHECK
==================================================

At the end, verify that Phase 7 now has:

Step 48:
Evidence completeness
    ↓
Step 49:
Clickable evidence citations
    ↓
Step 50:
Confidence visual weighting
    ↓
Step 51:
Coverage visibility

The final Step 51 implementation should make the provenance system understandable at a glance without changing the underlying analysis.

==================================================
24. VERIFICATION
==================================================

Run focused tests first.

Then run:

pnpm --filter @fluxora/web typecheck
pnpm --filter @fluxora/web test

Then:

pnpm typecheck
pnpm lint
pnpm lint:evidence
pnpm build
pnpm test
git diff --check

Review the final diff for:
- Step 51 scope only
- no confidence algorithm changes
- no evidence-writing changes
- no graph/impact algorithm changes
- no Step 52+ functionality
- no generated artifacts
- no secrets
- no node_modules

If a check fails:
- report the exact failure,
- fix only the Step 51 issue,
- rerun the failed check,
- do not claim success without actual output.

==================================================
25. FINAL REPORT
==================================================

Report:

1. Step 51 status
2. exact coverage definition
3. numerator and denominator
4. analysis-run scoping
5. exact files changed
6. new files created
7. API changes, if any
8. UI location and behavior
9. graph coverage behavior
10. impact coverage behavior
11. uncovered-item behavior
12. empty/loading/error handling
13. accessibility
14. security/tenant isolation
15. performance considerations
16. focused test results
17. full test results
18. typecheck result
19. lint result
20. evidence-lint result
21. build result
22. git diff --check result
23. limitations
24. confirmation that Steps 48–50 remain intact
25. confirmation that no Phase 8+ functionality was implemented

Do NOT commit or push unless explicitly requested.