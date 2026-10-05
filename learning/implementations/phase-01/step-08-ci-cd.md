# Fluxora — Phase 1 Step 8 — CI/CD and Hosted Deployment Implementation Notes

## 1. Step objective

Step 8 establishes a real CI/CD foundation for Fluxora rather than a local-only build script.

The acceptance target was:

```text
code change
   ↓
GitHub
   ↓
CI quality gates
   ↓
validated main branch
   ↓
hosted frontend + hosted API
   ↓
health/smoke verification
```

The canonical architecture remains provider-neutral, but the current implementation uses:

```text
GitHub            = source control
GitHub Actions    = CI quality gates
Vercel            = Next.js web hosting
Render            = API hosting
PostgreSQL        = hosted API database
Clerk             = authentication provider
```

This is the implementation actually verified during Step 8.

---

## 2. What Step 8 actually includes

Implemented and verified:

- GitHub Actions CI workflow
- lint gate
- typecheck gate
- unit-test gate
- build gate
- GitHub `main` branch verification
- Vercel-hosted Next.js frontend
- hosted authentication smoke test
- Render-hosted API
- Render production environment variables
- hosted PostgreSQL database
- database migration during API deployment build
- API health endpoint
- hosted API → hosted PostgreSQL connectivity
- Render auto-deploy on commits to `main`
- production runtime handling of the platform-provided `PORT`
- API binding to `0.0.0.0`

Not yet implemented as part of this step:

- a complete staging environment
- automated PR E2E gating
- automated production smoke-test workflow
- automated promotion from staging to production
- full rollback orchestration
- worker production deployment
- production Redis deployment
- production object-storage backend wiring
- final production observability backend

These are future hardening/roadmap work and should not be claimed as completed Step 8 functionality.

---

## 3. CI vs CD — the distinction I need to remember

### Continuous Integration (CI)

CI asks:

> "Is this change safe enough to integrate?"

Fluxora CI currently runs:

```text
checkout
   ↓
pnpm setup
   ↓
install from lockfile
   ↓
lint
   ↓
typecheck
   ↓
test
   ↓
build
```

### Continuous Delivery / Deployment (CD)

CD asks:

> "How does validated code get delivered to a running environment?"

Current Fluxora delivery path:

```text
GitHub main
   ├── Vercel → apps/web
   └── Render → apps/api
```

The current implementation is therefore a **working CI + hosted deployment foundation**, not the final enterprise-grade promotion pipeline.

---

## 4. GitHub Actions workflow

Workflow file:

```text
.github/workflows/ci.yml
```

Trigger policy:

```yaml
on:
  pull_request:
  push:
    branches: [main]
```

This means:

- pull requests run CI
- pushes to `main` run CI
- arbitrary feature-branch pushes do not trigger this workflow unless they are part of a pull request

Current job shape:

```text
CI job
  ↓
ubuntu-latest
  ↓
checkout@v6
  ↓
pnpm/action-setup@v4
  ↓
Node 24 via setup-node@v7
  ↓
pnpm install --frozen-lockfile
  ↓
pnpm lint
  ↓
pnpm typecheck
  ↓
pnpm test
  ↓
pnpm build
```

The workflow uses pnpm `10.34.5` and Node `24`.

Dependency caching is handled through the Node setup's pnpm cache configuration.

The important design property is that CI uses the **same lockfile and workspace graph** as development instead of allowing a CI-only dependency resolution path.

---

## 5. Why `pnpm install --frozen-lockfile`

`--frozen-lockfile` means CI should not silently rewrite the lockfile.

The mental model is:

```text
package.json
    +
pnpm-lock.yaml
    ↓
exact dependency resolution
```

This catches a class of "works on my machine" failures where the developer's local lockfile and committed package metadata diverge.

Interview sentence:

> "I use a frozen lockfile in CI so the pipeline validates the dependency graph that is actually committed rather than letting CI resolve a different dependency tree."

---

## 6. Why the root workspace is used

Fluxora is a pnpm monorepo:

```text
apps/
packages/
pnpm-workspace.yaml
pnpm-lock.yaml
```

The API depends on internal workspace packages such as:

```text
@fluxora/db
@fluxora/observability
@fluxora/shared-types
```

Therefore the CI and hosted API build contexts need access to the repository root and workspace metadata.

Render's monorepo behavior uses the repository root when no root directory is specified, which is why `fluxora-api` keeps the root directory blank. Render documents this behavior in its monorepo guidance.

Source: https://render.com/docs/monorepo-support

---

## 7. Linting details

The root project has a real ESLint 9 flat-config setup.

Important implementation detail:

```text
ESLint 10
   ↓
peer compatibility problems with the selected Next.js/TypeScript ESLint packages
```

