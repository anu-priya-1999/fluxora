# Step 17 — Golden Fixture Repository

## Objective

Establish ONE real open-source repository as Fluxora's canonical golden fixture for deterministic testing and manual/demo verification:
1. Select a real open-source Next.js + TypeScript repository of moderate complexity.
2. Pin the exact version to an immutable 40-character Git commit SHA.
3. Establish a compact, deterministic recorded fixture representation in the codebase.
4. Guarantee reproducibility without requiring live GitHub network access during normal automated test runs.
5. Create targeted tests verifying fixture identity, metadata integrity, checksum immutability, and path traversal security.
6. Provide documentation detailing the fixture's purpose, characteristics, and upcoming reuse in Steps 18–26.

---

## 1. Selected Golden Repository & Pinned Identity

- **Repository Full Name**: `shadcn-ui/taxonomy`
- **Repository URL**: `https://github.com/shadcn-ui/taxonomy`
- **Repository Name**: `taxonomy`
- **Pinned Commit SHA**: `298a8857c7128a0d121e7f699dfd729f23b3966d`
- **Source Branch / Ref**: `refs/heads/main`
- **Commit Message**: `docs: update readme`
- **Author**: `shadcn <m@shadcn.com>`
- **Committed Date**: `2026-04-20T16:01:37+04:00`
- **Fixture Identifier**: `golden-taxonomy-v1`

### Why This Repository Was Selected
1. **Next.js & TypeScript Reference Architecture**: Built as the canonical reference implementation showcasing Next.js 13+ App Router, React Server Components (RSC), and Client Components.
2. **Realistic Modern SaaS Complexity**: Includes file-based routing (`app/(auth)`, `app/(dashboard)`, `app/(marketing)`, `app/api`), route handlers (`POST`, `GET`, `DELETE`), middleware (`middleware.ts`), Prisma ORM schemas (`prisma/schema.prisma`), NextAuth authentication (`lib/auth.ts`, `pages/api/auth`), and Stripe webhooks (`app/api/webhooks/stripe/route.ts`).
3. **TypeScript Configuration & Path Aliases**: Fully configured `tsconfig.json` utilizing path mapping (`@/* -> ./*`) and barrel files (`components/ui/*`).
4. **Moderate Size**: Contains 177 files (169 text/code files) totaling ~2.16 MB on disk (compressed archive ~1.15 MB), fitting well within Fluxora's ingestion limits (`maxFileCount: 10,000`, `maxTotalBytes: 100MB`) without bloating repository size or slowing down test execution.
5. **Architectural Permanence**: As an archived open-source reference project, the pinned commit `298a8857c7128a0d121e7f699dfd729f23b3966d` is immutable and will not experience upstream branch churn or force pushes.

---

## 2. Fixture Storage & Structure

The canonical fixture files are placed under `fixtures/golden/`:
```text
fixtures/golden/
├── manifest.json                # Complete manifest with SHA-256 digests and file metadata
└── taxonomy/                    # Clean source tree of shadcn-ui/taxonomy at pinned SHA
    ├── app/                     # App router routes and route handlers
    │   ├── (auth)/
    │   ├── (dashboard)/
    │   ├── (marketing)/
    │   ├── api/
    │   └── layout.tsx
    ├── components/              # React UI components and barrel exports
    ├── config/                  # Navigation and application configuration
    ├── content/                 # MDX documentation and blog posts
    ├── hooks/                   # Custom React hooks
    ├── lib/                     # Database, auth, and utility modules
    ├── pages/                   # NextAuth API routes
    ├── prisma/                  # Prisma schema and migrations
    ├── styles/                  # CSS stylesheets
    ├── types/                   # TypeScript declaration files
    ├── next.config.mjs          # Next.js configuration
    ├── package.json             # Manifest with scripts and dependencies
    └── tsconfig.json            # TypeScript configuration with path aliases
```

### Exclusions
Per Fluxora's testing strategy, the fixture explicitly excludes:
- `node_modules/`
- `.next/` build caches
- Temporary build outputs / `.turbo/`
- Git history directory (`.git/`)
- Secrets and environmental files (`.env.local`)

---

## 3. Metadata Contracts & Access Helper

In `@fluxora/shared-types`:
- `GoldenFixtureManifest`: Structured contract declaring repository identity, framework characteristics, file counts, sizes, and per-file SHA-256 checksums.
- `GoldenFixtureCharacteristics`: Declarative indicators (`framework: 'Next.js'`, `language: 'TypeScript'`, `router: 'app'`, `hasServerComponents: true`, `hasApiRoutes: true`, `hasPrisma: true`, etc.).

In `@fluxora/workers` (`apps/workers/src/fixtures/golden.ts`):
- `loadGoldenFixtureManifest()`: Synchronously loads and parses `manifest.json`.
- `getGoldenFixtureRootPath()`: Returns the absolute filesystem path to `fixtures/golden/taxonomy`.
- `readGoldenFixtureFile(relativePath)`: Reads buffer of any fixture file with sandbox path traversal validation.
- `readGoldenFixtureFileText(relativePath)`: Reads UTF-8 contents of any fixture file.

---

## 4. Reuse in Steps 18–26

The golden fixture established here serves as the ground truth reference across upcoming implementation steps:
- **Step 18 (Language/Framework Detection)**: Verifies detector identifies Next.js (App Router), TypeScript, React, and Prisma.
- **Step 19 (Symbol Extraction)**: Verifies AST parsing of functions, classes, and exported constants across Server and Client Components.
- **Step 20 (Import/Export Graph)**: Verifies resolution of `@/*` path aliases via `tsconfig.json` and barrel exports.
- **Step 21 (Route Detection)**: Verifies detection of file-based Next.js routes (`app/api/posts/route.ts`, `app/(dashboard)/page.tsx`).
- **Step 22 (Event Patterns)**: Verifies detection of event publishing/handling patterns (e.g. Stripe webhooks).
- **Step 23 (DB Reference Detection)**: Verifies extraction of Prisma client queries (`prisma.post.findMany`, `prisma.user.update`).
- **Step 24 (Tree-sitter Fallback)**: Verifies error-tolerant parsing of complex/unsupported syntax.
- **Step 25 (Normalization)**: Verifies barrel-file resolution and symbol deduplication.
- **Step 26 (Full Pipeline & Hand Verification)**: Full end-to-end extraction and graph generation validated against human ground truth.

---

## 5. Security & Verification

1. **Untrusted Code Invariant**: The golden fixture source files are strictly treated as data/text inputs for static analysis. They are never executed, evaluated, or imported as runnable code.
2. **Path Traversal Protection**: `readGoldenFixtureFile` verifies all requested paths resolve within `GOLDEN_FIXTURE_DIR`.
3. **Deterministic Verification**: Tests in `apps/workers/src/fixtures/golden.test.ts` verify:
   - All fixture constants match the canonical pinned identity.
   - Pinned commit is a 40-character hexadecimal SHA.
   - Manifest loads without network access and all calculated file hashes match recorded digests.
   - Core structural files (`package.json`, `tsconfig.json`, `app/layout.tsx`, `prisma/schema.prisma`) exist and contain expected patterns.
   - Path traversal attempts are rejected.

