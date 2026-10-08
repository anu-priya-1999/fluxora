# Step 19 — Per-File Symbol Extraction

## Objective

Implement **Global Step 19: Per-file symbol extraction** (`docs/architecture/05-component-responsibilities.md §5.3`, `docs/architecture/17-implementation-roadmap.md §Phase 3 Step 2`).

Given a repository snapshot, determine what code entities/symbols exist in each supported source file without executing untrusted code.

The output will be consumed by Step 20 for import/export relationship resolution and by later graph construction passes.

---

## 1. Problem & Architectural Position

In Phase 3 (Code Intelligence), Step 18 answers:
> *"What languages/frameworks/tooling does this repository use?"*

Step 19 answers:
> *"What code entities exist in each source file?"*

### Pure Analysis Layer
Step 19 acts as a deterministic, pure static analysis function over file contents. It transforms individual source file contents into structured symbol definitions accompanied by source positions, export status, and kind-specific metadata.

Step 19 deliberately avoids:
- Resolving imported modules or import paths.
- Resolving path aliases via `tsconfig.json`.
- Constructing cross-file dependency edges or call graphs.
- Persisting rows to Postgres `GraphNode`, `GraphEdge`, or `Evidence` tables.

These responsibilities belong strictly to Step 20 (import/export graph) and Phase 4 (graph persistence).

---

## 2. AST Parser Selection

Fluxora utilizes the **TypeScript Compiler API** (`typescript.createSourceFile`) for Step 19 symbol extraction:

### Why TypeScript Compiler API?
1. **Zero New Monorepo Dependencies**: TypeScript (`~5.9.2`) is already present in the workspace root and monorepo tooling. Using `typescript` directly avoids introducing heavier abstraction wrappers (such as `ts-morph`) or native C++ bindings (`tree-sitter`).
2. **First-Class Modern TS/JS/TSX Support**: Fully understands TypeScript 5.x syntax, JSX/TSX expressions, ECMAScript modules, class properties, and decorators.
3. **AST Safety**: Creates in-memory Abstract Syntax Trees (`ts.SourceFile`) purely by lexical and syntactic analysis without evaluating runtime code.
4. **Resilience to Syntax Errors**: `ts.createSourceFile` produces partial ASTs even when files contain syntax errors, exposing parse diagnostics through `sourceFile.parseDiagnostics` without throwing unhandled runtime exceptions.

---

## 3. Supported Symbols and Kinds

The shared contract in `@fluxora/shared-types` (`RepositorySymbolKind`) defines:

1. `function`: Top-level function declarations (`function foo() {}`) and variable-assigned functions (`const foo = () => {}`, `const foo = function() {}`).
2. `class`: Class declarations (`class Foo {}`) and class expressions (`export default class {}`).
3. `method`: Methods within classes (`class Foo { async bar() {} }`).
4. `interface`: TypeScript interface declarations (`interface User {}`).
5. `type_alias`: TypeScript type aliases (`type Id = string | number;`).
6. `enum`: Standard and const enums (`enum Status {}`, `const enum Priority {}`).
7. `variable`: Mutable bindings (`let x = 1;`, `var y = 2;`, destructuring `let { a } = obj;`).
8. `constant`: Immutable constant bindings (`const MAX = 100;`, destructuring `const { port } = config;`).

---

## 4. Source Location Model

Source locations are strictly deterministic and captured as:

```typescript
export interface SourcePosition {
  readonly line: number;   // 1-based line number
  readonly column: number; // 1-based character column
  readonly offset: number; // 0-based character offset
}

export interface SourceLocation {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}
```

Line and column numbers are computed via TypeScript's `sourceFile.getLineAndCharacterOfPosition`, ensuring precise character boundaries for multi-line declarations.

---

## 5. Parent-Child Symbol Hierarchy

Nested symbols record explicit parent relationships:

Example:
```typescript
class PaymentService {
  async charge() {}
}
```

Produces:
- `PaymentService` (`kind: "class"`)
- `PaymentService.charge` (`kind: "method"`, `parentSymbolId: "<class-id>"`, `parentName: "PaymentService"`)

Method IDs deterministically incorporate the qualified path:
`${relativePath}#method:PaymentService.charge:${startOffset}`

---

## 6. Export Handling

Declarations record deterministic export metadata:
- Direct exports: `export function foo() {}`, `export class Bar {}`, `export const val = 1;`
- Default exports: `export default function foo() {}`, `export default class Bar {}`, `export default identifier;`
- Separate export clauses: `const foo = 1; export { foo, foo as bar };`

Import declarations (`import ... from '...'`) and cross-file link resolution are deferred to Step 20.

---

## 7. Security & Sandboxing

Repository contents are treated as **untrusted input**:
- Never `eval()`, `Function()`, or `import()` customer code.
- Never run npm scripts or package compilers from the repository.
- Symbol extraction is purely AST traversal over plain text strings.
- Path traversal escapes outside the repository root are rejected.

---

## 8. Directory & File Filtering

Reuses the directory filter semantics from Step 18 (`isIgnoredPath`):
- `node_modules`
- `.git`
- `.next`
- `build`
- `dist`
- `out`
- `.turbo`
- `.cache`
- `coverage`

Only supported file extensions are parsed: `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`.
Non-code files (`.md`, `.json`, `.png`) return an empty symbol list immediately without parsing.

---

## 9. Verification & Golden Fixture Coverage

Verified using `fixtures/golden/taxonomy`:
- `app/api/posts/route.ts`: Extracted `GET` and `POST` async route handler functions.
- `components/user-auth-form.tsx`: Extracted TSX component function `UserAuthForm` and interface `UserAuthFormProps`.
- `lib/session.ts`: Extracted async helper `getCurrentUser`.
- `types/index.d.ts`: Extracted type aliases including `SubscriptionPlan`.
- `config/subscriptions.ts`: Extracted exported constants `freePlan` and `proPlan`.

Full verification passed:
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test` (74 passing tests across workers, 35 in API)
- `pnpm build`

