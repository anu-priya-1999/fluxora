# Phase 9, Step 64 — Tool-Calling Free-Form Architecture Chat

## Objective

Implement Phase 9, Step 6: an evidence-grounded, tool-calling architecture chat interface where users can ask natural-language questions about a connected repository and Fluxora's model retrieves facts exclusively through three controlled deterministic tools (`query_graph`, `get_evidence`, `run_simulation`).

## Key Requirements

1. **Controlled Tools**: Expose only `query_graph(start_node, direction, max_depth, edge_types)`, `get_evidence(evidence_id)`, and `run_simulation(target_node, failure_type)` with strict schema validation and server-derived tenant/repository/analysis-run context.
2. **Provider-Independent Tool Calling**: Extend `ModelGateway`, `AnthropicProviderAdapter`, and `MockModelProvider` / `MockModelGateway` to support tool definitions, `tool_use`, `tool_result`, bounded multi-round loops, and usage/cost/latency aggregation.
3. **Chat Orchestrator & Persistence**: Implement `orchestrateChatQuery` with bounded history, `chat-query-v1` prompt, tool-loop limits, evidence manifest accumulation, `chat-query-output-v1` validation, and durable `AIAnalysis` persistence (`subject_type = 'chat_query'`).
4. **API & Frontend**: Add `POST /api/v1/chat/query` with Clerk authentication + tenant isolation + `chat.query` job enqueueing, and `ArchitectureChatPanel` in the Architecture Explorer.
5. **Security & Verification**: Prevent prompt injection, cross-tenant/cross-run access, and fabricated citations. Verify with `pnpm lint`, `pnpm lint:evidence`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check`.
