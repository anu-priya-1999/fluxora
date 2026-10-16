Implement ONLY Global Step 42 of Fluxora.

# Global Step 42 — PullRequest + Changed-File/Diff Storage

This is the second step of Phase 6: PR Impact Analysis.

The canonical roadmap defines Step 42 as:

"Implement `PullRequest` table + changed-file/diff storage."

:chatgpt-content-reference{index="0"}

Before editing anything, inspect the existing implementation and architecture.

==================================================
FIRST: INSPECT EXISTING ARCHITECTURE
==================================================

Inspect:

- docs/architecture/17-implementation-roadmap.md
- docs/architecture/06-database-schema.md
- docs/architecture/07-api-architecture.md
- docs/architecture/08-event-schema.md
- docs/architecture/11-security-architecture.md
- docs/architecture/12-testing-strategy.md
- docs/DESIGN.md

And inspect the actual code:

- apps/api/src/github/
- apps/api/src/http/
- apps/workers/src/
- packages/db/src/
- packages/db/migrations/
- packages/shared-types/src/
- existing GitHub repository client
- existing GitHub installation repository
- existing job queue
- Step 41 webhook handler
- Step 41 normalized webhook payload
- existing repository/repository-snapshot/commit storage

Do not assume an architecture that is not present in the repository.

Reuse the existing GitHub App installation/authentication/client infrastructure.

==================================================
ROADMAP BOUNDARY
==================================================

Step 42 ONLY owns:

- PullRequest persistence;
- PR changed-file persistence;
- PR diff/patch storage;
- processing of the Step 41 webhook job sufficiently to populate those records;
- tests and documentation for that storage flow.

DO NOT implement:

Step 43:
- Impact Analysis Engine
- traversal for impact analysis
- direct/downstream/affected API/event computation

Step 44:
- ImpactAnalysis persistence
- impact evidence generation

Step 45:
- impact-analysis HTTP APIs

Step 46:
- frontend change-mode overlay

Step 47:
- golden-fixture PR validation

Do not implement any of those even if the code seems to naturally lead there.

==================================================
CORE GOAL
==================================================

After Step 42, a verified Step 41 webhook should result in durable, tenant-scoped information about the PR:

GitHub PR webhook
      ↓
existing Step 41 normalized job
      ↓
worker retrieves current PR metadata + changed files/diff
      ↓
PullRequest record
      ↓
changed-file records / diff data
      ↓
ready for Step 43 Impact Analysis

The output of Step 42 becomes the persisted source of truth that Step 43 will consume later.

==================================================
1. DESIGN THE DATABASE MODEL FROM EXISTING ARCHITECTURE
==================================================

Inspect the existing database conventions before creating tables.

Follow:

- existing naming conventions;
- UUID conventions;
- organization/tenant scoping;
- foreign-key conventions;
- timestamp conventions;
- unique constraints;
- indexes;
- RLS policies;
- migration style;
- repository abstraction patterns.

The exact physical schema should be chosen from the existing Fluxora architecture.

At minimum, model:

### PullRequest

Enough information to identify and process a PR later.

Expected conceptual fields include:

- stable internal ID;
- organization_id;
- repository_id or equivalent repository association;
- GitHub pull request numeric ID;
- pull request number;
- installation association where required by current architecture;
- URL;
- title;
- base ref;
- base SHA;
- head ref;
- head SHA;
- state/status metadata where useful;
- sender/author metadata where appropriate;
- created/updated timestamps;
- source/webhook delivery metadata where the existing architecture requires it.

Do NOT copy the entire GitHub webhook payload into the database.

### Changed-file / diff storage

Persist enough information for Step 43 to determine:

- which files changed;
- how they changed;
- the relevant before/after blob references or SHAs;
- additions/deletions;
- patch/diff data where available;
- file status;
- rename information where GitHub supplies it;
- file paths.

Use the simplest schema that supports the next phase without overbuilding.

Do not store redundant copies of information that can safely be derived from existing repository/commit records unless the current architecture specifically calls for denormalized storage.

==================================================
2. DATABASE MIGRATION
==================================================

