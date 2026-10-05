# Phase 1 Step 1 — Monorepo foundation

Scope of this note: only what this step introduced. Nothing here was typechecked, installed, built, or tested.

## What was implemented

A pnpm workspace with five private packages and a strict TypeScript setup. Each package exports one module from TypeScript source. There is no HTTP server, Next.js app, database client, migration, auth, queue, or product UI.

Workspace members:

| Package | Name | Depends on |
|---|---|---|
| `apps/api` | `@fluxora/api` | `@fluxora/db`, `@fluxora/shared-types` |
| `apps/web` | `@fluxora/web` | `@fluxora/shared-types` |
| `apps/workers` | `@fluxora/workers` | `@fluxora/db`, `@fluxora/shared-types` |
| `packages/db` | `@fluxora/db` | `@fluxora/shared-types` |
| `packages/shared-types` | `@fluxora/shared-types` | nothing inside the workspace |

`pnpm-workspace.yaml` already listed `apps/*` and `packages/*`. This step left that file as-is and added the packages it names.

The root script is `pnpm typecheck`, which runs each package `typecheck` script if present. Lint, test, and build scripts were not added, because those tools are not part of this step.

Node observed on this machine: v24.18.0. `pnpm -v` returned 10.34.5, matching the `packageManager` field already in the root manifest. The root manifest requires `node >= 20`. Compatibility with Node 20 was not tested.

## Why the architecture is structured this way

Fluxora has three runtime roles and two shared libraries. The architecture docs assign them different jobs so that a slow or unsafe task cannot sit inside a request, and so that contracts stay separate from persistence.

- `apps/web` is the product UI. It will be a Next.js app in Phase 1 Step 4. It reads server state through the API. It does not own business rules or the database.
- `apps/api` is the HTTP boundary: authz, resource CRUD, job orchestration, and reads. It must not do heavy repository analysis inside a request. That behavior is not implemented yet; the package only reserves the boundary.
- `apps/workers` is where asynchronous work will run: ingestion, static analysis, graph construction, impact, simulation, and AI calls. Locally they may later share one process. In production the deployment doc splits heavier analysis workers from the API so parsing does not starve request latency.
- `packages/db` will own schema, migrations, queries, and transactions. PostgreSQL is the MVP system of record, including the graph. This step does not add a schema.
- `packages/shared-types` will own types shared across apps: domain contracts, API contracts, event payloads. Keeping them here stops the API and workers from inventing divergent shapes.

The dependency arrows are one-way on purpose:

- Shared contracts depend on nobody in the repo. If they imported `db` or an app, every package would risk a cycle.
- The database package may use shared contracts. Apps do not reach into each other.
- The web package depends only on shared types. A UI that imported `@fluxora/db` would couple the browser app to persistence and could pull server-only code toward the client.
- API and workers both depend on `db` and shared types, because both will read and write tenant data. They do not depend on each other. The API will enqueue work; workers will pick it up through the database. That link is a later step (the job table), not an in-process import.

This matches principle P8: boring, separate processes and a normal database, with novelty reserved for code intelligence and evidence later. It also matches P1 and P9 only as reserved boundaries: the deterministic core and tenant isolation are not implemented in this step. The folders are where those will live so they are not mixed into the UI.

Local hardware does not change that split. The machine constraint in DESIGN.md is Windows and 4 GB RAM. Redis, MinIO, Docker, and Kubernetes stay deferred. Production can still run the same package boundaries as separate containers later.

## Concepts and terminology

### Monorepo

One Git repository holds several packages that are versioned and changed together.

Fluxora uses one repo because the API, workers, web app, database layer, and shared contracts must change in lockstep. A graph-edge type used by a worker and returned by the API should not drift across repositories. The repo is still small; separate repos would add versioning overhead before there is a product.

### Workspace

A workspace is the set of packages a package manager installs and links as one unit.

Fluxora's workspace is declared in `pnpm-workspace.yaml` as `apps/*` and `packages/*`. The root `package.json` is private and is not itself a library.

### pnpm

pnpm is the package manager. It stores each dependency version once in a content-addressable store and links it into packages. The root manifest pins `packageManager` to pnpm 10.34.5.

Fluxora uses pnpm because the architecture's local-dev entry point is `pnpm dev` (later), and because a single store matters on a small disk and 4 GB RAM machine. This step did not run an install.

