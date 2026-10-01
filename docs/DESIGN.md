# Fluxora — DESIGN.md

## 1. Purpose

Fluxora is an AI-powered software digital twin.

It builds a deterministic, queryable, evidence-backed model of a software system from source code, repository history, dependencies, APIs, infrastructure metadata, and later runtime telemetry.

Fluxora provides:

- Architecture Explorer

- Change-impact / blast-radius analysis

- Deterministic scenario simulation

- Evidence-backed AI explanations

- Architecture Q&A grounded in the software model

Fluxora is deliberately not:

- a generic chatbot over GitHub

- an AI code-review wrapper

- a linter

- an APM replacement

The central product principle is:

\> Build a deterministic, evidence-backed software model first. Use AI to explain and reason over verified evidence; never use the LLM as the source of truth.

---

## 2. Source of Truth

The detailed architecture package under:

```text

docs/architecture/

```

is the canonical architectural source of truth.

Canonical documents:

```text

00-README.md

01-executive-summary.md

02-product-scope.md

03-architecture-principles.md

04-system-architecture-diagrams.md

05-component-responsibilities.md

06-database-schema.md

07-api-architecture.md

08-event-schema.md

09-ai-architecture.md

10-frontend-architecture.md

11-security-architecture.md

12-testing-strategy.md

13-deployment-architecture.md

14-local-development.md

15-scaling-strategy.md

16-cost-model.md

17-implementation-roadmap.md

18-decision-log.md

19-risks-and-mitigations.md

20-interview-questions.md

21-demo-script.md

22-definition-of-done.md

```

`DESIGN.md` is only the compact, living implementation snapshot.

It records:

- current implementation state

- active engineering constraints

- current technology decisions

- current development environment

- current implementation phase

- current next step

When `DESIGN.md` and the canonical architecture package appear to conflict, review the architecture package before changing the design.

---

## 3. Product Definition

Fluxora models software relationships such as:

```text

Repository

    ↓

Application

    ↓

Package

    ↓

Module

    ↓

Symbol

    ↓

API / Event / Database

    ↓

Consumer

```

The model is deterministic, evidence-backed, and queryable.

Fluxora is intended to answer questions such as:

- What depends on this function?

- What could break if this PR is merged?

- What is the blast radius of this change?

- What happens if a dependency becomes unavailable?

- Why is this component affected?

- What evidence supports this conclusion?

---

## 4. Core Architectural Invariants

### 4.1 Deterministic core

The following must never depend on an LLM:

- dependency graph construction

- dependency relationship discovery

- graph traversal

- blast-radius calculation

- simulation propagation

- evidence provenance

- authorization

- tenant isolation

For identical input, deterministic analysis should produce reproducible results.

The deterministic core must remain independently testable without an LLM.

### 4.2 AI boundary

The AI layer may:

- explain deterministic findings

- narrate impact analysis

- narrate simulation results

- answer architecture questions using verified context

- summarize evidence

- provide explicitly labeled suggestions

The AI layer must not:

- discover graph truth

- decide what depends on what

- calculate blast radius

- determine simulation propagation

- determine authorization

- fabricate evidence

- mutate the deterministic graph as an authoritative source

The LLM is an explanatory/reasoning layer over verified system facts.

---

## 5. Evidence Model

Evidence is a cross-cutting concept.

Relevant user-facing claims should be traceable through:

```text

source file

    ↓

symbol

    ↓

relationship

    ↓

analysis run

    ↓

confidence / provenance

```

If a deterministic claim cannot be supported by evidence, it should not be presented as a deterministic fact.

---

## 6. Confidence and Provenance

Static analysis of JavaScript and TypeScript is inherently incomplete.

Examples include:

- dynamic imports

- dynamically constructed values

- reflection-like patterns

- unusual framework behavior

- unsupported syntax

Known provenance categories include:

```text

static-analysis

inferred

ai-hypothesis

runtime-observed

```

These categories must remain distinguishable.

AI hypotheses must not become visually or semantically equivalent to statically established facts.

---

## 7. Current Implementation Phase

