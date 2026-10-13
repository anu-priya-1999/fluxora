# Step 36 — Node Inspector Panel & Evidence Trail

## Executive Summary

Fluxora Global Step 36 implements the `NodeInspectorPanel` and `EvidenceTrail` components for the Architecture Explorer. When an engineer clicks any graph node in the React Flow canvas, a typed selection is propagated to the Explorer client container, opening a right-side inspector panel displaying the node's architectural properties, metadata, and verifiable source code evidence trail.

All evidence and node attributes originate strictly from the backend's existing `GraphQueryResponse` returned by `POST /api/v1/graph/query` (Step 31). No secondary network requests or database queries are performed.

---

## Architecture & Data Flow

```
   ┌─────────────────────────────────────────────────────────────┐
   │ Backend Engine (POST /api/v1/graph/query)                   │
   │ Bounded CTE traversal + verified EvidenceWriter records     │
   └──────────────────────────────┬──────────────────────────────┘
                                  │
                                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ ArchitectureExplorerClient State                            │
   │ - graph: GraphQueryResponse (nodes, edges, evidence)        │
   │ - selectedNodeId: string | null (React useState)            │
   └──────────────────────────────┬──────────────────────────────┘
                                  │
            ┌─────────────────────┴─────────────────────┐
            ▼                                           ▼
   ┌─────────────────────────────┐             ┌─────────────────────────────┐
   │ GraphCanvas (Left Pane)     │             │ NodeInspectorPanel (Right)  │
   │ - onNodeClick(id)           │             │ - node details & metadata   │
   │ - onPaneClick() (clear)     │             │ - onClose() (clear button)  │
   │ - isSelected visually shown │             │ - empty state when null     │
   └─────────────────────────────┘             └──────────────┬──────────────┘
                                                              │
                                                              ▼
                                               ┌─────────────────────────────┐
                                               │ EvidenceTrail               │
                                               │ - explicit association:     │
                                               │   subject_type='graph_node' │
                                               │   AND subject_id=node.id    │
                                               │ - deterministic sort:       │
                                               │   path → start → end → id   │
                                               └─────────────────────────────┘
```

---

## Core Components & Responsibilities

### 1. Node Selection (`ArchitectureExplorerClient`)
- **State Ownership**: Owned at the smallest shared boundary (`ArchitectureExplorerClient`) using React's standard `useState<string | null>(null)`. No external state-management libraries (such as Zustand, Redux, or Jotai) are introduced.
- **Selection Lifecycle**:
  - Clicking a node selects it (`setSelectedNodeId(id)`).
  - Clicking another node replaces the selection.
  - Clicking the canvas background or clicking "Clear" in the inspector header resets `selectedNodeId` to `null`.
- **Visual Feedback**: `GraphCanvas` receives `selectedNodeId` and maps `isSelected: true` into `NodeRenderer`, which applies an active blue outline and focus shadow.

### 2. NodeInspectorPanel (`NodeInspectorPanel.tsx`)
- **Location**: `apps/web/src/components/graph/NodeInspectorPanel.tsx`.
- **Purely Presentational**: Receives `node: GraphQueryResponseNode | null` and `evidence: GraphQueryResponseEvidence[]`. Performs zero network requests and zero database queries.
- **Empty State**: Renders an accessible, centered placeholder message when no node is selected (`data-testid="inspector-empty-state"`).
- **Inspected Fields**:
  - Node Type (with dedicated badge styling from `node-styles.ts`).
  - Node Name (with word breaking).
  - Node ID (`id`) and Canonical Identifier (`canonical_id`).
  - Traversal Depth (`depth`) and Confidence Score (`confidence`).
  - File Path (`path`), when available.
  - Metadata: Formats present key-value pairs cleanly and truncates oversized payloads safely using `safeFormatMetadataValue`.
- **Deselection Action**: Renders a "Clear" button (`data-testid="clear-selection-button"`) to dismiss the panel.

### 3. EvidenceTrail (`EvidenceTrail.tsx`)
- **Location**: `apps/web/src/components/graph/EvidenceTrail.tsx`.
- **Explicit Evidence Association**:
  ```ts
  evidence.subject_type === "graph_node" && evidence.subject_id === selectedNode.id
  ```
  Edge evidence (`subject_type === "graph_edge"`), other subject types (`impact_finding`, `simulation_state`), and foreign node IDs are strictly excluded.
- **Deterministic Ordering**: Derived strictly from immutable fields:
  1. `file_path` (lexicographical)
  2. `line_start` (ascending numerical; `-1` if absent)
  3. `line_end` (ascending numerical; `-1` if absent)
  4. `id` (lexicographical tie-breaker)
- **Rendered Properties**:
  - `relationship_description`
  - `file_path`
  - Formatted coordinates: `formatCoordinates` handles full ranges (`Lines 10–25, Col 1–50`), single lines (`Line 42`), columns, and partial/missing coordinates without crashing.
  - `symbol_id` when present.
  - `confidence` percentage indicator.
  - `metadata` formatted safely.
- **Empty State**: Renders a dedicated fallback (`data-testid="evidence-empty-state"`) when a node has zero matching evidence records.

---

## Architectural & Security Invariants

1. **Deterministic Core vs. UI Projection**:
   The browser does not compute, infer, or synthesize evidence. All evidence records reflect the immutable AST coordinates recorded by `EvidenceWriter` during repository ingestion.
2. **Database Boundary Protection**:
   `apps/web` does **not** import `@fluxora/db`, execute SQL queries, or talk directly to PostgreSQL.
3. **No Unrequested Dependencies**:
   Zero state libraries added; React Flow + standard React state coordinates selection.
4. **Tenant Isolation**:
   The response is already scoped to the authenticated tenant via the backend's verified Clerk token and PostgreSQL RLS.

---

## Verification Results

| Check | Result | Command |
| --- | --- | --- |
| Web Test Suite (40 tests) | PASSED | `pnpm --filter @fluxora/web test` |
| Web Typecheck | PASSED | `pnpm --filter @fluxora/web typecheck` |
| Workspace Typecheck (7 packages) | PASSED | `pnpm typecheck` |
| ESLint Code Quality | PASSED | `pnpm lint` |
| AST Evidence Lint | PASSED | `pnpm lint:evidence` |
| Production Build (Next.js 16) | PASSED | `pnpm build` |
| Git Diff Cleanliness | PASSED | `git diff --check` |
| Workspace Test Suite (253 tests) | PASSED | `pnpm test` |

---

## Strict Scope Boundary: What Step 36 Does NOT Implement

- `GraphFilters` (Step 37)
- Clustering / Level-of-Detail pre-aggregation (Step 38)
- WebSocket live cache invalidation / `graph.updated` subscriptions (Step 39)
- Visual polish / edge routing styling (Step 40)
- PR change-impact analysis or simulation UI (Phase 6 / Phase 8)
- AI-driven explanations or LLM summaries (Phase 9)

