# Step 41 — GitHub Pull Request Webhook Handling

## Objective

Implement the secure reception, HMAC-SHA256 signature verification, payload validation, event filtering, normalization, server-side tenant association, and asynchronous job queue handoff for GitHub pull request webhooks (`pull_request.opened` and `pull_request.synchronize`).

This begins **Phase 6: PR Impact Analysis** as strictly defined by `docs/architecture/17-implementation-roadmap.md`.

## Exact Scope

- **Modified**:
  - `packages/db/src/repositories/github-installation.ts`: Added `getGithubInstallationByInstallationId` lookup function without adding any new table or migration.
  - `packages/db/src/repositories/github-installation.test.ts`: Added unit tests for installation lookup by installation id.
  - `packages/db/src/index.ts`: Exported `getGithubInstallationByInstallationId`.
  - `packages/shared-types/src/jobs.ts`: Defined `PULL_REQUEST_WEBHOOK_JOB_TYPE`, `SupportedPullRequestAction`, `NormalizedPullRequestWebhookPayload`, `pullRequestWebhookIdempotencyKey`, and `parsePullRequestWebhookPayload`.
  - `packages/shared-types/src/index.ts`: Re-exported the new types and helpers.
  - `apps/api/src/github/config.ts`: Added optional `webhookSecret` to `GithubAppConfig` and exported `loadGithubWebhookSecret`.
  - `apps/api/src/http/server.ts`: Added `githubWebhookDeps` injection support to `CreateApiServerOptions`, routed `/api/v1/webhooks/github` and `/api/v1/github/webhooks` to `handleGithubWebhook`, and registered paths in `isKnownPath`.
  - `apps/workers/src/handlers.ts`: Registered `[PULL_REQUEST_WEBHOOK_JOB_TYPE]` in default job handlers with minimal handoff/acknowledgement boundary.
  - `apps/workers/src/worker.test.ts`: Added worker execution test for `pull_request.webhook` jobs.
- **Created**:
  - `apps/api/src/github/webhook-signature.ts`: Timing-safe HMAC-SHA256 signature verification module (`verifyGithubWebhookSignature`, `computeGithubWebhookSignature`).
  - `apps/api/src/github/webhook-signature.test.ts`: Focused unit tests for HMAC signature verification.
  - `apps/api/src/http/github-webhooks.ts`: HTTP request handler for incoming GitHub webhooks (`handleGithubWebhook`, `isGithubWebhookPath`, `GITHUB_WEBHOOK_PATH`).
  - `apps/api/src/http/github-webhooks.test.ts`: 20 focused tests covering all 18 requirements from Section 12.
- **Explicit Boundary Against Steps 42–47**:
  - Step 41 does **NOT**:
    - Create `PullRequest` table or migrations (owned by Step 42);
    - Store changed files or diffs (owned by Step 42);
    - Implement Impact Analysis Engine or BFS/DFS symbol traversal (owned by Step 43);
    - Persist `ImpactAnalysis` records or evidence (owned by Step 44);
    - Add impact analysis REST endpoints (owned by Step 45);
    - Add frontend change-mode overlay on GraphCanvas (owned by Step 46);
    - Execute golden-fixture PR tests (owned by Step 47);
    - Add AI reasoning, simulation, or WebSocket live events for PR impact.

## Existing GitHub App Architecture Reused

Step 41 builds on Phase 2's GitHub App architecture:
1. **Installation Persistence (`packages/db`)**:
   - Reuses `github_installations` table (created in `0008_github_installations.sql`).
   - Reuses `isCanonicalGithubId` string validation from `@fluxora/shared-types`.
   - Uses `getGithubInstallationByInstallationId` to resolve the installation ID to a stored `organizationId`.
2. **Configuration (`apps/api/src/github/config.ts`)**:
   - Reuses environment resolution (`GITHUB_WEBHOOK_SECRET` / `GITHUB_APP_WEBHOOK_SECRET`).
3. **Queue / Async Job Infrastructure (`packages/db`, `packages/shared-types`, `apps/workers`)**:
   - Reuses `jobs` table with `ON CONFLICT (organization_id, idempotency_key) DO UPDATE SET id = jobs.id RETURNING ...`.
   - Reuses standard `enqueueJob` API.
   - Enqueues `PULL_REQUEST_WEBHOOK_JOB_TYPE` (`"pull_request.webhook"`).
   - Reuses `apps/workers` job dispatching architecture.

## Webhook Request Flow

