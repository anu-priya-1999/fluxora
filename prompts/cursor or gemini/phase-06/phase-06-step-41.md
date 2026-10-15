Implement ONLY Global Step 41 of Fluxora.

# Global Step 41 — GitHub Pull Request Webhook Handling

This begins Phase 6: PR Impact Analysis.

Before editing anything, inspect the existing Fluxora architecture and implementation, especially:

- apps/api/src/
- apps/workers/src/
- packages/db/src/
- packages/shared-types/src/
- existing GitHub App integration from Phase 2
- existing authentication/tenant resolution
- existing job queue / worker infrastructure
- existing event/outbox architecture
- existing GitHub-related tests
- docs/architecture/17-implementation-roadmap.md
- docs/DESIGN.md
- learning/implementations/
- learning/notes/
- learning/interviews/

Use the existing architecture. Do not invent a parallel GitHub integration.

==================================================
ROADMAP BOUNDARY
==================================================

Global Step 41 corresponds to ONLY:

Phase 6 — PR Impact Analysis
Step 1:
Implement GitHub webhook handling for:

- `pull_request.opened`
- `pull_request.synchronize`

That is the entire product scope for this step.

The roadmap's next steps are intentionally separate:

Step 42 → PullRequest table + changed-file/diff storage
Step 43 → Impact Analysis Engine
Step 44 → ImpactAnalysis persistence + evidence
Step 45 → Impact Analysis API
Step 46 → Change-mode frontend overlay
Step 47 → Golden-fixture PR validation

DO NOT implement any of Steps 42–47.

==================================================
STRICT SCOPE
==================================================

Implement:

- GitHub webhook HTTP handling for pull requests;
- signature verification;
- event/action validation;
- normalization of the relevant webhook metadata;
- tenant/installation association using the existing GitHub App architecture;
- safe handoff to the existing job/event mechanism for later processing.

Do NOT implement:

- PullRequest database tables;
- changed-file persistence;
- diff persistence;
- impact analysis;
- graph traversal changes;
- impact graph calculations;
- impact-analysis API endpoints;
- frontend change-mode overlay;
- AI reasoning;
- simulation;
- new graph nodes/edges;
- new graph query semantics;
- new WebSocket event type;
- unrelated GitHub functionality.

==================================================
1. INSPECT EXISTING GITHUB APP ARCHITECTURE FIRST
==================================================

Before writing code, determine how the existing Fluxora GitHub App integration works.

Inspect:

- GitHub App installation persistence;
- installation_id handling;
- authenticated organization/user association;
- GitHub API client;
- existing repository connection flow;
- existing webhook/event conventions;
- existing job queue;
- existing event/outbox patterns.

Reuse the existing implementation.

Do NOT create a second GitHub client or second installation lookup mechanism.

==================================================
2. WEBHOOK ENDPOINT
==================================================

Add the minimum API route required to receive GitHub webhooks.

Use the repository's existing native `node:http` API architecture.

Do NOT migrate the API framework.

The endpoint should:

- accept GitHub webhook POST requests;
- read the raw request body where required for signature verification;
- inspect GitHub webhook headers;
- validate the event;
- return deterministic HTTP responses.

Use an appropriate webhook route such as the repository's established API naming convention.

Do not invent a route structure that conflicts with the existing API architecture.

==================================================
3. SIGNATURE VERIFICATION
==================================================

Verify GitHub webhook authenticity using the existing GitHub App webhook secret configuration.

Requirements:

- use the raw request body for HMAC verification;
- validate `X-Hub-Signature-256`;
- use timing-safe comparison;
- reject missing or invalid signatures;
- never trust webhook payloads before verification;
- never log the webhook secret;
- never expose the secret to the browser.

Do NOT weaken verification for local development.

Do NOT implement a bypass such as:

- `if (development) skip verification`
- accepting unsigned requests;
- accepting arbitrary test signatures.

Tests may use a deterministic test-only secret/configuration.

==================================================
4. EVENT FILTERING
==================================================

Handle only:

### Event
`pull_request`

### Actions
- `opened`
- `synchronize`

For unsupported pull-request actions:

- do not perform impact-analysis work;
- return a deterministic success/ignored response where appropriate;
- do not treat ignored events as failures.

For unrelated GitHub webhook event types:

- ignore them safely;
- do not execute pull-request processing.

Examples that should NOT trigger Step 41 processing:

- `issues`
- `push`
- `installation`
- `pull_request.closed`
- `pull_request.review_submitted`

Do not expand scope to those events.

==================================================
5. PAYLOAD VALIDATION
==================================================

Do not blindly trust the JSON shape.

Validate the minimum fields required for Step 41 processing.

