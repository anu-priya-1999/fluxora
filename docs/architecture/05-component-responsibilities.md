# 5. Detailed Component Responsibilities

For each component: **responsibility, inputs, outputs, dependencies, failure modes.**

---

## 5.1 Repository Ingestion Service

- **Responsibility:** Authenticate to GitHub, discover repo metadata, fetch content at a given ref, store an immutable snapshot.
- **Inputs:** OAuth token, repo identifier, target ref (branch/commit SHA).
- **Outputs:** `RepositorySnapshot` record, raw content in S3, `repository.indexed` event.
- **Dependencies:** GitHub API, Secrets Manager, Object Storage, job queue.
- **Failure modes:** GitHub rate limiting → exponential backoff + queue delay, not job failure. Token revoked → mark repo `needs_reauth`, notify user, do not retry indefinitely. Repo too large (>configurable size cap) → partial/shallow clone with explicit "truncated analysis" flag rather than OOM crash.

## 5.2 Language/Framework Detector

- **Responsibility:** Classify the repo's stack (TS/JS/React/Next.js/Node.js vs unsupported) and select the appropriate parser pipeline.
- **Inputs:** File tree + package manifests (`package.json`, `tsconfig.json`, lockfiles).
- **Outputs:** `AnalysisRun` config specifying which parsers to run, which files to skip.
- **Dependencies:** none external; pure function over the snapshot.
- **Failure modes:** Ambiguous/mixed-stack repo → run all applicable parsers, tag confidence lower. Zero recognized files → mark `unsupported`, still create a skeletal Repository/Application record so the user isn't met with silence.

## 5.3 AST Parser (ts-morph / TypeScript Compiler API) — primary

- **Responsibility:** Full semantic parse of TS/JS/TSX files: symbols, imports/exports, type references, decorators, JSX component usage.
- **Inputs:** File contents, `tsconfig.json` (for path alias resolution).
- **Outputs:** Per-file symbol table, import/export edges.
- **Dependencies:** Node.js sandbox with TypeScript installed matching (or closest compatible to) the repo's version.
- **Failure modes:** Syntax the compiler can't parse (very old syntax, corrupted file) → skip file, log, lower overall confidence for that module, do not fail the run. TypeScript version mismatch causing subtly wrong types → non-fatal; type-level edges get a lower confidence than import-level edges, which are far more reliable.

## 5.4 AST Parser (tree-sitter) — fallback / non-TS-aware paths

- **Responsibility:** Lightweight, error-tolerant parsing for files the compiler-based pass can't fully type-check, and as the extension point for future languages (Python, Go, Rust, Java).
- **Inputs:** Raw source text.
- **Outputs:** Syntax tree → best-effort symbol/import extraction (less semantic depth than 5.3, but never throws on malformed input).
- **Dependencies:** tree-sitter grammars per language.
- **Failure modes:** Designed to be failure-tolerant by construction (tree-sitter produces a tree even for invalid syntax); genuine failure only on binary/non-text files, which are filtered upstream.

## 5.5 Symbol & Dependency Extractor

- **Responsibility:** Turn raw parser output into typed candidate graph edges: `IMPORTS`, `CALLS`, `EXTENDS`, `IMPLEMENTS`, `EXPOSES_ROUTE`, `EMITS_EVENT`, `CONSUMES_EVENT`, `QUERIES_DB`.
- **Inputs:** Per-file symbol tables + import graphs from 5.3/5.4.
- **Outputs:** Candidate edges with source location and confidence.
- **Dependencies:** Pattern libraries for framework-specific detection (Next.js API routes, Express routers, common event-bus/queue client patterns, common ORM call shapes for DB detection).
- **Failure modes:** Framework pattern not recognized (custom routing abstraction) → edge simply not created; this is a known, documented limitation surfaced in the UI as analysis coverage, not silently absent.

## 5.6 Normalizer

- **Responsibility:** Resolve path aliases, dedupe symbols referenced from multiple import paths, collapse barrel-file re-exports to their true origin, merge multi-file class/interface declarations.
- **Inputs:** Candidate edges from 5.5.
- **Outputs:** Canonicalized symbol identities and edges ready for graph construction.
- **Dependencies:** `tsconfig.json` path mapping, monorepo workspace config (if present).
- **Failure modes:** Unresolvable alias → keep edge with `unresolved_target` flag rather than dropping it silently.

## 5.7 Graph Builder

