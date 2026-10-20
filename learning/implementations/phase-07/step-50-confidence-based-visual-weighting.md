# Step 50 — Confidence-Based Visual Weighting

## 1. Executive Summary & Step Objectives

Global Step 50 implements **Confidence-Based Visual Weighting** under **Phase 7: Evidence Engine** per `docs/architecture/17-implementation-roadmap.md`, `docs/architecture/08-frontend-application.md`, `docs/architecture/03-architecture-principles.md` (Principle P3), and `docs/architecture/22-definition-of-done.md`.

The primary objective of Step 50 is **Honest Uncertainty Presentation**:
> **Core Principle P3**: "Uncertainty is presented, never smoothed over. Every inferred relationship carries a confidence score; low-confidence edges are rendered distinctly (dashed, muted) rather than treated as facts or hidden."

### Core Architectural Invariant: Presentation-Only Normalization
Confidence is presentation metadata. Fluxora's backend analysis and traversal decay calculations are authoritative. The frontend **never** recomputes confidence, never executes formulas like `confidence = 0.9 ** depth`, never derives synthetic confidence from graph topology, and never fabricates fallback confidence values.

```
┌────────────────────────────────────────────────────────┐
│                   Backend (Authoritative)              │
│  - Static AST Analysis (direct imports = 1.0)          │
│  - Traversal & Impact Decay (hop decay = 0.9 per hop)  │
│  - Dynamic / Inferred Analysis (heuristics = 0.4–0.8)  │
└───────────────────────────┬────────────────────────────┘
                            │ Read-only API Response
                            ▼
┌────────────────────────────────────────────────────────┐
│             Frontend Presentation Normalization        │
│  - normalizeConfidence(raw) → NormalizedConfidence     │
│  - Monotonic visual mapping (High / Medium / Low)      │
│  - Missing confidence remains strictly missing (null)  │
└───────────────────────────┬────────────────────────────┘
                            │ Visual Encoding
                            ▼
┌────────────────────────────────────────────────────────┐
│                Visual Prominence Layer                 │
│  - Graph Edges: strokeWidth, opacity, strokeDasharray  │
│  - Impact Findings: card border, opacity, tier chips   │
│  - EvidenceCitation: tier styling, accessible labels   │
│  - Node Inspector: explicit confidence and tier badge  │
└────────────────────────────────────────────────────────┘
```

### Scope Boundaries Strictly Enforced
- **Step 51 Untouched**: No evidence coverage calculation, repository health metrics, missing-evidence analytics, coverage dashboards, or coverage heatmaps.
- **Backend Unchanged**: No changes to backend database schemas, graph traversal, blast-radius analysis, or confidence decay algorithms.
- **Data Integrity**: Browser treats confidence as read-only presentation metadata. No user-supplied confidence overrides.
- **No Edge Deletion or Filtering**: Low-confidence edges remain visible, selectable, inspectable, and structurally intact.
- **Deterministic Ordering**: Impact findings and graph nodes preserve their deterministic sorting regardless of confidence scores.

---

## 2. Architecture & Design Decisions

### 2.1 Authoritative Confidence Source
Authoritative confidence scores are provided by Fluxora's backend across several core domain and API contracts:
1. `GraphQueryResponseEdge.confidence: number`: Score for graph relationships (1.0 for direct AST imports, 0.7–0.89 for resolved dynamic imports, < 0.70 for heuristic or naming-based links).
2. `GraphQueryResponseNode.confidence: number`: Compiler/AST declaration confidence (typically 1.0 for static symbols).
3. `ImpactAnalysisFindingResponse.confidence: number`: Traversal-decayed blast-radius score (`0.9 ** hop`).
4. `GraphQueryResponseEvidence.confidence: number`: Provenance strength score for individual evidence records.

### 2.2 Presentation Normalization & Thresholds (`confidence-data.ts`)
To translate raw numeric confidence into consistent visual encodings without fabricating values, we introduced `normalizeConfidence`:

