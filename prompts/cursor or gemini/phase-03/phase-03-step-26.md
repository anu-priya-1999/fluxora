Implement ONLY Fluxora Global Step 26 — Full Phase 3 Golden-Fixture Pipeline Verification.

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
25 — Normalization

ROADMAP DEFINITION:

Phase 3 Step 9:
“Run the full pipeline against the golden-fixture repo from Phase 2; hand-verify a sample of extracted symbols/edges against the actual source.”

This is the FINAL step of Phase 3.

==================================================
IMPORTANT: FIRST INSPECT THE ACTUAL CURRENT SYSTEM
==================================================

Before editing anything, inspect:

- docs/architecture/17-implementation-roadmap.md
- docs/DESIGN.md
- the existing golden fixture implementation
- fixtures/golden/
- its manifest
- apps/workers/src/fixtures/*
- existing golden fixture tests
- packages/shared-types/src/detection.ts
- packages/shared-types/src/symbols.ts
- packages/shared-types/src/modules.ts
- packages/shared-types/src/routes.ts
- packages/shared-types/src/event-patterns.ts
- packages/shared-types/src/database-references.ts
- packages/shared-types/src/tree-sitter.ts
- packages/shared-types/src/normalized.ts
- apps/workers/src/detect/*
- apps/workers/src/symbols/*
- apps/workers/src/modules/*
- apps/workers/src/routes/*
- apps/workers/src/events/*
- apps/workers/src/database/*
- apps/workers/src/tree-sitter/*
- apps/workers/src/normalizer/*
- all current Step 18–25 tests

Do NOT assume detector APIs that are not actually present.

Do NOT rewrite previous detectors.

==================================================
GOAL
==================================================

Run the COMPLETE Phase 3 code-intelligence pipeline against the existing golden repository fixture.

The pipeline must conceptually be:

Golden repository snapshot
        ↓
Language / framework detection
        ↓
Symbol extraction
        ↓
Import / export graph extraction
        ↓
API route / Express route detection
        ↓
Event producer / consumer detection
        ↓
Database reference detection
        ↓
Tree-sitter fallback where applicable
        ↓
Normalization
        ↓
Canonical Phase 3 result
        ↓
Verification against expected/hand-verified source evidence

The objective is NOT to build a graph database.

The objective is to prove that the Phase 3 intelligence layers work together coherently.

==================================================
1. CREATE A SMALL PIPELINE ORCHESTRATOR
==================================================

If the repository does not already have an appropriate pipeline entry point, create a small reusable Phase 3 pipeline orchestrator.

Use the existing architecture and naming conventions.

It should:

1. Load the golden fixture
2. Run Step 18 detection
3. Run Step 19 symbol extraction
4. Run Step 20 module/import-export extraction
5. Run Step 21 route detection
6. Run Step 22 event detection
7. Run Step 23 database-reference detection
8. Run Step 24 fallback parsing where applicable
9. Feed the collected outputs into Step 25 normalization
10. Return a deterministic consolidated result

Do NOT create production persistence.

Do NOT create graph tables.

Do NOT introduce new database storage.

Do NOT invoke AI.

The pipeline must be deterministic.

==================================================
2. USE THE EXISTING GOLDEN FIXTURE
==================================================

The existing golden fixture is authoritative.

Do NOT replace it with a new toy repository.

Inspect the current fixture and its manifest first.

Preserve:
- pinned commit information
- file hashes
- file counts
- checksum verification
- line-ending invariants
- path-traversal protections

Reuse the existing golden-fixture helpers rather than duplicating their logic.

If the fixture already contains representative examples for a detector, verify those.

Do NOT fabricate expected outputs merely to make tests pass.

==================================================
3. VERIFY EACH PHASE 3 LAYER
==================================================

The pipeline verification must assert that the golden fixture produces meaningful output from each applicable layer.

At minimum verify:

### Step 18
- languages detected correctly
- frameworks detected correctly

### Step 19
- representative symbols are extracted
- source locations are valid
- symbol kinds are correct

### Step 20
- representative internal module edges exist
- representative export/re-export relationships exist
- alias/path resolution remains correct

### Step 21
- representative Next.js API routes are detected
- expected HTTP methods are detected
- non-API pages are not incorrectly classified

### Step 22
- inspect the golden fixture for supported event patterns
- if supported event patterns genuinely exist, verify representative detections
- if the golden fixture contains no supported event patterns, explicitly record “no applicable golden-fixture event pattern” rather than fabricating one

### Step 23
- inspect the golden fixture for supported ORM/database patterns
- verify representative detections when genuinely present
- if none exist, explicitly record “no applicable golden-fixture database pattern”

### Step 24
- verify applicable non-TS/JS files use the fallback
- verify valid TS/JS remains on the primary compiler path
- verify malformed/unsupported cases are handled according to existing contracts where applicable

### Step 25
- verify canonical symbols
- verify barrel/re-export normalization
- verify aliases remain explainable
- verify deterministic IDs
- verify unresolved/ambiguous cases remain explicit

==================================================
4. HAND-VERIFY REAL SOURCE EVIDENCE
==================================================

This is REQUIRED.

Do not only assert counts.

Choose a representative sample from the actual golden fixture and compare:

EXPECTED CLAIM
    ↓
ACTUAL SOURCE FILE
    ↓
ACTUAL SOURCE CONSTRUCT
    ↓
DETECTOR OUTPUT
    ↓
NORMALIZED OUTPUT

The hand-verified sample must include several categories, preferably:

- at least 3 representative symbols
- at least 3 representative module/import/export relationships
- representative API routes
- event/database references if genuinely present
- at least 1 normalization/barrel example if present

For every hand-verified item, record:
- source file
- relevant source location/range
- what the source actually says
- what Fluxora extracted
- why the extraction is correct

Do NOT claim a relationship is correct unless the fixture source actually supports it.

==================================================
5. GOLDEN EXPECTATION / VERIFICATION REPORT
==================================================

Create a deterministic verification result.

Prefer a structured test/report rather than a human-only document.

The report should summarize at least:

- files analyzed
- supported languages
- frameworks
- symbol count
- module/import/export relationship count
- route count
- event producer count
- event consumer count
- database reference count
- Tree-sitter fallback count
- normalized symbol count
- unresolved count
- diagnostic count
- cycle count if exposed by the normalizer

Do not hardcode counts without deriving them from the actual pipeline output.

Where a detector has zero applicable examples in the golden fixture, report zero honestly.

==================================================
6. DETERMINISM
==================================================

Run the complete Phase 3 pipeline more than once over the same fixture.

Assert that repeated runs produce identical:
- result IDs
- ordering
- counts
- normalized outputs
- unresolved/diagnostic ordering

No timestamps.
No random UUIDs.
No process-state-dependent output.

If serialization is required for deterministic comparison, define a canonical serialization/order.

==================================================
7. REGRESSION PROTECTION
==================================================

The Step 26 suite must prove that Steps 18–25 continue to work together.

Do NOT replace the existing focused tests.

The current tests must continue passing.

Add only the integration/orchestration tests required for Step 26.

==================================================
8. GOLDEN FIXTURE INTEGRITY
==================================================

Reuse the existing fixture-integrity verification.

The test suite must continue detecting:
- modified fixture files
- incorrect SHA-256 hashes
- incorrect sizes
- line-ending drift
- accidental pinned-commit changes
- path traversal attempts

Do not weaken fixture integrity checks.

==================================================
9. NO PRODUCTION PIPELINE CHANGES
==================================================

Step 26 is a Phase 3 verification milestone.

Do NOT connect this verification runner to:
- repository ingestion production jobs
- production event publishing
- database persistence
- graph persistence
- web routes
- UI
- AI

A reusable internal pipeline/test harness is enough.

==================================================
10. TESTS
==================================================

Add focused Step 26 integration tests covering at minimum:

1. golden fixture loads successfully
2. fixture integrity is verified
3. Step 18 output is present and deterministic
4. Step 19 output is present and deterministic
5. Step 20 output is present and deterministic
6. Step 21 output is present and deterministic
7. Step 22 output is handled correctly based on actual fixture contents
8. Step 23 output is handled correctly based on actual fixture contents
9. Step 24 fallback decision is correct
10. Step 25 normalization succeeds
11. complete Phase 3 result is deterministic across repeated runs
12. representative symbols are hand-verified
13. representative module relationships are hand-verified
14. representative routes are hand-verified
15. representative normalization/barrel relationship is hand-verified when present
16. unresolved/diagnostic data is preserved
17. golden fixture integrity protections still pass
18. complete pipeline does not execute repository code

Do NOT create fake event or database results simply to satisfy test counts.

==================================================
11. LEARNING / DOCUMENTATION
==================================================

Maintain the EXACT established Fluxora learning pattern used in Steps 18–25.

Create:

learning/implementations/phase-03/step-26-full-phase3-golden-pipeline.md

learning/notes/25. Full Phase 3 Golden Pipeline Verification.md

learning/interviews/26. Step 26 Full Phase 3 Pipeline Interview CheatSheet.md

Update:

docs/DESIGN.md

Do NOT replace or delete previous sections.

The Step 26 learning documentation must explain:

- what the complete Phase 3 pipeline does
- why the stages execute in this order
- what each Step 18–25 contributes
- how data flows from one detector to the next
- what normalization contributes before graph construction
- why the golden fixture is important
- what “hand verification” means
- how deterministic analysis is verified
- what can be trusted vs unresolved
- how this prepares Fluxora for Phase 4
- why no graph database is created yet

Also include:
- plain-English architecture flow
- important files
- important functions/modules
- key design decisions
- security/static-analysis invariants
- limitations
- interview questions and strong answers
- a concise “explain Phase 3 in one minute” section

Keep the same terminology and documentation style already used in Steps 18–25.

==================================================
12. INTERVIEW PREPARATION
==================================================

The Step 26 cheatsheet must prepare for questions such as:

- Explain the complete Fluxora code-intelligence pipeline.
- Why is static analysis performed in stages?
- Why isn't Tree-sitter the primary parser for TypeScript?
- Why do we normalize before graph construction?
- Why is determinism important?
- How do you verify an automated code-intelligence system is correct?
- Why use a golden fixture?
- What is the difference between extracted evidence and inferred relationships?
- How do you handle unresolved or ambiguous relationships?
- What would you improve at larger repository scale?

Answers must reference the actual Step 18–26 architecture.

==================================================
13. VERIFICATION COMMANDS
==================================================

Run:

pnpm lint
pnpm typecheck
pnpm test
pnpm build

Also run the focused Step 26 integration test directly.

Do NOT report a command as passing unless it actually ran successfully.

Report exact:
- focused Step 26 test count
- total workspace test count
- lint result
- typecheck result
- build result

If something fails:
- identify whether it is a Step 26 issue
- identify whether it is pre-existing
- identify whether it is environment/dependency related
- do not hide the failure

==================================================
14. FINAL PHASE 3 ACCEPTANCE CRITERIA
==================================================

Step 26 is complete only when:

1. The complete Phase 3 pipeline runs against the existing golden fixture.
2. All applicable Step 18–25 outputs are produced.
3. Outputs are deterministic.
4. Representative symbols/relationships/routes are hand-verified against real fixture source.
5. Unresolved/ambiguous cases remain explicit.
6. Fixture integrity remains enforced.
7. Existing Step 18–25 tests remain green.
8. Full lint/typecheck/test/build are green.
9. Required Step 26 learning/interview documentation is created.
10. No Phase 4 functionality is implemented.

==================================================
STRICT SCOPE BOUNDARY
==================================================

DO NOT implement:

- GraphNode / GraphEdge / Evidence tables
- graph builder
- graph traversal
- recursive CTEs
- graph query API
- graph.updated
- graph UI
- React Flow
- architecture explorer
- PR impact analysis
- simulation
- AI/LLM
- runtime telemetry
- production persistence of normalized intelligence

Those belong to later phases.

Step 26 is the FINAL VERIFICATION STEP OF PHASE 3.

At the end provide:

1. files created
2. files modified
3. complete Phase 3 pipeline flow
4. golden fixture verification summary
5. hand-verified examples
6. deterministic verification result
7. focused test count/results
8. full lint/typecheck/test/build results
9. any limitations
10. exact recommended commit message
11. explicit statement: “Phase 3 complete” only if every acceptance criterion above is actually satisfied

Do not refactor unrelated code.
Do not broaden Step 26 beyond full Phase 3 golden-fixture verification.