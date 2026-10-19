# Step 48 — Evidence Completeness Audit + Hardening

## 1. Executive Summary & Step Objectives

Global Step 48 initiates **Phase 7: Evidence Engine (Hardening Pass)** of the Fluxora Engineering Roadmap (`docs/architecture/17-implementation-roadmap.md`, Phase 7, Step 1). 

The primary objective of Step 48 is to audit every conclusion-producing write path in the Fluxora platform and guarantee **Evidence Completeness**:
> **Core Invariant**: Every confirmed graph conclusion (node, edge) and impact finding produced by the system MUST have corresponding immutable, traceable provenance persisted via `EvidenceWriter` in the same atomic database transaction.

No code path may persist or expose a conclusion without an associated evidence record. Furthermore, this step hardens both static AST linting (`pnpm lint:evidence`) and dynamic PostgreSQL verification to guarantee that:
1. All graph edge types (`IMPORTS`, `CALLS`, `EXTENDS`, `EXPOSES_ROUTE`, `EMITS_EVENT`, `CONSUMES_EVENT`, `QUERIES_DB`, `WRITES`) produce traceable evidence linking source nodes, target nodes, file paths, and symbol locations.
2. All impact finding classifications (`directImpact`, `downstreamImpact`, `affectedApis`, `affectedEvents`, `affectedServices`) receive deterministic `impact_finding` evidence records.
3. Decayed confidence scores calculated during traversal are faithfully mirrored into evidence without artificial resets to `1.0`.
4. Transactional atomicity is enforced: any evidence persistence failure triggers a full rollback of the conclusion.
5. Deterministic evidence ID derivation guarantees 100% idempotency across re-runs while maintaining strict isolation across tenants and analysis runs.

This audit preserves all architectural invariants: the deterministic core is strictly unpolluted by LLM or probabilistic heuristics, and future Phase 7 capabilities (Step 49 clickable `EvidenceCitation` UI, Step 50 confidence-based visual weighting, Step 51 analysis coverage UI) remain strictly out of scope.

---

## 2. Comprehensive Audit Inventory

An exhaustive code audit was conducted across all conclusion-producing paths in Fluxora:

### A. Graph Construction & Storage Writes (`packages/db`, `apps/workers`)
| Code Path / Function | File Location | Write Operation | Audit Assessment |
| --- | --- | --- | --- |
| `persistGraphBuild` | `packages/db/src/repositories/graph.ts` | Batch insert `graph_nodes`, `graph_edges`, `evidence` | Audited: Atomic single-transaction write. Hardened to validate that all nodes, edges, and evidence strictly match `input.organizationId` and `input.analysisRunId`. |
| `batchCreateGraphNodes` | `packages/db/src/repositories/graph.ts` | Direct `graph_nodes` batch insertion | Audited: Internal helper called exclusively within `persistGraphBuild`. Covered by static linter. |
| `batchCreateGraphEdges` | `packages/db/src/repositories/graph.ts` | Direct `graph_edges` batch insertion | Audited: Internal helper called exclusively within `persistGraphBuild`. Covered by static linter. |
| `GraphBuilder.buildAndPersist` | `apps/workers/src/builder/graph-builder.ts` | Projection from normalized intelligence to graph | Audited: Calls `persistGraphBuild` with complete node and edge evidence generated via `EvidenceWriter.createNodeEvidence` and `EvidenceWriter.createEdgeEvidence`. |

### B. Impact Analysis Persistence & Orchestration (`packages/db`, `apps/workers`)
| Code Path / Function | File Location | Write Operation | Audit Assessment |
| --- | --- | --- | --- |
| `saveImpactAnalysisTx` | `packages/db/src/repositories/impact-analysis.ts` | Upsert `impact_analyses` + batch insert `evidence` | **Audit Finding & Gap Closed**: `directImpact` and `downstreamImpact` previously generated evidence, but `affectedApis`, `affectedEvents`, and `affectedServices` were stored with empty `evidenceIds`. Remediated to unify all 5 finding categories under `processFinding`, updating `evidenceIds` across all lists with deduplicated evidence rows. |
| `saveImpactAnalysis` | `packages/db/src/repositories/impact-analysis.ts` | Transaction wrapper for `saveImpactAnalysisTx` | Audited: Manages client acquisition and transaction boundaries. |
| `persistPullRequestImpactAnalysis` | `packages/db/src/repositories/impact-analysis.ts` | Engine execution + persistence | Audited: Calls Step 43 engine and delegates to `saveImpactAnalysisTx`. |
| `processPullRequestImpactJob` | `apps/workers/src/pull-request/impact-handler.ts` | Worker async job handler | Audited: Calls `persistPullRequestImpactAnalysis` within worker harness. |

