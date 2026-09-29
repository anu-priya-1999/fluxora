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

> Build a deterministic, evidence-backed software model first. Use AI to explain and reason over verified evidence; never use the LLM as the source of truth.

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
Step 8 — CI/CD                                        ⏭ NEXT
Step 9 — Local-dev compose/seed skeleton              ⏳
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

---

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
org:{organizationId}:cache:{key}
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

### Phase 1 — Step 8

Implement the CI/CD foundation.

Current target:

```text
CI
 ↓
lint + typecheck + unit tests
 ↓
build
 ↓
preview deployment per PR
```

Do not implement Step 9 while completing Step 8.

Do not mark Step 8 complete until the workflow is actually executed successfully.

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

## 22. CI/CD

CI/CD is a later Phase 1 step.

Planned checks include:

- lint
- typecheck
- unit tests
- build
- preview deployment per PR

Do not claim CI/CD completion until the actual workflow has been executed successfully.

---

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
│   └── 5. OpenTelemetry Observability.md
└── phase-01/
    ├── step-01-monorepo.md
    ├── step-02-database.md
    ├── step-03-auth.md
    ├── step-04-nextjs-clerk.md
    ├── step-05-infrastructure.md
    ├── step-06-job-queue-worker-harness.md
    └── step-07-opentelemetry.md
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

1. Inspect the current repository.
2. Read the relevant canonical architecture documents.
3. Plan the smallest coherent change.
4. Implement.
5. Verify with appropriate tests/typecheck/build/lint.
6. Review for unintended changes and architecture violations.
7. Record the actual result.

Never claim verification that was not actually run.

---

## 26. Scope Discipline

When uncertain:

1. Prefer the canonical architecture package.
2. Prefer the smallest coherent change.
3. Prefer deterministic behavior.
4. Prefer explicit evidence.
5. Prefer simple infrastructure at MVP scale.
6. Do not invent requirements.
7. Do not silently expand scope.
8. Do not hide uncertainty.
9. Do not claim tests passed unless they actually passed.
10. Stop and revisit the architecture when implementation would change a documented architectural boundary.

---

## 27. Current Foundation Status

```text
FOUNDATION

Monorepo                         ✅
PostgreSQL + tenancy + RLS       ✅
Clerk authentication             ✅
Next.js auth/dashboard           ✅
Redis abstraction                ✅
Object storage abstraction       ✅
Secrets abstraction              ✅
Step 5 runtime tests             ✅
PostgreSQL job queue             ✅
Worker harness                   ✅
Job runtime verification         ✅

OpenTelemetry                    ✅ Step 7
CI/CD                            ⏭ Step 8
Local compose/seed               ⏳ Step 9
```

## 28. Product Status

Product-specific code intelligence has not yet started.

```text
GitHub App integration           ⬜
Repository ingestion             ⬜
Snapshot ingestion               ⬜
Language/framework detection     ⬜
Symbol extraction                ⬜
Import/export graph              ⬜
Graph construction               ⬜
Evidence engine                  ⬜
Impact analysis                  ⬜
Simulation engine                ⬜
AI reasoning                     ⬜
Architecture Explorer            ⬜
Runtime telemetry                ⬜
```

These remain later roadmap work.

---

## 29. Complete Current Mental Model

```text
                             USER
                               ↓
                             WEB
                               ↓
                            CLERK
                               ↓
                   authenticated identity
                               ↓
                              API
                               ↓
              Fluxora User + Organization + Role
                               ↓
                         tenant context
                               ↓
                   ┌───────────┼───────────┐
                   ↓           ↓           ↓
                  DB       Infrastructure  API logic
                   ↓           │
              PostgreSQL       │
                + RLS          │
                               │
              ┌────────────────┼────────────────┐
              ↓                ↓                ↓
            Redis           Storage           Secrets
              ↓                ↓                ↓
          local/prod       local/prod       local/prod
```

Asynchronous execution:

```text
WEB
 ↓
API
 ↓
PostgreSQL job
 ↓
Worker
 ↓
Repository ingestion
 ↓
Static analysis
 ↓
Graph
 ↓
Evidence
 ↓
Impact analysis
 ↓
Simulation
 ↓
AI explanation
```

The deterministic software model remains the authority. AI sits above it.

---

## 30. Current One-Line State

> Fluxora has completed the first seven foundation steps: monorepo, PostgreSQL tenancy/RLS, Clerk authentication, Next.js authentication UI/dashboard, production-compatible Redis/object-storage/secrets infrastructure boundaries, the PostgreSQL-backed job queue plus worker harness with runtime verification, and OpenTelemetry traces/metrics/logs verified end-to-end through a local Collector; the next implementation target is CI/CD (Step 8).
