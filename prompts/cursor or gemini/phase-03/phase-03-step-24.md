Implement ONLY Fluxora Global Step 24 — Tree-sitter Fallback Pass.

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

Roadmap definition:
“Implement the tree-sitter fallback pass for files the compiler-based pass can't handle.”

IMPORTANT:
Before editing anything, inspect the current repository implementation and preserve all existing Phase 3 detectors.

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
- apps/workers/src/detect/*
- apps/workers/src/symbols/*
- apps/workers/src/modules/*
- apps/workers/src/routes/*
- apps/workers/src/events/*
- apps/workers/src/database/*
- existing fixtures and test conventions

Do NOT refactor Steps 18–23.

==================================================
GOAL
==================================================

Add a Tree-sitter-based fallback parsing pass for source files that are NOT handled by the existing TypeScript Compiler API pipeline.

The fallback must complement the existing compiler-based analysis.

PRIMARY RULE:

If the existing TypeScript Compiler API/parser can successfully analyze a TypeScript/JavaScript file, KEEP USING THE EXISTING PIPELINE.

Tree-sitter must NOT replace or duplicate successful TypeScript/JavaScript analysis.

Use Tree-sitter only when:
- the file language is supported by the fallback but is outside the compiler-based TypeScript/JavaScript scope, OR
- the primary parser cannot parse/handle the file safely and the fallback grammar is available.

==================================================
ARCHITECTURAL BOUNDARY
==================================================

Step 24 is a FALLBACK PARSING LAYER.

It must:
- parse source statically
- never execute target code
- never import target repository modules
- never connect to services/databases
- never evaluate arbitrary expressions
- produce deterministic results
- expose parse success/failure and diagnostics
- provide generic syntax information that later Phase 3 normalization can consume

Do NOT make Step 24 a second implementation of Steps 19–23.

Do NOT duplicate:
- full TS/JS symbol extraction
- import/export graph extraction
- route detection
- event detection
- DB detection

Those existing detectors remain authoritative for their supported inputs.

==================================================
LANGUAGE SCOPE
==================================================

First inspect Step 18's actual detected language taxonomy.

Implement a deliberately small fallback language set matching the repository's current needs and Tree-sitter grammar availability.

At minimum, consider the non-TypeScript/JavaScript languages already recognized by Fluxora, such as:
- JSON
- CSS
- HTML
- Markdown

Add other languages only when:
1. the current repository already recognizes them, AND
2. a compatible Tree-sitter grammar can be integrated cleanly.

Do NOT build a large language matrix.

Do NOT add arbitrary grammars just for demonstration.

==================================================
PARSER ABSTRACTION
==================================================

Create a small reusable Tree-sitter abstraction, for example:

apps/workers/src/tree-sitter/

or another structure consistent with the existing worker architecture.

It should expose something conceptually similar to:

- detect/parse one file
- language selection
- parser initialization
- parse result
- diagnostics
- whether fallback was actually used

Keep parser creation deterministic and reusable.

Avoid creating a parser instance separately for every node traversal when a shared/reusable design is possible.

==================================================
LANGUAGE SELECTION
==================================================

Use deterministic extension/language mapping.

Examples:

.json      -> JSON grammar
.css       -> CSS grammar
.html/.htm -> HTML grammar
.md/.markdown -> Markdown grammar

Do not infer a language from arbitrary source content when an extension-based mapping is sufficient.

Unknown extensions should return a safe “unsupported” result rather than guessing.

==================================================
RESULT CONTRACT
==================================================

Create a shared contract only if the existing contracts do not already provide an appropriate fallback/result shape.

Prefer something like:

packages/shared-types/src/tree-sitter.ts

The result should contain enough information for later stages, for example:
- file path
- detected/fallback language
- parser used
- success/failure
- whether fallback was invoked
- deterministic diagnostics
- source range information when available
- stable result identifier if consistent with existing contracts

Do NOT create graph entities.

Do NOT create new database tables.

Do NOT mix this with Fluxora's own application-event contracts.

==================================================
GENERIC EXTRACTION
==================================================

The fallback should expose generic syntax information that is useful to later Phase 3 processing.

At minimum support:
- parse success
- parse errors/diagnostics
- root node/type
- deterministic node traversal/count information
- source ranges for relevant syntax nodes
- language-specific generic structural information where it is safe

Do NOT attempt to build a complete semantic analyzer.

The goal is to establish a reliable syntax fallback, not to recreate a compiler.

Where a language-specific structure maps cleanly to existing intelligence contracts, expose only the minimum necessary representation.

For example:
- JSON object/property structure
- CSS rule/selector structure
- HTML element/tag structure
- Markdown heading/section structure

Do not invent semantic dependencies from these structures.

==================================================
FALLBACK DECISION LOGIC
==================================================

Implement an explicit decision path:

1. Determine file language.
2. If TypeScript/JavaScript and the existing compiler-based detector can parse it successfully:
   -> use existing pipeline
   -> DO NOT run Tree-sitter as a duplicate pass.
3. If the file is outside compiler-supported TS/JS scope and a Tree-sitter grammar exists:
   -> use Tree-sitter fallback.
4. If primary parsing fails and a supported fallback grammar exists:
   -> attempt Tree-sitter fallback.
5. If no fallback grammar exists:
   -> return unsupported/unparsed status with deterministic diagnostics.

This decision must be testable.

==================================================
MALFORMED SOURCE
==================================================

Malformed input must never crash the entire repository analysis.

The fallback should:
- capture parser errors
- return partial syntax information when the parser allows it
- mark the result appropriately
- preserve deterministic diagnostics
- continue analyzing other files

Do NOT silently pretend malformed input parsed successfully.

==================================================
SECURITY
==================================================

Tree-sitter parsing must remain isolated from target code execution.

Never:
- execute repository code
- import customer modules
- invoke package scripts
- load arbitrary plugins from the target repository
- connect to databases
- make network calls

Only parse source text.

==================================================
TESTS
==================================================

Add focused Step 24 tests covering at minimum:

1. JSON parses through Tree-sitter
2. CSS parses through Tree-sitter
3. HTML parses through Tree-sitter
4. Markdown parses through Tree-sitter
5. unknown extension returns unsupported safely
6. valid non-TS/JS file reports fallback parser usage
7. supported TS/JS file continues using existing compiler pipeline
8. TS/JS file is not double-parsed by fallback after successful primary parsing
9. malformed JSON does not crash analysis
10. malformed CSS does not crash analysis
11. malformed HTML does not crash analysis
12. malformed Markdown does not crash analysis
13. deterministic diagnostics
14. deterministic output ordering
15. deterministic result identifiers if implemented
16. ignored paths remain ignored
17. mixed repository containing TS/JS + fallback languages chooses the correct parser per file
18. synthetic multi-language repository fixture verifies fallback coverage

Also run the existing Phase 3 detectors to prove Step 24 does not regress Steps 18–23.

==================================================
GOLDEN FIXTURE
==================================================

Inspect the current golden fixture before modifying it.

Do NOT alter the golden fixture unnecessarily.

If existing golden files include JSON/CSS/HTML/Markdown, assert that the fallback is invoked appropriately.

If the golden fixture does not contain enough representative fallback files, create a small dedicated synthetic fallback fixture instead.

Do NOT fabricate semantic intelligence counts.

Step 26 is responsible for the complete full-pipeline golden verification.

==================================================
DEPENDENCY / TOOLING RULE
==================================================

Before adding Tree-sitter dependencies, inspect:
- current Node version
- package-manager version
- existing TypeScript/module configuration
- CI environment
- current package structure

Choose the Tree-sitter integration that is compatible with the existing Node/CI environment.

Do NOT introduce native build requirements unnecessarily when a compatible supported approach exists.

Do NOT modify Docker or deployment infrastructure for this step.

Only add the minimum required dependency/dependencies.

Update the lockfile correctly if package dependencies change.

==================================================
INTEGRATION
==================================================

Integrate the fallback cleanly into the existing analysis architecture.

Possible structure:

apps/workers/src/tree-sitter/
  parser.ts
  languages.ts
  result.ts
  parser.test.ts

Use the actual repository architecture after inspection rather than blindly following this layout.

Update:
- shared-type exports when required
- worker exports when required
- test scripts only when necessary

Do NOT change the behavior of Steps 18–23 except for the explicit fallback routing needed for Step 24.

==================================================
DOCUMENTATION
==================================================

Create:

learning/implementations/phase-03/step-24-tree-sitter-fallback.md

learning/notes/23. Tree-sitter Fallback.md

learning/interviews/24. Step 24 Tree-sitter Fallback Interview CheatSheet.md

Update:

docs/DESIGN.md

Add a new section describing Step 24 without deleting previous sections.

Documentation must explain:
- why Tree-sitter exists as a fallback
- primary-parser vs fallback decision flow
- supported fallback languages
- parser abstraction
- diagnostics/error behavior
- security/static-analysis invariants
- dependency choice
- deterministic behavior
- limitations
- explicit Step 25/26 boundary

==================================================
VERIFICATION
==================================================

Run:

pnpm lint
pnpm typecheck
pnpm test
pnpm build

Also run the focused Tree-sitter/fallback tests directly.

Report exact:
- focused test count
- full test count
- lint result
- typecheck result
- build result

If any failure occurs, identify whether it is:
- caused by Step 24
- pre-existing
- environment/dependency related

Do NOT hide failures by weakening tests.

==================================================
STRICT SCOPE BOUNDARY
==================================================

DO NOT implement:

- normalization
- barrel-file resolution
- symbol deduplication
- cross-detector result merging — Step 25
- full golden pipeline verification — Step 26
- GraphNode / GraphEdge / Evidence tables
- graph construction
- graph traversal
- graph API
- AI/LLM
- UI
- PR impact analysis
- simulation
- runtime instrumentation
- database access
- new event ecosystems
- new ORM ecosystems

Step 24 is ONLY the Tree-sitter fallback parsing layer.

At the end provide:

1. files created
2. files modified
3. Tree-sitter dependency/dependencies added, if any
4. supported fallback languages
5. primary-vs-fallback decision logic
6. focused test count/results
7. full lint/typecheck/test/build results
8. limitations
9. exact recommended commit message

Do not refactor unrelated code.
Do not replace the existing TypeScript Compiler API path.
Do not broaden Step 24 beyond the explicit fallback scope.