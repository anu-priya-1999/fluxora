# Step 49 — Clickable Evidence Citation UI

## 1. Executive Summary & Step Objectives

Global Step 49 implements **Clickable Evidence Citation UI** under **Phase 7: Evidence Engine** per `docs/architecture/17-implementation-roadmap.md`, `docs/architecture/08-frontend-application.md`, and `docs/architecture/22-definition-of-done.md`.

The primary objective of Step 49 is **Traceability**:
> **Core Principle**: Wherever Fluxora presents a conclusion backed by evidence (graph edge, node with provenance, PR impact finding, or inspector trail), the user must be able to click that citation to inspect its exact provenance and navigate to the verified source location without fabricating source paths, line ranges, or commit SHAs.

### User Interaction Journey
```
CONCLUSION (Edge / Impact Finding / Graph Node)
  ↓
EvidenceCitation (Compact chip or expanded card)
  ↓
Evidence Details (File path, line range, symbol, analysis run, confidence, metadata)
  ↓
Source Location / Provenance Target (Safe GitHub permalink with exact line anchor or honest unavailable state)
```

### Scope Boundaries Strictly Enforced
- **No visual weighting or confidence filtering**: Step 50 remained untouched.
- **No coverage heatmap or analysis coverage UI**: Step 51 remained untouched.
- **No LLM or AI reasoning**: Deterministic evidence inspection only.
- **No synthetic fabrication**: If line numbers or commit references are absent, the UI honestly displays "Source link unavailable" with an explanation tooltip rather than fabricating `L0` or `main`.
- **No direct database access from frontend**: Consumes authenticated REST API routes.
- **No mutation of evidence**: Evidence remains immutable, backend-owned, and append-only.

---

## 2. Architecture & Design Decisions

### 2.1 Backend Contract Extension (`@fluxora/shared-types` & `apps/api`)
Previously, `ImpactAnalysisResponse` returned findings containing `evidence_ids: string[]`, but the actual evidence records (`file_path`, `line_start`, `relationship_description`, etc.) were not returned in the impact analysis GET route.
- Extended `ImpactAnalysisResponse` with optional `evidence?: readonly GraphQueryResponseEvidence[] | undefined`.
- Updated `apps/api/src/http/impact-analysis.ts` to call `listImpactFindingEvidence(dbClient, tenantContext.organizationId, analysis.id)`.
- Added `formatImpactEvidence` in `apps/api/src/http/impact-analysis-response.ts` to transform database evidence records into `GraphQueryResponseEvidence`.
- Multi-tenant RLS isolation is strictly preserved: only evidence belonging to the authenticated user's organization is retrieved.

### 2.2 Security & Deterministic Permalink Construction (`evidence-citation-data.ts`)
Source navigation permalinks are constructed through a strict, deterministic validator:
1. **Repository Name Validation**: Must match `/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/`.
2. **Immutable Commit Preference**: Prefers pinned commit SHA (`/^[0-9a-fA-F]{7,40}$/`) over mutable refs (`/^[a-zA-Z0-9_./-]+$/`). Rejects refs containing `..`.
3. **Path Traversal & Injection Defense**: File paths cannot start with `/` or `\\`, cannot contain `..`, `:`, or URI scheme markers (`javascript:`, `data:`).
4. **Exact Coordinate Anchors**: Formats `#L{start}-L{end}` or `#L{start}` strictly when positive integers exist. Never fabricates fake line ranges.
5. **Non-Fabrication**: When prerequisites are not met, returns `available: false` with a descriptive reason.

### 2.3 Evidence Deduplication & Ordering
When multiple evidence records support a single finding or node:
- Deduplicates by unique `evidence.id`.
- Sorts deterministically by:
  1. `file_path` ASC
  2. `line_start` ASC
  3. `line_end` ASC
  4. `relationship_description` ASC
  5. `id` ASC

### 2.4 Component Architecture (`EvidenceCitation.tsx`)
Written with `React.createElement` for complete compatibility with Next.js SSR and the repo's Vitest runner (which runs without JSX plugins):
- **Compact Mode**: Inline chip with short file name, line range badge (`L15–L45`), confidence score chip (`98%`), and clickable external link or detail modal trigger.
- **Expanded Mode**: Full card showing relationship description, file path, symbol, analysis run ID, confidence chip, metadata table, and source link.
- **States**:
  - `citation-loading-state`: Accessible spinner with `role="status"`.
  - `citation-error-state`: Accessible alert banner with `role="alert"`.
  - `citation-source-unavailable`: Informative tooltip explaining why source permalink is disabled.
  - `citation-unresolved-id`: Fallback badge when evidence ID exists but record metadata is not loaded.
