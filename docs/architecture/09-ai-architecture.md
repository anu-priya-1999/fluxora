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

- Single internal client (`ModelGateway`) wraps all outbound calls to Claude (primary: `claude-sonnet-5-5`, fallback: `claude-haiku-5-5`). All prompt construction, retries, and fallback logic live behind this interface so provider swaps or multi-provider routing never touch calling code. Implemented under `apps/workers/src/ai/`.
- **Offline local development & testing:** defaults to a deterministic `MockModelProvider` (`USE_REAL_LLM=false`), requiring zero external network calls or secrets. Setting `USE_REAL_LLM=true` enables the real Anthropic Claude adapter and enforces fail-closed API key validation.
- **Fallback model:** a configured secondary model (`claude-haiku-5-5`, a cost-efficient Claude tier) used when the primary errors out repeatedly or when a lower-stakes task (e.g., quick chat follow-ups) doesn't need the highest-capability model — model selection is task-aware, not one-size-fits-all, to manage cost (see `16-cost-model.md`).
- **Timeouts:** per-task-type timeout budgets (e.g., 20s for a single impact explanation, 45s for a free-form chat query that may need larger context) with the deterministic result already delivered to the user before the AI call even starts, so a timeout never blocks the core product experience.
- **Token/cost tracking:** every call tracks `model, prompt_version, input_tokens, output_tokens, cost_usd, latency_ms`, emitting OpenTelemetry metrics/traces and preparing audit data for `AIAnalysis` persistence in later orchestration steps, rolled up into per-organization and global cost dashboards (`16-cost-model.md`).

## 9.3 Prompt / version management

- Prompts are versioned templates (`prompt_version: "impact-explain-v3"`), stored as code (not database rows edited live), so a prompt change is a reviewable diff and every `AIAnalysis` record can be traced back to the exact template that produced it.
- Each task type (impact explanation, simulation narration, free-form chat, remediation suggestion) has its own template and its own JSON output schema — no single mega-prompt trying to do everything.
- Prompt changes go through the same AI evaluation suite (`12-testing-strategy.md`) before being promoted, with A/B capability (serve v2 vs v3 to a sample, compare groundedness/quality scores) reserved for post-MVP once there's real usage volume to A/B against.

## 9.4 Context assembly — the core reliability mechanism

The Context Assembler is the component standing between "untrusted repository content" and "the model." Its job:

1. **Never pass raw file content as the basis for a factual claim.** The model receives *already-extracted, already-verified* structured facts (graph nodes/edges, `ImpactAnalysis`/`SimulationResult` records, `Evidence` rows) — not "here's the diff, tell me what breaks." That determination was already made deterministically; the model's job is to narrate it.
2. **Scope context tightly to the task.** An impact-explanation call gets exactly the `ImpactAnalysis` + its cited `Evidence` rows — not the whole graph, not unrelated PRs, not the full repository tree.
3. **Attach an explicit evidence-id manifest** to the prompt: "You may only reference the following evidence IDs: [ev_1001, ev_1123, ev_1130]. Do not state anything as fact that is not backed by one of these IDs." This is the mechanism that makes grounding checkable at output validation time (9.6).
4. **Truncate transparently, never silently**, when context would exceed budget — prioritizing by confidence and hop-distance, with an explicit "N lower-confidence findings omitted" note included in what's sent, so the model's narration can itself say "there may be additional lower-confidence effects not covered here."

### 9.4.1 Impact Explanation Context Assembler Implementation (Global Step 60)

