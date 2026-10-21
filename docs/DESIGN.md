**\*\*# Fluxora — DESIGN.md\*\***







**\*\*## 1. Purpose\*\***







Fluxora is an AI-powered software digital twin.







It builds a deterministic, queryable, evidence-backed model of a software system from source code, repository history, dependencies, APIs, infrastructure metadata, and later runtime telemetry.







Fluxora provides:







\\- Architecture Explorer







\\- Change-impact / blast-radius analysis







\\- Deterministic scenario simulation







\\- Evidence-backed AI explanations







\\- Architecture Q&A grounded in the software model







Fluxora is deliberately not:







\\- a generic chatbot over GitHub







\\- an AI code-review wrapper







\\- a linter







\\- an APM replacement







The central product principle is:







\\\\> Build a deterministic, evidence-backed software model first. Use AI to explain and reason over verified evidence; never use the LLM as the source of truth.







\\---







**\*\*## 2. Source of Truth\*\***







The detailed architecture package under:







\\\`\\\`\\\`text







docs/architecture/







\\\`\\\`\\\`







is the canonical architectural source of truth.







Canonical documents:







\\\`\\\`\\\`text







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







\\\`\\\`\\\`







\\\`DESIGN.md\\\` is only the compact, living implementation snapshot.







It records:







\\- current implementation state







\\- active engineering constraints







\\- current technology decisions







\\- current development environment







\\- current implementation phase







\\- current next step







When \\\`DESIGN.md\\\` and the canonical architecture package appear to conflict, review the architecture package before changing the design.







\\---







**\*\*## 3. Product Definition\*\***







Fluxora models software relationships such as:







\\\`\\\`\\\`text







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







\\\`\\\`\\\`







The model is deterministic, evidence-backed, and queryable.







Fluxora is intended to answer questions such as:







\\- What depends on this function?







\\- What could break if this PR is merged?







\\- What is the blast radius of this change?







\\- What happens if a dependency becomes unavailable?







\\- Why is this component affected?







\\- What evidence supports this conclusion?







\\---







**\*\*## 4. Core Architectural Invariants\*\***







**\*\*### 4.1 Deterministic core\*\***







The following must never depend on an LLM:







\\- dependency graph construction







\\- dependency relationship discovery







\\- graph traversal







\\- blast-radius calculation







\\- simulation propagation







\\- evidence provenance







\\- authorization







\\- tenant isolation







For identical input, deterministic analysis should produce reproducible results.







The deterministic core must remain independently testable without an LLM.







**\*\*### 4.2 AI boundary\*\***







The AI layer may:







\\- explain deterministic findings







\\- narrate impact analysis







\\- narrate simulation results







\\- answer architecture questions using verified context







\\- summarize evidence







\\- provide explicitly labeled suggestions







The AI layer must not:







\\- discover graph truth







\\- decide what depends on what







\\- calculate blast radius







\\- determine simulation propagation







\\- determine authorization







\\- fabricate evidence







\\- mutate the deterministic graph as an authoritative source







The LLM is an explanatory/reasoning layer over verified system facts.







\\---







**\*\*## 5. Evidence Model\*\***







Evidence is a cross-cutting concept.







Relevant user-facing claims should be traceable through:







\\\`\\\`\\\`text







source file







    ↓







symbol







    ↓







relationship







    ↓







analysis run







    ↓







confidence / provenance







\\\`\\\`\\\`







If a deterministic claim cannot be supported by evidence, it should not be presented as a deterministic fact.







\\---







**\*\*## 6. Confidence and Provenance\*\***







Static analysis of JavaScript and TypeScript is inherently incomplete.







Examples include:







\\- dynamic imports







\\- dynamically constructed values







\\- reflection-like patterns







\\- unusual framework behavior







\\- unsupported syntax







Known provenance categories include:







\\\`\\\`\\\`text







static-analysis







inferred







ai-hypothesis







runtime-observed







\\\`\\\`\\\`







These categories must remain distinguishable.







AI hypotheses must not become visually or semantically equivalent to statically established facts.







\\---







**\*\*## 7. Current Implementation Phase\*\***







**\*\*### Phase 1 — Foundation\*\***







The goal of Phase 1 is to establish a deployable software foundation before product-specific code intelligence.







Current progress:







\\\`\\\`\\\`text







Step 1 — Monorepo foundation                         ✅ COMPLETE







Step 2 — PostgreSQL + Organization/User + RLS        ✅ COMPLETE







Step 3 — Clerk authentication + identity mapping     ✅ COMPLETE







Step 4 — Next.js + Clerk auth UI/dashboard            ✅ COMPLETE







Step 5 — Redis + object storage + secrets abstraction ✅ COMPLETE







Step 6 — PostgreSQL job queue + worker harness        ✅ COMPLETE







Step 7 — OpenTelemetry                                ✅ COMPLETE







Step 8 — CI/CD                                        ✅ COMPLETE







Step 9 — Local-dev compose/seed skeleton             ✅ COMPLETE







\\\`\\\`\\\`







Phase 2 progress:







\\\`\\\`\\\`text







Step 10 — GitHub App installation + setup flow       IMPLEMENTED







Step 11 — Repository, RepositorySnapshot, Commit     IMPLEMENTED







Step 12 — Repository ingestion worker                IMPLEMENTED



Step 13 — Repository snapshot storage                ✅ COMPLETE







\\\`\\\`\\\`







Phase 1 includes:







\\- monorepo







\\- PostgreSQL







\\- database migrations







\\- organization/user tenancy foundation







\\- managed authentication boundary







\\- PostgreSQL RLS







\\- Redis abstraction







\\- object storage abstraction







\\- secrets abstraction







\\- job queue







\\- worker harness







\\- observability







\\- CI/CD foundation







\\- local development foundation







Phase 1 does not yet include:







\\- GitHub repository ingestion







\\- AST analysis







\\- dependency graph construction







\\- impact analysis







\\- simulation engine







\\- AI reasoning







\\- runtime telemetry







The implementation roadmap remains the authority for phase boundaries.



Step 10 implementation note: the final GitHub setup completion is a browser-side POST from the Vercel web origin to the Render API. The browser obtains the Clerk session token with \`useAuth().getToken()\`. Because the API is cross-origin from the web host, the GitHub installation endpoint handles \`OPTIONS\` preflight and scoped CORS using the same exact origins listed in \`CLERK_AUTHORIZED_PARTIES\`.



Step 11 implementation note: Fluxora now stores tenant-owned \`repositories\` plus immutable \`repository_snapshots\` and \`commits\` under each repository. Child tables do not carry \`organization_id\`; RLS walks \`Repository → Organization\`. This step does not ingest GitHub trees, mint installation tokens, upload object storage, or add a connect API.



Step 12 implementation note: the worker handles \`repository.ingest\`. It validates \`job.organization_id\` against the repository, mints a short-lived GitHub App installation token from the Step 10 installation row, fetches the GitHub tarball at the resolved commit, and extracts into an isolated temp directory with size, file-count, timeout, path-traversal, and symlink guards. It does not upload to object storage, persist \`RepositorySnapshot\`/\`Commit\` rows, expose a connect API, or push WebSocket progress.



Step 13 implementation note: the worker deterministically packages the Step 12 extracted repository tree as one \`snapshot.tar.gz\`, computes SHA-256 over the final archive bytes, uploads the archive through the existing object-storage abstraction, and persists immutable tenant-scoped \`RepositorySnapshot\` metadata in PostgreSQL. The object key is \`{organizationId}/{repositoryId}/{snapshotId}/snapshot.tar.gz\`. If database persistence fails after object upload, the uploaded object is deleted; partial local archives are also removed. Step 13 does not add the repository connect API, WebSocket progress, AST analysis, graph construction, or AI reasoning.









**\*\*## 8. Current Repository Shape\*\***







\\\`\\\`\\\`text







fluxora/







├── apps/







│   ├── api/







│   ├── web/







│   └── workers/







│







├── packages/







│   ├── db/







│   ├── infrastructure/







│   ├── observability/







│   └── shared-types/







│







├── docs/







│   └── architecture/







│







├── learning/







├── prompts/







├── .cursor/







├── .observability/







└── package.json







\\\`\\\`\\\`







Mental model:







\\\`\\\`\\\`text







apps     = applications/services that run







packages = reusable internal building blocks







\\\`\\\`\\\`







\\---







**\*\*## 9. Application Boundaries\*\***







**\*\*### \\\`apps/web\\\`\*\***







Responsibilities:







\\- Next.js application







\\- authentication UI







\\- organization dashboard







\\- repository UI







\\- Architecture Explorer







\\- node inspection







\\- PR impact reports







\\- simulation views







\\- architecture Q&A







\\- organization settings







The frontend consumes server state through the API rather than owning backend business rules.







**\*\*### \\\`apps/api\\\`\*\***







Responsibilities:







\\- HTTP API







\\- Clerk authentication boundary







\\- Fluxora authorization / tenant-role checks







\\- resource CRUD







\\- job orchestration







\\- graph reads







\\- impact/simulation result reads







\\- API contracts







The API must not perform heavy repository analysis synchronously.







**\*\*### \\\`apps/workers\\\`\*\***







Responsibilities:







\\- asynchronous jobs







\\- repository ingestion







\\- static analysis







\\- graph construction







\\- impact analysis







\\- simulation







\\- AI reasoning







Workers are designed for retryability and idempotency.







Production may split worker types into separate scalable pools.







Local development may run worker types in a single process.







**\*\*### \\\`packages/db\\\`\*\***







Responsibilities:







\\- database schema







\\- migrations







\\- database access







\\- persistence utilities







\\- transaction helpers







**\*\*### \\\`packages/shared-types\\\`\*\***







Responsibilities:







\\- shared TypeScript types







\\- domain contracts







\\- API contracts







\\- event payload types







\\- schemas shared between applications







**\*\*### \\\`packages/infrastructure\\\`\*\***







Responsibilities:







\\- Redis abstractions and adapters







\\- object-storage abstractions and adapters







\\- secrets abstractions and providers







\\- environment-specific infrastructure boundaries







**\*\*### \\\`packages/observability\\\`\*\***







Responsibilities:







\\- OpenTelemetry SDK configuration







\\- trace, metric, and log signal helpers







\\- OTLP exporter configuration







\\- shared instrumentation boundaries for API and workers







\\- service/resource identity configuration







\\---







**\*\*## 10. Database Strategy\*\***







**\*\*### MVP system of record\*\***







PostgreSQL is the system of record.







PostgreSQL stores:







\\- tenancy data







\\- users







\\- repositories







\\- analysis runs







\\- graph nodes







\\- graph edges







\\- evidence







\\- jobs







\\- impact results







\\- simulation results







\\- AI analysis records







\\- audit data







The dependency graph is modeled in PostgreSQL using relational adjacency structures and bounded-depth traversal.







A dedicated graph database is not part of the MVP architecture.







\\---







**\*\*## 11. Authentication and Tenancy\*\***







Fluxora uses Clerk as the managed authentication provider.







Current responsibility split:







\\\`\\\`\\\`text







GitHub







  ↓







Clerk







  ↓







Authenticated identity







  ↓







Fluxora User + Organization + Role







  ↓







PostgreSQL RLS







\\\`\\\`\\\`







Clerk handles authentication.







Fluxora owns:







\\- Organization







\\- User







\\- roles







\\- organization membership







\\- tenant authorization







PostgreSQL RLS remains the database-level tenant boundary.







Fluxora intentionally does not use Clerk Organizations as the product tenant authority.







\\---







**\*\*## 12. Local / Production Separation\*\***







Local development is optimized for the available hardware.







Production architecture is optimized for:







\\- correctness







\\- isolation







\\- scaling







\\- resilience







\\- deployment







The implementation intentionally supports both local and production adapters without changing application-level contracts.







**\*\*### Redis\*\***







\\\`\\\`\\\`text







Local







→ InMemoryRedisAdapter







Production







→ RedisAdapter







→ real/managed Redis







\\\`\\\`\\\`







**\*\*### Object storage\*\***







\\\`\\\`\\\`text







Local







→ FilesystemObjectStorage







Production







→ S3ObjectStorage







→ AWS S3 / S3-compatible storage







\\\`\\\`\\\`







**\*\*### Secrets\*\***







\\\`\\\`\\\`text







Local







→ EnvSecretsProvider







Production







→ SecretsManagerProvider







→ managed secrets service







\\\`\\\`\\\`







Production adapters are implemented, but production infrastructure is not required to run locally.







\\---







**\*\*## 13. Current Local Development Environment\*\***







Machine constraints:







\\\`\\\`\\\`text







Windows







4 GB RAM







\\\`\\\`\\\`







Current tooling/environment:







\\\`\\\`\\\`text







Node.js 24.18.0







pnpm 10.34.5







Git







PostgreSQL 18.6







\\\`\\\`\\\`







Current PostgreSQL:







\\\`\\\`\\\`text







Host: localhost







Port: 5432







Database: fluxora_dev







\\\`\\\`\\\`







PostgreSQL is currently the required persistent local infrastructure service.







Deferred as running local services:







\\\`\\\`\\\`text







Redis server







MinIO / S3-compatible server







MailHog







Docker Desktop







\\\`\\\`\\\`







The code for production adapters exists without requiring those services to be running locally.







**\*\*### Step 9 local-development bootstrap\*\***







The repository now defines a reproducible local infrastructure recipe plus deterministic database lifecycle commands.







Compose services:







\\\`\\\`\\\`text



postgres



redis



minio



minio-init



\\\`\\\`\\\`







The Compose PostgreSQL service maps:







\\\`\\\`\\\`text



host 5433 → container 5432



\\\`\\\`\\\`







so it can coexist with the native PostgreSQL instance already using \\\`localhost:5432\\\`.







Local database lifecycle commands are:







\\\`\\\`\\\`text



pnpm db:migrate



pnpm db:seed



pnpm db:reset



\\\`\\\`\\\`







\\\`db:seed\\\` creates deterministic local organization/user state through the existing database provisioning path and is safe to rerun.







\\\`db:reset\\\` is destructive and validates that the configured target is clearly the local \\\`fluxora_dev\\\` development database before clearing tenant data.







Step 9 does not add a new SQL migration because the schema remains unchanged.







**\*\*### Step 9 CLI/module lifecycle lesson\*\***







The reset acceptance test initially exposed a runtime bug: \\\`seed.ts\\\` contained a top-level \\\`main()\\\` call. When \\\`reset.ts\\\` imported the reusable seed function, ES module evaluation also executed that top-level call, creating an unexpected second CLI path and resulting in:







\\\`\\\`\\\`text



Called end on pool more than once



\\\`\\\`\\\`







The reusable seed logic and direct CLI entrypoint were separated so \\\`main()\\\` only runs when \\\`seed.ts\\\` is directly executed.







The incident is recorded as a learning/debugging item because it demonstrates module evaluation, top-level side effects, and explicit resource ownership.











\\---







**\*\*## 14. Step 5 Infrastructure Boundary\*\***







The infrastructure package currently contains:







\\\`\\\`\\\`text







packages/infrastructure/







├── src/







│   ├── index.ts







│   │







│   ├── redis/







│   │   ├── client.ts







│   │   ├── in-memory.ts







│   │   ├── node-redis.ts







│   │   └── keys.ts







│   │







│   ├── object-storage/







│   │   ├── client.ts







│   │   ├── filesystem.ts







│   │   ├── s3.ts







│   │   └── paths.ts







│   │







│   └── secrets/







│       ├── client.ts







│       ├── env.ts







│       ├── cached.ts







│       └── aws-secrets-manager.ts







\\\`\\\`\\\`







**\*\*### Redis\*\***







Tenant-scoped key helpers include:







\\\`\\\`\\\`text







organizationRedisKey()







cacheKey()







lockKey()







rateLimitKey()







\\\`\\\`\\\`







Example:







\\\`\\\`\\\`text







org:{organizationId}\\\\:cache:{key}







\\\`\\\`\\\`







**\*\*### Object storage\*\***







Tenant-safe snapshot keys follow:







\\\`\\\`\\\`text







{organizationId}/{repositoryId}/{snapshotId}/{objectName}







\\\`\\\`\\\`







Example:







\\\`\\\`\\\`text







org-123/repo-456/snapshot-789/source/index.ts







\\\`\\\`\\\`







Invalid traversal/path patterns are rejected.







**\*\*### Secrets\*\***







The secrets boundary contains:







\\\`\\\`\\\`text







SecretsClient







EnvSecretsProvider







SecretsManagerProvider







CachedSecretsClient







\\\`\\\`\\\`







Secret caching is short-lived and in memory.







Secrets are never intentionally persisted to disk by the infrastructure package.







\\---







**\*\*## 15. Node 24 Native TypeScript Execution\*\***







Fluxora currently uses two distinct mechanisms:







**\*\*### Type validation\*\***







\\\`\\\`\\\`powershell







tsc --noEmit







\\\`\\\`\\\`







**\*\*### Infrastructure test execution\*\***







\\\`\\\`\\\`powershell







node --experimental-strip-types --test







\\\`\\\`\\\`







Node's strip-only execution supports erasable TypeScript syntax but does not support constructs requiring JavaScript transformation, such as TypeScript parameter properties.







Therefore runtime-tested classes use explicit fields and assignments instead of parameter properties.







This is a runtime execution constraint, not an architectural constraint.







\\---

### Test Runner Migration (node:test to Vitest)

Fluxora workspace test execution was migrated from Node.js built-in `node:test` (`node --experimental-strip-types --test`) to Vitest (`vitest run`).
- Architecture Invariant: The migration is strictly behavioral and test-intent preserving. No production behaviors, database schemas, graph models, WebSocket contracts, or RLS policies were modified.
- Configuration: Standardized root `vitest.config.ts` and per-package configurations with `environment: "node"`, `fileParallelism: false` (to prevent parallel fork worker exhaustion on Windows), and custom timeouts for heavy static analysis runs (`apps/workers`).
- Command: Package test scripts execute `vitest run`, with root `pnpm test` invoking tests across the workspace.

---






**\*\*## 16. Testing Philosophy\*\***







Testing should verify architectural invariants, not merely line coverage.







Important distributed-system tests include:







\\- idempotency







\\- retries







\\- crash recovery







\\- job claiming







\\- lease expiry / stale-worker recovery







\\- duplicate job submission







\\- tenant-scoped behavior







Step 5 local runtime tests cover:







\\- Redis key helpers







\\- Redis set-if-absent







\\- Redis increment







\\- Redis delete







\\- Redis ping







\\- filesystem object storage







\\- object write/read







\\- existence/deletion







\\- path traversal rejection







\\- environment secret lookup







\\- missing-secret handling







\\- secret caching







\\- cache invalidation







Step 6 runtime tests cover:







\\- basic job enqueue/claim







\\- \\\`FOR UPDATE SKIP LOCKED\\\` claim behavior







\\- lease expiry and reclaim







\\- worker ownership validation







\\- successful completion







\\- failure/retry







\\- dead-letter behavior







\\- worker harness success path







\\- worker harness failure path







\\- same-tenant idempotency







\\- cross-tenant idempotency isolation







Real production services are not required for these local tests.







**\*\*## 17. Current Verification\*\***







Step 5 verification completed:







\\\`\\\`\\\`text







pnpm --filter @fluxora/infrastructure typecheck ✅







pnpm --filter @fluxora/infrastructure test       ✅







pnpm typecheck                                   ✅







\\\`\\\`\\\`







Step 6 verification completed:







\\\`\\\`\\\`text







pnpm --filter @fluxora/db typecheck       ✅







pnpm --filter @fluxora/workers typecheck  ✅







pnpm typecheck                            ✅







\\\`\\\`\\\`







Step 6 runtime verification also completed for:







\\\`\\\`\\\`text







basic claim                              ✅







lease expiry / reclaim                   ✅







completion ownership                     ✅







failure / retry / dead-letter            ✅







worker success integration               ✅







worker failure integration               ✅







idempotency within tenant                ✅







idempotency across tenants               ✅







\\\`\\\`\\\`







Step 5 production adapters and Step 6 production deployment behavior have not been exercised against live production infrastructure locally.







Step 7 verification completed:







\\\`\\\`\\\`text







pnpm --filter @fluxora/observability typecheck ✅







pnpm --filter @fluxora/api typecheck            ✅







pnpm --filter @fluxora/workers typecheck       ✅







pnpm typecheck                                  ✅







\\\`\\\`\\\`







Step 7 end-to-end telemetry verification completed with a local OpenTelemetry Collector:







\\\`\\\`\\\`text







Collector OTLP/HTTP receiver on :4318       ✅







Fluxora API startup with OTel               ✅







Dummy endpoint HTTP 200                     ✅







Traces received                             ✅







Metrics received                            ✅







Logs received                               ✅







service.name = @fluxora/api                 ✅







fluxora.telemetry.dummy span                ✅







fluxora.telemetry.dummy.request log         ✅







HTTP request duration metric                ✅







\\\`\\\`\\\`







The local Collector uses the debug exporter for verification. This proves the application-to-Collector telemetry path; a production observability backend is not required for this local acceptance test.







Step 8 local quality verification completed:







\\\`\\\`\\\`text







pnpm lint                                      ✅







pnpm typecheck                                 ✅







pnpm test                                      ✅







7 tests passed, 0 failed                      ✅







pnpm build                                     ✅







Next.js production build                       ✅







\\\`\\\`\\\`







The CI workflow was executed successfully on \\\`main\\\` for both the CI foundation commit and the hosted-runtime commit:







\\\`\\\`\\\`text







CI #1 — 741de67 — passed ✅







CI #2 — 83b6602 — passed ✅







\\\`\\\`\\\`







The deployed frontend was manually smoke-tested on Vercel:







\\\`\\\`\\\`text







homepage renders                              ✅







/sign-in loads                                ✅







Continue with GitHub                          ✅







authenticated landing page                   ✅







/dashboard protected route                   ✅







\\\`\\\`\\\`







The API was prepared for a hosted runtime and verified locally with a Render-like \\\`PORT\\\`:







\\\`\\\`\\\`text







PORT=4100                                       ✅







server binds to 0.0.0.0                         ✅







GET /healthz                                   200 ✅







health response status = ok                    ✅







\\\`\\\`\\\`







Render deployment verification completed:







\\\`\\\`\\\`text







Render service: fluxora-api                   ✅ LIVE







Branch: main                                   ✅







Plan: Free                                     ✅







Region: Singapore                              ✅







Health check: /healthz                         ✅







Auto-deploy: On Commit                         ✅







Hosted PostgreSQL                              ✅







Production environment variables configured   ✅







Hosted /healthz request verified               ✅







\\\`\\\`\\\`







The hosted \\\`/healthz\\\` endpoint performs \\\`SELECT 1\\\`, so the successful response verified both API reachability and API-to-hosted-PostgreSQL connectivity.







Step 8 therefore meets the current implementation acceptance criteria for the CI/CD foundation and hosted frontend/API baseline. Full staging promotion, automated E2E gates, production smoke-test automation, and rollback orchestration remain future hardening work rather than claims of completion in Step 8.







**\*\*## 17.1 Step 9 Verification\*\***







Step 9 local-development verification completed after the reset/seed lifecycle bug was fixed:







\\\`\\\`\\\`text



pnpm db:migrate       ✅ No pending migrations



pnpm db:seed          ✅



pnpm db:seed          ✅ Idempotent / same logical local identity



pnpm db:reset         ✅



pnpm db:seed          ✅ Reset/reseed restored known state



pnpm typecheck        ✅



pnpm lint             ✅



pnpm test             ✅ 7 passed, 0 failed



pnpm build            ✅



\\\`\\\`\\\`







The acceptance test is intentionally broader than typechecking because the Step 9 failure was behavioral rather than type-level: the original implementation was valid TypeScript but had an unintended top-level module side effect during CLI import.







\*\*## 17.2 Step 10 Verification



Step 10 local verification completed after the GitHub App implementation, browser Clerk-token handoff, scoped CORS support, and the associated fixes were completed:



\`\`\`text



pnpm db:migrate       ✅ Applied migration 0008_github_installations.sql



pnpm typecheck        ✅



pnpm lint             ✅



pnpm test             ✅ 30 passed, 0 failed



pnpm build            ✅



\`\`\`



The build output includes:



\`\`\`text



/github/setup        ✅



\`\`\`



Focused Step 10 coverage includes:



\`\`\`text



Web GitHub setup/browser-token tests        ✅

DB installation planning tests              ✅ 4 passed

API GitHub/JWT/security/CORS tests          ✅ 15 passed

Infrastructure existing tests               ✅ 7 passed

\`\`\`



Step 10 is locally verified but is not yet marked fully production-complete. One live hosted smoke test remains:



\`\`\`text



Vercel dashboard

    ↓

GitHub App installation on anu-priya-1999/fluxora

    ↓

/github/setup?installation_id=...&setup_action=install

    ↓

browser Clerk useAuth().getToken()

    ↓

OPTIONS preflight + POST to Render API

    ↓

Clerk verification

    ↓

GitHub installation verification

    ↓

Render PostgreSQL persistence



\`\`\`



The production acceptance test must confirm that the exact Vercel origin is present in the API's \`CLERK_AUTHORIZED_PARTIES\`, CORS allows that origin only, and the installation row is created or replayed idempotently in the hosted PostgreSQL database.



\*\*## 17.3 Step 11 Verification



Step 11 local verification of the Repository / RepositorySnapshot / Commit data model:



\`\`\`text



pnpm db:migrate       ✅ Applied 0010_grant_bootstrap_function_execute.sql and 0011_repositories_snapshots_commits.sql



pnpm typecheck        ✅



pnpm lint             ✅



pnpm test             ✅ 46 passed, 0 failed



pnpm build            ✅



\`\`\`



Local PostgreSQL catalog check confirmed \`repositories\`, \`repository_snapshots\`, and \`commits\` exist with FORCE RLS, expected uniques/FKs/indexes, no \`organization_id\` on child tables, and no UPDATE policy on snapshots or commits.



Focused Step 11 coverage includes:



\`\`\`text



Static 0011 migration contract tests                 ✅

Repository validation unit tests                    ✅

PostgreSQL repository / snapshot / commit / RLS     ✅ (via non-bypass fluxora_rls_test role)



\`\`\`



Step 11 does not ingest repositories. Step 12 is the \`repository.ingest\` worker: load tenant repository and GitHub installation, mint a short-lived installation token, fetch the tree at a ref, and materialize it into an isolated working directory. Object-storage upload, final \`RepositorySnapshot\` persistence, \`POST /api/v1/repositories/connect\`, and WebSocket progress remain Step 13+.



\*\*## 17.4 Step 12 Verification



Step 12 local verification of the repository ingestion worker:



\`\`\`text



pnpm typecheck        ✅



pnpm lint             ✅



pnpm test             ✅ 66 passed, 0 failed (20 of them Step 12 worker tests)



pnpm build            ✅



\`\`\`



Focused Step 12 coverage includes:



\`\`\`text



repository.ingest payload and handler registration   ✅

mocked GitHub token, ref, tarball ingest             ✅

tenant mismatch, needs_reauth, rate-limit, invalid ref ✅

archive path traversal, symlink, size limits, cleanup ✅

JobWorker permanent vs retryable failure             ✅



\`\`\`



Step 12 does not upload snapshots or add a connect API. Those remain Step 13+.



**## 17.5 Step 13 Verification



Step 13 local verification of deterministic snapshot packaging, object-storage persistence, and immutable snapshot metadata:



\`\`\`text



pnpm --filter @fluxora/workers test   ✅ 24 passed, 0 failed



pnpm typecheck                        ✅



pnpm lint                             ✅



pnpm test                             ✅



\`\`\`



Focused Step 13 coverage includes:



\`\`\`text



deterministic snapshot checksum/file contents        ✅
compressed archive-size enforcement + cleanup        ✅
filesystem/S3 storage configuration                  ✅
immutable RepositorySnapshot persistence             ✅
idempotent re-ingestion                              ✅
partial object cleanup on DB persistence failure    ✅



\`\`\`



The final Step 13 artifact is one deterministic \`snapshot.tar.gz\` in object storage plus immutable \`RepositorySnapshot\` metadata in PostgreSQL. The temporary extracted repository remains ephemeral and is cleaned up after processing.




**## 18. Job Architecture — Implemented\*\***







The MVP uses a PostgreSQL-backed job queue and transactional outbox-compatible worker foundation.







Jobs are:







\\- idempotent







\\- retryable







\\- observable







\\- tenant-aware







Every job carries organization context.







Implemented queue capabilities:







\\\`\\\`\\\`text







enqueue







claim







complete







fail







retry







dead-letter







idempotency enforcement







lease-based crash recovery







\\\`\\\`\\\`







The MVP claim mechanism uses PostgreSQL row locking with:







\\\`\\\`\\\`sql







SELECT ... FOR UPDATE SKIP LOCKED







\\\`\\\`\\\`







Worker crashes allow jobs to become claimable again after lease expiry.







Repeated failures eventually route to \\\`dead_letter\\\` rather than retrying forever.







The worker harness dispatches jobs through a typed handler registry and handles success, retryable failure, and dead-letter transitions.







**\*\*## 19. Current Next Implementation Target\*\***







**\*\*### Phase 1 — Step 9 — COMPLETE\*\***







Step 9 established the repeatable local-development foundation.







Implemented:







\\- Docker Compose local-infrastructure recipe for PostgreSQL, Redis, MinIO, and MinIO bucket initialization



\\- deterministic local seed command



\\- guarded destructive reset command



\\- shared environment-loading/local-database validation helper



\\- root-level \\\`db:migrate\\\`, \\\`db:seed\\\`, and \\\`db:reset\\\` scripts







Current low-RAM development mode remains:







\\\`\\\`\\\`text



PostgreSQL → native PostgreSQL 18.6



Redis → in-memory adapter



Object storage → filesystem adapter



API/workers/web → native Node processes



Docker Desktop → not required



\\\`\\\`\\\`







Compose remains the reproducible multi-service environment definition for stronger machines and CI.







Step 9 verification completed:







\\\`\\\`\\\`text



pnpm db:migrate       ✅



pnpm db:seed          ✅



pnpm db:seed          ✅



pnpm db:reset         ✅



pnpm db:seed          ✅



pnpm typecheck        ✅



pnpm lint             ✅



pnpm test             ✅



pnpm build            ✅



\\\`\\\`\\\`







The seed was verified as idempotent because repeated seeding returned the same logical local organization/user.







The reset path initially exposed a PostgreSQL pool lifecycle bug caused by \\\`seed.ts\\\` executing a top-level CLI \\\`main()\\\` when the module was imported by \\\`reset.ts\\\`. The reusable seed logic was separated from direct CLI execution so importing \\\`seed.ts\\\` no longer starts its CLI entrypoint. Reset/reseed then passed cleanly, and the full quality gate was rerun successfully.







\*\*### Post-Step-9 target



The planned AWS production infrastructure migration is intentionally deferred until the core Fluxora implementation is substantially complete. This keeps the current development loop fast and avoids consuming production infrastructure resources before the later production-alignment point.



Step 10 is the GitHub App installation and setup flow. Repository ingestion, snapshots, workers, and webhooks remain later roadmap work.



The next engineering activity is the next canonical Phase 2 roadmap step. AWS production migration is a later deployment-alignment activity, not a prerequisite for continuing the implementation roadmap.



Step 11 adds the \`Repository\`, \`RepositorySnapshot\`, and \`Commit\` tables and tenant-safe data-access modules only. GitHub repository fetching, installation access tokens, and the ingestion worker are Step 12. S3 upload, \`POST /api/v1/repositories/connect\`, and WebSocket progress remain Step 13+.



Step 9 does not introduce a new SQL migration because it does not change database schema; it adds local environment/bootstrap and data-lifecycle tooling.



### Current Phase 2 status



The implementation through Step 13 is now:



\`\`\`text



Step 10 — GitHub App installation + setup flow        IMPLEMENTED

Step 11 — Repository, RepositorySnapshot, Commit      IMPLEMENTED

Step 12 — Repository ingestion worker                 IMPLEMENTED

Step 13 — Repository snapshot storage                 ✅ COMPLETE

Step 14 — Repository connect API/orchestration        ✅ COMPLETE

\`\`\`



Step 13 is verified. The next global implementation target is **Step 14 — repository connect API/orchestration**. AWS production migration remains a later deployment-alignment activity and is not a prerequisite for continuing the roadmap.




**## 20. Security Model\*\***







Repository source code is sensitive and potentially adversarial.







Rules:







\\- never execute customer repository code during static analysis







\\- never treat repository content as trusted instructions







\\- treat repository content reaching the AI layer as untrusted data







\\- never commit secrets







\\- never log secrets







\\- never persist secrets in source files







\\- enforce tenant isolation at multiple layers







Tenant isolation includes:







\\\`\\\`\\\`text







application authorization







        +







PostgreSQL RLS







        +







tenant-scoped jobs







        +







tenant-scoped object-storage paths







        +







tenant-scoped Redis keys







\\\`\\\`\\\`







\\---







**\*\*## 21. Observability — Implemented\*\***







OpenTelemetry is now part of the Phase 1 foundation.







Implemented architecture:







\\\`\\\`\\\`text







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







\\\`\\\`\\\`







Implemented components include:







\\- shared \\\`@fluxora/observability\\\` package







\\- OTLP trace exporter







\\- OTLP metric exporter







\\- OTLP log exporter







\\- OpenTelemetry HTTP instrumentation







\\- API bootstrap-time telemetry initialization







\\- worker job-processing spans







\\- dummy telemetry endpoint







\\- local Collector configuration for verification







Verified API telemetry includes:







\\\`\\\`\\\`text







fluxora.telemetry.dummy







fluxora.telemetry.dummy.request







http.server.request.duration







\\\`\\\`\\\`







Verified service resource identity:







\\\`\\\`\\\`text







service.name = @fluxora/api







service.version = 0.0.0







deployment.environment.name = development







\\\`\\\`\\\`







Target production observability areas remain:







\\- API latency







\\- ingestion latency







\\- analysis duration







\\- graph size







\\- AI cost/token usage







\\- job failure rate







\\- queue backlog







\\---







**\*\*## 22. CI/CD — Implemented Foundation\*\***







Step 8 established a working CI/CD and hosted-deployment foundation.







**\*\*### 22.1 Continuous Integration\*\***







GitHub Actions workflow:







\\\`\\\`\\\`text







.github/workflows/ci.yml







\\\`\\\`\\\`







Triggers:







\\\`\\\`\\\`yaml







on:







  pull_request:







  push:







    branches: [main]







\\\`\\\`\\\`







Current quality-gate sequence:







\\\`\\\`\\\`text







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







\\\`\\\`\\\`







The CI workflow is intentionally repository-root based because Fluxora is a pnpm workspace and the API/frontend depend on internal workspace packages.







The workflow uses:







\\\`\\\`\\\`text







pnpm/action-setup\\@v4







setup-node\\@v7







\\\`\\\`\\\`







with dependency caching through pnpm.







**\*\*### 22.2 Frontend delivery\*\***







\\\`\\\`\\\`text







GitHub main







   ↓







Vercel







   ↓







apps/web







\\\`\\\`\\\`







The Vercel project uses \\\`apps/web\\\` as its project root. Clerk environment variables are configured in Vercel for the hosted web application.







Hosted smoke verification established that authentication and the protected dashboard work on the deployed frontend.







**\*\*### 22.3 API delivery\*\***







\\\`\\\`\\\`text







GitHub main







   ↓







Render Web Service







   ↓







apps/api







\\\`\\\`\\\`







Current Render configuration:







\\\`\\\`\\\`text







service: fluxora-api







branch: main







runtime: Node







root directory: repository root







region: Singapore







plan: Free







auto-deploy: On Commit







health check: /healthz







\\\`\\\`\\\`







The API intentionally does not have a \\\`build\\\` script in \\\`apps/api/package.json\\\`. It currently executes TypeScript directly with Node's native strip-types runtime.







Therefore the hosted build command is:







\\\`\\\`\\\`text







pnpm install --frozen-lockfile && pnpm db\\\\:migrate && pnpm --filter @fluxora/api typecheck







\\\`\\\`\\\`







and the start command is:







\\\`\\\`\\\`text







pnpm --filter @fluxora/api start







\\\`\\\`\\\`







This keeps database migration, type validation, and runtime startup explicit instead of inventing a compiled \\\`dist/\\\` build that the API does not currently use.







**\*\*### 22.4 Runtime and health model\*\***







The API reads \\\`PORT\\\` with fallback to the local \\\`API_PORT\\\` default and binds to:







\\\`\\\`\\\`text







0.0.0.0







\\\`\\\`\\\`







This is required for the hosted service to receive traffic.







The \\\`/healthz\\\` route is intentionally unauthenticated and performs:







\\\`\\\`\\\`sql







SELECT 1







\\\`\\\`\\\`







before returning:







\\\`\\\`\\\`json







{







  "status": "ok",







  "service": "fluxora-api"







}







\\\`\\\`\\\`







This makes the health check an application-level readiness check rather than a process-only check.







\*\*### 22.5 Production configuration boundary



Local and hosted runtime configuration remain separate:



\`\`\`text



local .env



NODE_ENV=development



Render environment



NODE_ENV=production



\`\`\`



Hosted secrets/configuration are stored in Render environment variables rather than committed to Git.



Current API runtime variables include:



\`\`\`text



DATABASE_URL



CLERK_SECRET_KEY



CLERK_AUTHORIZED_PARTIES



NODE_ENV



\`\`\`



Step 10 adds GitHub App settings. The API host (Render) receives the App id and private key. The web host (Vercel) receives the public App slug, the API origin, and the web origin. Installation ids are not environment variables.



\`\`\`text



GITHUB_APP_ID



GITHUB_APP_PRIVATE_KEY



GITHUB_APP_SLUG



FLUXORA_API_URL



NEXT_PUBLIC_APP_URL



\`\`\`



Current hosted split during Step 10 is:



\`\`\`text



Vercel web

https\://fluxora-rho-cyan.vercel.app



Render API

https\://fluxora-api-6rrz.onrender.com



Render PostgreSQL

hosted database used by the Render API



\`\`\`



Vercel Production web variables are:



\`\`\`text



GITHUB_APP_SLUG=fluxora-software-intelligence



FLUXORA_API_URL=https\://fluxora-api-6rrz.onrender.com



NEXT_PUBLIC_APP_URL=https\://fluxora-rho-cyan.vercel.app



\`\`\`



Render API variables include:



\`\`\`text



DATABASE_URL=\<Render internal PostgreSQL URL>



GITHUB_APP_ID=\<GitHub App ID>



GITHUB_APP_PRIVATE_KEY=\<GitHub App private key>



GITHUB_APP_SLUG=fluxora-software-intelligence



CLERK_AUTHORIZED_PARTIES=https\://fluxora-rho-cyan.vercel.app



\`\`\`



\`CLERK_AUTHORIZED_PARTIES\` is used both by Clerk's \`authorizedParties\` check and by the scoped CORS allowlist for the browser-called GitHub installation endpoint. The exact Vercel origin is required; \`\*\` is not used.



The GitHub App private key is never configured on Vercel.



\`PORT\` is provided by the hosted runtime and is not hard-coded as a production constant.



**### 22.6 Database delivery\*\***







The hosted API uses a hosted PostgreSQL instance rather than the developer's local PostgreSQL at \\\`localhost:5432\\\`.







The local database remains:







\\\`\\\`\\\`text







localhost:5432/fluxora_dev







\\\`\\\`\\\`







The hosted deployment uses the hosted database connection URL through \\\`DATABASE_URL\\\`.







This separation is deliberate:







\\\`\\\`\\\`text







local machine







    ↓







local PostgreSQL







Render







    ↓







hosted PostgreSQL







\\\`\\\`\\\`







A local \\\`localhost\\\` database must not be treated as a production database endpoint.







**\*\*### 22.7 Deployment behavior\*\***







The current Step 8 baseline is:







\\\`\\\`\\\`text







commit to main







     ↓







GitHub Actions quality gates







     ↓







Vercel / Render deployment mechanisms







     ↓







health / smoke verification







\\\`\\\`\\\`







This is a real deployment foundation, but it is not yet the final enterprise promotion system.







Future hardening can add:







\\\`\\\`\\\`text







PR preview E2E gates







staging environment







manual promotion







production smoke tests







automated rollback policy







migration safety gates







worker deployment pipeline







\\\`\\\`\\\`







Those are explicitly future work unless implemented by a later roadmap step.







**\*\*## 23. Learning-First Development\*\***







Fluxora is also a learning and interview project.







The developer should understand:







\\- why the architecture is structured this way







\\- why each storage decision was made







\\- how graph traversal works







\\- how evidence is generated







\\- how idempotency works







\\- how worker failures are handled







\\- how AI is prevented from becoming the source of truth







\\- how trade-offs change at larger scale







Learning notes are maintained separately from the canonical architecture.







The Step 9 learning package includes:







\\\`\\\`\\\`text



learning/notes/8. Personal Learning - Step 9.md



learning/phase-01/step-09-local-dev-compose-seed.md



interviews/2. Step 9 Interview CheatSheet.md



\\\`\\\`\\\`







The Step 10 learning package includes:







\\\`\\\`\\\`text



learning/9. Github App Installation.md



learning/phase-02/step-10-github-app-installation.md



interviews/3. Github App Installation Interview CheatSheet.md



\\\`\\\`\\\`







The Step 11 learning package includes:







\\\`\\\`\\\`text



learning/10. Repository Snapshot Commit Data Model.md



learning/phase-02/step-11-repository-snapshot-commit.md



learning/interviews/4. Step 11 Repository Snapshot Commit Interview CheatSheet.md



\\\`\\\`\\\`







The Step 12 learning package includes:







\\\`\\\`\\\`text



learning/notes/11. Repository Ingestion Worker.md



learning/implementations/phase-02/step-12-repository-ingestion.md



learning/interviews/5. Step 12 Repository Ingestion Worker Interview CheatSheet.md



\\\`\\\`\\\`



The Step 13 learning package includes:



\`\`\`text



learning/notes/12. Repository Snapshot Storage.md



learning/implementations/phase-02/step-13-repository-snapshot-storage.md



learning/interviews/6. Step 13 Repository Snapshot Storage Interview CheatSheet.md



\`\`\`



The master interview guide covering every completed global step through Step 13 is:



\`\`\`text



learning/interviews/0. Fluxora Steps 1-13 Master Interview Guide.md



\`\`\`








The personal learning note covers repeatable local development, migration-vs-seed boundaries, idempotency, reset safety, ES module evaluation, top-level calls, CLI/library separation, PostgreSQL pool ownership, and the debugging incident found during reset verification.







Current private learning structure:







\\\`\\\`\\\`text







learning/







├── concepts/







├── decisions/







├── interviews/







│   └── 4. Step 11 Repository Snapshot Commit Interview CheatSheet.md







│   └── 5. Step 12 Repository Ingestion Worker Interview CheatSheet.md







├── notes/







│   ├── 1. Monorepo & Foundation.md







│   ├── 2. Backend Foundation.md







│   ├── 3. PostgreSQL & DB.md







│   ├── 4. Infrastructure Foundation.md







\\|   ├── 5. PostgreSQL Job Queue, Distributed Workers & Failure&#x20;







\\|   |      Handling







│   ├── 6. OpenTelemetry Observability.md







│   ├── 7. CI-CD and Production Deployment.md



│   └── 8. Personal Learning - Step 9.md







├── 9. Github App Installation.md



├── 10. Repository Snapshot Commit Data Model.md







├── notes/11. Repository Ingestion Worker.md



├── notes/12. Repository Snapshot Storage.md







├── implementations/phase-02/step-12-repository-ingestion.md







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







    ├── step-10-github-app-installation.md



    └── step-11-repository-snapshot-commit.md







\\\`\\\`\\\`







\\---







**\*\*## 24. Prompt Workflow\*\***







\\\`prompts/\\\` is a private prompt library.







It may contain:







\\- Cursor implementation prompts







\\- debugging prompts







\\- architecture prompts







\\- review prompts







Cursor is an implementation aid, not the architectural owner.







For routine fixes, verification, or straightforward coding, prefer direct implementation rather than spending Cursor tokens unnecessarily.







\\---







**\*\*## 25. Cursor Operating Model\*\***







For meaningful implementation tasks:







1\\\\. Inspect the current repository.







2\\\\. Read the relevant canonical architecture documents.







3\\\\. Plan the smallest coherent change.







4\\\\. Implement.







5\\\\. Verify with appropriate tests/typecheck/build/lint.







6\\\\. Review for unintended changes and architecture violations.







7\\\\. Record the actual result.







Never claim verification that was not actually run.







\\---







**\*\*## 26. Scope Discipline\*\***







When uncertain:







1\\\\. Prefer the canonical architecture package.







2\\\\. Prefer the smallest coherent change.







3\\\\. Prefer deterministic behavior.







4\\\\. Prefer explicit evidence.







5\\\\. Prefer simple infrastructure at MVP scale.







6\\\\. Do not invent requirements.







7\\\\. Do not silently expand scope.







8\\\\. Do not hide uncertainty.







9\\\\. Do not claim tests passed unless they actually passed.







\\---







**\*\*## 27. Step 10 — GitHub App Installation\*\***







Step 10 connects a GitHub App installation to the signed-in Fluxora organization. It does not ingest repositories.







**\*\*### Responsibility split\*\***







Clerk authenticates the person and exposes the GitHub account id from the linked external account.







The GitHub App is a separate credential. Its App ID and private key prove that Fluxora is that App. They do not identify the user.







The installation id identifies one install of that App on one GitHub account. It arrives on the Setup URL query string. It is never hard-coded and it is not an environment variable.







\*\*### Request path



\`\`\`text



Dashboard "Connect GitHub"

        ↓

https\://github.com/apps/{slug}/installations/new

        ↓

GitHub redirects the browser to /github/setup?installation_id=...&setup_action=install|update

        ↓

Next.js server checks Clerk session + validates installation_id/setup_action

        ↓

Client component calls Clerk useAuth().getToken()

        ↓

Browser OPTIONS preflight when Vercel and API are cross-origin

        ↓

Browser POST /api/v1/github/installations

        ↓

Authorization: Bearer \<Clerk session token>

        ↓

API verifies Clerk JWT + linked GitHub providerUserId

        ↓

App JWT (RS256, iss = App ID) → GET /app/installations/{id}

        ↓

account.id must equal the Clerk GitHub user id, and account.type must be User

        ↓

github_installations row under the caller's organization, with RLS



\`\`\`



\`github_installation_id\` is accepted only as a decimal string. A JSON number is rejected so the id is not rounded through \`Number\` before it is stored in PostgreSQL \`bigint\`. Responses keep the same ids as strings. The SQL casts those strings with \`::bigint\` and reads them back with \`::text\`.



**### Persistence and idempotency\*\***







\\\`github_installations\\\` has one row per organization and a globally unique \\\`github_installation_id\\\`. Repeating the same completion returns the existing row with \\\`created: false\\\`. A later install for the same GitHub account refreshes the installation id. A different GitHub account is rejected. Installation access tokens are not created or stored.







RLS policies match the existing tenant tables: \\\`organization_id = fluxora_current_org_id()\\\`, with \\\`ENABLE\\\` and \\\`FORCE ROW LEVEL SECURITY\\\`. Because RLS hides another tenant's row, the global unique index is what stops a second organization from claiming the same installation. A unique violation aborts the current PostgreSQL transaction, so the write runs inside a savepoint, rolls back to that savepoint, and then re-reads the caller's row.







\\\`TRUNCATE organizations CASCADE\\\` in the local reset already removes these rows through the foreign key. No seed installation is created.







**\*\*### Security choices\*\***







The dashboard link only contains the public App slug. The Next.js process loads \\\`GITHUB_APP_SLUG\\\` and \\\`FLUXORA_API_URL\\\` from the environment and does not load the private key. The API signs the JWT and calls GitHub. Logs pass through redaction for PEM blocks, bearer tokens, and JWTs.







The Setup URL is a GET because that is how GitHub redirects the browser. Completion is safe to repeat. The browser session is not trusted to pick an arbitrary installation: the API fetches the installation with the App JWT and requires the installation account to be the same personal GitHub user Clerk already linked. An organization installation is rejected in this step because its account id is the org id, and the App JWT alone does not prove the signed-in user administers that org.







Only organization owners and admins can complete installation.







The web server posts the Clerk session token only to a \\\`FLUXORA_API_URL\\\` that is https, or http on localhost, and that URL must not contain credentials.







**\*\*### Verification status\*\***







Step 10 code and focused tests were added. \\\`pnpm typecheck\\\`, \\\`pnpm lint\\\`, \\\`pnpm test\\\`, \\\`pnpm build\\\`, and \\\`pnpm db:migrate\\\` were not run as part of this change.







**\*\*## 28. Step 11 — Repository, RepositorySnapshot, and Commit\*\***







Step 11 adds the tenant-owned repository metadata model. It does not ingest repository contents.







A \\\`Repository\\\` belongs to an \\\`Organization\\\`. \\\`github_repo_id\\\` is unique per organization so two Fluxora tenants may connect the same public GitHub repository. \\\`connection_status\\\` is \\\`pending | active | needs_reauth | error\\\`.







\\\`RepositorySnapshot\\\` and \\\`Commit\\\` belong to \\\`Repository\\\`. They do not duplicate \\\`organization_id\\\`. Tenant access is enforced by RLS that exists through the parent repository (\\\`fluxora_repository_in_current_tenant\\\`).







A snapshot is not a commit. A commit is git object metadata (sha, author, message, parents). A snapshot is an immutable packaged tree for one commit (\\\`commit_sha\\\`, \\\`ref\\\`, \\\`storage_uri\\\`, file/size stats). File bytes are not stored in PostgreSQL; \\\`storage_uri\\\` is the later object-storage pointer.



Step 13 now materializes that pointer by packaging the extracted repository tree as \\\`snapshot.tar.gz\\\`, storing the archive in object storage, and persisting the final immutable snapshot metadata.







Snapshots are insert-only: unique \\\`(repository_id, commit_sha)\\\`, no UPDATE RLS policy under FORCE RLS, identical replay returns the existing row, a different payload is rejected. Commits are similarly unique on \\\`(repository_id, sha)\\\` and have no UPDATE policy.







Foreign keys use \\\`ON DELETE CASCADE\\\`. Foreign keys do not replace RLS: PostgreSQL FK checks bypass RLS, so child INSERT policies still require the parent repository to be in the current tenant.







Data access lives in \\\`packages/db\\\` (\\\`repository.ts\\\`, \\\`repository-snapshot.ts\\\`, \\\`commit.ts\\\`) using existing \\\`withTenant\\\` session configuration. Local integration tests set \\\`FLUXORA_DATABASE_ROLE=fluxora_rls_test\\\` so \\\`withTenant\\\` runs \\\`SET LOCAL ROLE\\\` as a \\\`NOBYPASSRLS\\\` role; a local superuser would otherwise bypass FORCE RLS. Step 10 GitHub installation code is unchanged.







**\*\*## 29. Step 12 — Repository Ingestion Worker\*\***







Step 12 implements the \\\`repository.ingest\\\` job handler on the existing PostgreSQL job queue and \\\`JobWorker\\\`. It does not add a new queue, object storage upload, snapshot persistence, or a connect API.







The payload is \\\`{ repositoryId, ref, commitSha? }\\\`. \\\`organization_id\\\` stays on the Job. The worker loads the repository with that tenant id before any GitHub call. \\\`commitSha\\\` is optional and is resolved from GitHub for \\\`ref\\\`; when supplied it must match the resolved SHA. Idempotency uses the existing jobs unique \\\`(organization_id, idempotency_key)\\\` with key \\\`repository.ingest:{repositoryId}:{commitSha}\\\`. Retry re-fetches into a new temp directory and does not insert snapshot rows.







GitHub App authentication reuses the Step 10 installation row. The worker mints a GitHub App JWT, then a short-lived installation access token for that operation only. Tokens are not stored. Clerk session tokens are not used. Archive download follows GitHub's tarball redirect without forwarding the installation token to \\\`codeload.github.com\\\`.







Contents are extracted into \\\`os.tmpdir()/fluxora-ingest-\*\\\`. Extraction is bounded (file count, uncompressed bytes, compressed bytes, wall-clock timeout). Path traversal, absolute paths, symlinks, hard links, and device files are permanent security failures. Repository files are never executed, evaluated, or imported.







Failure classification:







\\- GitHub 401/403 (non-rate-limit) or missing installation → \\\`connection_status = needs_reauth\\\`, permanent job failure (no \\\`retryFailedJob\\\`)







\\- rate limit / 5xx / network → retryable via existing \\\`failJob\\\` + \\\`retryFailedJob\\\`







\\- invalid ref / commitSha mismatch / too large / unsafe archive → \\\`connection_status = error\\\`, permanent







\\- unexpected errors → existing JobWorker retry path







Successful Step 12 materialization sets \\\`connection_status = active\\\`. \\\`last_indexed_at\\\` is unchanged. The in-memory result (\\\`workDir\\\`, \\\`commitSha\\\`, file/size stats) is what Step 13 will upload; the handler deletes the temp directory in \\\`finally\\\`.







The worker process entrypoint is \\\`apps/workers/src/run.ts\\\` (\\\`pnpm --filter @fluxora/workers start\\\`). No new deployment topology was added.



Step 13 consumes the successful materialization result and turns it into a durable snapshot. The worker packages the `workDir` deterministically, computes SHA-256, uploads `snapshot.tar.gz` through the object-storage abstraction, persists the immutable `RepositorySnapshot` metadata, and cleans up temporary artifacts. No new queue or retry mechanism is introduced.




---

**\*\*## 30. Step 13 — Repository Snapshot Storage\*\***



Step 13 is the durability boundary between repository ingestion and later code intelligence.



### Purpose



Step 12 produces a temporary extracted repository tree. Step 13 freezes that tree into a reproducible, immutable repository snapshot.



\`\`\`text



Step 12

GitHub

  ↓

safe extraction

  ↓

temporary workDir



Step 13

workDir

  ↓

deterministic packaging

  ↓

snapshot.tar.gz

  ↓

SHA-256

  ↓

object storage

  ↓

RepositorySnapshot metadata in PostgreSQL

  ↓

cleanup



\`\`\`



### Snapshot representation



The current implementation stores **one deterministic \`snapshot.tar.gz\` archive**, not one object per source file.



The archive contains the repository tree. Object storage contains those bytes.



PostgreSQL stores:



\`\`\`text



id

repositoryId

commitSha

ref

storageUri

sha256

fileCount

sizeBytes

createdAt



\`\`\`



### Deterministic packaging



The packaging path:



\- walks the extracted work directory;



\- skips symbolic links;



\- sorts normalized relative paths;



\- enforces file-count limits;



\- creates a portable tar stream;



\- gzip-compresses the stream;



\- normalizes gzip header metadata;



\- enforces the compressed archive-size limit;



\- writes \`snapshot.tar.gz\`;



\- calculates SHA-256 over the exact final archive bytes.



For identical repository contents, the goal is identical snapshot bytes and therefore an identical checksum.



### Object storage boundary



Step 13 reuses the existing object-storage abstraction.



\`\`\`text



Local

  ↓

FilesystemObjectStorage



Production

  ↓

S3ObjectStorage



\`\`\`



The tenant-scoped object key is:



\`\`\`text



{organizationId}/{repositoryId}/{snapshotId}/snapshot.tar.gz



\`\`\`



The database stores the \`storageUri\`; it does not store the archive bytes.



### Immutability and idempotency



Snapshot identity remains governed by the existing \\\`(repository_id, commit_sha)\\\` uniqueness rule.



A successful replay must not replace the existing immutable snapshot object.



If a redundant object is uploaded during an idempotent replay path and the existing immutable row wins, the redundant object is cleaned up.



### Partial-failure handling



Object storage and PostgreSQL do not share one database transaction.



Therefore:



\`\`\`text



object upload succeeds

        ↓

database persistence fails

        ↓

delete uploaded object



\`\`\`



Packaging failures also remove partial archives.



The generated temporary archive is removed after persistence processing.



### Security and trust boundary



Repository content remains untrusted data.



Step 13 does not:

\- execute repository code;

\- import repository modules;

\- run package scripts;

\- invoke an LLM;



It only reads and packages the extracted tree.



Tenant isolation remains defense in depth:



\`\`\`text



Fluxora authorization

        +

tenant-scoped job

        +

PostgreSQL RLS

        +

tenant-scoped object key



\`\`\`



### Verification



Step 13 verification completed with:



\`\`\`text



pnpm --filter @fluxora/workers test   ✅ 24 passed, 0 failed

pnpm typecheck                        ✅

pnpm lint                             ✅

pnpm test                             ✅



\`\`\`



Focused packaging tests verify deterministic checksum/file contents and compressed-size enforcement with cleanup.



### Node 24 implementation lesson



The runtime test command uses Node 24's strip-only TypeScript execution.



Step 13 verification exposed:



\- TypeScript parameter-property syntax that strip-only mode does not transform;



\- an invalid \`pipeline()\` call caused by passing \`undefined\` as an extra stream/options argument.



The final implementation uses explicit class fields and conditional pipeline options.



### Scope boundary



Step 13 does **not** add:



\- \`POST /api/v1/repositories/connect\`;

\- WebSocket ingestion progress;

\- AST or symbol extraction;

\- dependency graph construction;

\- impact analysis;

\- AI reasoning.



Those belong to later roadmap steps.



### Learning and interview references



\`\`\`text



learning/notes/12. Repository Snapshot Storage.md

learning/implementations/phase-02/step-13-repository-snapshot-storage.md

learning/interviews/6. Step 13 Repository Snapshot Storage Interview CheatSheet.md

learning/interviews/0. Fluxora Steps 1-13 Master Interview Guide.md



\`\`\`



The next global implementation target is **Step 14 — repository connect API/orchestration**, which should enqueue the existing \`repository.ingest\` job rather than perform heavy ingestion synchronously.
---

**\*\*## 31. Step 14 — Repository Connect API and Orchestration\*\***

Step 14 adds the synchronous API boundary that starts repository ingestion without performing heavy ingestion inside the HTTP request.

### Endpoint

```text
POST /api/v1/repositories/connect
```

Request:

```json
{
  "github_installation_id": "12345678",
  "repo_full_name": "acme-corp/checkout-service",
  "branch": "main"
}
```

Accepted response:

```text
202 Accepted
```

with:

```json
{
  "repository_id": "...",
  "status": "pending",
  "job_id": "...",
  "ref": "main",
  "commit_sha": "..."
}
```

### Request/HTTP boundary

`apps/api/src/http/repositories.ts` is responsible for:

- request headers and content type;
- Clerk authentication;
- linked GitHub identity resolution;
- tenant/user loading;
- request-body reading;
- stable HTTP error mapping;
- returning the `202` response.

Pure request validation is separated into:

```text
apps/api/src/http/repository-request.ts
```

It owns:

- `REPOSITORY_CONNECT_PATH`;
- route recognition;
- `parseConnectBody`;
- `RequestValidationError`.

This prevents pure request-validation tests from importing the Clerk-dependent HTTP module.

### Repository orchestration

`apps/api/src/repositories/connect.ts` owns the repository connection workflow:

```text
authenticated organization
        ↓
