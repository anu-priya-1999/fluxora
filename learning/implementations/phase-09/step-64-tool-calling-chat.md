# Step 64: Tool-Calling Free-Form Architecture Chat — Implementation Report

## 1. Objective

Implement Phase 9, Step 6: an evidence-grounded, tool-calling architecture chat interface allowing users to ask natural-language questions about a connected repository while ensuring all architectural facts are retrieved exclusively through Fluxora's three controlled deterministic tools.

## 2. Implemented Architecture

1. **Shared Contracts (`packages/shared-types`)**:
   - Added `CHAT_QUERY_PATH = "/api/v1/chat/query"`, `ChatToolName`, `ChatHistoryMessageDto`, `ChatToolActivityDto`, `ChatQueryRequest`, and `ChatQueryAcceptedResponse` in `packages/shared-types/src/ai.ts`.
   - Added `CHAT_QUERY_JOB_TYPE = "chat.query"`, `chatQueryIdempotencyKey`, and `parseChatQueryJobPayload` in `packages/shared-types/src/jobs.ts`.
2. **Provider-Independent Tool Calling (`apps/workers/src/ai/`)**:
   - Extended `types.ts`, `gateway.ts`, `anthropic-adapter.ts`, and `mock-gateway.ts` with `ToolDefinition`, `ModelToolUseBlock`, `ModelToolResultBlock`, and multi-turn content block support while preserving 100% backward compatibility for Steps 62 and 63.
3. **Controlled Tools & Orchestrator (`apps/workers/src/ai/chat/`)**:
   - `tools.ts`: Implements `query_graph` and `get_evidence` (**read-only**), plus `run_simulation` (the **sole bounded, non-destructive state-creating operation**, creating synthetic `Scenario` and `Simulation` records through the deterministic simulation engine via `executeSimulation(..., { enqueueNarrationJob: false })`). The model cannot modify source code, repositories, existing graph records, infrastructure, or existing simulations, and bounded simulation creation is not unrestricted database mutation or autonomous remediation. Enforces strict schema validation, unknown-tool/extra-key rejection, server-derived tenant/repository/analysis-run isolation (`TrustedChatContext`), `HARD_MAX_TRAVERSAL_DEPTH` (20, default 3), `MAX_SIMULATIONS_PER_REQUEST = 2`, `MAX_SIMULATIONS_PER_SESSION = 5`, `MAX_TOOL_RESULT_CHARS = 16_000`, in-request `(resolvedNode.id, failureType)` simulation idempotency, and isolated `tool_execution_error` failure handling.
   - `request-builder.ts`: Builds `chat-query-v1` requests with bounded history and unicode-escaped XML untrusted-data delimiters.
   - `validator.ts`: Enforces `chat-query-output-v1` strict 4-field schema and accumulated evidence-manifest grounding with max 1 corrective retry.
   - `orchestrator.ts`: Runs the bounded tool-calling loop (`MAX_TOOL_ROUNDS = 5`, `MAX_TOTAL_TOOL_CALLS = 10`, `MAX_EXECUTION_TIME_MS = 45_000`), aggregates token/cost/latency metrics, and persists `AIAnalysis` (`subject_type = 'chat_query'`).
   - `job-handler.ts`: Registers `chat.query` in `createDefaultJobHandlers()`.
4. **API & Frontend**:
   - `apps/api/src/http/chat-query.ts` & `server.ts`: Authenticated `POST /api/v1/chat/query` returning `202 Accepted` with `Idempotency-Key` support.
   - `apps/web/src/components/ai/ArchitectureChatPanel.tsx`: Interactive chat panel with history, tool activity badges, `EvidenceCitationList` citations, pending/completed/rejected/failed/retry states, integrated into `explorer-client.tsx`.