Implemented under `apps/workers/src/ai/context/`:
- **Contracts (`types.ts`):** `ImpactExplanationContext`, `BoundedFinding`, `BoundedEvidenceRecord`, `TruncationDetails`, and `ContextLimits`.
- **Pure Assembler (`assembler.ts`):** Deterministic transformation of `ImpactAnalysis` and `EvidenceRecord[]` into a bounded context. Enforces confidence-first, hop-distance-second, stable `nodeId` sorting. Verifies structural evidence association (`subjectType === "impact_finding"`, `analysisRunId`, `impactAnalysisId`, and exact `subjectId === nodeId`; `metadata.nodeId` is never used as a substitute for a mismatched subject ID). Synchronizes the allowed evidence manifest (`allowedEvidenceIds`) strictly with retained evidence records.
- **Tenant-Scoped Loader (`loader.ts`):** Fetches completed analyses and associated evidence via existing PostgreSQL RLS methods (`getImpactAnalysisById`, `listImpactFindingEvidence`) under tenant boundaries.
- **Request Builder (`request-builder.ts`):** Formats provider-independent `ModelGatewayRequest` with stable prompt version `impact-explain-v1`, strict system instruction enforcing deterministic authority and untrusted data warnings, and explicit `<impact_context>` JSON containment with safe unicode escaping of markup-significant characters (`\u003c`, `\u003e`, `\u0026`) preventing XML tag breakout or fake instruction injection.

### 9.4.2 Three Levels of Grounding Guarantees

To ensure architectural clarity, Fluxora separates evidence guarantees into three distinct levels:

1. **Structural evidence association (Step 60 — Context Assembly):**
   - The Context Assembler verifies at context-creation time that an evidence record is structurally associated with the relevant persisted impact finding through validated subject identity, analysis-run identity, and impact-analysis association (`subjectType === "impact_finding"`, matching `analysisRunId`, matching `metadata.impactAnalysisId`, exact `subjectId === finding.node.id`; `metadata.nodeId` is never a substitute for a mismatched `subjectId`).
   - Only retained, structurally verified evidence records contribute IDs to the `allowedEvidenceIds` manifest.
   - *Guarantee:* Establishes that the evidence record is structurally associated with the relevant persisted impact finding through validated subject identity, analysis-run identity, and impact-analysis association, and that no fabricated or cross-run evidence IDs enter the context.
   - *Non-Guarantee:* This verifies the record's structural association. It does not independently establish the truth, completeness, or semantic accuracy of the underlying evidence description.
2. **Evidence manifest membership (Step 61 — Output Validator):**
   - The structured-output Validator checks at completion-validation time that evidence IDs cited by model-generated claims belong to the exact allowed evidence-ID manifest supplied with the request.
   - Claims citing evidence IDs outside the allowed manifest are rejected as violating the evidence-grounding policy (either stripped from the response or triggering retry/fallback).
   - *Guarantee:* Establishes citation provenance and allowlist compliance. It prevents the model from citing fabricated IDs or IDs outside the allowed manifest. It does *not* prove that the model interpreted the evidence correctly.
3. **Semantic evidence support (Acknowledged Limitation):**
   - Manifest membership alone cannot establish that cited evidence substantively supports or entails a natural-language claim.
   - For example, the model might cite a valid evidence ID associated with an unrelated finding, or misrepresent the relationship described by a valid evidence record.
   - Manifest membership establishes citation provenance and allowlist compliance, not semantic correctness. The validator does not automatically prove that cited evidence entails or substantively supports the natural-language claim.
   - Semantic support requires additional verification (such as explicit claim-to-finding association checks, downstream semantic evaluation in the evaluation suite §12.5, or human review).
   - Unless such verification is implemented, semantic correctness remains an acknowledged limitation, not a guaranteed property.

### Where raw code snippets *are* allowed in context

For free-form Q&A where a user asks something genuinely open-ended ("explain what this function does"), a small, explicitly-scoped code excerpt (the specific function body, with line numbers, already identified deterministically by the graph as the relevant symbol) can be included — but it is always labeled as "source excerpt, for explanatory context" and any claim about *relationships/dependencies* still must cite a graph-derived evidence id, never be inferred fresh from the snippet by the model.

### 9.4.3 Simulation Narration Context Assembler Implementation (Global Step 63)

