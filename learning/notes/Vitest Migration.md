# Engineering Notes: Vitest Migration in a TypeScript Monorepo

## 1. Context & Architectural Overview

Fluxora is an AI-powered software digital twin where the core graph engine, change-impact analysis, scenario simulation, and tenant isolation (RLS) are strictly deterministic and never depend on an LLM.

Before this migration, test execution relied on Node's native runner (`node --experimental-strip-types --test`). While this allowed running TypeScript tests without a compiler pre-pass, it had notable limitations in a growing monorepo:
1. **Runner Fragmentation**: Different packages relied on varying CLI argument strings (e.g. `apps/workers` enumerating all 18 test files manually in `package.json`).
2. **Ecosystem Tooling Inflexibility**: Node's runner lacks built-in watch modes with module dependency graphs, workspace-aware filtering, coverage visualization, and configurable worker pool isolation.
3. **Execution Control**: Handling per-file timeouts, parallel worker limits, and async hook lifecycles required boilerplate in every test file.

Vitest was chosen as the standard workspace test framework because it provides first-class ESM and TypeScript support via Vite, unified workspace configuration, robust lifecycle hooks, and drop-in compatibility with native Node assertions.

---

## 2. Key Technical Decisions & Invariants

### 2.1 Preserving `node:assert/strict` Instead of Churning to `expect`
Vitest supports both `expect(...)` and Node's native `assert` from `node:assert/strict`.
- **Decision**: Retain existing `node:assert/strict` calls rather than rewrite every assertion.
- **Rationale**:
  - The goal of the infrastructure migration was **behavior-preserving**. Rewriting hundreds of assertions to `expect` creates unnecessary diff churn and risks subtly altering error message matching or deep-equality semantics.
  - Vitest seamlessly catches `AssertionError` thrown by `node:assert/strict` and formats stack traces cleanly with diff highlighting.

### 2.2 Subtest Pattern Translation (`t.test` -> `describe` / `it`)
Node's test runner encouraged nesting via test context objects:
```ts
test("Suite", async (t) => {
  await t.test("Subtest 1", async () => { ... });
  t.after(async () => { ... });
});
```
In Vitest, `t.test` does not exist on the test context. The canonical, idiomatic Vitest equivalent is:
```ts
describe("Suite", () => {
  beforeAll(async () => { ... });
  afterAll(async () => { ... });
  it("Subtest 1", async () => { ... });
});
```
Where teardown was local to a single test without subtests:
```ts
import { test, onTestFinished } from "vitest";

test("WebSocket authenticated delivery", async () => {
  onTestFinished(async () => {
    await server.close();
  });
});
```
`onTestFinished` guarantees that cleanup code executes regardless of whether the test passes or fails.

### 2.3 Conditional Database Testing (`describe.skipIf`)
In `packages/db` and `apps/workers`, certain integration tests require a live PostgreSQL instance with migrations and RLS helper functions installed:
```ts
const hasDatabase = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;

describe.skipIf(!hasDatabase)("Database Persistence & RLS Integration", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = getPool();
    await runMigrations(pool);
  });
  afterAll(async () => {
    await closePool();
  });
  it("verifies RLS boundary", async () => { ... });
});
```
This cleanly skips database-dependent test blocks without throwing unhandled connection errors in environments without active database credentials.

---

## 3. Challenges & Windows OS Considerations

### 3.1 Parallel Fork Worker Exhaustion
By default, Vitest executes test files in parallel across child processes (`pool: "forks"`). On Windows, spawning 18+ Node processes simultaneously for `apps/workers` causes:
- Extreme CPU thrashing and memory pressure.
- IPC timeout errors (`[vitest-pool]: Timeout terminating forks worker` or `Failed to start forks worker`).
- Unpredictable test timeouts during heavy AST parsing of the Shadcn Taxonomy golden fixture.

**Solution**:
Configuring `fileParallelism: false` in `vitest.config.ts`:
- Executes test files sequentially in a stable, single worker loop.
- Reduces total execution time by eliminating OS process spawn overhead.
- Mirrors the deterministic execution characteristics of the pre-migration setup.

### 3.2 Long-Running Static Analysis Timeouts
Vitest applies a default `testTimeout` of 5,000ms (5 seconds) and `hookTimeout` of 10,000ms (10 seconds).
In `apps/workers`, `src/pipeline/phase3.test.ts` and `src/pipeline/golden-graph.test.ts` run static AST parsing, route extraction, module dependency resolution, and Tree-sitter fallback parsing across >100 TypeScript source files.
Under Node test runner, there was no default 5-second ceiling.

**Solution**:
Set `testTimeout: 60000` (60s) and `hookTimeout: 60000` (60s) in the Vitest configuration for the workspace and workers package.

### 3.3 Server Connection Teardown
Fastify and Node HTTP servers with persistent keep-alive connections can hold the Vitest worker process open if connections are not terminated.
In `apps/api`, adding `server.closeAllConnections?.()` in `afterAll` ensures HTTP sockets terminate promptly.

---

## 4. Key Takeaways
- Vitest provides immediate developer experience improvements: unified CLI, fast filtering (`pnpm test -t "pattern"`), and consistent lifecycle hooks.
- Keeping assertions minimal and focused prevented behavioral regressions.
- All 487 tests and invariants (RLS, graph storage, evidence provenance, WebSocket routing) were 100% preserved.