At minimum inspect the actual GitHub payload shape needed for:

- repository identity;
- repository owner/name;
- pull request number;
- pull request URL/reference;
- pull request base/head information;
- installation identity;
- sender/user identity where needed;
- action.

Use the repository's existing validation conventions.

If a payload is malformed:

- reject it safely;
- return an appropriate 4xx response;
- do not create downstream work.

Do not create a new heavyweight schema system merely for this step.

==================================================
6. TENANT / INSTALLATION ASSOCIATION
==================================================

This is security-critical.

A GitHub webhook is not itself an authenticated Fluxora user request.

Use the existing GitHub App installation identity to determine which Fluxora organization/tenant owns the installation.

Do NOT trust:

- `organization_id` from the webhook payload;
- a client-supplied tenant ID;
- arbitrary repository metadata as a tenant identifier.

Use the existing installation mapping already established in Fluxora.

If the installation cannot be associated with a valid Fluxora tenant:

- reject or safely ignore the webhook according to the existing security conventions;
- do not enqueue tenant-scoped processing.

Do not implement cross-tenant fallback behavior.

==================================================
7. WEBHOOK NORMALIZATION
==================================================

Create a small internal normalized representation for the two supported events.

It should contain only the metadata downstream Step 42/43 will need.

For example, conceptually:

- event type;
- action;
- installation_id;
- organization/tenant identity derived server-side;
- repository identity;
- pull request number;
- pull request URL;
- base ref/SHA metadata;
- head ref/SHA metadata;
- sender metadata needed downstream.

Do not persist the full GitHub payload to a new database table in Step 41.

Do not invent permanent storage that belongs to Step 42.

Keep normalization deterministic.

==================================================
8. HANDOFF TO EXISTING ASYNC INFRASTRUCTURE
==================================================

Fluxora already has job/event infrastructure.

Determine the correct existing mechanism for handing verified webhook work to asynchronous processing.

Prefer:

GitHub webhook
    ↓
verify
    ↓
validate
    ↓
normalize
    ↓
enqueue existing job/event
    ↓
worker processes later

Do NOT perform expensive impact analysis synchronously inside the webhook request.

Do NOT implement the impact engine here.

The webhook endpoint should acknowledge quickly after successful validation/handoff.

If an existing job type convention exists, follow it.

Do NOT introduce a second queue.

==================================================
9. IDEMPOTENCY / DELIVERY SAFETY
==================================================

GitHub webhook deliveries can be retried.

Inspect the existing Fluxora idempotency mechanisms.

Use them rather than inventing a parallel mechanism.

The webhook handling must not cause duplicate downstream work when GitHub retries the same delivery.

Use GitHub's delivery identifier when appropriate and compatible with the existing job idempotency model.

Do not create a new database table solely for webhook delivery deduplication unless the existing architecture genuinely requires it.

Do not implement more persistence than this step needs.

==================================================
10. RESPONSE SEMANTICS
==================================================

Define deterministic webhook responses.

Examples:

- valid supported event accepted;
- valid but unsupported event ignored;
- malformed payload rejected;
- invalid signature rejected;
- unknown installation rejected/safely ignored according to security conventions.

Do not return stack traces or internal implementation details.

Never expose:

- secrets;
- database connection information;
- internal paths;
- raw exceptions.

==================================================
11. LOGGING / OBSERVABILITY
==================================================

Use the existing logging/telemetry conventions.

Log useful metadata such as:

- GitHub event type;
- action;
- repository;
- pull request number;
- delivery ID;
- installation ID where safe.

Do NOT log:

- webhook secrets;
- authorization credentials;
- full untrusted payloads unnecessarily;
- sensitive tokens.

Do not introduce a new logging framework.

==================================================
12. TESTS
==================================================

Add focused tests for Step 41.

At minimum cover:

1. valid `pull_request.opened` webhook is accepted;
2. valid `pull_request.synchronize` webhook is accepted;
3. invalid signature is rejected;
4. missing signature is rejected;
5. tampered payload fails verification;
6. unsupported pull-request actions are safely ignored;
7. unrelated GitHub webhook event types are ignored;
8. malformed pull-request payload is rejected;
9. missing repository identity is rejected;
10. missing pull request number is rejected;
11. missing installation identity is rejected;
12. unknown/unmapped installation does not create tenant-scoped work;
13. verified event is normalized correctly;
14. normalized event contains server-derived tenant association;
15. webhook processing uses the existing queue/job mechanism;
16. duplicate delivery does not create duplicate downstream work when the existing idempotency mechanism is applied;
17. webhook handling does not execute impact analysis synchronously;
18. secrets are never included in logs or responses.

