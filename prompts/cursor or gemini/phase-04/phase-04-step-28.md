Implement ONLY Fluxora Global Step 28: Graph Builder.

Do NOT implement Steps 29+.

Before changing anything:
1. Inspect the latest Git history and current working tree.
2. Read:
   - docs/architecture/17-implementation-roadmap.md
   - docs/DESIGN.md
   - the current Graph Storage migration created in Step 27
   - current GraphNode / GraphEdge / Evidence shared types
   - current Step 25 normalization contract
   - current Step 26 Phase 3 pipeline output contract
   - existing DB repository/test conventions
   - existing RLS / tenant / analysis-run / snapshot scoping conventions
3. Reuse the actual current repository contracts and names. Do not invent parallel types, IDs, scopes, or persistence patterns.

GOAL

Implement the Graph Builder that transforms the already-existing Phase 3 normalized analysis result into the GraphNode, GraphEdge, and Evidence records created by Step 27.

Conceptually:

Repository Snapshot
       │
       ▼
Phase 3 analysis
       │
       ▼
Normalized result
       │
       ▼
Graph Builder
       │
       ├───────────────┐
       ▼               ▼
   GraphNode       GraphEdge
       │               │
       └───────┬───────┘
               ▼
            Evidence
               │
               ▼
          PostgreSQL

IMPORTANT BOUNDARY

This step is GRAPH CONSTRUCTION ONLY.

Do NOT implement:
- graph query API
- recursive CTE traversal
- graph querying
- graph diff generation
- graph.updated events
- UI
- graph visualization
- LLM/AI enrichment
- new AST/symbol/import/event/database extraction
- Tree-sitter changes
- Step 29 evidence writer architecture beyond what is strictly required for Step 28 integration
- Step 30+ traversal
- Step 31 API
- Step 32 events/diff
- Step 33 golden graph verification as a separate roadmap step

Use the existing Phase 3 result as the source of truth.

GRAPH CONSTRUCTION

The builder must consume the existing normalized Phase 3 output from Step 25/26.

Build graph nodes from canonical normalized symbols/entities.

Build directed graph edges from normalized relationships.

At minimum preserve the relationships already established by Phase 3, including the applicable:
- module/import/export relationships
- canonical symbol relationships
- route relationships
- event relationships
- database-reference relationships

Do NOT invent semantic relationships that Phase 3 does not prove.

The graph builder should be deterministic.

Given the same normalized analysis input:
- the same nodes must be produced
- the same edges must be produced
- the same evidence references must be produced
- ordering must be deterministic

CANONICAL IDS

Reuse the canonical IDs already established by Step 25.

Do NOT create a second identity scheme.

The builder should map:

normalized canonical entity
        ↓
GraphNode identity

and:

normalized relationship
        ↓
GraphEdge identity

If the existing Step 27 schema separates database IDs from canonical graph IDs, preserve that distinction exactly.

TENANCY / SCOPE

Every persisted graph record must remain inside the correct existing Fluxora scope.

Follow the Step 27 schema and existing RLS conventions.

The builder must NOT allow:
- cross-organization graph records
- cross-repository graph records
- cross-snapshot contamination
- cross-analysis-run contamination when the current architecture scopes graph data that way

Do not bypass RLS.

Do not create a new tenancy mechanism.

IDEMPOTENCY

Running the Graph Builder twice for the same analysis/snapshot must not create duplicate graph records.

Use the constraints and persistence conventions introduced by Step 27.

The desired behavior is conceptually:

First run:
  nodes: inserted
  edges: inserted
  evidence: inserted

Second identical run:
  nodes: unchanged
  edges: unchanged
  evidence: unchanged
  no duplicates

Do not implement a destructive “delete everything and rebuild” strategy unless the existing architecture explicitly requires that behavior.

TRANSACTIONAL BEHAVIOR

Use the existing database transaction conventions.

The builder must avoid leaving an analysis in a partially written graph state where the architecture expects atomic graph construction.

Think carefully about:

normalized input
      │
      ▼
validation
      │
      ▼
graph records prepared
      │
      ▼
database transaction
      │
      ├── nodes
      ├── edges
      └── evidence
      │
      ▼
commit

If the repository already has an established transaction abstraction, reuse it.

EVIDENCE

Use the Evidence model from Step 27 to preserve provenance from the Phase 3 normalized result.

Do not invent AI-generated explanations.

Evidence should answer:

“Why does this graph node/edge exist?”

Preserve source/path/line/range or the equivalent provenance already available in the existing normalized contracts.

Do not lose provenance during normalization → graph conversion.

DETERMINISTIC ORDERING

Sort graph input before persistence wherever necessary.

Do not rely on:
- object property iteration order as an identity mechanism
- filesystem traversal order
- database incidental ordering

The same analysis must generate the same graph deterministically.

GRAPH VALIDATION

Before insertion, validate invariants such as:

- every edge source exists
- every edge target exists
- every graph record has the correct scope
- canonical IDs are valid
- unsupported/unresolved relationships are not accidentally converted into fake graph nodes
- evidence references point to valid graph/source context
- duplicate logical records collapse according to Step 27 constraints

Unresolved Phase 3 relationships should remain unresolved when the architecture says they must remain unresolved. Do not fabricate nodes merely to make an edge insertable.

NORMALIZED INPUT → GRAPH MAPPING

Create a clear internal mapping layer instead of scattering conversion logic across DB calls.

Conceptually:

Phase3NormalizedResult
        │
        ▼
  Graph Projection
        │
        ├── Node records
        ├── Edge records
        └── Evidence records
        │
        ▼
  Persistence layer

Keep this conversion testable without requiring PostgreSQL wherever practical.

TESTS

Add focused Step 28 tests following the repository's existing conventions.

Test at minimum:

1. normalized symbols become GraphNodes
2. normalized module relationships become directed GraphEdges
3. canonical symbol IDs are preserved
4. multiple aliases to the same canonical symbol do not create duplicate GraphNodes
5. same symbol name in different files remains distinct
6. route relationships are represented correctly when present
7. event relationships are represented correctly when present
8. database-reference relationships are represented correctly when present
9. Evidence preserves source provenance
10. deterministic input produces deterministic graph output
11. running the same graph build twice is idempotent
12. invalid/missing edge endpoints are rejected safely
13. unresolved relationships are not fabricated into false nodes
14. graph records retain correct organization/scope
15. cross-tenant/cross-scope writes are rejected according to existing RLS behavior
16. transaction failure does not leave an invalid partial graph when the existing architecture expects atomicity

Use integration tests against PostgreSQL for persistence/RLS behavior where that matches the repository's existing testing pattern.

Do not weaken RLS for tests.

GOLDEN FIXTURE

Use the existing golden fixture only as an input to the Graph Builder tests.

Do not change the golden fixture files.

Verify representative graph construction from the existing Phase 3 output.

Do not turn this into the full Step 33 golden graph verification task.

Keep Step 28 focused on construction correctness.

SHARED TYPES

Only add or modify shared types when genuinely required by the Graph Builder.

Prefer existing Step 25/Step 27 types.

Do not create duplicate graph contracts.

DATABASE LAYER

Reuse the Step 27 graph persistence repository/API if one exists.

If Step 27 intentionally exposed only low-level primitives, add the smallest Graph Builder-facing abstraction needed.

Do not create a second database abstraction layer.

ARCHITECTURE DOCUMENTATION — MANDATORY

Preserve the exact learning workflow used in previous steps.

Create:

learning/implementations/phase-04/<step-28 implementation file following the existing naming convention>

learning/notes/<next sequential graph-builder note following the existing naming convention>

learning/interviews/28. Step 28 Graph Builder Interview CheatSheet.md

Update:

docs/DESIGN.md

Do not delete unrelated documentation.

The implementation document must explain in plain English:

- what the Graph Builder does
- why Graph Builder is separate from Graph Storage
- how Phase 3 normalized output becomes graph records
- how canonical IDs are preserved
- how nodes and edges are mapped
- how evidence/provenance flows through the system
- how deterministic graph construction works
- how idempotency works
- how tenant/snapshot/analysis isolation works
- how transaction boundaries work
- what happens to unresolved relationships
- why the builder must not invent relationships
- what Step 28 deliberately does NOT do
- how Step 29 will extend the evidence/persistence pipeline

LEARNING NOTES

Teach these concepts in plain English:

- graph projection
- graph node vs graph edge
- canonical identity
- deterministic graph construction
- idempotency
- referential integrity
- provenance
- transactional graph writes
- tenant isolation
- why graph builders should be deterministic

Use small concrete examples.

For example:

File A:
  export function login() {}

File B:
  import { login } from "./A";

Conceptually:

GraphNode:
  A#function:login

GraphNode:
  B#import-binding:login
  (only if the existing graph model actually represents this as a node)

GraphEdge:
  B → A
  kind = imports

Only use the actual Fluxora graph model when implementing; the example is explanatory.

INTERVIEW CHEATSHEET

Include senior interview questions such as:

- Why separate graph storage from graph construction?
- Why is deterministic graph construction important?
- How do you make a graph builder idempotent?
- How do canonical IDs prevent duplicate nodes?
- How would you handle unresolved imports?
- Why should a graph builder avoid inventing relationships?
- How do you preserve evidence/provenance?
- What transaction guarantees should graph construction provide?
- How do you prevent cross-tenant graph contamination?
- What happens if an edge points to a missing node?
- How would you scale graph construction for a very large repository?
- Why might you batch inserts?
- What are the trade-offs between rebuilding and incremental graph updates?

DESIGN.md

Add the Step 28 architecture section consistent with the current document.

Include a properly aligned ASCII diagram similar to:

Phase 3 normalized output
            │
            ▼
      Graph Builder
            │
      ┌─────┼─────┐
      ▼     ▼     ▼
    Nodes  Edges Evidence
      │     │     │
      └─────┼─────┘
            ▼
        PostgreSQL

Use the repository's actual terminology where it differs.

VERIFICATION

After implementation, run the appropriate commands:

1. migration/database prerequisites if required
2. focused Step 28 tests
3. pnpm typecheck
4. pnpm lint
5. pnpm test
6. pnpm build

Report the exact results.

Do not claim success without actual command output.

FINAL REPORT

Report:

1. files created
2. files modified
3. Graph Builder entry point/API
4. Phase 3 → graph mapping
5. node/edge/evidence behavior
6. idempotency behavior
7. tenant/scope/RLS behavior
8. transaction behavior
9. focused test count/result
10. full test count/result
11. typecheck/lint/build result
12. exact Step 29+ boundary

CRITICAL:
Implement ONLY Global Step 28.
Do not implement Step 29, 30, 31, 32, or 33 functionality.
Do not migrate the test framework to Vitest.
Do not refactor unrelated code.
Do not modify Steps 18–26 behavior unless a strictly necessary compatibility fix is discovered and documented.
Use one focused implementation pass.