### C. Static AST Evidence Linter (`packages/db`, `scripts/`)
| Component | File Location | Scan Capability | Audit Assessment |
| --- | --- | --- | --- |
| `verifyGraphWritePaths` | `packages/db/src/repositories/evidence-lint.ts` | TypeScript AST analysis | **Audit Finding & Gap Closed**: Previously only checked for `INSERT INTO graph_edges` and `batchCreateGraphEdges` in graph-related files. Hardened to scan all conclusion-producing files (`graph.ts`, `impact-analysis.ts`, `graph-builder.ts`, `impact-handler.ts`) for both graph writes and impact analysis writes (`saveImpactAnalysis`, `saveImpactAnalysisTx`, `persistPullRequestImpactAnalysis`), verifying that `EvidenceWriter` is invoked. Added automatic workspace root resolution. |
| CLI Runner | `scripts/evidence-lint.ts` | Standalone CI script | Audited: Executable via `pnpm lint:evidence`. |

---

## 3. Complete Invariant Proof Matrix

| Invariant # | Architectural Requirement | Enforcement Mechanism | Proof / Test Reference |
| --- | --- | --- | --- |
| **Inv-1** | Every GraphEdge must produce an Evidence row | `persistGraphBuild` + `EvidenceWriter.createEdgeEvidence` | `packages/db/src/repositories/evidence-audit.test.ts` (Test B1: all 8 edge types) |
| **Inv-2** | Every ImpactFinding must produce an Evidence row | `saveImpactAnalysisTx` + `EvidenceWriter.createImpactFindingEvidence` | `packages/db/src/repositories/evidence-audit.test.ts` (Test B2: 5 finding categories) |
| **Inv-3** | Decayed confidence must be preserved in Evidence | Depth-decayed confidence passed directly to evidence input | `packages/db/src/repositories/evidence-audit.test.ts` (Test B3: monotonic decay, no reset) |
| **Inv-4** | Transactional Atomicity (No orphan conclusions) | All writes execute within `BEGIN ... COMMIT` in same client; error triggers `ROLLBACK` | `packages/db/src/repositories/evidence-audit.test.ts` (Test B4: simulated error rolls back conclusion) |
| **Inv-5** | Deterministic Evidence IDs & Idempotency | Canonical UUID derived via SHA-256 hash of stable conclusion tuple | `packages/db/src/repositories/evidence-audit.test.ts` (Test B5: re-run creates 0 duplicates) |
| **Inv-6** | Analysis-Run Isolation | Evidence strictly partitioned by `analysis_run_id` | `packages/db/src/repositories/evidence-audit.test.ts` (Test B6: distinct runs produce distinct evidence) |
| **Inv-7** | Multi-Tenant RLS Enforcement | Tenant RLS policies on `evidence` and `impact_analyses` | `packages/db/src/repositories/evidence-audit.test.ts` (Test B7: non-member tenant isolated) |
| **Inv-8** | CI Static AST Verification | `pnpm lint:evidence` AST check | `packages/db/src/repositories/evidence-audit.test.ts` (Test A1–A4) & `scripts/evidence-lint.ts` |

---

## 4. Gaps Discovered & Remediations Applied

### Gap 1: Incomplete Impact Finding Evidence Linking in Specialized Categories
- **Discovery**: In `packages/db/src/repositories/impact-analysis.ts`, while `directImpact` and `downstreamImpact` had evidence records constructed and their `evidenceIds` updated, the specialized categorized views (`affectedApis`, `affectedEvents`, and `affectedServices`) were persisted using the raw findings without updating their `evidenceIds` array with the newly generated `impact_finding` evidence ID.
- **Remediation**: Re-architected finding processing in `saveImpactAnalysisTx` using a unified `processFinding` helper. When a node appears in multiple lists (e.g. an API route handler is in both `downstreamImpact` and `affectedApis`), a single deterministic evidence input is created, and the derived evidence ID is populated across all relevant finding arrays.