stored GitHub installation
        ↓
installation-id ownership check
        ↓
GitHub repository metadata
        ↓
ref → commit SHA
        ↓
find/create Repository
        ↓
connectionStatus = pending
        ↓
repository.ingest job
```

A requested installation ID is never trusted solely because it arrived in the HTTP body. It must match the installation stored for the authenticated organization.

### GitHub repository client

`apps/api/src/github/repository-client.ts`:

1. creates a short-lived GitHub App JWT;
2. requests a short-lived installation access token;
3. fetches repository metadata;
4. resolves the requested ref to a full commit SHA;
5. classifies GitHub/network failures without exposing raw response bodies.

Repository IDs are preserved as canonical decimal strings so large GitHub IDs are not rounded by JavaScript number conversion before PostgreSQL persistence.

### Repository creation and race handling

Repositories are tenant-scoped by the existing database layer.

The flow is:

```text
get repository by organization + githubRepoId
        ↓
not found
        ↓
create repository
        ↓
unique race?
   ┌────┴────┐
   no        yes
   ↓          ↓
continue   re-read row
```

Existing repositories are reconciled to pending when their metadata or status needs updating before ingestion.

### Job enqueue and idempotency

Step 14 reuses the existing PostgreSQL job queue.

Job type:

```text
repository.ingest
```

Payload:

```json
{
  "repositoryId": "...",
  "ref": "main",
  "commitSha": "..."
}
```

Idempotency key:

```text
repository.ingest:{repositoryId}:{commitSha}
```

The endpoint therefore initiates ingestion for one specific repository state rather than for an unpinned moving branch.

### Error mapping

Stable API mappings include:

```text
github_app_not_configured  → 503
invalid_session            → 401
github_account_required    → 403
github_installation_required → 409
github_installation_mismatch → 403
repository_not_accessible  → 404
invalid_ref                → 422
github_reauth_required     → 409
github_rate_limited        → 503
github_app_misconfigured   → 503
github_unavailable         → 503
```

Raw GitHub error bodies are not returned to the client.

### Scope boundary

Step 14 does not:

- download the repository;
- safely extract GitHub archives;
- package snapshots;
- upload object storage;
- build AST/symbol graphs;
- calculate impact;
- invoke an LLM.

Those responsibilities remain in the asynchronous pipeline established by Steps 12 and 13.

### Commit status

```text
8bc047f feat: add repository connect API
```

Step 14 is complete. The next roadmap work should build on the accepted `repository.ingest` job and preserved repository/snapshot boundary rather than moving ingestion into the HTTP request.

---

**## 32. Step 15 - Repository Indexed Event and WebSocket Push**

Step 15 bridges the asynchronous worker ingestion pipeline with the real-time client experience using a durable outbox event and an authenticated WebSocket push endpoint.

### Event Definition & Outbox

When a repository ingestion run completes successfully (Step 12-14), the worker updates the connection status to `active` and durably emits the `repository.indexed` event:

```text
Event Type: repository.indexed
Schema Version: 1
Idempotency Key: repository.indexed:<repositoryId>:<commitSha>
```

#### Payload Shape
```json
{
  "repositoryId": "<uuid>",
  "snapshotId": "<uuid>",
  "commitSha": "<40-char-sha>",
  "ref": "refs/heads/main"
}
```

The event is persisted to the PostgreSQL `events` table with:
- Row-Level Security (RLS) scoped to `organization_id`;
- Unique constraint `(organization_id, idempotency_key)` preventing duplicate emissions on worker retries;
- PostgreSQL trigger `events_notify_trigger` executing `PERFORM pg_notify('fluxora_events', envelope_json)`.

### API WebSocket Gateway & Listener

`apps/api` listens on the database channel and manages client connections:
- Endpoint: `GET /api/v1/ws` (WebSocket Upgrade);
- Authentication: Clerk session tokens extracted from `Authorization` header, `?token=` query param, or `Sec-WebSocket-Protocol`;
- Connection Registry: `WebSocketHub` groups active connections by `organizationId`;
- Event Dispatch: PostgreSQL notifications on `fluxora_events` are parsed and dispatched strictly to connections belonging to the matching `organization_id`.

### Frontend Handling

The Next.js frontend (`apps/web`):
- Connects to `/api/v1/ws` using the Clerk session token;
- Parses and validates `repository.indexed` envelopes (`handleRepositoryIndexedMessage`);
- Updates the organization dashboard feed in real time.

### Scope Boundary

Step 15 does not:
- introduce Kafka, Redis Pub/Sub, or external message brokers;
- implement failure paths or retry policies (Step 16);
- emit graph or AST analysis events;
- invoke an LLM.

---

**## 33. Step 16 - Ingestion Failure-Path Hardening**

Step 16 hardens the asynchronous ingestion worker pipeline against GitHub API, network, file size, archive corruption, and storage failures by strictly differentiating between permanent failures and retryable transient failures, with bounded exponential backoff.

### Failure Classification & Repository State

1. **Permanent Failures (`retryable = false`)**:
   - **Revoked / Inaccessible GitHub Access**:
     - Codes: `github_auth`
     - Condition: GitHub HTTP 401/403, missing installation, or HTTP 404 on repository lookup.
     - Action: repository status transitioned to `needs_reauth`.
     - Queue: Job is marked `failed` or `dead_letter` without calling `retryFailedJob`.
   - **Invalid Ref**:
     - Code: `invalid_ref`
     - Condition: GitHub HTTP 404 on commit resolution, malformed commit SHA, or payload SHA mismatch.
     - Action: repository status transitioned to `error`.
     - Queue: Job is marked `failed` without calling `retryFailedJob`.
   - **Oversized Repository / Archive**:
     - Code: `repository_too_large`
     - Condition: declared `Content-Length` or actual stream exceeds `maxArchiveBytes`, uncompressed bytes exceed `maxTotalBytes`, or file count exceeds `maxFileCount`.
     - Action: repository status transitioned to `error`.
     - Queue: Job is marked `failed` without calling `retryFailedJob`.
   - **Unsafe Archive & Snapshot Conflict**:
     - Codes: `unsafe_archive`, `snapshot_conflict`
     - Condition: Path traversal (`..`), symlinks/hard links, corrupted headers, or attempted overwrite of immutable snapshot with divergent checksum/metadata.
     - Action: repository status transitioned to `error`.
     - Queue: Job is marked `failed` without calling `retryFailedJob`.

2. **Retryable Failures (`retryable = true`)**:
   - **GitHub Rate Limit**:
     - Code: `github_rate_limit` (HTTP 429 or HTTP 403 with `x-ratelimit-remaining: 0` or `retry-after`).
     - Action: Repository status remains unchanged (e.g. `pending`).
     - Queue: Enqueued for retry via `retryFailedJob`.
   - **Temporary GitHub Outage & Timeouts**:
     - Codes: `github_unavailable`, `timeout` (HTTP >= 500, network errors, fetch abort / execution timeouts).
     - Action: Repository status remains unchanged.
     - Queue: Enqueued for retry via `retryFailedJob`.
   - **Temporary Object Storage Failure**:
     - Code: `object_storage` (Transient S3/filesystem upload or persistence error).
     - Action: Repository status remains unchanged.
     - Queue: Enqueued for retry via `retryFailedJob`.

### Deterministic Exponential Backoff

When retrying failed jobs in `JobWorker`:
- Delay formula:
  $$\text{delay} = \min(\text{baseDelay} \times 2^{\text{attemptCount} - 1}, 300\text{ seconds})$$
- Default base of 5s yields:
  $$5\text{s} \to 10\text{s} \to 20\text{s} \to 40\text{s} \to 80\text{s} \to 160\text{s} \to 300\text{s}$$
- Bounded at 300 seconds (5 minutes).
- Respects existing `maxAttempts` and database dead-letter semantics.

### Scope Boundary

Step 16 does not:
- modify PostgreSQL schema or migrations;
- alter tenant isolation or RLS policies;
- alter Step 15 `repository.indexed` outbox event emission;
- implement AST parsing or symbol extraction (Phase 3);
- invoke an LLM.

---

**## 34. Step 17 - Golden Fixture Repository**

Step 17 establishes ONE real-world open-source repository as Fluxora's canonical golden fixture for deterministic testing, demo preparation, and manual verification across subsequent code-intelligence phases.

### Golden Repository Selection & Pinned Identity

- **Repository Full Name**: `shadcn-ui/taxonomy`
- **Repository URL**: `https://github.com/shadcn-ui/taxonomy`
- **Pinned Commit SHA**: `298a8857c7128a0d121e7f699dfd729f23b3966d`
- **Source Branch**: `refs/heads/main`
- **Fixture Identifier**: `golden-taxonomy-v1`
- **Description**: Open-source Next.js 13+ App Router, React Server Components, and TypeScript reference SaaS application.

