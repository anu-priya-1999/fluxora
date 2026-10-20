# Step 51 — Analysis Coverage View

## 1. Executive Summary & Step Objectives

Global Step 51 implements the **Analysis Coverage View**, concluding **Phase 7: Evidence Engine** per `docs/architecture/17-implementation-roadmap.md`, `docs/architecture/08-frontend-application.md`, `docs/architecture/03-architecture-principles.md` (Principles P1, P2, P3), and `docs/architecture/22-definition-of-done.md`.

Phase 7 progression:
- **Step 48**: Evidence completeness audit & CI hardening (guaranteeing that all conclusion write paths invoke `EvidenceWriter`).
- **Step 49**: Clickable evidence citations & GitHub source permalinks (`EvidenceCitation` with line badges and audit drawers).
- **Step 50**: Confidence-based visual weighting (communicating certainty and traversal decay monotonically without hiding uncertainty).
- **Step 51**: **Analysis Coverage View** (answering: *"How much of the analyzed surface has verified evidence, and where are the gaps?"*).

### The Core Question Answered by Step 51
> **"How much of the analyzed surface has verified evidence, and where are the gaps?"**

Step 51 makes evidence completeness and architectural gaps visible, understandable, and actionable across the Architecture Explorer without modifying graph traversal algorithms, mutating backend databases, or creating synthetic evidence.

```
┌────────────────────────────────────────────────────────┐
│               Authoritative Backend Data               │
│  - Graph Query: GraphQueryResponseEdge.evidence_id    │
│  - PR Impact: ImpactAnalysisFindingResponse.evidence   │
│  - Analysis Run Context: analysisRunId, repository     │
└───────────────────────────┬────────────────────────────┘
                            │ Read-only API Contract
                            ▼
┌────────────────────────────────────────────────────────┐
│             Deterministic Coverage Engine              │
│                 (coverage-data.ts)                     │
│  - Exact Numerator: Evidence-backed conclusions        │
│  - Exact Denominator: Analyzed conclusions in scope    │
│  - Distinct Scopes: Graph Edges vs. PR Impact Findings │
│  - Deterministic Sorting & Category Groupings          │
└───────────────────────────┬────────────────────────────┘
                            │ Presentation Model
                            ▼
┌────────────────────────────────────────────────────────┐
│              Analysis Coverage Interface               │
│              (AnalysisCoverageBar.tsx)                 │
│  - Compact Summary: Badge, counts, progress bar        │
│  - Category Breakdown: IMPORTS, CALLS, APIs, etc.      │
│  - Actionable Uncovered Findings: "Inspect in Graph"   │
│  - Multi-Channel Accessibility (WCAG 2.1 AA)           │
└────────────────────────────────────────────────────────┘
```

---

## 2. Precise Definition of Coverage

Evidence Coverage in Fluxora is defined deterministically:

$$\text{Evidence Coverage} = \frac{\text{Evidence-Backed Analyzed Conclusions in Selected Scope}}{\text{Analyzed Conclusions in Selected Scope}}$$

### 2.1 Graph Analysis Surface (Graph Edges)
- **Scope**: Current analysis run slice (`analysisRunId`) loaded in the Architecture Explorer.
- **Denominator ($N$)**: Total analyzed graph edges in scope (`edges.length`).
- **Numerator ($K$)**: Analyzed graph edges with authoritative evidence (`isGraphEdgeCovered(edge) === true`, requiring a non-empty string in `edge.evidence_id`).
- **Missing / Uncovered ($U = N - K$)**: Analyzed graph edges where `evidence_id` is `null`, `undefined`, or empty string.
- **Percentage**:
  - If $N > 0$: $\text{round}\left(\frac{K}{N} \times 100, 1\right)$ (e.g. `100%`, `96.5%`, `0%`).
  - If $N = 0$: Reported explicitly as `N/A` with text `"0 analyzed graph edges in scope"` (never fabricating a false 0% failure state).
- **Categories**: Grouped by edge type (`IMPORTS`, `CALLS`, `EXPOSES_ROUTE`, `EMITS_EVENT`, `CONSUMES_EVENT`, `QUERIES_DB`, `WRITES`, etc.).

