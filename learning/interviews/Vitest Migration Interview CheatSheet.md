# Interview CheatSheet: Vitest Test Runner Migration & Monorepo Testing

## 1. High-Level Concept & Framing

### Q: Why migrate from Node.js built-in `node:test` to Vitest in a monorepo?
**Strong Answer:**
> "Node's built-in `node:test` runner is great for zero-dependency prototyping, especially with `--experimental-strip-types`. However, as a TypeScript monorepo scales across multiple packages (`api`, `web`, `workers`, `db`, `infrastructure`), `node:test` presents operational limitations:
> 1. Lack of a unified monorepo configuration or workspace orchestrator.
> 2. Primitive lifecycle management—subtest contexts (`t.test` / `t.after`) become verbose and lack fine-grained hook scoping (`beforeAll`, `afterAll`).
> 3. No native fast watch mode powered by an ESM module dependency graph.
>
> Vitest provides out-of-the-box ESM/TypeScript support, first-class workspace integration, idiomatic lifecycle hooks, and rich CLI filtering while maintaining full backward-compatibility with Node's native `assert` library."

---

## 2. Invariant & Architecture Questions

### Q: How do you guarantee a test infrastructure migration is strictly behavior-preserving?
**Key Points:**
- **Zero Production Changes**: Never modify business logic, database schemas, API routes, or UI components to satisfy the test runner.
- **Baseline Capture**: Run the existing test runner and record exact metrics: test file count, passed, failed, and skipped tests, plus typecheck, lint, and build statuses.
- **Assertion Fidelity**: Do not mechanically rewrite working assertions (e.g. `assert.equal`, `assert.deepEqual`) into `expect(...)` unless necessary. Preserve exact input/output boundaries and error message matching.
- **Post-Migration Comparison**: Verify identical test counts (e.g. 487 passed across 46 test files in Fluxora) and identical behavior under conditional skipping (e.g. database-dependent tests skipping when `DATABASE_URL` is absent).

### Q: How do you handle database integration tests with Row-Level Security (RLS) in Vitest?
**Key Points:**
- Use `describe.skipIf(!hasDatabase)` to conditionally run tests only when database credentials exist.
- Group PostgreSQL connection initialization and database migrations inside `beforeAll` and connection pool closing in `afterAll`.
- Always restore database roles and environment variables in `finally` blocks (or `onTestFinished`) so multi-tenant RLS checks don't leak permissions into subsequent tests.

---

## 3. Practical Monorepo & System Pitfalls

### Q: What challenges arise when running parallel test workers on Windows or CI?
**Key Points:**
- **Worker Process Exhaustion**: Spawning 18+ fork processes simultaneously on Windows triggers severe CPU contention, process creation overhead, and IPC timeouts (`[vitest-pool]: Timeout terminating forks worker`).
- **Solution**: Configure `fileParallelism: false` or limit `maxConcurrency` so test suites run sequentially in a stable worker pool. This eliminated timeouts and made the test run significantly faster by removing fork thrashing.
- **Static Analysis Workloads**: Deterministic AST parsing across 100+ TypeScript files can take 10–15 seconds per suite. Default 5s test timeouts must be elevated (e.g. `testTimeout: 60000`, `hookTimeout: 60000`) for data-heavy pipelines.

### Q: What is the difference between `t.after` in Node and Vitest lifecycle hooks?
**Key Points:**
- In `node:test`, teardown is attached to the subtest context via `t.after(fn)`.
- In Vitest, test-level teardown uses `onTestFinished(fn)`. It runs immediately after the test completes, regardless of success or failure, preventing resource leaks (such as open HTTP or WebSocket servers).
- Suite-level teardown maps to `afterAll(fn)`.

---

## 4. Rapid-Fire CheatSheet

| Feature | Node.js `node:test` | Vitest |
| :--- | :--- | :--- |
| **Command** | `node --experimental-strip-types --test` | `vitest run` |
| **Test Hook** | `t.after(fn)` | `onTestFinished(fn)` or `afterEach`/`afterAll` |
| **Subtests** | `await t.test("name", fn)` | `describe(...)` + `it(...)` |
| **Assertions** | `node:assert/strict` | Native `expect` + Full support for `node:assert/strict` |
| **Conditional Run**| `{ skip: !condition }` in test options | `describe.skipIf(!condition)` / `it.skipIf(!condition)` |
| **Parallelism** | Default concurrent per file | `fileParallelism: false` / `maxConcurrency` |
| **TypeScript Support**| Type stripping only (no parameter properties) | Full TS & ESM transformation via Vite |
