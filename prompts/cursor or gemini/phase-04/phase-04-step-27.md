Implement ONLY Fluxora Global Step 27: Graph Storage — GraphNode, GraphEdge, and Evidence persistence.

Do not implement any part of Steps 28+.

Before changing anything:
1. Inspect the current repository state and latest Git history.
2. Read the canonical architecture and database documentation, especially:
   - docs/architecture/17-implementation-roadmap.md
   - the current database schema architecture/documentation
   - existing PostgreSQL migrations
   - existing RLS/tenant-scoping patterns
   - current repository/snapshot/analysis-run data model
   - existing database test conventions
3. Inspect the actual existing implementation instead of assuming names, IDs, foreign keys, RLS helpers, or migration numbering.
4. Reuse existing conventions exactly. Do not introduce a parallel persistence architecture.

GOAL

Create the database persistence layer required for the Phase 4 graph.

Add these three logical persistence models:

1. GraphNode
2. GraphEdge
3. Evidence

The implementation must support the graph produced later by Step 28 while remaining completely independent of the graph-building logic.

IMPORTANT BOUNDARY

This step is STORAGE ONLY.

Do NOT implement:
- graph building
- graph traversal
- recursive CTE queries
- graph query API
- graph diff generation
- graph.updated events
- UI
- LLM/AI processing
- AST extraction changes
- changes to Steps 18–26
- Vitest migration
- any Phase 5 work

The existing Phase 3 pipeline must remain unchanged.

DATABASE DESIGN

Design the tables from the existing Fluxora architecture rather than inventing a new tenancy model.

The three tables must:

- be tenant-safe according to the existing Fluxora organization/RLS conventions
- correctly associate graph data with the appropriate analysis/repository snapshot/run scope used by the current architecture
- use foreign keys wherever the existing schema supports them
- have deterministic primary keys/identity strategy consistent with the existing DB design
- have appropriate uniqueness constraints
- have appropriate indexes for the access patterns expected by later graph steps
- preserve referential integrity
- avoid mutable relationships that would allow graph records to escape their tenant or analysis scope

GRAPH NODE

Persist the canonical nodes that later graph construction will create.

The schema must support at minimum the concepts already established by Phase 3 normalization:

- canonical node identity
- node kind/type
- repository/analysis scope
- enough structured metadata to represent the normalized node without forcing later steps to redesign the table

Do not duplicate the entire Phase 3 normalized object blindly.

GRAPH EDGE

Persist directed relationships between graph nodes.

The schema must support:

- source node
- target node
- edge kind/type
- repository/analysis scope
- deterministic identity / uniqueness
- enough structured metadata for later evidence linking

The design must make it possible for Step 28 to insert edges without changing the schema.

EVIDENCE

Persist the provenance/evidence that explains why a graph node or edge exists.

Reuse the repository's existing provenance terminology and conventions.

Evidence should be able to point back to the relevant repository/snapshot/source location and preserve the information necessary for later inspection/debugging.

Do not add speculative AI-generated explanations.

RLS / TENANCY

Follow the same RLS model already used by Fluxora.

Requirements:

- no cross-organization reads
- no cross-organization inserts
- no cross-organization updates/deletes
- child graph records must not bypass parent tenant boundaries
- service/database access must use the same organization context mechanism already established elsewhere

Do NOT invent a second RLS implementation.

INDEXING

Add only indexes justified by the architecture and upcoming Step 28–33 access patterns.

At minimum consider the existing tenancy/scope keys and the node/edge lookup patterns that later graph construction will need.

Do not blindly index every column.

MIGRATION

Create the next correctly numbered PostgreSQL migration using the existing migration conventions.

The migration must:
- be deterministic
- be reversible only if that is already the project's convention
- preserve existing data
- not modify unrelated tables
- include constraints, indexes, and RLS/policies required by this step

TESTS

Add focused tests following the existing database-test style.

Cover at minimum:

1. tables are created correctly
2. GraphNode can be inserted/read within the correct tenant/scope
3. GraphEdge can be inserted/read within the correct tenant/scope
4. Evidence can be inserted/read within the correct tenant/scope
5. required foreign-key relationships work
6. uniqueness constraints behave deterministically
7. invalid references are rejected
8. cross-tenant access is rejected
9. graph records cannot bypass parent tenant boundaries
10. relevant indexes/constraints exist where the existing project test style verifies schema metadata

Use real PostgreSQL integration where the repository's existing tests use the database.

Do not weaken existing RLS just to make tests pass.

SHARED TYPES / DB ACCESS

Only add or modify shared TypeScript types or DB-layer code when required by the existing architecture for this storage step.

Reuse current package boundaries and naming conventions.

Do not create graph-building services or repositories that belong to Step 28 unless a minimal persistence abstraction is explicitly required by the existing DB architecture.

DOCUMENTATION — MANDATORY

Preserve the exact learning workflow used in Steps 1–26.

Create:

learning/implementations/phase-04/<step-27 implementation file following the existing naming convention>
learning/notes/<next sequential graph-storage note following the existing naming convention>
learning/interviews/<step-27 interview cheatsheet following the existing naming convention>

Update:

docs/DESIGN.md

Do not delete or rewrite unrelated documentation.

The Step 27 implementation document must explain in plain English:

- what GraphNode is
- what GraphEdge is
- what Evidence is
- why graph persistence is separate from graph construction
- how tenant isolation works
- how analysis/repository/snapshot scope works
- why the chosen foreign keys exist
- why the chosen indexes exist
- how uniqueness prevents duplicate graph records
- what guarantees the database provides
- what this step deliberately does NOT do
- how Step 28 will consume this storage layer

The learning notes must teach the underlying concepts, not merely list files changed.

The interview cheatsheet must cover questions such as:

- Why store a graph in relational tables?
- Why separate nodes, edges, and evidence?
- How would you model a directed graph in PostgreSQL?
- Why are tenant keys important on child tables?
- How does RLS protect graph data?
- What is the difference between a node identity and a database primary key?
- Why are uniqueness constraints important for graph ingestion?
- Why do indexes matter for later graph construction?
- Why is evidence a separate table?
- What would go wrong if graph data were stored without analysis/snapshot scoping?
- Why is Step 27 storage-only instead of building the graph now?

DESIGN.md

Add a Step 27 architecture section consistent with the existing DESIGN.md structure.

Include a simple data-flow diagram showing the relationship conceptually:

Repository / Snapshot / Analysis scope
        ↓
     GraphNode
        ↓
     GraphEdge
        ↓
     Evidence / provenance

Use the actual existing architecture terminology when the repository differs from this conceptual diagram.

VERIFICATION

After implementation, run the repository's normal verification commands appropriate to the current workspace:

- migration/test command(s) required by the existing DB setup
- pnpm typecheck
- pnpm lint
- pnpm test
- pnpm build

Do not claim success unless the commands actually pass.

Also run the new Step 27 focused database tests separately and report their exact result.

FINAL REPORT

At the end, report:

1. files created
2. files modified
3. migration created
4. tables and important constraints/indexes added
5. RLS/tenant isolation behavior
6. focused test result
7. full test result
8. typecheck/lint/build result
9. exact Step 28 boundary

Do NOT implement anything beyond Global Step 27.