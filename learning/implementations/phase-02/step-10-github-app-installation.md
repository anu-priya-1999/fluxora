# Phase 2 — Step 10 — GitHub App installation

Scope that was implemented:

- GitHub App env/config on the API
- RS256 App JWT with `node:crypto`
- dynamic installation id, handled as a string and stored as PostgreSQL `bigint`
- verification that the installation belongs to the Clerk user's GitHub account
- tenant-scoped `github_installations` with the existing RLS session variable
- idempotent `POST /api/v1/github/installations`
- Next.js Setup URL at `/github/setup`
- dashboard "Connect GitHub" link only
- **browser Clerk `getToken()`** after GitHub redirects back
- **CORS** on that API path for Vercel → Render

Not implemented: repository, snapshot, commit, clone, S3 upload, ingestion workers, `repository.indexed`, WebSockets, PR webhooks, impact analysis, AST, or graph.

---

## File map

```text
apps/web
  src/app/dashboard/page.tsx                 Connect GitHub link (slug only)
  src/app/github/setup/page.tsx              Setup URL: session + query checks
  src/app/github/setup/github-setup-completion.tsx
                                             Client: useAuth().getToken() then POST
  src/github/complete-setup.ts               Browser fetch + error-message mapping
  src/github/install-url.ts                  Public install URL from slug
  src/github/env.ts                          Read web env (no private key, no .env file load)
  src/github/github-setup.test.ts            URL + browser POST tests
  src/app/layout.tsx                         ClerkProvider (needed for useAuth)
  src/proxy.ts                               clerkMiddleware for cookies

apps/api
  src/http/server.ts                         Routes, CORS apply, JSON responses
  src/http/cors.ts                           Origin allowlist + preflight helper
  src/http/github-installations.ts           POST handler (auth, body, provision, complete)
  src/github/config.ts                       Load App ID + PEM
  src/github/jwt.ts                          Sign short RS256 App JWT
  src/github/installation-id.ts              String-only request ids
  src/github/parse-installation.ts           Quote GitHub JSON integers
  src/github/verify-installation.ts          GET /app/installations/{id} + ownership
  src/github/complete-installation.ts        Role + JWT + verify + writer
  src/github/http-error.ts                   Domain errors → HTTP codes (no Clerk import)
  src/github/redact.ts                       Strip PEM / Bearer / JWT from logs
  src/github/github.test.ts                  JWT, parse, CORS unit tests
  src/auth/clerk.ts                          Verify Clerk JWT + GitHub identity
  src/env.ts                                 API loads repo-root .env (not web)
  src/server.ts                              Process entry: loadRootEnv, listen

packages/db
  migrations/0008_github_installations.sql   Table + unique + RLS
  src/repositories/github-installation.ts    Idempotent save + savepoint
  src/repositories/github-installation.test.ts
  src/tenant.ts                              withTenant / app.current_org_id
  src/index.ts                               Re-exports installation repository
  src/cli/reset.ts                           TRUNCATE organizations CASCADE (installs go too)
  src/cli/seed.ts                            Does not seed an installation

packages/shared-types
  src/github.ts                              Path constant, types, isCanonicalGithubId
  src/index.ts                               Re-exports github contracts
```

---

## How to read Step 10 code

Open files in this order so each layer has context before the next:

1. `packages/shared-types/src/github.ts` — the wire path, string ids, request shape.
2. `apps/web/src/github/install-url.ts` then `apps/web/src/app/dashboard/page.tsx` — how a user starts.
3. `apps/web/src/github/env.ts` — what the web process is allowed to know.
4. `apps/web/src/app/github/setup/page.tsx` — GitHub's GET redirect, session gate, query validation.
5. `apps/web/src/app/github/setup/github-setup-completion.tsx` then `apps/web/src/github/complete-setup.ts` — browser token and POST.
6. `apps/api/src/http/cors.ts` then the GitHub branch in `apps/api/src/http/server.ts` — OPTIONS/POST and CORS.
7. `apps/api/src/http/github-installations.ts` — HTTP adapter: Clerk, body, provision, response.
8. `apps/api/src/auth/clerk.ts` — session → GitHub `providerUserId`.
9. `apps/api/src/github/complete-installation.ts` — role, App JWT, verify, save.
10. `apps/api/src/github/jwt.ts`, `verify-installation.ts`, `parse-installation.ts`, `installation-id.ts`.
11. `apps/api/src/github/config.ts`, `http-error.ts`, `redact.ts`.
12. `packages/db/migrations/0008_github_installations.sql` then `packages/db/src/repositories/github-installation.ts` and `packages/db/src/tenant.ts`.
13. Tests last: `github-setup.test.ts`, `github.test.ts`, `github-installation.test.ts`.

