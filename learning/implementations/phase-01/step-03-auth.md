# Phase 1 Step 3 — Managed Authentication with Clerk

## Scope

This note records the **actual implemented state** of Fluxora Phase 1, Step 3 after migrating from the initial custom GitHub OAuth/JWT implementation to the managed authentication architecture using Clerk.

The original implementation note described a custom in-process GitHub OAuth + JWT system. That was subsequently replaced because the canonical Fluxora architecture names Clerk as the managed authentication provider.

## Status

**Step 3: COMPLETE**

Current authentication flow:

```text
GitHub
   ↓
Clerk
   ↓
Clerk session / JWT
   ↓
Fluxora API
   ↓
Fluxora User + Organization + Role
   ↓
PostgreSQL RLS
```

This preserves the separation between:

- **Authentication:** Clerk establishes the user's identity and session.
- **Authorization / tenancy:** Fluxora maps that identity to its own `User`, `Organization`, and role.
- **Database isolation:** PostgreSQL RLS enforces the tenant boundary.

The canonical architecture diagram already depicts this boundary as `User → Clerk → API → tenant/role check → Postgres RLS`. The security architecture likewise specifies managed authentication, short-lived tokens, and application authorization plus RLS. 

---

## Why the first implementation was changed

The first Step 3 implementation used:

```text
GitHub OAuth authorization code
        ↓
Fluxora exchanges code
        ↓
Fluxora creates its own access JWT
        ↓
Fluxora stores refresh-session state
        ↓
Fluxora verifies its own JWT
```

That implementation was functional in design, but it did not match the canonical architecture's explicit Clerk boundary.

The implementation was therefore migrated rather than extended.

### Legacy custom-auth files removed from the API

```text
apps/api/src/auth/github.ts
apps/api/src/auth/access-token.ts
apps/api/src/auth/crypto.ts
apps/api/src/auth/principal.ts
apps/api/src/http/cookies.ts
```

The old application-level refresh/session repository is no longer used by the active API flow.

The old migration history is **not deleted or rewritten**. Applied migrations remain historical records; obsolete database structures should be cleaned later with a new forward migration.

---

# 1. Clerk becomes the authentication authority

The API now uses:

```text
@clerk/backend
```

The backend verifies a Clerk bearer token and obtains the Clerk user identity.

The request flow is:

```text
Authorization: Bearer <Clerk session JWT>
                    ↓
             verify Clerk token
                    ↓
               Clerk userId
                    ↓
       load Clerk user from backend
                    ↓
      read connected GitHub account
                    ↓
        GitHub providerUserId
                    ↓
       Fluxora identity provisioning
```

The browser/API must not be trusted to provide its own tenant identity.

---

# 2. Why Fluxora still has User and Organization

Using Clerk does **not** remove Fluxora's product-level identity model.

Fluxora still needs:

```text
Organization
   │
   ├── User
   ├── User
   └── User
```

because Fluxora needs to know:

- which tenant owns a repository
- which user belongs to which organization
- whether the user is `owner`, `admin`, `member`, or `viewer`
- which organization-scoped rows the user may access
- how PostgreSQL RLS should isolate data

So the responsibility split is:

```text
Clerk
  = authenticated identity + session

Fluxora
  = product identity + organization + role + authorization

PostgreSQL
  = tenant isolation
```

---

# 3. Mapping Clerk identity to the existing Fluxora schema

The current Fluxora schema already has:

```text
users.github_user_id
```

and that field is globally unique.

The implementation therefore does not introduce a new `clerk_user_id` column in this step.

The mapping is:

```text
Clerk user
   ↓
Clerk externalAccounts
   ↓
GitHub provider user id
   ↓
users.github_user_id
```

This allows the existing Step 2 identity model to remain intact while Clerk owns the authentication/session boundary.

---

# 4. First-login provisioning

A new migration was added:

```text
packages/db/migrations/0003_clerk_identity_provisioning.sql
```

It creates:

```text
fluxora_provision_github_user(
  bigint,
  text,
  text
)
```

The function handles the bootstrap case where the user is authenticated by Clerk but has not yet been provisioned inside Fluxora.

### Behavior

```text
Existing github_user_id?
       │
   ┌───┴───┐
  YES      NO
   │        │
return     create organization
existing    ↓
user       create owner user
            ↓
          return ids
```

The function:

1. Validates the GitHub user id.
2. Validates the email.
3. Validates the organization name.
4. Uses a PostgreSQL advisory transaction lock to serialize concurrent first-login attempts.
5. Looks up an existing user by `github_user_id`.
6. Returns the existing user when already provisioned.
7. Otherwise creates a personal organization.
8. Creates the first user as `owner`.
9. Returns the user id and organization id.

This makes first-login provisioning idempotent.

---

# 5. Why the provisioning function uses SECURITY DEFINER

Normal Fluxora reads are tenant-scoped.

But during the first login, the system does not yet know the user's Fluxora organization.

Therefore:

```text
First login
    ↓
identity is authenticated
    ↓
Fluxora tenant is not known yet
    ↓
bootstrap provisioning function
    ↓
organization + user created
    ↓
tenant context becomes known
    ↓
normal RLS-protected read
```

The bootstrap operation is deliberately narrow.

After provisioning, the API uses the normal tenant-aware database path:

```text
getUserById(...)
      ↓
withTenant(...)
      ↓
app.current_org_id
      ↓
PostgreSQL RLS
```

This preserves the Step 2 tenant-isolation design.

---

# 6. Migration system lesson

The migration runner **does not generate migrations**.

The developer creates:

```text
packages/db/migrations/0003_clerk_identity_provisioning.sql
```

Then:

