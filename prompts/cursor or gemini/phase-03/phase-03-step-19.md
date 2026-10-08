Implement ONLY Fluxora Global Step 19: Per-file symbol extraction.

IMPORTANT:
- Inspect the current repository implementation before changing anything.
- Treat docs/architecture/17-implementation-roadmap.md as the authoritative roadmap.
- Step 18 is already implemented and verified. Reuse its repository/snapshot abstractions where appropriate.
- Do NOT implement Step 20 or any later step.
- Do NOT perform broad refactors.
- Do NOT add LLM/AI-based analysis.
- Keep the implementation deterministic and reproducible.

==================================================
STEP 19 OBJECTIVE
==================================================

Build the deterministic AST-based symbol extraction layer for source files in an ingested repository snapshot.

The purpose of Step 19 is:

"Given a repository snapshot, determine what code entities/symbols exist in each supported source file."

The output will later be consumed by Step 20 for import/export relationship resolution and by later graph-building steps.

Step 18 already answers:
"What languages/frameworks/tooling does this repository use?"

Step 19 must answer:
"What code entities exist in each source file?"

==================================================
SCOPE
==================================================

Implement symbol extraction for TypeScript/JavaScript-family source files supported by the existing Step 18 detection layer, prioritizing:

- .ts
- .tsx
- .js
- .jsx
- .mts
- .cts
- .mjs
- .cjs

Use the TypeScript compiler API or ts-morph, whichever best fits the existing Fluxora architecture.

Prefer the smallest dependency footprint and reuse any existing TypeScript tooling already present in the monorepo.

DO NOT introduce ts-tree-sitter or another fallback parser in Step 19.

==================================================
SYMBOLS TO EXTRACT
==================================================

At minimum extract, with accurate source locations:

1. Functions
2. Classes
3. Class methods
4. Interfaces
5. Type aliases
6. Enums
7. Variables
8. Constants
9. Imports/exports ONLY as declaration metadata needed to represent symbols

IMPORTANT:
Step 19 is NOT import/export graph extraction.

Do not resolve:
- imported module targets
- dependency edges
- tsconfig path aliases
- cross-file relationships

Those belong to Step 20.

For exports, record whether a declaration is exported and the export name where deterministically available, but do not build cross-file import/export edges.

==================================================
SYMBOL CONTRACT
==================================================

Create a strongly typed shared contract in packages/shared-types.

Design a result shape along these lines, adapting to existing Fluxora conventions:

RepositorySymbolExtractionInput
- relativePath
- sourceText
- language/script kind where necessary

RepositorySymbol
- stable deterministic id/key
- kind
- name
- relativePath
- start position
- end position
- exported status
- optional parent symbol
- optional metadata appropriate to the symbol kind

RepositorySymbolExtractionResult
- relativePath
- symbols
- diagnostics if useful and deterministic

Use explicit string unions/enums for symbol kinds rather than untyped strings.

A symbol's identity must be deterministic for identical source input.

Do not invent database persistence for Step 19 unless the existing architecture explicitly requires it. Prefer a pure analysis layer that can later be consumed by Step 20/26.

==================================================
AST / PARSING REQUIREMENTS
==================================================

Parse source text without executing repository code.

Never:
- import customer repository modules
- execute repository scripts
- run package scripts from the analyzed repository
- resolve dependencies by executing them

The repository is untrusted input.

Use AST nodes to extract symbols.

Handle malformed source safely:
- return structured diagnostics or an empty/partial result
- never crash the worker for one malformed file
- preserve deterministic behavior

Correctly distinguish things such as:

function foo() {}

const foo = () => {}

class Foo {}

interface Foo {}

type Foo = ...

enum Foo {}

class Foo {
  method() {}
}

const VALUE = 123;

let mutableValue = 123;

Do not double-count the same declaration.

Nested symbols should have deterministic parent relationships where appropriate.

Example:

class PaymentService {
  async charge() {}
}

should produce:

PaymentService        → class
PaymentService.charge → method

rather than treating the method as an unrelated top-level symbol.

==================================================
SOURCE LOCATIONS
==================================================

Record deterministic source locations for every symbol.

Use offsets and/or line/column information consistent with existing project conventions.

At minimum capture:

- start
- end

Prefer a representation that remains stable and can later support evidence/graph visualization.

Test multi-line declarations.

==================================================
EXPORT HANDLING
==================================================

Correctly recognize declarations such as:

export function foo() {}

export class Foo {}

export const value = 1;

export interface Foo {}

export type Foo = ...

export default class Foo {}

export default function foo() {}

Also handle:

const foo = ...
export { foo };

But:

DO NOT resolve imported symbols.
DO NOT build cross-file export relationships.

Only record deterministic export metadata available from the file AST.

==================================================
DIRECTORY / FILE FILTERING
==================================================

Reuse the same ignored-directory semantics established by Step 18.

Do not parse:

- node_modules
- .git
- .next
- build
- dist
- out
- .turbo
- .cache
- coverage

Do not parse unsupported file types.

Do not execute fixture code.

==================================================
GOLDEN FIXTURE
==================================================

Use the existing golden fixture:

fixtures/golden/taxonomy

Do not modify the fixture itself.

Add deterministic Step 19 coverage using the golden fixture.

The test should verify representative symbols from real files rather than relying only on synthetic examples.

Do not make the tests dependent on network access.

==================================================
TESTS
==================================================

Add focused tests for:

1. function extraction
2. arrow-function variable extraction
3. class extraction
4. class method extraction
5. interface extraction
6. type-alias extraction
7. enum extraction
8. variable/constant extraction
9. exported declarations
10. default exports
11. nested symbols / parent relationship
12. source locations
13. duplicate-prevention
14. unsupported file handling
15. ignored directories
16. malformed source handling
17. deterministic repeated execution
18. golden-fixture symbol extraction

Test both TypeScript and JavaScript-family source files where supported.

Do NOT write tests for Step 20 behavior such as:
- import target resolution
- dependency graph construction
- path alias resolution
- cross-file relationships

==================================================
ARCHITECTURE / INTEGRATION
==================================================

Inspect the existing Step 18 implementation first.

Reuse:
- repository file abstractions
- shared-types conventions
- worker package conventions
- fixture loading utilities
- existing test conventions

Keep the symbol extractor as a deterministic, reusable analysis component.

Do not couple it to:
- PostgreSQL
- RLS
- WebSockets
- GitHub API
- S3
- LLMs

unless an existing abstraction genuinely requires it.

==================================================
DOCUMENTATION
==================================================

Create/update:

1. learning/implementations/phase-03/step-19-symbol-extraction.md

Include:
- problem
- architecture
- AST approach
- symbol model
- source-location model
- security considerations
- deterministic behavior
- malformed-code behavior
- examples
- testing strategy
- explicit Step 19 boundary

2. learning/notes/
Create the next appropriately numbered Step 19 learning note.

3. learning/interviews/
Create:
19. Step 19 Symbol Extraction Interview CheatSheet.md

Include interview questions around:
- AST
- TypeScript Compiler API / ts-morph
- symbol extraction
- parsing vs execution
- deterministic analysis
- malformed source
- source locations
- why Step 19 is separate from Step 20

4. Update docs/DESIGN.md with the Step 19 implementation state.

Do not delete existing DESIGN.md content.

==================================================
STRICT STEP BOUNDARY
==================================================

Absolutely DO NOT implement:

- import graph construction
- export graph construction
- tsconfig path-alias resolution
- cross-file dependency edges
- Next.js API route detection
- Express router detection
- event producer/consumer detection
- database/ORM detection
- tree-sitter fallback
- symbol normalizer
- GraphNode / GraphEdge / Evidence tables
- graph persistence
- graph query APIs
- LLM analysis

Those belong to later roadmap steps.

==================================================
VERIFICATION
==================================================

After implementation run:

pnpm lint
pnpm typecheck
pnpm test
pnpm build

Also run focused Step 19 tests separately if useful.

Fix only issues caused by this Step 19 implementation.

Do not weaken tests to make them pass.

At the end provide:

1. exact files created/modified
2. symbol kinds supported
3. parser choice and why
4. test counts/results
5. lint/typecheck/build results
6. explicit confirmation that Step 20+ was not implemented
7. any limitations that genuinely remain

Do not claim completion unless the verification commands actually pass.