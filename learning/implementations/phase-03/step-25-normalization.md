# Fluxora Implementation: Step 25 — Normalization

## Overview

Step 25 implements the Phase 3 Normalizer (`normalizeAnalysis`), which processes the raw outputs produced by existing code-intelligence detectors (Steps 18–24: language detection, per-file symbol extraction, import/export graph extraction, API route detection, event pattern detection, database reference detection, and tree-sitter fallback parsing).

The Normalizer produces a canonical, deterministic representation (`RepositoryNormalizedResult`) suitable for Step 26 full-pipeline verification and Phase 4 graph persistence.

## Core Responsibilities

1. **Barrel-File / Re-Export Resolution**: Traverses barrel re-exports (`export { foo } from "./foo"`, `export * from "./users"`, `export { a as b }`, etc.) to map re-exported names and aliases to their canonical underlying symbol declarations.
2. **Symbol Deduplication**: Deduplicates multiple references to the same underlying symbol declaration without collapsing distinct declarations that share names across different files or locations.
3. **Canonical Identity Generation**: Generates stable, deterministic IDs (`sym:...`, `edge:...`, `route:...`, `event:...`, `db:...`, `unresolved:...`) based strictly on static code parameters.
4. **Cycle Safety**: Detects and bounds re-export cycles (`a.ts <-> b.ts`) deterministically without infinite loops or stack overflow.
5. **Cross-Detector Symbol Linkage**: Links API routes, event producers/consumers, and database references to their underlying canonical symbols when static evidence connects them.
6. **Deterministic Ordering**: Sorts all output collections using explicit alphanumeric keys to ensure reproducible analysis across execution runs.
7. **Provenance Preservation**: Retains origin detector tags (`step-19-symbols`, etc.) and original source IDs.

## Data Contracts

Defined in `packages/shared-types/src/normalized.ts`:
- `RepositoryNormalizerInput`
- `NormalizedSymbol`
- `NormalizedAlias`
- `NormalizedExportResolution`
- `NormalizedModuleEdge`
- `NormalizedRoute`
- `NormalizedEventPattern`
- `NormalizedDatabaseReference`
- `NormalizedUnresolvedReference`
- `NormalizedDiagnostic`
- `NormalizerStatistics`
- `RepositoryNormalizedResult`

## API Usage

```typescript
import { normalizeAnalysis } from "@fluxora/workers/normalizer";

const result = normalizeAnalysis({
  symbolExtractions,
  moduleGraph,
  routeResult,
  eventResult,
  databaseResult,
  treeSitterResults,
});
```

## Verification

Validated by 21 focused unit tests covering direct symbols, barrel chains, aliased re-exports, star re-exports, cycle handling, ambiguous resolution, cross-detector linkage, immutability, and deterministic ordering.