Implemented under `apps/workers/src/ai/simulation-context/`:
- **Contracts (`types.ts`):** `SimulationNarrationContext`, `BoundedSimulationResultItem`, `BoundedEvidenceRecord`, `SimulationTruncationDetails`, and `SimulationContextLimits` (`DEFAULT_SIMULATION_CONTEXT_LIMITS`).
- **Pure Assembler (`assembler.ts`):** Deterministic transformation of `SimulationRecord` and `EvidenceRecord[]` into a bounded context. Enforces canonical 4-key sorting: `confidence DESC → severity DESC` (`failed` > `degraded` > `at_risk` > `healthy`, with unknown states defaulting to `0`) `→ hopDistance ASC → nodeId ASC` (`capped` is tracked as a separate boolean flag, not a severity state), determining which results survive the context budget. Verifies structural evidence association (`subjectType === "simulation_state"`, `analysisRunId`, `simulationId` in metadata, and exact `subjectId === nodeId`). Synchronizes the allowed evidence manifest (`allowedEvidenceIds`) strictly with retained evidence records.
- **Tenant-Scoped Loader (`loader.ts`):** Fetches completed simulation results and associated state evidence via existing PostgreSQL RLS methods (`getSimulationById`, `listSimulationEvidence`) under tenant boundaries.
- **Request Builder (`request-builder.ts`):** Formats provider-independent `ModelGatewayRequest` with stable prompt version `simulation-narrate-v1`, task type `simulation_narration`, strict system instruction enforcing deterministic authority, clear differentiation between synthetic scenarios and real production observations, untrusted scenario label containment, and explicit `<simulation_context>` JSON containment with safe unicode escaping of markup-significant characters (`\u003c`, `\u003e`, `\u0026`).

## 9.5 Tool calling

For free-form chat queries where the user's question doesn't map to a pre-computed `ImpactAnalysis`/`SimulationResult`, the model is given a small, explicit tool set rather than open-ended repository access:

- `query_graph(start_node, direction, max_depth, edge_types)` → calls the deterministic Graph Query engine (§7.2) and returns structured results
- `get_evidence(evidence_id)` → fetches a specific evidence record
- `run_simulation(target_node, failure_type)` → triggers the deterministic Simulation Engine (bounded, rate-limited per session to prevent abuse/cost blowup)

The model never gets a generic "read any file" or "run arbitrary query" tool — every tool call still routes through the deterministic core and its evidence/confidence machinery.

## 9.6 Structured outputs & validation

- Every AI call requests strict JSON matching a versioned, task-specific output schema.
- **Canonical Impact-Explanation Output Contract (`impact-explanation-output-v1`):**
  - Schema contains exactly four fields: `{ "summary": string, "claims": [{ "text": string, "evidence_ids": string[] }], "confidence": "high"|"medium"|"low", "caveats": string[] }`.
  - Enforces explicit limits: `summary` $\le 2,000$ chars, `claims` $\le 50$ items, `claim.text` $\le 1,200$ chars, `evidence_ids` $\le 20$ IDs per claim, individual evidence ID string $\le 128$ chars, `caveats` $\le 20$ items ($\le 500$ chars each).
  - Unknown properties at any object level, empty strings, nulls, and type coercions are rejected.
- **Simulation Narration Output Contract (`simulation-narration-output-v1` — Global Step 63):**
  - Schema contains four fields: `{ "summary": string, "claims": [{ "text": string, "evidence_ids": string[] }], "confidence": "high"|"medium"|"low", "caveats": string[] }`.
  - Validates under `SIMULATION_NARRATION_OUTPUT_SCHEMA_VERSION = "simulation-narration-output-v1"`.
  - Enforces explicit bounds identical to impact explanation with strict rejection of unknown properties, empty strings, and type coercion.
  - Enforces strict manifest grounding: citations must strictly belong to the simulation's `allowedEvidenceIds` manifest with atomic whole-response rejection (ADR-014/ADR-016).
  - Bounded corrective retry: maximum two attempts (1 initial + at most 1 corrective retry with deterministic issue guidance).
