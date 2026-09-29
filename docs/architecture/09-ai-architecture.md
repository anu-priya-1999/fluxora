# 9. AI Architecture

This is the highest-scrutiny component of Fluxora, both because it's the most interesting engineering surface and because it's where trust in the whole product can be lost if done carelessly (Principle P1/P2/P10).

## 9.1 What the LLM is, and is not, responsible for

| Responsibility | Owner |
|---|---|
| Discovering that `PaymentProvider.ts` calls `CheckoutService.ts` | Deterministic AST analysis — **never** the LLM |
| Computing that a PR touches 3 downstream services at hop-distance ≤3 | Deterministic graph traversal — **never** the LLM |
| Deciding what "degraded" means when Redis fails, per the rule table | Deterministic rule engine — **never** the LLM |
| Authorization / who can see what | Application-layer RBAC + Postgres RLS — **never** the LLM |
| Explaining *why* Checkout is affected, in plain English, referencing the evidence | LLM |
| Suggesting what to validate before deploying a risky change | LLM (explicitly labeled as a suggestion, not a fact) |
| Answering free-form "what if" architecture questions | LLM, grounded via Context Assembler — never given raw file access to fabricate an answer from |
| Summarizing a scenario's cascading failure narrative | LLM, narrating a deterministic `SimulationResult` it did not generate the logic for |

## 9.2 Model gateway

- Single internal client (`ModelGateway`) wraps all outbound calls to Claude (primary). All prompt construction, retries, and fallback logic live behind this interface so provider swaps or multi-provider routing never touch calling code.
- **Fallback model:** a configured secondary model (e.g., a smaller/cheaper Claude tier) used when the primary errors out repeatedly or when a lower-stakes task (e.g., quick chat follow-ups) doesn't need the highest-capability model — model selection is task-aware, not one-size-fits-all, to manage cost (see `16-cost-model.md`).
- **Timeouts:** per-task-type timeout budgets (e.g., 20s for a single impact explanation, 45s for a free-form chat query that may need larger context) with the deterministic result already delivered to the user before the AI call even starts, so a timeout never blocks the core product experience.
- **Token/cost tracking:** every call logs `model, prompt_version, input_tokens, output_tokens, cost_usd, latency_ms` to `AIAnalysis`, rolled up into per-organization and global cost dashboards (`16-cost-model.md`).

## 9.3 Prompt / version management

- Prompts are versioned templates (`prompt_version: "impact-explain-v3"`), stored as code (not database rows edited live), so a prompt change is a reviewable diff and every `AIAnalysis` record can be traced back to the exact template that produced it.
- Each task type (impact explanation, simulation narration, free-form chat, remediation suggestion) has its own template and its own JSON output schema — no single mega-prompt trying to do everything.
- Prompt changes go through the same AI evaluation suite (`12-testing-strategy.md`) before being promoted, with A/B capability (serve v2 vs v3 to a sample, compare groundedness/quality scores) reserved for post-MVP once there's real usage volume to A/B against.

## 9.4 Context assembly — the core reliability mechanism

The Context Assembler is the component standing between "untrusted repository content" and "the model." Its job:

1. **Never pass raw file content as the basis for a factual claim.** The model receives *already-extracted, already-verified* structured facts (graph nodes/edges, `ImpactAnalysis`/`SimulationResult` records, `Evidence` rows) — not "here's the diff, tell me what breaks." That determination was already made deterministically; the model's job is to narrate it.
2. **Scope context tightly to the task.** An impact-explanation call gets exactly the `ImpactAnalysis` + its cited `Evidence` rows — not the whole graph, not unrelated PRs, not the full repository tree.
3. **Attach an explicit evidence-id manifest** to the prompt: "You may only reference the following evidence IDs: [ev_1001, ev_1123, ev_1130]. Do not state anything as fact that is not backed by one of these IDs." This is the mechanism that makes grounding checkable (9.6).
4. **Truncate transparently, never silently**, when context would exceed budget — prioritizing by confidence and hop-distance, with an explicit "N lower-confidence findings omitted" note included in what's sent, so the model's narration can itself say "there may be additional lower-confidence effects not covered here."

### Where raw code snippets *are* allowed in context

For free-form Q&A where a user asks something genuinely open-ended ("explain what this function does"), a small, explicitly-scoped code excerpt (the specific function body, with line numbers, already identified deterministically by the graph as the relevant symbol) can be included — but it is always labeled as "source excerpt, for explanatory context" and any claim about *relationships/dependencies* still must cite a graph-derived evidence id, never be inferred fresh from the snippet by the model.

## 9.5 Tool calling

For free-form chat queries where the user's question doesn't map to a pre-computed `ImpactAnalysis`/`SimulationResult`, the model is given a small, explicit tool set rather than open-ended repository access:

- `query_graph(start_node, direction, max_depth, edge_types)` → calls the deterministic Graph Query engine (§7.2) and returns structured results
- `get_evidence(evidence_id)` → fetches a specific evidence record
- `run_simulation(target_node, failure_type)` → triggers the deterministic Simulation Engine (bounded, rate-limited per session to prevent abuse/cost blowup)

The model never gets a generic "read any file" or "run arbitrary query" tool — every tool call still routes through the deterministic core and its evidence/confidence machinery.

## 9.6 Structured outputs & validation

- Every AI call requests strict JSON matching a task-specific schema (e.g., `{ "summary": string, "claims": [{ "text": string, "evidence_ids": string[] }], "confidence": "high"|"medium"|"low", "caveats": string[] }`).
- **Schema validation:** malformed JSON → automatic retry (max 2) with a corrective system message quoting the validation error.
- **Grounding validation:** every `evidence_ids` entry in every claim is checked against the manifest that was actually sent in context (§9.4.3). Any claim citing an id outside that set is either stripped from the response (if other claims are still valid) or the whole response is rejected and retried, depending on severity.
- **Fallback:** if validation fails after retries, Fluxora falls back to a deterministic, template-based explanation ("Direct impact: Payment Service. Downstream: Checkout (1 hop), Orders (2 hops)...") generated without the LLM at all, so the user is never left with nothing (Principle P10).

## 9.7 Hallucination mitigation — summary of layered defenses

1. Structural: the model is never the source of graph/impact/simulation facts (P1).
2. Contextual: only verified, scoped evidence is provided, with an explicit allowed-citation manifest (§9.4.3).
3. Output-level: schema validation + grounding validation reject or strip unsupported claims (§9.6).
4. Presentational: the UI visually distinguishes AI narration from graph-derived fact, and confidence/caveats surfaced by the model are always rendered, never hidden.
5. Evaluation: a continuously-run AI eval suite tracks groundedness and hallucination rate over time as a first-class metric (`12-testing-strategy.md §AI evaluation`), not a one-time check.

## 9.8 Provenance

Every `AIAnalysis` record stores: `model_used, prompt_version, input_evidence_ids, validation_status`. This makes every piece of AI-generated text in the product fully reproducible and auditable — "why did it say that" always has a concrete answer: this model, this prompt version, these exact evidence records.
