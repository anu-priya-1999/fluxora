# Phase 1 Step 2 — PostgreSQL, migrations, Organization/User, RLS

Scope of this note: only what this step introduced. Per the implementation request, **install, migrate, typecheck, test, and build were not run** as part of this step unless you run them locally afterward.

## Migration CLI runtime bug (Node 24 type stripping)

**Bug:** `pnpm db:migrate` / `node --experimental-strip-types src/cli/migrate.ts` failed with `ERR_MODULE_NOT_FOUND` for `packages/db/src/pool.js` (imported from `src/cli/migrate.ts`).

**Root cause:** `@fluxora/db` is executed as TypeScript source, not compiled `.js`. Node 24’s type-stripping loader resolves import specifiers as written. A relative `../pool.js` looks for `pool.js` on disk and does not rewrite or fall back to `pool.ts`. The same mismatch existed on other relative `@fluxora/db` imports.

**Fix:** Point relative imports in `packages/db` at the `.ts` sources (`migrate.ts`, `pool.ts`, `index.ts`, repositories). `packages/db/tsconfig.json` sets `allowImportingTsExtensions` so those specifiers remain valid under `noEmit` typechecking. Schema, SQL, and later-phase packages were not changed.

## What was implemented

- **`@fluxora/shared-types`**: `Organization`, `User`, `UserRole`, `PlanTier`, and create-input types aligned with `06-database-schema.md` §6.3 (foundation columns only).
- **`@fluxora/db`**:
  - `DATABASE_URL` configuration and a shared `pg` connection pool.
  - Forward-only SQL migrations in `packages/db/migrations/` with a `schema_migrations` ledger table.
  - `pnpm db:migrate` (root) → `pnpm --filter @fluxora/db migrate` → Node runs `src/cli/migrate.ts` (loads repo-root `.env` when present).
  - Postgres schema: `organizations`, `users`, enums `user_role` and `plan_tier`.
  - Row-Level Security on both tables, keyed on session variable `app.current_org_id`.
  - `withTenant(organizationId, fn)` sets that variable inside a transaction (`set_config(..., true)` = transaction-local, safe with pooling).
  - Repositories: `createOrganization`, `getOrganizationById`, `createUser`, `getUserById`, `listUsersInOrganization`.
  - Bootstrap inserts via `SECURITY DEFINER` functions `fluxora_create_organization` and `fluxora_create_user` (RLS does not allow raw `INSERT` on `organizations` without a tenant context).

Not implemented (later Phase 1 / product): GitHub OAuth, JWT/session middleware, Next.js UI, Redis, jobs, audit_log, seed scripts, Docker, RLS integration tests, non-superuser DB role for local dev.

## Why the database architecture is structured this way

Fluxora treats **PostgreSQL as the single system of record** for tenancy, users, and (later) the graph, evidence, and jobs (`06-database-schema.md` §6.1, `DESIGN.md` §10). Putting schema, migrations, and queries in **`packages/db`** keeps `apps/api` and `apps/workers` as orchestration layers: they authenticate, authorize, and call `@fluxora/db`, but they do not own SQL or migration files (`05-component-responsibilities.md`, `DESIGN.md` §11).

**Shared shapes live in `packages/shared-types`** so API responses, worker payloads, and row mappers agree on `UserRole` and `PlanTier` without the contract package importing `pg` or SQL.

**Tenant isolation is enforced in the database**, not only in application `WHERE` clauses (`03-architecture-principles.md` P9, `06-database-schema.md` §6.5). RLS is defense in depth under API middleware (`11-security-architecture.md` §11.4). If application code forgets a filter, Postgres still hides other tenants’ rows when policies apply.

**Migrations are plain SQL** applied by a small TypeScript runner rather than an ORM schema generator. That matches deployment guidance (forward-only, additive-first, `13-deployment-architecture.md` §13.5) and keeps the graph/evidence DDL readable when later phases add large tables.

