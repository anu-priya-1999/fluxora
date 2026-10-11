# Fluxora Global Step 30 — Bounded-Depth Recursive-CTE Graph Traversal

Implement **Global Step 30 ONLY** in the existing Fluxora monorepo.

## 1. Inspect the architecture first

Before editing any files, inspect:

- `docs/architecture/17-implementation-roadmap.md`
- `docs/DESIGN.md`
- The relevant graph and database architecture documents in `docs/architecture/00–22`
- `packages/db/src/repositories/graph.ts`
- `packages/db/src/repositories/evidence-writer.ts`
- `packages/shared-types/src/graph.ts`
- The graph-storage migration, especially the actual `GraphNode`, `GraphEdge`, and `Evidence` schemas
- Existing PostgreSQL transaction, tenant/RLS, repository, and test conventions
- Existing `AGENTS.md`, `CURSOR.md`, and `.cursor/rules/`, if present

The authoritative Phase 4 roadmap item is:

**Implement bounded-depth recursive-CTE graph traversal as a reusable internal query function.**

Reuse the existing schema, types, abstractions, graph direction semantics, and security conventions. Do not guess column names or introduce a competing architecture.

## 2. Implement the traversal function

Create or extend the appropriate graph repository abstraction to support bounded-depth traversal using a **PostgreSQL recursive CTE**.

Requirements:

1. Accept a valid starting graph node and a validated `maxDepth`.
2. Enforce a hard upper bound on traversal depth. Reject invalid depth values instead of silently allowing unbounded queries.
3. Scope every traversal to the correct organization/tenant, analysis run, and applicable graph scope.
4. Apply scope restrictions in both the recursive CTE's anchor query and recursive term.
5. Follow the existing directed-edge semantics. Do not silently traverse edges in reverse unless explicitly supported by the architecture.
6. Handle cycles using an explicit visited-path or equivalent cycle-prevention strategy appropriate to the actual schema.
7. Ensure traversal terminates for cyclic graphs and does not produce unintended duplicate results when multiple paths reach the same node.
8. Return the fields required by the existing architecture, including traversal depth and the relevant graph relationships.
9. Apply a deterministic ordering policy where result ordering matters.
10. Correctly handle missing starting nodes, empty results, disconnected components, and graph boundaries.
11. Use parameterized SQL for runtime values. Never interpolate user-controlled values into SQL.
12. Reuse existing transactions and tenant/RLS conventions. Do not weaken authorization or isolation.
13. Preserve graph provenance and evidence associations. Do not fabricate evidence, relationships, nodes, or source locations.
14. Avoid N+1 database queries and unnecessary database round trips.
15. Keep the function reusable internally; do not introduce an unrestricted arbitrary graph-query engine.

Inspect the schema before deciding whether a migration is necessary. Do not add one unless the implementation genuinely requires it.

## 3. Add focused tests

Use the existing database-testing infrastructure and conventions. Test the actual recursive SQL against PostgreSQL where available; mocks alone are insufficient to verify recursive-CTE behavior.

Cover at least:

- Linear graph chains.
- Fan-out and fan-in relationships.
- Cyclic graphs; traversal must terminate.
- Disconnected components.
- A starting node with no outgoing relationships.
- A depth-zero query, if zero is supported by the chosen contract.
- Nodes exactly at the configured maximum depth.
- Nodes one hop beyond the maximum depth.
- Invalid depths and the hard depth cap.
- Missing or invalid starting-node references.
- Repeated paths to the same node.
- Deterministic results across repeated executions.
- Tenant isolation and cross-tenant access rejection.
- Analysis-run and graph-scope isolation.
- Empty graph results.
- Evidence/provenance preservation where returned by the query.

Use synthetic fixtures with hand-verified expected results. Follow existing project conventions for database setup and RLS tests.

## 4. Security and correctness

Ensure that:

- A caller cannot use traversal to access another tenant's graph.
- The starting node and all recursively reached records belong to the authorized scope.
- A cycle cannot create infinite recursion.
- Depth limits are enforced server-side.
- Invalid input fails safely.
- No raw SQL execution capability is exposed to callers.
- Existing Evidence Writer behavior and graph-write invariants remain unchanged.

Do not execute customer repository code during static analysis.

## 5. Strict scope boundary

This task is **only Global Step 30**.

Do NOT implement:

- `POST /api/v1/graph/query` or other graph-query HTTP endpoints.
- `graph.updated` events or graph-diff summaries.
- Graph visualization or frontend changes.
- PR impact analysis.
- Simulation, AI reasoning, or later roadmap steps.
- Unrelated refactors or speculative features.

Do not create `README.md` or `AGENTS.md` as part of this implementation task. Those are separate documentation work.

## 6. Documentation

Update existing documentation without deleting unrelated content.

Create:

- `learning/implementations/phase-04/step-30-graph-traversal.md`
- `learning/interviews/30. Step 30 Graph Traversal Interview CheatSheet.md`
- A Step 30 learning note in `learning/notes/`, following the established naming convention

Update `docs/DESIGN.md` to record Step 30's actual implementation status and the correct next roadmap item.

The implementation notes must explain in plain English:

- What a graph traversal does.
- What a recursive CTE is.
- How the anchor query and recursive term work.
- How the maximum depth is enforced.
- How cycles and duplicate paths are handled.
- How tenant/RLS and analysis-run isolation are preserved.
- Why this implementation avoids unrestricted graph queries.
- What was tested and what remains incomplete.

Do not claim a feature is complete until it is implemented and verified.

## 7. Verification

Run the relevant focused tests first, followed by these root commands:

`pnpm lint:evidence`

`pnpm typecheck`

`pnpm lint`

`pnpm test`

`pnpm build`

Review the final diff using `git diff --check` and `git status`.

Fix failures introduced by Step 30 without expanding scope. Report every command's actual result; distinguish failed checks, skipped tests, and tests that could not run due to missing infrastructure.

## 8. Final implementation report

At completion, report:

1. Files created and modified.
2. The traversal function's API and return shape.
3. How the recursive CTE works, explained in plain English.
4. The cycle-prevention and depth-limit strategies.
5. Tenant/RLS and evidence guarantees.
6. Focused test results and full verification results.
7. Remaining limitations or unresolved issues.
8. Confirmation that no Step 31+ functionality was implemented.
9. The recommended Git commit message.

Do not commit, push, or deploy automatically.

### Definition of done

Fluxora has a reusable, tested PostgreSQL recursive-CTE traversal function that returns only reachable, in-scope graph results within a validated depth limit, terminates safely on cyclic graphs, preserves the established tenant/RLS and evidence architecture, and introduces no later-step functionality.