### 2.2 PR Blast-Radius Impact Surface (Impact Findings)
- **Scope**: Current PR Impact Analysis (`impactAnalysisId`, `pullRequestId`, based on `analysisRunId`).
- **Denominator ($N$)**: Total impact findings across all authoritative categories (`direct_impact.length + downstream_impact.length + affected_apis.length + affected_events.length + affected_services.length`).
- **Numerator ($K$)**: Impact findings with verified evidence (`finding.evidence_ids.length > 0 || (finding.evidence_id != null && finding.evidence_id !== "")`).
- **Missing / Uncovered ($U = N - K$)**: Impact findings with no associated evidence IDs.
- **Categories**:
  - `Direct impact`
  - `Downstream impact`
  - `Affected APIs`
  - `Affected events`
  - `Affected services`
- **Unresolved Files**: Surfaced explicitly as unmapped/unsupported files in the PR (`unresolved_files: [{ path, reason }]`), providing complete visibility into non-code or unparsed files.

### 2.3 Critical Distinction: Confidence vs. Coverage
Fluxora strictly enforces that **Confidence** and **Coverage** are orthogonal concepts:
- **Confidence asks**: *"How strong or direct is this conclusion?"*
- **Coverage asks**: *"Does this conclusion have verified provenance evidence?"*

| Conclusion State | Confidence | Evidence Present? | Coverage Status | Visual Presentation |
| --- | --- | --- | --- | --- |
| Direct AST import | 1.0 (High) | Yes | **Covered** | Solid prominent stroke, covered badge |
| Deep heuristic edge | 0.4 (Low) | Yes | **Covered** | Dashed stroke, covered badge, low confidence chip |
| Speculative route link | 0.95 (High) | No | **Uncovered** | Dashed stroke, missing evidence alert, actionable gap |
| Fallback hypothesis | 0.5 (Low) | No | **Uncovered** | Dashed stroke, missing evidence alert, actionable gap |

Under no circumstances is high confidence treated as an implicit substitute for evidence coverage.

---

## 3. Architecture & Component Design

### 3.1 Pure Presentation Engine (`coverage-data.ts`)
- Pure, deterministic calculation functions with zero side effects:
  - `calculateGraphEdgeCoverage(options)`: Computes summary, categories, and sorted uncovered edges.
  - `calculateImpactFindingCoverage(options)`: Computes summary, 5-tier categories, and sorted uncovered findings.
  - `formatCoveragePercentage(covered, total)`: Formats deterministic integer or single-decimal percentage strings.
  - `isGraphEdgeCovered(edge)`: Validates authoritative string presence of `evidence_id`.
  - `isImpactFindingCovered(finding)`: Validates array length of `evidence_ids` or string presence of `evidence_id`.
- **Deterministic Ordering**:
  - Uncovered edges are sorted by `edgeType` (alphabetical), then `sourceName` (alphabetical), then `targetName` (alphabetical), then `id`.
  - Uncovered impact findings are sorted by category order (`direct`, `downstream`, `api`, `event`, `service`), then `hopDistance` ascending, then `name`, then `nodeId`.

### 3.2 Analysis Coverage View Component (`AnalysisCoverageBar.tsx`)
- Rendered in `apps/web/src/app/repositories/[repoId]/explorer/explorer-client.tsx` directly between the header/ChangeModeBar and GraphFilters.
- **Top Bar**:
  - Status indicator (emerald for 100%, amber for partial, rose for 0%, slate for empty).
  - Scope badge (`Analysis Run: {analysisRunId}` or `Impact Analysis: {impactId}`).
  - Refreshing / stale indicator badge when graph background refreshes occur.
  - Scope surface tabs (`Graph Edges` vs. `PR Impact Findings`) when change mode is active.
  - Summary stats: `Covered: K | Missing: U | Total: N`.
  - Exact percentage badge (`100%`, `96.5%`, `0%`).
  - Accessible progress bar (`role="progressbar"`).
  - Expand/collapse drawer toggle (`View Details` / `Hide Details`).
- **Expanded Drawer**:
  - **Category Coverage Breakdown**: Grid of cards showing total, covered, uncovered, percentage, and mini progress bar for each analyzed edge type or impact category.
  - **Unresolved PR Files Alert**: Informative banner when changed PR files could not be mapped to graph nodes.
  - **Actionable Findings Section**:
    - Filter pills: `All (N)`, `Covered (K)`, `Missing Evidence (U)`.
    - Success banner when 0 gaps exist: *"All analyzed conclusions have verified evidence. No evidence gaps detected."*
    - Uncovered items list: Each row displays subject type, names/routes, confidence badge, missing evidence status chip, and an **"Inspect in Graph"** action button.
    - Selecting an uncovered edge invokes `onSelectEdge(edge.id)` -> highlights edge in `GraphCanvas` and opens edge inspection in `NodeInspectorPanel`.
    - Selecting an uncovered finding invokes `onSelectNode(node.id)` -> highlights node in `GraphCanvas` and opens node inspection in `NodeInspectorPanel`.

