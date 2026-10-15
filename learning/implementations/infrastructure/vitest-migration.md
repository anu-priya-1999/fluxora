# Vitest Test Infrastructure Migration Implementation

## 1. Executive Summary & Migration Motivation

### 1.1 Objective
Migrate the Fluxora workspace testing infrastructure from Node's built-in `node:test` test runner (`node --experimental-strip-types --test`) to Vitest (`vitest run`).

### 1.2 Core Invariants Preserved
- **Behavior-Preserving Migration**: Zero changes to production code, business logic, REST APIs, WebSocket protocols, database schemas, Row-Level Security (RLS) policies, graph models, or UI features.
- **Contract & Assertion Integrity**: Retained 100% of assertion semantics, inputs, expected outputs, negative assertions, error handling verifications, idempotency checks, and transaction boundaries. No tests were deleted, commented out, or weakened.
- **Deterministic Core Protection**: The deterministic dependency graph construction, traversal, and evidence collection remain strictly verified without any LLM dependencies or artificial mocking.

---

## 2. Pre-Migration Baseline vs. Post-Migration State

### 2.1 Pre-Migration Baseline (Node `node:test`)
- **Root runner**: Custom invocation per package using Node's `--experimental-strip-types --test` flag.
- **Total Test Files**: 46
- **Test Results**:
  - `@fluxora/infrastructure`: 1 file, 7 passed, 0 failed
  - `@fluxora/web`: 10 files, 105 passed, 0 failed
  - `@fluxora/api`: 7 files, 64 passed, 0 failed
  - `@fluxora/db`: 10 files, 61 passed, 5 skipped (skipped conditionally when `DATABASE_URL` is omitted)
  - `@fluxora/workers`: 18 files, 250 passed, 4 skipped (skipped conditionally when `DATABASE_URL` is omitted)
  - **Total**: 487 passed, 9 skipped, 0 failed.

### 2.2 Post-Migration State (Vitest)
- **Root runner**: `vitest run` configured at root (`vitest.config.ts`) and workspace packages.
- **Total Test Files**: 46
- **Test Results**:
  - `@fluxora/infrastructure`: 1 file, 7 passed, 0 failed
  - `@fluxora/web`: 10 files, 105 passed, 0 failed
  - `@fluxora/api`: 7 files, 64 passed, 0 failed
  - `@fluxora/db`: 10 files, 61 passed, 5 skipped
  - `@fluxora/workers`: 18 files, 250 passed, 4 skipped
  - **Total**: 487 passed, 9 skipped, 0 failed (100% parity).

---

## 3. Architecture & Workspace Configuration

### 3.1 Monorepo Vitest Strategy
Fluxora utilizes a root configuration file with package-specific overrides where required:
1. **Root `vitest.config.ts`**:
   - Environment: `node`
   - Test patterns: `apps/**/*.{test,spec}.{ts,tsx}`, `packages/**/*.{test,spec}.{ts,tsx}`
   - Exclusions: `node_modules`, `.next`, `dist`
   - Execution tuning: `fileParallelism: false` to prevent parallel fork-process thrashing on Windows, `testTimeout: 60000`, and `hookTimeout: 60000` for heavy AST parsing and fixture verification suites.
2. **`apps/workers/vitest.config.ts`**:
   - Explicit package-level override providing `testTimeout: 60000` and `hookTimeout: 60000` when running package-isolated test commands (`pnpm --filter @fluxora/workers test`).

### 3.2 Package Script Alignment
Each package `package.json` now maps its `"test"` script directly to Vitest:
- `packages/infrastructure/package.json`: `"test": "vitest run"`
- `packages/db/package.json`: `"test": "vitest run"`
- `apps/api/package.json`: `"test": "vitest run"`
- `apps/web/package.json`: `"test": "vitest run"`
- `apps/workers/package.json`: `"test": "vitest run"`
- Root `package.json`: `"test": "pnpm -r --if-present test"`

---

## 4. Package-by-Package Migration Details

### 4.1 `@fluxora/infrastructure`
- **File**: `src/infrastructure.test.ts`
- **Changes**: Migrated `import test from "node:test"` to `import { test } from "vitest"`. Retained native Node `assert` checks verifying Redis helpers, key hashing, and concurrency limits.

### 4.2 `@fluxora/api`
- **Files**:
  - `src/github/github.test.ts`
  - `src/github/repository-client.test.ts`
  - `src/http/graph-query-request.test.ts`
  - `src/http/repositories.test.ts`
  - `src/repositories/connect.test.ts`
  - `src/ws/ws.test.ts`
  - `src/http/graph-query.test.ts`
- **Key Patterns & Fixes**:
  - Converted `ws.test.ts` test teardown callbacks (`t.after(...)`) to Vitest `onTestFinished(async () => { ... })`.
  - Converted subtest hierarchy in `graph-query.test.ts` to `describe(...)`, `beforeAll`, `afterAll`, and `it(...)` blocks.
  - Ensured Fastify and HTTP server instances explicitly invoke `server.closeAllConnections()` in `afterAll` so child worker threads terminate cleanly.

