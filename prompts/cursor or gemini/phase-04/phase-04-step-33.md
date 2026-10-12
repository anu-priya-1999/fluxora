Implement ONLY Fluxora Global Step 33: Golden Fixture Graph Verification.

Do not implement Step 34 or any Phase 5/UI work. Do not redesign existing graph architecture. Do not introduce new production behavior unless strictly required to make the Step 33 verification testable.

Context:
Steps 18–26 completed code-intelligence extraction/normalization and golden-fixture pipeline.
Step 27 added graph storage.
Step 28 added the Graph Builder.
Step 29 added Evidence Writer + evidence lint.
Step 30 added bounded-depth recursive-CTE traversal.
Step 31 added POST /api/v1/graph/query.
Step 32 added deterministic graph diffs + transactional graph.updated events.

Goal:
Create a deterministic end-to-end golden-fixture verification for the graph produced by the existing normalized-code → graph pipeline.

Step 33 must verify the ACTUAL persisted graph contract, not merely unit-test individual helper functions.

Required scope:
1. Reuse the existing golden fixture/repository fixture infrastructure from Steps 26–28 wherever possible.
2. Build the fixture through the existing production pipeline.
3. Persist the graph using the existing Graph Builder/repository path.
4. Read the persisted graph back from PostgreSQL using the existing repository/read APIs.
5. Assert the expected canonical GraphNodes:
   - correct node IDs
   - correct node types
   - correct stable identity/canonicalization
   - no unexpected duplicate nodes
6. Assert the expected GraphEdges:
   - correct source/target node IDs
   - correct edge types
   - correct directionality
   - no unexpected duplicate edges
7. Assert evidence records are present and attached to the correct graph relationships/nodes according to the existing Step 29 contract.
8. Verify deterministic output:
   - running the same golden fixture again produces the same graph structure
   - ordering is deterministic where the existing contract requires it
   - repeated persistence does not create duplicate graph records
9. Verify tenant/analysis-run isolation using the existing RLS conventions:
   - the fixture graph is visible to its owning tenant/run
   - another tenant cannot read it
   - another analysis run does not accidentally contaminate the expected graph
10. Add at least one meaningful negative assertion for an unexpected node/edge/evidence record.
11. Keep assertions tied to the canonical graph contract rather than implementation-private SQL details.
12. Do NOT change the Step 30 traversal algorithm, Step 31 HTTP contract, or Step 32 event/diff behavior except for a strictly necessary test-only compatibility fix.

Tests:
- Add/update the smallest appropriate Step 33 golden-fixture verification test suite.
- Prefer the existing test conventions in the repository.
- Make the tests deterministic and runnable in the normal PostgreSQL-backed test environment.
- Do not weaken existing tests or skip failures.
- Run the focused Step 33 tests first, then the relevant graph/worker/db tests.

Documentation is REQUIRED and must follow the exact learning pattern already used in previous steps:
- learning/implementations/phase-04/step-33-golden-fixture-graph-verification.md
- learning/notes/33. Golden Fixture Graph Verification - End-to-End Graph Contract Validation.md
- learning/interviews/33. Step 33 Golden Fixture Graph Verification Interview CheatSheet.md
- Update docs/DESIGN.md without deleting existing content.

Documentation must explain in plain English:
- what Step 33 verifies
- why golden fixtures are necessary
- the full data flow from source fixture → extraction/normalization → graph build → persistence → readback → verification
- what exactly is considered canonical
- node/edge/evidence invariants
- determinism/idempotency guarantees
- tenant and analysis-run isolation
- what this test proves and what it does NOT prove
- important failure modes
- interview questions/answers for a senior frontend/full-stack engineer discussing this architecture

Before editing:
- Inspect the existing Step 26 golden fixture implementation and the current Step 28 graph-builder tests.
- Inspect current graph repository/read APIs and shared graph types.
- Reuse existing helpers instead of creating parallel fixture infrastructure.

Verification required before finishing:
- focused Step 33 tests pass
- relevant existing graph/worker/db tests pass
- pnpm typecheck
- pnpm lint
- pnpm lint:evidence
- pnpm build
- git diff --check

At the end, report:
1. files created/modified
2. exact tests/commands run and results
3. any assumptions
4. confirmation that NO Step 34/UI work was implemented

Do not commit changes.