### Phase 1 — Foundation

The goal of Phase 1 is to establish a deployable software foundation before product-specific code intelligence.

Current progress:

```text

Step 1 — Monorepo foundation                         ✅ COMPLETE

Step 2 — PostgreSQL + Organization/User + RLS        ✅ COMPLETE

Step 3 — Clerk authentication + identity mapping     ✅ COMPLETE

Step 4 — Next.js + Clerk auth UI/dashboard            ✅ COMPLETE

Step 5 — Redis + object storage + secrets abstraction ✅ COMPLETE

Step 6 — PostgreSQL job queue + worker harness        ✅ COMPLETE

Step 7 — OpenTelemetry                                ✅ COMPLETE

Step 8 — CI/CD                                        ✅ COMPLETE

Step 9 — Local-dev compose/seed skeleton             ✅ COMPLETE

```

Phase 2 progress:

```text

Step 10 — GitHub App installation + setup flow       IMPLEMENTED

```

Phase 1 includes:

- monorepo

- PostgreSQL

- database migrations

- organization/user tenancy foundation

- managed authentication boundary

- PostgreSQL RLS

- Redis abstraction

- object storage abstraction

- secrets abstraction

- job queue

- worker harness

- observability

- CI/CD foundation

- local development foundation

Phase 1 does not yet include:

- GitHub repository ingestion

- AST analysis

- dependency graph construction

- impact analysis

- simulation engine

- AI reasoning

- runtime telemetry

The implementation roadmap remains the authority for phase boundaries.

## 8. Current Repository Shape

```text

fluxora/

├── apps/

│   ├── api/

│   ├── web/

│   └── workers/

│

├── packages/

│   ├── db/

│   ├── infrastructure/

│   ├── observability/

│   └── shared-types/

│

├── docs/

│   └── architecture/

│

├── learning/

├── prompts/

├── .cursor/

├── .observability/

└── package.json

```

Mental model:

```text

apps     = applications/services that run

packages = reusable internal building blocks

```

---

## 9. Application Boundaries

### `apps/web`

Responsibilities:

- Next.js application

- authentication UI

- organization dashboard

- repository UI

- Architecture Explorer

- node inspection

- PR impact reports

- simulation views

- architecture Q&A

- organization settings

The frontend consumes server state through the API rather than owning backend business rules.

### `apps/api`

Responsibilities:

- HTTP API

- Clerk authentication boundary

- Fluxora authorization / tenant-role checks

- resource CRUD

- job orchestration

- graph reads

- impact/simulation result reads

- API contracts

The API must not perform heavy repository analysis synchronously.

### `apps/workers`

Responsibilities:

- asynchronous jobs

- repository ingestion

- static analysis

- graph construction

- impact analysis

- simulation

- AI reasoning

Workers are designed for retryability and idempotency.

Production may split worker types into separate scalable pools.

Local development may run worker types in a single process.

### `packages/db`

Responsibilities:

- database schema

- migrations

- database access

- persistence utilities

- transaction helpers

### `packages/shared-types`

Responsibilities:

- shared TypeScript types

- domain contracts

- API contracts

- event payload types

- schemas shared between applications

### `packages/infrastructure`

Responsibilities:

- Redis abstractions and adapters

- object-storage abstractions and adapters

- secrets abstractions and providers

- environment-specific infrastructure boundaries

### `packages/observability`

Responsibilities:

- OpenTelemetry SDK configuration

- trace, metric, and log signal helpers

- OTLP exporter configuration

- shared instrumentation boundaries for API and workers

- service/resource identity configuration

---

## 10. Database Strategy

### MVP system of record

PostgreSQL is the system of record.

PostgreSQL stores:

- tenancy data

- users

- repositories

- analysis runs

- graph nodes

- graph edges

- evidence

- jobs

- impact results

- simulation results

- AI analysis records

- audit data

The dependency graph is modeled in PostgreSQL using relational adjacency structures and bounded-depth traversal.

A dedicated graph database is not part of the MVP architecture.

---

## 11. Authentication and Tenancy

Fluxora uses Clerk as the managed authentication provider.