Create the required migration(s).

Follow existing migration ordering exactly.

Use deterministic migration naming.

The migration must include:

- new tables;
- primary keys;
- foreign keys;
- uniqueness constraints;
- necessary indexes;
- timestamps;
- organization/tenant scope;
- RLS policies;
- appropriate grants following the existing Fluxora DB security architecture.

Do not weaken RLS.

Do not add broad cross-tenant query permissions.

A tenant must never be able to retrieve another tenant's PR records or changed-file data.

Keep migration scope limited to Step 42.

Do NOT add:

- ImpactAnalysis tables;
- simulation tables;
- AI tables;
- new graph tables.

==================================================
3. TENANT ISOLATION
==================================================

Every new PR-related persistent object must be associated with the correct Fluxora organization.

The organization must come from the already verified Step 41 GitHub installation mapping.

Never trust:

- arbitrary organization_id from the webhook payload;
- browser/client-supplied tenant IDs;
- repository metadata as a substitute for tenant authorization.

Use the existing `withTenant` / RLS conventions already present in Fluxora.

Tests must demonstrate:

Tenant A
  ↓
cannot read/update/delete
  ↓
Tenant B PR or changed-file data

==================================================
4. REPOSITORY ASSOCIATION
==================================================

A PR belongs to a GitHub repository.

Reuse the existing Fluxora repository identity instead of creating another repository representation.

Determine how the current GitHub repository installation/connection flow maps:

GitHub repository
      ↓
Fluxora Repository

Use that existing mapping.

If a valid PR references a repository that is not connected to the corresponding Fluxora installation/tenant:

- do not create an orphan PR record;
- return/record a deterministic failure or ignored outcome consistent with existing job semantics;
- do not cross-link it to another tenant.

Do not invent a second repository lookup model.

==================================================
5. PROCESSING THE STEP 41 WEBHOOK JOB
==================================================

Step 41 already creates:

`pull_request.webhook`

jobs.

Extend the existing worker handling only enough to process that job into Step 42 storage.

The worker flow should be approximately:

existing Step 41 job
      ↓
validate normalized payload
      ↓
resolve repository / installation
      ↓
fetch current PR data from GitHub
      ↓
persist PullRequest
      ↓
fetch/persist changed files + diff information
      ↓
complete job

Do NOT run Impact Analysis here.

Do NOT traverse the graph here.

Do NOT calculate blast radius here.

==================================================
6. GITHUB DATA FETCH
==================================================

Reuse the existing GitHub App installation token/client architecture.

Do NOT create a second GitHub client.

Determine the correct GitHub API calls needed to retrieve:

- current pull request metadata;
- changed files;
- patch/diff information.

Respect the existing installation authentication.

Do not use user PATs.

Do not expose GitHub tokens.

Do not store access tokens in the database.

Do not log GitHub credentials.

==================================================
7. BASE / HEAD INFORMATION
==================================================

Persist the PR's relevant revision identity.

Step 42 must preserve enough information for later comparison and analysis.

At minimum ensure the stored record distinguishes:

- base SHA;
- head SHA;
- current PR number;
- repository;
- GitHub PR identity.

For `synchronize`, recognize that the head SHA can change.

Do not assume a PR's head SHA is immutable.

The stored representation must allow the latest webhook delivery to update the PR state correctly.

==================================================
8. OPENED VS SYNCHRONIZE
==================================================

Handle both supported Step 41 actions:

- `opened`
- `synchronize`

### opened

Create the PullRequest record and its initial changed-file/diff snapshot.

### synchronize

Update the existing PullRequest to the latest GitHub head revision and persist the new changed-file/diff state according to the chosen schema.

Do not blindly create a second logical PullRequest for every synchronize event.

The same GitHub PR should remain one logical PR record.

However, preserve historical information only if the architecture already requires versioned snapshots.

Do NOT invent full PR revision history unless necessary for Step 42's acceptance criteria.

==================================================
9. IDEMPOTENCY
==================================================

Preserve the Step 41 delivery-id idempotency guarantee.

A GitHub delivery may be retried.