```text
pnpm db:migrate
```

causes the runner to:

```text
scan migrations/
      ↓
find migrations not recorded in schema_migrations
      ↓
execute SQL in order
      ↓
record successful migrations
```

So:

```text
Developer
  = decides what schema change is needed

Migration runner
  = executes and records that change
```

### Migration result verified

The database reported:

```text
Applied migrations:
  - 0002_auth_sessions.sql
  - 0003_clerk_identity_provisioning.sql
```

`0002` was previously pending in the local database, so the runner correctly applied it before `0003`.

Do not rewrite or delete either migration after they are part of migration history. Future cleanup should use a later forward migration.

---

# 7. PostgreSQL function return-type issue

During the migration, PostgreSQL reported:

```text
cannot change return type of existing function
```

The reason is that PostgreSQL does not allow `CREATE OR REPLACE FUNCTION` to change the function's existing OUT/row return type.

The migration was corrected to:

```text
DROP FUNCTION IF EXISTS ...
        ↓
CREATE FUNCTION ...
```

with the final return shape.

Interview lesson:

> PostgreSQL function argument signatures identify functions, but changing an existing function's result row type can require dropping and recreating the function.

---

# 8. API authentication boundary

The API remains a Node `http.Server`.

The authentication boundary is now:

```text
IncomingMessage
       ↓
Authorization header
       ↓
verify Clerk bearer token
       ↓
Clerk user id
       ↓
Clerk backend user lookup
       ↓
GitHub external account
       ↓
Fluxora provisioning / user lookup
       ↓
organization + role
```

The previous custom functions for:

- GitHub authorization-code exchange
- PKCE state storage
- custom access-token signing
- refresh-token rotation
- custom auth cookies
- custom JWT principal resolution

are no longer part of the active API runtime.

---

# 9. Role handling

The Fluxora role remains database-owned:

```text
owner
admin
member
viewer
```

The authentication provider does not become the source of truth for Fluxora permissions.

The important rule is:

```text
Clerk proves identity
       ↓
Fluxora loads role
       ↓
Fluxora authorizes action
```

This means application role changes remain a Fluxora database concern.

---

# 10. Tenant isolation

The Step 2 RLS architecture remains intact.

Conceptually:

```text
Authenticated Clerk identity
          ↓
Fluxora User
          ↓
Fluxora Organization
          ↓
withTenant(...)
          ↓
app.current_org_id
          ↓
PostgreSQL RLS
```

RLS is still defense in depth.

Application authorization and database isolation are separate security layers.

---

# 11. What is intentionally NOT completed in Step 3

This step does not implement:

```text
Next.js login UI
GitHub App installation
Repository permissions
Repository ingestion
Redis
Object storage
Secrets-manager abstraction
Job queue
OpenTelemetry
CI/CD
Audit-log product workflow
Product-route RBAC matrix
```

Those belong to later roadmap steps.

The canonical roadmap places:

- Step 4 = Next.js auth flow
- Step 5 = Redis/object storage/secrets abstraction
- Step 6 = job queue
- Step 7 = OpenTelemetry
- Step 8 = CI/CD
- Step 9 = local-dev compose/seed skeleton

---

# 12. Verification actually performed

Unlike the original note, verification **was performed after implementation**.

### Typecheck

The final workspace typecheck passed for:

```text
packages/shared-types ✅
apps/web               ✅
packages/db            ✅
apps/api               ✅
apps/workers           ✅
```

Command:

```text
pnpm typecheck
```

### Database migration

The migration runner successfully applied:

```text
0002_auth_sessions.sql
0003_clerk_identity_provisioning.sql
```

Command:

```text
pnpm db:migrate
```

### Important limitation

A real browser login against a live Clerk/GitHub configuration has **not yet been demonstrated in this note**.

So the correct claim is:

> The Clerk authentication implementation typechecks and its required database provisioning migration has been applied; live end-to-end browser authentication still needs to be exercised during the web/auth-flow step.

Do not claim a successful live OAuth login until it has actually been tested.

---

# 13. Interview questions and answer points

### Why use Clerk?

A managed provider owns security-sensitive authentication/session infrastructure while Fluxora retains control of application-specific authorization and tenancy.

### Why doesn't Clerk replace the Fluxora User table?

Because Clerk identity is not the same thing as Fluxora's business identity. Fluxora needs organization membership, roles, repositories, and organization-scoped data.

### Authentication vs authorization?

Authentication establishes identity.

Authorization determines what that identity can access or modify.

### Why keep PostgreSQL RLS?

Application checks can contain bugs. RLS provides a database-level tenant boundary as defense in depth.

### Why is first-login provisioning a special path?

The application knows the authenticated person but does not yet know their Fluxora organization. A controlled bootstrap function creates the initial tenant/user relationship.

### Why is provisioning idempotent?

Multiple concurrent or repeated login requests must not create duplicate organizations for the same external identity.

### Why keep migration history?

Migrations are an ordered record of schema evolution. Editing historical migrations can make environments diverge. Use forward migrations for later corrections.

---

# 14. Current Phase 1 position

```text
Step 1  Monorepo                    ✅
Step 2  Postgres + tenancy + RLS   ✅
Step 3  Clerk authentication       ✅
Step 4  Next.js auth/UI             ⏭
Step 5  Redis/storage/secrets
Step 6  Job queue/worker
Step 7  OpenTelemetry
Step 8  CI/CD
Step 9  Local-dev compose/seed
```

## One-sentence interview summary

> Fluxora uses Clerk for authenticated identity and sessions, maps that identity into its own organization/role model, and relies on PostgreSQL RLS as the database-level tenant isolation boundary.