- **`EvidenceCitationList`**: Handles collections of evidence, resolving candidates from an evidence pool or individual finding evidence IDs.

### 2.5 Integration into Existing Explorer Views
1. **NodeInspectorPanel**:
   - Added edge selection inspection (`edge` prop) displaying edge type, confidence, and an expanded `EvidenceCitation` for the edge's provenance.
   - For nodes under PR Change Mode, displays compact `EvidenceCitation` chips for each linked PR impact finding.
   - Updated `EvidenceTrail` with `citation-source-link` permalinks and honest unavailable badges, preserving all legacy Step 36 test IDs.
2. **GraphCanvas**:
   - Added `selectedEdgeId` and `onEdgeClick` to support interactive edge selection and styling (`strokeWidth: 3`, `#3b82f6`).
3. **ChangeModeBar**:
   - Added expandable `impact-findings-panel` displaying all direct, downstream, API, and event impact findings with clickable `EvidenceCitationList` components and "View in graph" selection actions.
4. **Explorer Client**:
   - Threaded repository context (`repositoryName`, `commitSha`, `gitRef`) and active edge selection across `ChangeModeBar`, `GraphCanvas`, and `NodeInspectorPanel`.

---

## 3. Verification & Test Matrix

| Test Suite | File | Tests Passed | Focus Areas |
| --- | --- | --- | --- |
| **Evidence Citation & UX** | `apps/web/src/components/graph/evidence-citation.test.ts` | 26 / 26 | Permalink construction, path sanitization, coordinate formatting, deduplication, compact/expanded modes, loading/error states, edge inspection, PR findings panel |
| **Change Mode Overlay** | `apps/web/src/components/graph/change-mode.test.ts` | 27 / 27 | Normalization, state transitions, finding resolution |
| **Explorer Status & Query** | `apps/web/src/components/graph/explorer-status.test.ts` | 20 / 20 | Loading, error, empty, and retry states |
| **All Web Tests** | `apps/web` (12 test files) | 158 / 158 | Full frontend test suite pass |
| **API Impact Readback** | `apps/api/src/http/impact-analysis.test.ts` | 20 / 20 | Test W verifies GET `/api/v1/impact-analyses/:id` returns formatted evidence |
| **All API Tests** | `apps/api` (11 test files) | 124 / 124 | Full API test suite pass |
| **AST Evidence Lint** | `pnpm lint:evidence` | 0 violations | All graph and impact conclusion writes invoke `EvidenceWriter` |
| **Workspace Typecheck** | `pnpm typecheck` | 0 errors | All 7 workspace packages pass with `exactOptionalPropertyTypes` |
| **Workspace Lint** | `pnpm lint` | 0 errors | ESLint passes cleanly across all packages |
| **Workspace Build** | `pnpm build` | 0 errors | Next.js production build compiled cleanly |

---

## 4. Key Architectural Lessons & Invariants

1. **React 19 Prop Naming (`gitRef` vs `ref`)**:
   In React 19 and modern ESLint rules (`react-hooks/refs`), passing or reading a prop named `ref` during component rendering triggers linter errors because `ref` is treated as a component ref. Using domain-specific names (`gitRef`, `commitSha`) avoids naming collisions and guarantees clean linting.
2. **`exactOptionalPropertyTypes: true` in Next.js Monorepos**:
   When TypeScript enables `exactOptionalPropertyTypes`, assigning `{ style: isSelected ? ... : e.style }` fails if `e.style` can be `undefined`. Returning the object unmodified when not selected completely preserves type safety without inserting `undefined` values.
3. **Honest Fallbacks over Synthetic Placeholders**:
   It is tempting to default missing commit SHAs to `"main"` or missing lines to `0`. Fluxora's architecture explicitly forbids this: provenance must be real, verifiable, and honest. Missing metadata surfaces as "Source link unavailable" with an informative explanation.