### Gap 2: Static Evidence Linter Scope Was Limited to Graph Edges
- **Discovery**: The AST linter in `packages/db/src/repositories/evidence-lint.ts` checked only for graph edge write operations (`INSERT INTO graph_edges`, `batchCreateGraphEdges`) in a fixed set of graph files. It lacked awareness of graph node writes and impact analysis writes (`saveImpactAnalysis`, `saveImpactAnalysisTx`, `persistPullRequestImpactAnalysis`), allowing an impact write path to theoretically bypass evidence generation undetected.
- **Remediation**: Extended `verifyGraphWritePaths` to recognize:
  1. Graph Node Writes: `INSERT INTO graph_nodes`, `createGraphNode`, `batchCreateGraphNodes`.
  2. Graph Edge Writes: `INSERT INTO graph_edges`, `createGraphEdge`, `batchCreateGraphEdges`.
  3. Impact Analysis Writes: `INSERT INTO impact_analyses`, `saveImpactAnalysis`, `saveImpactAnalysisTx`, `persistPullRequestImpactAnalysis`.
  The linter ensures that any file containing these write operations imports and invokes `EvidenceWriter`.

### Gap 3: Static Linter Path Resolution Sensitivity
- **Discovery**: When running `verifyGraphWritePaths` from subdirectories or during testing without setting `process.cwd()` to the root, relative file resolution could fail.
- **Remediation**: Implemented `findWorkspaceRoot(startDir)` in `packages/db/src/repositories/evidence-lint.ts`, searching upwards for `pnpm-workspace.yaml` to ensure reliable AST inspection regardless of working directory.

### Gap 4: Cross-Run and Cross-Tenant Validation in Graph Builder
- **Discovery**: `persistGraphBuild` did not explicitly validate that every incoming node, edge, and evidence item had `analysisRunId` and `organizationId` matching the batch payload header.
- **Remediation**: Added strict validation in `packages/db/src/repositories/graph.ts` ensuring all elements match `input.organizationId` and `input.analysisRunId`, throwing a descriptive `Error` immediately before transaction execution if a mismatch is detected.

---

## 5. Evidence Writer Static AST Linter Hardening

The AST linter (`packages/db/src/repositories/evidence-lint.ts`) enforces the Evidence Writer invariant statically during CI (`pnpm lint:evidence`).

### Scanned Target Files:
1. `packages/db/src/repositories/graph.ts` (Graph storage & batch creation)
2. `packages/db/src/repositories/impact-analysis.ts` (Impact analysis persistence)
3. `apps/workers/src/builder/graph-builder.ts` (Worker graph builder projection)
4. `apps/workers/src/pull-request/impact-handler.ts` (Worker impact job handler)

### Target AST Patterns Detected:
```typescript
const CONCLUSION_WRITE_PATTERNS = [
  /INSERT\s+INTO\s+graph_edges/i,
  /INSERT\s+INTO\s+graph_nodes/i,
  /INSERT\s+INTO\s+impact_analyses/i,
  /\bcreateGraphEdge\b/,
  /\bbatchCreateGraphEdges\b/,
  /\bcreateGraphNode\b/,
  /\bbatchCreateGraphNodes\b/,
  /\bsaveImpactAnalysis\b/,
  /\bsaveImpactAnalysisTx\b/,
  /\bpersistPullRequestImpactAnalysis\b/,
];
```

If any file contains any of the above conclusion write patterns, the AST is traversed to ensure:
1. An import declaration references `EvidenceWriter` (or local file definition).
2. At least one CallExpression invokes an `EvidenceWriter` method (`createNodeEvidence`, `createEdgeEvidence`, `createEvidenceInput`, `createImpactFindingEvidence`, `batchCreateEvidence`).

---

## 6. Graph Edge Evidence Guarantee & Propagation

Every graph edge conclusion represents a discovered structural dependency. During `persistGraphBuild`, each edge is verified to have an accompanying evidence row.

### Supported Edge Types Validated:
1. `IMPORTS`: Module-to-module static ES / CommonJS imports.
2. `CALLS`: Function/method invocations between symbols.
3. `EXTENDS`: Class/interface inheritance.
4. `EXPOSES_ROUTE`: Next.js App Router / Express route handler endpoints.
5. `EMITS_EVENT`: Message producer / EventEmitter publish points.
6. `CONSUMES_EVENT`: Message consumer / EventEmitter subscribe points.
7. `QUERIES_DB`: Database table read references (e.g. Prisma, SQL queries).
8. `WRITES`: Database table mutation references (e.g. INSERT, UPDATE).

### Provenance Mapping:
- `subject_type`: `"graph_edge"`
- `subject_id`: Edge UUID (deterministic)
- `file_path`: Source file containing the relationship
- `symbol_id`: Source symbol canonical ID (e.g. `sym:src/core.ts#fn`)
- `line_start` / `line_end`: Source coordinate bounding the reference
- `confidence`: Edge confidence (e.g. `0.95` for static analysis, `0.70` for heuristic fallback)

---