We corrected the stack to ESLint 9.

The root lint command runs the repository-level ESLint configuration.

Two practical lint issues were fixed during the setup:

1. An intentionally unused parameter in the API server was made explicit with `void _config;`.
2. A similar unused `options` parameter in the filesystem object-storage adapter was handled with `void options;`.
3. Next.js App Router produced a false positive for `@next/next/no-html-link-for-pages`, so that rule was disabled for the relevant web application files.

This became an interview-worthy point because the CI setup was not just "install ESLint"; the repository was brought to a clean linting baseline.

---

## 8. Test and build gates

Current root verification commands:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Step 8 verification result:

```text
lint                    ✅
typecheck               ✅
7 tests                 ✅
0 failed                ✅
production build        ✅
```

The Next.js production build completed successfully.

Important distinction:

> Not every workspace package needs a `build` script.

The API package currently has:

```json
"scripts": {
  "start": "node --experimental-strip-types --import ./src/telemetry.ts src/server.ts",
  "typecheck": "tsc --noEmit -p tsconfig.json"
}
```

There is intentionally **no `build` script in `apps/api/package.json`**.

The API currently executes TypeScript directly using Node's native strip-types runtime.

I should not invent a `dist/` compilation step merely because a hosting provider has a "Build Command" field.

---

## 9. Vercel frontend deployment

The frontend deployment architecture is:

```text
GitHub
   ↓
Vercel project
   ↓
apps/web
   ↓
Next.js application
```

The Vercel project uses `apps/web` as its application root.

Clerk configuration was provided through Vercel environment variables for the hosted web application.

Hosted smoke tests were performed for:

```text
homepage                         ✅
sign-in page                     ✅
Continue with GitHub             ✅
authenticated landing page       ✅
protected /dashboard             ✅
```

This proves that the frontend was not merely built; the deployed authentication flow was manually exercised.

---

## 10. Deployment-history lesson from Vercel

During the initial deployment setup, an old commit contained an incorrect Git author email:

```text
mauryasonali1999@gmailcom
```

instead of the verified address:

```text
mauryasonali1999@gmail.com
```

The deployment integration interacted badly with the malformed author metadata.

The repository identity was corrected locally:

```text
git config --local user.name "Anu Priya"
git config --local user.email "mauryasonali1999@gmail.com"
```

A temporary empty trigger commit was created on a test branch to force a preview, but it was intentionally **not merged to `main`**.

Instead, the real hosted-runtime change was cherry-picked onto `main` and pushed as:

```text
83b6602 feat: prepare API for hosted runtime
```

Important lesson:

> Git metadata is part of the integration surface. Source-control tooling, deployment platforms, and CI systems can all depend on commit metadata, not just file contents.

---

## 11. Render API deployment

API architecture:

```text
GitHub main
   ↓
Render Web Service
   ↓
apps/api
```

Current service configuration:

```text
Name:             fluxora-api
Branch:           main
Runtime:          Node
Root Directory:   repository root
Region:           Singapore
Compute plan:     Free
Auto-deploy:      On Commit
Health check:     /healthz
```

The region choice is intentional so related hosted infrastructure can be kept in the same geographic deployment area.

---

## 12. Why the Render root directory stays blank

Fluxora is a workspace monorepo.

The API imports workspace packages:

```text
apps/api
  ↓
@fluxora/db
@fluxora/observability
@fluxora/shared-types
```

If Render built only from `apps/api`, those workspace files and the root lockfile would not be available in the same way.

Therefore the service builds from the repository root and uses pnpm's filter syntax to target the API package.

---

## 13. Render build command

Final build command:

```text
pnpm install --frozen-lockfile && pnpm db:migrate && pnpm --filter @fluxora/api typecheck
```

Why this exact sequence?

```text
install
  ↓
all workspace dependencies become available
  ↓
db:migrate
  ↓
hosted schema is brought to the application migration state
  ↓
API typecheck
  ↓
we fail before startup if the API source is not type-safe
```

The service does not currently use a compiled API artifact.

Therefore we intentionally do not use:

```text
pnpm --filter @fluxora/api build
```

because that script does not exist.

---

## 14. Render start command

Final start command:

```text
pnpm --filter @fluxora/api start
```

That executes:

```text
node --experimental-strip-types --import ./src/telemetry.ts src/server.ts
```

So the hosted runtime uses the same API execution model that we validated locally.

---

## 15. `PORT` and `0.0.0.0`

Render expects a web service to bind to `0.0.0.0` and to the platform-provided `PORT`.

Fluxora was updated so:

```text
config.port = PORT ?? API_PORT ?? 4000
```

and the HTTP server listens on:

```text
0.0.0.0
```

The important distinction is:

