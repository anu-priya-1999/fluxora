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