- **Strict JSON parsing:** Parses the complete response text as strict JSON. Markdown code fences (````json ... ````), leading or trailing prose, arrays, primitives, and empty responses are rejected without permissive auto-repair or extraction.
- **Grounding validation & Whole-Response Rejection (ADR-014):** Every `evidence_ids` entry in every claim is checked against the trusted `allowedEvidenceIds` manifest assembled in context (§9.4.1, §9.4.2). Every claim in the `claims` array must cite at least one evidence ID (`EMPTY_EVIDENCE_IDS`). Duplicate citations within the same claim fail validation with `DUPLICATE_EVIDENCE_ID`. Citations citing evidence IDs absent from the trusted manifest fail validation with `UNKNOWN_EVIDENCE_ID`. Fluxora enforces atomic whole-response rejection: any ungrounded citation invalidates the entire response; claims are never silently stripped or partially accepted. Validation failure results return up to 20 deterministic validation issues (`MAX_VALIDATION_ISSUES = 20`) in the discriminated failure result; downstream orchestration may consume them for error handling and diagnostics.
- **Bounded Corrective Retry:** Maximum two total attempts allowed (initial response plus one corrective retry). On initial failure, a bounded, deterministic corrective system instruction is provided quoting at most 10 validation error codes and property paths (`MAX_CORRECTIVE_FEEDBACK_ISSUES = 10`) without echoing raw untrusted output, preventing prompt bloat while keeping instructions focused.
- **Citation Provenance vs. Semantic Support:** Manifest membership establishes citation provenance and allowlist compliance, not semantic correctness. The validator verifies that cited IDs belong to the allowed manifest, but does not prove that cited evidence entails or substantively supports the natural-language claim. Semantic correctness requires downstream evaluation (§12.5) or human review.
- **Fallback (Future Downstream Orchestration — Global Step 66):** If validation fails after the permitted retry, Step 61 returns an explicit discriminated failure result `{ success: false, errors: [...], attempts: 2 }`. Invoking deterministic, template-based explanation fallback ("Direct impact: Payment Service. Downstream: Checkout (1 hop), Orders (2 hops)...") generated without the LLM is a future downstream-orchestration responsibility once Global Step 66 (ADR-010) is implemented; Step 61 does not invoke or route to fallback itself.

## 9.7 Hallucination mitigation — summary of layered defenses

1. Structural: the model is never the source of graph/impact/simulation facts (P1).
2. Contextual (Steps 60 & 63): only verified, scoped evidence is provided (`subjectType === "impact_finding"` for impact analyses; `subjectType === "simulation_state"` for simulations), with an explicit allowed-citation manifest synchronized strictly with retained evidence (§9.4.1, §9.4.2, §9.4.3).
3. Output-level (Steps 61 & 63): schema validation + grounding validation enforce strict whole-response rejection (ADR-014, ADR-016) whenever any claim cites an evidence ID outside the allowed manifest (§9.6); claims are never silently stripped or partially accepted. Note that manifest membership enforces citation provenance and allowlist compliance, not semantic correctness.
4. Presentational: the UI visually distinguishes AI narration from graph-derived fact, and confidence/caveats surfaced by the model are always rendered, never hidden.
5. Evaluation (Step 65): a continuously-run AI eval suite tracks groundedness, semantic support, and hallucination rate over time as a first-class metric (`12-testing-strategy.md §AI evaluation`), not a one-time check.

## 9.8 Provenance

Every `AIAnalysis` record stores: `model_used, prompt_version, input_evidence_ids, validation_status`. This makes every piece of AI-generated text in the product fully reproducible and auditable — "why did it say that" always has a concrete answer: this model, this prompt version, these exact evidence records.

## 9.9 End-to-End Impact Explanation Pipeline (Global Step 62)

The production integration connects the completed deterministic impact analysis to the frontend through an isolated, observable pipeline:

1. **Triggering Sequence**:
   - The worker processor computes and persists deterministic `ImpactAnalysis` and finding evidence records.
   - Downstream of successful persistence, `orchestrateImpactExplanation` is invoked within an isolated try/catch block.
   - AI generation failure, network timeouts, or validation rejection NEVER fail the deterministic impact analysis job or trigger recursive queue retries.
