Fluxora Global Step 12 ONLY — Repository Ingestion Worker.

Use the canonical architecture and roadmap in the repository as the source of truth.

IMPORTANT:
Step 11 is complete.
Do NOT implement Step 13+:
- no S3/object-storage upload
- no final RepositorySnapshot persistence
- no repository-connect API
- no WebSocket progress UI
- no language/framework detection
- no AST parsing
- no graph extraction
- no new queue architecture

Current infrastructure already exists:
- PostgreSQL-backed jobs table
- enqueueJob()
- claimNextJob()
- completeJob()
- failJob()
- retryFailedJob()
- JobWorker
- handler registry
- Repository / RepositorySnapshot / Commit data model
- GitHub App installation persistence from Step 10

Build Step 12 ON TOP OF those existing components.

GOAL

Implement the repository ingestion worker/service that handles a `repository.ingest` job.

Flow:

repository.ingest job
→ load Repository
→ resolve/load tenant GitHub installation
→ mint a short-lived GitHub App installation access token
→ fetch repository content at the requested ref
→ safely materialize repository contents into an isolated working directory
→ enforce ingestion security limits
→ return/record enough result information for Step 13
→ complete/fail/retry the job correctly

GITHUB AUTH

Use the existing GitHub App installation model from Step 10.

Do NOT:
- store long-lived GitHub access tokens
- add a persistent token table
- reuse the Clerk session token as the GitHub API credential

Installation tokens must be short-lived and only exist for the ingestion operation.

JOB CONTRACT

Define a typed `repository.ingest` payload following existing shared job conventions.

The payload must include at minimum:
- repositoryId
- ref

Determine whether commitSha should also be required or resolved during ingestion based on the existing Repository model and architecture.

Keep organization_id on the Job itself and validate the repository belongs to that tenant before fetching anything.

IDEMPOTENCY

Design the ingestion operation so retry/re-execution does not create duplicate durable state.

Do not invent a new idempotency system; use the existing jobs/idempotency infrastructure.

GITHUB FETCHING

Inspect existing GitHub-related code first and choose the smallest approach consistent with the codebase and architecture.

The architecture allows GitHub API fetching or git clone using the installation token.

Prefer a deterministic, dependency-light implementation suitable for the current Node/TypeScript worker environment.

Do not require Docker.

WORKING DIRECTORY

Create an isolated temporary working directory per ingestion execution.

Requirements:
- no repository code execution
- no eval
- no require/import of customer files
- never execute repository scripts
- cleanup in finally blocks
- bounded file count / total bytes / extraction time according to configurable limits
- reject or safely handle path traversal
- reject unsafe archive paths/symlinks if archive extraction is used
- never let a malformed/malicious repository crash the worker process

FAILURE SEMANTICS

Implement clear classification:

1. GitHub 401/403 / revoked access
   → mark Repository as `needs_reauth`
   → do not retry indefinitely

2. GitHub rate limit / transient availability error
   → throw a retryable error so existing job retry logic handles it

3. Repository too large
   → fail safely with an explicit ingestion error
   → do not OOM the worker
   → preserve information needed for the later `truncated analysis` design

4. Invalid/not-found ref
   → permanent repository ingestion error

5. Path traversal / unsafe archive content
   → permanent security failure
   → never extract outside the working directory

6. Unexpected worker failure
   → use the existing JobWorker failure/retry path

REPOSITORY STATUS

Use the Step 11 `connection_status` field appropriately.

Do not invent new repository statuses.

Do not mark the repository `active` unless the ingestion operation has successfully completed the Step 12 definition of success.

STEP 12 BOUNDARY

Step 12 must NOT:
- upload to S3
- create final RepositorySnapshot records
- implement repository connect API
- implement WebSocket progress
- trigger analysis
- parse source code

Prepare only the in-memory/filesystem result needed by Step 13.

TESTING

Add focused tests covering:
- successful ingestion
- repository/ref resolution
- installation-token usage
- tenant mismatch rejection
- GitHub 401/403 → needs_reauth
- transient/rate-limit retry classification
- invalid ref
- repository size limits
- path traversal / unsafe archive handling
- cleanup of temp directories
- worker handler registration
- retry/idempotency behavior

Do not depend on live GitHub calls in unit tests. Use mocked/recorded responses following existing testing conventions.

OBSERVABILITY

Use the existing OpenTelemetry/logging conventions.

Record useful metadata such as:
- repository id
- organization id
- job id
- ref
- duration
- file count/bytes where safe

Never log:
- installation token
- GitHub App private key
- Clerk token
- DATABASE_URL
- repository source contents

LEARNING PACKAGE — REQUIRED

After implementation, create/update:

1. `learning/11. Repository Ingestion Worker.md`
2. `learning/phase-02/step-12-repository-ingestion.md`
3. `learning/interviews/5. Step 12 Repository Ingestion Worker Interview CheatSheet.md`

Learning notes must explain:
- why ingestion is asynchronous
- worker vs API responsibilities
- job leasing
- at-least-once delivery
- idempotency
- GitHub App installation token lifecycle
- rate limits and retry classification
- needs_reauth handling
- temporary working directories
- path traversal
- archive/decompression attack protection
- why repository code is treated as untrusted data
- why no code execution is allowed
- how Step 12 feeds Step 13

STEP IMPLEMENTATION NOTES must include:
- objective
- exact files changed
- file-by-file responsibility map
- recommended code-reading order
- data flow
- failure-state matrix
- security controls
- test strategy
- verification results
- Step 12 acceptance criteria
- explicit "not implemented because it belongs to Step 13+" section

INTERVIEW CHEAT SHEET must include senior-level questions on:
- worker architecture
- retries
- leasing
- idempotency
- GitHub App tokens
- rate limiting
- tenant isolation
- untrusted repository content
- archive attacks
- cleanup
- large repository handling
- API vs worker separation

DESIGN.md:
- preserve ALL existing content
- do not shorten or replace sections
- update only the relevant Step 12 / Phase 2 portions
- document only what is actually implemented

VERIFICATION

Run:

pnpm typecheck
pnpm lint
pnpm test
pnpm build

If the worker package does not currently have a runnable worker script, do not invent deployment infrastructure beyond Step 12; add only the minimum executable/handler registration needed to test the ingestion worker within the existing worker architecture.

Do not start Step 13.