- **Responsibility:** Persist normalized edges as `GraphNode`/`GraphEdge` rows scoped to an `AnalysisRun`, diffing against the previous run to detect what changed.
- **Inputs:** Normalized edges, previous `AnalysisRun` (if any).
- **Outputs:** New graph snapshot, `graph.updated` event, diff summary.
- **Dependencies:** PostgreSQL.
- **Failure modes:** Partial write failure mid-transaction → whole `AnalysisRun` write is transactional; either the full new snapshot commits or none of it does (old graph stays authoritative until the new one is complete).

## 5.8 Evidence Writer / Evidence Store

- **Responsibility:** For every edge and every later-derived conclusion (impact result, simulation state change), persist the provenance chain: source file, symbol, line range, analysis run id, timestamp, confidence, producing component.
- **Inputs:** Called by 5.7, the Impact Engine, and the Simulation Engine.
- **Outputs:** `Evidence` rows, queryable by the entity they support.
- **Dependencies:** PostgreSQL (co-located with graph for join performance).
- **Failure modes:** Evidence write failure invalidates the associated claim — the system is designed so a graph edge or impact conclusion without evidence is treated as *not proven* and excluded from user-facing "confirmed" results.

## 5.9 Impact Analysis Engine

- **Responsibility:** Given a set of changed symbols (from a PR diff), perform bounded graph traversal to compute direct + downstream affected nodes, APIs, events, and services.
- **Inputs:** Changed file list + diff hunks, current graph snapshot.
- **Outputs:** `ImpactAnalysis` record: direct/downstream/events/workflow-impact lists, each with evidence links and a traversal-depth-based confidence decay.
- **Dependencies:** Graph store, Evidence store.
- **Failure modes:** Traversal depth unbounded on a highly connected graph → hard depth cap (configurable, default 5 hops) with explicit "truncated, N more nodes beyond this depth" reporting rather than runaway computation. Cyclic dependencies → traversal tracks visited-node set per run to guarantee termination.

## 5.10 Simulation Engine

- **Responsibility:** Deterministically propagate a scenario (infra failure, latency injection, node removal) across the graph using an explicit rule table (see `04-system-architecture-diagrams.md §4.7`).
- **Inputs:** Scenario definition (target node, failure type, parameters), graph snapshot, edge metadata (sync/async, has-fallback, has-circuit-breaker where knowable from code patterns).
- **Outputs:** `SimulationResult`: per-node end state, propagation path, assumptions used, confidence.
- **Dependencies:** Graph store, Evidence store, Rule Table (versioned, itself testable).
- **Failure modes:** Missing edge metadata needed for a rule (e.g., "does this call have a circuit breaker?" unknown) → rule falls back to a conservative default (assume no protection) and flags the assumption explicitly in the output rather than guessing optimistically.

## 5.11 Model Gateway

- **Responsibility:** Single controlled boundary for all LLM calls — provider abstraction, retries, fallback model selection, token/cost tracking, caller cancellation propagation, and secret sanitization (`apps/workers/src/ai/`).
- **Inputs:** `ModelGatewayRequest` (assembled messages, task type, prompt version, timeout override, abort signal).
- **Outputs:** `ModelGatewayResponse` (normalized text, actual model, reported token counts, calculated USD cost, latency, attempt records).
- **Dependencies:** Anthropic Claude Messages API (primary: `claude-sonnet-5-5`, secondary fallback: `claude-haiku-5-5`), `@fluxora/observability`, `@fluxora/infrastructure` (SecretsClient), deterministic `MockModelProvider` (local dev default).
- **Failure modes:** Primary model timeout/5xx/rate-limit → bounded exponential backoff retries, then fallback model; fatal auth/400 errors or caller abort → fail fast; total failure → typed `ModelGatewayError` without blocking deterministic graph results (Principle P10).

## 5.12 Context Assembler

- **Responsibility:** Build the exact, minimal, structured context sent to the model — graph facts and evidence records, never raw repository file content as unmediated context for factual claims. Implemented under `apps/workers/src/ai/context/` for the `impact_explanation` task type (Global Step 60).
- **Inputs:** Task type (explain impact / explain simulation / answer question), relevant `ImpactAnalysis`/`SimulationResult`/`Evidence` records.
- **Outputs:** A structured `ImpactExplanationContext` object + selected prompt template version (`ModelGatewayRequest`).
- **Dependencies:** Evidence store (`packages/db`), `@fluxora/shared-types`.
- **Failure modes:** Context too large for model window → prioritize by confidence/relevance and truncate with an explicit "N additional lower-confidence findings omitted" marker, never silent truncation. Analysis not in completed status → fail fast with `not_completed`. Inaccessible or missing record → fail safely with `not_found`.

