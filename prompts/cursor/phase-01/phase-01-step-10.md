Implement ONLY Fluxora Global Step 10: GitHub App integration + installation flow.

First inspect the current repo and reuse existing architecture/dependencies. Do not introduce Express/Fastify/new auth/router/SDK unless truly necessary. Do not waste tokens installing anything that can be handled manually; report any manual prerequisite/configuration I need to do.

Scope:
- GitHub App config/env support
- GitHub App JWT generation
- dynamic installation_id (never hard-code)
- treat github_installation_id as a string in API/input handling; persist appropriately in PostgreSQL
- verify GitHub installation belongs to the authenticated Clerk user's GitHub account
- tenant-scoped GitHub installation persistence with PostgreSQL + existing RLS conventions
- idempotent installation completion
- API endpoint for installation completion
- Next.js GitHub Setup URL route
- Dashboard "Connect GitHub" action only
- secure error handling / secret handling
- focused Step 10 tests

Do not build the full dashboard UI or redesign the dashboard.

Use the existing native node:http API, Clerk authentication and current DB/RLS architecture.

Do NOT implement anything beyond Global Step 10:
- Repository/Snapshot/Commit
- repository ingestion/download/clone
- S3 snapshot upload
- ingestion workers
- repository.indexed events
- WebSockets
- PR webhooks/impact analysis
- AST/graph/code intelligence

Also create/update the learning artifacts from the ACTUAL implementation:
1. learning/9. Github App Installation.md
2. learning/phase-02/step-10-github-app-installation.md
3. interviews/3. Github App Installation Interview CheatSheet.md
4. Update the EXISTING full docs/DESIGN.md.

Preserve all existing content in docs/DESIGN.md; update/append Step 10 sections without replacing, truncating, or rewriting unrelated sections.

The notes must explain the actual implementation and reasoning, including:
- GitHub App vs Clerk
- App ID vs installation ID
- dynamic installation IDs
- GitHub App JWT
- installation verification
- Setup URL flow
- tenant mapping/RLS
- least privilege
- idempotency
- security/trade-offs
- any real bug/debugging lesson encountered

Do NOT run pnpm typecheck/lint/test/build; we will do verification ourselves.

At the end report only:
- files changed
- manual steps I must do in GitHub/Vercel/.env
- anything you could not implement