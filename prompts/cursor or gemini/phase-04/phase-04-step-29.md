You are implementing ONLY Fluxora Global Step 29: Evidence Writer + CI Evidence Lint.

Do not implement, refactor, redesign, or anticipate Global Steps 30+.

==================================================
1. FIRST: INSPECT THE CURRENT REPOSITORY
==================================================

Before making any changes:

1. Inspect the latest git history and current branch/status.
2. Read the canonical roadmap:
   docs/architecture/17-implementation-roadmap.md
3. Inspect the ACTUAL current implementation of:
   - packages/shared-types/src/graph.ts
   - packages/shared-types/src/builder.ts
   - packages/db/src/repositories/graph.ts
   - apps/workers/src/builder/graph-builder.ts
   - apps/workers/src/builder/graph-builder.test.ts
   - migration 0014 graph storage
   - existing DB/repository test conventions
   - existing CI/workflow files
4. Inspect the existing Step 27 and Step 28 learning documentation so Step 29 uses the SAME:
   - terminology
   - organization
   - detail level
   - architectural framing
5. Verify that the Step 28 graph builder and persistence flow are the current source of truth.
6. Do not assume code structure from an older version of the repository.

==================================================
2. STEP 29 OBJECTIVE
==================================================

Implement the Evidence Writer layer and CI evidence-linting mechanism.

The goal is:

Every graph-write path must produce corresponding Evidence records with preserved provenance, deterministic identity, tenant/scope correctness, and atomic behavior.

Step 29 should make evidence persistence an explicit architectural responsibility instead of allowing graph-writing code to create graph records without evidence.

The implementation must work with the existing Step 27 GraphNode / GraphEdge / Evidence schema and Step 28 Graph Builder.

==================================================
3. REQUIRED ARCHITECTURE
==================================================

Introduce a dedicated Evidence Writer abstraction in the existing architecture.

The Evidence Writer should:

- accept normalized/provenance-aware evidence information
- produce deterministic evidence IDs
- preserve source provenance
- preserve analysis_run_id / tenant scope
- write evidence through the existing DB architecture
- support single and batch evidence persistence where appropriate
- be safe for repeated/idempotent execution
- participate in the same transaction as graph writes
- never bypass existing RLS/security conventions
- never fabricate provenance
- never silently discard unresolved/missing provenance
- return useful persistence results/errors consistent with existing repository conventions

Use the existing Evidence schema and types.
Do not create a second competing evidence model.

==================================================
4. WIRE THE EVIDENCE WRITER INTO GRAPH WRITES
==================================================

Update the Step 28 graph persistence flow so that graph writes go through the Evidence Writer rather than containing ad-hoc evidence-writing logic.

Audit EVERY existing graph-write path in the repository.

For each graph-write path, determine:

1. Does it create/update GraphNode records?
2. Does it create/update GraphEdge records?
3. What evidence should be attached?
4. Where is the source provenance obtained?
5. Is evidence written in the SAME transaction?
6. Is the evidence deterministic and idempotent?

The final implementation must ensure that every supported graph-write path has corresponding evidence handling.

Do not modify unrelated repository write paths.

==================================================
5. DETERMINISTIC EVIDENCE IDENTITY
==================================================

Evidence IDs must remain deterministic.

Use a stable canonical seed based on the evidence's semantic identity, using the existing project conventions.

Repeated execution of the same graph build must NOT create duplicate Evidence rows.

Do not:

- generate random IDs for graph evidence
- remove deterministic IDs
- weaken primary-key constraints
- add unnecessary schema changes
- replace RLS with application-only checks

Preserve the Step 28 idempotency guarantees.

==================================================
6. PROVENANCE REQUIREMENTS
==================================================

Evidence should preserve, whenever available:

- analysis_run_id
- subject type
- subject ID
- file path
- symbol ID
- line start/end
- column start/end
- relationship description
- confidence
- metadata

Follow the existing shared types and database schema.

Do not invent provenance for relationships that do not have real source evidence.

Where the pipeline intentionally represents an unresolved relationship, preserve that fact rather than manufacturing a source location or graph endpoint.

==================================================
7. TRANSACTION / ATOMICITY
==================================================

Evidence and graph persistence must remain atomic.

A graph build must not reach a state where:

- GraphNode/GraphEdge records were committed
- but their required evidence was not committed

and vice versa.

Use the current transaction architecture.

Do not introduce a new transaction framework.

Preserve the existing RLS behavior.

Cross-tenant access must continue to fail.

==================================================
8. CI EVIDENCE LINT
==================================================

Add a lightweight deterministic CI check that verifies graph-write code paths satisfy the Evidence Writer requirement.

The checker should be narrowly scoped to Step 29.

Its purpose is architectural enforcement, not runtime execution.

It should fail when a supported graph-write path is introduced or modified in a way that bypasses the Evidence Writer/evidence requirement.

Prefer a deterministic source-level/static check using the existing repository/tooling conventions.

The check should:

- be understandable
- have stable output
- avoid brittle dependence on formatting
- avoid requiring a live database
- run in CI
- have focused tests
- explain failures clearly enough for a developer to fix them

Do NOT build a general static-analysis framework.

Do NOT add AI-based linting.

Do NOT scan the entire monorepo indiscriminately.

Keep it specifically about Fluxora graph-write/evidence architectural invariants.

==================================================
9. TESTS
==================================================

Add focused Step 29 tests.

At minimum cover:

1. Evidence Writer creates valid evidence.
2. Evidence identity is deterministic.
3. Repeating the same evidence write is idempotent.
4. Evidence provenance is preserved exactly.
5. Batch evidence writing is deterministic if batch support is implemented.
6. Graph node writes receive evidence.
7. Graph edge writes receive evidence.
8. Evidence and graph records remain atomic in one transaction.
9. Cross-tenant/RLS protections remain intact.
10. Invalid evidence input is rejected safely.
11. Missing/invalid provenance is not fabricated.
12. CI evidence-lint passes for valid graph-write paths.
13. CI evidence-lint fails when a graph-write path bypasses the required evidence mechanism.

If the existing test architecture already has helpers for PostgreSQL/RLS, reuse them.

Do not rewrite the existing test framework.

Do not migrate from node:test to Vitest.
That is a separate future infrastructure task and is OUT OF SCOPE.

==================================================
10. SHARED TYPES / DATABASE CHANGES
==================================================

Only modify shared types or DB repository contracts when required by the Evidence Writer design.

Do NOT add a migration unless the existing schema truly cannot support the required Step 29 behavior.

The Step 27 Evidence schema is already the intended persistence model.

Do not change:

- Evidence primary key semantics
- graph node uniqueness
- graph edge uniqueness
- tenant/RLS architecture

unless inspection proves a current implementation bug specifically blocks Step 29.

==================================================
11. LEARNING DOCUMENTATION — REQUIRED
==================================================

Follow the EXACT documentation pattern used in Steps 18–28.

Create:

learning/implementations/phase-04/step-29-evidence-writer-and-ci-lint.md

Create/update engineering notes under:

learning/notes/

Use the next consistent naming convention already established by Steps 27–28.

Create:

learning/interviews/29. Step 29 Evidence Writer Interview CheatSheet.md

Update:

docs/DESIGN.md

Do NOT delete existing documentation.

==================================================
12. IMPLEMENTATION DOCUMENTATION CONTENT
==================================================

The Step 29 implementation document must explain in plain English:

A. What Step 29 does
B. Why Evidence needs its own writer abstraction
C. The problem Step 29 solves
D. How Step 27 storage and Step 28 Graph Builder lead into Step 29
E. Evidence Writer architecture
F. Data flow:
   normalized intelligence
      ↓
   graph builder
      ↓
   graph records
      +
   Evidence Writer
      ↓
   Evidence records
      ↓
   atomic transaction
E. Deterministic evidence identity
F. Provenance preservation
G. Idempotency
H. RLS/tenant isolation
I. CI evidence-lint purpose and design
J. Why the lint is static/deterministic
K. Failure modes
L. Testing strategy
M. Security/invariants
N. Limitations
O. Explicit boundary:
   what Step 29 does NOT implement

Use diagrams where previous implementation documents use them.

==================================================
13. ENGINEERING NOTES
==================================================

The Step 29 engineering notes should teach:

- what an Evidence Writer is
- why evidence is a first-class persistence concern
- difference between graph data and evidence/provenance
- deterministic IDs
- idempotent persistence
- transactional consistency
- tenant boundaries/RLS
- static CI architectural linting
- why source-level linting is useful
- how this prepares the system for later graph traversal/query work

Explain concepts in plain English first, then technical terminology.

==================================================
14. INTERVIEW CHEATSHEET
==================================================

The Step 29 interview cheatsheet should cover:

- What problem does the Evidence Writer solve?
- Why not write evidence directly inside every graph repository function?
- How do you guarantee idempotency?
- How are evidence IDs deterministic?
- How is provenance preserved?
- How do GraphNodes/GraphEdges relate to Evidence?
- How do you guarantee atomicity?
- How does RLS protect evidence?
- Why use CI static lint instead of runtime validation alone?
- What happens if a developer adds a new graph-write path?
- What are the trade-offs and limitations?
- Why is this architecture useful for a code-intelligence platform?

Include concise interview-ready answers plus deeper explanations.

==================================================
15. docs/DESIGN.md
==================================================

Append/update the Step 29 section using the existing DESIGN.md structure.

Explain:

- Evidence Writer
- evidence ownership
- evidence lifecycle
- graph-write → evidence relationship
- deterministic identity
- transactional guarantees
- CI architectural enforcement
- tenant/RLS boundaries
- Step 29 boundary

Do not remove or rewrite unrelated sections.

==================================================
16. STRICT STEP BOUNDARY
==================================================

DO NOT IMPLEMENT:

- recursive graph traversal
- recursive CTE traversal
- graph query API
- graph.updated events
- graph diff summaries
- golden-graph verification
- UI graph visualization
- Phase 5 work
- Vitest migration
- AI-generated evidence
- semantic embeddings
- vector search
- graph ranking
- performance refactors unrelated to evidence

Those belong to later steps.

==================================================
17. VERIFICATION
==================================================

After implementation, run the narrowest relevant tests first.

Then run:

pnpm test
pnpm typecheck
pnpm lint
pnpm build

Also run the CI evidence-lint directly if it has a dedicated command.

Verify:

- zero failing tests
- zero type errors
- zero lint errors
- build succeeds
- existing Step 27 tests still pass
- existing Step 28 tests still pass
- Step 28 idempotency remains green
- RLS tests remain green
- CI evidence-lint passes

Do not hide skipped tests.
If any test is skipped, explain exactly why.

==================================================
18. FINAL REPORT FORMAT
==================================================

At the end, report:

1. Files created
2. Files modified
3. What changed
4. Evidence Writer API/architecture
5. Graph-write paths covered
6. CI evidence-lint mechanism
7. Tests added
8. Exact verification commands and results
9. Any migrations/env requirements
10. Explicit confirmation that no Step 30+ functionality was implemented
11. Recommended git commit message

Recommended commit message:

feat(graph): add evidence writer and CI evidence lint

Do not create a commit automatically unless explicitly instructed.