**Bootstrap writes use `SECURITY DEFINER` functions** because RLS correctly blocks inserting an `organizations` row while no `app.current_org_id` is set. Signup and org creation (Phase 1 Step 3) will call these functions; day-to-day reads and tenant-scoped writes use `withTenant`.

## Concepts and terminology

### System of record

The authoritative store for durable product data. In Fluxora, that is PostgreSQL for tenancy through AI analysis records in the MVP (`06-database-schema.md` §6.1).

### Tenant / organization

An `Organization` is the tenant boundary (`06-database-schema.md` §6.3). Every user belongs to one organization. Later tables hang off `organization_id` directly or through repository → snapshot chains.

### Row-Level Security (RLS)

Postgres feature: policies attached to a table filter which rows are visible or writable for the current database role/session.

**Fluxora:** policies on `organizations` and `users` compare row keys to `fluxora_current_org_id()`, which reads `current_setting('app.current_org_id', true)`. The API/worker sets that once per transaction via `withTenant`.

### `FORCE ROW LEVEL SECURITY`

Even the table owner must obey policies (unless the role bypasses RLS). Fluxora enables this so application connections that own tables still cannot accidentally skip isolation—**except** superusers and roles with `BYPASSRLS`, which always bypass RLS in PostgreSQL.

**Local implication:** connecting as the `postgres` superuser during development **does not exercise RLS**. Phase 1 testing strategy expects cross-tenant read tests against a real Postgres role subject to RLS (`12-testing-strategy.md`).

### Session variable / `set_config`

`SELECT set_config('app.current_org_id', '<uuid>', true)` stores the tenant id for the **current transaction** when the third argument is `true`. That avoids leaking tenant context across pooled connections after commit.

### `SECURITY DEFINER` function

A Postgres function that runs with the privileges of its owner (typically the migration role), not the caller. Used here only for controlled bootstrap inserts with explicit validation inside the function body— not as a general escape hatch for reads.

### Migration / forward-only schema change

A versioned SQL file applied once, recorded in `schema_migrations`. Rollbacks are not automated in this step; production strategy is additive migrations and expand/contract deploys (`13-deployment-architecture.md` §13.5).

### Connection pool (`pg.Pool)

Reuses TCP connections to Postgres. Requires transaction-local tenant settings (above) so one pool serves many requests safely.

### Repository (in `packages/db`)

Small modules that execute SQL and map rows to `@fluxora/shared-types` interfaces. This is the only layer apps should use for Organization/User persistence in this phase.

### Defense in depth

Application RBAC **and** database RLS (`11-security-architecture.md`). Neither alone is sufficient for Fluxora’s threat model.

## Important security and architecture decisions

1. **RLS from the first migration** (`17-implementation-roadmap.md` Phase 1 security note)—not retrofitted later.
2. **No raw `INSERT` on `organizations` under RLS**—org creation goes through `fluxora_create_organization`.
3. **User inserts** allowed under RLS only when `organization_id` matches `app.current_org_id`; bootstrap also exposed via `fluxora_create_user` for flows that do not yet have a session.
4. **Database access stays in `@fluxora/db`**—apps must not embed SQL for these tables.
5. **Contracts in `@fluxora/shared-types`**—roles and tiers are shared enums/types, not duplicated in the API package.
6. **No Docker**—uses existing local `fluxora_dev` and `DATABASE_URL` (`DESIGN.md` §8).
7. **Superuser local connections bypass RLS**—documented limitation until a dedicated `fluxora_app` role is introduced (likely with auth/CI work in later steps).
8. **GitHub ids nullable** until Step 3 OAuth; unique constraints prepare for login lookup later.

## Likely interview questions and answer points

**Why Postgres for everything including the graph?**  
MVP graphs are bounded-depth and fit adjacency-list + recursive CTEs; one engine simplifies transactions with evidence and tenancy (`06-database-schema.md` §6.1, ADR-002).