```
GitHub Webhook Delivery (POST /api/v1/webhooks/github)
                     ↓
      Read Raw Request Body Buffer (max 1MB cap)
                     ↓
         HMAC-SHA256 Signature Verification
     (X-Hub-Signature-256 vs computed digest)
       ├─ Missing / Invalid → 401 Unauthorized
       └─ Secret unconfigured → 500 Internal Error
                     ↓
            Filter Event Header
     (X-GitHub-Event: "pull_request" vs other)
       └─ Unrelated event → 200 OK { status: "ignored" }
                     ↓
              Parse JSON Body
       └─ Malformed JSON → 400 Bad Request
                     ↓
            Filter Payload Action
       ("opened" | "synchronize" vs other)
       └─ Unsupported action → 200 OK { status: "ignored" }
                     ↓
        Validate Minimum Required Fields
   (repository.id, number, installation.id, base/head refs)
       └─ Missing / Malformed → 400 Bad Request
                     ↓
       Server-Side Tenant Resolution
   (lookup github_installations by installation.id)
       └─ Unmapped installation → 404 Not Found (no work enqueued)
                     ↓
     Deterministic Normalization & Idempotency Key
       (NormalizedPullRequestWebhookPayload)
                     ↓
           Enqueue Asynchronous Job
   (enqueueJob -> PULL_REQUEST_WEBHOOK_JOB_TYPE)
       └─ Retries deduped via PostgreSQL unique constraint
                     ↓
     Fast Acknowledgment Response (200 OK)
   { ok: true, status: "accepted", jobId, deliveryId }
```

## Signature Verification

- **Algorithm**: HMAC-SHA256.
- **Input**: The exact raw request body buffer received over the wire (`Buffer`), before any JSON parsing or string transformations.
- **Header**: `X-Hub-Signature-256`. Format: `sha256=<64-character hex digest>`.
- **Comparison**: Uses `crypto.timingSafeEqual` with strict buffer length checks to protect against timing attacks.
- **Security Invariants**:
  - Payloads are never parsed or trusted prior to successful signature verification.
  - Verification is never skipped or bypassed in development or test environments.
  - Secrets are never logged, reflected in responses, or exposed to the client.

## Payload Validation & Event Filtering

- **Event Filtering**:
  - Only `x-github-event === "pull_request"` is processed.
  - Unrelated events (`push`, `issues`, `installation`, etc.) return `200 OK` with `{ ok: true, status: "ignored", reason: "unsupported_event" }`.
- **Action Filtering**:
  - Only `action === "opened"` and `action === "synchronize"` are accepted.
  - Unsupported actions (`closed`, `reopened`, `labeled`, `review_requested`, etc.) return `200 OK` with `{ ok: true, status: "ignored", reason: "unsupported_action" }`.
- **Required Fields**:
  - `repository.id`: Valid decimal string or number matching `isCanonicalGithubId`. Missing or non-canonical returns `400 Bad Request` with `missing_repository_identity`.
  - `number`: Positive integer. Missing or non-integer returns `400 Bad Request` with `missing_pull_request_number`.
  - `installation.id`: Valid decimal string or number matching `isCanonicalGithubId`. Missing or non-canonical returns `400 Bad Request` with `missing_installation_identity`.
  - `pull_request.base` (`ref`, `sha`) and `pull_request.head` (`ref`, `sha`): Non-empty strings. Missing returns `400 Bad Request` with `missing_pull_request_details`.

## Tenant / Installation Association

- Webhooks are unauthenticated server-to-server requests; client-provided tenant parameters are untrusted.
- The webhook's `installation.id` is queried against the authoritative `github_installations` table.
- If the installation is unknown / not registered:
  - The request returns `404 Not Found` with `{ error: { code: "unknown_installation", message: "GitHub App installation is not registered." } }`.
  - No tenant-scoped work or job is created.
- If the installation is found:
  - `organizationId = installation.organizationId` is derived strictly server-side.
  - Cross-tenant fallback or injection is impossible.

## Webhook Normalization

The payload is projected into a compact domain type:
```ts
export interface NormalizedPullRequestWebhookPayload {
  readonly eventType: "pull_request";
  readonly action: SupportedPullRequestAction;
  readonly deliveryId?: string;
  readonly installationId: string;
  readonly organizationId: string;
  readonly repository: {
    readonly githubRepoId: string;
    readonly name: string;
    readonly owner: string;
    readonly fullName: string;
  };
  readonly pullRequest: {
    readonly number: number;
    readonly url: string;
    readonly title?: string;
    readonly baseRef: string;
    readonly baseSha: string;
    readonly headRef: string;
    readonly headSha: string;
  };
  readonly sender?: {
    readonly githubUserId: string;
    readonly login: string;
  };
}
```

## Idempotency & Delivery Safety

- GitHub delivers an `X-GitHub-Delivery` header containing a GUID unique to the delivery.
- The job queue's idempotency key is derived as:
  `pull_request.webhook:${deliveryId}` (or fallback to repo, PR number, head SHA, and action if delivery ID is absent).