### Workspace protocol (`workspace:*`)

A dependency version of `workspace:*` means "use the package of that name inside this workspace," not a version published to npm.

`@fluxora/api` depends on `workspace:*` for `@fluxora/db` and `@fluxora/shared-types`. Those names are not public npm packages. The protocol is what makes the internal dependency graph real once dependencies are installed.

### Package manifest

`package.json` names the package, marks it private, lists dependencies, and defines scripts.

Every Fluxora workspace package is `"private": true` and `"version": "0.0.0"`. They are not meant to be published. `"type": "module"` marks each package as ECMAScript modules.

### `exports`

The `exports` field is the public entry point of a package. Other files are not part of the package API.

Each package exports `"."` to `./src/index.ts`. Callers import `@fluxora/api`, not a deep file path. Later phases can change the implementation behind that entry without inviting cross-package imports of internals.

### App vs package

`apps/` holds deployable processes. `packages/` holds libraries used by those processes.

Fluxora deploys web, API, and workers as separate processes (one local worker process is allowed later). `db` and `shared-types` are libraries. They are not services.

### Dependency direction

A dependency is an allowed import edge. The important property is which way the edge points.

Fluxora forbids web → db, and forbids shared-types → anything internal. API and workers may both use db. Neither app imports the other. That keeps the UI, the HTTP boundary, and async work separable, which is also why workers can be deployed without redeploying the API.

### TypeScript

TypeScript is the language used for the API, workers, web app, and shared libraries. The compiler checks types before, or instead of, emitting JavaScript.

Fluxora standardizes on TypeScript because the product analyzes TypeScript/JavaScript systems and because shared contracts need one type system across apps. This step adds the compiler configuration only. It does not parse customer repositories.

### `strict`

`"strict": true` turns on a fixed set of compiler checks: `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`, `noImplicitAny`, `noImplicitThis`, `alwaysStrict`, and `useUnknownInCatchVariables`.

Those checks apply to every Fluxora package through `tsconfig.base.json`. They do not by themselves prove architectural invariants. They only make the TypeScript in this repo reject implicit `any`, unchecked nulls, and sloppy `this`.

### Additional compiler flags in the shared config

These are not all implied by `strict`. They are set explicitly in `tsconfig.base.json`.

| Flag | What it does | Why it is set for Fluxora |
|---|---|---|
| `noUncheckedIndexedAccess` | Indexing an array or record adds `undefined` to the result type. | Missing graph or map entries should be handled explicitly once those structures exist. |
| `exactOptionalPropertyTypes` | An optional property may be omitted. Assigning `undefined` is a different type. | Shared contracts can distinguish "field absent" from "field present and undefined." |
| `noImplicitOverride` | A method that overrides a base method must say `override`. | Small classes stay explicit when workers and services grow. |
| `noImplicitReturns` | Every path in a function must return a value. | Analysis functions should not fall off the end accidentally. |
| `noFallthroughCasesInSwitch` | A `case` must end or be empty before the next case. | Discriminated unions (`node_type`, job status) are expected later; fallthrough would mix them. |
| `noUnusedLocals` / `noUnusedParameters` | Unused bindings are errors. | Keeps placeholder modules from accumulating dead code. The `void` uses in package entry files exist so the workspace imports count as used. |
| `forceConsistentCasingInFileNames` | Import path casing must match the real filename. | This repo is developed on Windows, where the filesystem is case-insensitive, and may be checked on a case-sensitive system. |
| `verbatimModuleSyntax` | Type-only imports must use `import type`. Value imports are kept in the emit. | Shared packages will mix types and values. This flag prevents types from being imported as if they were runtime values. |
| `isolatedModules` | Each file must be valid on its own, as a transpiler would see it. | Compatible with later Next.js or other single-file transpilers. |
| `skipLibCheck` | Do not typecheck `.d.ts` files from dependencies. | Cuts work during typecheck on a 4 GB machine. It does not skip checking Fluxora's own source. |
| `noEmit` | The compiler checks types and writes no JavaScript. | This step has no build. Typecheck is a check, not a compile. |
| `types: []` | Do not automatically include `@types/*` packages such as Node. | No Node APIs are used yet, and `@types/node` is not a dependency. |
| `module` / `moduleResolution`: `ESNext` / `Bundler` | Resolve packages the way a bundler does, including TypeScript source in `exports`. | Packages point `exports` at `.ts` files. Bundler resolution can follow that without a declaration emit. |
| `target` / `lib`: `ES2022` | The language level assumed for output and standard library types. | No DOM library is included. The web package is not a browser app yet. |

