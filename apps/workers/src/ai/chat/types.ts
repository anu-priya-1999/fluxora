/**
 * @file types.ts
 * Types and deterministic limits for Tool-Calling Free-Form Architecture Chat (Phase 9 Step 64).
 */

import type { ChatToolActivityDto, ChatToolName } from "@fluxora/shared-types";

export const CHAT_QUERY_PROMPT_VERSION = "chat-query-v1" as const;
export const CHAT_QUERY_OUTPUT_SCHEMA_VERSION = "chat-query-output-v1" as const;

export const CHAT_EXECUTION_LIMITS = Object.freeze({
  /** Maximum number of model-to-tool round trips per chat query. */
  MAX_TOOL_ROUNDS: 5,
  /** Maximum total tool invocations across all rounds in a single chat query. */
  MAX_TOTAL_TOOL_CALLS: 10,
  /** Maximum number of synthetic simulations triggered per chat query. */
  MAX_SIMULATIONS_PER_REQUEST: 2,
  /** Maximum number of synthetic simulations per chat session (server-side limit). */
  MAX_SIMULATIONS_PER_SESSION: 5,
  /** Overall execution time budget for a single chat query (ms). */
  MAX_EXECUTION_TIME_MS: 45_000,
  /** Maximum number of prior conversation turns retained in bounded prompt context. */
  MAX_HISTORY_MESSAGES: 10,
  /** Maximum character length per prior history message. */
  MAX_HISTORY_MESSAGE_CHARS: 1_500,
  /** Maximum character length of the incoming user question. */
  MAX_QUESTION_CHARS: 2_000,
  /** Maximum serialized character length for a single tool result returned to the model. */
  MAX_TOOL_RESULT_CHARS: 16_000,
});

export interface TrustedChatContext {
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly analysisRunId: string;
  readonly chatQueryId: string;
  readonly sessionId?: string | undefined;
}

export interface ToolExecutionContext {
  readonly trusted: TrustedChatContext;
  readonly allowedEvidenceIds: Set<string>;
  readonly toolActivity: ChatToolActivityDto[];
  readonly simulationCountInRequest: { count: number };
  readonly simulationCountInSession: { count: number };
  readonly simulationCache: Map<string, Record<string, unknown>>;
}

export interface ExecutedToolResult {
  readonly toolName: ChatToolName | string;
  readonly content: string;
  readonly isError: boolean;
  readonly addedEvidenceIds: readonly string[];
}
