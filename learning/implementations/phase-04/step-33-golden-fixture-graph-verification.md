# Step 33 — Golden Fixture Graph Verification: End-to-End Contract Validation

## Overview

Global Step 33 implements the end-to-end golden fixture verification test suite (`apps/workers/src/pipeline/golden-graph.test.ts`) that validates the complete deterministic pipeline:
$$\text{Source Fixture Code} \longrightarrow \text{AST Extraction \& Normalization} \longrightarrow \text{Graph Builder} \longrightarrow \text{PostgreSQL Persistence} \longrightarrow \text{Repository Readback} \longrightarrow \text{Contract Verification}$$

Step 33 ensures that the graph persisted in PostgreSQL strictly obeys the architectural contracts defined across Phase 3 (Steps 18–26) and Phase 4 (Steps 27–32). It tests the actual database-backed state against canonical invariants rather than relying merely on mocked unit tests.

---

## Architectural Purpose & Scope Boundary

- **Contract-Level Ground Truth**: Validates that all phases of code intelligence and graph storage work synchronously on a non-trivial, multi-file codebase (`packages/db/src/fixtures/taxonomy`).
- **Relational Integrity**: Asserts foreign keys, unique constraints, and absence of dangling pointers across `graph_nodes`, `graph_edges`, and `evidence`.
- **First-Class Evidence Provenance**: Verifies that every single graph node and graph edge is linked to exact source file coordinates via `EvidenceWriter` (`packages/db/src/repositories/evidence-writer.ts`).
- **Deterministic Core Invariant**: Verifies that re-running graph construction on identical source fixtures yields identical node and edge sets without duplicate records or ordering drift.
- **Strict Multi-Tenant & Run Isolation**: Verifies that PostgreSQL Row-Level Security (RLS) blocks cross-tenant reads and that separate analysis runs within the same tenant remain strictly isolated.
- **Recursive-CTE Traversal Smoke Test**: Validates that the Step 30 bounded-depth recursive-CTE traversal engine executes correctly over the persisted golden graph.
- **Scope Boundary**: Step 33 is strictly a verification and hardening step. It does NOT implement:
  - Global Step 34 (Phase 4 completion review & transition)
  - Phase 5 React Flow interactive graph canvas or UI components
  - Phase 6 PR change-impact traversal or GitHub webhooks
  - Phase 9 LLM-assisted graph explanations

---

## Architecture & Data Flow

```
[ Golden Fixture Files: taxonomy ]
         │
         ▼
[ Step 18–26: runNormalizedAnalysisPipeline(files) ]
         │  (symbols, import/export graph, API routes)
         ▼
[ Step 28: buildAndPersistGraph(input, { pool, organizationId, analysisRunId }) ]
         │
         ├── withTenant(pool, organizationId) Transaction
         │     ├── EvidenceWriter.createNodeEvidence() -> graph_nodes, evidence
         │     ├── EvidenceWriter.createEdgeEvidence() -> graph_edges, evidence
         │     └── Step 32: computeGraphDiff() -> events (graph.updated)
         │
         ▼ COMMIT
[ PostgreSQL Tables: graph_nodes, graph_edges, evidence, events ]
         │
         ▼ Readback via Production Repositories
[ listGraphNodes, listGraphEdges, getGraphNodeById, listEvidenceForSubject, getEvidenceById ]
         │
         ▼ Step 33 Assertions
[ Contract 1: Canonical Nodes (counts, types, stable IDs, uniqueness) ]
[ Contract 2: Canonical Edges (counts, types, directionality, referential integrity) ]
[ Contract 3: Evidence Provenance (valid file paths, positive 1-based coordinates) ]
[ Contract 4: Determinism & Idempotency (repeated runs produce identical graphs) ]
[ Contract 5: Tenant & Run Isolation (RLS enforcement across orgs and runs) ]
[ Contract 6: Negative Assertions (absence of bogus symbols, phantom edges, or leaked files) ]
[ Contract 7: Bounded-Depth CTE Traversal (smoke test module->route/import chains) ]
```

---

## Canonical Graph Contract Details

For the canonical `taxonomy` fixture (5 source files: `app/api/posts/route.ts`, `app/api/users/route.ts`, `lib/auth.ts`, `lib/db.ts`, `lib/utils.ts`):

1. **Graph Nodes (490 total)**:
   - `symbol` (367 nodes): Canonical IDs format `sym:<filepath>#<symbolName>:<lineStart>`.
   - `module` (118 nodes): Canonical IDs format `mod:<filepath>`.
   - `api` (5 nodes): Next.js App Router route handlers. Canonical IDs format `route:<filepath>#<handler>:<method>:<path>:<lineStart>`.
   - Zero unexpected duplicate canonical IDs per analysis run.

2. **Graph Edges (888 total)**:
   - `IMPORTS` (511 edges): Module-to-module dependencies.
   - `RESOLVES_TO` (372 edges): Symbol-to-symbol resolution edges.
   - `EXPOSES_ROUTE` (5 edges): Module/handler exposing an API route.
   - Zero dangling edges (`sourceNodeId` and `targetNodeId` both resolve to valid nodes in the same run).

3. **Evidence Records (1378 total)**:
   - Exactly 490 `graph_node` evidence records + 888 `graph_edge` evidence records.
   - 100% of evidence rows have valid file paths, confidence scores of 1.0, and positive 1-based line coordinates.

---

## Engineering Hardening & Bug Fixes in Step 33

During the end-to-end verification of the golden fixture, two subtle edge cases were surfaced and hardened:

1. **Multi-line Evidence Column Range Check**:
   - *Problem*: In TypeScript ASTs, multi-line declarations can have a start column greater than their end column on the ending line (e.g., line 5 col 25 to line 8 col 10). The existing check constraint `evidence_column_end_valid` (`column_end >= column_start`) and TypeScript validation threw an error on valid multi-line tokens.
   - *Fix*: Updated `packages/db/src/repositories/evidence-writer.ts` and migration `0015_evidence_coordinates_constraint.sql` to require `column_end >= column_start` only when `line_start = line_end`.

2. **PostgreSQL NOTIFY Payload Size Limit**:
   - *Problem*: PostgreSQL's `NOTIFY` channel (`pg_notify`) has a hard limit of 8000 bytes. When the golden fixture's 490 nodes and 888 edges emitted an initial `graph.updated` diff, the serialized payload exceeded 8000 bytes, triggering `payload string too long` on commit.
   - *Fix*: Added migration `0016_event_notify_payload_truncation.sql` updating `fluxora_notify_event()`. If the payload exceeds 7500 bytes, PostgreSQL sends a truncated notification summary `{ "truncated": true, "eventId": ... }` over `pg_notify`, while preserving the full un-truncated payload in the durable `events` table for workers/API to read.

---

## Verification Summary

All verification gates pass cleanly:
- `node --experimental-strip-types --test apps/workers/src/pipeline/golden-graph.test.ts`: 8/8 subtests pass (16.9s).
- `pnpm --filter @fluxora/workers test`: 252 tests pass, 0 fail.
- `pnpm --filter @fluxora/db test`: 67 tests pass, 0 fail.
- `pnpm --filter @fluxora/api test`: 65 tests pass, 0 fail.
- `pnpm typecheck`: Clean compilation across all 7 workspace projects.
- `pnpm lint`: 0 ESLint warnings/errors.
- `pnpm lint:evidence`: Static AST lint passed (all graph writes invoke `EvidenceWriter`).
- `pnpm build`: Next.js Turbopack and monorepo build succeeded.
- `git diff --check`: Passed with 0 whitespace issues.