### `noEmit` versus project references

Project references (`composite`, `tsc -b`) typecheck a monorepo in dependency order and emit `.d.ts` files. That is a build.

This step uses `noEmit` and source `exports` instead. A typecheck does not need to write `dist/`. Declaration emit and project references can be added when a package must publish types or when Node must run emitted JavaScript. They were not required to name the packages.

### ECMAScript modules (`"type": "module"`)

The package is interpreted as ESM. Imports are static `import` statements, not CommonJS `require`.

Fluxora packages are ESM so the later API, workers, and Next.js app share one module system. No package uses `require`.

### Root script

A root script is an npm/pnpm script on the repository root that fans out to workspace packages.

`pnpm typecheck` runs `pnpm -r --if-present typecheck`. `-r` means recursive across workspace packages. `--if-present` skips a package that has no `typecheck` script. The root package does not define its own compiler project; `tsconfig.json` at the root includes no files and only exists so the base config has a root file. Each package typechecks with `tsc --noEmit -p tsconfig.json`.

### `.npmrc` install limits

`child-concurrency=1` and `network-concurrency=2` tell pnpm to do less work in parallel during install.

They are set because the development machine has 4 GB RAM. They do not change the production architecture. They also do nothing until an install is run. No install was run in this step.

### Phase boundary

A roadmap step is the only allowed scope. Later steps stay unimplemented even if the architecture already names them.

Phase 1 Step 1 is the monorepo scaffold. Step 4 is the Next.js app. Step 2 is Postgres, migrations, `Organization`, `User`, and RLS. Auth, Redis, jobs, GitHub, analysis, the graph, and AI are outside this step. The entry files export a package name constant and import their declared dependencies. They contain no domain types.

## Technical and architecture decisions

1. **Five packages, matching DESIGN.md section 11 and roadmap step 1.** No extra shared package (config, logger, eslint-config). Those would be new abstractions without a current need.
2. **Web does not depend on `@fluxora/db`.** Persistence stays on the server side of the API.
3. **`@fluxora/db` may depend on `@fluxora/shared-types`. The reverse dependency is not declared.** Contracts stay free of the database client so API DTOs and persistence can evolve on different sides of that edge.
4. **API and workers do not depend on each other.** Coordination through a job table is a later step.
5. **TypeScript source is the package entry.** No `dist/` build in this step, to avoid a compile on a 4 GB machine and to avoid pretending a runtime exists.
6. **Module resolution is `Bundler`, not `NodeNext`.** `NodeNext` expects Node's resolution rules and generally a built `.js` entry. Nothing in this step is executed by Node. When the API or workers gain a runtime, that choice has to be revisited. It is not settled for production execution.
7. **No DOM lib in the web package.** Adding DOM, React, or Next.js would start Phase 1 Step 4.
8. **TypeScript is the only dependency, as a dev dependency, range `~5.9.2`.** No Fastify/Express, Next, React, `pg`, Prisma, Redis, or test runner. Each package lists TypeScript so `pnpm --filter <pkg> typecheck` can see `tsc`. pnpm stores one copy of a given version. Whether the install dedupes correctly was not verified, because install was not run.
9. **No lint, test, or build script.** A script that succeeds without checking would look like verification. The testing strategy's invariants (RLS, idempotent jobs, graph traversal) have no code to test yet.
10. **`.npmrc` only limits install concurrency.** It does not enable hoisting changes or peer-dependency auto-install.
11. **Engine range is `node >= 20`.** The observed runtime is Node v24.18.0. The floor stays at 20 so the manifest does not claim that Node 24 is required. Compatibility of the scaffold with Node 20 was not tested.
12. **Placeholder exports are package name constants, not domain models.** `Organization`, graph nodes, jobs, and API DTOs are not invented here. The constants exist so each `include` has an input file and so workspace imports are real. `void` marks those imports as used under `noUnusedLocals`.

## Likely interview questions and answer points

These are questions this step can support. They are not a record of an interview.

