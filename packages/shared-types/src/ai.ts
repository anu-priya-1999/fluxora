/**
 * @file ai.ts
 * AI Analysis and Explanation shared contracts (Phase 9 Step 62).
 */

export type AIAnalysisStatus = "pending" | "completed" | "rejected" | "failed";

export type AIAnalysisValidationStatus =
  | "pending"
  | "passed"
  | "rejected"
  | "fallback";

export type AIAnalysisSubjectType =
  | "impact_analysis"
  | "simulation"
  | "chat_query";

export type AIExplanationConfidence = "high" | "medium" | "low";

export interface AIExplanationClaimDto {
  readonly text: string;
  readonly evidence_ids: readonly string[];
}

export interface AIExplanationOutputDto {
  readonly summary: string;
  readonly claims: readonly AIExplanationClaimDto[];
  readonly confidence: AIExplanationConfidence;
  readonly caveats: readonly string[];
}

/**
 * Domain entity representing an AI explanation or analysis record.
 */
export interface AIAnalysis {
  readonly id: string;
  readonly organizationId: string;
  readonly subjectType: AIAnalysisSubjectType;
  readonly subjectId: string;
  readonly status: AIAnalysisStatus;
  readonly modelUsed: string | null;
  readonly promptVersion: string | null;
  readonly inputEvidenceIds: readonly string[];
  readonly outputText: string | null;
  readonly outputStructured: AIExplanationOutputDto | null;
  readonly validationStatus: AIAnalysisValidationStatus | null;
  readonly tokenCount: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly errorMessage?: string | null | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Safe client-facing DTO for an AI analysis record.
 */
export interface AIAnalysisResponse {
  readonly id: string;
  readonly subject_type: AIAnalysisSubjectType;
  readonly subject_id: string;
  readonly status: AIAnalysisStatus;
  readonly model_used: string | null;
  readonly prompt_version: string | null;
  readonly input_evidence_ids: readonly string[];
  readonly output_text: string | null;
  readonly output_structured: AIExplanationOutputDto | null;
  readonly validation_status: AIAnalysisValidationStatus | null;
  readonly token_count: number;
  readonly cost_usd: number;
  readonly latency_ms: number;
  readonly schema_version?: string | null | undefined;
  readonly error_message?: string | null | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Step 64: Tool-Calling Free-Form Architecture Chat contracts.
 */
export const CHAT_QUERY_PATH = "/api/v1/chat/query" as const;

export type ChatToolName = "query_graph" | "get_evidence" | "run_simulation";

export type ChatMessageRole = "user" | "assistant";

export interface ChatHistoryMessageDto {
  readonly role: ChatMessageRole;
  readonly content: string;
}

export interface ChatToolActivityDto {
  readonly tool_name: ChatToolName;
  readonly status: "completed" | "failed";
  readonly summary?: string | undefined;
}

export interface ChatQueryRequest {
  readonly repository_id: string;
  readonly analysis_run_id: string;
  readonly question: string;
  readonly history?: readonly ChatHistoryMessageDto[] | undefined;
  readonly session_id?: string | undefined;
}

export interface ChatQueryAcceptedResponse {
  readonly chat_query_id: string;
  readonly ai_analysis_id: string;
  readonly status: "pending" | "completed" | "rejected" | "failed";
  readonly job_id: string;
}