Current responsibility split:

```text

GitHub

  ↓

Clerk

  ↓

Authenticated identity

  ↓

Fluxora User + Organization + Role

  ↓

PostgreSQL RLS

```

Clerk handles authentication.

Fluxora owns:

- Organization

- User

- roles

- organization membership

- tenant authorization

PostgreSQL RLS remains the database-level tenant boundary.

Fluxora intentionally does not use Clerk Organizations as the product tenant authority.

---

## 12. Local / Production Separation

Local development is optimized for the available hardware.

Production architecture is optimized for:

- correctness

- isolation

- scaling

- resilience

- deployment

The implementation intentionally supports both local and production adapters without changing application-level contracts.

### Redis

```text

Local

→ InMemoryRedisAdapter

Production

→ RedisAdapter

→ real/managed Redis

```

### Object storage

```text

Local

→ FilesystemObjectStorage

Production

→ S3ObjectStorage

→ AWS S3 / S3-compatible storage

```

### Secrets

```text

Local

→ EnvSecretsProvider

Production

→ SecretsManagerProvider

→ managed secrets service

```

Production adapters are implemented, but production infrastructure is not required to run locally.

---

## 13. Current Local Development Environment

Machine constraints:

```text

Windows

4 GB RAM

```

Current tooling/environment:

```text

Node.js 24.18.0

pnpm 10.34.5

Git

PostgreSQL 18.6

```

Current PostgreSQL:

```text

Host: localhost

Port: 5432

Database: fluxora_dev

```

PostgreSQL is currently the required persistent local infrastructure service.

Deferred as running local services:

```text

Redis server

MinIO / S3-compatible server

MailHog

Docker Desktop

```

The code for production adapters exists without requiring those services to be running locally.

### Step 9 local-development bootstrap

The repository now defines a reproducible local infrastructure recipe plus deterministic database lifecycle commands.

Compose services:

```text
postgres
redis
minio
minio-init
```

The Compose PostgreSQL service maps:

```text
host 5433 → container 5432
```

so it can coexist with the native PostgreSQL instance already using `localhost:5432`.

Local database lifecycle commands are:

```text
pnpm db:migrate
pnpm db:seed
pnpm db:reset
```

`db:seed` creates deterministic local organization/user state through the existing database provisioning path and is safe to rerun.

`db:reset` is destructive and validates that the configured target is clearly the local `fluxora_dev` development database before clearing tenant data.

Step 9 does not add a new SQL migration because the schema remains unchanged.

### Step 9 CLI/module lifecycle lesson

The reset acceptance test initially exposed a runtime bug: `seed.ts` contained a top-level `main()` call. When `reset.ts` imported the reusable seed function, ES module evaluation also executed that top-level call, creating an unexpected second CLI path and resulting in:

```text
Called end on pool more than once
```

The reusable seed logic and direct CLI entrypoint were separated so `main()` only runs when `seed.ts` is directly executed.

The incident is recorded as a learning/debugging item because it demonstrates module evaluation, top-level side effects, and explicit resource ownership.


---

## 14. Step 5 Infrastructure Boundary

The infrastructure package currently contains:

```text

packages/infrastructure/

├── src/

│   ├── index.ts

│   │

│   ├── redis/

│   │   ├── client.ts

│   │   ├── in-memory.ts

│   │   ├── node-redis.ts

│   │   └── keys.ts

│   │

│   ├── object-storage/

│   │   ├── client.ts

│   │   ├── filesystem.ts

│   │   ├── s3.ts

│   │   └── paths.ts

│   │

│   └── secrets/

│       ├── client.ts

│       ├── env.ts

│       ├── cached.ts

│       └── aws-secrets-manager.ts

```

### Redis

Tenant-scoped key helpers include:

```text

organizationRedisKey()

cacheKey()

lockKey()

rateLimitKey()

```

Example:

```text

org:{organizationId}\:cache:{key}

```

### Object storage

Tenant-safe snapshot keys follow:

```text

{organizationId}/{repositoryId}/{snapshotId}/{objectName}

```

Example:

```text

org-123/repo-456/snapshot-789/source/index.ts

```

Invalid traversal/path patterns are rejected.

### Secrets

The secrets boundary contains:

```text

SecretsClient

EnvSecretsProvider

SecretsManagerProvider

CachedSecretsClient

```

Secret caching is short-lived and in memory.

Secrets are never intentionally persisted to disk by the infrastructure package.

---

## 15. Node 24 Native TypeScript Execution

Fluxora currently uses two distinct mechanisms:

### Type validation

```powershell

tsc --noEmit

```

### Infrastructure test execution

```powershell

node --experimental-strip-types --test

```

Node's strip-only execution supports erasable TypeScript syntax but does not support constructs requiring JavaScript transformation, such as TypeScript parameter properties.

Therefore runtime-tested classes use explicit fields and assignments instead of parameter properties.

This is a runtime execution constraint, not an architectural constraint.

---

## 16. Testing Philosophy

Testing should verify architectural invariants, not merely line coverage.

Important distributed-system tests include:

- idempotency

- retries

- crash recovery

- job claiming

- lease expiry / stale-worker recovery

- duplicate job submission

- tenant-scoped behavior

Step 5 local runtime tests cover:

- Redis key helpers

- Redis set-if-absent

- Redis increment

- Redis delete

- Redis ping

- filesystem object storage

- object write/read

- existence/deletion

- path traversal rejection

- environment secret lookup

- missing-secret handling

- secret caching

- cache invalidation

Step 6 runtime tests cover:

- basic job enqueue/claim

- `FOR UPDATE SKIP LOCKED` claim behavior

- lease expiry and reclaim

- worker ownership validation

- successful completion

- failure/retry

- dead-letter behavior

- worker harness success path

- worker harness failure path

- same-tenant idempotency

- cross-tenant idempotency isolation

Real production services are not required for these local tests.

## 17. Current Verification

Step 5 verification completed:

```text

pnpm --filter @fluxora/infrastructure typecheck ✅

pnpm --filter @fluxora/infrastructure test       ✅

pnpm typecheck                                   ✅

```

Step 6 verification completed:

```text

pnpm --filter @fluxora/db typecheck       ✅

pnpm --filter @fluxora/workers typecheck  ✅

pnpm typecheck                            ✅

```

Step 6 runtime verification also completed for:

```text

basic claim                              ✅

lease expiry / reclaim                   ✅

completion ownership                     ✅

failure / retry / dead-letter            ✅

worker success integration               ✅

worker failure integration               ✅

idempotency within tenant                ✅

idempotency across tenants               ✅

```

Step 5 production adapters and Step 6 production deployment behavior have not been exercised against live production infrastructure locally.

Step 7 verification completed:

```text

pnpm --filter @fluxora/observability typecheck ✅

pnpm --filter @fluxora/api typecheck            ✅

pnpm --filter @fluxora/workers typecheck       ✅

pnpm typecheck                                  ✅

```

Step 7 end-to-end telemetry verification completed with a local OpenTelemetry Collector:

```text

Collector OTLP/HTTP receiver on :4318       ✅

Fluxora API startup with OTel               ✅

Dummy endpoint HTTP 200                     ✅

Traces received                             ✅

Metrics received                            ✅

Logs received                               ✅

service.name = @fluxora/api                 ✅

fluxora.telemetry.dummy span                ✅

fluxora.telemetry.dummy.request log         ✅

HTTP request duration metric                ✅

```

The local Collector uses the debug exporter for verification. This proves the application-to-Collector telemetry path; a production observability backend is not required for this local acceptance test.

Step 8 local quality verification completed:

```text

pnpm lint                                      ✅

pnpm typecheck                                 ✅

pnpm test                                      ✅

7 tests passed, 0 failed                      ✅

pnpm build                                     ✅

Next.js production build                       ✅

```

The CI workflow was executed successfully on `main` for both the CI foundation commit and the hosted-runtime commit:

```text

CI #1 — 741de67 — passed ✅

CI #2 — 83b6602 — passed ✅

```