**Why a monorepo instead of three repositories?**  
The API, workers, and UI share contracts and will change together. One workspace makes those contracts a TypeScript package instead of a published version. Separate repos become useful if teams or release cycles diverge. They do not diverge yet.

**Why split API and workers if both are Node processes?**  
The API must stay responsive. Analysis is heavy and retryable. Deployment doc 13 puts analysis in its own pool so a large parse does not consume API CPU. The code boundary is the package split. The process split can be one local process later and separate production processes. The import graph already forbids the API from calling worker code directly.

**Why can the web app not import the database package?**  
The UI is a client of the API. Database access, Row-Level Security, and migrations belong behind the API and workers. A web dependency on `db` would leak persistence into the UI bundle and bypass the authorization boundary the API is supposed to own.

**Why a separate shared-types package instead of putting types in the API?**  
Workers and the web app both need the same contracts. If types lived only in the API, workers would depend on the API package, or the web app would import server code. A leaf package both sides can import avoids that cycle.

**What does `workspace:*` mean?**  
The dependency is linked from this repo at install time. It is not downloaded from the npm registry. The version in the dependency's own manifest is used.

**What does `strict` actually turn on?**  
The eight flags listed above. Name them if asked. Extra flags in this repo (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, unused checks, casing) are stricter than `strict` alone and are explicit choices.

**Why not TypeScript project references on day one?**  
References want composite projects and declaration emit. This step only needs a typecheck with no output. Source exports plus bundler resolution do that. References are a build graph, and there is no build yet.

**Why is Next.js not in the web package?**  
Roadmap step 1 creates the package. Step 4 creates the Next.js app and auth screens. Installing Next, React, and Tailwind now would add a large dependency tree on a 4 GB machine and would implement a later step.

**How does a 4 GB Windows laptop relate to the production architecture?**  
Local setup may defer Redis, object storage, and Docker. It must not collapse API, workers, and database into one unstructured package just to save memory. Interfaces stay compatible with the documented split. `.npmrc` only reduces install parallelism.

**What is intentionally not proven by this step?**  
That `tsc` succeeds, that pnpm links the workspace, or that Node can execute these packages. `noEmit` and bundler resolution mean there is no Node entrypoint yet.

## Files changed

Created:

- `tsconfig.base.json`
- `tsconfig.json`
- `.npmrc`
- `apps/api/package.json`
- `apps/api/tsconfig.json`
- `apps/api/src/index.ts`
- `apps/web/package.json`
- `apps/web/tsconfig.json`
- `apps/web/src/index.ts`
- `apps/workers/package.json`
- `apps/workers/tsconfig.json`
- `apps/workers/src/index.ts`
- `packages/db/package.json`
- `packages/db/tsconfig.json`
- `packages/db/src/index.ts`
- `packages/shared-types/package.json`
- `packages/shared-types/tsconfig.json`
- `packages/shared-types/src/index.ts`
- `learning/phase-01/step-01-monorepo.md`

Modified:

- `package.json` — private workspace root, `typecheck` script, TypeScript dev dependency. Removed the npm-init placeholder `main` and the failing default `test` script.
- `docs/DESIGN.md` — foundation checklist and the immediate next step.
- `.gitignore` — ignore `*.tsbuildinfo`.

Unchanged on purpose:

- `pnpm-workspace.yaml` — already included `apps/*` and `packages/*`.

Not run:

- install
- typecheck
- lint
- test
- build

No lockfile was generated, because install was not run.

## Remaining Phase 1 work

From `docs/architecture/17-implementation-roadmap.md`, Phase 1 steps not done:

2. Postgres, migration tooling, `Organization` and `User` tables, RLS policies.
3. GitHub OAuth login, JWTs, session middleware.
4. Next.js app with auth flow: `/`, `/login`, empty org dashboard.
5. Redis, object storage (S3/MinIO), secrets-manager client abstraction.
6. Postgres-backed job queue table and a minimal worker harness (claim, complete/fail, idempotency key).
7. OpenTelemetry for one dummy endpoint.
8. CI (lint, typecheck, unit test) and CD to a preview environment per PR.
9. Local-dev `docker-compose` and seed script skeleton.

Phase 1 acceptance is still unmet: a user cannot log in, and there is no preview deploy. Phases 2–12 are not started.