Processing the same delivery twice must not create duplicate logical PR records or duplicate changed-file rows.

Use deterministic unique keys based on:

- organization;
- repository;
- GitHub PR identity;

and/or existing delivery/job idempotency mechanisms.

Inspect current DB/job conventions before choosing exact constraints.

The implementation must be safe under retries.

==================================================
10. CHANGED-FILE MODEL
==================================================

Store enough information for Step 43 without calculating impact.

At minimum represent fields conceptually equivalent to:

- file path;
- previous path when renamed;
- status (`added`, `modified`, `removed`, `renamed`, etc.);
- additions;
- deletions;
- patch/diff text where available;
- base blob SHA where available;
- head blob SHA where available;
- change position/metadata where useful.

Do not parse source code or extract symbols in Step 42.

Do not attempt to determine which symbols were changed.

That belongs to Step 43.

==================================================
11. DIFF STORAGE
==================================================

Use GitHub-provided patch/diff information where available.

Do not reconstruct diffs from scratch unless the existing architecture specifically requires it.

Handle GitHub cases where a file has no patch or the patch is unavailable.

Examples can include:

- binary files;
- very large files;
- truncated patch data.

Represent this safely without pretending a diff exists.

Do not fail an otherwise valid PR merely because one file lacks patch text unless the repository architecture explicitly requires complete patches.

==================================================
12. LARGE PAYLOAD / SAFETY LIMITS
==================================================

Inspect existing GitHub and storage security limits.

Do not allow an extremely large webhook/API response or diff to cause unbounded memory usage.

Reuse existing size-limit conventions.

If GitHub returns more changed files than can safely be stored/processsed under the current architecture:

- fail or safely handle according to existing ingestion/job conventions;
- do not silently truncate without recording that truncation occurred.

Do not introduce arbitrary limits without documenting them.

==================================================
13. TRANSACTIONALITY
==================================================

Persist the PR and its changed-file data consistently.

Avoid this inconsistent state:

PullRequest saved
    ↓
changed files partially saved
    ↓
worker reports success

Prefer an atomic transaction for the database portion:

fetch/prepare external GitHub data
        ↓
DB transaction
  PullRequest
  changed files
        ↓
COMMIT

If a retry/update occurs, ensure the database converges deterministically to the latest valid state.

Do not hold a database transaction open while making slow GitHub API calls.

==================================================
14. REPOSITORY ABSTRACTION
==================================================

Create repository-layer functions following existing Fluxora conventions.

Keep HTTP/GitHub transport concerns separate from DB persistence concerns.

Possible conceptual operations:

- upsertPullRequest
- replacePullRequestChangedFiles
- getPullRequest
- getPullRequestChangedFiles

Names are examples only.

Do not expose raw SQL from the worker if the project convention uses repository modules.

Do not over-create abstractions.

==================================================
15. TESTS
==================================================

Add focused tests for Step 42.

### Database tests

At minimum:

1. create PullRequest;
2. retrieve PullRequest;
3. update PullRequest;
4. unique GitHub PR identity is enforced;
5. changed files persist correctly;
6. renamed file metadata persists;
7. added file persists;
8. modified file persists;
9. deleted file persists;
10. patch/diff is stored when available;
11. missing patch is handled safely;
12. duplicate changed files are prevented;
13. PullRequest and changed-file tenant isolation;
14. cross-tenant read returns no data;
15. cross-tenant mutation is rejected/blocked;
16. foreign-key relationships are enforced;
17. transaction rollback leaves no partial PR data.

### Worker / API integration tests

At minimum:

18. `pull_request.opened` job creates the PR record;
19. `pull_request.synchronize` updates the existing PR;
20. duplicate webhook delivery remains idempotent;
21. repository association is correct;
22. unknown/unmapped repository does not create an orphan PR;
23. GitHub API failures cause deterministic job failure/retry behavior using existing conventions;
24. PR metadata is normalized/persisted correctly;
25. changed-file data corresponds to the fetched GitHub response;
26. impact analysis is NOT executed by Step 42.

### Security