## 7. Impact Finding Evidence Across All Classifications

Impact findings represent change-impact blast-radius conclusions. To ensure explainability without fabricating source locations, `saveImpactAnalysisTx` links every finding to an immutable `impact_finding` evidence row.

### Finding Classifications Audited:
1. `directImpact`: Nodes directly connected to changed diff seeds (Depth 1).
2. `downstreamImpact`: Multi-hop reachable dependencies (Depth 2+).
3. `affectedApis`: Reachable API route handlers.
4. `affectedEvents`: Reachable event schemas or publishers.
5. `affectedServices`: Reachable services or packages.

### Non-Fabrication Rule:
- For direct symbol changes, exact file path and line coordinates from AST analysis are preserved.
- For downstream nodes reachable only via traversal, the evidence records the node's declared location (if known) or path context, and metadata records `traversalPath: finding.path`. Line coordinates are never fabricated.

---

## 8. Confidence Decay Preservation Invariant

During graph traversal in Step 43, confidence decays exponentially with traversal depth according to the formula:
$$\text{confidence}(d) = \text{base\_confidence} \times (\text{decay\_factor})^d$$
With `base_confidence = 1.0` and `decay_factor = 0.9`:
- Depth 1 (Direct Impact): $1.0 \times 0.9^1 = 0.90$
- Depth 2 (Downstream Hop 1): $1.0 \times 0.9^2 = 0.81$
- Depth 3 (Downstream Hop 2): $1.0 \times 0.9^3 = 0.729$

### Audit Assertion:
When findings are persisted into `impact_analyses` and their evidence records are written via `EvidenceWriter.createImpactFindingEvidence`:
- Evidence rows MUST store the exact decayed confidence (e.g. `0.81`, `0.729`).
- Evidence confidence must NEVER be reset to `1.0` or rounded prematurely.
- Monotonic decay is strictly verified: $\text{conf}(d_1) > \text{conf}(d_2) > \text{conf}(d_3)$.

---

## 9. Atomicity & Transaction Rollback Proofs

Graph and impact conclusions must never exist as orphaned records without evidence.

### Architectural Invariant:
```sql
BEGIN;
  -- 1. Insert Graph Edges / Impact Analysis
  INSERT INTO impact_analyses (...) VALUES (...);
  -- 2. Insert Evidence
  INSERT INTO evidence (...) VALUES (...);
COMMIT;
```

### Verification Proof (Test B4):
1. An impact analysis save operation was initiated with an invalid evidence record (violating foreign key / type constraints).
2. The transaction aborted with an error.
3. Database queries confirmed that neither the `impact_analyses` record nor any partial `evidence` records were committed.

---

## 10. Deterministic ID Derivation & Idempotent Re-runs

In distributed worker environments, network retries or duplicate webhook deliveries must not corrupt evidence history or generate duplicate records.

### Deterministic ID Formula:
```typescript
// For Graph Nodes:
const nodeId = generateDeterministicUuid(`${analysisRunId}:node:${canonicalId}`);

// For Graph Edges:
const edgeId = generateDeterministicUuid(`${analysisRunId}:edge:${sourceCanonicalId}->${targetCanonicalId}:${edgeType}`);

// For Impact Finding Evidence:
const evidenceId = generateDeterministicUuid(
  `${analysisRunId}:impact_finding:${finding.node.id}:${finding.node.filePath ?? ""}:${finding.path.join("->")}`
);
```

### Idempotency Behavior:
- Inserting an identical impact analysis or graph build executes `ON CONFLICT (id) DO UPDATE` or `ON CONFLICT (id) DO NOTHING`.
- Repeated executions result in exactly the same evidence IDs and zero duplicate rows.

---

## 11. Tenant & Analysis-Run Boundary Isolation

Fluxora enforces multi-tenant security and analysis-run immutability via PostgreSQL Row-Level Security (RLS) policies.

### Analysis-Run Isolation:
- An analysis run represents an immutable point-in-time snapshot.
- When a new run is executed for the same repository, evidence records are created with the new `analysis_run_id`.
- Queries filtering by Run A cannot observe or contaminate evidence from Run B.

### Multi-Tenant Isolation:
- All tables (`graph_nodes`, `graph_edges`, `evidence`, `impact_analyses`) include `organization_id`.
- Tenant context is set via `SET LOCAL app.current_organization_id = '<uuid>'`.
- Non-member tenants receive empty arrays / zero rows when querying another tenant's conclusions or evidence.

---

## 12. Future Obligation: Simulation & Probabilistic Bounds

Step 48 deliberately audits only **current** conclusion-producing write paths.