Preserve every existing test.

Do NOT weaken security assertions to make tests pass.

Do NOT delete or skip existing tests.

==================================================
13. SHARED TYPES
==================================================

Only modify `packages/shared-types` if a shared normalized webhook/job type is genuinely needed by both API and worker code.

Do not create broad webhook schemas.

Keep types minimal and specific to:

`pull_request.opened`
`pull_request.synchronize`

Avoid coupling the shared types to future Step 42 database models.

==================================================
14. WORKER SCOPE
==================================================

If the existing queue architecture requires a worker-side handler for the newly enqueued webhook job:

implement ONLY the minimal handoff/acceptance boundary needed for Step 41.

Do NOT implement:

- PR persistence;
- changed-file extraction;
- diff generation;
- impact traversal;
- impact persistence.

The worker may acknowledge/route the normalized event, but the actual PR analysis belongs to later steps.

If no worker-side code is required yet because the existing queue already supports the handoff abstraction, do not add speculative worker implementation.

==================================================
15. DATABASE SCOPE
==================================================

Do NOT add:

- `PullRequest` table;
- changed-file table;
- diff table;
- `ImpactAnalysis` table;
- new graph tables.

Step 42 owns PR persistence.

Use existing database structures only when required by the current GitHub installation/tenant lookup.

No new migration should be created for Step 41 unless inspection proves an existing architecture requirement cannot work without one.

Prefer zero database migrations for this step.

==================================================
16. DOCUMENTATION
==================================================

Create:

### Implementation document

`learning/implementations/phase-06/step-41-github-pull-request-webhook-handling.md`

Include:

- objective;
- exact scope;
- existing GitHub App architecture reused;
- webhook request flow;
- signature verification;
- payload validation;
- supported events/actions;
- tenant/installation association;
- normalization;
- idempotency;
- queue/job handoff;
- response semantics;
- security invariants;
- observability;
- failure modes;
- limitations;
- verification;
- explicit boundary against Steps 42–47.

### Learning notes

`learning/notes/41. GitHub Pull Request Webhook Handling.md`

Explain in plain English:

- what a webhook is;
- GitHub webhook delivery;
- HMAC signature verification;
- why raw request bodies matter;
- why webhook handlers should be fast;
- async job handoff;
- retries/idempotency;
- installation-to-tenant association;
- trust boundaries.

### Interview cheat sheet

`learning/interviews/41. Step 41 GitHub Pull Request Webhook Handling Interview CheatSheet.md`

Include:

- likely interview questions;
- concise answers;
- webhook architecture;
- signature verification;
- HMAC;
- timing-safe comparison;
- idempotency;
- retries;
- tenant isolation;
- async processing;
- security tradeoffs;
- webhook vs polling;
- failure handling.

### DESIGN.md

Update `docs/DESIGN.md` with a Step 41 architecture section.

Do NOT delete or rewrite previous Step 1–40 sections.

Do NOT document future Step 42+ behavior as already implemented.

==================================================
17. VERIFICATION
==================================================

Run the relevant focused API tests first.

Then run:

- affected package tests;
- `pnpm test`;
- `pnpm typecheck`;
- `pnpm lint`;
- `pnpm lint:evidence`;
- `pnpm build`;
- `git diff --check`.

Report actual results.

Fix ONLY problems introduced by Step 41.

==================================================
18. FINAL SCOPE GUARD
==================================================

The final diff must contain ONLY:

- Step 41 GitHub pull request webhook handling;
- minimal shared types if required;
- minimal async handoff integration if required;
- Step 41 tests;
- Step 41 learning documentation;
- Step 41 DESIGN.md section.

DO NOT:

- create PullRequest persistence;
- store changed files;
- store diffs;
- implement impact analysis;
- implement impact traversal;
- create ImpactAnalysis persistence;
- add impact-analysis REST endpoints;
- add frontend PR overlay;
- change GraphCanvas semantics;
- add AI reasoning;
- add simulation;
- modify graph traversal;
- modify existing graph-query behavior;
- introduce polling;
- create a second queue;
- create a second GitHub App integration;
- add unrelated dependencies;
- perform unrelated refactors;
- add speculative future infrastructure.

==================================================
19. FINAL REPORT
==================================================

At the end report:

1. exact files created;
2. exact files modified;
3. exact webhook endpoint;
4. supported event/action combinations;
5. signature-verification mechanism;
6. tenant/installation association mechanism;
7. normalized webhook structure;
8. existing async queue/job mechanism reused;
9. idempotency strategy;
10. test results;
11. typecheck/lint/build results;
12. explicit confirmation that Steps 42–47 were NOT implemented.

Do NOT commit or push.