27. tenant A cannot access tenant B PRs;
28. tenant A cannot access tenant B changed-file records;
29. no client-supplied organization_id can override server-side tenant association;
30. GitHub credentials are not persisted/logged.

Preserve all existing tests.

Do not weaken or delete tests.

==================================================
16. SHARED TYPES
==================================================

Add shared types only if genuinely required between:

- webhook/job payloads;
- worker;
- database repository boundary.

Do not prematurely create public ImpactAnalysis types.

Do not define the Step 43 engine types here unless strictly necessary.

==================================================
17. DOCUMENTATION
==================================================

Create:

### Implementation document

`learning/implementations/phase-06/step-42-pull-request-and-diff-storage.md`

Include:

- objective;
- scope;
- architecture;
- database design;
- PullRequest lifecycle;
- changed-file model;
- diff storage;
- `opened` behavior;
- `synchronize` behavior;
- GitHub data retrieval;
- job processing;
- idempotency;
- transactions;
- tenant isolation;
- security;
- failure/retry behavior;
- storage limits;
- why symbol/impact analysis is NOT done here;
- verification;
- explicit Step 43–47 boundary.

### Learning notes

`learning/notes/42. PullRequest and Diff Storage.md`

Explain in plain English:

- why PR metadata needs persistence;
- why changed files are stored;
- what a patch/diff represents;
- opened vs synchronize;
- idempotency;
- database transactions;
- tenant isolation;
- why webhook ingestion and impact analysis are separate concerns.

### Interview cheat sheet

`learning/interviews/42. Step 42 PullRequest and Diff Storage Interview CheatSheet.md`

Include:

- likely interview questions;
- concise answers;
- schema design;
- repository/PR identity;
- changed-file modeling;
- diff storage;
- idempotency;
- transactional writes;
- webhook retries;
- multi-tenancy;
- GitHub API failure handling;
- scalability tradeoffs;
- why Step 43 is separated.

### DESIGN.md

Update:

`docs/DESIGN.md`

Append the Step 42 architecture/design section.

Do NOT delete, rewrite, or reorder previous Step 1–41 sections.

Do NOT claim future impact-analysis functionality already exists.

==================================================
18. VERIFICATION
==================================================

Run:

- focused Step 42 DB tests;
- focused worker/API tests;
- `pnpm test`;
- `pnpm typecheck`;
- `pnpm lint`;
- `pnpm lint:evidence`;
- `pnpm build`;
- `git diff --check`.

Report the actual results.

Fix ONLY issues introduced by Step 42.

==================================================
19. FINAL SCOPE GUARD
==================================================

The final diff must contain ONLY:

- PullRequest schema/migration;
- changed-file/diff storage schema;
- RLS/indexes/constraints for those tables;
- DB repository functions;
- minimal Step 41 worker-job integration required to populate the records;
- GitHub fetch integration required for PR metadata/changed files;
- tests;
- Step 42 learning documentation;
- Step 42 DESIGN.md section.

DO NOT:

- implement Impact Analysis Engine;
- traverse the graph for impact;
- calculate affected/downstream nodes;
- create ImpactAnalysis tables;
- create impact-analysis endpoints;
- create change-mode GraphCanvas overlay;
- perform symbol-level diff analysis;
- add simulation;
- add AI reasoning;
- change graph traversal;
- change existing graph query behavior;
- modify Step 39 WebSocket behavior;
- add unrelated GitHub webhook events;
- create a second GitHub client;
- create unrelated database tables;
- introduce speculative future infrastructure.

==================================================
20. FINAL REPORT
==================================================

At the end report:

1. exact files created;
2. exact files modified;
3. database tables created;
4. important indexes/constraints/RLS rules;
5. PullRequest identity strategy;
6. changed-file/diff storage strategy;
7. how `opened` is handled;
8. how `synchronize` is handled;
9. how idempotency works;
10. how tenant isolation works;
11. how GitHub API failures are handled;
12. exact test counts;
13. typecheck/lint/evidence-lint/build results;
14. explicit confirmation that Steps 43–47 were NOT implemented.

Do NOT commit or push.