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
**Operationalization (Step 60):** Implemented in `apps/workers/src/ai/context/` via `assembleImpactExplanationContext` and `buildImpactExplanationRequest`, generating the canonical `allowedEvidenceIds` grounding manifest, applying deterministic prioritization and character budgeting, and treating all repository strings as untrusted data within `<impact_context>` delimiters. Grounding distinguishes evidence integrity (Step 60), manifest membership (Step 61), and semantic evidence support (acknowledged limitation; `09-ai-architecture.md §9.4.2`).

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

---

### ADR-011: Composite Foreign Key for Scenario and Repository Referential Integrity
**Decision:** Enforce the repository-to-target-node relationship at the database storage engine level using a composite foreign key `FOREIGN KEY (repository_id, target_node_id) REFERENCES public.graph_nodes (repository_id, id) ON DELETE CASCADE` (Migration 0026). Denormalize `repository_id` onto `graph_nodes` with `UNIQUE (repository_id, id)`, backfill existing records, and deploy backward-compatible triggers. Harden lineage integrity forward-only (Migration 0027) by: (1) authoritatively deriving `repository_id` from `analysis_runs` $\to$ `repository_snapshots` on `graph_nodes` INSERT and rejecting explicit caller mismatches with SQLSTATE `23000` (while failing closed on unresolvable runs with `23503`); (2) enforcing strict immutability of both `repository_id` AND `analysis_run_id` on UPDATE with SQLSTATE `23000`; (3) verifying that upstream lineage (`analysis_runs.snapshot_id`, `repository_snapshots.repository_id`) is write-once; (4) enforcing test database isolation on disposable databases (`fluxora_fix4_test`), rejecting `fluxora_dev` and production; and (5) verifying concurrency via deterministic database-observed row lock waits (`pg_locks`).
**Alternatives considered:** (a) Application-level pre-validation only (`nodeCheck` query in `createScenario`); (b) Database trigger on `scenarios` verifying parent repository via subquery; (c) Check constraint with subquery (not supported by PostgreSQL); (d) Unvalidated caller-provided `repository_id` on INSERT.
**Why this one:** Application validation is advisory and subject to TOCTOU races, direct SQL bypasses, and omitted update validation. Subquery triggers on `scenarios` add execution overhead and do not establish declarative catalog foreign-key metadata or automatic row locking (`FOR KEY SHARE`). A composite foreign key provides relational engine atomicity, eliminates concurrency race conditions, automatically indexes the correlation, and guarantees that invalid cross-repository associations are rejected. Authoritative lineage derivation and dual immutability triggers on `graph_nodes` close identity-spoofing and lineage-severing bypasses at the database boundary.

---

### ADR-012: Separation of Fixture-Backed Simulation Edges from Production Graph Projections
**Decision:** When validating simulation propagation against golden repository fixtures whose current production static graph projection lacks functional call edges (`CALLS`), represent manually verified call relationships as explicit, test-only `SimulationEdge` records within an in-memory `SimulationGraphSnapshot`. Never mutate, convert, or relabel production `IMPORTS` edges as `CALLS`, and never persist test relationships into the production PostgreSQL graph.
**Alternatives considered:** (a) Reinterpret or relabel `IMPORTS` edges as `CALLS` during simulation propagation; (b) Add speculative `CALLS` extraction to the production pipeline during validation; (c) Validate only target failure without testing downstream propagation.
**Why this one:** Relabeling `IMPORTS` violates fundamental semantic boundaries and produces widespread false-positive blast-radius cascades. Rushing speculative call extraction compromises the frozen Step 33 golden graph contracts (490 nodes, 888 edges). A dedicated test-augmented snapshot grounded in a hand-verified, source-checked manifest (`fixtures/golden/simulation-manifest.json`) validates simulation engine mechanics, causal path tracking, assumption generation, and determinism while preserving the integrity and trustworthiness of the production graph extractor.

---