### 3.3 Node Inspector Integration (`node-inspector-data.ts`)
- Edge inspection in `NodeInspectorPanel` surfaces an explicit `inspector-edge-coverage-status` badge:
  - `data-coverage-status="covered"`: Emerald badge (`Covered`) with link to `EvidenceCitation`.
  - `data-coverage-status="uncovered"`: Rose badge (`Missing Evidence`) with alert explaining that no provenance record is linked.

---

## 4. Multi-Channel Accessibility (WCAG 2.1 AA)

In adherence to WCAG 2.1 AA (Guideline 1.4.1 Use of Color):
1. **Never Color Alone**: Coverage status is always accompanied by explicit text chips (`Covered`, `Missing Evidence`), exact numerical figures (`96.5%`, `12 / 12`), and semantic labels.
2. **Accessible Labeling**: Every summary indicator and category card provides detailed screen-reader text:
   `"Evidence coverage: 96.5 percent, 842 of 873 analyzed conclusions have evidence."`
3. **Semantic Progress Bar**: Visual progress bars utilize standard ARIA attributes:
   `role="progressbar"`, `aria-valuenow="96.5"`, `aria-valuemin="0"`, `aria-valuemax="100"`.
4. **Keyboard Accessibility**: All toggle buttons, tab switches, and inspection triggers are semantic `<button>` elements with `:focus-visible` outline rings.

---

## 5. Scope Invariants & Boundaries Preserved

1. **Deterministic Core Preserved**: No client-side graph recomputation; coverage is a presentation layer over authoritative persisted data.
2. **No Database Access from Frontend**: The frontend never queries PostgreSQL, never imports `@fluxora/db`, and never inspects raw repository files.
3. **No Changes to Traversal or Evidence Writing**: Traversal algorithms (`@fluxora/db/repositories/graph.ts`) and `EvidenceWriter` remain untouched.
4. **No Graph Edge Culling**: Coverage does not hide or delete graph edges; topology remains intact.
5. **No AI Invention**: Coverage values are derived mathematically from authoritative counts; no heuristic or predictive coverage estimation is introduced.

---

## 6. Verification & Test Matrix

- **Focused Step 51 Unit & Integration Suite (`coverage.test.ts`)**:
  - 22 tests covering:
    - Section A: Percentage calculations, 100%, 0%, partial, and empty scope handling.
    - Section B: Scope isolation, analysis-run context, and distinct graph vs. impact denominators.
    - Section C: Category breakdowns for edge types and impact categories.
    - Section D: High-confidence uncovered items, low-confidence covered items, and deterministic ordering.
    - Section E: UI rendering across all 10 states (available, loading, error, empty, full, zero, stale).
    - Section F: Expanded drawer, filter toggles, and graph selection actions.
    - Section G: Multi-channel accessibility and ARIA progressbar compliance.
    - Section H: NodeInspectorPanel edge coverage badge integration.
- **Full Workspace Test Results**:
  - `apps/web`: 14 test files, 199 tests passed (0 failures).
  - Monorepo: 50 test files, 411 tests passed across all 7 packages.
- **Typecheck & Linter**:
  - `pnpm typecheck`: 0 errors across all 7 packages.
  - `pnpm lint`: 0 ESLint errors.
  - `pnpm lint:evidence`: 0 violations; static AST check verified.
  - `pnpm build`: Next.js production build compiled cleanly in Turbopack.
  - `git diff --check`: Clean diff, zero whitespace or conflict errors.

---

## 7. Phase 7 Completion Milestone

Step 51 completes **Phase 7: Evidence Engine**:
1. **Step 48**: Evidence completeness audit & hardening (provenance invariant statically enforced in CI).
2. **Step 49**: Clickable evidence citations & GitHub source permalinks (interactive provenance navigation).
3. **Step 50**: Confidence-based visual weighting (honest presentation of uncertainty without topology modification).
4. **Step 51**: Analysis coverage view (immediate visibility into verified surface and actionable gaps).

Fluxora now provides complete end-to-end provenance visibility: every architectural conclusion can be traced to verified code evidence, uncertainty is visually weighted, and coverage gaps are surfaced transparently.