### Selection Rationale

1. **Next.js & TypeScript Architecture**: Employs App Router file-based routing (`app/(auth)`, `app/(dashboard)`, `app/(marketing)`, `app/api`), React Server Components, Client Components, and route handlers.
2. **Realistic SaaS Complexity**: Includes Prisma ORM models (`prisma/schema.prisma`), NextAuth.js authentication, Stripe webhook handling, MDX documentation, and custom Tailwind components.
3. **TypeScript Configuration**: Defines `tsconfig.json` with path mapping (`@/*`) and barrel-file exports (`components/ui/*`).
4. **Moderate Size & Determinism**: Comprises 177 files totaling ~2.16 MB uncompressed (~1.15 MB tarball), fitting within Fluxora's ingestion limits (`100MB`) while enabling fast, offline test execution without requiring live GitHub network calls.
5. **Architectural Permanence**: As an archived open-source reference project, the pinned commit `298a8857c7128a0d121e7f699dfd729f23b3966d` will not experience branch movement or upstream history rewrites.

### Storage & Reproducibility

- The fixture source tree resides at `fixtures/golden/taxonomy/` accompanied by `fixtures/golden/manifest.json`.
- The manifest records repository metadata, framework characteristics, file sizes, and SHA-256 digests for every file.
- Excluded from the fixture: `node_modules`, `.next`, `.git`, build caches, and credentials.
- Tests verify fixture integrity, hash matching, and path traversal protection entirely offline.

### Product Scope Clarification

This golden fixture is an internal testing and benchmarking asset. Real Fluxora users will connect and analyze arbitrary GitHub repositories; the golden fixture does not restrict the product's runtime capabilities.

### Scope Boundary

Step 17 does not:
- implement language/framework detection algorithms (Step 18);
- integrate ts-morph or TypeScript Compiler API (Step 19);
- implement import/export dependency extraction (Step 20);
- implement route detection (Step 21);
- implement event pattern or DB-reference detection (Steps 22–23);
- implement tree-sitter or normalizers (Steps 24–25);
- build graph nodes, edges, or evidence rows;
- invoke an LLM.

---

**## 35. Step 18 - Language and Framework Detection**

Step 18 implements deterministic Language and Framework Detection (`docs/architecture/05-component-responsibilities.md §5.2`, `docs/architecture/17-implementation-roadmap.md §Phase 3 Step 1`).

### Purpose and Responsibilities

Given an immutable repository snapshot produced by Fluxora ingestion, the detector statically evaluates file paths, file extensions, and manifest contents to classify:
1. All programming, styling, and markup languages present in the repository (`TypeScript`, `JavaScript`, `JSON`, `CSS`, `HTML`, `Markdown`).
2. Frameworks and runtime tooling present (`Next.js`, `React`, `Node.js`).
3. Primary language and primary framework when determinable.
4. Structured provenance evidence explaining the detection rationale.

### Deterministic Architecture & Safe Invariant

- **Pure Static Analysis**: Operates over snapshot metadata and configuration file text. Does not execute repository code (`eval`, `import()`, or subprocesses) or make network requests.
- **No LLM in Core**: Fulfills Fluxora's invariant of a deterministic core and probabilistic AI edge. Classifications are reproducible and testable.
- **File Normalization**: Maps modern TypeScript/JavaScript dialects (`.mts`, `.cts`, `.tsx`, `.mjs`, `.cjs`, `.jsx`) to canonical language types.
- **Directory Exclusion**: Strictly filters out build outputs, dependencies, and caches (`node_modules`, `.git`, `.next`, `build`, `dist`, `out`, `.turbo`, `.cache`, `coverage`).
- **False-Positive Prevention**: Frameworks require verified package manifests (`package.json`), recognized config files (`next.config.mjs`), or standard project layout structures. Unrelated file names containing keywords do not trigger framework detections.

### Golden Fixture Verification

When evaluated against `shadcn-ui/taxonomy` (the canonical golden fixture), the detector produces:
- Primary Language: `TypeScript`
- Languages: `["CSS", "HTML", "JSON", "JavaScript", "Markdown", "TypeScript"]`
- Primary Framework: `Next.js`
- Frameworks: `["Next.js", "Node.js", "React"]`
- Evidence: Captured package dependencies for `next` and `react`, `next.config.mjs`, and App Router directory structures.

### Scope Boundary

Step 18 does not:
- perform AST parsing or symbol extraction (Step 19);
- integrate ts-morph or the TypeScript Compiler API;
- extract import/export dependency graphs (Step 20);
- detect API routes or Express routers (Step 21);
- detect event publishers or database queries (Steps 22–23);
- run tree-sitter or graph normalizers (Steps 24–25);
- persist GraphNode, GraphEdge, or Evidence database rows (Phase 4);
- invoke an LLM.

---

**## 36. Step 19 - Per-File Symbol Extraction**

Step 19 implements deterministic per-file symbol extraction (`docs/architecture/05-component-responsibilities.md §5.3`, `docs/architecture/17-implementation-roadmap.md §Phase 3 Step 2`).

### Purpose and Responsibilities

Given a repository snapshot, the symbol extractor deterministically discovers all code entities defined within each supported source file (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`):
1. **Functions**: Function declarations (`function foo() {}`) and variable-assigned functions / arrow functions (`const foo = () => {}`).
2. **Classes**: Class declarations (`class Foo {}`) and class expressions (`export default class {}`).
3. **Class Methods**: Methods within classes with parent relationship links (`Foo.bar`), accessibility, and modifiers.
4. **Interfaces**: TypeScript interface declarations (`interface User {}`).
5. **Type Aliases**: TypeScript type aliases (`type Result<T> = ...`).
6. **Enums**: Standard and const enums (`enum Status {}`).
7. **Variables**: Mutable variable declarations (`let`, `var`, and destructuring).
8. **Constants**: Constant declarations (`const` and destructuring bindings).
9. **Export Metadata**: Deterministic export markings (`isExported`, `isDefaultExport`, `exportName`) including separate export clauses (`export { foo }`).

### Deterministic Architecture & Safe Invariants

- **AST Static Analysis**: Employs the TypeScript Compiler API (`ts.createSourceFile`) to parse source files into ASTs without executing customer code.
- **Untrusted Input Guarantee**: Never dynamically imports or evaluates repository code.
- **Fault-Tolerant Parsing**: Syntax errors are captured as structured `RepositorySymbolDiagnostic` records rather than failing or crashing analysis runs.
- **Precise Source Locations**: Tracks 1-based line/column numbers alongside 0-based character offsets for deterministic evidence linking.
- **Strict Directory & File Filtering**: Honors standard ignored directories (`node_modules`, `.git`, `.next`, `build`, `dist`, `out`, `.turbo`, `.cache`, `coverage`) and skips non-code files.

### Scope Boundary

Step 19 does not:
- extract import/export dependency graphs (Step 20);
- resolve module targets or `tsconfig.json` path aliases (Step 20);
- detect Next.js API routes or Express routers (Step 21);
- detect event publishers/subscribers or ORM/database references (Steps 22–23);
- implement tree-sitter fallback parsers (Step 24);
- implement symbol normalizers or barrel-file collapses (Step 25);
- persist GraphNode, GraphEdge, or Evidence database rows (Phase 4);
- invoke an LLM.

---

**## 37. Step 20 - Import/Export Graph Extraction and TypeScript Path-Alias Resolution**

Step 20 implements deterministic import/export graph extraction and TypeScript path-alias resolution (`docs/architecture/05-component-responsibilities.md §5.3`, `docs/architecture/17-implementation-roadmap.md §Phase 3 Step 3`).

### Purpose and Responsibilities

Given an immutable repository snapshot, the module graph extractor deterministically traces inter-module connections across all supported TypeScript/JavaScript source files (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`):
1. **Named Imports**: Extracts named import clauses and specifiers (`import { foo, bar as baz } from "./utils"`).
2. **Default Imports**: Extracts default imports (`import Foo from "./Foo"`).
3. **Namespace Imports**: Extracts wildcard imports (`import * as Utils from "./utils"`).
4. **Side-Effect Imports**: Extracts bare module statements (`import "./setup"`).
5. **Dynamic Imports**: Statically extracts `import("./foo")` and flags computed calls (`import(fn())`) as `unsupported_dynamic`.
6. **CommonJS Require**: Statically extracts `require("./foo")` without executing runtime code.
7. **Re-Exports**: Extracts star (`export * from "./utils"`), namespace (`export * as utils from "./utils"`), and named re-exports (`export { foo } from "./utils"`).
8. **TypeScript Path-Alias Resolution**: Resolves `@/*` and other custom path mappings against `tsconfig.json` `baseUrl` and `paths`.
9. **Extension & Index Resolution**: Deterministically resolves relative imports lacking extensions or pointing to directories (`./components` -> `./components/index.ts`).
10. **Classification & Diagnostics**: Deterministically classifies targets as `internal`, `external`, `unresolved`, or `unsupported_dynamic` and captures parse diagnostics without throwing unhandled exceptions.

### Deterministic Architecture & Safe Invariants

- **Untrusted Input Guarantee**: Customer code is never executed, evaluated, dynamically imported by the runtime, or passed to external package managers.
- **In-Memory Virtual Resolution**: Resolves modules against an in-memory `SnapshotFileMap` using a custom `ts.ModuleResolutionHost`, completely decoupled from network and disk access.
- **Explicit Barrel Relationships**: Preserves barrel re-export edges explicitly (`re_export`). Barrel-file collapsing and normalization is strictly deferred to Step 25.
- **Cross-Platform Determinism**: Normalizes path separators to POSIX slashes and lexicographically sorts all emitted arrays (`filesAnalyzed`, `references`, `internalEdges`, `externalReferences`, `unresolvedReferences`).

### Scope Boundary

Step 20 does not:
- detect Next.js API routes or Express routers (Step 21);
- detect event publishers or subscribers (Step 22);
- detect ORM or database references (Step 23);
- implement tree-sitter fallback parsers (Step 24);
- implement symbol normalizers or barrel-file collapses (Step 25);
- persist GraphNode, GraphEdge, or Evidence database rows (Phase 4);
- invoke an LLM.

---

**## 38. Step 21 - Next.js API Route and Express Router Detection**

Step 21 implements deterministic static detection of Next.js API routes and Express routers (`docs/architecture/05-component-responsibilities.md §5.5`, `docs/architecture/17-implementation-roadmap.md §Phase 3 Step 4`).

### Purpose and Responsibilities