```ts
export type ConfidenceTier = "high" | "medium" | "low";

export interface NormalizedConfidence {
  readonly raw: number;
  readonly value: number;
  readonly percentage: number;
  readonly formattedPercentage: string;
  readonly tier: ConfidenceTier;
  readonly label: string;
  readonly accessibleLabel: string;
  readonly strokeWidth: number;
  readonly opacity: number;
  readonly strokeDasharray?: string | undefined;
}

export const CONFIDENCE_THRESHOLDS = {
  HIGH: 0.9,   // >= 90%: Direct AST imports, 1-hop impact, verified facts
  MEDIUM: 0.7, // >= 70% and < 90%: Dynamic imports, 2-3 hops impact, resolved inferences
  // Low: < 70%: Heuristic links, 4+ hops impact, uncertain hypotheses
} as const;
```

#### Threshold Rationale
These thresholds align directly with Fluxora's architecture documentation:
- `docs/architecture/05-component-responsibilities.md §5.7`: Direct AST = 1.0, resolved dynamic = 0.7–0.9, heuristic = 0.4–0.6.
- `DEFAULT_CONFIDENCE_DECAY_PER_HOP = 0.9`: Hop 0 = 1.0 (High), Hop 1 = 0.90 (High), Hop 2 = 0.81 (Medium), Hop 3 = 0.729 (Medium), Hop 4 = 0.656 (Low).
- `apps/web/src/components/graph/node-styles.ts`: Low-confidence threshold is `< 0.70`.

#### Missing Confidence Handling
If `confidence` is `null`, `undefined`, `NaN`, or non-numeric, `normalizeConfidence` returns `null`. The UI displays no percentage and implies no confidence tier.

### 2.3 Graph Edge Visual Weighting
Graph edges in `graph-mapping.ts` and `GraphCanvas.tsx` are weighted deterministically via `computeEdgeConfidenceStyles`:
- **High Confidence (>= 90%)**:
  - `stroke`: `#64748b` (prominent slate)
  - `strokeWidth`: `2.0px`
  - `opacity`: `1.0`
  - `strokeDasharray`: `undefined` (solid line)
- **Medium Confidence (70%–89%)**:
  - `stroke`: `#94a3b8` (neutral slate)
  - `strokeWidth`: `1.5px`
  - `opacity`: `0.85`
  - `strokeDasharray`: `undefined` (solid line)
- **Low Confidence (< 70%)**:
  - `stroke`: `#94a3b8` (neutral slate)
  - `strokeWidth`: `1.25px`
  - `opacity`: `0.65`
  - `strokeDasharray`: `"4 4"` (distinct dashed pattern)
- **Missing Confidence**: Neutral fallback (`strokeWidth: 1.5px`, `opacity: 0.85`, solid).
- **Selection State Priority**: When an edge is selected, selection styling takes absolute visual priority: `#3b82f6` (blue), `strokeWidth: 3px`, `opacity: 1.0`.

### 2.4 Graph Node Weighting & Invariants
- **No Synthetic Node Derivation**: Node confidence is never derived from adjacent edges, depth, or citation counts.
- **Change Mode**: Impacted nodes receive visual weighting based on their authoritative finding confidence (e.g. `< 0.70` produces dashed borders and amber indicators via `node-styles.ts`).
- **Base Mode**: Base graph nodes carry `confidence: number` from static analysis. The renderer displays confidence when `< 1.0`, but leaves standard node layout and geometry unchanged.

### 2.5 Impact Finding Weighting (`ChangeModeBar.tsx`)
In the PR Change Mode findings panel:
- Findings for direct, downstream, API, event, and service impacts are mapped with visual weighting:
  - High confidence: Solid border `border-slate-200`, opacity `1.0`.
  - Medium confidence: Solid border `border-slate-200/90`, opacity `0.95`.
  - Low confidence: Dashed border `border-dashed border-amber-300 bg-amber-50/20`, opacity `0.65`–`0.90`.
- Each finding item displays an explicit confidence chip (`finding-confidence-${node_id}`) with its percentage and tier styling.
- All findings remain visible, selectable via "View in graph →", and linked to their `EvidenceCitationList`.
- Findings maintain deterministic category and ID ordering.

