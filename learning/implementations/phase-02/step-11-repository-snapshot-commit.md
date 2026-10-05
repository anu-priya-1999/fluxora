# Phase 2 — Step 11 Implementation Note

Repository, RepositorySnapshot, and Commit data model.

Canonical sources:

- `docs/architecture/06-database-schema.md` (§6.3 entities, §6.5 tenancy)
- `docs/architecture/11-security-architecture.md` (§11.2 connection status, §11.4 isolation, §11.7 snapshot immutability)
- `docs/architecture/17-implementation-roadmap.md` Phase 2 step 2 (global Step 11)

This note describes what was implemented. It does not describe Step 12 ingestion.

---

## Objective

Add the PostgreSQL data model and tenant-safe data-access layer for:

- `Repository` belonging to `Organization`
- `RepositorySnapshot` belonging to `Repository` (immutable)
- `Commit` belonging to `Repository`

No GitHub repository fetching, installation access tokens, object-storage upload, ingestion worker, connect API, WebSocket progress, or repository UI.

---

## Acceptance criteria

- Forward-only migration `0011_repositories_snapshots_commits.sql` (do not edit 0001–0010).
- Tables, PKs, FKs, uniques, checks, indexes match architecture and existing conventions.
- `ENABLE` + `FORCE ROW LEVEL SECURITY` on all three tables.
- Repository policies use `organization_id = fluxora_current_org_id()`.
- Snapshot/commit policies use parent-chain tenancy (`fluxora_repository_in_current_tenant`).
- Child tables do **not** duplicate `organization_id`.
- Data-access modules follow `withTenant` + GitHub-id string/`::bigint` conventions.
- Tests cover create/read/update, connection_status, snapshot immutability, commit create/read, parent relationships, and cross-tenant denial.
- Step 10 GitHub installation flow is unchanged.

---

## Exact files changed

### Created

| File | Responsibility |
|---|---|
| `packages/db/migrations/0011_repositories_snapshots_commits.sql` | Schema, constraints, indexes, RLS, helper function |
| `packages/shared-types/src/repository.ts` | Shared `Repository` / `RepositorySnapshot` / `Commit` types |
| `packages/db/src/repositories/repository.ts` | Tenant-scoped repository CRUD |
| `packages/db/src/repositories/repository-snapshot.ts` | Snapshot insert/read + immutability semantics |
| `packages/db/src/repositories/commit.ts` | Commit insert/read |
| `packages/db/src/migrate/repositories-data-model.test.ts` | Static migration contract (FORCE RLS, parent-chain, no child org id, no snapshot UPDATE policy) |
| `packages/db/src/repositories/repository.test.ts` | Validation unit tests (no database) |
| `packages/db/src/repositories/repository-data-model.test.ts` | PostgreSQL integration tests (skipped if `DATABASE_URL` is unset) |
| `learning/10. Repository Snapshot Commit Data Model.md` | Personal learning note |
| `learning/phase-02/step-11-repository-snapshot-commit.md` | This implementation note |
| `learning/interviews/4. Step 11 Repository Snapshot Commit Interview CheatSheet.md` | Interview sheet |

### Modified

| File | Responsibility |
|---|---|
| `packages/shared-types/src/index.ts` | Export repository types |
| `packages/db/src/index.ts` | Export data-access functions and errors |
| `packages/db/src/tenant.ts` | Optional `SET LOCAL ROLE` when `FLUXORA_DATABASE_ROLE` is set so FORCE RLS is evaluated (local superuser otherwise bypasses policies) |
| `docs/DESIGN.md` | Record Step 11 status, verification, learning package, design section |

Step 10 GitHub App modules were not modified.

---

## File-by-file responsibility map

```text
shared-types/repository.ts
  domain records only (no SQL)

migrations/0011_*.sql
  source of truth for tables, RLS, constraints

repositories/repository.ts
  create / get / list / update connection fields under withTenant

repositories/repository-snapshot.ts
  insert snapshot; identical replay; reject mutate; SELECT by id/repo

repositories/commit.ts
  insert commit; identical replay; SELECT by id/repo

tenant.ts (unchanged)
  sets app.current_org_id for every write/read above
```

---

## Migration explanation

Next number after `0010_grant_bootstrap_function_execute.sql` is **0011**. Already-applied migrations were not edited.

The migration is forward-only SQL applied in one transaction by `packages/db` `runMigrations`.

It creates enum `repository_connection_status` (`pending`, `active`, `needs_reauth`, `error`), three tables, indexes, `fluxora_repository_in_current_tenant(uuid)`, and RLS policies.

Bootstrap role `fluxora_bootstrap` is not granted these tables. Org/user provisioning does not insert repositories.

---

## Schema explanation

### repositories

`id, organization_id, github_repo_id, name, default_branch, connection_status, last_indexed_at, created_at`

- Tenant-owned. `github_repo_id` is GitHub's id (`bigint`, exposed as decimal string in TypeScript).
- `last_indexed_at` is nullable until an ingestion step sets it.
- Default `connection_status` is `pending`.

### repository_snapshots

`id, repository_id, commit_sha, ref, storage_uri, file_count, size_bytes, created_at`

