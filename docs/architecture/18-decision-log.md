# 18. Decision Log

Format: **Decision — Alternatives considered — Why this one.**

---

### ADR-001: Deterministic core, LLM narrates only
**Decision:** Graph construction, impact traversal, and simulation propagation are pure deterministic code; the LLM only explains already-computed results.
**Alternatives considered:** (a) LLM-driven graph construction (feed it the repo, ask it to describe the architecture); (b) LLM-assisted traversal ("ask the model what this change might affect").
**Why not (a)/(b):** Both make the product's core value proposition (blast-radius correctness) probabilistic and unverifiable — exactly the failure mode the product thesis explicitly rejects ("must not feel like a chatbot attached to GitHub"). A wrong blast-radius claim is a trust-destroying failure for this product category in a way a slightly awkward sentence isn't.

---

### ADR-002: PostgreSQL for the graph (not Neo4j) in MVP
**Decision:** Model the graph as adjacency-list tables in Postgres, using recursive CTEs for bounded-depth traversal.
**Alternatives considered:** Neo4j, Memgraph, a managed graph database from day one.
**Why not a graph DB immediately:** MVP graph sizes (single-repo, thousands to tens of thousands of edges) and bounded-depth traversal patterns don't need native graph-engine algorithms. A second database introduces cross-database transactional consistency problems between the graph and the evidence/tenancy data that outweigh the query-ergonomics benefit at this scale. Concrete upgrade triggers are defined (`06-database-schema.md §6.1`) so this isn't "never," it's "not yet, and here's exactly when."

---

### ADR-003: Typed polymorphic `GraphNode` table vs. per-entity-type tables
**Decision:** `Application`/`Service`/`Package`/`API`/`Event`/`DatabaseResource` are rows in one `GraphNode` table (`node_type` discriminator + JSONB metadata).
**Alternatives considered:** Seven separate tables with typed foreign keys.
**Why:** Graph traversal must be uniform across node types; separate tables force either N-way UNIONs or a discriminator column on every edge anyway. The JSONB metadata trade-off (less column-level type safety) is acceptable given Postgres's JSONB/GIN indexing support.

---

### ADR-004: Postgres-backed job queue for MVP, not Kafka/SQS immediately
**Decision:** A `jobs` table with `SELECT ... FOR UPDATE SKIP LOCKED` polling, plus a transactional outbox for events.
**Alternatives considered:** Kafka, AWS SQS/SNS from day one.
**Why not immediately:** Adds real operational complexity (cluster/topic management, or a managed-service dependency and its own failure modes) not justified until event volume or the need for external/durable-replay consumers actually materializes. The transactional-outbox pattern used here is the same pattern that underlies a later migration to Kafka via CDC, so this isn't a dead end — it's a deliberately deferred upgrade with a clear path (`08-event-schema.md §8.5`, `15-scaling-strategy.md §15.3`).

---

### ADR-005: REST + a scoped graph-query DSL, not full GraphQL
**Decision:** REST for CRUD/orchestration; a purpose-built `POST /graph/query` endpoint for flexible graph reads.
**Alternatives considered:** Full GraphQL schema across the whole API.
**Why not full GraphQL:** Most of the API surface (repositories, PRs, scenarios, jobs) is standard resource CRUD where GraphQL's flexibility doesn't pay for its complexity (dataloader N+1 mitigation, per-field auth, schema versioning discipline). Only the graph-read pattern genuinely benefits from client-specified query shape, and a narrow, purpose-built query DSL gets that benefit without adopting GraphQL wholesale.

---

### ADR-006: Context Assembler never gives the LLM raw file content as a basis for factual claims
**Decision:** The AI layer receives structured, pre-verified evidence records; raw code excerpts are allowed only for explanatory context, explicitly labeled, and never as the basis for a *relationship* claim.
**Alternatives considered:** Feed the model the full diff/file content and let it reason about impact directly ("agentic" code-reading approach).
**Why not:** This is the single most important reliability decision in the AI architecture — it's what makes grounding checkable at all (`09-ai-architecture.md §9.6`) and what makes the prompt-injection mitigation structural rather than best-effort (`11-security-architecture.md §11.9`). An agentic "let the model read the code and decide" approach is more flexible but reintroduces exactly the unverifiability ADR-001 rejects, one layer up.

---

### ADR-007: Containers on a managed platform, not Kubernetes, for MVP
**Decision:** Managed container platform (ECS Fargate / Cloud Run / equivalent).
**Alternatives considered:** Self-managed Kubernetes cluster.
**Why not K8s yet:** Operational overhead of running a K8s control plane isn't justified until scaling sophistication genuinely needs it (custom scheduling, service mesh, multi-region active-active). Managed container platforms provide autoscaling and zero-downtime deploys without that overhead. Revisit at the 10,000-repo scale tier if concrete needs (not just "K8s is standard") emerge.

---

### ADR-008: Sharding by `organization_id`, not by another dimension, at large scale
**Decision:** When Postgres sharding becomes necessary (`15-scaling-strategy.md §15.3`), shard by tenant.
**Alternatives considered:** Shard by repository, by graph size, by geography-first.
**Why organization_id:** Nearly every query in the system is already tenant-scoped (Principle P9, enforced via RLS from day one), so there is no cross-tenant query pattern that sharding breaks. This is a direct payoff of the multi-tenancy-from-day-one principle, not a coincidence — it's why P9 is listed as a core principle rather than an implementation detail.

---

### ADR-009: No code execution, static analysis only
**Decision:** Fluxora never executes, `eval`s, or `require()`s any part of a connected repository.
**Alternatives considered:** Sandboxed execution to observe actual runtime behavior for higher-fidelity dependency discovery.
**Why not:** Executing arbitrary, untrusted third-party/customer code is a severe RCE/security-boundary risk that static analysis avoids by construction. The confidence/evidence model (P3) is specifically designed to make static analysis's inherent incompleteness visible and honest, rather than solved by trading it for a much larger security surface.

---

### ADR-010: Deterministic fallback explanation when AI validation fails
**Decision:** If the LLM's structured output fails schema/grounding validation after retries, fall back to a template-generated, non-AI explanation rather than showing nothing or showing an unvalidated response.
**Alternatives considered:** Block the impact report until AI generation succeeds; show the raw (unvalidated) model output anyway with a warning label.
**Why:** Principle P10 — the AI layer must fail safely. Blocking the core deterministic result on AI availability couples the product's reliability to a third-party API's reliability, which is an unnecessary and avoidable dependency. Showing unvalidated output risks exactly the hallucination/trust failure the whole architecture exists to prevent.
