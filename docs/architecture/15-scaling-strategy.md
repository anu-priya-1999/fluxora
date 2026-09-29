# 15. Scaling Strategy: 1 Repo → 100 Repos → 10,000 Repos

## 15.1 At 1 repository (MVP / portfolio-demo scale)

- Single Postgres instance, no read replica needed.
- Worker pool of 1–3 instances per worker type, mostly idle.
- No caching layer strictly required, though Redis is present from day one for correctness (rate limiting, job locks) even if load doesn't demand it.
- Graph queries hit Postgres directly with no pre-aggregation; a single repo's graph (thousands of nodes) renders fine client-side without clustering.
- Cost is dominated by LLM API calls, not infrastructure (`16-cost-model.md`).

**Bottleneck at this scale: none, by design.** This tier exists to prove correctness, not to be stressed.

## 15.2 At ~100 repositories (early customers / small team usage)

- **Database:** still single Postgres instance is fine for OLTP load, but introduce a **read replica** for graph-query-heavy read traffic (Architecture Explorer views) to isolate read load from ingestion/analysis write load.
- **Workers:** autoscaling on queue depth becomes meaningful — analysis jobs are bursty (a customer connects 10 repos at once) and the worker pool should scale from ~3 to ~15 instances transiently rather than being sized for peak at all times.
- **Caching:** graph-query results for "hot" analysis runs (the latest run per repo, viewed repeatedly) get a Redis cache layer with invalidation on `graph.updated` — meaningfully cuts repeated-traversal DB load.
- **LLM cost control becomes real:** response caching (`16-cost-model.md`) for repeated identical questions/impact explanations becomes worth the engineering investment at this volume.
- **Introduce per-tenant rate limiting enforcement in practice** (was architected from day one, but this is the scale where a single noisy tenant could actually affect others).

**Bottleneck emerging: analysis worker throughput during connect-many-repos bursts**, addressed by worker autoscaling + a fair-scheduling policy in the job queue (round-robin across organizations rather than strict FIFO, so one org's 50-repo bulk-connect doesn't starve another org's single urgent PR analysis).

## 15.3 At ~10,000 repositories (production, many-tenant scale)

- **Database:** single Postgres, even with a read replica, becomes the real constraint — both on write throughput (constant ingestion/analysis/impact writes across many tenants) and on graph-table size (tens of millions of `GraphNode`/`GraphEdge`/`Evidence` rows).
  - **Sharding strategy:** shard by `organization_id` — this works cleanly because Fluxora's queries are almost always tenant-scoped already (Principle P9's multi-tenancy-from-day-one pays off directly here: there is no cross-tenant query pattern to break when sharding). A router layer directs queries to the correct shard based on `organization_id`.
  - **Alternative/complementary:** move the graph specifically to a dedicated graph engine at this point if the concrete triggers in `06-database-schema.md §6.1` have been hit (which, at 10k repos, they likely have — cross-tenant analytics, or per-tenant graphs large enough that traversal latency has become a measured problem).
- **Search:** Postgres full-text search is replaced by a dedicated search index (OpenSearch) for symbol/evidence search across this volume.
- **Object storage:** no architectural change needed — S3-compatible storage scales horizontally by design; only lifecycle/retention policy tuning to control cost (`16-cost-model.md`).
- **Workers:** worker fleets are large and genuinely need sophisticated autoscaling (predictive/scheduled scaling for known bulk-onboarding events, not just reactive queue-depth scaling) and possibly geographic/regional distribution if customers are latency-sensitive and globally distributed.
- **Job queue:** the Postgres-backed queue (`08-event-schema.md §8.1`, `05-component-responsibilities.md §5.16`) is replaced by a managed queue (SQS) or Kafka at this point — the trigger conditions from `08-event-schema.md §8.1` are met (event volume, need for external consumers/webhooks at scale).
- **Multi-region:** becomes a real consideration for latency and data-residency requirements (some enterprise customers will require EU data residency) — Postgres-per-region with tenant-to-region assignment at onboarding.

## 15.4 What does *not* change across all three scales

- The deterministic-core/AI-edge separation (Principle P1).
- The evidence model and its schema.
- The event catalog (only its transport changes, not its shape, per `08-event-schema.md §8.5`).
- The API contract (internal scaling changes are invisible to API consumers, by design — this is exactly what the BFF/API layer exists to insulate against).

This is the intended payoff of the architecture principles: scaling from 1 to 10,000 repos is a story about swapping *implementations* behind stable interfaces (storage engine, queue transport, search engine), not about redesigning the product's core model.