Supporting Clerk shell (not GitHub-specific, but required): `apps/web/src/app/layout.tsx`, `apps/web/src/proxy.ts`.

---

## File-by-file responsibility map

### apps/web

#### `src/app/dashboard/page.tsx`

- **What:** Signed-in dashboard. Adds a "Connect GitHub" `<a>` to the public GitHub App install URL, or the text "Connect GitHub is not configured."
- **Why:** GitHub's install page is the only place a user can create an installation. Fluxora must not invent an installation id.
- **Imports:** `@clerk/nextjs/server` `auth`, `@clerk/nextjs` `UserButton`, `readGithubAppSlug`, `githubAppInstallUrl`.
- **Called by:** Next.js App Router for `/dashboard`.
- **Lifecycle:** After Clerk login, before GitHub. No API call.

#### `src/github/install-url.ts`

- **What:** `githubAppInstallUrl(slug)` → `https://github.com/apps/{slug}/installations/new` or `null`.
- **Why:** The slug is public. Reject anything that is not `[A-Za-z0-9-]+` so query strings and path tricks cannot be injected.
- **Imports:** none.
- **Called by:** dashboard page; tests.
- **Lifecycle:** URL construction only.

#### `src/github/env.ts`

- **What:** Reads `GITHUB_APP_SLUG` / `NEXT_PUBLIC_GITHUB_APP_SLUG`, `FLUXORA_API_URL` (default `http://127.0.0.1:4000`), `NEXT_PUBLIC_APP_URL` or `VERCEL_URL`. Validates https-or-local-http and no embedded credentials. Returns **origin only** for the API URL.
- **Why:** Web needs the slug and API origin. It must not load the GitHub App private key. `loadWebRootEnv()` is intentionally empty after Vercel/Turbopack failed on a manual repo-root `.env` `node:fs` loader. Next/Vercel inject env; local web vars belong in `apps/web/.env.local`. `void ROOT_ENV_KEYS` keeps the old allowlist listed without using it.
- **Imports:** none (no `fs`).
- **Called by:** dashboard (`readGithubAppSlug`), setup page (`readFluxoraApiUrl`, `readWebOrigin`).
- **Lifecycle:** Server components only for those reads. `apiUrl` is then passed to the client as a prop.

#### `src/app/github/setup/page.tsx`

- **What:** GitHub Setup URL. `runtime = "nodejs"`, `dynamic = "force-dynamic"`. Reads `installation_id` and `setup_action` from `searchParams`. If not authenticated, `redirectToSignIn({ returnBackUrl })`. Rejects missing/non-canonical installation ids and unknown `setup_action` (allowed: omitted, `install`, `update`). On success, renders `GithubSetupCompletion`.
- **Why:** GitHub redirects with GET. Fluxora must not complete an install for a signed-out browser, and must not POST garbage ids.
- **Imports:** `@clerk/nextjs/server` `auth`, `@fluxora/shared-types` `isCanonicalGithubId`, `next/link`, `readFluxoraApiUrl`, `readWebOrigin`, `GithubSetupCompletion`.
- **Called by:** GitHub App Setup URL → `/github/setup`.
- **Lifecycle:** First hop after GitHub. Does **not** call `getToken()` and does **not** POST.

#### `src/app/github/setup/github-setup-completion.tsx`

- **What:** `"use client"`. `useAuth()` → wait `isLoaded` → `completeGithubInstallationFromBrowser`. Renders connecting / success (`created` vs already connected) / error. "Authentication required." omits the dashboard link.
- **Why:** Server `getToken()` was null after the GitHub redirect even when `auth()` was authenticated. Browser `getToken()` is the working session-token source.
- **Imports:** `@clerk/nextjs` `useAuth`, `next/link`, React `useEffect`/`useState`, `completeGithubInstallationFromBrowser`.
- **Called by:** setup `page.tsx`.
- **Lifecycle:** After the server page decides the query and session are usable. Effect deps: `apiUrl`, `installationId`, `isLoaded`, `getToken`. Cleanup sets `cancelled` so a stale request does not `setState`.

#### `src/github/complete-setup.ts`

