# 14. Local Development Architecture

## 14.1 Goals

A new contributor (or future-you returning after a break) should be able to run the full pipeline — connect a repo, see it analyzed, see the graph, run an impact analysis — locally within minutes, without needing real GitHub App credentials or burning real LLM API spend for routine frontend/backend work.

## 14.2 Local stack

```
docker-compose.yml:
  - postgres (with the same schema/migrations as production)
  - redis
  - minio (S3-compatible, for local object storage)
  - mailhog (if/when email notifications exist)

apps:
  - api (Node/TS, hot-reload)
  - workers (all worker types runnable as a single local process pool for simplicity, split into separate processes only in staging/production)
  - web (Next.js dev server)
```

Single `docker-compose up` + a `make dev` (or `pnpm dev`) target brings up the full stack.

## 14.3 Seed data & fixtures

- A seed script populates a local organization, a test user, and imports one or two of the "golden-fixture" repositories (`12-testing-strategy.md §12.4`) directly from a pre-fetched snapshot committed to the repo (or fetched once and cached), so local development doesn't require live GitHub API access by default.
- A `make seed-large` variant seeds a synthetic large graph (procedurally generated, thousands of nodes/edges) specifically for testing graph-visualization performance and traversal-depth-limit behavior locally.

## 14.4 Mocking external dependencies

- **GitHub API:** local dev defaults to replaying recorded fixture responses (the same VCR-style recordings used in integration tests, `12-testing-strategy.md §12.2`) via a local mock server, with an opt-in flag to hit the real GitHub API using a personal developer GitHub App installation for testing the ingestion path itself.
- **LLM (Claude API):** local dev defaults to a mock Model Gateway implementation that returns deterministic, schema-valid canned responses (so UI/AI-panel work doesn't require API spend), with an opt-in `.env` flag (`USE_REAL_LLM=true`) plus a personal API key for actually testing prompt changes and AI evaluation locally.

## 14.5 Developer workflow niceties

- Hot-reload across API, workers, and frontend.
- A local admin UI route (`/dev/jobs`) to inspect the Postgres-backed job queue directly — see pending/running/failed jobs, manually retry/inspect payloads, without needing a separate queue-inspection tool.
- Structured logs printed human-readably in local dev (pretty-printed), JSON in every other environment (machine-readable for the log aggregator).
- `make reset-db` for a fast full reset back to seeded state during iteration.

## 14.6 What's intentionally *not* replicated locally

- Autoscaling behavior, multi-replica WebSocket fanout via Redis pub/sub (local dev runs a single instance — this is a known gap, exercised only in staging).
- Real GitHub webhook delivery (local dev triggers PR-analysis flows via a manual API call or a local webhook-replay script instead of exposing a public endpoint for GitHub to hit, unless the developer explicitly sets up a tunnel like ngrok for that specific test).