- No `organization_id`.
- `commit_sha` is 40 lowercase hex (Git SHA-1 as GitHub still uses).
- `storage_uri` is a URI string; this step does not write objects.

### commits

`id, repository_id, sha, author, message, committed_at, parent_shas`

- `parent_shas text[]` not null, default `{}`.
- No UPDATE policy (git objects are immutable).

---

## Constraint and index explanation

**Uniques**

- `(organization_id, github_repo_id)` — per-tenant GitHub repo identity; same public GitHub id may exist in another org.
- `(repository_id, commit_sha)` on snapshots — one immutable tree per commit.
- `(repository_id, sha)` on commits — one git object row per SHA.

**Checks**

- positive `github_repo_id`, non-empty name/branch/ref/storage_uri/author
- SHA format, non-negative file_count/size_bytes
- `parent_shas` contains no NULLs (format of each SHA validated in application code; PostgreSQL CHECK cannot easily regex-array without a subquery)

**Indexes** — see personal learning note; they match list-by-org, filter-by-status, latest-snapshot, and history-by-time.

**FKs** all `ON DELETE CASCADE` to parent.

---

## RLS explanation

All three tables: `ENABLE` + `FORCE ROW LEVEL SECURITY`.

Repositories: four policies (SELECT/INSERT/UPDATE/DELETE) on `organization_id = fluxora_current_org_id()`.

Snapshots and commits:

- SELECT/INSERT/DELETE via `fluxora_repository_in_current_tenant(repository_id)`
- **No UPDATE policy** → overwrite denied

`fluxora_repository_in_current_tenant` is `LANGUAGE sql STABLE` `SECURITY INVOKER` (default). It must not be `SECURITY DEFINER`; that could see other tenants' repositories and weaken the EXISTS.

DELETE on children is required so repository/org cascade succeeds under FORCE RLS.

---

## Test strategy

1. **Static SQL test** — migration text must contain FORCE RLS, parent-chain policies, uniques, and must not add `organization_id` to child table definitions or snapshot UPDATE policies. Runs in CI without Postgres.
2. **Validation unit tests** — invalid GitHub id / SHA rejected before any query. Runs in CI.
3. **Integration tests** — require `DATABASE_URL` (loaded from repo-root `.env`). Skipped in CI where the env is absent. Against local `fluxora_dev` they cover:
   - repository create/read/update
   - `connection_status` pending → active → needs_reauth → error
   - snapshot create, identical replay, different payload rejected, UPDATE rowCount 0
   - commit create/read, parent_shas, listing order
   - snapshot/commit belong to repository lists
   - org B cannot read org A repository/snapshot/commit
   - org B cannot insert child rows against org A's `repository_id`
   - org B can create its own repo with the same `github_repo_id`

Cleanup deletes organizations whose names match the test suffix.

---

## Verification commands / results

Recorded after the local run (see also `docs/DESIGN.md` Step 11 verification):

```text
pnpm db:migrate
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Local results:

- `pnpm db:migrate` applied `0010_grant_bootstrap_function_execute.sql` (already pending on this database) and `0011_repositories_snapshots_commits.sql`
- `pnpm typecheck` passed
- `pnpm lint` passed
- `pnpm test` passed (46 tests)
- `pnpm build` passed
- Catalog check: FORCE RLS on all three tables; no snapshot/commit UPDATE policies; no child `organization_id`

---

## Production deployment considerations

- Apply `0011_repositories_snapshots_commits.sql` with the same migration runner as prior steps. Do not rewrite 0008–0010.
- Hosted PostgreSQL uses FORCE RLS already; new tables inherit that model.
- No new environment variables. No S3 bucket required until Step 12.
- `db:reset` `TRUNCATE organizations CASCADE` already removes these rows; no seed repositories are created.
- Application must keep using `withTenant`. Raw SQL against these tables without `app.current_org_id` returns no rows.

---

## Recommended code-reading order

1. `docs/architecture/06-database-schema.md` Repository / Snapshot / Commit + §6.5
2. `packages/db/migrations/0011_repositories_snapshots_commits.sql`
3. `packages/shared-types/src/repository.ts`
4. `packages/db/src/tenant.ts` (existing)
5. `packages/db/src/repositories/repository.ts`
6. `packages/db/src/repositories/repository-snapshot.ts`
7. `packages/db/src/repositories/commit.ts`
8. `packages/db/src/repositories/repository-data-model.test.ts`
9. `learning/10. Repository Snapshot Commit Data Model.md`

---

## End-to-end Step 11 lifecycle

```text
Organization exists (Phase 1 / Step 10)
        ↓
createRepository (pending, github_repo_id, name, default_branch)
        ↓
(optional) updateRepository connection_status / last_indexed_at
        ↓
createCommit (sha, author, message, parents)     — metadata only
        ↓
createRepositorySnapshot (commit_sha, ref, storage_uri, counts)
        ↓
Identical snapshot/commit insert → same row
Conflicting snapshot payload → RepositorySnapshotImmutableError
UPDATE snapshot → 0 rows (RLS)
Other tenant session → empty reads / failed child inserts
```

Nothing in this lifecycle calls GitHub Contents API, clones a repo, or writes object storage. Those are Step 12.
