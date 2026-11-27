# ADR-017: Provider-Neutral Tool-Calling Architecture Chat, Trust Boundaries, Execution Limits, and Durable Persistence

**Status:** Accepted
**Date:** 2026-11-26
**Deciders:** Core Engineering Team
**Consulted:** Architecture Review
**Informed:** Phase 9 (AI Reasoning)

---

## 1. Context & Problem Statement

In **Global Step 64** (Phase 9, Step 6), Fluxora introduces free-form natural-language architecture Q&A (`chat_query`). Unlike PR impact explanation (Step 62) and simulation narration (Step 63), which operate over a single pre-computed artifact, free-form questions require dynamic retrieval over the dependency graph, evidence records, and on-demand failure simulations.

This introduces four critical architectural tensions:
1. **Provider Coupling vs. Model Gateway Abstraction**: Tool-use message formats differ across LLM providers; exposing Anthropic SDK types to the chat orchestrator would violate Step 59's provider-independent gateway boundary.
2. **Unrestricted Repo Access vs. Deterministic Truth**: Giving an LLM generic file-reading, shell, or SQL tools would allow it to bypass Fluxora's deterministic graph/simulation engines and leak cross-tenant or untrusted repository data.
3. **Resource & Cost Blowup**: Unbounded tool loops or unconstrained simulation triggers could exhaust token budgets, worker leases, or database capacity.
4. **Citation Grounding & Persistence**: Every factual claim in a chat answer must be traceable to evidence IDs actually retrieved during that query, while preserving API/worker package isolation and `AIAnalysis` idempotency.

---

## 2. Decision

1. **Provider-Independent Tool Contracts in `ModelGateway`**:
   - Extended `apps/workers/src/ai/types.ts` with `ToolDefinition`, `ModelTextBlock`, `ModelToolUseBlock`, `ModelToolResultBlock`, and optional `tools` / `toolUses` on gateway requests and responses.
   - `AnthropicProviderAdapter` translates these neutral blocks to/from Anthropic's `tool_use` and `tool_result` content blocks.
   - `MockModelProvider` supports queued `toolUses` for deterministic offline and CI testing without network calls or API keys.

2. **Strictly Three Controlled Tools (`apps/workers/src/ai/chat/tools.ts`)**:
   - `query_graph(start_node, direction, max_depth, edge_types)`: **Read-only.** Resolves `start_node` within the authorized `analysisRunId`, enforces `0 <= max_depth <= HARD_MAX_TRAVERSAL_DEPTH` (20, default 3), invokes `traverseGraph`, and registers returned evidence IDs.
   - `get_evidence(evidence_id)`: **Read-only.** Fetches evidence via tenant-scoped `getEvidenceById` and rejects any record whose `analysisRunId` does not match the authorized run.
   - `run_simulation(target_node, failure_type)`: **Sole bounded, non-destructive state-creating operation.** Validates `target_node` and `failure_type` (`"unavailable" | "latency"`), creates new synthetic `Scenario` (tagged `source: "chat_query"`) and `Simulation` records through the deterministic simulation engine (`executeSimulation(..., { enqueueNarrationJob: false })`), enforces per-request (`MAX_SIMULATIONS_PER_REQUEST = 2`) and per-session (`MAX_SIMULATIONS_PER_SESSION = 5`) limits, and caches identical `(resolvedNode.id, failureType)` calls for idempotency within the request.
   - The model cannot modify source code, repositories, existing graph records, infrastructure, or existing simulations; bounded simulation creation is not unrestricted database mutation or autonomous remediation.
   - Unknown tools (`unknown_tool`), extra/unrecognized properties (`rejectKeysOutside`), and non-object inputs (`invalid_arguments`) are rejected before execution, and unexpected tool errors are isolated as `tool_execution_error` results. Tenant (`organizationId`), `repositoryId`, and `analysisRunId` are injected exclusively from trusted server context (`TrustedChatContext`), never model arguments. Serialized tool outputs are capped at `MAX_TOOL_RESULT_CHARS = 16_000`.

3. **Bounded Execution & Prompt-Injection Containment**:
   - Enforces `MAX_TOOL_ROUNDS = 5`, `MAX_TOTAL_TOOL_CALLS = 10`, `MAX_EXECUTION_TIME_MS = 45_000`, `MAX_HISTORY_MESSAGES = 10`, `MAX_HISTORY_MESSAGE_CHARS = 1_500`, and `MAX_QUESTION_CHARS = 2_000`.
   - Prior conversation history and user questions are unicode-escaped (`\u003c`, `\u003e`, `\u0026`) and wrapped in `<conversation_history>` and `<user_question>` XML delimiters marked as untrusted data.

4. **Manifest Grounding & Durable `AIAnalysis` Persistence**:
   - Every evidence ID returned by successful tool calls is accumulated into `allowedEvidenceIds`.
   - Final responses are validated against `chat-query-output-v1` (the strict 4-field schema `{ summary, claims, confidence, caveats }`) with at most one corrective retry and atomic whole-response rejection on ungrounded citations (ADR-014).
   - Validated manifest membership guarantees citation provenance, not automatic semantic entailment.
   - Results are persisted in `ai_analyses` with `subject_type = 'chat_query'` and `subject_id = chatQueryId`. Raw invalid output and secrets are never persisted.

5. **Decoupled API & Worker Job (`POST /api/v1/chat/query` → `chat.query`)**:
   - `POST /api/v1/chat/query` authenticates via Clerk, derives `organizationId` from the session, verifies repository and analysis-run ownership, creates a pending `AIAnalysis`, enqueues `chat.query` in PostgreSQL `jobs`, and returns `202 Accepted` with `ai_analysis_id` for polling via `GET /api/v1/ai-analyses/:id`.

---

## 3. Consequences

- **Positive:** Zero provider lock-in in the chat orchestrator; deterministic graph/simulation engines remain the sole source of architectural truth; strict tenant and analysis-run isolation; full auditability in `ai_analyses`.
- **Trade-offs:** Asynchronous `202 Accepted` + polling adds a brief polling interval in the UI compared to SSE streaming, but preserves API/worker package isolation and durable job execution established in ADR-016.
