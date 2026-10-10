# Step 29 — Evidence Writer Implementation & CI Evidence Lint

## Overview

Global Step 29 introduces the **Evidence Writer** abstraction and the **CI Evidence Lint** check for Fluxora (`docs/architecture/05-component-responsibilities.md §5.7`, `docs/architecture/12-testing-strategy.md §12.1`, `docs/architecture/17-implementation-roadmap.md §Phase 4 Step 3`).

Every graph-write path in Fluxora must produce corresponding `Evidence` records with preserved source provenance, deterministic identity, tenant isolation, and transactional atomicity. Step 29 elevates evidence persistence from an ad-hoc implementation detail to a first-class architectural responsibility enforced at compile/CI time.

---

## Architectural Purpose & Scope Boundary

- **First-Class Evidence Concern**: Graph nodes and edges represent structural conclusions about code. Evidence records store *why* Fluxora arrived at those conclusions (file path, symbol ID, exact 1-based line/column spans, confidence score, and relationship descriptions).
- **Separation of Concerns**: Step 27 established the PostgreSQL schema and RLS policies for `evidence`. Step 28 established the `buildGraphProjection` and `persistGraphBuild` pipeline. Step 29 introduces `EvidenceWriter` to own evidence ID derivation, structural validation, batch persistence, and transaction participation.
- **Architectural Enforcement**: The CI Evidence Lint statically verifies that every graph-write path in the monorepo invokes `EvidenceWriter` rather than bypassing evidence generation or writing ad-hoc unevidenced graph records.
- **Scope Boundary**: Step 29 strictly implements Evidence Writer persistence, validation, and CI static linting. It deliberately does NOT implement recursive CTE queries (Step 30), graph API routes, UI visualization, or AI reasoning.

---

## Data Flow Architecture

```
                       Normalized Intelligence (Phase 3)
                                      │
                                      ▼
                      Graph Builder (buildGraphProjection)
                                      │
                 ┌────────────────────┴────────────────────┐
                 ▼                                         ▼
            GraphNode & GraphEdge                     Evidence Writer
               Create Inputs                       (createNodeEvidence /
                 (in-memory)                         createEdgeEvidence)
                 │                                         │
                 └────────────────────┬────────────────────┘
                                      │
                                      ▼
                      persistGraphBuild Transaction
                        (PostgreSQL withTenant)
                                      │
                 ┌────────────────────┼────────────────────┐
                 ▼                    ▼                    ▼
             graph_nodes         graph_edges            evidence
            (ON CONFLICT)       (ON CONFLICT)        (ON CONFLICT)
```

---

## Technical Design & Component Layers

### 1. Evidence Writer Abstraction (`EvidenceWriter`)

Location: `packages/db/src/repositories/evidence-writer.ts`

The `EvidenceWriter` class provides both static and instance-based methods for evidence identity, validation, and database operations:

- **Deterministic Identity (`generateEvidenceId`)**: Evidence primary keys (`id`) are deterministically derived via SHA-256 using the canonical seed:
  `${analysisRunId}:evidence:${subjectType}:${subjectId}:${filePath}:${relationshipDescription}`
- **Validation (`assertEvidenceInput`)**: Validates UUID formats for `organizationId`, `analysisRunId`, `subjectId`, checks 1-based line/column bounds (`lineStart >= 1`, `lineEnd >= lineStart`), confidence ranges (`0.0 <= confidence <= 1.0`), and non-empty string fields.
- **Non-Fabrication**: Unresolved relationships or missing source locations retain `null` for `symbolId`, `lineStart`, `columnStart`, etc. Source coordinates are never fabricated.
- **Database Persistence (`writeEvidence`, `writeEvidenceBatch`, `writeEvidenceBatchTx`)**: Executes `INSERT INTO evidence ... ON CONFLICT (id) DO UPDATE` to guarantee idempotency across repeated analysis runs.

### 2. Wiring Evidence Writer into Graph Persistence

