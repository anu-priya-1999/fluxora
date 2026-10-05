# Fluxora — Phase 1 Step 9 Notes
## Local-Dev Compose + Seed Skeleton

## Status

**Step 9 is COMPLETE and verified.**

Verified:

```text
pnpm db:migrate       ✅
pnpm db:seed          ✅
pnpm db:seed          ✅
pnpm db:reset         ✅
pnpm db:seed          ✅
pnpm typecheck        ✅
pnpm lint             ✅
pnpm test             ✅
pnpm build            ✅
```

---

# 1. Step 9 scope

Step 9 implements only local-development infrastructure and database lifecycle tooling.

It does NOT implement:

```text
GitHub App installation
repository ingestion
snapshots
AST analysis
dependency graph
impact analysis
simulation
AI reasoning
Architecture Explorer
```

---

# 2. Files added

```text
docker-compose.yml

packages/db/src/cli/env.ts
packages/db/src/cli/seed.ts
packages/db/src/cli/reset.ts
```

Existing files updated:

```text
package.json
packages/db/package.json
packages/db/src/cli/migrate.ts
.env.example
.gitignore
docs/DESIGN.md
```

The two `.snippet.json` files from the working package were reference snippets, not permanent project files.

---

# 3. Compose environment

The local recipe defines:

```text
PostgreSQL
Redis
MinIO
MinIO bucket initialization
```

PostgreSQL uses:

```text
host port: 5433
container port: 5432
database: fluxora_dev
```

The host port is 5433 because native PostgreSQL already occupies localhost:5432.

---

# 4. Current low-RAM development mode

Machine:

```text
Windows
4 GB RAM
```

Normal local development remains:

```text
PostgreSQL → native 18.6
Redis → InMemoryRedisAdapter
Object storage → FilesystemObjectStorage
API/workers/web → native Node processes
Docker Desktop → not required
```

Compose exists as the reproducible multi-service environment definition.

---

# 5. Migration command

```powershell
pnpm db:migrate
```

Purpose:

```text
bring database schema to current migration state
```

Observed:

```text
No pending migrations.
```

---

# 6. Seed command

```powershell
pnpm db:seed
```

Creates deterministic local identity/data.

Logical seed identity:

```text
github user id: 900000001
email: local.owner@fluxora.dev
organization: Fluxora Local
```

The existing provisioning database function is reused so the seed path follows the database's existing identity/organization invariants.

---

# 7. Seed idempotency verification

We ran the seed twice.

Expected:

```text
same organization
same user
no duplicate local identities
```

Observed:

```text
same organization UUID
same user UUID
```

Therefore the seed is idempotent.

---

# 8. Reset command

```powershell
pnpm db:reset
```

Purpose:

```text
return local DB to a known clean state
then reseed
```

It validates the target database as local development before destructive work.

Safety conditions include:

```text
NODE_ENV = development
host = loopback
database = fluxora_dev
```

---

# 9. Reset behavior

The reset clears local auth state and tenant data, then reseeds.

The existing `oauth_login_states` table is part of the current schema and is cleared as part of local reset.

The tenant root is reset with:

```sql
TRUNCATE TABLE organizations CASCADE;
```

The operation is safe only because the database target is explicitly checked first.

---

# 10. Migration vs seed

Migration:

```text
database structure
```

Seed:

```text
database data
```

Step 9 did not create a new SQL migration.

---

# 11. Why no 0008 migration

Nothing in Step 9 required:

```text
new table
new column
new constraint
new index
new RLS policy
```

Therefore no new schema migration was necessary.

---

# 12. Commands added at root

Expected root scripts:

```json
{
  "db:migrate": "pnpm --filter @fluxora/db migrate",
  "db:seed": "pnpm --filter @fluxora/db seed",
  "db:reset": "pnpm --filter @fluxora/db reset"
}
```

DB package scripts run Node's native strip-types CLI.

---

# 13. Verification matrix

```text
Compose recipe                         ✅
Migration command                      ✅
Seed                                   ✅
Seed idempotency                       ✅
Reset                                  ✅
Reset safety                           ✅
Reset + reseed                         ✅
Typecheck                              ✅
Lint                                   ✅
Tests                                  ✅
Build                                  ✅
CLI module lifecycle bug fixed        ✅
```

Infrastructure test suite:

```text
7 passed
0 failed
```

---

# 14. Debugging incident

Initial reset execution produced:

```text
Called end on pool more than once
```

But the data work itself had succeeded.

The issue was in CLI/module cleanup.

Initial seed structure had:

```ts
export async function seedLocalData() {
  ...
}

async function main() {
  await seedLocalData();
  await closePool();
}

main();
```

`reset.ts` imported `seedLocalData`.

Because importing a module evaluates its top-level statements, `main()` executed unexpectedly.

That created conflicting ownership of the shared database pool.

---

# 15. Top-level call

A top-level call is a function invocation at module scope:

```ts
main();
```

When the module is evaluated, that statement runs.

Importing a named function does not mean every function body runs.

Only the module's top-level executable statements run.

---

# 16. Final fix

Reusable logic remains exported:

```ts
export async function seedLocalData() {
  ...
}
```

CLI entrypoint is separated and guarded so `main()` runs only when `seed.ts` is directly invoked.

Result:

```text
direct seed CLI
→ main runs

reset imports seed.ts
→ reusable function available
→ CLI main does not run
```

---

# 17. Why this matters

The fix demonstrates:

```text
module evaluation awareness
+
side-effect control
+
resource ownership
+
CLI/library separation
```

---

# 18. What to say about the bug

> "The database wasn't broken. The schema wasn't wrong. The reset data operation succeeded. The bug was that the seed module had a top-level CLI entrypoint, so importing the module also executed `main()`. Both code paths could then close the shared PostgreSQL pool. I separated reusable seed logic from direct CLI execution and made ownership of cleanup explicit."

---

# 19. Final Step 9 mental model

```text
Compose
   ↓
Migrate schema
   ↓
Seed known state
   ↓
Develop
   ↓
Reset safely
   ↓
Seed again
   ↓
Verify
```

---

# 20. Next boundary

After Step 9:

```text
Step 9 ✅
    ↓
AWS production infrastructure alignment
    ↓
Step 10 — repository ingestion
```

Do not claim Phase 2 features were implemented during Step 9.
