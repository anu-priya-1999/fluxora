/**
 * @file errors.ts
 * Typed error hierarchy for the Fluxora AI Model Gateway.
 *
 * Guarantees secret safety, sanitized error messages, and explicit classification
 * of retryability and root causes across primary and fallback executions.
 */

import type { ModelGatewayAttemptRecord, ModelTaskType } from "./types.ts";

export type ModelGatewayErrorCode =
  | "CONFIGURATION_ERROR"
  | "AUTHENTICATION_ERROR"
  | "TIMEOUT_ERROR"
  | "RATE_LIMIT_ERROR"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "ABORTED"
  | "RETRIES_EXHAUSTED";

export interface ModelGatewayErrorDetails {
  readonly code: ModelGatewayErrorCode;
  readonly retryable: boolean;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly taskType?: ModelTaskType | undefined;
  readonly attemptCount?: number | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly statusCode?: number | undefined;
  readonly primaryError?: ModelGatewayError | undefined;
  readonly attempts?: readonly ModelGatewayAttemptRecord[] | undefined;
  readonly cause?: unknown;
}

/**
 * Strips potential API keys, authorization tokens, and credentials from error messages.
 */
export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/sk-ant-[a-zA-Z0-9_-]+/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[a-zA-Z0-9_.-]+/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/(x-api-key|apiKey|authorization)["':=\s]+[^\s,;"']+/gi, "$1=[REDACTED]");
}

/**
 * Standard typed error emitted by the Model Gateway and Provider Adapters.
 */
export class ModelGatewayError extends Error {
  readonly code: ModelGatewayErrorCode;
  readonly retryable: boolean;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly taskType?: ModelTaskType | undefined;
  readonly attemptCount?: number | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly statusCode?: number | undefined;
  readonly primaryError?: ModelGatewayError | undefined;
  readonly attempts?: readonly ModelGatewayAttemptRecord[] | undefined;

  constructor(message: string, details: ModelGatewayErrorDetails) {
    const sanitized = sanitizeErrorMessage(message);
    super(sanitized);
    this.name = "ModelGatewayError";
    this.code = details.code;
    this.retryable = details.retryable;
    this.provider = details.provider;
    this.model = details.model;
    this.taskType = details.taskType;
    this.attemptCount = details.attemptCount;
    this.retryAfterMs = details.retryAfterMs;
    this.statusCode = details.statusCode;
    this.primaryError = details.primaryError;
    this.attempts = details.attempts;

    if (details.cause !== undefined) {
      this.cause = details.cause;
    }
  }

  static configurationError(
    message: string,
    details?: Partial<ModelGatewayErrorDetails> | undefined,
  ): ModelGatewayError {
    return new ModelGatewayError(message, {
      code: "CONFIGURATION_ERROR",
      retryable: false,
      ...details,
    });
  }

  static authenticationError(
    message: string,
    details?: Partial<ModelGatewayErrorDetails> | undefined,
  ): ModelGatewayError {
    return new ModelGatewayError(message, {
      code: "AUTHENTICATION_ERROR",
      retryable: false,
      ...details,
    });
  }

  static timeoutError(
    message: string,
    details?: Partial<ModelGatewayErrorDetails> | undefined,
  ): ModelGatewayError {
    return new ModelGatewayError(message, {
      code: "TIMEOUT_ERROR",
      retryable: true,
      ...details,
    });
  }

  static rateLimitError(
    message: string,
    details?: Partial<ModelGatewayErrorDetails> | undefined,
  ): ModelGatewayError {
    return new ModelGatewayError(message, {
      code: "RATE_LIMIT_ERROR",
      retryable: true,
      ...details,
    });
  }

  static providerUnavailable(
    message: string,
    details?: Partial<ModelGatewayErrorDetails> | undefined,
  ): ModelGatewayError {
    return new ModelGatewayError(message, {
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
      ...details,
    });
  }

  static invalidResponse(
    message: string,
    details?: Partial<ModelGatewayErrorDetails> | undefined,
  ): ModelGatewayError {
    return new ModelGatewayError(message, {
      code: "INVALID_RESPONSE",
      retryable: false,
      ...details,
    });
  }

  static aborted(
    message = "Model gateway operation was aborted by the caller",
    details?: Partial<ModelGatewayErrorDetails> | undefined,
  ): ModelGatewayError {
    return new ModelGatewayError(message, {
      code: "ABORTED",
      retryable: false,
      ...details,
    });
  }

  static retriesExhausted(
    message: string,
    details: Partial<ModelGatewayErrorDetails> & { primaryError?: ModelGatewayError | undefined },
  ): ModelGatewayError {
    return new ModelGatewayError(message, {
      code: "RETRIES_EXHAUSTED",
      retryable: false,
      ...details,
    });
  }
}

export function isModelGatewayError(err: unknown): err is ModelGatewayError {
  return err instanceof ModelGatewayError;
}
