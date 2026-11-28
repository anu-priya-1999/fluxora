# Step 67: Runtime Telemetry Data Foundation — Implementation Report

## 1. Scope & Roadmap Consistency
Global Step 67 implements **Phase 10, Step 1** from `docs/architecture/17-implementation-roadmap.md`: the persistent PostgreSQL foundation for `TelemetrySource` and `Observation` (`docs/architecture/06-database-schema.md`). No ingestion endpoints, provider API clients, correlation pipelines, graph enrichment, or simulation overrides were implemented.

## 2. Files Created & Modified
- `packages/db/migrations/0029_runtime_telemetry_storage.sql`
- `packages/shared-types/src/telemetry.ts`
- `packages/shared-types/src/index.ts`
- `packages/db/src/repositories/telemetry.ts`
- `packages/db/src/index.ts`
- `packages/db/src/repositories/telemetry.test.ts`
- `docs/DESIGN.md`
- `docs/architecture/06-database-schema.md`
- `docs/architecture/11-security-architecture.md`
- `docs/architecture/12-testing-strategy.md`
- `docs/architecture/17-implementation-roadmap.md`
- `docs/architecture/18-decision-log.md`
- `learning/decisions/adr-020-runtime-telemetry-data-foundation-and-isolation.md`
- `learning/notes/67. Runtime Telemetry Data Foundation.md`
- `learning/interviews/67. Step 67 Runtime Telemetry Data Foundation Interview CheatSheet.md`
- `prompts/cursor or gemini/phase-10/phase-10-step-67.md`

## 3. Architecture & Security Highlights
- **TelemetrySource (`telemetry_sources`)**: Belongs to `repositories (id) ON DELETE CASCADE`, supports `datadog | otel | newrelic`, enforces explicit lifecycle states (`pending | active | error | disabled`) and state transitions, and rejects plaintext JSON/raw tokens via an opaque encrypted-envelope `CHECK` constraint (`^(enc|kms):v[0-9]+:[^\s]+$`).
- **Observation (`observations`)**: Stores exact `NUMERIC` values and UTC `timestamptz` `observed_at` timestamps, supports nullable `node_id` for pre-correlation observations, and enforces `(repository_id, node_id) -> graph_nodes(repository_id, id) ON DELETE SET NULL (node_id)` with authoritative `repository_id` derivation and immutability triggers.
- **RLS**: Both tables enable `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` using `fluxora_repository_in_current_tenant(repository_id)`.

## 4. Remaining Limitations & Deferred Work
- `packages/infrastructure` currently provides `SecretsClient` (`getSecret`) without KMS envelope encryption; KMS-backed encryption/decryption must be implemented before real provider credentials are stored in Phase 10 Step 2+.
- Ingestion endpoints, provider clients, service-to-node matching, confidence upgrades, and simulation overrides remain deferred to subsequent Phase 10 steps.
