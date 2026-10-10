# Phase 4 Step 27: Graph Storage — GraphNode, GraphEdge, and Evidence Persistence

## Overview

Step 27 creates the relational database persistence layer for Fluxora's code knowledge graph. It introduces four primary relational entities:

1. **`AnalysisRun` (`analysis_runs`)**: The execution scope for a complete graph analysis performed against a specific `RepositorySnapshot`.
2. **`GraphNode` (`graph_nodes`)**: The canonical entity representing code elements (modules, symbols, functions, routes, databases, services).
3. **`GraphEdge` (`graph_edges`)**: Directed relations connecting two `GraphNode` instances within the same `AnalysisRun`.
4. **`Evidence` (`evidence`)**: The provenance records tracking the exact source locations (file path, line range, column range, symbol ID) and explanations for why a node or edge exists.

This step is strictly **storage only**. It does not construct graphs, traverse nodes, run queries, or process ASTs.

---

## Architecture & Concepts

### 1. Separation of Persistence and Graph Building

In Fluxora, graph construction (Step 28) and graph storage (Step 27) are decoupled by design:
- **Persistence Layer (Step 27)** provides deterministic relational schema, foreign key constraints, uniqueness rules, composite indexes, and strict multi-tenant Row Level Security (RLS).
- **Graph Builder (Step 28)** ingests normalized Phase 3 analysis outputs, constructs nodes/edges, and performs batch writes to this storage layer.

Decoupling ensures storage invariants (tenant isolation, referential integrity, unique canonical IDs) are enforced at the database layer regardless of builder implementation.

### 2. Tenancy & Row-Level Security (RLS)

Graph data is tenant-isolated using PostgreSQL Row-Level Security:
- `analysis_runs` policy checks `fluxora_snapshot_in_current_tenant(snapshot_id)`, traversing `repository_snapshots -> repositories -> organization_id`.
- `graph_nodes`, `graph_edges`, and `evidence` policies evaluate `fluxora_analysis_run_in_current_tenant(analysis_run_id)` with `SECURITY DEFINER` helpers.
- All RLS policies check `r.organization_id = fluxora_current_org_id()`.
- Cross-tenant reads, inserts, updates, and deletes are denied at the database layer.

### 3. Analysis & Repository Scope

Graph records are bound to an `AnalysisRun` (`analysis_run_id`), which belongs to a `RepositorySnapshot` (`snapshot_id`).
- Graph nodes and edges cannot escape their analysis scope or tenant scope.
- Composite foreign keys `FOREIGN KEY (source_node_id, analysis_run_id) REFERENCES graph_nodes (id, analysis_run_id)` ensure edges cannot connect nodes belonging to different analysis runs or different tenants.

### 4. Foreign Keys & Structural Constraints

- `graph_nodes.analysis_run_id` -> `analysis_runs.id` ON DELETE CASCADE
- `graph_edges.analysis_run_id` -> `analysis_runs.id` ON DELETE CASCADE
- `graph_edges.(source_node_id, analysis_run_id)` -> `graph_nodes.(id, analysis_run_id)` ON DELETE CASCADE
- `graph_edges.(target_node_id, analysis_run_id)` -> `graph_nodes.(id, analysis_run_id)` ON DELETE CASCADE
- `evidence.analysis_run_id` -> `analysis_runs.id` ON DELETE CASCADE

### 5. Uniqueness & Deduplication

- `graph_nodes`: `UNIQUE (analysis_run_id, canonical_id)` prevents duplicate canonical nodes per run.
- `graph_edges`: `UNIQUE (analysis_run_id, source_node_id, target_node_id, edge_type)` prevents duplicate edges of the same type between identical nodes within a run.

### 6. Indexing Strategy

Targeted indexes support Step 28-33 query patterns:
- `graph_nodes (analysis_run_id, node_type)` for filtering nodes by type.
- `graph_edges (source_node_id, edge_type)` for outbound edge traversal.
- `graph_edges (target_node_id, edge_type)` for inbound edge traversal / blast-radius analysis.
- `evidence (analysis_run_id, subject_type, subject_id)` for quick provenance lookups.

---

## Implementation Summary

### Files Created
- `packages/db/migrations/0014_graph_storage.sql`
- `packages/shared-types/src/graph.ts`
- `packages/db/src/repositories/graph.ts`
- `packages/db/src/repositories/graph-storage.test.ts`
- `learning/implementations/phase-04/step-27-graph-storage.md`
- `learning/notes/26. Graph Storage — GraphNode, GraphEdge, and Evidence persistence.md`
- `learning/interviews/27. Step 27 Graph Storage Interview CheatSheet.md`

### Files Modified
- `packages/shared-types/src/index.ts`
- `packages/db/src/index.ts`
- `docs/DESIGN.md`

---

## What Step 27 Deliberately Does NOT Do

- Does not construct graph nodes or edges from Phase 3 AST outputs (Step 28).
- Does not execute recursive graph traversal CTEs (Step 29).
- Does not expose graph query API endpoints (Step 30).
- Does not generate graph diffs across snapshots (Step 31).
- Does not publish `graph.updated` WebSocket events (Step 32).
- Does not process AI explanations or speculative summaries.

