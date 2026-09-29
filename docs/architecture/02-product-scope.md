# 2. Product Scope

## In scope — MVP (Phases 0–9, see roadmap)

- GitHub OAuth connection to a single repository at a time (multi-repo per org allowed, but no cross-org federation yet)
- TypeScript/JavaScript/React/Next.js/Node.js static analysis
- Deterministic dependency graph: repo → application → package → module → symbol → API/event/DB → consumer
- Evidence layer: every edge traceable to file/symbol/line/commit
- Architecture Explorer UI (graph visualization, node inspection)
- PR-based change-impact analysis ("blast radius")
- A small, deterministic, rule-based simulation engine (infra failure + latency degradation scenarios only)
- AI reasoning layer for explanation/narration/Q&A, fed structured evidence, with schema-validated structured outputs
- Multi-tenant auth, encrypted credential storage, audit logging
- Core observability (structured logs, metrics, traces, job monitoring)

## Explicitly out of scope for MVP (future phases)

- Runtime telemetry ingestion (APM/OpenTelemetry consumption) — Phase 10
- Historical architecture time-travel (reconstructing graphs from past commits) — Phase 9+/future
- Non-TS/JS languages (Python, Java, Go, Rust) — future, architecture must not block it
- Large-scale capacity/traffic simulation (2x/10x traffic modeling with queueing theory) — future
- Cross-repository / cross-organization graph federation
- On-prem/self-hosted GitHub Enterprise (assume github.com first)
- Real-time collaborative editing of the graph/UI
- SOC 2 / compliance certification (design for it, don't certify in MVP)

## Non-goals (permanently out of scope, by design)

- Fluxora does not replace an APM (Datadog, New Relic) — it optionally *consumes* their data later
- Fluxora does not auto-fix code or auto-merge PRs
- Fluxora does not claim 100% completeness of analysis — every output carries confidence and evidence, and gaps are surfaced, not hidden
- The LLM is never the source of truth for graph structure, even in later phases

## MVP success criteria (product-level)

1. A user connects a real, moderately complex Next.js/TypeScript repo (not a toy example) in under 5 minutes.
2. Fluxora produces a dependency graph that a senior engineer looking at the actual repo agrees is "basically right" for at least 90% of first-order (direct import/call) relationships.
3. Given a real PR, Fluxora's blast-radius output matches what an experienced maintainer of that repo would say, for direct and one-hop-downstream impact.
4. Every claim in the impact report can be clicked through to the exact file/line evidence that produced it.
5. A rule-based scenario ("what if the payments API is unavailable") produces a propagation chain that is internally consistent with the graph, not hallucinated.

## Explicit scope boundary statement

> Fluxora's MVP promise is: **correct first- and second-order static analysis of a single TypeScript/JavaScript repository, with fully-evidenced blast-radius output and AI narration.** It does not promise runtime accuracy, multi-language support, or large-scale simulation in v1 — and says so in the product itself rather than silently under-delivering.