2. **Orchestration Execution (`orchestrateImpactExplanation`)**:
   - **Idempotency Guard**: Checks for an existing completed `AIAnalysis` record with `(organization_id, subject_type, subject_id)`. If present, returns immediately without making LLM calls.
   - **Context Assembly (Step 60)**: Loads tenant-scoped impact analysis and evidence, generating `ImpactExplanationContext` and the canonical `allowedEvidenceIds` manifest.
   - **Model Gateway Dispatch (Step 59)**: Formats `ModelGatewayRequest` (`taskType: "impact_explanation"`, prompt version `impact-explain-v1`), dispatching to primary Claude tier (`claude-sonnet-5-5`).
   - **Grounding Validation & Retry (Step 61)**: Validates response against `impact-explanation-output-v1`. If ungrounded or invalid, executes at most one corrective retry with deterministic issue guidance.
   - **Metrics Aggregation**: Aggregates token counts (input + output), microdollar USD cost, and latency across both initial and retry attempts.
   - **Durable Persistence (Step 62)**: Persists record in `ai_analyses` table (Migration 0028). On success, stores summary in `output_text` and the 4-field object in `output_structured`. On rejection or error, stores `null` in output columns, preserving only sanitized error diagnostics.
3. **API & UI Delivery**:
   - `GET /api/v1/impact-analyses/:id` provides `ai_analysis_id` and `ai_analysis_status`.
   - `GET /api/v1/ai-analyses/:id` returns authenticated, tenant-isolated explanation data.
   - `AIExplanationPanel` in explorer change mode renders summary, claims with interactive `EvidenceCitationList` chips, model confidence badge, caveats, and safe degradation states.

## 9.10 End-to-End Simulation Narration Pipeline (Global Step 63)

The production integration connects completed deterministic failure simulations to the frontend:

1. **Triggering Sequence**:
   - The simulation engine computes and persists deterministic `SimulationRecord` and state evidence (`subject_type = 'simulation_state'`).
   - Downstream of successful persistence, `orchestrateSimulationNarration` is invoked within an isolated try/catch block.
   - AI generation failure, network timeouts, or validation rejection NEVER fail the deterministic simulation or invalidate simulation results.
2. **Orchestration Execution (`orchestrateSimulationNarration`)**:
   - **Idempotency Guard**: Checks for an existing completed `AIAnalysis` record with `subject_type = 'simulation'` and `subject_id = simulationId`. If present, returns immediately without making LLM calls.
   - **Context Assembly (Step 63)**: Loads tenant-scoped simulation result and state evidence, generating `SimulationNarrationContext` and the canonical `allowedEvidenceIds` manifest.
   - **Model Gateway Dispatch (Step 59)**: Formats `ModelGatewayRequest` (`taskType: "simulation_narration"`, prompt version `simulation-narrate-v1`), dispatching to primary Claude tier (`claude-sonnet-5-5`).
   - **Grounding Validation & Retry (Step 63)**: Validates response against `simulation-narration-output-v1`. If ungrounded or invalid, executes at most one corrective retry with deterministic issue guidance.
   - **Metrics Aggregation**: Aggregates token counts (input + output), microdollar USD cost, and latency across both initial and retry attempts.
   - **Durable Persistence (Step 63)**: Persists record in `ai_analyses` table with `subject_type = 'simulation'`. On success, stores summary in `output_text` and structured JSON in `output_structured`. On rejection or error, stores `null` in output columns, preserving sanitized error diagnostics in `metadata`.
3. **API & UI Delivery**:
   - `GET /api/v1/simulations/:id` provides `ai_analysis_id` and `ai_analysis_status`.
   - `GET /api/v1/ai-analyses/:id` returns authenticated, tenant-isolated narration data.
   - `AISimulationNarrationPanel` in `SimulationStudio` renders summary, claims with interactive `EvidenceCitationList` chips, model confidence badge, synthetic scenario disclaimer, caveats, and safe degradation states with bounded discovery polling.