```text
0.0.0.0
= server bind address meaning "all network interfaces"

127.0.0.1
= local client/test address meaning "this machine"
```

Therefore this local test was valid:

```text
server listens on 0.0.0.0:4100
                    ↑
client tests 127.0.0.1:4100
```

Render documents that web services must bind to `0.0.0.0` and recommends using the `PORT` environment variable.

Source: https://render.com/docs/web-services

---

## 16. Environment separation

Local and hosted environments intentionally have different runtime configuration.

Local:

```text
NODE_ENV=development
```

Hosted:

```text
NODE_ENV=production
```

This does **not** require separate source code.

The same application code reads environment-specific configuration from its environment.

Current hosted API configuration:

```text
DATABASE_URL
CLERK_SECRET_KEY
CLERK_AUTHORIZED_PARTIES
NODE_ENV=production
```

The platform-provided `PORT` is read automatically.

Secrets are not committed to Git.

---

## 17. The first Render failure

The first API deploy failed with:

```text
Error: CLERK_SECRET_KEY is required.
```

This was not a code failure.

The service had reached application startup and then failed because the production environment was missing required configuration.

The debugging sequence was:

```text
Render starts service
   ↓
application imports auth configuration
   ↓
CLERK_SECRET_KEY missing
   ↓
startup throws
   ↓
deploy fails
```

After configuring the required production variables, the next deployment became live.

Interview lesson:

> "A deployment can fail even when the source code passes CI because runtime configuration is part of deployment correctness."

---

## 18. Hosted PostgreSQL vs local PostgreSQL

Local development uses:

```text
localhost:5432
fluxora_dev
```

That database exists only on the developer's machine.

Render cannot use:

```text
postgres://...@localhost:5432/fluxora_dev
```

because from Render, `localhost` refers to the Render service's own environment, not the developer's PC.

Therefore the hosted API uses a hosted PostgreSQL connection through:

```text
DATABASE_URL
```

This separation is essential:

```text
local app → local DB
hosted app → hosted DB
```

---

## 19. Database migration strategy in the Free Render service

The Render service was on the Free compute plan.

For this deployment setup, the migration step was placed in the build command:

```text
pnpm db:migrate
```

rather than relying on a separate paid-only deployment phase.

The result is:

```text
build container
   ↓
install dependencies
   ↓
apply migrations
   ↓
typecheck
   ↓
start application
```

The database migration system itself is still owned by Fluxora's `@fluxora/db` package; Render only provides the execution environment and database endpoint.

---

## 20. Health check design

Endpoint:

```text
GET /healthz
```

The route is intentionally unauthenticated.

Its internal check is:

```sql
SELECT 1
```

Success response:

```json
{
  "status": "ok",
  "service": "fluxora-api"
}
```

Failure response:

```json
{
  "status": "unhealthy",
  "service": "fluxora-api"
}
```

with HTTP `503` when the database check fails.

This creates a useful readiness boundary:

```text
process running
      ≠
application ready
```

The API is considered healthy only when its critical database dependency is reachable.

Render's HTTP health checks accept `2xx`/`3xx` as healthy and can be used for application-level checks. Render explicitly recommends critical dependency checks such as a simple database query.

Source: https://render.com/docs/health-checks

---

## 21. Actual Render verification

The final deployment was observed as:

```text
LIVE
commit: 83b6602
```

The deployment completed in approximately 1 minute 14 seconds according to the Render deployment screen.

Hosted `/healthz` was then tested manually and verified successfully.

Because the health implementation executes `SELECT 1`, this proved:

```text
public API reachable
        +
Node server running
        +
Render environment variables present
        +
DATABASE_URL valid
        +
hosted PostgreSQL reachable
```

---

## 22. Auto-deploy behavior

Render was configured with:

```text
Auto-Deploy = On Commit
```

This means a new commit to the linked branch can trigger a new Render deployment.

Render documents Git-linked web services as automatically deployable from updates to their linked Git branch.

Source: https://render.com/docs/web-services

The current mental model is:

```text
push main
   ↓
Render sees new commit
   ↓
build
   ↓
migrate
   ↓
typecheck
   ↓
start
   ↓
health check
   ↓
new deployment becomes live if healthy
```

Do not describe this as a full staging-promotion pipeline; it is the current direct deployment baseline.

---

## 23. Free-tier limitations I must know

The current Render documentation describes Free web services as development/testing/hobby infrastructure rather than production-grade infrastructure.

Relevant current limitations include:

- Free web services spin down after 15 minutes without inbound traffic.
- Wake-up can take about a minute.
- Free web services have 750 included instance-hours per workspace per calendar month.
- Free web services cannot scale beyond a single instance.
- Free web services do not support persistent disks or SSH access.
- Free Render Postgres databases expire 30 days after creation.

