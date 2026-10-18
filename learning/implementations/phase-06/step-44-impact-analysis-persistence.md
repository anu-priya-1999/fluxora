# Step 44 — ImpactAnalysis Persistence + Evidence

## Objective & Role in Roadmap

Global Step 44 implements durable, multi-tenant persistence for the deterministic change-impact results computed by the Step 43 Impact Analysis Engine, and integrates `EvidenceWriter` to generate first-class `impact_finding` evidence records.

This fulfills **Global Step 44** of **Phase 6: PR Impact Analysis** as defined by `docs/architecture/17-implementation-roadmap.md`, `docs/architecture/05-component-responsibilities.md §5.8 and §5.9`, and `docs/architecture/06-database-schema.md §6.3`.

---

## Exact Scope & Boundaries

### Modified Files:
- `packages/shared-types/src/impact.ts`: Domain models for persisted impact analysis (`ImpactAnalysisStatus`, `ImpactAnalysisStatuses`, `ImpactAnalysis`, `SaveImpactAnalysisInput`, `SaveImpactAnalysisResult`, `PersistPullRequestImpactAnalysisOptions`, `PersistImpactAnalysisResult`).
- `packages/db/src/repositories/evidence-writer.ts`: Extended `EvidenceWriter` with `createImpactFindingEvidence` for creating structured `impact_finding` evidence records with deterministic primary keys.
- `packages/db/src/repositories/evidence-lint.ts`: Updated `usesEvidenceWriter` check to recognize `createImpactFindingEvidence`.
- `packages/db/src/index.ts`: Re-exported all Step 44 impact analysis persistence repositories, mappers, and error classes.
- `docs/DESIGN.md`: Documented Global Step 44 data model, architecture, invariants, and scope boundaries.

### Created Files:
- `packages/db/migrations/0018_impact_analyses_storage.sql`: Forward-only migration provisioning `impact_analyses` table, indexes, and PostgreSQL Row-Level Security (RLS) policies.
- `packages/db/src/repositories/impact-analysis.ts`: Core repository methods (`saveImpactAnalysis`, `saveImpactAnalysisTx`, `persistPullRequestImpactAnalysis`, `getImpactAnalysisById`, `getLatestImpactAnalysisForPullRequest`, `listImpactAnalysesForPullRequest`, `listImpactFindingEvidence`) with tenant scoping.
- `packages/db/src/repositories/impact-analysis.test.ts`: Complete unit and PostgreSQL integration test suite covering persistence, idempotency, evidence linking, query ordering, empty PRs, truncation, and cross-tenant RLS isolation.

### Strict Scope Boundary Against Steps 45–47:
- Step 44 does **NOT**:
  - Expose impact analysis HTTP REST endpoints in `apps/api` (Step 45 owns `POST /pull-requests/:id/analyze-impact` and `GET /impact-analyses/:id`);
  - Modify the frontend or create the GraphCanvas change-mode overlay in `apps/web` (Step 46 owns this);
  - Run golden-fixture PR impact validation (Step 47 owns this);
  - Add AI/LLM narrative explanations (Step 48+).

---

## Persistence Pipeline & Conceptual Flow

```
PullRequest (PR metadata + changed files + diffs from Step 42)
                    │
                    ▼
Step 43 Impact Analysis Engine (`analyzePullRequestImpact` / `computeImpactAnalysis`)
                    │
                    ▼
Deterministic ImpactAnalysisResult (direct/downstream findings, taxonomy, decay, truncation)
                    │
                    ▼
Step 44 Persistence Orchestration (`persistPullRequestImpactAnalysis` / `saveImpactAnalysis`)
   ├─ 1. Multi-Tenant Validation & Scoping (RLS verification via `withTenant`)
   ├─ 2. Evidence Derivation (`EvidenceWriter.createImpactFindingEvidence`)
   │     ├─ subject_type: 'impact_finding'
   │     ├─ subject_id: finding.node.id
   │     ├─ Deterministic evidence ID derivation via SHA-256
   │     └─ Metadata: impactAnalysisId, pullRequestId, depth, propagation path, supporting evidence
   ├─ 3. Finding Evidence Linkage (evidenceIds populated on each ImpactFinding)
   ├─ 4. Atomic PostgreSQL Transaction
   │     ├─ INSERT INTO impact_analyses ... ON CONFLICT (id) DO UPDATE ...
   │     └─ EvidenceWriter.writeEvidenceBatchTx(client, evidenceRecords)
   │
   ▼
Committed ImpactAnalysis row + durable impact_finding Evidence records
```

---

## Database Architecture & Invariants

