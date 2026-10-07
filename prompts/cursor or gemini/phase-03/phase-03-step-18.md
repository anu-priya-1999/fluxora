Implement ONLY Fluxora Global Step 18: Language/Framework Detection.

First inspect the current Fluxora codebase and Git history, especially:

- docs/architecture/17-implementation-roadmap.md
- docs/DESIGN.md
- the completed Step 17 golden fixture
- existing repository/snapshot models
- existing worker/ingestion architecture
- existing shared types and database conventions
- existing learning/implementation/interview documentation

Do NOT implement Step 19 or any later Code Intelligence, Graph, UI, or AI functionality.

==================================================
STEP 18 GOAL
==================================================

Given an immutable repository snapshot produced by Fluxora ingestion, deterministically detect:

1. Languages present in the repository.
2. Relevant frameworks/tooling present in the repository.

The detection must be based on repository contents and configuration/manifest evidence, NOT an LLM.

For the current golden fixture, the detector should correctly identify its primary language/framework characteristics.

==================================================
1. ARCHITECTURE
==================================================

First inspect the existing Phase 2 snapshot representation and determine the cleanest existing boundary for consuming repository snapshot files.

Do NOT create an unrelated duplicate repository-reading abstraction.

Create a small, deterministic detection module following the existing Fluxora architecture.

The detector should accept repository snapshot/file metadata through a testable interface rather than directly depending on GitHub network calls.

The detector must NOT execute repository code.

==================================================
2. LANGUAGE DETECTION
==================================================

Implement deterministic language detection using file extensions and repository metadata.

At minimum support the languages relevant to the Fluxora MVP, including:

- TypeScript
- JavaScript
- TSX
- JSX
- JSON
- CSS
- HTML
- Markdown

Use a clear normalization strategy so equivalent extensions map consistently.

For example:

.ts / .mts / .cts → TypeScript
.tsx               → TypeScript
.js / .mjs / .cjs   → JavaScript
.jsx                → JavaScript

Do not count:
- node_modules
- .git
- .next
- build/dist output
- other generated/cache directories

Avoid double-counting equivalent language categories.

The implementation should be extensible for additional languages later without redesigning the core API.

==================================================
3. FRAMEWORK DETECTION
==================================================

Implement deterministic framework/tooling detection from repository evidence.

At minimum support the framework characteristics required by the Phase 3 roadmap and the golden fixture.

Detect Next.js using reliable repository evidence such as:

- package.json dependencies/devDependencies
- recognizable Next.js configuration where appropriate
- existing Next.js project structure where appropriate

Also distinguish the existence of:

- React
- Node.js/server-side JavaScript ecosystem

Do NOT infer a framework merely from a filename if stronger package/config evidence exists.

Avoid false positives.

Return structured detection results with evidence indicating why a framework was detected.

==================================================
4. EVIDENCE
==================================================

Detection must be explainable.

For every detected language/framework, retain concise evidence such as:

- source file extension(s)
- package.json dependency
- configuration file
- relevant repository path

Example concept:

TypeScript:
  evidence = [".ts", ".tsx"]

Next.js:
  evidence = ["package.json: next"]

Do not build the full Phase 4 Evidence system yet.

This is only local deterministic detection evidence for Step 18.

==================================================
5. OUTPUT CONTRACT
==================================================

Create a strongly typed result model.

It should distinguish at least:

- detected languages
- detected frameworks
- primary language/framework when determinable
- evidence

Avoid returning arbitrary untyped JSON.

Keep the result independent of the future graph model.

Do not create GraphNode, GraphEdge, Evidence database tables.

==================================================
6. CONFIDENCE / DETERMINISM
==================================================

Do not introduce an LLM or probabilistic classifier.

The same snapshot must always produce the same result.

Do not use:
- AI models
- embeddings
- network calls
- GitHub API calls
- runtime execution of repository code

A detector decision must be reproducible from the snapshot contents alone.

If there is insufficient evidence to identify something, return an explicit unknown/undetected result rather than guessing.

==================================================
7. GOLDEN FIXTURE
==================================================

Run the detector against the Step 17 golden fixture.

Add deterministic tests proving that the fixture's expected:

- language(s)
- framework(s)

are detected.

Do NOT start symbol extraction yet.

Do NOT parse ASTs yet.

Do NOT build import/export relationships yet.

==================================================
8. TEST COVERAGE
==================================================

Add focused node:test coverage for at least:

- TypeScript detection
- JavaScript detection
- TSX/JSX normalization
- ignored generated directories
- Next.js detection from package metadata
- React detection
- Node.js ecosystem detection where applicable
- unknown/unsupported extensions
- duplicate evidence normalization
- empty/minimal repository
- golden fixture detection
- deterministic repeated execution

Test false-positive cases where practical.

Tests must use small in-memory/fixture inputs rather than requiring live GitHub access.

==================================================
9. DOCUMENTATION
==================================================

Create:

learning/implementations/phase-03/step-18-language-framework-detection.md

Create an appropriate Step 18 learning note.

Create:

learning/interviews/18. Step 18 Language Framework Detection Interview CheatSheet.md

Update:

docs/DESIGN.md

Do NOT delete existing documentation.

Document:

- what language detection does
- what framework detection does
- why this is deterministic
- what evidence is used
- how generated files/directories are excluded
- how the golden fixture is used
- why this step does not use an LLM
- what Step 19 will build on top of this

==================================================
10. STRICT SCOPE BOUNDARY
==================================================

DO NOT implement:

- symbol extraction
- ts-morph
- TypeScript Compiler API
- AST analysis
- import/export graph extraction
- path alias resolution
- Next.js route detection
- Express route detection
- event producer/consumer detection
- DB-reference detection
- tree-sitter
- normalizer
- GraphNode / GraphEdge / Evidence persistence
- graph traversal
- graph API
- Architecture Explorer UI
- AI/LLM functionality

Step 18 is ONLY deterministic language/framework detection.

==================================================
11. VERIFICATION
==================================================

Run:

pnpm lint
pnpm typecheck
pnpm test
pnpm build

All existing Step 1–17 behavior must continue working.

At the end report:

1. Exact files changed/created
2. Detection API/result shape
3. Languages detected
4. Frameworks detected
5. Evidence mechanism
6. Golden-fixture detection result
7. Test results
8. Build result
9. Confirmation that no Step 19+ functionality was implemented
10. Any remaining limitation

Do not modify unrelated files.