Source: https://render.com/docs/free

For Fluxora, that means:

```text
current Free deployment
= validation / learning / early prototype

future always-on production
= paid or otherwise production-grade hosting
```

This distinction should be stated honestly in an interview.

---

## 24. Why the API is separate from the Next.js web app

Fluxora is not just a web page.

It has independent backend responsibilities:

```text
authentication boundary
authorization
tenancy
CRUD
job orchestration
graph queries
analysis reads
simulation reads
```

Keeping the API separately deployable means:

- frontend deployments are independent from backend deployments
- workers can later scale independently
- backend resources can scale without scaling the browser-facing application
- long-running work is not coupled to frontend requests
- infrastructure and security boundaries are clearer

Current topology:

```text
Browser
  ↓
Vercel / Next.js
  ↓
Render / API
  ↓
PostgreSQL
```

Later:

```text
Render API
   ↓
PostgreSQL
Redis
Object storage
Job queue
   ↓
Workers
```

---

## 25. Why workers are not deployed in Step 8

The architecture already defines workers as a separate runtime boundary, but the current Step 8 acceptance focused on the API and frontend deployment baseline.

Workers will eventually need their own deployment path because they perform asynchronous work such as:

```text
repository ingestion
static analysis
graph construction
impact analysis
simulation
AI reasoning
```

The worker architecture is designed for:

- retries
- idempotency
- tenant awareness
- lease recovery
- independent scaling

Deploying those workers before the API/web baseline is stable would mix separate acceptance checkpoints.

---

## 26. Current end-to-end picture

```text
                 USER
                  │
                  ▼
             Vercel / Web
             apps/web
                  │
             Clerk session
                  │
                  ▼
             Render / API
             apps/api
                  │
       ┌──────────┴──────────┐
       ▼                     ▼
PostgreSQL                 Redis (later)
 current                    
       │
       ▼
Fluxora application data
```

Source-control and CI plane:

```text
Developer
   ↓
Git
   ↓
GitHub
   ↓
GitHub Actions
   ├── lint
   ├── typecheck
   ├── test
   └── build
```

This separation of planes is useful in interviews:

```text
Source control plane
CI plane
Delivery/hosting plane
Runtime/data plane
Observability plane
```

---

## 27. Step 8 acceptance statement

The accurate statement is:

> "I implemented and verified Fluxora's Phase 1 CI/CD foundation. GitHub Actions now enforces lint, typecheck, tests, and production build on pull requests and pushes to main. The Next.js frontend is deployed through Vercel, and the backend API is deployed through Render with production environment variables, database migrations, a runtime-compatible Node start command, and an application-level `/healthz` endpoint that verifies PostgreSQL connectivity. I also manually verified the hosted frontend authentication flow and the hosted API health endpoint."

That is more precise than saying:

> "Fluxora has fully automated enterprise CI/CD."

The latter is not yet true because staging promotion, automated E2E gates, worker deployment, automated smoke-test orchestration, and rollback policy are still future work.

---

## 28. Debugging lessons from Step 8

### Lesson 1 — Build commands must match actual package capabilities

Do not assume every package has a build script.

The API has no `build` script because it executes TypeScript directly.

### Lesson 2 — CI correctness and runtime correctness are different

```text
CI passes
   ≠
runtime configuration is valid
```

The missing `CLERK_SECRET_KEY` proved this.

### Lesson 3 — Local and production environments are separate

```text
localhost:5432
```

is not a production database endpoint.

### Lesson 4 — Health checks should test critical dependencies

A process can be running while its database is unavailable.

The `/healthz` database query catches that class of failure.

### Lesson 5 — Platform runtime contracts matter

Hosted environments impose requirements such as:

```text
PORT
0.0.0.0
startup command
health endpoint
```

### Lesson 6 — Monorepos change deployment configuration

The workspace root and lockfile matter because internal workspace packages are part of the application dependency graph.

### Lesson 7 — Git history and deployment integrations are connected

The malformed author metadata was a real integration issue, not a code bug.

### Lesson 8 — Free infrastructure is not the same as production infrastructure

A successful deployment can still have platform constraints that make the tier unsuitable for long-lived production traffic.

---

## 29. Step 8 mental model to memorize

```text
CODE
 ↓
GITHUB
 ↓
CI
 ├─ lint
 ├─ typecheck
 ├─ test
 └─ build
 ↓
MAIN
 ↓
DELIVERY
 ├─ Vercel → web
 └─ Render → API
       ↓
     migrate
       ↓
     start
       ↓
    /healthz
       ↓
   PostgreSQL
```

When blanking out, say the nouns first:

```text
GitHub
Actions
Vercel
Render
PostgreSQL
Clerk
Health check
```

Then expand each noun into its job.