## 5.13 Structured Output Validator

- **Responsibility:** Implemented under `apps/workers/src/ai/structured-output/` (Global Step 61). Parses raw model responses strictly as JSON; validates parsed payloads against versioned task-specific schemas (starting with `impact-explanation-output-v1`); verifies that every cited claim references non-empty evidence IDs from the trusted allowed manifest assembled by Step 60; enforces whole-response rejection (ADR-014) on ungrounded or duplicate citations; executes bounded corrective retries (max 2 total response attempts).
- **Inputs:** Raw model response text, trusted `allowedEvidenceIds` manifest from `ImpactExplanationContext`.
- **Outputs:** Discriminated `ValidationResult<T>` containing either validated, typed payload or bounded, deterministic validation issues.
- **Dependencies:** Task schema definitions, strict JSON parser, injected retry callback. Provider-independent; zero SDK or database dependencies.
- **Failure modes:** Malformed JSON, markdown fences, schema violations, or citations outside the allowed manifest → reject entire response, trigger exactly one corrective retry with deterministic issue guidance, then return explicit validation failure so orchestration can invoke Step 66 deterministic template fallback.

## 5.14 Fluxora API (BFF layer)

- **Responsibility:** Tenant-scoped REST/GraphQL surface for the frontend; enforces authz on every request; orchestrates job enqueue for long-running work; pushes live updates over WebSocket.
- **Inputs:** Authenticated client requests.
- **Outputs:** JSON responses, WS events.
- **Dependencies:** PostgreSQL, Redis, job queue, Auth provider.
- **Failure modes:** Standard API failure handling (4xx/5xx, rate limiting per tenant); designed to never block on long-running work — always enqueue-and-return-job-id for anything analysis/AI related.

## 5.15 Architecture Explorer (Frontend)

- **Responsibility:** Render the graph, node inspection panels, change-mode and simulation-mode overlays.
- **Inputs:** API data (graph, evidence, impact, simulation results).
- **Outputs:** Interactive UI.
- **Dependencies:** Fluxora API, graph visualization library.
- **Failure modes:** Very large graphs (10k+ nodes) → client-side virtualization/level-of-detail rendering, server-side pre-aggregation into "clusters" rather than shipping the full graph to the browser at once.

## 5.16 Job Queue / Worker Coordination

- **Responsibility:** Reliable at-least-once delivery of analysis/impact/simulation/AI jobs to a horizontally scalable worker fleet.
- **Inputs:** Enqueued jobs with idempotency keys.
- **Outputs:** Job execution, dead-letter routing on repeated failure.
- **Dependencies:** PostgreSQL (MVP: a `jobs` table with `SELECT ... FOR UPDATE SKIP LOCKED`) → managed queue (SQS) or Kafka at scale.
- **Failure modes:** Worker crash mid-job → job visibility timeout expires, job becomes claimable again; idempotency key ensures re-execution doesn't duplicate graph writes. Repeated failure (N attempts) → dead-letter, alert, do not retry forever.

## 5.17 AI Explanation Orchestrator Service

- **Responsibility:** Implemented under `apps/workers/src/ai/orchestrator.ts` (Global Step 62). Coordinates the end-to-end impact explanation pipeline downstream of deterministic impact analysis persistence. Loads tenant-scoped context via Step 60, builds provider-independent request, invokes Step 59 Model Gateway, executes Step 61 structured-output and evidence-grounding validation with at most one corrective retry, aggregates usage/cost/latency metrics across attempts, and persists durable results in `ai_analyses` (Migration 0028).
- **Inputs:** `organizationId`, `impactAnalysisId`.
- **Outputs:** Typed `AIExplanationOrchestrationResult` (`completed`, `already_completed`, `rejected`, or `failed`).
- **Dependencies:** Context Assembler (`§5.12`), Model Gateway (`§5.11`), Structured Output Validator (`§5.13`), `AIAnalysis` repository (`packages/db`), `@fluxora/observability`.
- **Failure modes:**
  - AI provider outage, rate limits, or network errors → caught by the worker failure boundary; recorded as `status: 'failed'`; deterministic impact findings remain fully valid and completed.
  - Validation rejection (ungrounded claims) → recorded as `status: 'rejected'` with raw ungrounded output withheld; deterministic impact findings remain unaffected.
  - Idempotency hit → reuses existing completed record without regenerating or calling the Model Gateway.
