Implement ONLY Fluxora Global Step 16: ingestion failure-path hardening.

First inspect the current Fluxora codebase and Git history. Preserve all existing Step 15 behavior. Do NOT implement Step 17 or any Phase 3+ work.

Step 16 goal:
Handle ingestion failure paths correctly for:
- revoked/inaccessible GitHub access
- oversized repositories
- invalid GitHub refs
- unsafe archives
- GitHub rate limiting
- temporary GitHub outages/timeouts
- temporary object-storage failures

Required behavior:

1. Permanent failures
   - GitHub 401/403 or revoked installation:
     code = github_auth
     repository status = needs_reauth
     must NOT retry
   - inaccessible repository:
     repository status = needs_reauth
     must NOT retry
   - invalid ref:
     code = invalid_ref
     repository status = error
     must NOT retry
   - oversized repository/archive:
     code = repository_too_large
     repository status = error
     must NOT retry
   - unsafe archive / snapshot conflict:
     permanent failure
     must NOT retry

2. Retryable failures
   - GitHub rate limit
   - temporary GitHub outage
   - timeout
   - temporary object-storage failure
   These must remain retryable and must NOT change the repository to error or needs_reauth.

3. Retry backoff
   The current worker uses a fixed retry delay. Change it to deterministic bounded exponential backoff using the existing retryDelaySeconds as the base:

   delay = min(baseDelay * 2^(attemptCount - 1), 300 seconds)

   With the current default base of 5 seconds this should become:
   5s → 10s → 20s → 40s → 80s → 160s → 300s

   Preserve the existing maxAttempts behavior.

4. Tests
   Add/update node:test coverage for:
   - revoked GitHub access
   - inaccessible repository
   - invalid ref
   - oversized repository/archive
   - rate-limit retry
   - exponential retry delays across attempts
   - temporary GitHub failure retry
   - temporary object-storage failure retry
   - permanent failures do not call retryFailedJob
   - retryable failures do call retryFailedJob
   - existing temporary working-directory cleanup remains intact

5. Preserve architecture
   - Keep tenant isolation unchanged.
   - Keep PostgreSQL/RLS behavior unchanged.
   - Keep Step 15 repository.indexed events unchanged.
   - Keep WebSocket behavior unchanged.
   - Do not redesign IngestionError unless strictly required.
   - Do not add new queues, services, APIs, UI, AI, graph logic, or database tables.

6. Documentation
   Add/update:
   - learning/implementations/phase2/step16/
   - learning/notes/
   - learning/interviews/
   - docs/DESIGN.md

   Do not delete existing documentation. Keep terminology consistent with the existing Fluxora architecture.

7. Verification
   Run:
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm build

At the end, report:
- exact files changed
- what was already present vs what Step 16 added
- tests passed/failed
- any remaining issue

Do not modify unrelated files.