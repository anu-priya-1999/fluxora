# 3. Architecture Principles

These are non-negotiable. Every later design decision in this package is judged against them, and any violation must be called out explicitly and justified.

## P1 — Deterministic core, probabilistic edge

The dependency graph, blast-radius traversal, and simulation propagation are computed by deterministic code (AST analysis, graph traversal, rule engines) that produces the **same output for the same input, every time**, and can be unit-tested like any other software. The LLM sits *after* this core, consuming its verified output. The LLM is never asked "what depends on what" — it is told the answer and asked to explain it.

## P2 — Every conclusion is evidence-backed

No user-facing claim ("Checkout is affected") exists without a traceable chain: source file → symbol → relationship type → analysis run → confidence. If evidence cannot be produced, the claim is not made — or it is explicitly labeled as an AI hypothesis, visually distinct from graph-derived fact.

## P3 — Confidence is a first-class citizen, not an afterthought

Static analysis of dynamic languages is inherently incomplete (dynamic imports, `eval`, runtime-constructed strings, reflection-like patterns). Every edge in the graph carries a confidence score and a provenance tag (`static-analysis`, `inferred`, `ai-hypothesis`, `runtime-observed`). The UI never presents inferred/hypothesized edges with the same visual weight as statically-proven ones.

## P4 — Idempotent, replayable pipelines

Ingestion, analysis, impact computation, and simulation are all re-runnable without side effects or duplication. A crashed worker mid-analysis must be safely retryable. This is enforced via idempotency keys on every job and append-only `AnalysisRun` versioning rather than in-place mutation of the graph.

## P5 — Incremental, not all-or-nothing

A repository that partially fails to parse (unsupported syntax, huge file, unknown framework) still produces a partial graph with clearly marked gaps, rather than failing the whole ingestion. Graceful degradation is a requirement, not a nice-to-have.

## P6 — Security-first for code handling

Repository content is the most sensitive asset in the system (private source code) and the most dangerous (it can contain adversarial content aimed at the AI layer — prompt injection via comments/strings/README content). Every file that reaches the LLM context is treated as untrusted input, sandboxed analysis workers never have outbound network access beyond what's required, and secrets are never persisted in plaintext.

## P7 — Explainability over cleverness

If a design choice makes the system faster but harder to explain *why* it produced a given answer, prefer the explainable choice for the core graph/impact/simulation path. Cleverness is allowed in the AI layer's language generation, never in the mechanism that decides what's true.

## P8 — Boring technology for the deterministic core, interesting technology for the interesting problem

PostgreSQL, not a graph database, until a concrete scaling trigger is hit (see `06-database-schema.md`). Well-understood queueing (e.g., a managed queue or Postgres-backed job table before reaching for Kafka). Save architectural novelty for the genuinely novel parts: code intelligence, evidence modeling, and AI-context assembly.

## P9 — Multi-tenant from day one, even as a single-user portfolio project

Every table, query, and cache key is tenant-scoped from the first migration. Retrofitting multi-tenancy is one of the most expensive mistakes in this category of product; it costs almost nothing to do it correctly from the start.

## P10 — The AI layer must fail safely

If the LLM call fails, times out, returns malformed structured output, or is unavailable, the deterministic graph/impact/simulation results are still delivered to the user — with the AI explanation section clearly marked unavailable, not blocked on.