Given an immutable repository snapshot, the route detector deterministically discovers and classifies all HTTP API entrypoints and router instances:
1. **Next.js App Router Route Handlers**: Discovers route handlers in `app/**/route.(ts|tsx|js|jsx)` and extracts exported HTTP method functions (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`).
2. **Next.js Pages Router API Routes**: Discovers API routes in `pages/api/**` and extracts default exported handlers (`export default function handler(req, res)`).
3. **Route Path Derivation**: Deterministically computes public HTTP endpoint paths (e.g. `app/api/posts/[id]/route.ts` -> `/api/posts/[id]`, `pages/api/users.ts` -> `/api/users`).
4. **Express Router Detection**: Detects `express.Router()` and `Router()` invocations when imported from `"express"`, capturing registered routes (`router.get`, `router.post`, etc.) and middleware mounts (`router.use`).
5. **Express App Route Detection**: Detects `app.get`, `app.post`, etc. only when proven to originate from `express()`.
6. **Static Value Extraction**: Statically parses string literals and template literals for paths; dynamic expressions safely fall back to `(unresolved)` without executing code.
7. **False-Positive Prevention**: Strictly excludes frontend page files (`page.tsx`, `layout.tsx`) and arbitrary non-Express objects named `router` or `app`.

### Deterministic Architecture & Safe Invariants

- **Untrusted Input Guarantee**: Customer code is never executed, evaluated, dynamically imported, or run via external processes.
- **AST Provenance Verification**: Uses the TypeScript Compiler API (`ts.createSourceFile`) to verify AST identifier origins and call sites.
- **Reproducible Findings**: Given identical snapshot inputs, route IDs, counts, locations, and evidence are 100% deterministic.
- **Explicit Evidence**: Every detected route and router record carries an explanatory evidence statement detailing why it was classified.

### Scope Boundary

Step 21 does not:
- detect event publishers or subscribers (Step 22);
- detect ORM or database references (Step 23);
- implement tree-sitter fallback parsers (Step 24);
- implement symbol normalizers or barrel-file collapses (Step 25);
- persist GraphNode, GraphEdge, or Evidence database rows (Phase 4);
- invoke an LLM.

---

**## 39. Step 22 - Event Producer and Consumer Pattern Detection**

Step 22 implements deterministic static detection of event producer and consumer patterns (`docs/architecture/05-component-responsibilities.md §5.5`, `docs/architecture/17-implementation-roadmap.md §Phase 3 Step 5`).

### Purpose and Responsibilities

Given an immutable repository snapshot, the event pattern detector statically and deterministically discovers where pub/sub events are emitted and consumed across four initial ecosystems:
1. **Node.js EventEmitter**:
   - Producers: `emitter.emit("event", ...)` and subclassed `this.emit("event", ...)`.
   - Consumers: `emitter.on("event", fn)`, `emitter.once("event", fn)`, `emitter.addListener("event", fn)`.
2. **Redis Pub/Sub**:
   - Producers: `client.publish("channel", ...)`.
   - Consumers: `client.subscribe("channel", fn)`, `client.pSubscribe("pattern", fn)`.
3. **KafkaJS**:
   - Producers: `producer.send({ topic: "..." })`.
   - Consumers: `consumer.subscribe({ topic: "..." })`, `consumer.run({ eachMessage: ... })`, `consumer.run({ eachBatch: ... })`.
4. **RabbitMQ / amqplib**:
   - Producers: `channel.publish(exchange, routingKey, ...)`, `channel.sendToQueue(queue, ...)`.
   - Consumers: `channel.consume(queue, fn)`.
5. **Static Value Extraction**:
   - Statically extracts string literals and no-substitution template literals for event names, topics, channels, and queues.
   - Dynamic, computed, or non-literal expressions safely fall back to `null` with `status: "unresolved"`. Code is never executed.
6. **False-Positive Prevention**:
   - Strictly enforces receiver provenance from known imports (`events`, `redis`, `ioredis`, `kafkajs`, `amqplib`), constructor calls, or factory functions. Arbitrary objects named `socket`, `blog`, `client`, or `channel` without proven provenance are excluded.

### Deterministic Architecture & Safe Invariants

- **Untrusted Input Guarantee**: Customer code is never executed, evaluated, dynamically imported, or run via external processes.
- **AST Provenance Verification**: Uses the TypeScript Compiler API (`ts.createSourceFile`) to verify module imports and variable instantiation bindings before matching call sites.
- **Reproducible Findings**: Given identical snapshot inputs, detected patterns, counts, locations, and IDs are 100% deterministic.
- **Explicit Evidence**: Every detected producer and consumer carries an explanatory evidence statement detailing why it was classified.

### Scope Boundary

Step 22 does not:
- detect ORM or database references (Step 23);
- implement symbol normalizers or barrel-file collapses (Step 25);
- persist GraphNode, GraphEdge, or Evidence database rows (Phase 4);
- link producers and consumers across the graph (Phase 4);
- invoke an LLM.

---

**## 40. Step 23 - Database Reference Detection**

Step 23 implements deterministic static detection of database and ORM references (`docs/architecture/05-component-responsibilities.md §5.5`, `docs/architecture/17-implementation-roadmap.md §Phase 3 Step 6`).

### Purpose and Responsibilities

Given an immutable repository snapshot, the database reference detector statically and deterministically discovers where database operations occur across four initial ORM ecosystems:
1. **Prisma**:
   - Model operations: `prisma.<model>.findMany`, `findUnique`, `findFirst`, `create`, `createMany`, `update`, `updateMany`, `delete`, `deleteMany`, `upsert`.
   - Raw queries & transactions: `$queryRaw`, `$queryRawUnsafe`, `$executeRaw`, `$executeRawUnsafe`, `$transaction`.
2. **Drizzle ORM**:
   - Query builder shapes: `select().from(table)`, `insert(table)`, `update(table)`, `delete(table)`.
   - Relational query shapes: `db.query.<table>.findMany`, `db.query.<table>.findFirst`.
3. **TypeORM**:
   - Repository patterns: `getRepository(Entity).find`, `save`, `insert`, `update`, `delete`, `remove`, `userRepo.find`, `userRepo.save`.
   - Entity Manager patterns: `manager.find(Entity, ...)`, `manager.save(Entity, ...)`, `manager.insert(Entity, ...)`, `manager.update(Entity, ...)`.
4. **Sequelize**:
   - Model patterns: `User.findAll`, `User.findOne`, `User.findByPk`, `User.create`, `User.bulkCreate`, `User.update`, `User.destroy`, `User.upsert`.

### Operation Taxonomy

All detected calls are mapped into a unified operation taxonomy:
- `read`: Query and fetch operations (`findMany`, `findUnique`, `select`, `findAll`, `findOne`, `findByPk`).
- `insert`: Entity and row insertions (`create`, `createMany`, `insert`, `save`, `bulkCreate`).
- `update`: Mutation and update calls (`update`, `updateMany`).
- `delete`: Removal operations (`delete`, `deleteMany`, `remove`, `destroy`).
- `upsert`: Atomic create-or-update calls (`upsert`).
- `query`: Raw database query evaluations (`$queryRaw`, `$queryRawUnsafe`).
- `execute`: Raw command executions (`$executeRaw`, `$executeRawUnsafe`).
- `transaction`: Transaction block boundaries (`$transaction`).

### Provenance & False-Positive Prevention

- **Strict In-File Provenance Verification**: Calls are evaluated against in-file ORM provenance scopes built from top-level imports (`@prisma/client`, `drizzle-orm`, `typeorm`, `sequelize`), CommonJS requires, class declarations (`extends Model`, `extends BaseEntity`, `@Entity()`), and client variable bindings (`new PrismaClient()`, `drizzle()`, `getRepository(User)`).
- **False-Positive Elimination**: Unproven calls like `foo.findMany()`, `file.save()`, `element.create()`, or `user.update()` on arbitrary objects without ORM provenance are strictly excluded.

### Static Resource Name Resolution

- Model, table, or entity names are extracted as `resourceName` with `status: "resolved"` when statically knowable (string literals, identifier names, or no-substitution template literals).
- Dynamic or computed resource expressions (e.g. `prisma[dynamicModel].findMany()`) resolve to `resourceName: null` with `status: "unresolved"`.
- Raw queries (`$queryRaw`, `$executeRaw`) set `resourceName: null` with `status: "resolved"`.

### Deterministic Architecture & Safe Invariants

- **Untrusted Input Guarantee**: Customer code is never executed, evaluated, dynamically imported, or run via external processes. No database connections are opened.
- **AST Provenance Verification**: Uses TypeScript Compiler API (`ts.createSourceFile`) to verify bindings and call sites.
- **Reproducible Findings**: Output reference lists, IDs, source locations, and counts are 100% deterministic across runs.

### Scope Boundary

Step 23 does not:
- implement tree-sitter fallback parsers (Step 24);
- implement symbol normalizers or barrel-file collapses (Step 25);
- persist GraphNode, GraphEdge, or Evidence database rows (Phase 4);
- build graph edges or graph database relationships;
- invoke an LLM.

---

**## 41. Step 24 - Tree-sitter Fallback Pass**

Step 24 implements a WebAssembly Tree-sitter-based fallback parsing pass for source files that are outside the primary TypeScript Compiler API scope or cannot be parsed safely by the primary parser (`docs/architecture/05-component-responsibilities.md §5.2`, `docs/architecture/17-implementation-roadmap.md §Phase 3 Step 7`).

### Purpose and Responsibilities

The Tree-sitter fallback pass complements the existing compiler-based analysis pipeline:
1. **Primary Parser Rule**: If the primary TypeScript Compiler API can parse a TS/JS file, Fluxora keeps using the compiler API. Tree-sitter NEVER replaces or duplicates successful TS/JS parsing.
2. **Non-TS/JS Scope**: Non-TypeScript/JavaScript files recognized by Fluxora (JSON, CSS, HTML, Markdown) are parsed via Tree-sitter / static AST fallback.
3. **Primary Parse Failure Fallback**: If primary parsing fails or encounters critical syntax errors on a supported TS/JS file, Tree-sitter provides a fault-tolerant syntax fallback pass.

### Architecture & Parser Abstraction

- Located in `apps/workers/src/tree-sitter/` (`parser.ts`, `languages.ts`, `result.ts`).
- Uses `web-tree-sitter` with precompiled WASM grammars from `tree-sitter-wasms`.
- Maintains a cached, reusable parser and WASM language grammar instance pool.
- Exposes generic syntax information: root node type, node counts, source ranges (1-based line/col, 0-based offset), and generic structural units (`json_property`, `css_rule`, `html_element`, `markdown_heading`, `code_block`).

### Fallback Decision Path

The decision logic (`evaluateFallbackDecision`) enforces:
1. File path ignored directory check (`node_modules`, `.next`, `dist`, etc. -> skipped/unparsed).
2. Language determination via extension mapping. Unsupported extensions return `language: "unsupported"` safely.
3. TS/JS files with `primaryParserSucceeded === true` -> return `parserUsed: "compiler-primary"`, `usedFallback: false`.
4. Non-TS/JS supported files or failed TS/JS files -> execute Tree-sitter fallback pass.

### Malformed Source Tolerance & Diagnostics

- Malformed input never throws or crashes ingestion workers.
- Captures Tree-sitter error nodes (`ERROR`, `isError`) and records structured, deterministic diagnostics.
- Returns partial syntax trees and structural units when available.
- All diagnostics and structural units are deterministically sorted by line/column and character offsets.

### Security Invariants

- Strictly static analysis.
- WebAssembly isolation.
- Target repository code is never executed, dynamically imported, or evaluated.
- No network connections, process spawning, or database calls.

### Scope Boundary

Step 24 does not:
- normalize symbols or resolve barrel files (Step 25);
- merge cross-detector results into graph entities (Step 25/26);
- create database tables or persist `GraphNode` / `GraphEdge` / `Evidence` records (Phase 4);
- invoke an LLM.

---

**## 42. Step 25 - Normalization**

Step 25 implements the Phase 3 Normalizer engine (`docs/architecture/05-component-responsibilities.md §5.7`, `docs/architecture/17-implementation-roadmap.md §Phase 3 Step 8`).

### Purpose and Responsibilities

The Normalizer takes raw detector outputs produced across Steps 18–24 (language detection, per-file symbol extraction, import/export graph extraction, API route detection, event pattern detection, database reference detection, and tree-sitter fallback parsing) and produces a canonical, deterministic representation (`RepositoryNormalizedResult`).

The primary responsibilities are:
1. **Barrel-File / Re-Export Resolution**: Traverses static re-export relationships (`export { foo } from "./foo"`, `export * from "./users"`, `export { a as b }`, etc.) extracted in Step 20 to resolve re-exported names and aliases to their underlying canonical symbol declarations.
2. **Symbol Deduplication**: Ensures multiple barrel references or alias re-exports point to a single canonical symbol declaration without collapsing distinct declarations that share names across different files or locations.
3. **Canonical Identity Generation**: Computes stable, deterministic IDs for symbols (`sym:${file}#${kind}:${parent ? parent + "." : ""}${name}:${offset}`), module edges, routes, event patterns, database references, and unresolved references.
4. **Cycle Safety**: Bounds re-export graph traversal to prevent infinite recursion, recording cycle status deterministically when cycles (`a.ts <-> b.ts`) exist.
5. **Cross-Detector Symbol Linkage**: Connects API routes, event producers/consumers, and database references to their corresponding canonical symbol declarations in the repository snapshot when static evidence is present.
6. **Deterministic Ordering**: Sorts all output collections (`symbols`, `exportResolutions`, `moduleEdges`, `routes`, `events`, `databaseReferences`, `unresolved`, `diagnostics`) using explicit alphanumeric comparison keys to guarantee 100% reproducible analysis output across runs.
7. **Provenance & Evidence Preservation**: Maintains source detector provenance (`step-19-symbols`, `step-20-modules`, etc.) and original IDs without erasing context.

### Data Contracts

Shared normalizer contracts are defined in `packages/shared-types/src/normalized.ts`:
- `RepositoryNormalizerInput`: Input container accepting raw detector outputs.
- `NormalizedSymbol`: Canonical symbol representation with aliases and provenance.
- `NormalizedAlias`: Record of an export alias or re-export alias pointing to a canonical symbol declaration.
- `NormalizedExportResolution`: Resolution result for re-exported names (`"resolved" | "unresolved" | "ambiguous" | "cyclic"`).
- `NormalizedModuleEdge`: Normalized module dependency edge with linked symbol IDs.
- `NormalizedRoute`: Normalized API route with linked canonical symbol ID.
- `NormalizedEventPattern`: Normalized event pattern with linked canonical symbol ID.
- `NormalizedDatabaseReference`: Normalized database reference with linked canonical symbol ID.
- `NormalizedUnresolvedReference`: Explicit record of unresolved module specifiers, ambiguous exports, or cyclic re-exports.
- `NormalizedDiagnostic`: Unified diagnostic entry from all underlying detector passes.
- `NormalizerStatistics`: Deterministic metrics summary.
- `RepositoryNormalizedResult`: Complete deterministic result model.

### Pure Invariants & Security Safeguards

- **Immutability**: The Normalizer is a pure function (`normalizeAnalysis`). Raw detector inputs are never mutated in place.
- **No LLM Dependence**: Re-export resolution, symbol deduplication, and linkage are 100% static and deterministic.
- **No Code Execution**: Resolution relies solely on static AST module graphs and tsconfig path alias information extracted in Step 20. Customer code is never executed, evaluated, or imported.
- **Cycle & Depth Bounds**: Recursion depth is capped at 100 hops, and visited re-export keys (`file:exportName`) prevent infinite loops on cyclic barrel graphs.

### Scope Boundary

Step 25 does NOT:
- run the full Phase 3 pipeline end-to-end verification (Step 26);
- create database tables or persist `GraphNode` / `GraphEdge` / `Evidence` records (Phase 4);
- build graph builder persistence engines or graph traversal APIs (Phase 4);
- invoke an LLM.

**## 43. Step 26 - Full Phase 3 Golden-Fixture Pipeline Verification**

Step 26 implements the final verification milestone of Phase 3 (`docs/architecture/05-component-responsibilities.md §5.7`, `docs/architecture/17-implementation-roadmap.md §Phase 3 Step 9`).

### Architecture & Pipeline Orchestrator

Step 26 defines the reusable internal pipeline orchestrator `runPhase3Pipeline` in `apps/workers/src/pipeline/phase3.ts`, orchestrating Steps 18–25 sequentially over a repository snapshot:

1. **Step 18 — Stack Detection**: Detects languages (TypeScript, JavaScript, JSON, CSS, Markdown) and frameworks (Next.js, React, Node.js).
2. **Step 19 — Per-File AST Symbol Extraction**: Extracts functions, classes, interfaces, types, and variables.
3. **Step 20 — Import/Export Module Graph**: Extracts module edges and resolves `tsconfig.json` path aliases (`@/*`).
4. **Step 21 — API Route & Express Router Detection**: Identifies Next.js App Router HTTP handlers and Express router mounts.
5. **Step 22 — Event Pattern Detection**: Detects pub/sub event method shapes (EventEmitter, Redis, KafkaJS, RabbitMQ).
6. **Step 23 — Database Reference Detection**: Detects ORM/database interaction points (Prisma, Drizzle, TypeORM, Sequelize).
7. **Step 24 — Tree-sitter Fallback Pass**: Executes WebAssembly Tree-sitter parsing for non-TS/JS files.
8. **Step 25 — Normalization**: Dedupes symbols, resolves barrel file re-export chains, assigns canonical IDs (`sym:...`, `edge:...`), and aggregates diagnostics.

### Verification against Golden Fixture (`shadcn-ui/taxonomy`)

The pipeline was executed and validated against the production golden fixture repository (`shadcn-ui/taxonomy`), verifying extracted claims against actual source evidence:
- **Representative Symbols**: `db` (`lib/db.ts`), `siteConfig` (`config/site.ts`), `GET` (`app/api/posts/route.ts`).
- **Representative Module Edges**: `app/api/posts/route.ts` -> `lib/db.ts`, `app/layout.tsx` -> `config/site.ts`, `components/user-auth-form.tsx` -> `lib/validations/auth.ts`.
- **Representative Routes**: `/api/posts` (`GET`, `POST`), `/api/og` (`GET`).
- **Determinism**: Repeated execution yields identical canonical IDs, ordering, and summary counts across platforms.

### Scope Boundary & Phase 4 Transition

Step 26 does NOT:
- persist `GraphNode` / `GraphEdge` / `Evidence` records to PostgreSQL (Phase 4 Step 1 & 2);
- build graph traversal APIs or graph query endpoints (Phase 4 Step 4 & 5);
- invoke AI or LLM models (Phase 9).

With Global Step 26 complete, **Phase 3 — Code Intelligence is 100% complete** and ready for Phase 4 graph persistence.

---

**## 44. Step 27 - Graph Storage — GraphNode, GraphEdge, and Evidence Persistence**

Step 27 implements the relational database persistence layer for Fluxora's code knowledge graph (`docs/architecture/05-component-responsibilities.md §5.8`, `docs/architecture/17-implementation-roadmap.md §Phase 4 Step 1`).

### Purpose and Data Model

Step 27 creates four core database tables in `packages/db/migrations/0014_graph_storage.sql`:

1. **`analysis_runs`**: Parent execution scope for graph analysis of a `RepositorySnapshot`.
2. **`graph_nodes`**: Persists canonical graph entities (modules, symbols, functions, routes, databases, services).
3. **`graph_edges`**: Persists directed relationships between nodes within an `analysis_run` (`IMPORTS`, `CALLS`, `EXPOSES_ROUTE`, `READS_TABLE`).
4. **`evidence`**: Persists code provenance records (file paths, line/column ranges, symbol IDs, relationship explanations).

### Conceptual Data-Flow Diagram

```
Repository / Snapshot / Analysis scope
                  ↓
              AnalysisRun
            /             \
      GraphNode  ------->  GraphEdge
          ↓                   ↓
       Evidence  <-------  Evidence
```

### Multi-Tenant Isolation & Row-Level Security (RLS)

- **Strict Tenant Boundaries**: All tables enforce PostgreSQL Row-Level Security (RLS).
- **RLS Helper Functions**: `fluxora_snapshot_in_current_tenant(snapshot_id)` and `fluxora_analysis_run_in_current_tenant(analysis_run_id)` verify that `repositories.organization_id = fluxora_current_org_id()`.
- **Recursion-Free Policies**: Policies on `analysis_runs` evaluate `fluxora_snapshot_in_current_tenant(snapshot_id)` directly on its foreign key column to eliminate RLS policy recursion loops.
- **Cross-Tenant Prevention**: Cross-tenant reads, inserts, updates, and deletes are denied at the database layer.

### Referential Integrity & Uniqueness Constraints

- **Composite Foreign Keys**: `graph_edges` uses composite foreign keys `FOREIGN KEY (source_node_id, analysis_run_id) REFERENCES graph_nodes (id, analysis_run_id)` to guarantee at the database level that an edge can ONLY connect nodes belonging to the exact same analysis run and tenant.
- **Node Deduplication**: `UNIQUE (analysis_run_id, canonical_id)` prevents duplicate canonical nodes per analysis run.
- **Edge Deduplication**: `UNIQUE (analysis_run_id, source_node_id, target_node_id, edge_type)` prevents duplicate edges of the same type between identical nodes within a run.

### Scope Boundary

Step 27 is **storage only**. It does NOT:
- construct graph nodes or edges from Phase 3 AST outputs (Step 28);
- perform recursive graph traversal CTE queries (Step 29);
- expose graph query API endpoints (Step 30);
- generate graph diffs across snapshots (Step 31);
- publish `graph.updated` WebSocket events (Step 32);
- process LLM/AI explanations or speculative summaries.

---

**## 45. Step 28 - Graph Builder — Transforming Normalized Intelligence into Graph Storage**

Step 28 implements the Graph Builder component (`docs/architecture/05-component-responsibilities.md §5.7`, `docs/architecture/17-implementation-roadmap.md §Phase 4 Step 2`).

### Architecture & Conceptual Flow

The Graph Builder transforms the normalized, deduplicated Phase 3 code-intelligence result (`RepositoryNormalizedResult`) into structured `GraphNode`, `GraphEdge`, and `Evidence` records created by Step 27.

```
Phase 3 Normalized Output
            │
            ▼
      Graph Builder (Projection & Validation)
            │
      ┌─────┼─────┐
      ▼     ▼     ▼
    Nodes  Edges Evidence
      │     │     │
      └─────┼─────┘
            ▼
   PostgreSQL (withTenant Transaction)
```

### Pure Graph Projection & Endpoint Invariants

- **Decoupled Projection Layer**: `buildGraphProjection` performs in-memory node, edge, and evidence projection without database calls, enabling instant unit testing.
- **Node Classification**:
  - `symbols` $\rightarrow$ `GraphNodeType = "symbol"` (preserves canonical symbol IDs `sym:...`).
  - `modules` $\rightarrow$ `GraphNodeType = "module"` (`mod:${filePath}`).
  - `routes` $\rightarrow$ `GraphNodeType = "api"` (`route:...`).
  - `events` $\rightarrow$ `GraphNodeType = "event"` (`event:...`).
  - `databaseReferences` $\rightarrow$ `GraphNodeType = "database"` (`db:...`).
- **Endpoint Verification**: Every directed edge requires both source and target nodes to exist in the generated node map. If an edge endpoint is missing or unresolvable, the edge is safely rejected and counted in `statistics.rejectedEdgesCount`.
- **Non-Fabrication**: Unresolved Phase 3 specifiers or references (`normalizedResult.unresolved`) remain unresolved. Fake nodes or dangling edges are never created.

### Deterministic Identifiers & Idempotency

- **Deterministic UUID Generation**: Primary keys (`id`) are derived deterministically using SHA-256 hashes (`generateDeterministicUuid`).
- **Deterministic Ordering**: Output nodes, edges, and evidence arrays are sorted lexicographically ASC before returning or persisting.
- **Idempotency**: Running `buildAndPersistGraph` twice on the same snapshot produces identical IDs and uses `ON CONFLICT (...) DO UPDATE` in PostgreSQL, preventing duplicate records.

### Atomic Transactions & RLS Isolation

- **Atomic Transactions**: `persistGraphBuild` executes all node, edge, and evidence insertions within a single `withTenant` PostgreSQL transaction block.
- **All-or-Nothing Rollback**: Any error or constraint failure triggers a database `ROLLBACK`, guaranteeing zero partial graph data.
- **RLS Enforced**: All records inherit `analysis_run_id` and pass `fluxora_analysis_run_in_current_tenant` RLS validation.

### Scope Boundary

Step 28 does NOT:
- expose graph query or traversal API endpoints (Step 29/30);
- generate graph diffs across snapshot runs (Step 31);
- publish `graph.updated` WebSocket events (Step 32);
- perform golden graph verification as a separate roadmap step (Step 33);
- invoke LLM/AI reasoning.

---

## 46. Phase 4 Step 29 Architecture — Evidence Writer & CI Evidence Lint

Step 29 implements the Evidence Writer abstraction and static CI Evidence Lint (`docs/architecture/05-component-responsibilities.md §5.7`, `docs/architecture/12-testing-strategy.md §12.1`, `docs/architecture/17-implementation-roadmap.md §Phase 4 Step 3`).

### Architecture & Data Flow

Every structural conclusion in Fluxora (graph nodes and graph edges) must have corresponding Evidence records preserving exact source provenance. Step 29 introduces `EvidenceWriter` as an explicit architectural component and enforces its usage via static AST analysis in CI.

```
                  Phase 3 Normalized Intelligence
                                 │
                                 ▼
                 Graph Builder Projection Layer
                                 │
           ┌─────────────────────┴─────────────────────┐
           ▼                                           ▼
      Graph Nodes                               Evidence Writer
      & Graph Edges                         (createNodeEvidence /
           │                                 createEdgeEvidence)
           └─────────────────────┬─────────────────────┘
                                 │
                                 ▼
                     persistGraphBuild Transaction
                        (PostgreSQL withTenant)
                                 │
           ┌─────────────────────┼─────────────────────┐
           ▼                     ▼                     ▼
      graph_nodes           graph_edges             evidence
     (ON CONFLICT)         (ON CONFLICT)         (ON CONFLICT)
```

### Evidence Writer Responsibilities (`EvidenceWriter`)

- **Deterministic Identity (`generateEvidenceId`)**: Evidence UUID primary keys are derived deterministically using SHA-256:
  `${analysisRunId}:evidence:${subjectType}:${subjectId}:${filePath}:${relationshipDescription}`
- **Validation (`assertEvidenceInput`)**: Validates UUID formats, 1-based line/column numbers (`lineStart >= 1`, `lineEnd >= lineStart`), confidence bounds (`0.0 <= confidence <= 1.0`), and non-empty string attributes.
- **Non-Fabrication**: Unresolved relationships or missing source maps retain `null` for `symbolId`, `lineStart`, `columnStart`, etc. Source locations are never fabricated.
- **Single & Batch Database Persistence**: `writeEvidence`, `writeEvidenceBatch`, and `writeEvidenceBatchTx` write evidence records using `ON CONFLICT (id) DO UPDATE` to guarantee idempotency.

### CI Evidence Lint (`verifyGraphWritePaths`)

- **Static AST Inspection**: Uses TypeScript Compiler API (`ts.createSourceFile`) to inspect graph-write implementation files (`packages/db/src/repositories/graph.ts` and `apps/workers/src/builder/graph-builder.ts`) without requiring a live database.
- **Architectural Invariant Enforcement**: Asserts that every function performing graph node or edge creation/persistence explicitly invokes `EvidenceWriter`.
- **CI Gate**: Executed via `pnpm lint:evidence` in `.github/workflows/ci.yml`.

### Scope Boundary

Step 29 does NOT:
- implement bounded-depth recursive CTE queries (Step 30);
- expose `POST /api/v1/graph/query` (Step 30);
- compute graph diffs or publish `graph.updated` events (Step 31/32);
- implement Phase 5 UI visualization or Phase 9 AI reasoning.

---

## 47. Phase 4 Step 30 Architecture — Bounded-Depth Recursive-CTE Graph Traversal

Step 30 implements Bounded-Depth Recursive-CTE Graph Traversal as a reusable internal query function (`traverseGraph`) in `@fluxora/db` (`docs/architecture/05-component-responsibilities.md §5.9`, `docs/architecture/06-database-schema.md §6.1`, `docs/architecture/17-implementation-roadmap.md §Phase 4 Step 4`).

### Architecture & Conceptual Flow

`traverseGraph` provides tenant-isolated, analysis-run scoped, bounded-depth graph exploration over PostgreSQL using a recursive Common Table Expression (`WITH RECURSIVE`).

```
                   Graph Traversal Request
            (orgId, analysisRunId, startNodeId, maxDepth)
                               │
                               ▼
            Validation & Hard Cap Enforcement (maxDepth <= 20)
                               │
                               ▼
                   PostgreSQL withTenant Session
                     (app.current_org_id set)
                               │
                               ▼
                  PostgreSQL Recursive CTE (WITH RECURSIVE)
         ┌─────────────────────┴─────────────────────┐
         ▼                                           ▼
   Anchor Member                              Recursive Member
(startNode at depth 0)                     (joins edges & target nodes)
         │                                           │
         └─────────────────────┬─────────────────────┘
                               │
                       Cycle Check (WHERE NOT (next_node.id::text = ANY(t.path)))
                       Depth Check (WHERE t.depth < maxDepth)
                               │
                               ▼
               Shortest Path & Distinct Node Selection
            (ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY depth ASC))
                               │
                               ▼
                      Evidence Collection
          (queries evidence for traversed nodes & edges)
                               │
                               ▼
                    GraphTraversalResult
         (startNode, nodes[], edges[], maxDepthReached, evidence[])
```

### Core Invariants & Security Safeguards

1. **Deterministic Core**: Graph reachability calculations are purely structural and 100% deterministic, depending only on graph records and query options (`docs/architecture/03-architecture-principles.md §P1`).
2. **Server-Side Hard Depth Cap**: Validation enforces `0 <= maxDepth <= 20` (`HARD_MAX_TRAVERSAL_DEPTH`), preventing runaway recursion or client-driven denial of service. Inside PostgreSQL, `WHERE t.depth < maxDepth` halts recursion at `maxDepth`.
3. **Cycle Prevention**: Each CTE iteration maintains a path array (`ARRAY[n.id::text]`). The recursive member checks `WHERE NOT (next_node.id::text = ANY(t.path))`, pruning cyclic graph paths (`n5 -> n6 -> n7 -> n5`).
4. **Shortest Path & Fan-In Deduplication**: Uses `ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY depth ASC, path::text ASC) WHERE rn = 1` to collapse multiple paths to the same node while preserving minimum depth and deterministic path ordering.
5. **Multi-Tenancy & RLS Isolation**: All traversal operations execute within `withTenant(pool, organizationId, ...)` and explicitly filter on `analysis_run_id = $2::uuid` across all CTE queries.
6. **Parameterized SQL**: All query values use parameterized SQL placeholders (`$1, $2, $3...`). Raw user values are never interpolated into SQL strings.
7. **Evidence Preservation**: Associated `evidence` records for traversed nodes and edges are retrieved without altering or fabricating source provenance.

### Scope Boundary & Next Roadmap Item

Step 30 does NOT:
- expose `POST /api/v1/graph/query` HTTP API endpoints (Step 31);
- compute graph diffs or publish `graph.updated` WebSocket events (Step 32);
- implement Phase 5 UI visualization or Phase 9 AI reasoning.

---

## 48. Phase 4 Step 31 Architecture — Graph Query API (POST /api/v1/graph/query)

Step 31 implements the public HTTP boundary for graph queries: `POST /api/v1/graph/query` (`docs/architecture/07-api-architecture.md §7.2`, `docs/architecture/17-implementation-roadmap.md §Phase 4 Step 5`).

### Architecture & Conceptual Flow

`handleGraphQuery` exposes the deterministic, bounded-depth recursive-CTE graph traversal functionality implemented in Step 30 (`traverseGraph`) to authenticated API consumers while isolating internal database concerns.

```
                      Client HTTP Request
                POST /api/v1/graph/query
                           │
                           ▼
                 Content-Type Validation
                (must be application/json)
                           │
                           ▼
                 Bearer JWT Authentication
                (Clerk verifyToken + Identity)
                           │
                           ▼
                  Tenant Derivation
             (organizationId from auth session)
                           │
                           ▼
                 Request Body Validation
          (analysisRunId, startNodeId, direction,
           maxDepth, edgeTypes, nodeTypes, minConfidence)
                           │
                           ▼
                 Direction Mapping
         (downstream -> outgoing, upstream -> incoming)
                           │
                           ▼
               Repository Traversal (Step 30)
                 traverseGraph(pool, options)
                           │
                           ▼
                 Response Formatting
        (Deterministic confidence filtering,
         internal-to-public mapping, evidence linking)
                           │
                           ▼
                    JSON Response (200)
         { nodes: [...], edges: [...], truncated: false }
```

### Core Invariants & Security Safeguards

1. **Authentication & Tenant Derivation**: The tenant `organization_id` is strictly derived from the authenticated Clerk GitHub session and user record. Request bodies attempting to specify `organization_id` or `organizationId` are explicitly rejected with HTTP 400 (`invalid_request`).
2. **Direction Mapping**:
   - `"downstream"` → mapped to internal `"outgoing"` traversal.
   - `"upstream"` → mapped to internal `"incoming"` traversal.
   - `"both"` → mapped to internal `"both"` traversal.
3. **Hard Depth Cap Enforcement**: `max_depth` enforces `0 <= max_depth <= 20` (`HARD_MAX_TRAVERSAL_DEPTH`). Values exceeding 20 or non-integers are rejected with HTTP 400 (`invalid_traversal_options`).
4. **Deterministic Confidence Filtering**: If `min_confidence` is provided, nodes and edges below the threshold are pruned deterministically, along with any dangling edges or orphaned evidence.
5. **Read-Only Guarantee**: The endpoint is strictly read-only and performs zero writes or mutations against `graph_nodes`, `graph_edges`, or `evidence`.
6. **Safe Public Error Contract**: Follows Fluxora's standard error format `{ "error": { "code": "...", "message": "..." } }`. Missing or cross-tenant start nodes return HTTP 404 (`start_node_not_found`) without leaking cross-tenant existence.

### Scope Boundary & Next Roadmap Item

Step 31 does NOT:
- generate graph diffs across snapshot runs (Step 32);
- publish `graph.updated` WebSocket events (Step 32);
- perform golden graph verification as a separate roadmap step (Step 33);
- implement Phase 5 UI visualization or Phase 9 AI reasoning.

With Global Step 31 complete, the next official Phase 4 roadmap item is **Step 32: Implement `graph.updated` event + diff summary computation**.

---

## 49. Phase 4 Step 32 Architecture — Graph Update Event Emission & Diff Summary

Step 32 implements deterministic graph diff summary computation and transactional `graph.updated` event emission (`docs/architecture/08-events-and-async-architecture.md §8.1`, `docs/architecture/17-implementation-roadmap.md §Phase 4 Step 6`).

### Architecture & Conceptual Flow

When repository ingestion produces an updated graph representation, `persistGraphBuild` computes the structural diff between the previous analysis run graph state and the newly projected graph state. The diff is calculated deterministically in memory, linked to the `graph.updated` domain event payload, and persisted to the transactional outbox (`events` table) within the same `withTenant` PostgreSQL transaction. Once committed, PostgreSQL `LISTEN/NOTIFY` pushes the event envelope to listening WebSocket clients scoped to the tenant organization.

```
   Worker: buildAndPersistGraph(input, options)
                     │
                     ▼
       withTenant(pool, organizationId) Transaction (Step 28 + Step 32)
                     │
       ┌─────────────┴─────────────────────────┐
       │ 1. Resolve prior graph state          │
       │    (getGraphStateForAnalysisRunTx)    │
       │                                       │
       │ 2. Compute deterministic diff         │
       │    computeGraphDiff(previous, current)│
       │                                       │
       │ 3. Persist nodes, edges, evidence     │
       │    (EvidenceWriter AST-enforced)      │
       │                                       │
       │ 4. Insert outbox event                │
       │    events.insert(graph.updated)       │
       └─────────────┬─────────────────────────┘
                     │ COMMIT
                     ▼
         PostgreSQL Trigger: fluxora_notify_event()
                     │ NOTIFY fluxora_events
                     ▼
         API Gateway Event Listener (LISTEN)
                     │
                     ▼
         WebSocket Server (apps/api/src/ws/server.ts)
                     │
                     ▼
      Authenticated Tenant WS Clients
      { type: "event", event: { type: "graph.updated", payload: { ... } } }
```

### Core Invariants & Security Safeguards

1. **Deterministic In-Memory Diff Engine**: `computeGraphDiff(previous, current)` compares nodes by canonical ID and edges by `(sourceNodeId, targetNodeId, edgeType)`. Metadata is recursively sorted before serialization (`canonicalStringify`) to eliminate JSON key ordering differences. Added, removed, and changed items are deterministically sorted.
2. **Transactional Outbox Guarantee**: Graph nodes, edges, evidence, and the `graph.updated` event row are written in the exact same `withTenant` transaction. If graph writes fail or roll back, no event is committed or broadcast.
3. **Idempotency**: The event uses a deterministic `idempotency_key = graph:updated:<analysisRunId>:<previousAnalysisRunId|initial>`, preventing duplicate outbox event generation on re-runs.
4. **Strict Multi-Tenant Isolation**: State queries set `app.current_organization_id` under RLS and enforce defensive SQL assertions (`AND fluxora_analysis_run_in_current_tenant(analysis_run_id)`). WebSocket dispatch checks client organization membership before broadcasting.
5. **No Database Row Leakage**: The public event payload contains only domain-safe fields (`nodeType`, `name`, `path`, `confidence`, `metadata`, `provenance`). Internal table columns and sensitive credentials are never exposed.

### Scope Boundary & Next Roadmap Item

Step 32 does NOT:
- perform golden fixture graph verification as a standalone roadmap step (Step 33);
- implement React Flow or interactive visual canvas components (Phase 5);
- calculate PR blast radius or change impact traversal (Phase 6);
- generate natural language explanations or LLM summaries (Phase 9).

With Global Step 32 complete, the next official Phase 4 roadmap item is **Step 33: Golden graph verification (end-to-end fixture: TypeScript repo -> full graph in DB)**.

---

## Global Step 33 — Golden Fixture Graph Verification

### Overview & Objective

Global Step 33 establishes the end-to-end integration and verification gate for the complete code intelligence to relational graph persistence pipeline (`docs/architecture/17-implementation-roadmap.md §Phase 4 Step 7`).

Step 33 takes the multi-file canonical fixture (`packages/db/src/fixtures/taxonomy`), runs it through Phase 3 AST extraction and normalization, executes the Graph Builder (`buildAndPersistGraph`), persists the resulting nodes, edges, and evidence to PostgreSQL under Row-Level Security, and reads the entire state back using production repository APIs to assert canonical contracts.

### End-to-End Pipeline Data Flow

```
[ Golden Fixture: taxonomy ]
           │
           ▼
[ Step 18–26: runNormalizedAnalysisPipeline ]
           │
           ▼
[ Step 28: buildAndPersistGraph ]
           │
           ├── withTenant Transaction
           │     ├── EvidenceWriter.createNodeEvidence (graph_nodes + evidence)
           │     ├── EvidenceWriter.createEdgeEvidence (graph_edges + evidence)
           │     └── Step 32 Diff Engine (events table outbox)
           ▼ COMMIT
[ PostgreSQL: graph_nodes, graph_edges, evidence, events ]
           │
           ▼ Production Repositories (listGraphNodes, listGraphEdges, etc.)
[ Step 33 Canonical Contract Verification Suite (apps/workers/src/pipeline/golden-graph.test.ts) ]
```

### Canonical Contracts Verified

1. **Canonical GraphNodes Contract**:
   - Asserts 490 total nodes: 367 `symbol`, 118 `module`, 5 `api`.
   - Asserts canonical ID formats: `mod:<path>`, `sym:<path>#<name>:<line>`, `route:<path>#<handler>:<method>:<path>:<line>`.
   - Asserts uniqueness: zero duplicate canonical IDs within the analysis run.
2. **Canonical GraphEdges Contract**:
   - Asserts 888 total edges: 511 `IMPORTS`, 372 `RESOLVES_TO`, 5 `EXPOSES_ROUTE`.
   - Asserts valid directionality (`IMPORTS` module->module, `EXPOSES_ROUTE` module->route).
   - Asserts complete referential integrity with zero dangling endpoints.
3. **Evidence Provenance Contract**:
   - Asserts 1378 total evidence records (490 node evidence + 888 edge evidence).
   - Asserts valid file paths, confidence scores of 1.0, and positive 1-based start coordinates.
4. **Determinism & Idempotency Contract**:
   - Asserts that re-running graph construction on identical source code produces identical nodes and edges.
   - Asserts that repeated persistence does not create duplicate graph records.
5. **Tenant and Analysis-Run Isolation Contract**:
   - Asserts that PostgreSQL Row-Level Security (RLS) completely isolates Organization A's graph from Organization B.
   - Asserts that separate analysis runs within the same organization do not cross-contaminate.
6. **Meaningful Negative Assertions**:
   - Asserts the absence of non-existent files (`services/billing.ts`), phantom symbols, and synthetic routes.
7. **Step 30 Recursive-CTE Traversal Smoke Test**:
   - Asserts that bounded-depth CTE graph traversal successfully navigates module, symbol, and route chains on the persisted golden graph.

### Architectural Hardening & Bug Fixes Discovered

1. **Multi-line Evidence Coordinate Validation**: Fixed `EvidenceWriter` coordinate checks and database check constraint `0015_evidence_coordinates_constraint.sql` to support tokens where `column_end < column_start` across multi-line declarations.
2. **PostgreSQL NOTIFY Payload Limit**: Added database migration `0016_event_notify_payload_truncation.sql` ensuring event notifications exceeding 7500 bytes send a summary envelope to prevent PostgreSQL `pg_notify` 8000-byte errors, while preserving full durable payloads in the `events` table.

### Scope Boundary & Next Roadmap Item

Step 33 does NOT:
- Implement Global Step 34 (Phase 4 completion review & transition);
- Implement React Flow, visual graph layout, or web canvas UI (Phase 5);
- Implement PR change-impact traversal or GitHub webhooks (Phase 6);
- Implement AI reasoning or natural language summaries (Phase 9).

With Global Step 33 complete, the roadmap advances to **Global Step 34: React Flow Graph Canvas + Node Renderers**.

---

## Global Step 34 — React Flow Graph Canvas + Node Renderers

### Overview & Objective

Global Step 34 initiates Phase 5 (Architecture UI) by integrating `@xyflow/react` (React Flow) into `apps/web` and delivering the deterministic graph canvas and per-node-type rendering foundation.

The primary objective is to bridge the deterministic graph contracts verified in Phase 4 (`GraphNode`, `GraphEdge`, and `GraphQueryResponse`) to an interactive React Flow diagram without introducing duplicate graph logic, random IDs, or client-side dependency inference.

### Component Architecture & Data Flow

```
   ┌──────────────────────────────────────────────────────────────┐
   │ Fluxora Backend (Steps 27–33)                                │
   │ Deterministic Graph State (PostgreSQL + RLS + EvidenceWriter)│
   └──────────────────────────────┬───────────────────────────────┘
                                  │ POST /api/v1/graph/query (Step 31)
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ Graph Query Response / Domain Graph                          │
   │ { nodes: GraphQueryResponseNode[], edges: ... }              │
   └──────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
               mapDomainGraphToFlow(inputNodes, inputEdges)
                                  │
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ React Flow Model                                             │
   │ - nodes: Node<FluxoraNodeData>[] (deterministic layout)      │
   │ - edges: Edge[] (stroke, labels, animation)                  │
   └──────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ GraphCanvas Component ("use client")                        │
   │ ┌──────────────────────────────────────────────────────────┐ │
   │ │ ReactFlow Viewport (Pan, Zoom, FitView)                  │ │
   │ │  ├─ NodeRenderer (per-node-type styling & handles)       │ │
   │ │  ├─ Background (Dots pattern)                            │ │
   │ │  └─ Controls (Zoom in / out / reset)                     │ │
   │ └──────────────────────────────────────────────────────────┘ │
   └──────────────────────────────────────────────────────────────┘
```

### Core Invariants Preserved

1. **Deterministic Core vs. UI Projection**:
   The frontend canvas never invents graph relationships, synthesizes phantom nodes, or calculates change propagation. The UI is strictly a presentational consumer of server-verified graph records.
2. **Stable Node & Edge Identity**:
   Domain IDs (`canonical_id` / `canonicalId`, node `id`, edge `id`) are preserved 1:1. Render keys and React Flow identifiers are never generated using `Date.now()`, `Math.random()`, or client UUIDs.
3. **Decoupled Data Fetching**:
   `GraphCanvas` and `NodeRenderer` contain zero `fetch` or React Query calls. State fetching remains the responsibility of route and container components.
4. **Per-Node-Type Visual Differentiation**:
   All 8 domain node categories (`application`, `service`, `package`, `module`, `symbol`, `api`, `event`, `database`) are visually distinct through tokens in `node-styles.ts`, while maintaining uniform handle positions, depth markers, path displays, and confidence indicators.
5. **Resilient Graph Mapping**:
   `mapDomainGraphToFlow` handles empty graphs, preserves source/target mappings, filters dangling edges pointing to non-existent nodes, and computes deterministic grid positions without external physics.

### Scope Boundary & Next Roadmap Item

Step 34 does NOT:
- Implement `/repositories/[repoId]/explorer` route or page layout (Step 35);
- Implement API data fetching or React Query query hooks (Step 35);
- Implement `NodeInspectorPanel` or `EvidenceTrail` (Step 36);
- Implement `GraphFilters` (Step 37);
- Implement clustering / level-of-detail pre-aggregation (Step 38);
- Implement live WebSocket invalidation (Step 39);
- Implement change-mode or simulation-mode overlays (Phase 6 / Phase 8).

With Global Step 34 complete, the next official Phase 5 roadmap item is **Step 35: Architecture Explorer Route (`/repositories/[repoId]/explorer`) + API Fetching via `POST /graph/query`**.


---

## Global Step 35 — Architecture Explorer Route & Graph API Fetching

### Overview & Objective

Global Step 35 connects the Next.js frontend to the backend graph query engine by implementing the dedicated Architecture Explorer route (`/repositories/[repoId]/explorer`). The route resolves the repository's analysis context, executes authenticated graph queries against `POST /api/v1/graph/query` (Step 31), maps the resulting `GraphQueryResponse` into React Flow primitives, and mounts the presentational `GraphCanvas` (Step 34).

### Component Architecture & Data Flow

```
  ┌─────────────────────────────────────────────────────────────┐
  │ Browser / Next.js Route Navigation                          │
  │ /repositories/[repoId]/explorer?analysis_run_id=...&start_node_id=...│
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ Server Component (page.tsx)                                 │
  │ - Enforces Clerk auth() session                             │
  │ - Resolves repository & analysis run context                │
  │ - Renders empty/not-ready state if analysis context missing │
  │ - Hands off apiUrl and context to Client Boundary           │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ Client Component (ArchitectureExplorerClient)               │
  │ - Retrieves Clerk JWT token via useAuth().getToken()        │
  │ - Issues POST /api/v1/graph/query (Never sends org_id)      │
  │ - Handles loading, empty, and error states                  │
  │ - Transforms GraphQueryResponse via mapDomainGraphToFlow()   │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ Presentational Canvas (Step 34 GraphCanvas)                 │
  │ - Zero network logic                                        │
  │ - Renders interactive React Flow graph deterministically     │
  └─────────────────────────────────────────────────────────────┘
```

### Core Invariants Preserved

1. **Frontend Does Not Own the DB Boundary**:
   The frontend application (`apps/web`) communicates with the backend exclusively via HTTP API contracts. `apps/web` does not import `@fluxora/db`, execute SQL queries, or manage database connection pools.
2. **Backend Derives Tenancy**:
   `POST /api/v1/graph/query` receives a Bearer JWT token from Clerk. The client never supplies `organization_id` or `organizationId` in request bodies or query parameters. The API server derives tenant isolation deterministically from verified authentication tokens and scopes transactions using Row-Level Security (RLS).
3. **Deterministic Core vs. UI Projection**:
   The frontend performs zero graph traversal, cycle detection, or relationship derivation. All nodes, edges, types, confidence values, and depth measurements are returned by the backend's bounded recursive CTE traversal (Step 30/31).
4. **Decoupled Architecture**:
   `GraphCanvas` remains strictly presentational and reusable across future visualization features (e.g., simulation, impact diffs). Data fetching, error handling, and route-level state live entirely in the route container.
5. **Robust State Handling**:
   - **Loading State**: Accessible spinner/indicator during API query execution.
   - **Not Ready / Empty State**: Clear explanation when no completed analysis run or start node is specified, rather than fabricating a graph.
   - **Error State**: Safe error presentation without leaking authentication secrets or server internals.

### Scope Boundary & Next Roadmap Item

Step 35 does NOT:
- Implement `NodeInspectorPanel` or `EvidenceTrail` (Step 36);
- Implement `GraphFilters` (Step 37);
- Implement clustering / level-of-detail pre-aggregation (Step 38);
- Implement live WebSocket invalidation or `graph.updated` cache handling (Step 39);
- Implement change-mode, simulation-mode, or AI explanation overlays (Phase 6 / Phase 8);
- Introduce any database or PostgreSQL dependencies into `apps/web`.

With Global Step 35 complete, the next official Phase 5 roadmap item is **Step 36: Node Inspector Panel & Evidence Trail (selection state, node details, source coordinates, file links)**.

---

## Global Step 36 — Node Inspector Panel & Evidence Trail

### Overview & Objective

Global Step 36 extends the Architecture Explorer (`/repositories/[repoId]/explorer`) by introducing interactive node selection, the `NodeInspectorPanel`, and the `EvidenceTrail`. When an engineer selects any node in the React Flow canvas, the right-side inspector renders the node's architectural properties, metadata, and verified source code evidence trail linking the node directly to its concrete AST declarations.

All node properties and evidence records originate strictly from the backend's existing `GraphQueryResponse` (`POST /api/v1/graph/query`). No secondary network queries or database operations are executed.

### Component Architecture & Data Flow

```
   ┌─────────────────────────────────────────────────────────────┐
   │ Backend Engine (POST /api/v1/graph/query)                   │
   │ Bounded CTE traversal + verified EvidenceWriter records     │
   └──────────────────────────────┬──────────────────────────────┘
                                  │
                                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ ArchitectureExplorerClient State                            │
   │ - graph: GraphQueryResponse (nodes, edges, evidence)        │
   │ - selectedNodeId: string | null (React useState)            │
   └──────────────────────────────┬──────────────────────────────┘
                                  │
            ┌─────────────────────┴─────────────────────┐
            ▼                                           ▼
   ┌─────────────────────────────┐             ┌─────────────────────────────┐
   │ GraphCanvas (Left Pane)     │             │ NodeInspectorPanel (Right)  │
   │ - onNodeClick(id)           │             │ - node details & metadata   │
   │ - onPaneClick() (clear)     │             │ - onClose() (clear button)  │
   │ - isSelected visually shown │             │ - empty state when null     │
   └─────────────────────────────┘             └──────────────┬──────────────┘
                                                              │
                                                              ▼
                                               ┌─────────────────────────────┐
                                               │ EvidenceTrail               │
                                               │ - explicit association:     │
                                               │   subject_type='graph_node' │
                                               │   AND subject_id=node.id    │
                                               │ - deterministic sort:       │
                                               │   path → start → end → id   │
                                               └─────────────────────────────┘
```

### Core Invariants Preserved

1. **Deterministic Core vs. UI Projection**:
   The browser does not compute, infer, or hallucinate evidence relationships. All evidence items match the verified provenance collected by `EvidenceWriter` during ingestion and stored in PostgreSQL.
2. **Explicit Evidence Association**:
   Evidence records are associated strictly via:
   `evidence.subject_type === "graph_node" && evidence.subject_id === selectedNode.id`.
   Edge evidence (`subject_type === "graph_edge"`), other subject types, and other node IDs are strictly excluded.
3. **Deterministic Multi-Key Ordering**:
   Evidence items are sorted using a stable comparator: `file_path` → `line_start` → `line_end` → `id`.
4. **Least-Privilege State Management**:
   Selection state is owned cleanly at the minimal shared parent (`ArchitectureExplorerClient`) using React `useState`. No external state libraries (e.g., Zustand, Redux) are introduced.
5. **Database Boundary Protection**:
   `apps/web` does **not** import `@fluxora/db`, execute SQL queries, or connect directly to PostgreSQL.
6. **Robust Sanitization and Formatting**:
   - `formatCoordinates` handles full ranges, single lines, and partial/missing coordinates safely.
   - `safeFormatMetadataValue` serializes complex objects and enforces a strict length cap (200 characters) to prevent UI overflow.
   - Content is rendered as text nodes to guarantee XSS prevention.

### Scope Boundary & Next Roadmap Item

Step 36 does NOT:
- Implement `GraphFilters` (Step 37);
- Implement clustering / level-of-detail pre-aggregation (Step 38);
- Implement live WebSocket invalidation or `graph.updated` subscriptions (Step 39);
- Implement final Step 40 visual polish;
- Implement PR change-impact or simulation UI (Phase 6 / Phase 8);
- Implement AI-driven explanations (Phase 9).

With Global Step 36 complete, the next official Phase 5 roadmap item is **Step 37: Graph Filters (Node Types, Confidence Thresholds, Edge Types)**.

---

## Global Step 37 — Graph Filters

### Overview & Objective

Global Step 37 implements the `GraphFilters` component and typed filtering state for the Architecture Explorer. It empowers engineers to narrow the displayed digital twin by node types, edge types, minimum confidence scores, and maximum traversal depth.

All filters are applied through the existing backend graph query contract (`POST /api/v1/graph/query` created in Step 31) without fabricating client-side traversal logic, altering backend graph truth, introducing global state libraries, or exposing database operations to the browser.

### Component Architecture & Data Flow

```
   ┌─────────────────────────────────────────────────────────────┐
   │ GraphFilters Component (Presentational UI)                 │
   │ - Node types (GraphNodeTypes buttons)                       │
   │ - Edge types (GraphEdgeTypes buttons)                       │
   │ - Min confidence (Range slider 0–100%)                      │
   │ - Max depth (Slider & input bounded to 1–20)                │
   │ - Reset Filters button                                      │
   └──────────────────────────────┬──────────────────────────────┘
                                  │ onChange(nextFilters) / onReset()
                                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ ArchitectureExplorerClient State                            │
   │ - filters: GraphFilterState                                 │
   │ - selectedNodeId: string | null                             │
   └──────────────────────────────┬──────────────────────────────┘
                                  │ buildGraphQueryRequest({ context, filters })
                                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ POST /api/v1/graph/query                                    │
   │ - node_types?: string[]                                     │
   │ - edge_types?: string[]                                     │
   │ - min_confidence?: number                                   │
   │ - max_depth?: number                                        │
   │ - organization_id NOT passed (enforced by Clerk session)    │
   └──────────────────────────────┬──────────────────────────────┘
                                  │ GraphQueryResponse
                                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ Selection & Inspector Reconciliation                        │
   │ - Does selectedNodeId still exist in response.nodes?        │
   │   YES ──> Keep selection & synchronized NodeInspectorPanel  │
   │   NO  ──> Safely clear selectedNodeId & empty inspector     │
   └──────────────────────────────┬──────────────────────────────┘
                                  │
                                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ React Flow GraphCanvas                                      │
   │ Renders updated filtered nodes and edges deterministically  │
   └─────────────────────────────────────────────────────────────┘
```

### Core Invariants Preserved

1. **Backend as Source of Graph Truth**:
   Filtering is not performed by arbitrarily hiding nodes or running client-side graph algorithms. All query filters are communicated through `GraphQueryRequest` (`node_types`, `edge_types`, `min_confidence`, `max_depth`), preserving the backend recursive CTE's traversal correctness and depth guarantees.
2. **Deterministic Filter State & Reset**:
   Filter state is represented as a focused immutable interface (`GraphFilterState`). Reset restores `DEFAULT_GRAPH_FILTERS` (unconstrained) without altering repository context, analysis run context, or authentication.
3. **Selection & Inspector Synchronization**:
   When filters remove the currently selected node from the graph, `selectedNodeId` is cleared, safely returning `NodeInspectorPanel` and `EvidenceTrail` to their default empty states without error.
4. **Race Condition Prevention**:
   Effect-level cleanup and cancellation ensure slow or out-of-order network responses never overwrite newer filter queries.
5. **Database Boundary Protection**:
   `apps/web` does **not** import `@fluxora/db`, execute SQL queries, or connect directly to PostgreSQL.
6. **Hard Depth Limits**:
   The browser UI enforces `HARD_MAX_TRAVERSAL_DEPTH = 20`. Traversal bounds cannot exceed backend invariants.

### Scope Boundary & Next Roadmap Item

Step 37 does NOT:
- Implement clustering or Level of Detail (LOD) pre-aggregation (Step 38);
- Implement live WebSocket invalidation or `graph.updated` subscriptions (Step 39);
- Implement final Step 40 visual polish;
- Implement PR change-impact or simulation UI (Phase 6 / Phase 8);
- Implement AI-driven explanations (Phase 9);
- Introduce Zustand, Redux, Jotai, or another state-management library.

With Global Step 37 complete, the next official Phase 5 roadmap item is **Step 38: Graph Performance & LOD (Clustering, Virtualization, Level of Detail)**.

---

## Global Step 38 — Graph Clustering / Level-of-Detail (LOD)

### Overview & Objective

Global Step 38 adds deterministic client-side Level-of-Detail (LOD) and visual aggregation to the Architecture Explorer.

As repository graphs expand to thousands of AST symbols, rendering every node at low zoom levels produces unreadable visual clutter and degrades browser frame rates. Step 38 ties visual granularity to the React Flow viewport zoom level:
- **`overview` (`zoom < 0.6`)**: Shows high-level architectural components (`application`, `service`, `database`, `package`), reducing visual density.
- **`module` (`0.6 <= zoom < 1.1`)**: Displays module-level structures, routes, APIs, and event channels (`module`, `api`, `event`).
- **`detail` (`zoom >= 1.1`)**: Reveals fine-grained code symbols (`symbol`) with complete call and declaration edges.

### Architecture & Data Flow

```
   ┌─────────────────────────────────────────────────────────────┐
   │ React Flow Viewport Zoom Change                             │
   │ onMoveEnd(viewport) ──> zoom                                │
   └──────────────────────────────┬──────────────────────────────┘
                                  │
                                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ getLodLevelFromZoom(zoom)                                   │
   │ - zoom < 0.6   ──> "overview"                               │
   │ - 0.6 <= zoom < 1.1 ──> "module"                            │
   │ - zoom >= 1.1  ──> "detail"                                 │
   └──────────────────────────────┬──────────────────────────────┘
                                  │
                                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ computeLodGraph({ nodes, edges, lod, selectedNodeId })      │
   │ 1. Filter nodes by LOD priority                             │
   │ 2. Always preserve selectedNodeId (Selected Node Immunity)  │
   │ 3. Prune dangling edges (both endpoints must be visible)    │
   │ 4. Retain exact domain IDs and stable source ordering       │
   └──────────────────────────────┬──────────────────────────────┘
                                  │
                                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ mapDomainGraphToFlow & NodeRenderer                         │
   │ Renders visible nodes and edges cleanly in React Flow       │
   └─────────────────────────────────────────────────────────────┘
```

### Core Invariants Preserved

1. **Presentation Layer Isolation**:
   LOD is strictly a visual projection. The backend `POST /api/v1/graph/query` remains the sole authority for graph truth. The browser does not perform BFS/DFS or graph discovery.
2. **Selected Node Immunity**:
   If a node is selected (`selectedNodeId`), it is **always visible** across all zoom tiers. Selection state, `NodeInspectorPanel`, and `EvidenceTrail` are never broken by zoom changes.
3. **No Dangling Edges**:
   Edges are included if and only if both source and target nodes are in the visible node set.
4. **Stable Identity Guarantee**:
   All node IDs, edge IDs, and canonical IDs remain exact and deterministic. No synthetic clusters or random IDs are fabricated.
5. **Composability with Step 37 Filters**:
   LOD filters are applied over the authoritative response of Step 37 filters; LOD never re-introduces nodes filtered out by the user.
6. **No External Dependencies**:
   Implemented using pure TypeScript functions and React Flow hooks without adding external libraries.

### Scope Boundary & Next Roadmap Item

Step 38 does NOT:
- Implement live WebSocket invalidation or `graph.updated` subscriptions (Step 39);
- Implement final Step 40 loading/empty/error UI polish;
- Modify backend CTE recursive traversal or database schemas;
- Introduce synthetic cluster abstractions that distort evidence provenance.

With Global Step 38 complete, the next official Phase 5 roadmap item is **Step 39: Live Updates & Analysis Invalidation**.

---

## Global Step 39 — WebSocket Live Updates & Analysis Invalidation

### Overview & Objective

Global Step 39 connects the existing `graph.updated` domain event bus to the Architecture Explorer. Authenticated clients receive real-time graph-update notifications for their tenant and refresh the displayed graph safely and deterministically.

Rather than requiring manual page reloads or running continuous database-draining polling loops, Step 39 wires the explorer directly into the existing Step 32 outbox and WebSocket architecture (`apps/api/src/ws/`). The WebSocket operates strictly as an **invalidation channel**: receipt of a relevant event triggers a fresh `POST /api/v1/graph/query`, ensuring that the backend recursive CTE remains the sole source of graph truth.

### Architecture & Data Flow

```
 Worker Ingestion / Analysis Pipeline
               │
               ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ 1. Ingestion completes, commits nodes/edges in PostgreSQL   │
 │ 2. Outbox event persisted: type = "graph.updated"           │
 │ 3. pg_notify('fluxora_events', envelope) triggered          │
 └──────────────────────────────┬──────────────────────────────┘
                                │ PostgreSQL LISTEN/NOTIFY
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ PostgresEventListener (apps/api/src/ws/listener.ts)         │
 │ - Forwards notification envelope to WebSocketHub            │
 └──────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ WebSocketHub (apps/api/src/ws/hub.ts)                       │
 │ - Matches client organizationId with envelope.organization_id │
 │ - Broadcasts solely to authenticated tenant sockets         │
 └──────────────────────────────┬──────────────────────────────┘
                                │ RFC 6455 WebSocket
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ Explorer WebSocket Client (apps/web/src/events/)            │
 │ - Subprotocol auth: ["bearer." + sessionToken]              │
 │ - Bounded exponential backoff (max 5 retries, 1s - 10s)     │
 │ - Strict teardown & timer cancellation on unmount           │
 └──────────────────────────────┬──────────────────────────────┘
                                │ Valid & Relevant Event
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ ArchitectureExplorerClient Refetch Cycle                    │
 │ 1. Validates repository_id and analysis_run_id              │
 │ 2. Dispatches POST /api/v1/graph/query                      │
 │ 3. Preserves current Step 37 filters (types, depth, conf)   │
 │ 4. Replaces displayed graph with fresh authoritative data   │
 │ 5. Preserves Step 38 LOD tier and viewport pan/zoom         │
 │ 6. Synchronizes Step 36 selection (retains or safely clears)│
 └─────────────────────────────────────────────────────────────┘
```

### Core Invariants Preserved

1. **WebSocket as Invalidation Signal, Graph Query as Source of Truth**:
   The client never mutates its graph state directly from differential event payloads. The backend recursive CTE remains the sole engine determining topological structure, reachable depth, and confidence thresholds.
2. **Server-Authoritative Tenant Isolation**:
   The browser never supplies `organization_id` for WebSocket subscriptions. Tenancy is derived server-side from the verified Clerk session token via `Sec-WebSocket-Protocol: bearer.<jwt>`.
3. **No Polling Fallback**:
   The system does not fall back to HTTP polling. If the WebSocket connection is unavailable or interrupted, the explorer continues to function seamlessly with its current loaded state.
4. **Race-Condition & Stale Response Protection**:
   Effect-level cancellation and sequence generation tracking ensure slow out-of-order responses from earlier queries cannot overwrite newer authoritative graph data.
5. **Selection & LOD Continuity**:
   If the currently selected node exists in the refreshed graph, `selectedNodeId` is preserved and the inspector stays open. If the node was deleted or filtered out, selection is safely reset to `null`. Step 38 LOD is reapplied to the fresh graph data without resetting viewport zoom or pan.
6. **Strict Lifecycle & Clean Teardown**:
   Unmounting the explorer or navigating between repositories cancels any scheduled backoff timers, unregisters all event listeners, and cleanly closes the underlying socket. React Strict Mode duplicate mounting is handled gracefully without leaking orphaned connections.

### Scope Boundary & Next Roadmap Item

Step 39 does NOT:
- Implement Step 40 loading/empty/error UI polish, skeleton animations, or visual refinements;
- Modify backend recursive CTE traversal logic or database schemas;
- Add client-side BFS/DFS or client-side synthetic clustering;
- Introduce direct database imports or SQL execution in `apps/web`.

With Global Step 39 complete, the next official Phase 5 roadmap item is **Step 40: Explorer Polish (Loading, Empty, and Error States)**.


---

## Global Step 40 — Final Architecture Explorer UI Polish

### Overview & Objective

Global Step 40 concludes Phase 5 (Architecture Explorer UI) by delivering production-quality UX feedback across all graph query lifecycle and connection states.

The existing backend, graph semantics, query API (`POST /api/v1/graph/query`), Step 37 filters, Step 38 level-of-detail (LOD), Step 36 node inspector/evidence trail, and Step 39 WebSocket invalidation remain authoritative and unchanged. Step 40 is strictly a presentation and UX hardening step that eliminates blank or unexplained UI states, adds non-blocking background refresh feedback, provides clear actionable error and empty states, displays live connection health, and ensures lightweight accessibility compliance.

### State Model Architecture

The explorer explicitly separates the **query lifecycle** from the **live WebSocket connection status**:

```
                         ┌──────────────────────────────────────────┐
                         │              Explorer State              │
                         │                                          │
                         │   Query Lifecycle (ExplorerState):       │
                         │   • loading                              │
                         │   • ready                                │
                         │   • empty                                │
                         │   • not_ready                            │
                         │   • error                                │
                         │                                          │
                         │   Connection Status:                     │
                         │   • connected                            │
                         │   • reconnecting                         │
                         │   • disconnected                         │
                         │                                          │
                         │   Supplementary Flags:                   │
                         │   • isRefreshing (boolean)               │
                         │   • refreshError (string | null)         │
                         └──────────────────────────────────────────┘
```

1. **Query Lifecycle (`ExplorerState`)**:
   - `loading`: Initial query in flight; no graph data loaded yet. Full-screen `ExplorerLoadingState` with accessible spinner and announcement.
   - `ready`: Graph query succeeded with ≥ 1 renderable nodes. Renders `GraphCanvas`, `GraphFilters`, and `NodeInspectorPanel`.
   - `empty`: Graph query succeeded but returned 0 renderable nodes for active filters. Renders `ExplorerEmptyState` with guidance to adjust filters.
   - `not_ready`: Repository analysis is still running or pending. Renders `ExplorerAnalysisNotReady` with distinct icon (⏳) and guidance.
   - `error`: Initial query failed (network, auth, or server error). Renders `ExplorerErrorState` with retry button and accessible alert role.

2. **Background Refresh & Stale-Data Preservation**:
   - When a refetch is triggered (via `graph.updated` WebSocket invalidation, filter changes, or retry) and an existing graph is already displayed (`ready`), the current graph remains visible.
   - A non-blocking `ExplorerUpdatingIndicator` (animated progress bar at top) signals the in-flight query.
   - If the refresh succeeds: the displayed graph updates smoothly, selection is reconciled, and LOD is reapplied.
   - If the refresh fails: the existing graph remains visible and interactive; an `ExplorerRefreshErrorBanner` displays the failure with a retry action.

3. **Live Connection Status (`ExplorerConnectionStatus`)**:
   - Derived from `ExplorerWsStatus` via `mapWsStatusToConnectionStatus()`:
     - `connected` → "Live" (green dot)
     - `connecting` → "Reconnecting" (amber dot)
     - `idle` / `disconnected` / `closed` → "Offline" (gray dot)
   - Rendered as `ExplorerConnectionBadge` in the explorer header.
   - A WebSocket disconnection or reconnection attempt **never** hides or disables an already-loaded graph.

### Component Structure

```
 apps/web/src/components/graph/
 ├── explorer-status-data.ts       <-- Pure TS component implementations & status mapping
 ├── ExplorerStatus.tsx            <-- Re-export barrel wrapper
 ├── index.ts                      <-- Package barrel re-export
 └── explorer-status.test.ts       <-- 20 focused Step 40 verification tests

 apps/web/src/app/repositories/[repoId]/explorer/
 ├── explorer-client.tsx           <-- Wired with loading/refresh/empty/error/connection states
 └── explorer-data.ts             <-- Updated ExplorerState union ("empty" status added)
```

### Core Invariants Preserved

1. **Deterministic Core & Backend Authoritativeness**:
   All graph nodes, edges, reachable paths, and evidence provenance remain strictly determined by the backend recursive CTE via `POST /api/v1/graph/query`. No client-side graph simulation, synthetic clustering, or BFS/DFS was added.
2. **Stale-Data Resilience**:
   Already-valid graph data is never destroyed because a later background refresh failed. The existing graph remains interactive under refresh failures.
3. **Single Fetch Path on Retry**:
   Manual retries increment `liveUpdateTrigger`, re-entering the standard `buildGraphQueryRequest` → `fetchGraphQuery` pipeline with current context, filters, and LOD settings intact. No secondary data-fetch path exists.
4. **WebSocket Decoupled from Graph Availability**:
   WebSocket state informs connection indicators only; an outage never blocks graph exploration. No HTTP polling fallback was introduced.
5. **Selection & LOD Continuity**:
   Selection survival is checked against refreshed node IDs (`exists ? current : null`). Zoom thresholds and LOD tier calculations remain identical to Step 38.
6. **Accessible Presentation**:
   Appropriate ARIA roles (`role="status"`, `role="alert"`, `aria-live="polite"`, `aria-live="assertive"`) and descriptive accessible names (`aria-label`) are used across all status and retry elements.

### Scope Boundary & Phase 5 Completion

Step 40 does NOT:
- Add backend API endpoints, database tables, or migrations;
- Alter WebSocket authentication, routing, or event contracts;
- Modify traversal algorithms, blast-radius queries, or RLS policies;
- Introduce Phase 6 functionality (PR impact analysis, GitHub webhooks, diff traversal).

With Global Step 40 verified, **Phase 5 (Architecture Explorer UI) is officially complete**. The Architecture Explorer is production-ready.

---

## Global Step 41 — GitHub Pull Request Webhook Handling

### Overview & Objective

Global Step 41 begins Phase 6 (PR Impact Analysis) by establishing the secure ingestion boundary for GitHub pull request events.

It implements the HTTP webhook endpoint (`/api/v1/webhooks/github` and `/api/v1/github/webhooks`), timing-safe HMAC-SHA256 signature verification over the raw incoming request body, event and action filtering (`pull_request.opened` and `pull_request.synchronize`), payload validation, server-side tenant association from stored GitHub App installations, deterministic event normalization, and asynchronous handoff to the PostgreSQL-backed job queue with delivery idempotency.

Step 41 strictly focuses on webhook handling and queue handoff. Database persistence for pull requests, changed-file/diff extraction, graph traversal, and impact analysis are deferred to subsequent Phase 6 steps.

### Webhook Processing Pipeline

```
GitHub Delivery (POST /api/v1/webhooks/github)
                     ↓
  1. Read Raw Body (max 1MB cap, no early JSON parsing)
                     ↓
  2. HMAC-SHA256 Verification (timingSafeEqual over raw bytes)
       ├─ Missing/Invalid Signature → 401 Unauthorized
       └─ Secret Unconfigured → 500 Internal Error
                     ↓
  3. Event Type Filter (X-GitHub-Event: "pull_request")
       └─ Unrelated Event → 200 OK { status: "ignored" }
                     ↓
  4. Parse JSON & Filter Action ("opened" | "synchronize")
       ├─ Malformed JSON → 400 Bad Request
       └─ Unsupported Action → 200 OK { status: "ignored" }
                     ↓
  5. Validate Required Fields (repo ID, PR number, installation ID, base/head)
       └─ Missing/Malformed → 400 Bad Request
                     ↓
  6. Server-Side Tenant Resolution (lookup github_installations)
       └─ Unmapped Installation → 404 Not Found (no work enqueued)
                     ↓
  7. Deterministic Normalization (NormalizedPullRequestWebhookPayload)
                     ↓
  8. Enqueue Asynchronous Job (pull_request.webhook)
       └─ Idempotency Key: pull_request.webhook:${deliveryId}
                     ↓
  9. Fast Acknowledgment (200 OK { status: "accepted", jobId })
```

### Key Architectural Invariants

1. **Byte-Accurate Signature Verification**:
   Signatures are verified strictly against the raw request body buffer before any JSON parsing. Comparison uses `crypto.timingSafeEqual` with buffer length validation to prevent timing attacks.
2. **Server-Side Tenant Derivation**:
   Webhooks are unauthenticated requests. Incoming payloads are never trusted for tenant identity. The tenant `organization_id` is derived strictly from the internal `github_installations` table using the verified `installation.id`. Unmapped installations return `404 Not Found` without enqueuing any downstream work.
3. **Delivery Idempotency**:
   GitHub's `X-GitHub-Delivery` GUID forms the idempotency key `pull_request.webhook:${deliveryId}`. The PostgreSQL `jobs` table unique constraint (`organization_id`, `idempotency_key`) prevents duplicate job creation across delivery retries.
4. **Decoupled Asynchronous Handoff**:
   No impact analysis, AST parsing, or graph traversal occurs synchronously in the webhook handler. Webhook responses acknowledge immediately (sub-100ms), well below GitHub's 10-second timeout.
5. **No Secret Leakage**:
   Webhook secrets and authorization credentials are never logged or exposed in responses or error payloads.
6. **Zero Speculative Database Migrations**:
   Step 41 reuses the existing `github_installations` and `jobs` schema with zero new database migrations.

### Scope Boundary Against Steps 42–47

Step 41 does NOT:
- Create `PullRequest` database tables or migrations (Step 42);
- Store changed files or git diffs (Step 42);
- Implement the Impact Analysis Engine or BFS/DFS symbol traversal (Step 43);
- Persist `ImpactAnalysis` records or evidence links (Step 44);
- Implement impact analysis REST endpoints (Step 45);
- Implement frontend change-mode overlay on GraphCanvas (Step 46);
- Execute golden-fixture PR impact validation (Step 47).

---

## Global Step 42 — PullRequest + Changed-File/Diff Storage

### Overview & Objective

Global Step 42 implements the durable, multi-tenant persistence layer for pull requests, changed files, and unified git diff/patch data, and extends the background worker harness to process Step 41's normalized `pull_request.webhook` jobs into this storage model.

This step establishes the persisted source of truth that the downstream Impact Analysis Engine (Step 43) will query to calculate symbol diffs and change-impact propagation.

### Data Model & Database Migration

Migration `0017_pull_requests_and_diff_storage.sql` establishes two normalized tables under PostgreSQL Row-Level Security:

1. **`pull_requests`**:
   - Primary Key: `id` (UUID).
   - Tenant Scope: `organization_id` (UUID, Foreign Key to `organizations(id)`).
   - Repository Association: `repository_id` (UUID, Foreign Key to `repositories(id)`).
   - Identity & Revisions: `github_pr_id`, `number`, `title`, `url`, `base_ref`, `base_sha` (40-char SHA), `head_ref`, `head_sha` (40-char SHA), `status` (`'open' | 'closed' | 'merged'`).
   - Audit & Tracking: `author_login`, `author_id`, `last_delivery_id`, `created_at`, `updated_at`.
   - Unique Constraint: `CONSTRAINT uq_pull_requests_repo_number UNIQUE (repository_id, number)`.

2. **`pull_request_files`**:
   - Primary Key: `id` (UUID).
   - PR Association: `pull_request_id` (UUID, Foreign Key to `pull_requests(id)` on delete cascade).
   - File Path & Rename: `path` (relative file path), `previous_path` (populated when renamed).
   - Modification Status: `status` (`'added' | 'modified' | 'removed' | 'renamed'`).
   - Metrics: `additions`, `deletions`, `changes` (non-negative integers).
   - Unified Diff Storage: `patch` (TEXT), `patch_truncated` (BOOLEAN).
   - Blob References: `base_sha`, `head_sha` (optional 40-char commit/blob SHAs).
   - Unique Constraint: `CONSTRAINT uq_pull_request_files_pr_path UNIQUE (pull_request_id, path)`.

### Multi-Tenant Row-Level Security (RLS)

- Strict tenant isolation is enforced at the database level with `FORCE ROW LEVEL SECURITY`.
- `pull_requests` evaluates `organization_id = fluxora_current_org_id()`.
- `pull_request_files` evaluates tenant isolation via the parent relationship using `fluxora_pull_request_in_current_tenant(pull_request_id)`:
  ```sql
  CREATE OR REPLACE FUNCTION fluxora_pull_request_in_current_tenant(target_pull_request_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
  AS $$
    SELECT EXISTS (
      SELECT 1
      FROM pull_requests
      WHERE id = target_pull_request_id
        AND organization_id = fluxora_current_org_id()
    );
  $$;
  ```
- Cross-tenant access is physically impossible even under direct SQL queries using application roles.

### Worker Processing Architecture

```
[pull_request.webhook] Job Triggered
             │
             ▼
1. Validate Normalized Payload (action, installationId, repoId, prNumber)
             │
             ▼
2. Verify Tenant Isolation (job.organizationId === payload.organizationId)
             │
             ▼
3. Resolve Repository (lookup by organizationId + githubRepoId)
   └─ Not found / unmapped ──> IngestionError("tenant_mismatch", retryable: false)
             │
             ▼
4. Mint GitHub App Installation Token (installationId)
             │
             ▼
5. Fetch GitHub PR Metadata (GET /repos/:owner/:repo/pulls/:number)
             │
             ▼
6. Fetch Changed Files (GET /repos/:owner/:repo/pulls/:number/files, paginated)
   └─ Apply limits: max 1,000 files, 512 KB per patch, 10 MB total
             │
             ▼
7. Atomically Save in PostgreSQL Transaction (`savePullRequestWithFiles`)
   ├─ Upsert `pull_requests` ON CONFLICT (repository_id, number) DO UPDATE
   ├─ Delete existing `pull_request_files` for this PR
   └─ Insert current `pull_request_files` records
             │
             ▼
8. Complete Job & Record OpenTelemetry Spans
```

### Core Invariants Preserved

1. **Deterministic Core vs. Probabilistic Edge**:
   Pull request metadata and diff representations are 100% deterministic, pulled directly from GitHub APIs, and stored with strict constraints. No LLMs or generative models are involved.
2. **Atomic Consistency (`savePullRequestWithFiles`)**:
   Updating pull request metadata and replacing changed files occurs within a single PostgreSQL transaction (`withTenant`). A failure in any file insertion or constraint rolls back the entire operation.
3. **Network I/O Outside Database Transactions**:
   All GitHub API requests, token minting, and pagination occur *prior* to opening the database transaction, preventing connection pool starvation.
4. **Delivery Idempotency**:
   Repeated delivery of the same webhook payload updates the existing PR and replaces its files deterministically, resulting in identical database state without duplicates or errors.
5. **Zero Secret Leakage**:
   GitHub App installation access tokens are minted in memory and never logged, exposed, or persisted to PostgreSQL.
6. **Defensive Resource Caps**:
   Files per PR (max 1,000), patch size (max 512 KB), and total patch bytes (max 10 MB) are strictly bounded to protect worker memory and database storage.

### Scope Boundary Against Steps 43–47

Step 42 does NOT:
- Implement the Impact Analysis Engine (Step 43);
- Resolve changed files to AST symbols or traverse the dependency graph (Step 43);
- Calculate blast radius or affected endpoints/events (Step 43);
- Create `impact_analyses` tables or generate evidence records (Step 44);
- Implement impact analysis REST APIs (Step 45);
- Implement frontend change-mode overlay on GraphCanvas (Step 46);
- Execute golden-fixture PR impact validation (Step 47).

---

## Global Step 43 — Impact Analysis Engine

### Overview & Objective

Global Step 43 implements the **deterministic Impact Analysis Engine** for Fluxora. Taking a stored pull request's changed files, unified diffs (from Step 42), and the repository's current graph snapshot, the engine computes the pull request's blast radius across downstream architectural dependencies.

This fulfills **Global Step 43** of **Phase 6: PR Impact Analysis** as defined by `docs/architecture/17-implementation-roadmap.md` and `docs/architecture/05-component-responsibilities.md §5.9`.

### Architecture & Pipeline

```
PullRequest Changed Files (path, status, patch)
                       │
                       ▼
    1. Diff Hunk Parsing (`parsePatchModifiedLines`)
       └─ Extract affected line ranges from unified diff headers
                       │
                       ▼
    2. Changed-Symbol Resolution (`resolveFilesToSeeds`)
       ├─ Intersect line numbers with AST symbol ranges [lineStart..lineEnd]
       ├─ Fallback to file-level symbols if patch is unaligned/missing
       └─ Track non-code/unmatched files in `unresolvedFiles`
                       │
                       ▼
    3. Multi-Seed BFS Traversal (`computeImpactAnalysis` / `traverseGraph`)
       ├─ Seeds initialized at depth = 0, confidence = 1.0
       ├─ Downstream traversal across graph_edges (source -> target)
       ├─ Visited set prevents infinite loops on cyclic dependencies
       ├─ Deduplication to shallowest path when reached by multiple seeds
       └─ Bounded depth: default 5 hops, hard cap 20 hops
                       │
                       ▼
    4. Taxonomy Classification & Metrics
       ├─ Direct Impacts (depth = 1) vs Downstream Impacts (depth >= 2)
       ├─ Affected APIs (api_route)
       ├─ Affected Events (event_producer, event_consumer, event)
       ├─ Affected Services (service)
       └─ Workflow Impact Summary (aggregate counts, affected services, max depth)
                       │
                       ▼
    5. Confidence Decay & Truncation
       ├─ Geometric confidence decay: C = 1.0 * (0.9 ^ depth)
       └─ Explicit truncation flag if maxDepth reached with outgoing edges
                       │
                       ▼
    6. Deterministic Output Normalization
       └─ Sort results by depth ASC, confidence DESC, nodeId ASC
```

### Core Invariants Preserved

1. **Deterministic Core vs. Probabilistic Edge**:
   Dependency graph traversal, blast-radius calculation, and change-impact propagation are 100% deterministic and statically computed. No LLMs or generative models are involved.
2. **Multi-Seed Shallowest Path Deduplication**:
   When multiple changed symbols or alternate graph paths reach the same downstream node, the engine retains the shallowest path (shortest hop distance) to preserve maximal confidence and avoid duplicate findings.
3. **Monotonic Confidence Decay**:
   Confidence strictly decays with depth ($C = 1.0 \times 0.9^d$). Deeper hops never increase confidence over a shallower path.
4. **Explicit Truncation Reporting**:
   If graph exploration reaches the configured `maxDepth` ceiling (default 5, hard maximum 20) and untraversed downstream edges exist, the result explicitly reports `truncated: true`. Traversal is never unbounded and truncation is never silently ignored.
5. **Multi-Tenant Row-Level Security (RLS)**:
   All database queries are executed within `withTenant(pool, organizationId, ...)` and evaluated against PostgreSQL `FORCE ROW LEVEL SECURITY`. Pull requests not belonging to the authenticated tenant are rejected with `PullRequestNotFoundError`.
6. **Pure In-Memory Calculation (Step 43 Boundary)**:
   Step 43 produces an evidence-ready, in-memory `ImpactAnalysisResult`. It does not create database tables, insert rows into `impact_analyses`, or generate `evidence` records (which are strictly owned by Step 44).

### Scope Boundary Against Steps 44–47

Step 43 does NOT:
- Create `impact_analyses` database tables or execute migrations (Step 44);
- Persist `ImpactAnalysis` records or insert evidence rows via `EvidenceWriter` (Step 44);
- Implement impact analysis REST endpoints in `apps/api` (Step 45);
- Implement the frontend change-mode overlay on GraphCanvas (Step 46);
- Execute golden-fixture PR impact validation (Step 47);
- Add AI narrative explanations (Step 48+).

---

## Global Step 44 — ImpactAnalysis Persistence + Evidence

### Overview & Objective

Global Step 44 implements durable, multi-tenant persistence for the deterministic change-impact results computed by the Step 43 Impact Analysis Engine, and integrates `EvidenceWriter` to generate first-class `impact_finding` evidence records.

This fulfills **Global Step 44** of **Phase 6: PR Impact Analysis** as defined by `docs/architecture/17-implementation-roadmap.md`, `docs/architecture/05-component-responsibilities.md §5.8 and §5.9`, and `docs/architecture/06-database-schema.md §6.3`.

### Architecture & Conceptual Flow

```
PullRequest (PR metadata + changed files + diffs from Step 42)
                    │
                    ▼
Step 43 Impact Analysis Engine (`analyzePullRequestImpact` / `computeImpactAnalysis`)
                    │
                    ▼
Deterministic ImpactAnalysisResult (direct/downstream findings, taxonomy, decay, truncation)
                    │
                    ▼
Step 44 Persistence Orchestration (`persistPullRequestImpactAnalysis` / `saveImpactAnalysis`)
   ├─ 1. Multi-Tenant Validation & Scoping (RLS verification via `withTenant`)
   ├─ 2. Evidence Derivation (`EvidenceWriter.createImpactFindingEvidence`)
   │     ├─ subject_type: 'impact_finding'
   │     ├─ subject_id: finding.node.id
   │     ├─ Deterministic evidence ID derivation via SHA-256
   │     └─ Metadata: impactAnalysisId, pullRequestId, depth, propagation path, supporting evidence
   ├─ 3. Finding Evidence Linkage (evidenceIds populated on each ImpactFinding)
   ├─ 4. Atomic PostgreSQL Transaction
   │     ├─ INSERT INTO impact_analyses ... ON CONFLICT (id) DO UPDATE ...
   │     └─ EvidenceWriter.writeEvidenceBatchTx(client, evidenceRecords)
   │
   ▼
Committed ImpactAnalysis row + durable impact_finding Evidence records
```

### Data Model & Database Migration

Migration `0018_impact_analyses_storage.sql` adds the `impact_analyses` table with strict Row-Level Security:

1. **Table Schema (`impact_analyses`)**:
   - `id`: `uuid PRIMARY KEY DEFAULT gen_random_uuid()`
   - `pull_request_id`: `uuid NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE`
   - `analysis_run_id`: `uuid NOT NULL REFERENCES analysis_runs (id) ON DELETE CASCADE`
   - `status`: `text NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'running', 'completed', 'failed'))`
   - `direct_impact`: `jsonb NOT NULL DEFAULT '[]'::jsonb`
   - `downstream_impact`: `jsonb NOT NULL DEFAULT '[]'::jsonb`
   - `affected_apis`: `jsonb NOT NULL DEFAULT '[]'::jsonb`
   - `affected_events`: `jsonb NOT NULL DEFAULT '[]'::jsonb`
   - `affected_services`: `jsonb NOT NULL DEFAULT '[]'::jsonb`
   - `workflow_impact_summary`: `jsonb NOT NULL DEFAULT '[]'::jsonb`
   - `unresolved_files`: `jsonb NOT NULL DEFAULT '[]'::jsonb`
   - `truncated`: `boolean NOT NULL DEFAULT false`
   - `truncation_reason`: `text`
   - `max_depth_reached`: `integer NOT NULL DEFAULT 0 CHECK (max_depth_reached >= 0)`
   - `execution_metrics`: `jsonb NOT NULL DEFAULT '{}'::jsonb`
   - `metadata`: `jsonb NOT NULL DEFAULT '{}'::jsonb`
   - `created_at`: `timestamptz NOT NULL DEFAULT now()`

2. **Indexes**:
   - `impact_analyses_pull_request_id_idx` on `(pull_request_id)`
   - `impact_analyses_analysis_run_id_idx` on `(analysis_run_id)`
   - `impact_analyses_pull_request_created_at_idx` on `(pull_request_id, created_at DESC)`
   - `evidence_impact_analysis_id_idx` partial index on `evidence ((metadata->>'impactAnalysisId')) WHERE subject_type = 'impact_finding'`

3. **Row-Level Security & Tenant Isolation**:
   - Helper function: `fluxora_impact_analysis_in_current_tenant(p_impact_analysis_id uuid)`
   - Table security: `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`
   - SELECT policy: `fluxora_pull_request_in_current_tenant(pull_request_id)`
   - INSERT & UPDATE policies: `fluxora_pull_request_in_current_tenant(pull_request_id) AND fluxora_analysis_run_in_current_tenant(analysis_run_id)`
   - Cross-tenant queries return `null` / `[]` and cross-tenant mutations are blocked by PostgreSQL engine policies.

### EvidenceWriter Integration

`EvidenceWriter.createImpactFindingEvidence` extends the Evidence Writer layer:
- Links every affected graph node finding to an explicit `impact_finding` evidence row.
- Preserves exact source location coordinates (`lineStart`, `lineEnd`, `columnStart`, `columnEnd`) from node metadata/AST provenance.
- Records propagation depth, path array, and supporting graph edge evidence IDs in evidence metadata.
- Updates finding objects so `evidenceIds` includes the newly created evidence ID.
- Re-running persistence produces identical deterministic evidence UUIDs and uses idempotent `ON CONFLICT (id) DO UPDATE`.

### Repository Surface (`packages/db`)

- `saveImpactAnalysis(pool, input)`: Atomically persists analysis and evidence within `withTenant`.
- `saveImpactAnalysisTx(client, input)`: Transactional save logic supporting caller-managed transactions.
- `persistPullRequestImpactAnalysis(pool, options)`: End-to-end execution of Step 43 engine + Step 44 persistence.
- `getImpactAnalysisById(pool, orgId, id)`: Tenant-scoped retrieval by analysis ID.
- `getLatestImpactAnalysisForPullRequest(pool, orgId, prId)`: Returns the newest analysis for a PR.
- `listImpactAnalysesForPullRequest(pool, orgId, prId)`: Returns chronological history of analyses for a PR.
- `listImpactFindingEvidence(pool, orgId, impactAnalysisId)`: Retrieves all evidence records generated for an impact analysis.

### Scope Boundary Against Steps 45–47

Step 44 does NOT:
- Implement REST API endpoints (`POST /pull-requests/:id/analyze-impact`, `GET /impact-analyses/:id`) in `apps/api` (Step 45 owns this);
- Implement the change-mode visual overlay on GraphCanvas in `apps/web` (Step 46 owns this);
- Run golden-fixture PR impact validation (Step 47 owns this);
- Add AI/LLM narrative explanations (Step 48+).

---

## Global Step 45 — PR Impact Analysis API

### Overview & Objective

Global Step 45 exposes the deterministic change-impact analysis engine (Step 43) and its durable persistence store (Step 44) through authenticated, tenant-scoped, and asynchronous HTTP REST endpoints in `apps/api` and coordinates background processing through the PostgreSQL job queue and worker harness in `apps/workers`.

This fulfills **Global Step 45** of **Phase 6: PR Impact Analysis** as defined by `docs/architecture/17-implementation-roadmap.md`, `docs/architecture/05-component-responsibilities.md §5.8, §5.9, §5.14, §5.16`, `docs/architecture/06-database-schema.md §6.3`, and `docs/architecture/07-api-architecture.md`.

### Architecture & Conceptual Flow

```
1. Client POST Request
   POST /api/v1/pull-requests/:id/analyze-impact
   Authorization: Bearer <JWT>
   Idempotency-Key: <client-key>
   { "analysis_run_id": "...", "max_depth": 3, "direction": "outgoing" }
                    │
                    ▼
2. HTTP API Server (`apps/api`)
   ├─ Authenticate Bearer JWT & resolve authenticated user session
   ├─ Derive organizationId from session (reject if body contains organization_id)
   ├─ Validate pullRequestId format (UUID regex)
   ├─ Resolve PR & AnalysisRun inside tenant scope (`resolveAnalysisRunForPullRequest`)
   │  └─ Returns 404 pull_request_not_found if PR belongs to another tenant
   ├─ Compute deterministic impactAnalysisId & idempotencyKey
   ├─ Enqueue job into PostgreSQL `jobs` table (type: "pull_request.impact_analysis")
   │  └─ Deduplication via unique idempotencyKey
   └─ Return HTTP 202 Accepted:
      {
        "status": "queued",
        "job_id": "...",
        "pull_request_id": "...",
        "idempotency_key": "..."
      }
                    │
                    ▼
3. Distributed Worker Harness (`apps/workers`)
   ├─ Dequeue job payload (`parsePullRequestImpactAnalysisJobPayload`)
   ├─ Validate tenant-scoped pull request & analysis run
   ├─ Execute `persistPullRequestImpactAnalysis`:
   │  ├─ Step 43 Deterministic Impact Analysis Engine (`analyzePullRequestImpact`)
   │  ├─ Step 44 Evidence Generation (`EvidenceWriter.createImpactFindingEvidence`)
   │  └─ Step 44 Atomic Persistence (`INSERT INTO impact_analyses ... ON CONFLICT DO UPDATE`)
   └─ Mark job completed
                    │
                    ▼
4. Client GET Request
   GET /api/v1/impact-analyses/:id
   Authorization: Bearer <JWT>
                    │
                    ▼
5. Read-Only Retrieval (`apps/api`)
   ├─ Authenticate Bearer JWT & derive organizationId
   ├─ Retrieve persisted record via `getImpactAnalysisById(pool, organizationId, id)`
   │  └─ Evaluated against PostgreSQL Row-Level Security (RLS)
   ├─ If cross-tenant or missing, return 404 impact_analysis_not_found
   ├─ Pure formatting via `formatImpactAnalysisResponse` (NO recomputation)
   └─ Return HTTP 200 OK with full finding taxonomy and evidence IDs
```

### Endpoints & Contract Specifications

1. **`POST /api/v1/pull-requests/:id/analyze-impact`**:
   - **Authentication**: Requires `Authorization: Bearer <JWT>` with linked GitHub identity.
   - **Tenancy**: `organization_id` derived exclusively from auth session. Body payloads containing `organization_id` are rejected with `400 invalid_request`.
   - **Input Validation**: `pullRequestId` and optional `analysis_run_id` validated as UUIDs. Traversal options (`max_depth`, `direction`, `decay_factor`, `edge_types`, `node_types`) validated against domain constraints.
   - **Asynchronous Execution**: Graph traversal is non-blocking. Schedules job `pull_request.impact_analysis` and responds with `HTTP 202 Accepted`.
   - **Idempotency**: Honors optional `Idempotency-Key` header; deduplicates via `pull_request.impact_analysis:${prId}:${runId}:${clientKey}`.

2. **`GET /api/v1/impact-analyses/:id`**:
   - **Authentication**: Requires valid Bearer JWT.
   - **Tenancy**: Scoped to authenticated user's organization; foreign or non-existent IDs return `404 impact_analysis_not_found`.
   - **Read-Only**: Strictly reads from persisted `impact_analyses` table via `getImpactAnalysisById`. Performs zero graph traversal or diff recalculation.
   - **Response**: Returns `HTTP 200 OK` with `direct_impact`, `downstream_impact`, `affected_apis`, `affected_events`, `affected_services`, `workflow_impact_summary`, `unresolved_files`, `truncated`, `truncation_reason`, `max_depth_reached`, `execution_metrics`, and linked `evidence_ids`.

3. **Standard Error Shape**:
   - All error responses conform to `{ "error": { "code": string, "message": string, "details"?: unknown } }`.
   - Standard HTTP codes: `400` (invalid request/UUID), `401` (missing/invalid token), `403` (missing GitHub link), `404` (PR/run/analysis not found or cross-tenant), `405` (method not allowed), `500` (internal server error).

### Scope Boundary Against Steps 46–47

Step 45 does NOT:
- Implement frontend UI components, routes, or the GraphCanvas change-mode overlay in `apps/web` (Step 46 owns this);
- Run golden-fixture PR impact validation (Step 47 owns this);
- Add AI/LLM narrative explanations or scenario simulation (Step 48+).
---

## Global Step 46 — Change-Mode Overlay in Architecture Explorer

### Overview & Objective

Global Step 46 implements the frontend Change-Mode overlay within the flagship Architecture Explorer in `apps/web`. It enables software engineers and reviewers to inspect the deterministic blast radius of a pull request visually superimposed on top of the system's canonical dependency graph.

This fulfills **Global Step 46** of **Phase 6: PR Impact Analysis** as defined by `docs/architecture/17-implementation-roadmap.md`, `docs/architecture/05-component-responsibilities.md §5.9, §5.15`, `docs/architecture/07-api-architecture.md`, and `docs/architecture/10-frontend-architecture.md`.

### Architecture & Conceptual Flow

```
PR Impact Analysis (PostgreSQL `impact_analyses`, Step 44)
      │
      ▼
GET /api/v1/impact-analyses/:id (Step 45 REST API, Bearer JWT Auth)
      │
      ▼
Frontend Normalization (`normalizeImpactAnalysisResponse`)
      │  ├─ Set<string> directNodeIds
      │  ├─ Set<string> downstreamNodeIds
      │  ├─ Set<string> affectedApiNodeIds
      │  ├─ Set<string> affectedEventNodeIds
      │  ├─ Map<string, number> hopDistanceByNodeId
      │  ├─ Map<string, number> confidenceByNodeId
      │  └─ Map<string, readonly string[]> evidenceIdsByNodeId
      ▼
ChangeModeState (`NormalizedChangeModeState`)
      │
      ▼
GraphCanvas / NodeRenderer Overlay
      │  ├─ Direct change: Crimson border (#dc2626) + glowing ring + "Direct Change" badge
      │  ├─ Downstream: Chromatic amber (#d97706 -> #fbbf24) + "Downstream (hop N)" badge
      │  ├─ Contract badges: "API" (emerald) and "Event" (purple)
      │  ├─ Uncertainty: Dashed border + "(low)" badge for confidence < 0.70
      │  └─ Unaffected nodes: De-emphasized (opacity: 0.45, grayscale: 30%)
      ▼
Selection + NodeInspectorPanel + Evidence Trail
      ├─ Selection priority: Primary blue (#2563eb) strictly overrides change-mode styles
      ├─ "PR Impact Analysis" card rendered in NodeInspectorPanel
      └─ Clickable links to durable AST / diff provenance evidence IDs
```

### Data & State Ownership

1. **Server Authoritative Data**:
   - The impact analysis findings are computed strictly server-side by the Step 43 deterministic engine and persisted in PostgreSQL under Step 44.
   - The browser never executes graph traversal, symbol extraction, AST parsing, or diff calculations.
   - The frontend communicates exclusively with `GET /api/v1/impact-analyses/:id` via Bearer JWT. It never connects to PostgreSQL, Redis, MinIO, or GitHub directly.

2. **Frontend State Ownership (`NormalizedChangeModeState`)**:
   - The normalized change-mode state is managed in the client component `ExplorerClient`.
   - Node lookups are optimized to $O(1)$ complexity via `Set<string>` and `Map<string, number>`.
   - Multi-seed shallowest path deduplication resolves conflicting findings deterministically (direct takes priority over downstream, lowest hop distance wins, highest confidence wins, evidence IDs deduplicated and sorted lexicographically).
   - URL synchronization (`?impact_id=<uuid>`) enables link-sharing without state divergence.

### Visual Priority & Presentation Hierarchy

1. **Selection Priority**: Selection state (`isSelected`) has highest visual priority. When a user selects any node—whether direct, downstream, or unaffected—the primary blue border (`#2563eb`) and focus ring take precedence.
2. **Direct Changes**: Crimson border (`#dc2626`) with 3px glowing ring and red badge (`Direct Change`).
3. **Downstream Impacts**: Graduated chromatic amber borders (`#d97706` for hop 1, `#f59e0b` for hop 2, `#fbbf24` for hop 3+) and amber badge (`Downstream (hop N)`).
4. **Architectural Contracts**: Emerald badge (`API`) for HTTP/RPC endpoints; purple badge (`Event`) for async message producers/consumers.
5. **Confidence & Uncertainty**: Findings with confidence $< 0.70$ render with dashed borders (`2px dashed <color>`) and `(low)` tag.
6. **Unaffected Nodes**: Softened with `opacity: 0.45` and `filter: grayscale(30%)` while preserving full interactivity.

### Filter and Level-of-Detail (LOD) Interaction

- **GraphFilters**: Filtering by node type, edge type, confidence threshold, or depth remains fully operational and does not alter or erase the normalized impact state.
- **Level-of-Detail (LOD)**: Zoom-driven clustering (System, Module, Detail tiers) continues to aggregate nodes smoothly. LOD is never globally disabled.
- **Slice Metrics**: If impacted nodes are excluded by current filters or LOD tiers, the canvas LOD badge dynamically displays an active slice counter (e.g. `• 3/5 impacted visible`), preventing false assumptions of safety.

### Error, Pending, and Truncated States

- **PENDING / RUNNING**: When a server analysis is in progress, the UI displays a status badge and polls every 4 seconds until completion.
- **ERROR**: Network or server errors display a prominent warning banner with an actionable "Retry" button, preserving the underlying architecture graph without interruption.
- **TRUNCATED**: If blast-radius traversal exceeded the configured `maxDepth` ceiling, `ChangeModeBar` renders an amber warning banner detailing `truncation_reason` and `max_depth_reached`.
- **UNRESOLVED FILES**: Non-code files that could not be mapped to graph nodes are surfaced in an expandable drawer with clear path-by-path rationales.

### Scope Boundary Against Steps 47–48

Step 46 does NOT:
- Implement Golden-Fixture PR Impact Validation (Step 47 owns this);
- Modify backend impact-analysis engine, persistence, DB schema, worker logic, webhook handling, or API contracts;
- Add AI/LLM narrative explanations or scenario simulation (Step 48+).

---

## Global Step 47 — Golden-Fixture PR Impact Validation

### Overview & Objective

Global Step 47 is the culminating step of **Phase 6: PR Impact Analysis** as defined by `docs/architecture/17-implementation-roadmap.md`, `docs/architecture/12-testing-strategy.md §12.1–§12.4`, `docs/architecture/05-component-responsibilities.md §5.7–§5.9, §5.16`, and `docs/architecture/06-database-schema.md`.

It establishes an automated, end-to-end deterministic validation pipeline proving that for a real-world repository and recorded golden Pull Request fixture, Fluxora's deterministic PR impact analysis pipeline produces the exact hand-verified direct and downstream impact findings across the core traversal engine, PostgreSQL persistence, and API retrieval contracts.

### Architecture & Verification Pipeline

```
Golden PR Manifest (fixtures/golden/pr-impact-manifest.json)
      │
      ├─ Recorded PR: "Harden subscription plan validation and grace period checks" (#42)
      ├─ Pinned Repository: "shadcn-ui/taxonomy" @ commit 298a8857c7128a0d121e7f699dfd729f23b3966d
      └─ Changed Files: lib/subscription.ts (modified), content/docs/billing.mdx (unresolved documentation)
      │
      ▼
PostgreSQL Ingestion & Graph Projection
      │
      ├─ Organizations, Repositories, Snapshots, Analysis Runs (multi-tenant RLS setup)
      ├─ AST extraction & canonical graph build: 490 nodes, 888 edges, Phase 3 pipeline
      └─ PullRequest & PullRequestFiles persisted into PostgreSQL
      │
      ▼
Step 43 Impact Analysis Engine (traverseGraph & computeImpactAnalysis)
      │
      ├─ Diff Hunk Parsing: @@ -7,4 +7,6 @@ in lib/subscription.ts
      ├─ Seed Resolution: sym:lib/subscription.ts#function:getUserSubscriptionPlan:197
      ├─ Traversal (direction: "both", maxDepth: 2, decayFactor: 0.9):
      │    ├─ Direct Impact (Depth 1): Exactly 4 module nodes (confidence = 0.90)
      │    └─ One-Hop Downstream (Depth 2): Exactly 45 nodes: 3 API routes, 14 modules, 28 symbols (confidence = 0.81)
      ├─ Affected APIs: GET /api/posts, GET /api/users/stripe, POST /api/posts
      └─ Unresolved Files: content/docs/billing.mdx (no graph nodes, no phantom nodes)
      │
      ▼
Step 44 Impact Analysis Persistence + EvidenceWriter
      │
      ├─ PostgreSQL impact_analyses table insertion
      ├─ EvidenceWriter: 49 deterministic impact_finding evidence records
      └─ Idempotency: ON CONFLICT DO UPDATE, zero duplicate evidence records
      │
      ▼
Step 45 API / Worker Job Readback Contract
      │
      ├─ processPullRequestImpactJob: Successful job execution with golden payload
      ├─ getLatestImpactAnalysisForPullRequest & getImpactAnalysisById readback
      └─ RLS Tenant Isolation: Non-member tenant receives null / empty array
      │
      ▼
Golden Ground Truth Assertion (Assert Actual == Expected)
      └─ 100% exact set equality on sorted canonical IDs, unaffected negative controls confirmed absent
```

### Golden Ground Truth & Direct vs. Downstream Semantics

1. **Seed (Depth 0)**:
   - Symbol: `sym:lib/subscription.ts#function:getUserSubscriptionPlan:197`
   - Confidence: 1.0
2. **Direct Impact (Depth 1)**:
   - Exactly 4 module nodes:
     1. `mod:app/(dashboard)/dashboard/billing/page.tsx`
     2. `mod:app/api/posts/route.ts`
     3. `mod:app/api/users/stripe/route.ts`
     4. `mod:lib/subscription.ts`
   - Confidence: $1.0 \times 0.9^1 = 0.90$
3. **One-Hop Downstream Impact (Depth 2)**:
   - Exactly 45 nodes:
     - 3 API Route Handlers:
       - `route:app/api/posts/route.ts#app-router-handler:GET:/api/posts:360`
       - `route:app/api/posts/route.ts#app-router-handler:POST:/api/posts:907`
       - `route:app/api/users/stripe/route.ts#app-router-handler:GET:/api/users/stripe:361`
     - 14 Modules: UI alerts, cards, forms, shell, header, config, auth, db, session, stripe, utils, types
     - 28 Symbols: exported functions, route handlers, config objects, type definitions
   - Confidence: $1.0 \times 0.9^2 = 0.81$
4. **Affected APIs**: `GET /api/posts`, `GET /api/users/stripe`, `POST /api/posts`
5. **Unresolved Files**: `content/docs/billing.mdx` (verified that Markdown docs do NOT become phantom nodes)
6. **Negative Controls (Unaffected Nodes)**:
   - `route:app/api/og/route.tsx#app-router-handler:GET:/api/og:238`
   - `route:app/api/webhooks/stripe/route.ts#app-router-handler:POST:/api/webhooks/stripe:561`
   - `mod:components/site-footer.tsx`
   - `sym:config/site.ts#constant:siteConfig:49`
   - `mod:lib/toc.ts`
   - `mod:app/(marketing)/page.tsx`
   All verified strictly absent from the impact sets.

### Invariants & Boundaries

1. **Deterministic Core Preserved**: No LLM, probabilistic ranking, or simulation heuristics were introduced. Traversal is 100% deterministic graph mathematics.
2. **Offline & CI-Safe**: No live GitHub API calls or external network dependencies; operates on pinned golden repository files.
3. **Strict Scope Boundaries**: Phase 6 is complete. Phase 7 (evidence hardening, AI explanations, scenario simulation) was NOT entered.

---

## Global Step 48 — Evidence Completeness Audit + Hardening

### Overview & Objective

Global Step 48 initiates **Phase 7: Evidence Engine (Hardening Pass)** per `docs/architecture/17-implementation-roadmap.md`, `docs/architecture/05-component-responsibilities.md §5.7, §5.8, §5.9`, and `docs/architecture/06-database-schema.md`.

Its mission is to audit every conclusion-producing write path in Fluxora and establish the absolute architectural guarantee of **Evidence Completeness**:
Every confirmed graph conclusion (node, edge) and change-impact finding produced by the platform MUST have corresponding immutable evidence created via `EvidenceWriter` within the same atomic database transaction.

### Conclusion-Producing Path Inventory & Hardening Matrix

| Component | Write Path | Conclusion Produced | Evidence Enforcement |
| --- | --- | --- | --- |
| **Graph Builder** | `persistGraphBuild` | `graph_nodes`, `graph_edges` | Pre-flight validation guarantees all nodes, edges, and evidence match `organizationId` and `analysisRunId`. All 8 edge types (`IMPORTS`, `CALLS`, `EXTENDS`, `EXPOSES_ROUTE`, `EMITS_EVENT`, `CONSUMES_EVENT`, `QUERIES_DB`, `WRITES`) produce traceable `graph_edge` evidence rows. |
| **Impact Analysis** | `saveImpactAnalysisTx` | `impact_analyses` row & findings | Unified finding processing via `processFinding` links every finding across all 5 categories (`directImpact`, `downstreamImpact`, `affectedApis`, `affectedEvents`, `affectedServices`) to a deduplicated, deterministic `impact_finding` evidence record. |
| **Static CI Linter** | `verifyGraphWritePaths` | AST validation of codebase | Expanded to scan all conclusion-producing files (`graph.ts`, `impact-analysis.ts`, `graph-builder.ts`, `impact-handler.ts`) for graph node/edge writes and impact persistence calls, enforcing `EvidenceWriter` invocation in CI (`pnpm lint:evidence`). |

### Core Invariants Proven

1. **Evidence Completeness**: No code path can commit or expose a graph edge or impact finding without an associated evidence record.
2. **Confidence Decay Preservation**: Depth-decayed confidence scores ($1.0 \times 0.9^{\text{depth}}$) are passed directly into evidence rows without artificial resets or rounding. Monotonic decay is verified.
3. **Transactional Atomicity**: Conclusion writes and evidence writes share a single client transaction. A simulated evidence failure triggers full database rollback, leaving zero orphan conclusions.
4. **Deterministic Identity & Idempotency**: Evidence IDs are derived via deterministic SHA-256 UUID v5. Repeated executions on the same analysis run produce 0 duplicate records.
5. **Multi-Tenant & Analysis-Run Isolation**: Evidence is strictly partitioned by `analysis_run_id` and isolated across organizations by PostgreSQL Row-Level Security (RLS).
6. **Non-Fabrication**: Source coordinates are preserved from AST when known; traversal paths are recorded in metadata. No synthetic line numbers are ever invented.
7. **Scope Boundaries**: Steps 49–51 (UI citations, visual weighting, coverage displays) and future simulation engine evidence remain strictly separated.

---

## Global Step 49 — Clickable Evidence Citation UI

### Overview & Objective

Global Step 49 continues **Phase 7: Evidence Engine** per `docs/architecture/17-implementation-roadmap.md`, `docs/architecture/08-frontend-application.md`, and `docs/architecture/22-definition-of-done.md`.

Its core objective is **Traceability**:
Turn the verified, append-only evidence produced by Fluxora into an accessible, clickable `EvidenceCitation` experience in the frontend, end-to-end. Wherever Fluxora presents a graph or blast-radius conclusion (edges, nodes with provenance, PR impact findings, and inspector details), a user can see that the conclusion is backed by evidence and click to inspect its exact provenance and navigate to the verified source location without fabricating source paths, line ranges, or commit SHAs.

### Architecture & Contract Extensions

1. **Impact Analysis API Response Contract (`@fluxora/shared-types` & `apps/api`)**:
   - Extended `ImpactAnalysisResponse` with optional `evidence?: readonly GraphQueryResponseEvidence[] | undefined`.
   - Updated `apps/api/src/http/impact-analysis.ts` and `apps/api/src/http/impact-analysis-response.ts` to join and format associated evidence records using `listImpactFindingEvidence` under strict tenant isolation.
   - Backward-compatible: retains existing finding structures (`node_id`, `evidence_ids`, `confidence`, `hop_distance`) while delivering complete evidence records to the frontend.

2. **Source Permalink & Provenance Engine (`evidence-citation-data.ts`)**:
   - **Deterministic URL Construction**: Constructs GitHub source permalinks (`https://github.com/{owner}/{repo}/blob/{commitSha|gitRef}/{filePath}#L{start}-L{end}`).
   - **Strict Non-Fabrication**: Accepts real positive numeric lines (`line_start`, `line_end`) only; never invents fake line numbers or synthetic commits.
   - **Path Traversal & Injection Defense**: Sanitizes file paths, rejecting `..`, absolute paths, colons, or URI scheme injections (`javascript:`, `data:`).
   - **Ref & Commit Validation**: Prefers pinned, immutable commit SHAs (`/^[0-9a-fA-F]{7,40}$/`) over mutable refs (`/^[a-zA-Z0-9_./-]+$/`). Rejects refs containing `..`.
   - **Honest Fallbacks**: If repository name, commit, or valid path is missing, returns `available: false` with a clear explanation (`reason`), preventing broken or fabricated URLs.
   - **Deduplication & Deterministic Ordering**: `deduplicateAndSortEvidence` deduplicates by evidence ID and sorts by file path, line start, line end, relationship description, and ID.

3. **Reusable `EvidenceCitation` & `EvidenceCitationList` (`EvidenceCitation.tsx`)**:
   - Implemented using `React.createElement` for full Vitest / Next.js SSR compatibility without external JSX transpilation overhead.
   - **Compact Mode**: Inline chip showing short file name, line badge (`L15–L45` or `L15`), confidence percentage chip (only when provided by API), and direct permalink or expanded trigger.
   - **Expanded Mode**: Full provenance inspection card displaying relationship description, file path, line range, AST symbol, analysis run, confidence, and metadata key-value pairs.
   - **Loading, Error, & Fallback States**:
     - `citation-loading-state`: Animated pulse indicator during evidence fetching.
     - `citation-error-state`: Accessible alert banner with retry/error messaging.
     - `citation-source-unavailable`: Informative tooltip explaining why source navigation is disabled (e.g. unconfigured repository or missing commit).
     - `citation-unresolved-id`: Fallback badge when evidence ID exists but record metadata is not loaded.
   - **Accessibility & Security**: Semantic HTML (`<a>`, `<button>`), accessible ARIA attributes (`role="status"`, `role="alert"`, `aria-label`), visible focus rings (`focus:ring-2 focus:ring-blue-500`), and external link security (`target="_blank" rel="noopener noreferrer"`).

4. **Integration into Graph Explorer & Change-Mode UI**:
   - **NodeInspectorPanel**:
     - Extended to support edge selection inspection (`edge` prop) displaying edge type, provenance, confidence, and an expanded `EvidenceCitation` for the edge's `evidence_id`.
     - In PR Change Mode, inspects selected nodes with compact `EvidenceCitation` chips for each linked PR impact finding.
     - Updated `EvidenceTrail` with `citation-source-link` permalinks and honest unavailable badges, preserving all legacy Step 36 test IDs.
   - **GraphCanvas**:
     - Added `selectedEdgeId` and `onEdgeClick` to support interactive edge selection and styling (`strokeWidth: 3`, `#3b82f6`).
   - **ChangeModeBar**:
     - Added expandable `impact-findings-panel` displaying all direct, downstream, API, and event impact findings with clickable `EvidenceCitationList` components and "View in graph" selection actions.
   - **Explorer Client**:
     - Threaded repository context (`repositoryName`, `commitSha`, `gitRef`) and active edge selection across `ChangeModeBar`, `GraphCanvas`, and `NodeInspectorPanel`.

### Verification & Test Matrix

- **Unit & Integration Tests**:
  - `apps/web/src/components/graph/evidence-citation.test.ts`: 26 unit & integration tests covering permalink construction, security sanitization, line formatting, deduplication, component rendering, loading/error states, edge inspection, and PR findings panel.
  - `apps/web`: 12 test files, 158 tests passing.
  - `apps/api`: 11 test files, 124 tests passing (including Test W for impact evidence readback).
- **TypeScript & Linting**:
  - `pnpm typecheck`: 0 errors across all 7 workspace packages.
  - `pnpm lint`: 0 ESLint errors across the workspace.
  - `pnpm lint:evidence`: 0 violations; all conclusion write paths invoke `EvidenceWriter`.
  - `pnpm build`: Next.js production build compiled cleanly in Turbopack.


---

## Global Step 50 — Confidence-Based Visual Weighting

### Overview & Objective

Global Step 50 continues **Phase 7: Evidence Engine** per `docs/architecture/17-implementation-roadmap.md`, `docs/architecture/08-frontend-application.md`, and `docs/architecture/22-definition-of-done.md`.

Its core objective is **Presentation Weighting**:
Visually communicate relative confidence across graph edges and impact-analysis findings in the Fluxora UI using the authoritative confidence values already computed and persisted by the backend.

**Core Invariants Preserved**:
1. **Backend is Authoritative**: Confidence is presentation information only. The frontend never recomputes, recalculates, adjusts, or simulates confidence (e.g. no frontend `0.9 ** depth` decay).
2. **Preserve Topology & Semantics**: Low-confidence edges remain visible, selectable, inspectable, and topologically intact. No graph edges or nodes are hidden, filtered, or culled based on confidence.
3. **Multi-Channel Accessibility**: Confidence is never communicated by color or opacity alone; stroke width, dash patterns, and textual/screen-reader labels (`aria-label`) ensure WCAG 2.1 AA compliance.
4. **Non-Fabrication**: Missing confidence remains `null`/missing. Missing confidence renders neutral styling and no synthetic percentages or bands are invented.
5. **Node Invariant**: Graph nodes in the current backend contract do not have node-level confidence (`GraphQueryResponseNode` has no confidence field). Therefore, graph nodes remain structurally unweighted; node confidence is never derived from adjacent edges or graph depth.
6. **Strict Step Boundary**: Evidence coverage metrics, repository health statistics, and coverage heatmaps are strictly reserved for Global Step 51.

### Architecture & Implementation Details

1. **Presentation Normalization Module (`confidence-data.ts`)**:
   - `NormalizedConfidence`: Read-only presentation model containing:
     - `value`: Original raw floating-point confidence score in $[0, 1]$.
     - `percentage`: Formatted whole number integer percentage (`Math.round(val * 100)`).
     - `percentageLabel`: Human-readable label (e.g., `"92%"`).
     - `tier`: Discrete presentation tier (`'high' | 'medium' | 'low'`).
     - `accessibleLabel`: Multi-channel accessible descriptor (e.g., `"High confidence, 92 percent"`).
   - **Deterministic Thresholds**:
     - `High`: $\ge 0.90$ (direct AST assertions, 1-hop traversal with default $0.90$ hop decay).
     - `Medium`: $0.70$–$0.89$ (dynamic imports, 2–3 hop traversals).
     - `Low`: $< 0.70$ (heuristic edges, 4+ hop traversals).
   - **Edge Style Computation**:
     - `High`: `strokeWidth: 2px`, `opacity: 1.0`, solid `#64748b`.
     - `Medium`: `strokeWidth: 1.5px`, `opacity: 0.85`, solid `#94a3b8`.
     - `Low`: `strokeWidth: 1.25px`, `opacity: 0.65`, strokeDasharray `"4 4"` `#94a3b8`.
     - `Default` (missing/neutral): `strokeWidth: 1.5px`, `opacity: 0.8`, solid `#94a3b8`.

2. **Graph Edge Weighting (`graph-mapping.ts` & `GraphCanvas.tsx`)**:
   - `mapDomainGraphToFlow`: Evaluates authoritative `edge.confidence` using `computeEdgeConfidenceStyles` to set React Flow `style` and stores `normalizedConfidence` and `ariaLabel` in `edge.data`.
   - `GraphCanvas`: Preserves confidence-weighted edge styling while maintaining selection priority (`selectedEdgeId` highlights at `strokeWidth: 3px`, `opacity: 1.0`, and `#3b82f6`).

3. **Impact Findings Visual Weighting (`ChangeModeBar.tsx`)**:
   - Direct, downstream, API, event, and service impact findings in the `impact-findings-panel` display normalized confidence badges with tier indicator (`data-confidence-tier="high|medium|low"`) and accessible `aria-label`.
   - Visual Legend: Subtle, non-intrusive legend explaining confidence tiers and edge stroke/dash patterns without introducing unrequested Step 51 coverage analytics.
   - Deterministic ordering: Findings maintain their deterministic order (by hop distance, file path, symbol name); confidence modulates visual prominence only.

4. **Evidence Citation Integration (`EvidenceCitation.tsx`)**:
   - `EvidenceCitation`: Integrates `normalizeConfidence` to format and present the verified confidence tier on compact and expanded citation cards with `data-confidence-tier` data attributes and accessible screen-reader text.
   - Missing confidence gracefully renders without a confidence chip, adhering strictly to non-fabrication.

5. **Node & Edge Inspector Integration (`node-inspector-data.ts`)**:
   - Edge inspection displays normalized confidence percentage, tier badge, and accessible description alongside edge type and provenance.
   - Node inspection displays confidence badges on linked PR impact findings while preserving unweighted node headers (honoring the lack of node-level confidence in the backend model).

### Verification & Test Matrix

- **Unit & Integration Tests**:
  - `apps/web/src/components/graph/confidence-weighting.test.ts`: 19 tests covering confidence normalization, edge style computation, monotonic weighting, low-confidence visibility and selectability, node invariance, impact finding badges, deterministic ordering preservation, `EvidenceCitation` integration, and multi-channel accessibility.
  - `apps/web`: 13 test files, 177 tests passing.
  - Workspace: 50 test files, 389 tests passing across all packages.
- **TypeScript & Linting**:
  - `pnpm typecheck`: 0 errors across all 7 workspace packages.
  - `pnpm lint`: 0 ESLint errors across the workspace.
  - `pnpm lint:evidence`: 0 violations; all conclusion write paths invoke `EvidenceWriter`.
  - `pnpm build`: Next.js production build compiled cleanly in Turbopack.


---

## Global Step 51 — Analysis-Coverage View

### Overview & Objective

Global Step 51 completes **Phase 7: Evidence Engine** per `docs/architecture/17-implementation-roadmap.md`, `docs/architecture/08-frontend-application.md`, `docs/architecture/03-architecture-principles.md` (Principles P1, P2, P3), and `docs/architecture/22-definition-of-done.md`.

Its core objective is **Evidence Coverage Visibility**:
Surface an honest, deterministic view answering:
> *"How much of the analyzed surface has verified evidence, and where are the gaps?"*

Step 51 bridges the gap between static analysis and human trust, clearly distinguishing analyzed conclusions, evidence-backed conclusions, missing evidence, and unsupported/unresolved files without altering underlying analysis semantics or graph topology.

**Core Invariants Preserved**:
1. **Deterministic Ratio**: Coverage is defined strictly as:
   $$\text{Coverage} = \frac{\text{Evidence-Backed Analyzed Conclusions}}{\text{Analyzed Conclusions in Scope}}$$
2. **Strict Scope Partitioning**: Graph edge coverage and PR impact finding coverage maintain strictly independent numerators and denominators. They are never conflated into an artificial repository-wide average.
3. **Orthogonal Confidence vs. Coverage**: High confidence never serves as a proxy for evidence. Unbacked claims remain strictly uncovered regardless of confidence score.
4. **Actionable Gaps**: Missing evidence is not just an aggregate metric; individual uncovered edges and impact findings can be inspected directly on the interactive graph canvas.
5. **Multi-Channel Accessibility**: Coverage status is communicated via text badges, explicit numeric counts, and ARIA progressbars (`role="progressbar"`), complying with WCAG 2.1 AA without relying on color alone.
6. **Read-Only Presentation Engine**: Zero database queries from the client, zero schema mutations, and zero frontend recomputation of graph analysis.

### Architecture & Implementation Details

1. **Deterministic Coverage Engine (`coverage-data.ts`)**:
   - `calculateGraphEdgeCoverage`:
     - Denominator ($N$): Total graph edges in the query slice (`edges.length`).
     - Numerator ($K$): Edges with valid non-empty `evidence_id`.
     - Categories: Grouped by edge type (`IMPORTS`, `CALLS`, `EXPOSES_ROUTE`, `QUERIES_DB`, etc.).
     - Uncovered items: Sorted deterministically by edge type, source node name, target node name, and edge ID.
   - `calculateImpactFindingCoverage`:
     - Denominator ($N$): Total findings across direct, downstream, API, event, and service categories.
     - Numerator ($K$): Findings with verified `evidence_ids` or `evidence_id`.
     - Categories: 5 authoritative impact tiers.
     - Unresolved files: Surfaced explicitly as unmapped PR files (`unresolved_files`).
     - Uncovered items: Sorted deterministically by category tier, hop distance, finding name, and node ID.
   - Precision: Computes deterministic single-decimal percentages (`formatCoveragePercentage`). Handles zero analyzed items ($N = 0$) with explicit `N/A` text rather than a fabricated 0% failure.

2. **Analysis Coverage Component (`AnalysisCoverageBar.tsx`)**:
   - Integrated into the Architecture Explorer directly below the header/ChangeModeBar and above GraphFilters.
   - **Summary Bar**: Displays status dot, scope badge (`Analysis Run: {id}`), refreshing indicator, summary counts (`Covered: K | Missing: U | Total: N`), percentage badge (`100%`, `96.5%`, `0%`), and ARIA progress bar.
   - **Surface Tabs**: When PR Change Mode is active, allows seamless switching between `Graph Edges` and `PR Impact Findings` scopes.
   - **Expanded Category Drawer**: Displays category breakdown cards with covered/total ratios, percentage chips, and mini progress indicators.
   - **Actionable Findings Drawer**: Filterable by `All`, `Covered`, and `Missing Evidence`. Each uncovered item renders an "Inspect in Graph" action that triggers native graph selection (`onSelectEdge` or `onSelectNode`).

3. **Explorer Client & Node Inspector Integration**:
   - `explorer-client.tsx`: Renders `AnalysisCoverageBar` with live graph edges, nodes, change mode state, and selection handlers.
   - `node-inspector-data.ts`: Edge inspection displays an explicit `Covered` vs `Missing Evidence` status chip (`inspector-edge-coverage-status`) linking directly into `EvidenceCitation`.

### Verification & Test Matrix

- **Unit & Integration Tests**:
  - `apps/web/src/components/graph/coverage.test.ts`: 22 tests covering precision percentage formatting, full/partial/zero/empty states, scope isolation, category breakdowns, high/low confidence evidence orthogonality, UI rendering, expanded drawers, multi-channel accessibility, and NodeInspectorPanel coverage badges.
  - `apps/web`: 14 test files, 199 tests passing.
  - Workspace: 50 test files, 411 tests passing across all packages.
- **TypeScript & Linting**:
  - `pnpm typecheck`: 0 errors across all 7 workspace packages.
  - `pnpm lint`: 0 ESLint errors across the workspace.
  - `pnpm lint:evidence`: 0 violations; all conclusion write paths invoke `EvidenceWriter`.
  - `pnpm build`: Next.js production build compiled cleanly in Turbopack.
  - `git diff --check`: 0 whitespace or formatting errors.

---

## Global Step 52 — Simulation Persistence Foundation

### Overview & Objective

Global Step 52 launches **Phase 8: Simulation** per `docs/architecture/17-implementation-roadmap.md`, `docs/architecture/05-component-responsibilities.md §5.10`, `docs/architecture/06-database-schema.md §6.3`, and `docs/architecture/04-system-architecture-diagrams.md §4.7`.

Its core objective is **Persistence & Domain-Contract Foundation**:
Establish the PostgreSQL database schema, forward-only migration, Row-Level Security (RLS) policies, domain contracts in `@fluxora/shared-types`, and tenant-scoped repository operations in `@fluxora/db` for Fluxora's simulation system:
- `Scenario`: The definition of a what-if experiment (target node, failure type, parameters).
- `Simulation`: An execution record of a scenario against an immutable analysis run snapshot.
- `SimulationResult`: The deterministic resulting state of each affected graph node resulting from a simulation execution.

**Core Invariants Preserved**:
1. **Separation of Concerns**:
   - `Scenario` owns *what* hypothesis is being tested (name, target node, failure type, parameters).
   - `Simulation` owns *which* graph snapshot was used (`analysisRunId`) and execution status (`pending`, `running`, `completed`, `failed`).
   - `SimulationResult` owns *how* each node was affected (resulting state, propagation path, rule applied, assumptions, confidence).
2. **Analysis-Run Snapshot Boundary**: A simulation must never combine a target node from one graph run with results computed against another graph run. The persistence layer enforces that `targetNodeId` and all result `nodeId`s belong to the simulation's `analysisRunId`.
3. **Multi-Tenancy & Hardware RLS**: All tables enforce PostgreSQL `FORCE ROW LEVEL SECURITY`. Scenarios are directly tenant-scoped via `organization_id`. Simulations and SimulationResults inherit tenant boundaries transitively through security-definer helper functions (`fluxora_scenario_in_current_tenant` and `fluxora_simulation_in_current_tenant`).
4. **Domain Enum Bounding vs Rule Table Scope**: The schema supports all 4 domain failure types (`unavailable`, `latency`, `capacity`, `removal`) and 4 resulting states (`healthy`, `degraded`, `at_risk`, `failed`). The MVP rule table in Step 53 will execute rules for `unavailable` and `latency`, but all valid failure types persist safely without schema migrations.
5. **Idempotency**: `simulation_results` enforces `UNIQUE (simulation_id, node_id)` and supports idempotent batch upserts via `ON CONFLICT (simulation_id, node_id) DO UPDATE`.
6. **Strict Step Boundary**: Rule table (Step 53), Simulation Engine (Step 54), Simulation APIs (Step 55), and Frontend Simulation Mode (Step 56) are strictly excluded from Step 52.

### Architecture & Implementation Details

1. **Database Migration (`0019_simulation_storage.sql`)**:
   - `scenarios`: `id` (UUID PK), `organization_id` (FK organizations), `repository_id` (FK repositories), `name`, `target_node_id` (FK graph_nodes), `failure_type` (CHECK in `'unavailable', 'latency', 'capacity', 'removal'`), `parameters` (JSONB), `created_by` (FK users, nullable), `created_at`.
   - `simulations`: `id` (UUID PK), `scenario_id` (FK scenarios), `analysis_run_id` (FK analysis_runs), `status` (CHECK in `'pending', 'running', 'completed', 'failed'`), `created_at`.
   - `simulation_results`: `id` (UUID PK), `simulation_id` (FK simulations), `node_id` (FK graph_nodes), `resulting_state` (CHECK in `'healthy', 'degraded', 'at_risk', 'failed'`), `propagation_path` (JSONB), `rule_applied`, `assumptions` (JSONB), `confidence` (float in `[0.0, 1.0]`), `created_at`.
   - Indexes:
     - `scenarios`: `organization_id`, `repository_id`, `target_node_id`, `(repository_id, created_at DESC)`.
     - `simulations`: `scenario_id`, `analysis_run_id`, `(scenario_id, created_at DESC)`.
     - `simulation_results`: `simulation_id`, `node_id`, and `UNIQUE (simulation_id, node_id)`.
   - RLS Policies: Configured with `FORCE ROW LEVEL SECURITY` and `STABLE SECURITY DEFINER` tenant check helpers.

2. **Domain Models (`@fluxora/shared-types`)**:
   - Created `packages/shared-types/src/simulation.ts` exporting:
     - `ScenarioFailureTypes`, `ScenarioFailureType`
     - `SimulationResultStates`, `SimulationResultState`
     - `SimulationStatuses`, `SimulationStatus`
     - `Scenario`, `Simulation`, `SimulationResult`
     - `CreateScenarioInput`, `CreateSimulationInput`, `CreateSimulationResultInput`, `ListScenariosOptions`
   - Re-exported from `@fluxora/shared-types/src/index.ts`.

3. **Repository Layer (`@fluxora/db`)**:
   - Created `packages/db/src/repositories/simulation.ts` providing:
     - Scenario: `createScenario`, `getScenarioById`, `listScenarios`, `deleteScenario`.
     - Simulation: `createSimulation`, `getSimulationById`, `listSimulationsForScenario`, `updateSimulationStatus`.
     - SimulationResult: `createSimulationResult`, `saveSimulationResults`, `getSimulationResultById`, `listSimulationResults`.
     - Error types: `SimulationPersistenceValidationError`, `ScenarioNotFoundError`, `SimulationNotFoundError`, `SimulationResultNotFoundError`, `SimulationConflictError`.
   - Re-exported from `@fluxora/db/src/index.ts`.

### Verification & Test Matrix

- **Migration**:
  - `0019_simulation_storage.sql` applied cleanly via `pnpm --filter @fluxora/db migrate`.
- **Unit & Integration Tests**:
  - `packages/db/src/repositories/simulation.test.ts`: 19 tests covering input validation, failure types, snapshot boundaries, lifecycle status updates, result idempotency, RLS isolation, deterministic ordering, and cascade deletions.
  - `@fluxora/db`: 15 test files, 153 tests passing.
- **TypeScript & Linting**:
  - `pnpm typecheck`: 0 errors across workspace.
  - `pnpm lint`: 0 ESLint errors.
  - `pnpm lint:evidence`: 0 violations; all conclusion write paths invoke `EvidenceWriter`.
  - `git diff --check`: 0 whitespace or formatting errors.

---

## Global Step 53 — Initial Simulation Rule Table

### Overview & Objective

Global Step 53 implements the **Initial Simulation Rule Table** for Phase 8 per `docs/architecture/17-implementation-roadmap.md §Phase 8 Step 2`, `docs/architecture/02-product-scope.md`, `docs/architecture/04-system-architecture-diagrams.md §4.7`, `docs/architecture/05-component-responsibilities.md §5.10`, and `docs/architecture/12-testing-strategy.md §12.1`.

Its core objective is **Deterministic, Pure, Versioned Simulation Rules**:
Establish a deterministic, versioned, side-effect-free, and independently testable Rule Table abstraction with explicit assumption surfacing and confidence scoring:
1. `calls.sync.no_fallback` (`CALLS + sync + no fallback` → dependent/caller `DEGRADED`, uncapped).
2. `calls.circuit_breaker` (`CALLS + circuit breaker present` → dependent/caller `DEGRADED`, `capped: true`).
3. `writes.failure` (`WRITES + failed dependency` → dependent READERS `AT_RISK`).
4. `emits.consumer_only` (`EMITS + consumer` → consumer `AT_RISK`, producer unaffected).

All other cases represent explicit non-matches rather than synthetic state transitions.

**Core Invariants Preserved**:
1. **Deterministic Core vs Probabilistic Edge**: All state transitions, assumptions, and confidence values are 100% deterministic and rule-driven. The LLM layer is strictly excluded from defining simulation transitions.
2. **Fallback & Async as Suppressors**: Fallback presence suppresses the `calls.sync.no_fallback` degradation rule; it does not invent a synthetic transition to `HEALTHY`. Likewise, asynchronous calls do not match the synchronous rule. Both return explicit non-matches (`matched: false`), allowing the future Simulation Engine to preserve current state.
3. **Narrowed `WRITES+failure`**: Strictly scoped to dependent read/query operations (`QUERIES_DB`). Dependent writes (`WRITES`) return non-match (`matched: false`).
4. **Explicit Unknown Metadata & Conservative Assumptions (§5.10)**: Uses `MetadataPresence = boolean | "unknown"`. Unknown metadata is never silently converted to `false`. When metadata is `"unknown"` (or omitted), conservative defaults apply (assume absence of protection) and an explicit assumption is surfaced in `decision.assumptions` (e.g. `"No circuit breaker detected on call"`), calibrated with confidence `0.90`.
5. **Qualitative Latency**: Supports `failureType: "latency"` deterministically through dependency semantics without quantitative telemetry (milliseconds, percentiles, queueing theory).
6. **Strict Step Boundary**: The Rule Table is purely domain logic independent of PostgreSQL, HTTP/API, React, or job workers. Simulation Engine traversal loop (Step 54), API endpoints (Step 55), and UI mode (Step 56) are strictly excluded from Step 53.

### Architecture & Implementation Details

1. **Domain Types & Contracts (`@fluxora/shared-types`)**:
   - `packages/shared-types/src/simulation.ts`:
     - Added `MetadataPresence = boolean | "unknown"`.
     - Added `DEFAULT_SIMULATION_RULE_TABLE_VERSION = "1.0.0"`.
     - Added `SimulationRuleIds`, `SimulationRuleId` (normative: `CALLS_CIRCUIT_BREAKER`, `CALLS_SYNC_NO_FALLBACK`, `WRITES_FAILURE_DEPENDENT_READS`, `EMITS_CONSUMER_AT_RISK`).
     - Added `AffectedNodeRole` (`"source" | "target" | "none"`).
     - Added `SimulationRuleInput`: `edgeType`, `sourceState`, `targetState`, `sync?`, `hasFallback?`, `hasCircuitBreaker?`, `failureType?`, `isWriteFailure?`, `sourceNodeName?`, `targetNodeName?`, `metadata?`.
     - Added `SimulationRuleDecision`: `matched`, `resultingState?`, `ruleId`, `ruleVersion`, `affectedNode?`, `capped?`, `assumptions`, `confidence`.
     - Added `SimulationRule`: `id`, `version`, `name`, `description`, `supportedEdgeTypes`, `evaluate`.
     - Added `SimulationRuleTable`: `version`, `rules`.
     - Added `ExtractedSimulationEdgeMetadata`: `sync: MetadataPresence`, `hasFallback: MetadataPresence`, `hasCircuitBreaker: MetadataPresence`.

2. **Simulation Rule Table Engine (`packages/shared-types/src/simulation-rules.ts`)**:
   - Canonical Rule IDs:
     - `RULE_ID_CALLS_CIRCUIT_BREAKER = "CALLS+circuit_breaker"`
     - `RULE_ID_CALLS_SYNC_NO_FALLBACK = "CALLS+sync+no_fallback"`
     - `RULE_ID_WRITES_FAILURE = "WRITES+failure"`
     - `RULE_ID_EMITS_CONSUMER_AT_RISK = "EMITS+consumer_only"`
     - `RULE_ID_NO_MATCH = "NO_MATCH"`
   - Normative Rules in `DEFAULT_SIMULATION_RULES`:
     - `callsCircuitBreakerRule`: Matches when callee is impaired and circuit breaker is confirmed present (`hasCircuitBreaker: true`); produces caller `degraded`, `capped: true`.
     - `callsSyncNoFallbackRule`: Matches when callee is impaired, call is synchronous (or unknown), fallback is absent (or unknown), and circuit breaker is absent (or unknown); produces caller `degraded`, `capped: false`. Suppressed by `hasFallback === true` (non-match) and `sync === false` (non-match).
     - `writesFailureRule`: Matches dependent query/read edges (`QUERIES_DB`) against impaired datastores or write failures; produces reader `at_risk`. Explicitly non-matching for dependent writes (`WRITES`).
     - `emitsConsumerAtRiskRule`: Matches event consumer edges (`CONSUMES_EVENT`); produces consumer `at_risk`. Explicitly non-matching for event producers (`EMITS_EVENT`), keeping producers unaffected.
   - Evaluator Functions:
     - `evaluateSimulationRule(input, table?)`: Evaluates against rules in order, returning first matching decision or `NO_MATCH`.
     - `evaluateAllSimulationRules(input, table?)`: Evaluates against all rules in table.
     - `extractSimulationEdgeMetadata(metadata)`: Normalizes metadata properties, preserving explicit `"unknown"` values.
     - `createSimulationRuleInputFromEdge(edge, sourceState, targetState, options?)`: Adapter constructing input from GraphEdge.
     - `isStateMoreSevere(newState, currentState)`: State severity hierarchy (`failed > degraded > at_risk > healthy`).

3. **Bridge & Re-exports (`@fluxora/db`)**:
   - Created `packages/db/src/repositories/simulation-rules.ts` re-exporting the rule engine and contracts.
   - Re-exported from `packages/db/src/index.ts`.

### Verification & Test Matrix

- **Unit Tests**:
  - `packages/db/src/repositories/simulation-rules.test.ts`: 44 tests covering:
    - Rule 1 (`calls.sync.no_fallback`): failure/degradation propagation, healthy/failed caller boundaries, fallback suppression (Correction 1: no match), async call suppression (Correction 2: no match).
    - Rule 2 (`calls.circuit_breaker`): capped propagation (`capped: true`), fail-fast isolation assumptions, non-match on unknown circuit breaker.
    - Conservative defaults & explicit unknown metadata (Correction 4 & §5.10): unknown metadata handling, node name formatting, latency degradation scenario.
    - Rule 3 (`writes.failure`): datastore outage, read-after-write latency assumption, QUERIES_DB dependent reads, regression test for dependent writes (Correction 3: no match).
    - Rule 4 (`emits.consumer_only`): consumer at risk, producer unaffected (no match on EMITS_EVENT).
    - Rule Table priority & evaluation fallthrough.
    - Extensibility & custom versioned rule tables.
    - State severity hierarchy (`isStateMoreSevere`).
    - Metadata extraction and edge adapter helpers.
  - `@fluxora/db`: 16 test files, 197 passed, 5 skipped (total 202).
- **TypeScript & Linting**:
  - `pnpm typecheck`: 0 errors across 7 workspace projects.
  - `pnpm lint`: 0 ESLint errors.
  - `pnpm lint:evidence`: 0 violations; all conclusion write paths invoke `EvidenceWriter`.
  - `pnpm build`: Next.js production build compiled cleanly with Turbopack.
  - `git diff --check`: 0 whitespace or formatting errors.