- **What:** `getToken()`, POST JSON `{ github_installation_id }` to `apiUrl + GITHUB_INSTALLATION_COMPLETION_PATH`, map API error codes to short UI strings. Injectable `fetchImpl` for tests.
- **Why:** Keep browser HTTP out of the React component so tests can assert method, headers, and body without rendering.
- **Imports:** `@fluxora/shared-types` `GITHUB_INSTALLATION_COMPLETION_PATH`.
- **Called by:** `GithubSetupCompletion`; `github-setup.test.ts`.
- **Lifecycle:** The actual cross-origin POST (and the only web code that attaches `Authorization`).

#### `src/github/github-setup.test.ts`

- **What:** Install URL never includes an installation id; `resolveFluxoraApiUrl` rejects http-non-local and credentialed URLs; browser completion posts the token and skips fetch when token is null.
- **Why:** Guard the two easy security mistakes: leaking an id into the Connect URL, and POSTing without a session.
- **Imports:** node test, shared-types path, complete-setup, env, install-url.
- **Called by:** `pnpm --filter @fluxora/web test` (not run as part of this documentation pass).

#### `src/app/layout.tsx`

- **What:** Root `ClerkProvider`.
- **Why:** Client `useAuth()` requires the provider.
- **Called by:** every page.

#### `src/proxy.ts`