- When GitHub retries the delivery, `jobs` table's `ON CONFLICT (organization_id, idempotency_key) DO UPDATE SET id = jobs.id` ensures zero duplicate jobs are inserted.
- The webhook handler responds with `200 OK` and returns the existing job ID.

## Queue / Job Handoff & Worker Scope

- Handed off asynchronously via `enqueueJob`:
  - Job type: `PULL_REQUEST_WEBHOOK_JOB_TYPE` (`"pull_request.webhook"`).
  - No synchronous analysis or diff calculation occurs inside the HTTP request.
- Worker fleet integration:
  - `apps/workers/src/handlers.ts` registers a minimal acknowledgement handler for `pull_request.webhook` jobs so that claimed jobs complete cleanly without failure.
  - Actual PR diff retrieval and impact analysis are deferred to Steps 42 and 43.

## Response Semantics

| Condition | HTTP Status | Response Body |
| --- | --- | --- |
| Valid `opened` or `synchronize` | `200 OK` | `{ ok: true, status: "accepted", jobId: string, deliveryId: string \| null, pullRequest: { number: number } }` |
| Valid but unsupported action | `200 OK` | `{ ok: true, status: "ignored", reason: "unsupported_action", action: string }` |
| Valid but unsupported event | `200 OK` | `{ ok: true, status: "ignored", reason: "unsupported_event", event: string }` |
| Missing signature | `401 Unauthorized` | `{ error: { code: "missing_signature", message: "Signature verification failed." } }` |
| Invalid / tampered signature | `401 Unauthorized` | `{ error: { code: "invalid_signature", message: "Signature verification failed." } }` |
| Malformed JSON body | `400 Bad Request` | `{ error: { code: "invalid_payload", message: "Request body must be valid JSON." } }` |
| Missing repository identity | `400 Bad Request` | `{ error: { code: "missing_repository_identity", message: "Repository identity is required." } }` |
| Missing pull request number | `400 Bad Request` | `{ error: { code: "missing_pull_request_number", message: "Pull request number is required." } }` |
| Missing installation identity | `400 Bad Request` | `{ error: { code: "missing_installation_identity", message: "Installation identity is required." } }` |
| Missing base/head ref/sha | `400 Bad Request` | `{ error: { code: "missing_pull_request_details", message: "Pull request details are required." } }` |
| Unknown installation ID | `404 Not Found` | `{ error: { code: "unknown_installation", message: "GitHub App installation is not registered." } }` |
| Server missing webhook secret | `500 Internal Error` | `{ error: { code: "webhook_not_configured", message: "Webhook processing is not configured." } }` |
| Method not POST (e.g. GET) | `405 Method Not Allowed` | `{ error: { code: "method_not_allowed", message: "Method not allowed." } }` |

## Observability

- OpenTelemetry span `fluxora.github.webhook` records:
  - `fluxora.github.event`: `"pull_request"`
  - `fluxora.github.action`: `"opened"` | `"synchronize"`
  - `fluxora.github.delivery`: delivery GUID
  - `fluxora.github.pr_number`: PR number
  - `fluxora.github.repo`: full repository name
  - `fluxora.organization_id`: tenant organization UUID
  - `fluxora.job.id`: enqueued job UUID
- Secrets, credentials, and untrusted payload dumps are excluded from logs.

## Failure Modes & Mitigations

1. **Replay attacks / tampering**: Mitigated by HMAC-SHA256 validation with constant-time equality checks over raw body bytes.
2. **Duplicate webhook deliveries**: Mitigated by `X-GitHub-Delivery`-based idempotency keys on the PostgreSQL `jobs` table.
3. **Payload / resource exhaustion (DoS)**: Mitigated by a strict 1MB payload size cap returning `413 Payload Too Large`.
4. **Tenant spoofing**: Mitigated by mapping `installation.id` to server-persisted `github_installations` records; incoming tenant IDs are disregarded.
5. **Slowdown / worker starvation**: Webhook handler returns immediately after enqueuing work; no heavy AST or traversal work is synchronous.

## Verification

1. `apps/api/src/http/github-webhooks.test.ts`: 20 tests verifying all 18 Section 12 requirements plus method check and alternative path routing.
2. `apps/api/src/github/webhook-signature.test.ts`: 7 tests verifying HMAC calculations, timing-safe equality, prefix checks, and edge cases.
3. `apps/workers/src/worker.test.ts`: Added test verifying default handler registration and clean execution of `pull_request.webhook` jobs.
4. `packages/db/src/repositories/github-installation.test.ts`: Added tests verifying non-canonical installation ID handling.
5. Monorepo suites:
   - `pnpm test` (all packages pass)
   - `pnpm typecheck` (all packages pass)
   - `pnpm lint` (clean)
   - `pnpm lint:evidence` (clean)