The deployed frontend was manually smoke-tested on Vercel:

```text

homepage renders                              ✅

/sign-in loads                                ✅

Continue with GitHub                          ✅

authenticated landing page                   ✅

/dashboard protected route                   ✅

```

The API was prepared for a hosted runtime and verified locally with a Render-like `PORT`:

```text

PORT=4100                                       ✅

server binds to 0.0.0.0                         ✅

GET /healthz                                   200 ✅

health response status = ok                    ✅

```

Render deployment verification completed:

```text

Render service: fluxora-api                   ✅ LIVE

Branch: main                                   ✅

Plan: Free                                     ✅

Region: Singapore                              ✅

Health check: /healthz                         ✅

Auto-deploy: On Commit                         ✅

Hosted PostgreSQL                              ✅

Production environment variables configured   ✅

Hosted /healthz request verified               ✅

```

The hosted `/healthz` endpoint performs `SELECT 1`, so the successful response verified both API reachability and API-to-hosted-PostgreSQL connectivity.

Step 8 therefore meets the current implementation acceptance criteria for the CI/CD foundation and hosted frontend/API baseline. Full staging promotion, automated E2E gates, production smoke-test automation, and rollback orchestration remain future hardening work rather than claims of completion in Step 8.

## 17.1 Step 9 Verification

Step 9 local-development verification completed after the reset/seed lifecycle bug was fixed:

```text
pnpm db:migrate       ✅ No pending migrations
pnpm db:seed          ✅
pnpm db:seed          ✅ Idempotent / same logical local identity
pnpm db:reset         ✅
pnpm db:seed          ✅ Reset/reseed restored known state
pnpm typecheck        ✅
pnpm lint             ✅
pnpm test             ✅ 7 passed, 0 failed
pnpm build            ✅
```

The acceptance test is intentionally broader than typechecking because the Step 9 failure was behavioral rather than type-level: the original implementation was valid TypeScript but had an unintended top-level module side effect during CLI import.

## 18. Job Architecture — Implemented

The MVP uses a PostgreSQL-backed job queue and transactional outbox-compatible worker foundation.

Jobs are:

- idempotent

- retryable

- observable

- tenant-aware

Every job carries organization context.

Implemented queue capabilities:

```text

enqueue

claim

complete

fail

retry

dead-letter

idempotency enforcement

lease-based crash recovery

```

The MVP claim mechanism uses PostgreSQL row locking with:

```sql

SELECT ... FOR UPDATE SKIP LOCKED

```

Worker crashes allow jobs to become claimable again after lease expiry.

Repeated failures eventually route to `dead_letter` rather than retrying forever.

The worker harness dispatches jobs through a typed handler registry and handles success, retryable failure, and dead-letter transitions.

## 19. Current Next Implementation Target

### Phase 1 — Step 9 — COMPLETE

Step 9 established the repeatable local-development foundation.

Implemented:

- Docker Compose local-infrastructure recipe for PostgreSQL, Redis, MinIO, and MinIO bucket initialization
- deterministic local seed command
- guarded destructive reset command
- shared environment-loading/local-database validation helper
- root-level `db:migrate`, `db:seed`, and `db:reset` scripts

Current low-RAM development mode remains:

```text
PostgreSQL → native PostgreSQL 18.6
Redis → in-memory adapter
Object storage → filesystem adapter
API/workers/web → native Node processes
Docker Desktop → not required
```

Compose remains the reproducible multi-service environment definition for stronger machines and CI.

Step 9 verification completed:

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

The seed was verified as idempotent because repeated seeding returned the same logical local organization/user.

The reset path initially exposed a PostgreSQL pool lifecycle bug caused by `seed.ts` executing a top-level CLI `main()` when the module was imported by `reset.ts`. The reusable seed logic was separated from direct CLI execution so importing `seed.ts` no longer starts its CLI entrypoint. Reset/reseed then passed cleanly, and the full quality gate was rerun successfully.

### Post-Step-9 target

The next engineering activity is the planned AWS production infrastructure alignment. Step 10 repository ingestion should begin only after that target production environment is aligned and verified.