**How do you enforce multi-tenancy?**  
`organization_id` on tenant data; RLS compares to `app.current_org_id` set per transaction; API also enforces RBAC (`06-database-schema.md` §6.5, `11-security-architecture.md` §11.4).

**Why both app-layer authz and RLS?**  
Different failure modes: buggy query vs. connection pool misuse vs. future read-only tools. RLS returns empty sets for cross-tenant reads when policies apply (`12-testing-strategy.md`).

**Why `SECURITY DEFINER` for creating organizations?**  
RLS blocks inserts without a tenant context; signup must create a tenant before any `current_org_id` exists. The function centralizes validation instead of disabling RLS globally.

**Why transaction-local `set_config`?**  
Pooled connections must not serve tenant A’s setting to tenant B’s request.

**Why not Prisma/Drizzle in this step?**  
Minimal, production-oriented SQL migrations with full control over RLS policies and definer functions; ORM can be revisited if it does not fight RLS.

**What would you test next?**  
Migration up on real Postgres; cross-tenant `SELECT` as a non-superuser role expecting zero rows; org/user repository happy paths (`12-testing-strategy.md`).

## Files changed

Created:

- `packages/shared-types/src/tenant.ts`
- `packages/db/migrations/0001_organization_user_rls.sql`
- `packages/db/src/config.ts`
- `packages/db/src/pool.ts`
- `packages/db/src/tenant.ts`
- `packages/db/src/mappers.ts`
- `packages/db/src/migrate/runner.ts`
- `packages/db/src/cli/migrate.ts`
- `packages/db/src/repositories/organization.ts`
- `packages/db/src/repositories/user.ts`
- `learning/phase-01/step-02-database.md`

Modified:

- `packages/shared-types/src/index.ts` — tenant exports
- `packages/db/src/index.ts` — public db API; relative exports use `.ts` for Node type stripping
- `packages/db/src/cli/migrate.ts` — relative imports use `.ts`
- `packages/db/src/pool.ts` — relative import uses `.ts`
- `packages/db/src/repositories/organization.ts` — relative imports use `.ts`
- `packages/db/src/repositories/user.ts` — relative imports use `.ts`
- `packages/db/package.json` — `pg`, migrate script, Node types
- `packages/db/tsconfig.json` — `"types": ["node"]`, `allowImportingTsExtensions`
- `package.json` — `db:migrate` script
- `docs/DESIGN.md` — foundation checklist and next step (Step 3)

Unchanged on purpose:

- `apps/*` — still shells; no auth or HTTP routes
- `.env.example` — still documents `DATABASE_URL` (ensure passwords with `@` are URL-encoded when used)

## Remaining Phase 1 work

From `docs/architecture/17-implementation-roadmap.md`, after Step 2:

3. GitHub OAuth login, JWTs, session middleware (set `app.current_org_id` on each authenticated request).
4. Next.js app with auth flow (`/`, `/login`, empty org dashboard).
5. Redis, object storage, secrets-manager client abstraction.
6. Postgres-backed job queue + minimal worker harness.
7. OpenTelemetry on one dummy endpoint.
8. CI (lint, typecheck, unit test) and CD to preview per PR.
9. Local-dev `docker-compose` + seed script skeleton (optional for this machine; Docker still deferred in `DESIGN.md`).

Also still open within Phase 1 acceptance: RLS cross-tenant **tests**, `audit_log` table, non-superuser DB role for realistic local RLS, and wiring API/workers to call `@fluxora/db` after auth exists.

Phase 1 acceptance remains unmet: no login, no dashboard, no CI/CD preview deploy. Phases 2–12 not started.

## Local verification (not run in this step)

When you choose to verify:

1. `pnpm install` at repo root (adds `pg` to `@fluxora/db`).
2. Ensure `.env` has a valid `DATABASE_URL` for `fluxora_dev`.
3. `pnpm db:migrate`
4. Optionally exercise repositories from a one-off script or Step 3 auth integration.

Do not claim these passed unless you actually run them.