- **What:** `clerkMiddleware()` with Next matcher including pages and `/__clerk`.
- **Why:** Clerk session cookies on `/github/setup` after the GitHub round-trip.
- **Called by:** Next.js request pipeline (Clerk's Next 16 proxy convention).

---

### apps/api

#### `src/server.ts`

- **What:** `loadRootEnv()`, construct `createApiServer()`, listen. Not GitHub-specific.
- **Why:** API process bootstrap. GitHub config is not read here; `createApiServer` loads it.
- **Imports:** telemetry, db pool, `loadAuthConfig`, `loadRootEnv`, `createApiServer`.

#### `src/env.ts`

- **What:** Line-oriented load of repo-root `.env` without overriding existing process env.
- **Why:** Local API and Render-style env injection. Web no longer shares this loader.
- **Called by:** `server.ts`, `telemetry.ts`.

#### `src/http/server.ts`

- **What:** Native `node:http` router. `/healthz`, dummy telemetry, `/api/v1/auth/me`, GitHub installation path. On that path: `OPTIONS` → `githubInstallationPreflight` + `applyCorsHeaders` + `writeHead(204, responseHeaders({}))`; `POST` → `applyCorsHeaders` then `handleCompleteGithubInstallation`. `sendJson` always adds cache/security headers via `responseHeaders`.
- **Why:** Existing API style (no Express). CORS lives here because only this path is called from the browser.
- **Imports:** observability, db (for `/me`), clerk (for `/me`), `loadGithubAppConfig`, `redactForLog`, cors helpers, github-installations handler.
- **Called by:** `createApiServer()` from `server.ts`.
- **Lifecycle:** Every API request. GitHub CORS is **not** applied to `/api/v1/auth/me`.

#### `src/http/cors.ts`

- **What:** `loadAllowedWebOrigins` from `CLERK_AUTHORIZED_PARTIES` (default `http://localhost:3000`). `corsHeadersForAllowedOrigin` returns headers or `undefined` (unknown origin / missing Origin). `githubInstallationPreflight` always status 204; headers empty object if origin not allowed.
- **Why:** Minimal CORS without a package. Same trusted origins as Clerk `authorizedParties`. Never `*`.
- **Imports:** none.
- **Called by:** `server.ts`; unit tests in `github.test.ts`.
- **Lifecycle:** OPTIONS and POST on `/api/v1/github/installations` only.

#### `src/http/github-installations.ts`

- **What:** POST adapter. 503 if App unconfigured. 415 unless `Content-Type` starts with `application/json`. Clerk Bearer → identity → safe numeric GitHub user id. Body max 4096 bytes. Parse `github_installation_id`. `provisionGithubUser` + `getUserById`. Reject if stored `githubUserId` text ≠ Clerk id. `completeInstallation` with `saveGithubInstallation`. 200 with installation DTO + `created`.
- **Why:** Keep HTTP parsing out of the GitHub domain module. Reuse `/me` provisioning so first-time users get an org.
- **Imports:** `@fluxora/db`, shared-types path, clerk, config type, complete-installation, http-error, installation-id, redact.
- **Called by:** `server.ts` after CORS headers are applied.
- **Lifecycle:** After preflight (if any). Clerk runs **before** GitHub is called.

#### `src/auth/clerk.ts`

- **What:** Throws at import if `CLERK_SECRET_KEY` missing. `authenticateClerkToken` (`verifyToken` + `authorizedParties`). `getClerkGithubIdentity` loads Clerk user, finds GitHub external account, email, org name.
- **Why:** Shared identity for `/me` and installation completion. Clerk GitHub id is the ownership key.
- **Called by:** `server.ts` (`/me`), `github-installations.ts`.
- **Lifecycle:** First trust boundary on the API.

#### `src/github/config.ts`

- **What:** `loadGithubAppConfig`: null if all GitHub App vars blank; throw if partial, non-decimal App ID, both key sources set, or PEM missing BEGIN/PRIVATE KEY/END. `normalizePrivateKeyPem` turns `\n` into newlines. Optional `GITHUB_API_BASE_URL` (https or local http).
- **Why:** Unconfigured App must not take down `/healthz`. Misconfiguration must fail closed without logging the key.
- **Called by:** `createApiServer` once at listen time; tests.
- **Lifecycle:** Process start, not per request.

#### `src/github/jwt.ts`

- **What:** RS256 App JWT via `createSign`. `iat` now-60s, `exp` = iat + 540s. `decodeGithubAppJwtPayload` for tests.
- **Why:** No GitHub SDK. Clock skew and 10-minute GitHub max.
- **Called by:** `completeInstallation`.

#### `src/github/installation-id.ts`

- **What:** Request-side canonical string ids. `readGithubInstallationIdField`. `parseClerkGithubUserId` also requires `Number.isSafeInteger` for the provision function.
- **Why:** JSON numbers would round. Clerk user id still crosses `Number` at provision.
- **Called by:** HTTP handler and `completeInstallation`.

#### `src/github/parse-installation.ts`

- **What:** Parse GitHub installation JSON. `quoteJsonIntegers` then `JSON.parse`. Login regex, type User|Organization, bigint max check.
- **Why:** GitHub sends numeric `id` fields. Fluxora must not round them.
- **Called by:** `fetchGithubInstallation`.

#### `src/github/verify-installation.ts`

- **What:** `GET {apiBaseUrl}/app/installations/{id}` with App JWT, `redirect: "error"`, 10s timeout. Map 404 / 401 / other. Then require User + matching account id + matching installation id.
- **Why:** Query-string id is untrusted. Org installs are a different account id.
- **Called by:** `completeInstallation`.

#### `src/github/complete-installation.ts`

- **What:** Require owner/admin. Parse installation id. Sign JWT (misconfigured PEM → `GithubAppMisconfiguredError`). Verify. `writer.save`.
- **Why:** Domain orchestration without `node:http` or Clerk SDK, so it is unit-testable with a fake fetch and fake writer.
- **Called by:** HTTP handler.

#### `src/github/http-error.ts`

- **What:** Maps domain/db errors to status + stable `code` + client message. Does not import `clerk.ts`.
- **Why:** Tests and the HTTP handler share mapping without requiring `CLERK_SECRET_KEY` at import.
- **Called by:** HTTP handler.

#### `src/github/redact.ts`

- **What:** Regex-redact PEM, `Bearer …`, JWT-shaped tokens in log strings.
- **Why:** Errors from crypto or fetch must not print secrets.
- **Called by:** HTTP handler and `server.ts` unexpected-error logger.

#### `src/github/github.test.ts`

- **What:** JWT shape/lifetime/signature, escaped PEM, id parsing, installation JSON quoting, completeInstallation behavior, redact, CORS allowlist/preflight/`*` rejected.
- **Why:** CORS helpers are tested here so tests do not boot `createApiServer` (which loads Clerk).

---

### packages/db

#### `migrations/0008_github_installations.sql`

- **What:** Table, unique installation id, unique org, positive bigint checks, account type `User` only, ENABLE + FORCE RLS, four tenant policies on `fluxora_current_org_id()`.
- **Why:** Persistence for Step 10 only (no installation tokens). Forward-only migrate runner.
- **Called by:** `pnpm db:migrate`.

#### `src/repositories/github-installation.ts`

- **What:** `planGithubInstallationWrite`, `saveGithubInstallation` inside `withTenant`. `SELECT … FOR UPDATE`. Insert/update with `::bigint` / `::text`. Savepoint around writes. Unique violation → re-read caller row or 409 conflict. Account mismatch error if plan is `reject`.
- **Why:** Idempotency + RLS-invisible cross-tenant uniqueness.
- **Imports:** shared-types, `withTenant`.
- **Called by:** HTTP handler's writer; tests for `planGithubInstallationWrite` only (save path needs a database).

#### `src/repositories/github-installation.test.ts`

- **What:** insert / unchanged / refresh / reject plans, including an installation id above `MAX_SAFE_INTEGER`.
- **Why:** Decision table without Postgres.

#### `src/tenant.ts`

- **What:** `set_config('app.current_org_id', …, true)` in a transaction.
- **Why:** RLS session variable. Installation writes must use the supplied client.
- **Called by:** `saveGithubInstallation` and other tenant repositories.

#### `src/index.ts`

- **What:** Re-exports installation errors, `planGithubInstallationWrite`, `saveGithubInstallation`.
- **Called by:** API HTTP handler.

#### `src/cli/reset.ts` / `src/cli/seed.ts`

- **What:** Reset truncates `organizations CASCADE` (installations follow the FK). Seed provisions a local user/org only — **no** `github_installations` row.
- **Why:** Connecting GitHub remains a real user action.

---

### packages/shared-types

#### `src/github.ts`

- **What:** `GITHUB_INSTALLATION_COMPLETION_PATH = "/api/v1/github/installations"`. `GithubInstallation` with string ids. `CompleteGithubInstallationRequest`. `isCanonicalGithubId` (no leading zero, fits PostgreSQL bigint).
- **Why:** Web and API must agree on path and id rules without either importing the other's HTTP stack.
- **Called by:** web complete-setup and tests; API path check; db mapping; installation-id parsing.

#### `src/index.ts`

- **What:** Re-exports the github module next to tenant/auth/jobs types.

---

## End-to-end request / data flow

1. Dashboard reads slug from env, links to GitHub's `/installations/new`.
2. User installs on a personal GitHub account.
3. GitHub GET-redirects to `{NEXT_PUBLIC_APP_URL or Vercel}/github/setup?installation_id=&setup_action=`.
4. `page.tsx` requires Clerk session; otherwise sign-in with return URL preserving the query.
5. Page validates id and action; reads API origin; renders client completion.
6. Browser waits for Clerk; `getToken()`; POST string id to Render.
7. If origins differ: OPTIONS preflight, then POST with CORS headers on the response.
8. API authenticates Clerk JWT, loads GitHub `providerUserId`, provisions org/user if needed, requires owner/admin.
9. API signs App JWT, GET GitHub installation, checks User + account id match.
10. `saveGithubInstallation` inserts or returns/updates the tenant row.
11. JSON `{ installation, created }` → client success copy.

`created: true` means a new row. `created: false` means the same installation was already stored, or a reinstall for the same GitHub account refreshed it.

---

## Authentication flow

```text
ClerkProvider + clerkMiddleware
        → cookies on Vercel
auth() on setup page            (is the user signed in?)
useAuth().getToken() in browser (JWT for the API)
Authorization: Bearer           (cross-origin POST)
authenticateClerkToken          (CLERK_SECRET_KEY + authorizedParties)
getClerkGithubIdentity          (provider === "github")
provisionGithubUser             (org + user, github_user_id as number)
role owner | admin
```

GitHub login through Clerk is **not** a GitHub App token. The API never uses a user OAuth token in this step.

---

## GitHub verification flow

```text
createGithubAppJwt(appId, PEM)
GET /app/installations/{id}   (App JWT, not installation token)
quoteJsonIntegers → parse
account.type === User
account.id === Clerk providerUserId (string compare)
installation.id === submitted id
```

401 from GitHub → App credentials unusable. 404 → installation not found. Org type → ownership error (same 403 as mismatch).

---

## Database persistence flow

```text
withTenant(organizationId)
  SELECT FOR UPDATE (RLS: this org only)
  plan: insert | unchanged | refresh | reject
  SAVEPOINT fluxora_github_installation_write
  INSERT or UPDATE ::bigint
  on 23505: ROLLBACK TO SAVEPOINT, SELECT again
    row visible → treat as race on this tenant
    no row → another org owns the unique installation id → conflict
```

---

## Error flow

Web maps a subset of `error.code` values (`installation_account_mismatch`, `installation_not_found`, `installation_conflict`, `github_app_not_configured` / `github_app_misconfigured`, `invalid_session`, `github_account_required`, `email_required`) to fixed English sentences. Anything else, including network failure, is "GitHub installation could not be completed."

API codes (via `githubInstallationHttpError` or the HTTP adapter directly) include: `github_app_not_configured` 503, `unsupported_media_type` 415, `invalid_session` 401, `github_account_required` / `email_required` / `insufficient_role` / `installation_account_mismatch` / `tenant_session_rejected` 403, `payload_too_large` 413, `invalid_json` / `invalid_installation_id` 400, `installation_not_found` 404, `installation_conflict` 409, `github_app_misconfigured` 503, `github_unavailable` 502, `internal_error` 500.

Logs pass through `redactForLog`. GitHub bodies are not returned.

---

## CORS / preflight flow

```text
Browser (Origin: https://<vercel>)
  OPTIONS /api/v1/github/installations
    Access-Control-Request-Method: POST
    Access-Control-Request-Headers: authorization, content-type
  → if Origin ∈ CLERK_AUTHORIZED_PARTIES:
       204 + Allow-Origin (echo) + Allow-Methods GET, POST, OPTIONS
         + Allow-Headers Authorization, Content-Type + Vary: Origin
  → else 204 with no Allow-Origin (browser blocks)

  POST /api/v1/github/installations
    Origin, Authorization, Content-Type
  → same Allow-Origin echo if allowed, then JSON body
```

`applyCorsHeaders` uses `res.setHeader`. OPTIONS then calls `writeHead(204, responseHeaders({}))` with an empty extra header object (see debugging notes). POST JSON uses `sendJson` → `writeHead` with content-type and security headers; CORS keys already set should merge in Node.

---

## Environment-variable flow

```text
Repo-root .env          → API loadRootEnv() only (and db CLIs)
apps/web/.env.local     → intended local Next env (loader no longer reads repo root)
Vercel project env      → GITHUB_APP_SLUG, FLUXORA_API_URL, NEXT_PUBLIC_APP_URL, Clerk publishable
Render env              → DATABASE_URL, CLERK_SECRET_KEY, CLERK_AUTHORIZED_PARTIES,
                           GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, NODE_ENV, PORT
```

`CLERK_AUTHORIZED_PARTIES` is both Clerk JWT `azp` and CORS allowlist. Production must list the exact Vercel origin (scheme + host, no trailing slash).

---

## Idempotency and the savepoint

Same organization + same installation + same account returns the current row and does not treat the retry as an error.

If two requests insert at once, one unique index will fire. PostgreSQL marks the transaction aborted unless the statement ran under a savepoint. The repository uses `SAVEPOINT fluxora_github_installation_write`, rolls back to it, then applies `planGithubInstallationWrite` to whatever row the tenant can see. If RLS shows no row, another organization owns that installation id and the API returns 409 `installation_conflict` without naming the other organization.

---

## Security

- Private key stays on the API. The web env module does not copy it into the Next process and no longer reads the repo-root `.env` file.
- Connect URL is built only from a slug of letters, digits, and hyphens.
- API origin for the browser POST must be https or local http, without embedded credentials.
- Client errors are coded messages. JWT, PEM, and GitHub bodies are not returned.
- Organization installations are out of scope until membership can be proven.
- CORS never uses `*`. Unlisted origins get no `Access-Control-Allow-Origin`.
- Browser token is a Clerk session JWT, not the GitHub App private key.

---

## Debugging lessons (actual)

1. Server `getToken()` null after GitHub → Vercel `/github/setup` while `auth()` still authenticated. Fix: client `useAuth().getToken()`.
2. That browser POST is cross-origin Vercel → Render. Fix: `cors.ts` + OPTIONS on the installation path.
3. Web `node:fs` repo-root `.env` load broke Vercel/Turbopack. Fix: empty `loadWebRootEnv()`; platform env / `.env.local`.
4. Client effect: ref-stabilizing `getToken` vs lint; shipped code uses effect deps + `cancelled`.
5. OPTIONS uses `responseHeaders({})` after `applyCorsHeaders`; CORS is not in the `writeHead` argument object.
6. PostgreSQL unique violation aborts the transaction without a savepoint.
7. Naive JSON integer quoting broke decimals.
8. Multiline PEM in `.env` is not one variable.
9. Importing Clerk from tests requires `CLERK_SECRET_KEY`; `http-error.ts` avoids that.

---

## Verification not run

`pnpm db:migrate`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` were not run for this documentation update. The migration has to be applied before the route can persist a row.