Step 10, as implemented after that note, is the GitHub App installation and setup flow. Repository ingestion, snapshots, workers, and webhooks remain later work. See section 27.

Step 9 does not introduce a new SQL migration because it does not change database schema; it adds local environment/bootstrap and data-lifecycle tooling.

## 20. Security Model

Repository source code is sensitive and potentially adversarial.

Rules:

- never execute customer repository code during static analysis

- never treat repository content as trusted instructions

- treat repository content reaching the AI layer as untrusted data

- never commit secrets

- never log secrets

- never persist secrets in source files

- enforce tenant isolation at multiple layers

Tenant isolation includes:

```text

application authorization

        +

PostgreSQL RLS

        +

tenant-scoped jobs

        +

tenant-scoped object-storage paths

        +

tenant-scoped Redis keys

```

---

## 21. Observability — Implemented

OpenTelemetry is now part of the Phase 1 foundation.

Implemented architecture:

```text

API + Workers

     ↓

@fluxora/observability

     ↓

OpenTelemetry SDK

     ↓

Traces / Metrics / Logs

     ↓

OTLP/HTTP

     ↓

OpenTelemetry Collector

```

Implemented components include:

- shared `@fluxora/observability` package

- OTLP trace exporter

- OTLP metric exporter

- OTLP log exporter

- OpenTelemetry HTTP instrumentation

- API bootstrap-time telemetry initialization

- worker job-processing spans

- dummy telemetry endpoint

- local Collector configuration for verification

Verified API telemetry includes:

```text

fluxora.telemetry.dummy

fluxora.telemetry.dummy.request

http.server.request.duration

```

Verified service resource identity:

```text

service.name = @fluxora/api

service.version = 0.0.0

deployment.environment.name = development

```

Target production observability areas remain:

- API latency

- ingestion latency

- analysis duration

- graph size

- AI cost/token usage

- job failure rate

- queue backlog

---

## 22. CI/CD — Implemented Foundation

Step 8 established a working CI/CD and hosted-deployment foundation.

### 22.1 Continuous Integration

GitHub Actions workflow:

```text

.github/workflows/ci.yml

```

Triggers:

```yaml

on:

  pull_request:

  push:

    branches: [main]

```

Current quality-gate sequence:

```text

checkout

  ↓

pnpm 10.34.5

  ↓

Node 24

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

The CI workflow is intentionally repository-root based because Fluxora is a pnpm workspace and the API/frontend depend on internal workspace packages.

The workflow uses:

```text

pnpm/action-setup@v4

setup-node@v7

```

with dependency caching through pnpm.

### 22.2 Frontend delivery

```text

GitHub main

   ↓

Vercel

   ↓

apps/web

```

The Vercel project uses `apps/web` as its project root. Clerk environment variables are configured in Vercel for the hosted web application.

Hosted smoke verification established that authentication and the protected dashboard work on the deployed frontend.

### 22.3 API delivery

```text

GitHub main

   ↓

Render Web Service

   ↓

apps/api

```

Current Render configuration:

```text

service: fluxora-api

branch: main

runtime: Node

root directory: repository root

region: Singapore

plan: Free

auto-deploy: On Commit

health check: /healthz

```

The API intentionally does not have a `build` script in `apps/api/package.json`. It currently executes TypeScript directly with Node's native strip-types runtime.

Therefore the hosted build command is:

```text

pnpm install --frozen-lockfile && pnpm db\:migrate && pnpm --filter @fluxora/api typecheck

```

and the start command is:

```text

pnpm --filter @fluxora/api start

```

This keeps database migration, type validation, and runtime startup explicit instead of inventing a compiled `dist/` build that the API does not currently use.

### 22.4 Runtime and health model

The API reads `PORT` with fallback to the local `API_PORT` default and binds to:

```text

0.0.0.0

```

This is required for the hosted service to receive traffic.

The `/healthz` route is intentionally unauthenticated and performs:

```sql

SELECT 1

```

before returning:

```json

{

  "status": "ok",

  "service": "fluxora-api"

}

