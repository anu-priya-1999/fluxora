# Phase 9, Step 65: AI Evaluation Suite, Groundedness & Hallucination Baselines

## Objective

Build Fluxora's initial continuously-run AI evaluation suite (`apps/workers/src/ai/eval/`) against the pinned `shadcn-ui/taxonomy` golden fixtures (`298a8857c7128a0d121e7f699dfd729f23b3966d`), measuring:
1. Semantic evidence groundedness (distinct from structural association and manifest membership).
2. Factual consistency and hallucination rate.
3. Named-entity, file-path, API, and simulation-state accuracy.
4. Structured-output correctness and 2-attempt corrective retry ceiling.
5. Latency (`p50`, `p95`, `mean`) and cost/token usage per task type.
6. Resistance to repository prompt-injection attempts via an isolated adversarial fixture pair.

## Execution Modes

- **Deterministic CI Mode (`ci_mock`)**: Offline-capable, uses `MockModelProvider`, integrated into `pnpm test` and `pnpm eval:ai`.
- **Opt-In Live Mode (`live`)**: Requires `USE_REAL_LLM=true` and `ANTHROPIC_API_KEY`, enforces hard case/token/cost/time budgets, and never runs implicitly in CI.
