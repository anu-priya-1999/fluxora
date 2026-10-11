You are implementing ONLY Fluxora Global Step 32.

IMPORTANT:
- Do NOT implement Step 33 or any later step.
- Do NOT refactor unrelated code.
- Do NOT change the Step 31 public API contract unless Step 32 absolutely requires a minimal internal adjustment.
- Preserve the existing architecture, naming, conventions, error handling, RLS/tenant isolation, deterministic behavior, and testing style.
- Continue the exact learning/documentation pattern used in Steps 18–31.
- Before changing anything, inspect the latest repository state and actual implementation. Do not assume files are unchanged.

==================================================
1. FIRST: INSPECT THE CURRENT REPO
==================================================

Inspect:

1. latest git history:
   - git log -n 10 --oneline

2. canonical roadmap:
   - docs/architecture/17-implementation-roadmap.md

3. architecture/design:
   - docs/DESIGN.md
   - relevant graph/API sections

4. Step 27:
   - GraphNode / GraphEdge / Evidence persistence
   - graph storage migration
   - graph repository code

5. Step 28:
   - graph builder
   - deterministic graph projection
   - persistence flow
   - transaction boundaries

6. Step 29:
   - EvidenceWriter
   - evidence lint
   - graph-write invariants

7. Step 30:
   - traverseGraph
   - traversal result types
   - tenant/run scoping

8. Step 31:
   - POST /api/v1/graph/query
   - request/response contracts
   - current HTTP routing
   - authentication
   - tenant derivation
   - current tests

9. existing event / async infrastructure anywhere in the repository.

Understand the ACTUAL current code before implementing.

==================================================
2. STEP 32 SCOPE
==================================================

Implement ONLY the Step 32 graph-update notification/diff capability defined by the canonical roadmap and current architecture.

The intended capability is:

Graph mutation
      ↓
detect previous graph state vs new graph state
      ↓
create deterministic graph diff summary
      ↓
emit `graph.updated`
      ↓
consumers can know what changed

The Step 32 implementation must establish a clean domain/event boundary around graph updates.

At minimum, cover the Step 32 concepts already identified in the architecture:

- `graph.updated` event
- graph diff summary
- deterministic change classification
- tenant/organization scoping
- analysis-run scoping
- changed nodes
- changed edges
- meaningful summary counts
- provenance / correlation metadata where the existing architecture supports it

If the canonical roadmap explicitly requires a transport/broadcast mechanism for Step 32, implement ONLY that mechanism using the existing architecture.
Do NOT invent a new messaging platform or introduce an unrelated infrastructure dependency.

If the roadmap distinguishes domain event creation from transport/broadcasting, preserve that separation.

==================================================
3. CORE DESIGN REQUIREMENTS
==================================================

### A. Graph update event

Create or extend the smallest appropriate shared contract for:

`graph.updated`

The event must have a stable, explicit schema.

It should contain the minimum information needed for downstream consumers to understand:

- organization/tenant
- analysis run
- event type
- graph version/change identity or equivalent correlation value
- timestamp if the architecture requires it
- diff summary
- changed node information
- changed edge information
- useful correlation metadata already supported by the repository

Do NOT put arbitrary raw database rows into the event.

Do NOT expose secrets.

Do NOT expose another tenant's information.

Prefer strongly typed shared contracts rather than duplicated inline object shapes.

==================================================
4. GRAPH DIFF
==================================================

Implement a deterministic graph diff between the relevant "before" and "after" graph states.

The diff must distinguish at least:

- nodes added
- nodes removed
- nodes changed, where the existing domain model supports meaningful mutation detection

and:

- edges added
- edges removed
- edges changed, where meaningful mutation detection is supported

Use the existing canonical graph identifiers.

Do NOT generate fake IDs.

Do NOT compare unstable database ordering.

Do NOT rely on object insertion order.

Sort output deterministically.

Repeatedly computing the diff for identical inputs MUST produce identical results.

The summary should expose useful counts, for example:

- nodes_added
- nodes_removed
- nodes_changed
- edges_added
- edges_removed
- edges_changed

Use names consistent with the actual repository conventions rather than blindly copying these names if the codebase already has an established terminology.

==================================================
5. WHERE THE DIFF IS GENERATED
==================================================

Inspect the existing Step 28 graph persistence flow carefully.

Choose the smallest correct integration point for generating the Step 32 graph diff.

Prefer:

old graph state
    +
new graph state
    ↓
diff
    ↓
persist graph mutation atomically
    ↓
publish/emit `graph.updated`

The graph write itself must remain authoritative.

Do NOT create an event for a graph write that actually failed.

Do NOT publish a successful-looking event before the transaction has established the successful graph state.

Preserve the existing transaction semantics.

If the current architecture does not yet have a durable event/outbox mechanism, do NOT silently invent a large event system.

Instead, implement the smallest architecture-consistent boundary required by Step 32 and document the reliability limitation explicitly.

Do NOT implement a production-grade distributed event bus unless the roadmap explicitly requires it.

==================================================
6. IDEMPOTENCY / DETERMINISM
==================================================

Step 28 already established deterministic graph persistence.

Step 32 must preserve that property.

Repeated processing of the same graph state must NOT create misleading duplicate updates.

Define the event/diff identity deterministically where the architecture requires idempotency.

At minimum test:

- identical before/after graph => empty diff
- same input twice => same diff
- same graph update processed twice => no false "new change"
- deterministic ordering of nodes and edges

