# Step 18 — Language and Framework Detection

## Objective

Implement **Global Step 18: Language/Framework Detection** (`docs/architecture/05-component-responsibilities.md §5.2`, `docs/architecture/17-implementation-roadmap.md §Phase 3 Step 1`).

Given an immutable repository snapshot produced by Fluxora ingestion, deterministically detect:
1. Languages present in the repository (TypeScript, JavaScript, JSON, CSS, HTML, Markdown).
2. Frameworks/tooling present in the repository (Next.js, React, Node.js ecosystem).
3. Primary language and primary framework when determinable.
4. Structured evidence explaining each detection decision.

This detection operates strictly as a pure, deterministic static analysis function over snapshot metadata and manifest content. It does not invoke an LLM, run network requests, or execute repository code.

---

## 1. Architectural Boundary & Input Contract

The detector lives in `@fluxora/workers` (`apps/workers/src/detect/detector.ts`) with shared data contracts defined in `@fluxora/shared-types` (`packages/shared-types/src/detection.ts`):

```typescript
export interface RepositoryDetectorInput {
  readonly files: readonly RepositoryDetectorFileItem[];
  readonly readFile?: (relativePath: string) => Promise<string | null> | string | null;
}
```

### Key Architectural Invariants:
- **No Code Execution**: Repository files are treated as untrusted data/text input. Code is never imported, evaluated (`eval`), or executed.
- **Pure & Deterministic**: Given the same file manifest and configuration texts, the detector produces the exact same output. No probabilistic classifiers, heuristics, or LLMs are used.
- **Offline & Decoupled**: The detector consumes in-memory or snapshot file lists and an optional text-reader abstraction, decoupling it from GitHub network APIs, object storage SDKs, or database transactions.

---

## 2. Language Detection & Normalization

The detector inspects relative file paths across the snapshot and maps extensions to canonical language identities:

| Extensions | Canonical Language |
|---|---|
| `.ts`, `.mts`, `.cts`, `.tsx` | `TypeScript` |
| `.js`, `.mjs`, `.cjs`, `.jsx` | `JavaScript` |
| `.json` | `JSON` |
| `.css` | `CSS` |
| `.html`, `.htm` | `HTML` |
| `.md`, `.markdown`, `.mdx` | `Markdown` |

### Ignored Directories
To avoid counting dependencies, build outputs, or ephemeral caches, any path segments residing in standard ignored directories are excluded:
- `node_modules/`
- `.git/`
- `.next/`
- `build/`
- `dist/`
- `out/`
- `.turbo/`
- `.cache/`
- `coverage/`

### Primary Language Calculation
Calculated deterministically from the recognized code file counts across the repository. In tie-break situations, primary language prioritizes `TypeScript > JavaScript > others > alphabetical`.

---

## 3. Framework & Ecosystem Detection

Frameworks are identified through verified manifest and configuration evidence, strictly avoiding false positives based solely on ambiguous file naming (e.g. `foo-next.ts` does not trigger Next.js detection):

1. **Next.js**:
   - `package.json` dependency or devDependency on `next`.
   - Presence of `next.config.js`, `next.config.mjs`, or `next.config.ts`.
   - Directory structures: `app/` / `src/app/` (App Router) or `pages/` / `src/pages/` (Pages Router).
2. **React**:
   - `package.json` dependency on `react` or `react-dom`.
   - Presence of `.tsx` or `.jsx` components alongside Next.js or React dependencies.
3. **Node.js**:
   - Presence of root `package.json` manifest.
   - Package manager lockfiles: `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lockb`.
   - Dependency or devDependency on `@types/node`.

---

## 4. Evidence Explanation Contract

For every detected language and framework, deterministic reasons are recorded in `RepositoryDetectorEvidence`:

```typescript
export interface RepositoryDetectorEvidence {
  readonly target: SupportedLanguage | SupportedFramework;
  readonly category: "language" | "framework";
  readonly reasons: readonly string[];
}
```

Example output:
- **TypeScript**: `["config: tsconfig.json", "extension: .ts", "extension: .tsx"]`
- **Next.js**: `["config: next.config.mjs", "directory: app router structure", "package.json: dependency 'next'"]`
- **React**: `["package.json: dependency 'react'", "package.json: dependency 'react-dom'", "source: JSX/TSX components present"]`
- **Node.js**: `["dependency: @types/node", "lockfile: pnpm-lock.yaml", "manifest: package.json"]`

---

## 5. Golden Fixture Verification

Running `detectRepositoryStack` on `shadcn-ui/taxonomy` (the Step 17 golden fixture):
- **Detected Languages**: `["CSS", "HTML", "JSON", "JavaScript", "Markdown", "TypeScript"]`
- **Primary Language**: `TypeScript`
- **Detected Frameworks**: `["Next.js", "Node.js", "React"]`
- **Primary Framework**: `Next.js`
- **Files Evaluated**: 177 files evaluated; >100 recognized code/config files.

---

## 6. What Step 19 Will Build On Top of This

Step 18 establishes the static foundation for parser pipeline selection (`docs/architecture/05-component-responsibilities.md §5.2`).
Step 19 will consume this detector's result to initialize the AST Parser (ts-morph / TypeScript Compiler API) for full semantic extraction of functions, classes, interfaces, and exports across the identified TypeScript/JavaScript files.