### ADR-013: Single Controlled Model Gateway Boundary with Secondary Model Fallback
**Decision:** Centralize all outbound model requests behind a single provider-independent `ModelGateway` interface within `@fluxora/workers/src/ai/`. Route task-aware requests to a primary Claude model (`claude-sonnet-5-5`) with bounded retries and exponential backoff, falling back automatically to a configured secondary Claude tier (`claude-haiku-5-5`) on exhaustion of eligible transient errors. Default to an offline, deterministic mock provider for local development (`USE_REAL_LLM=false`), and fail fast with sanitized configuration errors (never silently falling back to mock) when real LLM mode is enabled without verified credentials.
**Alternatives considered:** (a) Calling the Anthropic SDK directly across individual job handlers; (b) Introducing a separate external proxy service or third-party agent framework (LangChain/LiteLLM); (c) Silently falling back to mock mode when API keys are missing in real mode.
**Why this one:** Calling SDKs directly fragments retry logic, risks credential leakage in logs, and prevents uniform token cost accounting. Introducing an external proxy or heavy AI framework adds unneeded operational dependencies and latency. Centralizing within `@fluxora/workers` provides an observable, unit-testable boundary that tracks microdollar token costs, guarantees secret redaction, enforces per-task timeout budgets, and preserves the absolute independence of Fluxora's deterministic graph reasoning core. Fail-closed configuration validation guarantees that misconfigured production environments are detected immediately rather than silently serving mock data.

---

### ADR-014: Strict Whole-Response Rejection for Ungrounded Structured Output Citations
**Decision:** When validating model completions against the trusted evidence manifest (`allowedEvidenceIds`), enforce an atomic pass/fail outcome. Reject the entire response if any claim in the `claims` array cites an evidence ID outside the allowed manifest, omits citations, or includes duplicate IDs within a claim. Never silently strip invalid claims, delete ungrounded IDs, or accept partial output. Allow at most two total response attempts (initial generation plus one bounded corrective retry) with deterministic error instructions quoting codes and paths without echoing raw untrusted output. On retry exhaustion, return an explicit validation failure to enable downstream orchestration to trigger deterministic template fallback (Step 66 / ADR-010).
**Alternatives considered:** (a) Permissive partial claim stripping (delete invalid claims and keep the rest); (b) Permissive acceptance with warning badges in the UI; (c) Unbounded retries until valid.
**Why this one:** Claims within an explanation are interconnected; silently deleting invalid claims mutilates the narrative coherence of the summary and remaining claims. Silent stripping also hides prompt degradation and hallucinations from downstream evaluation suites. Whole-response rejection guarantees schema compliance and evidence-manifest membership (citation provenance), ensuring IDs absent from the trusted manifest cannot pass Step 61 validation, while acknowledging that manifest membership does not guarantee semantic evidence support. Step 61 returns an explicit validation failure when retries are exhausted; downstream orchestration (Step 66) is responsible for invoking deterministic fallback, preserving the fail-closed safety invariant (P10) without Step 61 routing directly to fallback.

---

### ADR-015: Durable Tenant-Scoped AIAnalysis Persistence and Failure-Isolated Pipeline Orchestration
**Decision:** Persist validated AI narrations in a dedicated, tenant-isolated `ai_analyses` table (Migration 0028) with explicit lifecycle states (`pending`, `completed`, `rejected`, `failed`) decoupled from validation status (`passed`, `rejected`). Orchestrate the end-to-end pipeline through an isolated orchestration service (`orchestrateImpactExplanation`) invoked downstream of deterministic impact analysis persistence. Enforce a strict failure boundary in the worker handler: provider exceptions, network timeouts, or validation rejections must never fail the deterministic impact analysis job, invalidate persisted impact findings, or trigger recursive job retries. Persist validated structured output only on success; store null in `output_text` and `output_structured` on validation rejection (retaining only sanitized error codes in metadata) and on provider errors. Expose AI narrations via an authenticated, tenant-isolated endpoint (`GET /api/v1/ai-analyses/:id`) and reference `ai_analysis_id` and `ai_analysis_status` on `GET /api/v1/impact-analyses/:id`. Render narrations via `AIExplanationPanel` in explorer change mode with evidence citations, model confidence badges, and graceful degradation states.
**Alternatives considered:** (a) Embedding AI explanation fields directly into the `impact_analyses` table; (b) Inline generation inside the deterministic traversal transaction; (c) Failing the impact analysis job when AI generation fails; (d) Persisting raw invalid model completions with warning flags.
**Why this one:** Embedding AI fields into `impact_analyses` couples the deterministic core to probabilistic narrations, complicates schema migrations for other AI tasks (e.g. simulation narration in Step 63), and pollutes blast-radius data with LLM lifecycle state. Inline generation during traversal stalls database connections and risks transaction timeouts on third-party LLM latency. Failing the impact job violates Core Principle P10 (fail-safe AI) and forces expensive deterministic recomputations merely because of transient model unavailability. Persisting raw ungrounded completions risks serving hallucinations. A dedicated `ai_analyses` table with unique `(organization_id, subject_type, subject_id)` constraints guarantees idempotency, clean lifecycle transitions, tenant RLS isolation, and seamless reuse across future AI workloads.