If the current architecture already has a suitable event identity or idempotency convention, reuse it rather than creating another competing mechanism.

==================================================
7. TENANT / SECURITY INVARIANTS
==================================================

Preserve the existing Fluxora security model.

The event and diff must remain tenant-scoped.

Never trust organization ID from an untrusted request payload.

Never mix graph state from different organizations.

Never compare or emit graph objects across tenants.

Respect analysis_run_id boundaries.

If a query or comparison cannot access a previous graph because of RLS, do not bypass RLS.

Do NOT introduce service-role shortcuts merely to make tests pass.

Add tests proving cross-tenant isolation.

==================================================
8. TRANSPORT / BROADCASTING
==================================================

Inspect the canonical roadmap and existing repository architecture first.

If Step 32 requires a transport/broadcast layer, use the smallest existing-compatible abstraction.

The domain layer should know about the `graph.updated` event contract, not about UI implementation details.

Do NOT couple graph persistence directly to React/UI code.

Do NOT implement React Flow.

Do NOT implement Phase 5.

Do NOT add general WebSocket infrastructure unless it is explicitly required by the canonical Step 32 definition.

If an existing WebSocket layer already exists and Step 32 explicitly requires graph-update broadcasting, integrate with that existing layer rather than redesigning it.

==================================================
9. TESTS
==================================================

Add focused Step 32 tests.

Cover at least:

1. empty diff
2. added node
3. removed node
4. changed node
5. added edge
6. removed edge
7. changed edge
8. combined node + edge changes
9. deterministic ordering
10. deterministic repeated diff
11. deterministic event payload
12. idempotent/repeated update behavior
13. tenant isolation
14. analysis-run isolation
15. failed graph transaction does not emit a successful update event
16. event contains correct diff summary
17. event never exposes raw unrelated DB fields
18. existing Step 27–31 tests remain green

Use the repository's existing test framework and testing conventions.

Do NOT migrate to Vitest here.
Do NOT introduce a new test framework.

==================================================
10. OBSERVABILITY / CORRELATION
==================================================

Where the repository already has correlation IDs, request IDs, analysis-run IDs, or similar metadata, reuse them.

Do not invent a parallel observability system.

Keep the event payload compact and purposeful.

==================================================
11. DOCUMENTATION — REQUIRED
==================================================

Continue the EXACT documentation pattern from previous steps.

Create:

`learning/implementations/phase-04/step-32-graph-updated-events.md`

Create:

`learning/notes/`
with the next appropriately numbered Step 32 engineering note, using the same naming and detail level as previous notes.

Create:

`learning/interviews/32. Step 32 Graph Updated Events Interview CheatSheet.md`

Update:

`docs/DESIGN.md`

Add the next Step 32 section without deleting or rewriting older sections.

The documentation MUST explain in plain English:

- what Step 32 does
- why a graph-update event is needed
- what a graph diff is
- how "before" and "after" states are compared
- how node/edge additions/removals/changes are determined
- why deterministic ordering matters
- how idempotency works
- how tenant isolation is preserved
- when the event is emitted
- transaction/event consistency
- what happens when graph persistence fails
- what transport is used, if any
- what limitations remain
- why the design does not jump ahead into later phases
- exact data flow
- important invariants
- interview questions and answers

The implementation document should contain concrete file-level details and verification results.

The engineering note should teach the underlying engineering concepts.

The interview cheat sheet should be concise but technically strong.

==================================================
12. DESIGN DIAGRAM
==================================================

Update `docs/DESIGN.md` with a clear Step 32 data-flow diagram similar in style to the existing architecture documentation.

Conceptually:

Graph Build / Mutation
        |
        v
Previous Graph State ----+
                         |
New Graph State ---------+--> Deterministic Diff
                                |
                                v
                         GraphUpdated Event
                                |
                                v
                    Existing Event/Transport Layer
                                |
                                v
                         Future Consumers

Use the actual architecture discovered in the repository.

Do NOT document architecture that was not implemented.

==================================================
13. STRICT STEP BOUNDARY
==================================================

DO NOT implement:

- Step 33 golden fixture graph verification
- Phase 5 UI / React Flow visualization
- graph canvas
- real-time UI rendering
- AI reasoning
- LLM integration
- PR impact analysis
- caching
- unrelated event infrastructure
- database redesign
- Vitest migration
- broad refactoring

Step 32 only.

==================================================
14. VERIFICATION
==================================================

After implementation, run the smallest relevant tests first.

Then run:

- focused Step 32 tests
- existing API tests
- existing DB graph tests
- existing workers tests
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- `pnpm lint:evidence`
- `git diff --check`

Use the correct existing commands discovered from package.json.

Do not claim a test passed unless it actually passed.

Report:

- exact files created
- exact files modified
- what changed
- tests run + exact results
- any intentionally skipped tests and why
- any architecture limitation
- confirmation that Step 33+ was not implemented

==================================================
15. FINAL IMPLEMENTATION REPORT
==================================================

At the end, provide a concise report containing:

### Created
[file list]

### Modified
[file list]

### Step 32 behavior
[plain-English explanation]

### Event contract
[actual implemented contract]

### Diff algorithm
[actual implemented behavior]

### Security / tenancy
[actual guarantees]

### Idempotency / determinism
[actual guarantees]

### Verification
[real command results]

### Step boundary
[explicit confirmation]

### Recommended commit message
Use:

`feat(graph): add graph updated events and diff summary`

Do NOT fabricate results or claim files were created if they were not.