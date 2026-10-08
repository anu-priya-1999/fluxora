Implement ONLY Fluxora Global Step 23 — Database Reference Detection.

Repository:
anu-priya-1999/fluxora

Current phase:
Phase 3 — Code Intelligence

Completed:
18 — Language/framework detection
19 — Per-file symbol extraction
20 — Import/export graph extraction + tsconfig path aliases
21 — Next.js API route + Express router detection
22 — Event producer/consumer pattern detection

Roadmap definition:
“Implement DB-reference detection (common ORM call shapes) — same iterative-pattern-library approach.”

IMPORTANT:
Before editing anything, inspect the current repository implementation and follow the conventions already established by Steps 18–22.

Inspect at minimum:
- docs/architecture/17-implementation-roadmap.md
- docs/DESIGN.md
- packages/shared-types/src/index.ts
- packages/shared-types/src/modules.ts
- packages/shared-types/src/routes.ts
- packages/shared-types/src/event-patterns.ts
- apps/workers/src/detect/*
- apps/workers/src/symbols/*
- apps/workers/src/modules/*
- apps/workers/src/routes/*
- apps/workers/src/events/*
- apps/workers/src/fixtures/*
- existing golden fixture + manifest
- existing detector tests and result-contract conventions

Do NOT refactor previous detectors unnecessarily.

==================================================
GOAL
==================================================

Add a deterministic, AST-based static detector for database/ORM references in TypeScript/JavaScript repository snapshots.

The detector must identify database interaction points and, when statically knowable:
- ORM/library family
- operation
- model/entity/table/resource name
- source file
- source location/range
- deterministic ID
- resolved vs unresolved reference status
- useful method/call metadata

This is code intelligence only.

It must:
- never execute target code
- never connect to a real database
- never import or instantiate target libraries at runtime
- never guess unresolved model/table names
- produce deterministic output
- preserve evidence needed by later graph construction

==================================================
INITIAL PATTERN LIBRARY
==================================================

Keep the Step 23 pattern library deliberately SMALL and explicit.

Support these ecosystems initially:

1. Prisma

Recognize statically identifiable Prisma Client usage such as:

- `prisma.user.findMany(...)`
- `prisma.user.findUnique(...)`
- `prisma.user.findFirst(...)`
- `prisma.user.create(...)`
- `prisma.user.createMany(...)`
- `prisma.user.update(...)`
- `prisma.user.updateMany(...)`
- `prisma.user.delete(...)`
- `prisma.user.deleteMany(...)`
- `prisma.user.upsert(...)`
- `$queryRaw(...)`
- `$executeRaw(...)`
- transaction-style Prisma calls when the underlying database operation can still be identified without execution

Capture:
- model/resource: `user`
- operation: find/create/update/delete/upsert/query/execute/etc.
- source location

Only classify an object as Prisma with reasonable provenance, such as an import from `@prisma/client` or another strong static signal already supported by the repository's conventions.

2. Drizzle ORM

Recognize common static query shapes such as:
- `select().from(users)`
- `insert(users)...`
- `update(users)...`
- `delete(users)...`
- clearly identifiable Drizzle query-builder calls
- `db.query.<table>.findFirst(...)`
- `db.query.<table>.findMany(...)` where the table/resource name is statically available

Capture:
- operation
- table/resource
- source location

Do not attempt to understand the full SQL/query-builder semantics.

3. TypeORM

Recognize common explicit TypeORM repository/entity-manager patterns such as:
- `repository.find(...)`
- `repository.findOne(...)`
- `repository.save(...)`
- `repository.insert(...)`
- `repository.update(...)`
- `repository.delete(...)`
- `repository.remove(...)`
- `manager.find(...)`
- `manager.save(...)`
- `manager.insert(...)`
- `manager.update(...)`
- `manager.delete(...)`
- `getRepository(User).find(...)` and similarly obvious static entity references

Capture the entity/model/resource name when statically available.

4. Sequelize

Recognize common model operations such as:
- `User.findAll(...)`
- `User.findOne(...)`
- `User.findByPk(...)`
- `User.create(...)`
- `User.bulkCreate(...)`
- `User.update(...)`
- `User.destroy(...)`
- `User.upsert(...)`

Capture the model/resource name when it is statically identifiable.

IMPORTANT:
Do NOT add a large ORM ecosystem matrix.
Do NOT add Mongoose, Knex, Kysely, MikroORM, Objection, raw SQL parser support, Mongo-specific patterns, etc. unless existing repository architecture explicitly requires them.
Keep Step 23 focused and extensible.

==================================================
REFERENCE / OPERATION MODEL
==================================================

Create a new shared contract, preferably:

packages/shared-types/src/database-references.ts

Do NOT overload:
- `packages/shared-types/src/events.ts`
- `event-patterns.ts`
- `modules.ts`

Define a result model aligned with the conventions from Steps 19–22.

Each detected reference should contain enough information for later graph building, for example:

- id
- filePath
- line / column or source range consistent with existing detectors
- library / pattern family
- operation
- resourceName or modelName or tableName, nullable when unresolved
- status: resolved | unresolved
- method/call shape
- optional metadata

Use the repository's existing naming conventions instead of inventing a completely different style.

==================================================
PROVENANCE / FALSE POSITIVE RULES
==================================================

Be conservative.

Do NOT classify arbitrary calls merely because they have familiar method names.

Examples that must NOT automatically become DB references:

- `foo.findMany()`
- `client.findOne()`
- `repository.save()` without provenance
- `user.update()` where `user` is just an ordinary object
- `model.create()` without evidence that `model` is a supported ORM model

Prefer provenance from:
- imports from known ORM packages
- recognizable client constructors
- known static factory calls
- known repository/entity-manager patterns
- explicit local aliases that can be established through static analysis

No runtime execution.

Do not inspect live database schemas.

Do not open real database connections.

Do not infer that a class is an ORM model merely because its name contains:
`User`, `Order`, `Product`, etc.

==================================================
STATIC RESOURCE NAME RESOLUTION
==================================================

Resolve resource/model/table names only when statically safe.

Support:
- string literals
- identifiers that are already directly bound to known static declarations
- no-substitution template literals where applicable
- obvious imported entity/model identifiers

For dynamic cases:

`prisma[modelName].findMany()`
`repository.save(dynamicEntity)`
`query(tableVariable)`

do NOT guess.

Return:
- `status: "unresolved"`
- resource/model/table name as `null` when it cannot be safely determined

==================================================
OPERATION TAXONOMY
==================================================

Use a small deterministic operation vocabulary.

At minimum support:

- read
- insert
- update
- delete
- upsert
- query
- execute
- transaction

Map framework-specific methods into these operations where straightforward.

Do not build a full SQL semantic analyzer.

==================================================
SECURITY / STATIC ANALYSIS INVARIANTS
==================================================

The detector must be:
- static
- deterministic
- side-effect free
- bounded
- safe against malformed source

Never:
- execute customer repository code
- import customer modules
- evaluate arbitrary expressions
- connect to DBs
- inspect environment secrets
- invoke ORM constructors
- execute query builders

Malformed files should produce diagnostics or safe skips, following the error-handling conventions established by previous detectors.

==================================================
INTEGRATION
==================================================

Add the detector consistently with:

apps/workers/src/detect/
apps/workers/src/symbols/
apps/workers/src/modules/
apps/workers/src/routes/
apps/workers/src/events/

Prefer something like:

apps/workers/src/database/detector.ts
apps/workers/src/database/detector.test.ts

or the repository's established naming convention after inspection.

Update:
- shared-types exports
- workers exports
- test script only if required by the current test architecture

Do not alter the existing Fluxora application database implementation.
Do not alter `packages/db/src/repositories/*` unless required only for unrelated type/build compatibility.

==================================================
TESTS
==================================================

Add focused Step 23 tests covering at minimum:

1. Prisma read
2. Prisma create
3. Prisma update
4. Prisma delete
5. Prisma upsert
6. Prisma raw query/execute
7. Drizzle select/from
8. Drizzle insert
9. Drizzle update
10. Drizzle delete
11. Drizzle table/resource extraction
12. TypeORM repository read
13. TypeORM repository write
14. TypeORM EntityManager operation
15. TypeORM getRepository(entity) operation
16. Sequelize read
17. Sequelize create
18. Sequelize update/delete
19. Sequelize upsert
20. static resource/model/table extraction
21. unresolved dynamic resource
22. unrelated `.findMany()` false-positive rejection
23. unrelated `.save()` false-positive rejection
24. unrelated `.create()` false-positive rejection
25. deterministic ordering / deterministic IDs
26. ignored directories are skipped
27. malformed source handled safely
28. synthetic multi-file repository fixture covering all supported families

Also scan the existing golden fixture and verify that ordinary Next.js/application code does not create obvious false-positive DB references.

Do NOT fabricate database references in the golden fixture merely to inflate counts.

==================================================
GOLDEN FIXTURE
==================================================

First inspect the existing golden fixture.

If it already contains supported ORM patterns, assert representative detections.

If it does not, use a small dedicated synthetic fixture for Step 23 rather than changing the golden repository unnecessarily.

Step 26 will handle complete full-pipeline golden verification.

==================================================
VERIFICATION
==================================================

Run:

pnpm lint
pnpm typecheck
pnpm test
pnpm build

Also run the focused Step 23 detector test directly.

Report exact results and test counts.

If an unrelated pre-existing failure occurs, identify it explicitly rather than silently modifying unrelated code.

==================================================
DOCUMENTATION
==================================================

Create:

learning/implementations/phase-03/step-23-database-reference-detection.md

learning/notes/22. Database Reference Detection.md

learning/interviews/23. Step 23 Database Reference Detection Interview CheatSheet.md

Update:

docs/DESIGN.md

Add the Step 23 architecture/details without deleting or rewriting previous sections.

Documentation must explain:
- supported ORM families
- operation taxonomy
- provenance rules
- static resource resolution
- unresolved dynamic references
- false-positive prevention
- security/static-analysis invariants
- deterministic IDs/order
- limitations
- explicit Step 24+ boundary

==================================================
STRICT SCOPE BOUNDARY
==================================================

DO NOT implement:

- tree-sitter fallback — Step 24
- normalization/barrel-file resolution/symbol dedup — Step 25
- full Phase 3 pipeline verification — Step 26
- GraphNode / GraphEdge / Evidence tables — Phase 4 / Step 27+
- graph construction
- graph traversal
- database persistence for extracted intelligence
- runtime DB inspection
- SQL parsing engine
- AI/LLM analysis
- UI
- PR impact analysis
- simulation
- event detection changes from Step 22 unless a minimal compatibility fix is absolutely required

Step 23 is EXTRACTION ONLY.

At the end provide:

1. files created
2. files modified
3. supported ORM patterns
4. operation mappings
5. provenance rules
6. focused test count/results
7. full lint/typecheck/test/build results
8. limitations
9. exact recommended commit message

Do not refactor unrelated code.
Do not broaden Step 23 beyond the explicit pattern library above.