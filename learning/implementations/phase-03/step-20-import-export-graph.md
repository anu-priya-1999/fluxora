# Step 20 — Import/Export Graph Extraction with TypeScript Path-Alias Resolution

## Objective

Implement **Fluxora Global Step 20: Import/Export Graph Extraction with TypeScript Path-Alias Resolution** (`docs/architecture/05-component-responsibilities.md §5.3`, `docs/architecture/17-implementation-roadmap.md §Phase 3 Step 3`).

While Step 19 answered:
> *"What symbols exist inside each file?"*

Step 20 answers:
> *"How are repository modules connected through imports and exports?"*

Given an immutable repository snapshot, Step 20 statically and deterministically:
1. Parses imports and exports from supported source files (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`).
2. Resolves internal module specifiers to their actual repository files.
3. Resolves relative imports (`./utils`, `../services/payment`).
4. Resolves `tsconfig.json` path aliases (such as `@/*` -> `./src/*` or `./*`).
5. Captures export and re-export relationships (`export * from ...`, `export { foo } from ...`).
6. Produces a deterministic module relationship graph with stable IDs and structured diagnostics.

Step 20 is **not** graph database persistence (Phase 4). It is the static analysis layer that later graph-building steps consume.

---

## 1. Architectural Position & Invariants

### Deterministic Core vs. Probabilistic AI Edge
Module extraction and path resolution are fundamental deterministic primitives of Fluxora:
- **No LLM in Core**: Module relationships and dependency edges never depend on an AI model or runtime inference.
- **Pure In-Memory Static Analysis**: Operates over an immutable in-memory `SnapshotFileMap` without executing customer repository code (`eval`, `import()`, subprocesses, or package managers).
- **Zero Monorepo Footprint Expansion**: Uses the TypeScript Compiler API (`ts.createSourceFile`, `ts.readConfigFile`, `ts.parseJsonConfigFileContent`, `ts.resolveModuleName`) already present in the workspace.

### Strict Scope Boundary
- **Step 19** was isolated per-file symbol extraction with zero cross-file knowledge.
- **Step 20** builds the module-to-module connection graph.
- **Step 25** will implement barrel-file collapsing and symbol normalization. Step 20 preserves barrel re-exports as explicit module edges (`re_export`), ensuring the raw architectural topology remains completely inspectable.
- **Phase 4** persists nodes, edges, and evidence to PostgreSQL (`GraphNode`, `GraphEdge`, `Evidence`). Step 20 operates entirely in memory.

---

## 2. Shared Type Contracts (`@fluxora/shared-types`)

Module graph contracts are defined in `packages/shared-types/src/modules.ts`:

- `RepositoryModuleReferenceKind`: `"import" | "re_export" | "dynamic_import" | "require"`
- `RepositoryModuleImportKind`: `"named_import" | "default_import" | "namespace_import" | "side_effect_import" | "dynamic_import" | "require" | "named_re_export" | "star_re_export" | "namespace_re_export"`
- `RepositoryModuleResolutionStatus`: `"internal" | "external" | "unresolved" | "unsupported_dynamic"`
- `RepositoryModuleImportedName`: Represents imported/exported symbols, optional aliases (`foo as bar`), and `isTypeOnly`.
- `RepositoryModuleReference`: Structured representation of a syntactic import or re-export.
  - Stable ID format: `${sourceFile}#ref:${referenceKind}:${start.offset}`
- `RepositoryModuleEdge`: Directed edge between repository modules.
  - Stable ID format: `${sourceFile}->${targetFile ?? specifier}#${edgeKind}:${start.offset}`
- `RepositoryModuleGraph`: Complete analysis result containing `filesAnalyzed`, `references`, `internalEdges`, `externalReferences`, `unresolvedReferences`, `unsupportedDynamicReferences`, and `diagnostics`.

---

## 3. Import & Export Syntactic Extraction

AST traversal inspects TypeScript AST nodes via `ts.forEachChild`:

1. **Named Imports**:
   ```typescript
   import { foo, bar as baz } from "./utils";
   ```
   Extracts `named_import`, imported names `foo` and `bar` (with alias `baz`).
2. **Default Imports**:
   ```typescript
   import Foo from "./Foo";
   ```
   Extracts `default_import`, imported name `default` with alias `Foo`.
3. **Namespace Imports**:
   ```typescript
   import * as Utils from "./utils";
   ```
   Extracts `namespace_import`, imported name `*` with alias `Utils`.
4. **Side-Effect Imports**:
   ```typescript
   import "./setup";
   ```
   Extracts `side_effect_import` with empty names list.
5. **Static Dynamic Imports**:
   ```typescript
   const mod = await import("./foo");
   ```
   Extracts `dynamic_import` with specifier `"./foo"`. Non-string dynamic imports are flagged as `unsupported_dynamic` with specifier `"<dynamic>"`.
6. **CommonJS Requires**:
   ```typescript
   const config = require("./config");
   ```
   Extracts `require` reference without executing code.
7. **Star Re-exports**:
   ```typescript
   export * from "./utils";
   ```
   Extracts `re_export` edge with `star_re_export`.
8. **Namespace Re-exports**:
   ```typescript
   export * as utils from "./utils";
   ```
   Extracts `namespace_re_export` with name `*` and alias `utils`.
9. **Named Re-exports**:
   ```typescript
   export { foo, bar as baz } from "./utils";
   ```
   Extracts `named_re_export` preserving aliasing.

---

## 4. Module Resolution Engine

### Virtual Module Resolution Host
`createSnapshotModuleResolutionHost` creates a custom TypeScript `ts.ModuleResolutionHost` wired to the in-memory `SnapshotFileMap`:
- `fileExists`: checks existence in the snapshot map.
- `readFile`: reads file contents from the snapshot map.
- `directoryExists`: checks against pre-computed directory prefixes.
- `getCurrentDirectory`: returns virtual root directory (`/repo`).

### tsconfig.json Parsing
`parseSnapshotTsconfig` uses `ts.readConfigFile` and `ts.parseJsonConfigFileContent` to parse `tsconfig.json`:
- Tolerates comments and trailing commas.
- Extracts `compilerOptions.baseUrl` and `compilerOptions.paths`.
- Resolves path mappings (such as `@/*` -> `./src/*` or `./*`).

### Resolution Cascade
1. **TypeScript Resolution**: `ts.resolveModuleName` resolves relative imports and path aliases.
2. **Relative Path Fallback**: Probes candidate extensions (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`) and directory indices (`/index.ts`, `/index.tsx`, etc.).
3. **Status Classification**:
   - `internal`: Resolves to a file present in the snapshot.
   - `external`: Non-relative specifiers not mapped by internal path aliases (e.g. `react`, `zod`, `next/font/google`).
   - `unresolved`: Relative specifier or matched path alias where target file does not exist in the snapshot.
   - `unsupported_dynamic`: Dynamic `import(expr)` or `require(expr)` where specifier is not a string literal.

---

## 5. Golden Fixture Verification (`shadcn-ui/taxonomy`)

Evaluated against the pinned golden fixture (`fixtures/golden/taxonomy`):
- **Analyzed Files**: 120 supported TS/JS source files.
- **Internal Edges**: 231 deterministic cross-file module edges.
- **External References**: 215 external library references (`react`, `next`, `lucide-react`, `@radix-ui/*`, etc.).
- **Unresolved References**: 5 (specifically generated build artifacts `contentlayer/generated` and non-code CSS assets `@/styles/globals.css`).
- **Path Alias Verification**: Verified that `@/config/site` resolves to `config/site.ts` and `@/lib/utils` resolves to `lib/utils.ts`.

---

## 6. Security & Performance

1. **Security**: Customer repository text is never executed or evaluated. No network calls or package installations take place.
2. **Determinism**: Files, references, edges, and diagnostics are sorted by deterministic IDs.
3. **Performance**: In-memory directory index caches directory existence for O(1) checks during module resolution. ASTs are parsed once per file.