### 1. Data Schema (`impact_analyses`)
- `id`: UUID primary key, defaulting to `gen_random_uuid()` or caller-supplied for deterministic replay.
- `pull_request_id`: UUID foreign key to `pull_requests(id)` with cascade deletion.
- `analysis_run_id`: UUID foreign key to `analysis_runs(id)` with cascade deletion.
- `status`: String restricted to `pending`, `running`, `completed`, `failed`.
- `direct_impact`: JSONB array of direct findings (`depth === 1`).
- `downstream_impact`: JSONB array of transitive findings (`depth >= 2`).
- `affected_apis`, `affected_events`, `affected_services`: Filtered taxonomy projections.
- `workflow_impact_summary`: String summary list of affected routes, events, and services.
- `unresolved_files`: List of files that could not be mapped to graph nodes.
- `truncated`: Boolean indicating whether bounded traversal was truncated at `maxDepth`.
- `truncation_reason`: Human-readable explanation when truncation occurs.
- `max_depth_reached`: Integer representing maximum hop distance reached.
- `execution_metrics`: Ingestion and traversal metrics (durations, nodes visited, edges explored).
- `metadata`: Extensible JSONB payload.
- `created_at`: Immutable timestamp.

### 2. Indexes & Performance
- `(pull_request_id)`: Quick retrieval of all analyses for a pull request.
- `(analysis_run_id)`: Join optimization with snapshot analysis runs.
- `(pull_request_id, created_at DESC)`: Rapid selection of latest analysis record.
- `evidence ((metadata->>'impactAnalysisId')) WHERE subject_type = 'impact_finding'`: Partial index on evidence table for fast lookup of findings by impact analysis ID.

### 3. Row-Level Security (RLS) & Multi-Tenancy
- Table configured with `FORCE ROW LEVEL SECURITY`.
- `SELECT` policy evaluates `fluxora_pull_request_in_current_tenant(pull_request_id)`.
- `INSERT` and `UPDATE` policies evaluate both `fluxora_pull_request_in_current_tenant(pull_request_id)` AND `fluxora_analysis_run_in_current_tenant(analysis_run_id)`.
- Helper function `fluxora_impact_analysis_in_current_tenant(p_impact_analysis_id)` provides fast tenant verification for child resources.
- Cross-tenant SELECT returns `null` / `[]`, and cross-tenant mutations are prevented by PostgreSQL engine security.

### 4. EvidenceWriter Provenance
- `EvidenceWriter.createImpactFindingEvidence`:
  - Derives deterministic evidence IDs: `SHA256(analysisRunId + ":evidence:impact_finding:" + nodeId + ":" + filePath + ":" + description)`.
  - Links findings to AST coordinates (`lineStart`, `lineEnd`, `columnStart`, `columnEnd`) where available.
  - Updates finding JSONB `evidenceIds` to cite the newly created evidence row.
  - Writes all evidence rows atomically alongside the analysis row via `EvidenceWriter.writeEvidenceBatchTx`.
  - Idempotent execution: re-running with the same ID updates existing records without duplicating evidence rows.

---

## Verification Summary

All 15 test suites in `packages/db/src/repositories/impact-analysis.test.ts` pass cleanly:
1. `EvidenceWriter.createImpactFindingEvidence` constructs valid deterministic evidence input with coordinates and metadata.
2. `EvidenceWriter.createImpactFindingEvidence` is strictly deterministic across repeated invocations.
3. Input validation rejects invalid UUIDs for organization, pull request, analysis run, and analysis ID.
4. Query methods gracefully return `null` or `[]` on malformed UUID strings.
5. `saveImpactAnalysis` persists `ImpactAnalysis` record and commits `impact_finding` evidence records.
6. Idempotency: Re-saving an analysis with the same ID updates cleanly without duplicate evidence rows.
7. `persistPullRequestImpactAnalysis` executes Step 43 engine and persists result + evidence end-to-end.
8. `getImpactAnalysisById` retrieves the exact persisted impact analysis with parsed structures.
9. `getLatestImpactAnalysisForPullRequest` and `listImpactAnalysesForPullRequest` order records chronologically.
10. `listImpactFindingEvidence` retrieves all evidence records associated with an impact analysis.
11. Multi-tenant RLS isolation blocks cross-tenant reads at the PostgreSQL engine level.
12. Multi-tenant RLS blocks cross-tenant inserts across organization boundaries.
13. Non-existent pull request raises `PullRequestNotFoundError`.
14. Empty pull request persists cleanly with empty arrays and zero evidence records.
15. Truncated impact analysis persists `truncated: true` and `truncation_reason` accurately.

