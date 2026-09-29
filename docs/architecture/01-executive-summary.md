# 1. Executive Summary

## What Fluxora is

Fluxora is a **software digital twin**: a structured, continuously-updated model of a real software system, built from source code, repository history, dependencies, APIs, CI/CD metadata, and (in later phases) runtime telemetry. That model is queryable, explainable, and simulatable.

It is deliberately **not**:
- a chatbot wrapped around a GitHub API client
- an AI code-review tool that comments on style
- a static-analysis linter
- an APM/observability dashboard (it consumes observability data later, it does not replace it)

It **is**:
- a deterministic graph of "what depends on what, and how do I know"
- a change-impact calculator ("this PR touches X, which affects Y, Z")
- a scenario simulator ("if Redis dies, here's what degrades, in what order, with what confidence")
- an AI reasoning layer that explains the graph's findings in natural language, grounded in evidence it did not invent

## Why this is architecturally interesting (and a strong portfolio piece)

Fluxora forces genuinely hard, senior-level engineering decisions:

1. **Where is the LLM allowed to be wrong, and where is it not allowed to be wrong at all.** The dependency graph and blast-radius calculation must be correct without an LLM in the loop — this is a classic "don't let the stochastic layer own the deterministic core" problem, the same class of problem that shows up in real production AI systems at any serious company.
2. **Static analysis at scale.** Parsing real-world TypeScript/JavaScript monorepos (path aliases, barrel files, dynamic imports, decorators, JSX) is a genuinely hard, well-scoped systems problem — not a toy CRUD app.
3. **Graph modeling and storage trade-offs.** Deciding *not* to reach for Neo4j on day one, and defining the concrete trigger conditions under which you would, is a more sophisticated answer than "we use a graph database because graphs."
4. **Evidence-grounded AI.** Building a context-assembly pipeline that feeds an LLM verified, structured facts (not raw file dumps) and validates its structured output against a schema is exactly the kind of "AI reliability engineering" senior AI full-stack roles screen for.
5. **Event-driven, idempotent, multi-tenant backend.** Ingestion, analysis, impact computation, and simulation are all long-running, failure-prone, asynchronous jobs — this is a real distributed-systems surface, not a single API handler.

## Who it's for (product framing, even as a solo portfolio project)

| Persona | Core question they ask Fluxora |
|---|---|
| Senior engineer | "What's the blast radius if I change this function?" |
| Staff/principal engineer | "What does this architecture actually look like today, and where are the risk concentrations?" |
| Platform engineer | "What operational dependencies exist between these services?" |
| Engineering manager | "Where is our system fragile, and what changed recently?" |
| PR author | "What could break if I merge this?" |

## What v1 (MVP) proves

A single GitHub TypeScript/Next.js repository can be connected, statically analyzed, and turned into an evidence-backed dependency graph, visualized in an architecture explorer, with PR-level blast-radius analysis and an AI explanation layer — end to end, deterministic core, AI-assisted narration, all traceable to source evidence.

## What later phases add

Multi-language support, runtime telemetry ingestion, rule-based failure/capacity simulation, historical architecture time-travel, and production-grade multi-tenant scaling to thousands of repositories.
