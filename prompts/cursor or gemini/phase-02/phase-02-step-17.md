Implement ONLY Fluxora Global Step 17: Golden Fixture Repository.

First inspect the current Fluxora codebase, Git history, and:
- docs/architecture/17-implementation-roadmap.md
- existing Phase 2 ingestion implementation
- Step 16 failure-path implementation
- docs/DESIGN.md
- learning/notes/
- learning/implementations/
- learning/interviews/

Do NOT implement Step 18 or any later Code Intelligence, Graph, UI, or AI functionality.

==================================================
STEP 17 GOAL
==================================================

Establish ONE real open-source repository as Fluxora's canonical golden fixture for deterministic testing and demo/manual verification.

This repository is ONLY Fluxora's controlled reference/test repository.

It is NOT a restriction on the real product:
real users will later be able to connect and analyze their own GitHub repositories.

The golden fixture exists so Steps 18–26 can repeatedly run against the same known codebase and verify correctness.

==================================================
1. SELECT THE GOLDEN REPOSITORY
==================================================

Choose one real public open-source repository that is:

- Next.js based
- TypeScript based
- moderate complexity
- actively structured enough to exercise meaningful code analysis
- not so large that it creates an unnecessarily huge fixture
- not a toy/tutorial repository

Prefer a repository containing several of these:
- multiple directories/modules
- reusable React components
- imports/exports
- server-side or API code
- configuration files
- tsconfig.json
- path aliases if present
- realistic application structure

Do NOT choose a repository merely because it is popular.
Choose one that is useful for Fluxora's upcoming deterministic code-intelligence tests.

Before selecting it, inspect its structure and confirm that it is suitable.

==================================================
2. PIN THE EXACT VERSION
==================================================

The fixture MUST be pinned to an immutable 40-character Git commit SHA.

Record:

- repository URL
- repository full name
- pinned commit SHA
- source branch/ref from which the commit was selected
- repository name
- short description
- why this repository was selected
- expected framework/language characteristics
- fixture identifier/version if appropriate

Do NOT make tests depend on:
- latest main
- latest master
- moving branches
- current GitHub HEAD

The pinned SHA is the canonical fixture identity.

==================================================
3. FIXTURE STORAGE
==================================================

Inspect the existing Fluxora repository/testing architecture first.

Create the smallest appropriate fixture representation for later deterministic tests.

Do NOT blindly commit:
- node_modules
- .next
- build artifacts
- caches
- secrets
- huge generated files

Prefer a compact recorded fixture/source representation consistent with the existing testing strategy.

Do not invent a second unrelated fixture framework if the repository already has an appropriate pattern.

==================================================
4. REPRODUCIBILITY
==================================================

Future tests must be able to identify exactly which repository version they are testing.

The fixture must be deterministic.

Tests must NOT require live GitHub network access during normal execution.

The fixture should allow later Steps 18–26 to use it repeatedly for:

Step 18 → language/framework detection
Step 19 → symbol extraction
Step 20 → import/export relationships
Step 21 → route detection
Step 22 → event producer/consumer patterns
Step 23 → DB references
Step 24 → tree-sitter fallback
Step 25 → normalization
Step 26 → full pipeline + hand verification

Do NOT implement any of those steps now.

==================================================
5. VALIDATION
==================================================

Add focused tests that verify the golden fixture itself.

At minimum verify:

- fixture metadata exists
- repository full name is valid
- pinned commit is a valid 40-character SHA
- fixture identity is deterministic
- fixture can be loaded successfully
- fixture data has the expected structure
- accidental changes to the pinned identity are detectable

Do NOT create tests for symbol extraction, dependency extraction, route detection, graph construction, etc. yet.

==================================================
6. SECURITY
==================================================

Treat the fixture repository as untrusted source code.

Do NOT execute repository code as part of creating or testing the fixture.

Do NOT add credentials or secrets.

Do NOT introduce Docker as a local requirement.

Preserve Fluxora's existing tenant/security architecture.

==================================================
7. DOCUMENTATION
==================================================

Create:

learning/implementations/phase-02/step-17-golden-fixture-repository.md

Create an appropriate Step 17 learning note.

Create:

learning/interviews/17. Step 17 Golden Fixture Repository Interview CheatSheet.md

Update:

docs/DESIGN.md

Do NOT delete or rewrite unrelated existing documentation.

Document:

- what a golden fixture is
- why Fluxora needs one
- which repository was selected
- the exact pinned commit SHA
- why the SHA is immutable/deterministic
- why tests should not use a moving branch
- how this fixture will be reused by Steps 18–26
- that real Fluxora users will NOT be limited to this repository
- what Step 17 deliberately does NOT implement

==================================================
8. SCOPE BOUNDARY
==================================================

DO NOT implement:

- language/framework detection
- ts-morph
- TypeScript Compiler API
- symbol extraction
- import/export graph extraction
- tsconfig alias resolution logic
- Next.js route detection
- Express route detection
- event pattern detection
- DB-reference detection
- tree-sitter
- normalizer
- GraphNode / GraphEdge / Evidence
- graph builder
- graph API
- Architecture Explorer
- UI redesign
- AI/LLM functionality

Step 17 is ONLY the establishment of the canonical golden repository fixture.

==================================================
9. VERIFICATION
==================================================

Run:

pnpm lint
pnpm typecheck
pnpm test
pnpm build

All existing tests must continue to pass.

At the end report:

1. Selected repository
2. Repository full name
3. Pinned commit SHA
4. Why it was selected
5. Exact files created/modified
6. Fixture size/contents at a high level
7. Test results
8. Build results
9. Confirmation that no Step 18+ functionality was implemented
10. Any remaining concern or assumption

Do not modify unrelated files.