### 4.3 `@fluxora/web`
- **Files**:
  - `src/github/github-setup.test.ts`
  - `src/events/repository-events.test.ts`
  - `src/events/graph-events.test.ts`
  - `src/events/explorer-ws-client.test.ts`
  - `src/components/graph/graph-canvas.test.ts`
  - `src/components/graph/graph-lod.test.ts`
  - `src/app/repositories/[repoId]/explorer/explorer.test.ts`
  - `src/components/graph/node-inspector.test.ts`
  - `src/components/graph/graph-filters.test.ts`
  - `src/components/graph/explorer-status.test.ts`
- **Key Patterns & Fixes**:
  - All web tests verify DOM projection, lod filters, WebSocket event streaming, and UI states.
  - Tests use Node environment with mock fetch/WebSocket abstraction without requiring heavy jsdom polyfills.
  - Migrated `node:test` imports to Vitest while preserving all UI assertions covering Steps 34 through 40.

### 4.4 `@fluxora/db`
- **Files**:
  - `src/migrate/bootstrap-function-execute.test.ts`
  - `src/migrate/repositories-data-model.test.ts`
  - `src/migrate/repository-snapshot-sha256.test.ts`
  - `src/repositories/github-installation.test.ts`
  - `src/repositories/repository.test.ts`
  - `src/repositories/event.test.ts`
  - `src/repositories/repository-data-model.test.ts`
  - `src/repositories/evidence-writer.test.ts`
  - `src/repositories/graph-diff.test.ts`
  - `src/repositories/graph-storage.test.ts`
- **Key Patterns & Fixes**:
  - Converted subtests to `describe.skipIf(!hasDatabase)` blocks with lifecycle hooks (`beforeAll`, `afterAll`).
  - Maintained complete PostgreSQL RLS tenant verification and recursive-CTE traversal tests.

### 4.5 `@fluxora/workers`
- **Files**:
  - `src/worker.test.ts`
  - `src/github/client.test.ts`
  - `src/ingest/archive.test.ts`
  - `src/ingest/package-snapshot.test.ts`
  - `src/ingest/storage-config.test.ts`
  - `src/ingest/ingest.test.ts`
  - `src/fixtures/golden.test.ts`
  - `src/detect/detector.test.ts`
  - `src/symbols/extractor.test.ts`
  - `src/modules/graph.test.ts`
  - `src/routes/detector.test.ts`
  - `src/events/detector.test.ts`
  - `src/database/detector.test.ts`
  - `src/tree-sitter/parser.test.ts`
  - `src/normalizer/normalizer.test.ts`
  - `src/pipeline/phase3.test.ts`
  - `src/builder/graph-builder.test.ts`
  - `src/pipeline/golden-graph.test.ts`
- **Key Patterns & Fixes**:
  - Transformed subtest blocks in `graph-builder.test.ts` and `golden-graph.test.ts` into native `describe.skipIf(!hasDatabase)`, `beforeAll`, `afterAll`, and `it` tests.
  - Set `testTimeout: 60000` and `hookTimeout: 60000` for `phase3.test.ts` and `golden-graph.test.ts` to accommodate deterministic static analysis and AST extraction across the 100+ files of the Shadcn Taxonomy golden fixture.
  - Configured `fileParallelism: false` to ensure Windows OS stability and eliminate worker process fork exhaustion.

---

## 5. Verification Matrix

| Verification Command                         | Purpose                                        | Result                                                       |
| :------------------------------------------- | :--------------------------------------------- | :----------------------------------------------------------- |
| `pnpm test` (root)                           | Workspace-wide test execution via Vitest       | **Passed** (487 passed, 9 skipped, 0 failed across 46 files) |
| `pnpm --filter @fluxora/infrastructure test` | Package-isolated test run                      | **Passed** (7 passed, 0 failed)                              |
| `pnpm --filter @fluxora/api test`            | Package-isolated test run                      | **Passed** (64 passed, 0 failed)                             |
| `pnpm --filter @fluxora/web test`            | Package-isolated test run                      | **Passed** (105 passed, 0 failed)                            |
| `pnpm --filter @fluxora/db test`             | Package-isolated test run                      | **Passed** (61 passed, 5 skipped)                            |
| `pnpm --filter @fluxora/workers test`        | Package-isolated test run                      | **Passed** (250 passed, 4 skipped)                           |
| `pnpm typecheck`                             | TypeScript compilation across all packages     | **Passed** (Exit 0)                                          |
| `pnpm lint`                                  | ESLint verification                            | **Passed** (Exit 0)                                          |
| `pnpm lint:evidence`                         | Static AST audit of graph-write evidence calls | **Passed** (Exit 0)                                          |
| `pnpm build`                                 | Production Next.js & package build compilation | **Passed** (Exit 0)                                          |
| `git diff --check`                           | Trailing whitespace and merge marker checks    | **Passed** (Exit 0)                                          |