### Documented Future Obligations:
1. **Simulation Engine (Global Step 8 / Step 10)**:
   - When what-if architectural simulations are implemented, simulated node mutations and speculative edges will constitute new conclusions.
   - Simulation results must define a distinct `subject_type` (e.g. `"simulation_result"`, `"simulated_edge"`).
   - Speculative conclusions must link to the base evidence from which the scenario was projected, maintaining clear separation between confirmed factual code truth and speculative simulation hypotheses.
2. **AI Explanation Layer**:
   - Probabilistic LLM outputs must cite immutable evidence IDs returned by Step 48. The LLM must never synthesize or infer structural truth.

---

## 13. Test Suite Architecture & Verification Matrix

A dedicated test suite `packages/db/src/repositories/evidence-audit.test.ts` was implemented to provide comprehensive integration and invariant verification.

### Test Matrix Breakdown:
- **Section A: Static Evidence Lint Hardening**
  - `A1. Static linter flags graph edge writes without EvidenceWriter` (PASSED)
  - `A2. Static linter flags impact analysis writes without EvidenceWriter` (PASSED)
  - `A3. Static linter accepts files properly pairing conclusion writes with EvidenceWriter` (PASSED)
  - `A4. CI lint check passes for all configured conclusion-producing target files` (PASSED)
- **Section B: Database Integration & Invariant Verification**
  - `B1. Graph evidence completeness: all supported edge types produce traceable evidence` (PASSED)
  - `B2. Impact finding evidence completeness: direct, downstream, affected APIs/events/services receive evidence` (PASSED)
  - `B3. Confidence propagation: depth-decayed confidence is preserved in evidence rows without reset` (PASSED)
  - `B4. Atomic transaction guarantee: failure in evidence write rolls back conclusion` (PASSED)
  - `B5. Deterministic evidence identity & idempotency: repeated execution creates zero duplicates` (PASSED)
  - `B6. Analysis-run isolation: distinct runs produce isolated, non-colliding evidence` (PASSED)
  - `B7. Tenant boundary: RLS prevents cross-tenant evidence leakage` (PASSED)

---

## 14. Verification Command Outputs

All workspace verification commands executed cleanly with 0 errors:

### 1. Evidence Lint (`pnpm lint:evidence`):
```text
🔍 Running Step 48 Evidence Completeness CI Lint...
Scanned 4 conclusion-producing target file(s).
✅ Evidence Lint PASSED: All graph and impact conclusion write paths invoke EvidenceWriter.
Exit code: 0
```

### 2. Monorepo ESLint (`pnpm lint`):
```text
> fluxora@0.0.0 lint C:\Users\HP\Desktop\Projects\fluxora
> eslint .
Exit code: 0
```

### 3. Monorepo Typecheck (`pnpm typecheck`):
```text
Scope: 7 of 8 workspace projects
packages/shared-types typecheck: Done
packages/observability typecheck: Done
packages/infrastructure typecheck: Done
packages/db typecheck: Done
apps/web typecheck: Done
apps/api typecheck: Done
apps/workers typecheck: Done
Exit code: 0
```

### 4. Monorepo Production Build (`pnpm build`):
```text
Scope: 7 of 8 workspace projects
apps/web build: Compiled successfully in 18.2s
apps/web build: Generating static pages using 3 workers (5/5) in 2.2s
apps/web build: Done
Exit code: 0
```

### 5. Monorepo Test Execution (`pnpm test`):
```text
packages/infrastructure: 7 passed (1 file)
packages/db: 134 passed | 5 skipped (14 files) — including 11 evidence-audit tests
apps/web: 132 passed (11 files)
apps/api: 123 passed (11 files)
apps/workers: 295 passed | 4 skipped (21 files) — including golden PR impact & golden graph
Total: 691 passed, 9 skipped, 0 failed.
Exit code: 0
```

---

## 15. Architectural Coherence & Definition of Done

Global Step 48 fulfills all acceptance criteria set forth in `docs/architecture/22-definition-of-done.md` and `docs/architecture/17-implementation-roadmap.md`:
- **Deterministic Core Preserved**: Every conclusion is mathematically grounded and backed by verifiable code provenance.
- **Evidence Completeness**: 100% of graph edge and impact finding conclusion paths are verified to write evidence.
- **Static & Dynamic Invariant Enforcement**: Guarded by both AST linting in CI and PostgreSQL transaction integration tests.
- **Strict Scope Boundaries**: Zero unrequested features; Steps 49–51 and simulation systems remain cleanly separated for upcoming roadmap phases.

