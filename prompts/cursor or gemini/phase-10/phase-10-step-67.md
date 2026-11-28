# Phase 10 — Global Step 67: Runtime Telemetry Data Foundation

## Objective
Begin Phase 10 (Runtime Telemetry) by implementing the persistent PostgreSQL data foundation for `TelemetrySource` and `Observation` (`docs/architecture/06-database-schema.md`), with strict tenant isolation (RLS), encrypted configuration envelope enforcement, composite repository-to-GraphNode referential integrity, and typed `@fluxora/shared-types` + `@fluxora/db` repository operations.

## Scope
- Migration `0029_runtime_telemetry_storage.sql`
- `@fluxora/shared-types` (`packages/shared-types/src/telemetry.ts`)
- `@fluxora/db` (`packages/db/src/repositories/telemetry.ts`)
- Integration & migration tests (`packages/db/src/repositories/telemetry.test.ts`)
- Canonical architecture docs + ADR-020 + Step 67 learning artifacts

## Non-Goals
- No OTel/Datadog/New Relic ingestion endpoints or provider API clients
- No service-name-to-GraphNode correlation or runtime edge/confidence enrichment
- No simulation engine overrides or UI dashboards