```

This makes the health check an application-level readiness check rather than a process-only check.

### 22.5 Production configuration boundary

Local and hosted runtime configuration remain separate:

```text

local .env

NODE_ENV=development

Render environment

NODE_ENV=production

```

Hosted secrets/configuration are stored in Render environment variables rather than committed to Git.

Current API runtime variables include:

```text

DATABASE_URL

CLERK_SECRET_KEY

CLERK_AUTHORIZED_PARTIES

NODE_ENV

```

Step 10 adds GitHub App settings. The API host (Render) receives the App id and private key. The web host (Vercel) receives the public App slug and the API origin. Installation ids are not environment variables.

```text

GITHUB_APP_ID

GITHUB_APP_PRIVATE_KEY

GITHUB_APP_SLUG

FLUXORA_API_URL

```

`PORT` is provided by the hosted runtime and is not hard-coded as a production constant.

### 22.6 Database delivery

The hosted API uses a hosted PostgreSQL instance rather than the developer's local PostgreSQL at `localhost:5432`.

The local database remains:

```text

localhost:5432/fluxora_dev

```

The hosted deployment uses the hosted database connection URL through `DATABASE_URL`.

This separation is deliberate:

```text

local machine

    ↓

local PostgreSQL

Render

    ↓

hosted PostgreSQL

```

A local `localhost` database must not be treated as a production database endpoint.

### 22.7 Deployment behavior

The current Step 8 baseline is:

```text

commit to main

     ↓

GitHub Actions quality gates

     ↓

Vercel / Render deployment mechanisms

     ↓

health / smoke verification

```

This is a real deployment foundation, but it is not yet the final enterprise promotion system.

Future hardening can add:

```text

PR preview E2E gates

staging environment

manual promotion

production smoke tests

automated rollback policy

migration safety gates

worker deployment pipeline

```

Those are explicitly future work unless implemented by a later roadmap step.

## 23. Learning-First Development

Fluxora is also a learning and interview project.

The developer should understand:

- why the architecture is structured this way

- why each storage decision was made

- how graph traversal works

- how evidence is generated

- how idempotency works

- how worker failures are handled

- how AI is prevented from becoming the source of truth

- how trade-offs change at larger scale

Learning notes are maintained separately from the canonical architecture.

The Step 9 learning package includes:

```text
learning/notes/8. Personal Learning - Step 9.md
learning/phase-01/step-09-local-dev-compose-seed.md
interviews/2. Step 9 Interview CheatSheet.md
```

The Step 10 learning package includes:

```text
learning/9. Github App Installation.md
learning/phase-02/step-10-github-app-installation.md
interviews/3. Github App Installation Interview CheatSheet.md
```

The personal learning note covers repeatable local development, migration-vs-seed boundaries, idempotency, reset safety, ES module evaluation, top-level calls, CLI/library separation, PostgreSQL pool ownership, and the debugging incident found during reset verification.

Current private learning structure:

```text

learning/

├── concepts/

├── decisions/

├── interviews/

├── notes/

│   ├── 1. Monorepo & Foundation.md

│   ├── 2. Backend Foundation.md

│   ├── 3. PostgreSQL & DB.md

│   ├── 4. Infrastructure Foundation.md

|   ├── 5. PostgreSQL Job Queue, Distributed Workers & Failure 

|   |      Handling

│   ├── 6. OpenTelemetry Observability.md

│   ├── 7. CI-CD and Production Deployment.md
│   └── 8. Personal Learning - Step 9.md

├── 9. Github App Installation.md

├── phase-01/

    ├── step-01-monorepo.md

    ├── step-02-database.md

    ├── step-03-auth.md

    ├── step-04-nextjs-clerk.md

    ├── step-05-infrastructure.md

    ├── step-06-job-queue-worker-harness.md

    ├── step-07-opentelemetry.md

    ├── step-08-ci-cd.md

    └── step-09-local-dev-compose-seed.md

└── phase-02/

    └── step-10-github-app-installation.md