### 2.6 EvidenceCitation Integration (`EvidenceCitation.tsx`)
- Extended `EvidenceCitation` to accept an optional authoritative `confidence` prop (falling back to `evidence.confidence`).
- **Compact Mode**: Renders `citation-confidence-chip` with `data-confidence-tier` and screen-reader accessible label (`aria-label="High confidence, 92 percent"`).
- **Expanded Mode**: Renders `citation-confidence` card label with `data-confidence-tier` and accessible text.
- **Missing Confidence**: Omits the chip/label entirely. Never displays placeholder percentages or default bands.

### 2.7 Accessibility (WCAG 2.1 AA)
Confidence is never communicated through color or opacity alone:
1. **Multi-Channel Signaling**: Visual variation uses stroke width (thickness), dash pattern (solid vs. dashed), opacity, and textual badges.
2. **Accessible Text**: Every confidence chip and edge provides an explicit `aria-label`: e.g. `"CALLS edge from A to B, High confidence, 95 percent"`.
3. **Inspectable**: Full confidence percentages and tier names are displayed textually in the Node Inspector panel.

---

## 3. Verification & Test Matrix

| Test Suite | File | Tests Passed | Focus Areas |
| --- | --- | --- | --- |
| **Confidence Weighting & Visuals** | `apps/web/src/components/graph/confidence-weighting.test.ts` | 19 / 19 | Normalization, thresholds, out-of-contract bounds, monotonic edge weighting, selection priority, node inspector metadata, findings panel weighting, deterministic ordering, citation confidence, accessibility |
| **Evidence Citation & UX (Step 49)** | `apps/web/src/components/graph/evidence-citation.test.ts` | 26 / 26 | Regression: Permalinks, sanitization, coordinates, deduplication, expanded mode, edge inspection |
| **Change Mode Overlay (Step 46)** | `apps/web/src/components/graph/change-mode.test.ts` | 27 / 27 | Regression: Normalization, state transitions, count metrics, finding resolution |
| **Node Inspector Panel** | `apps/web/src/components/graph/node-inspector.test.ts` | 13 / 13 | Regression: Node properties, edge properties, evidence trail |
| **Graph Canvas & Flow** | `apps/web/src/components/graph/graph-canvas.test.ts` | 8 / 8 | Regression: Mapping, deterministic layout, React Flow edges |
| **All Web Tests** | `apps/web` (13 test files) | 177 / 177 | Full frontend test suite pass |
| **All Workspace Tests** | `pnpm test` (7 packages, 50 test files) | 389 / 389 | Complete monorepo test suite pass |
| **AST Evidence Lint** | `pnpm lint:evidence` | 0 violations | All graph and impact conclusion writes invoke `EvidenceWriter` |
| **Workspace Typecheck** | `pnpm typecheck` | 0 errors | All 7 workspace packages pass with `exactOptionalPropertyTypes` |
| **Workspace Lint** | `pnpm lint` | 0 errors | ESLint passes cleanly across all packages |
| **Workspace Build** | `pnpm build` | 0 errors | Next.js production build compiled cleanly |
| **Git Diff Check** | `git diff --check` | 0 issues | Clean diff without whitespace or merge errors |

---

## 4. Key Architectural Lessons & Invariants

1. **Evidence vs. Confidence**:
   - **Evidence** is *provenance* (the AST node, file, and line that prove a relationship exists).
   - **Confidence** is *strength* (a numeric probability of relevance or propagation fidelity).
   - High confidence does not substitute for missing evidence; low confidence does not invalidate existing evidence.
2. **Never Calculate Confidence in the Browser**:
   - Calculating `0.9 ** depth` in the client introduces dual-source-of-truth drift between API responses, CLI exports, and UI views.
   - The frontend normalizes authoritative numbers into presentation tiers only.
3. **Low Confidence Must Never Mean Invisible**:
   - Principle P3 forbids hiding or auto-filtering uncertain data. Engineers need to see heuristic links to investigate potential regressions.
   - Low-confidence edges are rendered dashed with reduced opacity, but remain fully interactive and selectable.

