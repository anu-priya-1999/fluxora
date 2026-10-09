Implement ONLY Fluxora Global Step 25 — Normalization.

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
23 — Database reference detection
24 — Tree-sitter fallback pass

Roadmap definition:
“Implement the Normalizer (barrel-file resolution, symbol dedup).”

IMPORTANT:
Before editing anything, inspect the current repository and the actual output contracts of Steps 18–24.

Inspect at minimum:
- docs/architecture/17-implementation-roadmap.md
- docs/DESIGN.md
- packages/shared-types/src/index.ts
- packages/shared-types/src/detection.ts
- packages/shared-types/src/symbols.ts
- packages/shared-types/src/modules.ts
- packages/shared-types/src/routes.ts
- packages/shared-types/src/event-patterns.ts
- packages/shared-types/src/database-references.ts
- packages/shared-types/src/tree-sitter.ts
- apps/workers/src/detect/*
- apps/workers/src/symbols/*
- apps/workers/src/modules/*
- apps/workers/src/routes/*
- apps/workers/src/events/*
- apps/workers/src/database/*
- apps/workers/src/tree-sitter/*
- existing tests and golden fixture helpers

Do NOT refactor Steps 18–24 unnecessarily.

==================================================
GOAL
==================================================

Implement the Phase 3 Normalizer.

The normalizer takes the raw outputs produced by the existing code-intelligence detectors and produces a canonical, deterministic representation suitable for Step 26 full-pipeline verification and later Phase 4 graph construction.

The primary responsibilities are:

1. Barrel-file / re-export resolution
2. Symbol deduplication
3. Canonical identity generation
4. Deterministic ordering
5. Provenance/evidence preservation

The normalizer must NOT discover new relationships that the existing detectors did not provide.

It must normalize existing evidence.

==================================================
INPUTS
==================================================

Use the actual current detector result contracts discovered during repository inspection.

The normalizer may consume results from:
- symbol extraction
- module/import-export extraction
- route detection
- event producer/consumer detection
- database-reference detection
- Tree-sitter fallback metadata where relevant

Do NOT assume an input shape that does not exist.

Do NOT rewrite existing detector output contracts unless absolutely required for integration.

==================================================
1. BARREL-FILE / RE-EXPORT RESOLUTION
==================================================

Resolve straightforward barrel/re-export chains using the import/export information already extracted in Step 20.

Examples:

`index.ts`
  -> `export { foo } from "./foo"`
  -> `foo.ts`

or:

`index.ts`
  -> `export * from "./users"`
  -> `users/index.ts`
  -> `user.ts`

The normalizer should be able to identify the canonical underlying symbol/module when the existing static information makes that relationship deterministic.

Support:
- named re-exports
- `export *`
- namespace re-exports when represented by existing Step 20 output
- alias re-exports
- common `index.ts` barrel chains
- bounded/cycle-safe traversal

Do NOT perform arbitrary runtime module resolution.

Do NOT evaluate code.

Do NOT execute imports.

Do NOT invent relationships when the source graph cannot establish them.

==================================================
2. CYCLE SAFETY
==================================================

Barrel files and re-export graphs can contain cycles.

The normalizer must:
- terminate deterministically
- track visited modules/edges
- avoid infinite recursion
- preserve the original unresolved/cyclic evidence
- never silently drop a cycle

Add explicit cycle tests.

==================================================
3. SYMBOL DEDUPLICATION
==================================================

Multiple paths may refer to the same underlying symbol.

Deduplicate symbols using a deterministic canonical identity based on the strongest available static evidence.

Prefer a canonical identity derived from information such as:
- normalized file path
- symbol kind
- symbol name
- source range/position when necessary to disambiguate multiple declarations
- resolved underlying export target

Do NOT deduplicate merely because two symbols have the same name.

For example:

`users.ts -> function createUser`
`orders.ts -> function createUser`

must remain two distinct symbols.

But a barrel re-export referring to:

`index.ts -> createUser`
and
`users.ts -> createUser`

should normalize to the same canonical underlying symbol when Step 20 evidence proves they are the same declaration.

==================================================
4. ALIAS / RE-EXPORT NORMALIZATION
==================================================

When:

`export { createUser as addUser } from "./users"`

is encountered:

- preserve the alias information
- resolve the canonical underlying symbol to `createUser`
- do not lose the exported alias `addUser`
- preserve the source/export provenance

The normalized representation must be capable of explaining why two references point to the same symbol.

==================================================
5. DETERMINISTIC CANONICAL IDs
==================================================

Every normalized entity must have a deterministic ID.

The same snapshot + same source + same analysis must produce identical IDs across runs.

Do NOT use:
- random UUIDs
- timestamps
- object insertion order
- process-specific values

Use a stable canonical serialization/hash or the repository's existing deterministic-ID convention.

IDs must remain stable when the input ordering changes.

==================================================
6. DETERMINISTIC ORDERING
==================================================

Normalize all output into deterministic order.

Do not depend on:
- filesystem traversal order
- JavaScript object key insertion order
- Map creation order
- concurrency timing

Define explicit sorting keys.

Where relevant use deterministic keys such as:

filePath
kind
name
source position
canonical ID

Document the ordering rules.

==================================================
7. PROVENANCE / EVIDENCE PRESERVATION
==================================================

Normalization must NEVER erase useful source evidence.

For a normalized symbol/entity preserve:
- canonical identity
- original source declaration
- all relevant aliases
- source file
- source range
- original detector provenance
- unresolved/cyclic status where applicable

A normalized result must remain explainable.

Do not collapse multiple pieces of evidence into one opaque object.

==================================================
8. CROSS-DETECTOR NORMALIZATION
==================================================

Only perform cross-detector merging where there is an unambiguous canonical relationship already present in the existing result contracts.

Examples:
- a route points to an already-known file/symbol
- an event reference corresponds to an existing symbol
- a DB reference corresponds to an already-known source symbol

Do NOT attempt sophisticated semantic matching.

Do NOT use names alone to connect unrelated entities.

Do NOT create graph edges.

Do NOT infer runtime relationships.

==================================================
9. UNRESOLVED CASES
==================================================

When normalization cannot safely resolve something:

preserve the raw reference.

Use an explicit unresolved state rather than dropping it.

Examples:
- dynamic re-export
- unresolved module
- ambiguous symbol
- cyclic resolution that cannot determine a unique canonical target

Normalization must improve determinism without converting uncertainty into false certainty.

==================================================
10. RESULT CONTRACT
==================================================

Create a dedicated normalizer contract only if an existing contract is insufficient.

Prefer something conceptually like:

packages/shared-types/src/normalized.ts

or another name consistent with repository conventions.

The normalized result should expose:
- normalized symbols/entities
- canonical IDs
- alias information
- normalized module/export relationships
- unresolved references
- diagnostics if any
- deterministic counts/statistics

Do not create database tables.

Do not create GraphNode / GraphEdge / Evidence persistence models.

==================================================
11. NORMALIZER API
==================================================

Create a small reusable API, for example:

normalizeAnalysis(...)
normalizeSymbols(...)
normalizeModuleExports(...)

but use actual repository naming conventions after inspection.

The main normalization operation should:
- accept the existing raw detector outputs
- produce one deterministic normalized result
- be pure or effectively side-effect free
- not mutate the original detector outputs

The input data should remain inspectable for debugging.

==================================================
12. TESTS
==================================================

Add focused Step 25 tests covering at minimum:

1. direct symbol remains unchanged
2. named barrel re-export resolves to canonical symbol
3. aliased re-export preserves alias + canonical target
4. `export *` barrel resolution
5. nested barrel chain
6. `index.ts` barrel chain
7. multiple aliases to the same symbol deduplicate correctly
8. same symbol name in different files does NOT deduplicate
9. multiple declarations in one file remain distinct
10. deterministic canonical IDs
11. canonical IDs unaffected by input ordering
12. deterministic output ordering
13. cycle-safe barrel resolution
14. unresolved export remains unresolved
15. ambiguous resolution remains unresolved
16. source/provenance evidence is preserved
17. raw detector inputs are not mutated
18. repeated normalization of identical input produces identical output
19. normalization of empty input is deterministic
20. mixed Step 18–24 outputs normalize safely without dropping supported data

Also add at least one realistic synthetic repository fixture containing:
- direct module
- barrel file
- nested barrel
- alias re-export
- duplicated symbol names across different files
- cyclic barrel relationship

==================================================
GOLDEN FIXTURE
==================================================

Inspect the existing golden fixture before changing it.

Do not redesign the golden fixture.

Add normalization assertions only where current fixture data genuinely provides evidence.

Do NOT attempt the complete end-to-end golden pipeline yet.

That is Step 26.

==================================================
BACKWARD COMPATIBILITY
==================================================

Steps 18–24 must continue to work unchanged.

Existing focused tests must remain valid.

Do not rewrite previous detectors just to make normalization easier.

If a minimal adapter is required, prefer an adapter layer in Step 25.

==================================================
PERFORMANCE / SAFETY
==================================================

The normalizer must be bounded and safe for large repositories.

Use:
- visited sets
- memoization where appropriate
- bounded traversal
- deterministic maps/sets

Avoid exponential recursive expansion through repeated barrel chains.

Do not execute repository code.

Do not access network resources.

Do not access databases.

Do not read secrets.

==================================================
DOCUMENTATION
==================================================

Create:

learning/implementations/phase-03/step-25-normalization.md

learning/notes/24. Normalization and Barrel Resolution.md

learning/interviews/25. Step 25 Normalization Interview CheatSheet.md

Update:

docs/DESIGN.md

Add a new Step 25 section without deleting previous content.

Documentation must explain:
- why normalization is needed
- canonical identity
- barrel/re-export resolution
- alias preservation
- symbol deduplication
- cycle handling
- unresolved/ambiguous handling
- deterministic ordering/IDs
- provenance preservation
- performance safeguards
- explicit Step 26 boundary

==================================================
VERIFICATION
==================================================

Run:

pnpm lint
pnpm typecheck
pnpm test
pnpm build

Also run the focused Step 25 tests directly.

Report exact:
- focused normalization test count
- total workspace test count
- lint
- typecheck
- build

If any failure is caused by pre-existing infrastructure, identify it explicitly.

Do NOT weaken or remove tests to make the suite pass.

==================================================
STRICT SCOPE BOUNDARY
==================================================

DO NOT implement:

- full Phase 3 pipeline execution/verification — Step 26
- graph persistence
- GraphNode / GraphEdge / Evidence tables
- graph builder
- graph traversal
- graph query API
- graph.updated
- UI
- AI/LLM
- PR impact analysis
- simulation
- runtime instrumentation
- new languages
- new ORM ecosystems
- new event ecosystems

Step 25 is ONLY normalization of existing code-intelligence outputs.

At the end provide:

1. files created
2. files modified
3. normalization input/output contracts
4. barrel resolution behavior
5. deduplication rules
6. canonical ID rules
7. cycle handling
8. unresolved/ambiguous behavior
9. focused test count/results
10. full lint/typecheck/test/build results
11. limitations
12. exact recommended commit message

Do not refactor unrelated code.
Do not broaden Step 25 beyond normalization.