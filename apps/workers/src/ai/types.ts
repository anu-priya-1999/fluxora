/**
 * @file types.ts
 * Core types and contracts for the Fluxora AI Model Gateway.
 *
 * Defines the provider-independent request and response contracts,
 * task types, attempt records, and provider adapter interfaces.
 */

export type ModelTaskType =
  | "impact_explanation"
  | "simulation_narration"
  | "chat_query";

export type ModelMessageRole = "user" | "assistant";

export interface ModelMessage {
  readonly role: ModelMessageRole;
  readonly content: string;
}

/**
 * Normalized model gateway request.
 * Contains assembled messages and parameters; independent of prompt templating or evidence assembly.
 */
export interface ModelGatewayRequest {
  readonly taskType: ModelTaskType;
  readonly promptVersion: string;
  readonly systemInstruction?: string | undefined;
  readonly messages: readonly ModelMessage[];
  readonly maxTokens?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Parameters passed to a low-level provider adapter for a single invocation attempt.
 */
export interface ProviderGenerateParams {
  readonly model: string;
  readonly systemInstruction?: string | undefined;
  readonly messages: readonly ModelMessage[];
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Normalized raw result returned by a low-level provider adapter.
 */
export interface ProviderGenerateResult {
  readonly text: string;
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly providerRequestId: string | null;
  readonly stopReason: string | null;
}

/**
 * Provider-independent adapter contract implemented by Anthropic Claude and Mock adapters.
 */
export interface ModelProviderAdapter {
  readonly providerId: string;
  generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult>;
}

export type AttemptOutcome =
  | "success"
  | "retryable_error"
  | "fatal_error"
  | "timeout"
  | "aborted";

/**
 * Diagnostic and cost accounting record for each attempt made during a gateway request.
 */
export interface ModelGatewayAttemptRecord {
  readonly attemptNumber: number;
  readonly model: string;
  readonly isFallback: boolean;
  readonly latencyMs: number;
  readonly outcome: AttemptOutcome;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly errorCategory?: string | undefined;
  readonly providerRequestId?: string | null | undefined;
}

/**
 * Normalized response returned by the Model Gateway.
 */
export interface ModelGatewayResponse {
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  readonly taskType: ModelTaskType;
  readonly promptVersion: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly attemptCount: number;
  readonly usedFallback: boolean;
  readonly providerRequestId: string | null;
  readonly stopReason: string | null;
  readonly isMock: boolean;
  readonly attempts: readonly ModelGatewayAttemptRecord[];
}

/**
 * Single controlled boundary interface for all outbound LLM requests.
 */
export interface ModelGateway {
  generate(request: ModelGatewayRequest): Promise<ModelGatewayResponse>;
}