- **Graph Builder (`apps/workers/src/builder/graph-builder.ts`)**: `buildGraphProjection` delegates node and edge evidence creation directly to `EvidenceWriter.createNodeEvidence` and `EvidenceWriter.createEdgeEvidence`.
- **Atomic Persistence (`packages/db/src/repositories/graph.ts`)**: `persistGraphBuild` executes node, edge, and evidence inserts inside a single `withTenant` PostgreSQL transaction block. `persistGraphBuild` calls `EvidenceWriter.writeEvidenceBatchTx(client, input.evidence)` to ensure atomic all-or-nothing rollback.
- **Low-level Write APIs (`createGraphNode`, `batchCreateGraphNodes`, `createGraphEdge`, `batchCreateGraphEdges`)**: Updated to accept optional `evidence` properties on `CreateGraphNodeInput` and `CreateGraphEdgeInput`, routing evidence persistence through `EvidenceWriter`.

### 3. CI Evidence Lint (`verifyGraphWritePaths`)

Locations: `packages/db/src/repositories/evidence-lint.ts`, `scripts/evidence-lint.ts`

- **Deterministic Source-Level Check**: Uses the TypeScript Compiler API (`ts.createSourceFile`) to parse graph-write source files without executing code or connecting to a live database.
- **Target Files**: Scans `packages/db/src/repositories/graph.ts` and `apps/workers/src/builder/graph-builder.ts`.
- **Invariant Enforcement**: Asserts that every function performing graph node or edge creation/persistence invokes `EvidenceWriter`.
- **CI Integration**: Executed via `pnpm lint:evidence` as a mandatory step in `.github/workflows/ci.yml`.

---

## Primary Files Created & Modified

1. `packages/db/src/repositories/evidence-writer.ts` — Implemented `EvidenceWriter` class for deterministic ID generation, input validation, single/batch persistence, and transaction participation.
2. `packages/db/src/repositories/evidence-lint.ts` — Implemented `verifyGraphWritePaths` static AST analyzer for Evidence Writer compliance.
3. `packages/db/src/repositories/evidence-writer.test.ts` — Added 14 focused unit and integration test scenarios covering determinism, idempotency, provenance preservation, transaction atomicity, RLS isolation, and CI lint checks.
4. `scripts/evidence-lint.ts` — Added standalone CLI entrypoint for running Evidence Lint.
5. `packages/shared-types/src/graph.ts` — Added optional `evidence` property to `CreateGraphNodeInput` and `CreateGraphEdgeInput`.
6. `packages/db/src/repositories/graph.ts` — Re-exported `EvidenceWriter`, updated `createEvidence`, `batchCreateEvidence`, and `persistGraphBuild` to delegate evidence persistence to `EvidenceWriter`.
7. `apps/workers/src/builder/graph-builder.ts` — Delegated node and edge evidence creation in `buildGraphProjection` to `EvidenceWriter`.
8. `package.json` — Added `"lint:evidence": "node --experimental-strip-types scripts/evidence-lint.ts"`.
9. `.github/workflows/ci.yml` — Added `Evidence Lint` step to CI pipeline.
10. `docs/DESIGN.md` — Updated with Section 46 architecture details and data flow.

---

## Verification & Test Strategy

All 14 focused Step 29 test scenarios pass:

1. `EvidenceWriter` creates valid evidence input with correct UUIDs.
2. Evidence identity is deterministic across repeated calls.
3. Repeating evidence writes is idempotent (`ON CONFLICT (id) DO UPDATE`).
4. Evidence provenance (file path, symbol ID, 1-based line/col, metadata) is preserved exactly.
5. Batch evidence writing is deterministic and idempotent.
6. Graph node writes receive evidence via `EvidenceWriter`.
7. Graph edge writes receive evidence via `EvidenceWriter`.
8. Evidence and graph records remain atomic in a single transaction (invalid evidence rolls back entire build).
9. Cross-tenant / RLS protections remain intact for Evidence Writer.
10. Invalid evidence input (negative line numbers, lineEnd < lineStart, out-of-range confidence) is rejected with `EvidenceValidationError`.
11. Missing/unresolved provenance is preserved as `null` without fabrication.
12. CI evidence-lint passes for valid graph-write paths (`pnpm lint:evidence`).
13. CI evidence-lint fails when a graph-write path bypasses `EvidenceWriter`.
14. Step 28 graph builder determinism and idempotency tests remain green.

