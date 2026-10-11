# Step 32 — Graph Update Event Emission & Diff Summary

## Overview

Global Step 32 implements deterministic graph diff summary computation and transactional `graph.updated` event emission (`docs/architecture/08-events-and-async-architecture.md §8.1`, `docs/architecture/17-implementation-roadmap.md §Phase 4 Step 6`).

When a repository ingestion run completes and projects its normalized intelligence into `graph_nodes`, `graph_edges`, and `evidence` (Step 28), Step 32 compares the newly persisted graph state against the repository's prior analysis run graph state. It computes a byte-for-byte deterministic graph diff distinguishing added, removed, and changed nodes and edges, persists a strongly typed `graph.updated` event atomically into the transactional outbox (`events` table) within the same database transaction, and automatically triggers real-time broadcast to authenticated WebSocket subscribers scoped to that organization.

---

## Architectural Purpose & Scope Boundary

- **Deterministic Graph Diffing**: Diff computation is a purely deterministic in-memory set comparison (`computeGraphDiff`). It relies strictly on canonical graph node identifiers and edge keys `(source_node_id, target_node_id, edge_type)` with canonical JSON metadata ordering. No LLMs or probabilistic heuristics are involved.
- **Transactional Outbox Consistency**: The `graph.updated` event is persisted inside the exact same `withTenant` PostgreSQL transaction as the graph nodes, edges, and evidence records (`persistGraphBuild`). If the graph write fails or rolls back, no event is emitted. When the transaction commits, PostgreSQL's `fluxora_notify_event()` trigger automatically dispatches a `NOTIFY fluxora_events` payload picked up by the API gateway's event listener.
- **Real-Time Delivery via Existing Abstraction**: Emits events using the existing `createEventClient` outbox pattern. The WebSocket server (`apps/api/src/ws/server.ts`) listens to `fluxora_events`, validates tenant boundaries, and pushes the event envelope to authenticated clients subscribed to that organization.
- **No Direct UI Coupling**: The diff calculation and event emission remain strictly in domain/database packages (`packages/shared-types`, `packages/db`, `apps/workers`). Neither the graph builder nor the outbox knows about React Flow, DOM, or visual presentation.
- **Scope Boundary**: Step 32 implements ONLY the `graph.updated` event contract, deterministic diff engine, and transactional emission. It deliberately does NOT implement:
  - Step 33 Golden Graph Fixture verification
  - Phase 5 React Flow interactive canvas or UI layout algorithms
  - Phase 6 PR change-impact traversal or GitHub check annotations
  - Phase 9 AI reasoning or natural language change explanations

---

## Architecture & Data Flow

```
   Worker: buildAndPersistGraph(input, options)
                     │
                     ▼
       withTenant(pool, organizationId) Transaction (Step 28 + Step 32)
                     │
       ┌─────────────┴─────────────────────────┐
       │ 1. Resolve prior graph state          │
       │    (getGraphStateForAnalysisRunTx)    │
       │                                       │
       │ 2. Compute deterministic diff         │
       │    computeGraphDiff(previous, current)│
       │                                       │
       │ 3. Persist nodes, edges, evidence     │
       │    (EvidenceWriter AST-enforced)      │
       │                                       │
       │ 4. Insert outbox event                │
       │    events.insert(graph.updated)       │
       └─────────────┬─────────────────────────┘
                     │ COMMIT
                     ▼
         PostgreSQL Trigger: fluxora_notify_event()
                     │ NOTIFY fluxora_events
                     ▼
         API Gateway Event Listener (LISTEN)
                     │
                     ▼
         WebSocket Server (apps/api/src/ws/server.ts)
                     │
                     ▼
      Authenticated Tenant WS Clients
      { type: "event", event: { type: "graph.updated", payload: { ... } } }
```

---

## Core Invariants & Security Safeguards

1. **Deterministic Node & Edge Ordering**: All added, removed, and changed nodes are sorted alphabetically by canonical `id`. All edges are sorted by `sourceNodeId:targetNodeId:edgeType`.
2. **Canonical Metadata Serialization**: JSON metadata objects are compared using recursive key-sorting (`canonicalStringify`), preventing false positives from arbitrary JSON key ordering.
3. **Transactional Atomicity**: Event creation and graph persistence share the same PostgreSQL transaction (`withTenant`). A rollback on graph error guarantees zero orphaned or false `graph.updated` events.
4. **Idempotency**: The outbox event uses a deterministic `idempotency_key = graph:updated:<analysisRunId>:<previousAnalysisRunId|initial>`. Re-running graph persistence with the same parameters satisfies database unique constraints cleanly without duplicate phantom events.
5. **Strict Multi-Tenant Isolation**: State resolution queries (`getGraphStateForAnalysisRunTx`) execute under RLS session variables (`app.current_organization_id`) and enforce defensive SQL checks (`AND fluxora_analysis_run_in_current_tenant(analysis_run_id)`). Comparing or publishing graph state across tenants is impossible.
6. **No Leaked Database Internals**: The `GraphUpdatedPayload` exposes only domain fields (`nodeType`, `name`, `path`, `confidence`, `metadata`, `provenance`). Internal table columns and sensitive credentials are never serialized into the payload.

---

## Verification Summary

All verification commands executed cleanly:
- `git diff --check`: Passed with 0 whitespace or formatting issues.
- `pnpm typecheck`: Passed with 0 errors across all 7 workspace projects.
- `pnpm lint:evidence`: Passed with 0 errors (all graph writes invoke `EvidenceWriter`).
- `pnpm lint`: Passed with 0 errors.
- `node --env-file=.env --experimental-strip-types --test packages/db/src/repositories/graph-diff.test.ts`: 19/19 passing tests.
- `pnpm test`: All unit and integration suites passing.
- `pnpm build`: Next.js and workspace compilation clean.