```

---

## 24. Prompt Workflow

`prompts/` is a private prompt library.

It may contain:

- Cursor implementation prompts

- debugging prompts

- architecture prompts

- review prompts

Cursor is an implementation aid, not the architectural owner.

For routine fixes, verification, or straightforward coding, prefer direct implementation rather than spending Cursor tokens unnecessarily.

---

## 25. Cursor Operating Model

For meaningful implementation tasks:

1\. Inspect the current repository.

2\. Read the relevant canonical architecture documents.

3\. Plan the smallest coherent change.

4\. Implement.

5\. Verify with appropriate tests/typecheck/build/lint.

6\. Review for unintended changes and architecture violations.

7\. Record the actual result.

Never claim verification that was not actually run.

---

## 26. Scope Discipline

When uncertain:

1\. Prefer the canonical architecture package.

2\. Prefer the smallest coherent change.

3\. Prefer deterministic behavior.

4\. Prefer explicit evidence.

5\. Prefer simple infrastructure at MVP scale.

6\. Do not invent requirements.

7\. Do not silently expand scope.

8\. Do not hide uncertainty.

9\. Do not claim tests passed unless they actually passed.

---

## 27. Step 10 — GitHub App Installation

Step 10 connects a GitHub App installation to the signed-in Fluxora organization. It does not ingest repositories.

### Responsibility split

Clerk authenticates the person and exposes the GitHub account id from the linked external account.

The GitHub App is a separate credential. Its App ID and private key prove that Fluxora is that App. They do not identify the user.

The installation id identifies one install of that App on one GitHub account. It arrives on the Setup URL query string. It is never hard-coded and it is not an environment variable.

### Request path

```text
Dashboard "Connect GitHub"
        ↓
https://github.com/apps/{slug}/installations/new
        ↓
GitHub redirects the browser to /github/setup?installation_id=...&setup_action=install|update
        ↓
Next.js server reads the Clerk session and POSTs the installation id string
        ↓
POST /api/v1/github/installations
        ↓
App JWT (RS256, iss = App ID) → GET /app/installations/{id}
        ↓
account.id must equal the Clerk GitHub user id, and account.type must be User
        ↓
github_installations row under the caller's organization, with RLS
```

`github_installation_id` is accepted only as a decimal string. A JSON number is rejected so the id is not rounded through `Number` before it is stored in PostgreSQL `bigint`. Responses keep the same ids as strings. The SQL casts those strings with `::bigint` and reads them back with `::text`.

### Persistence and idempotency

`github_installations` has one row per organization and a globally unique `github_installation_id`. Repeating the same completion returns the existing row with `created: false`. A later install for the same GitHub account refreshes the installation id. A different GitHub account is rejected. Installation access tokens are not created or stored.

RLS policies match the existing tenant tables: `organization_id = fluxora_current_org_id()`, with `ENABLE` and `FORCE ROW LEVEL SECURITY`. Because RLS hides another tenant's row, the global unique index is what stops a second organization from claiming the same installation. A unique violation aborts the current PostgreSQL transaction, so the write runs inside a savepoint, rolls back to that savepoint, and then re-reads the caller's row.

`TRUNCATE organizations CASCADE` in the local reset already removes these rows through the foreign key. No seed installation is created.

### Security choices

The dashboard link only contains the public App slug. The Next.js process loads `GITHUB_APP_SLUG` and `FLUXORA_API_URL` from the environment and does not load the private key. The API signs the JWT and calls GitHub. Logs pass through redaction for PEM blocks, bearer tokens, and JWTs.

The Setup URL is a GET because that is how GitHub redirects the browser. Completion is safe to repeat. The browser session is not trusted to pick an arbitrary installation: the API fetches the installation with the App JWT and requires the installation account to be the same personal GitHub user Clerk already linked. An organization installation is rejected in this step because its account id is the org id, and the App JWT alone does not prove the signed-in user administers that org.

Only organization owners and admins can complete installation.

The web server posts the Clerk session token only to a `FLUXORA_API_URL` that is https, or http on localhost, and that URL must not contain credentials.

### Verification status

Step 10 code and focused tests were added. `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, and `pnpm db:migrate` were not run as part of this change.
