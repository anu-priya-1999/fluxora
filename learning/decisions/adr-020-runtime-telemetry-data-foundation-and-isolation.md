# ADR-020: Runtime Telemetry Data Foundation, Encrypted Config Contract, and Composite Node Integrity

## Status
Accepted (Global Step 67 — Phase 10 Step 1)

## Context
Phase 10 introduces runtime telemetry (`TelemetrySource` and `Observation`) to ground Fluxora's deterministic graph in observed runtime behavior. Before any ingestion endpoints or provider clients are built, the relational persistence layer must enforce strict tenant isolation, prevent plaintext credential storage, support unmapped observations prior to graph correlation, and prevent cross-repository or cross-tenant `GraphNode` associations.

## Decision
1. **Encrypted Configuration Contract without Custom Crypto**: Store `telemetry_sources.connection_config` as `text NOT NULL` constrained to `^(enc|kms):v[0-9]+:[^\s]+$` at both the TypeScript repository and PostgreSQL `CHECK` boundaries. Do not implement custom cryptography or add unrequested crypto dependencies; KMS envelope encryption in `packages/infrastructure` is required before persisting real provider credentials.
2. **Composite Foreign Key for Observation-to-GraphNode Integrity**: Include `repository_id` on `observations` (authoritatively derived from `telemetry_sources` on `INSERT` and immutable on `UPDATE`) and enforce `FOREIGN KEY (repository_id, node_id) REFERENCES public.graph_nodes (repository_id, id) ON DELETE SET NULL (node_id)`.
3. **Nullable `node_id` & Exact `NUMERIC` Storage**: Keep `observations.node_id` nullable for pre-correlation observations and use PostgreSQL `NUMERIC` + `timestamptz` (`observed_at`) with standard B-tree and partial indexes.
4. **Tenant Isolation**: Apply `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` on both tables using `public.fluxora_repository_in_current_tenant(repository_id)`.

## Consequences
- Cross-repository and cross-tenant node links are structurally impossible at the storage engine level.
- Historical telemetry survives `GraphNode` pruning (`node_id` becomes `NULL`) and cascades cleanly on `TelemetrySource` or `Repository` deletion.
- Ingestion, correlation, and simulation overrides remain cleanly deferred to later Phase 10 steps.
