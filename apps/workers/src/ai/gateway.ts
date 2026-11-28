/**
 * @file gateway.ts
 * Production Model Gateway orchestrator for the Fluxora AI layer.
 *
 * Enforces single-boundary dispatch, bounded retries with exponential backoff,
 * secondary model fallback routing, cancellation propagation, aggregate cost accounting,
 * and OpenTelemetry metrics, traces, and structured logs.
 */

import {
  emitAiGatewayLog,
  markSpanError,
  markSpanSuccess,
  recordAiAttemptLatency,
  recordAiCost,
  recordAiGatewayAttempt,
  recordAiGatewayRequest,
  recordAiRequestLatency,
  recordAiTokenUsage,
  tracer,
} from "@fluxora/observability";

import { ModelGatewayError } from "./errors.ts";
import { ModelRoutingPolicy } from "./policy.ts";
import { DefaultModelPricingRegistry, type ModelPricingRegistry } from "./pricing.ts";
import type {
  AttemptOutcome,
  ModelGateway,
  ModelGatewayAttemptRecord,
  ModelGatewayRequest,
  ModelGatewayResponse,
  ModelProviderAdapter,
  ProviderGenerateResult,
} from "./types.ts";

export type SleepFunction = (ms: number, signal?: AbortSignal | undefined) => Promise<void>;

export async function defaultSleep(ms: number, signal?: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw ModelGatewayError.aborted();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      reject(ModelGatewayError.aborted());
    }

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export interface ProductionModelGatewayOptions {
  readonly provider: ModelProviderAdapter;
  readonly policy?: ModelRoutingPolicy | undefined;
  readonly pricingRegistry?: ModelPricingRegistry | undefined;
  readonly sleepFn?: SleepFunction | undefined;
  readonly baseRetryDelayMs?: number | undefined;
  readonly maxRetryDelayMs?: number | undefined;
  readonly maxRetryAfterMs?: number | undefined;
}

export class ProductionModelGateway implements ModelGateway {
  readonly provider: ModelProviderAdapter;
  readonly policy: ModelRoutingPolicy;
  readonly pricingRegistry: ModelPricingRegistry;
  private readonly sleep: SleepFunction;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly maxRetryAfterMs: number;

  constructor(options: ProductionModelGatewayOptions) {
    this.provider = options.provider;
    this.policy = options.policy ?? new ModelRoutingPolicy();
    this.pricingRegistry =
      options.pricingRegistry ?? new DefaultModelPricingRegistry();
    this.sleep = options.sleepFn ?? defaultSleep;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 500;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 5_000;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 10_000;
  }

  async generate(request: ModelGatewayRequest): Promise<ModelGatewayResponse> {
    const requestStartMs = Date.now();
    const taskPolicy = this.policy.getPolicy(request.taskType);
    const timeoutMs = this.policy.resolveTimeoutMs(
      request.taskType,
      request.timeoutMs,
    );
    const maxTokens = this.policy.resolveMaxTokens(
      request.taskType,
      request.maxTokens,
    );

    if (request.signal?.aborted) {
      throw ModelGatewayError.aborted(
        "Request aborted before model gateway dispatch",
        {
          provider: this.provider.providerId,
          taskType: request.taskType,
        },
      );
    }

    const attempts: ModelGatewayAttemptRecord[] = [];
    let attemptIndex = 0;
    let primaryError: ModelGatewayError | undefined;
    let lastError: ModelGatewayError | undefined;
    let successResult: ProviderGenerateResult | undefined;
    let usedFallback = false;
    let activeModel = taskPolicy.primaryModel;

    const isMock = this.provider.providerId === "mock";
    const maxPrimaryAttempts = 1 + taskPolicy.maxPrimaryRetries;

    const gatewaySpan = tracer.startSpan("fluxora.ai.gateway.request", {
      attributes: {
        "ai.task_type": request.taskType,
        "ai.prompt_version": request.promptVersion,
        "ai.primary_model": taskPolicy.primaryModel,
        "ai.fallback_model": taskPolicy.fallbackModel,
        "ai.provider": this.provider.providerId,
        "ai.is_mock": isMock,
      },
    });

    try {
      // 1. Primary Model Execution Loop
      for (let pAttempt = 1; pAttempt <= maxPrimaryAttempts; pAttempt++) {
        if (request.signal?.aborted) {
          throw ModelGatewayError.aborted();
        }

        attemptIndex++;
        activeModel = taskPolicy.primaryModel;
        const attemptStartMs = Date.now();

        const attemptSpan = tracer.startSpan("fluxora.ai.provider.attempt", {
          attributes: {
            "ai.attempt_number": attemptIndex,
            "ai.model": activeModel,
            "ai.is_fallback": false,
            "ai.task_type": request.taskType,
            "ai.provider": this.provider.providerId,
          },
        });

        try {
          const result = await this.provider.generate({
            model: activeModel,
            systemInstruction: request.systemInstruction,
            messages: request.messages,
            ...(request.tools ? { tools: request.tools } : {}),
            maxTokens,
            timeoutMs,
            signal: request.signal,
          });

          const latencyMs = Date.now() - attemptStartMs;
          const costUsd = isMock
            ? null
            : this.pricingRegistry.calculateCost(
                activeModel,
                result.inputTokens,
                result.outputTokens,
              );

          const attemptRecord: ModelGatewayAttemptRecord = {
            attemptNumber: attemptIndex,
            model: activeModel,
            isFallback: false,
            latencyMs,
            outcome: "success",
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            costUsd,
            providerRequestId: result.providerRequestId,
          };
          attempts.push(attemptRecord);

          markSpanSuccess(attemptSpan);
          attemptSpan.end();

          this.recordAttemptTelemetry(attemptRecord, request.taskType, isMock);

          successResult = result;
          break;
        } catch (err: unknown) {
          const latencyMs = Date.now() - attemptStartMs;
          const gatewayErr = this.normalizeError(
            err,
            activeModel,
            request.taskType,
            request.signal,
          );
          markSpanError(attemptSpan, gatewayErr);
          attemptSpan.end();

          const outcome = this.classifyAttemptOutcome(gatewayErr);
          const attemptRecord: ModelGatewayAttemptRecord = {
            attemptNumber: attemptIndex,
            model: activeModel,
            isFallback: false,
            latencyMs,
            outcome,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            errorCategory: gatewayErr.code,
          };
          attempts.push(attemptRecord);

          this.recordAttemptTelemetry(attemptRecord, request.taskType, isMock);

          primaryError = gatewayErr;
          lastError = gatewayErr;

          // Non-retryable errors stop immediately (auth, invalid request, caller abort)
          if (!gatewayErr.retryable || request.signal?.aborted) {
            break;
          }

          // If retryable and attempts remain, sleep with exponential backoff
          if (pAttempt < maxPrimaryAttempts) {
            const backoffMs = this.computeBackoffMs(pAttempt, gatewayErr.retryAfterMs);
            await this.sleep(backoffMs, request.signal);
          }
        }
      }

      // 2. Fallback Model Execution (if primary exhausted eligible attempts)
      const canAttemptFallback =
        !successResult &&
        !request.signal?.aborted &&
        primaryError?.retryable &&
        taskPolicy.fallbackModel &&
        taskPolicy.fallbackModel !== taskPolicy.primaryModel;

      if (canAttemptFallback) {
        attemptIndex++;
        usedFallback = true;
        activeModel = taskPolicy.fallbackModel;
        const attemptStartMs = Date.now();

        const fallbackSpan = tracer.startSpan("fluxora.ai.provider.attempt", {
          attributes: {
            "ai.attempt_number": attemptIndex,
            "ai.model": activeModel,
            "ai.is_fallback": true,
            "ai.task_type": request.taskType,
            "ai.provider": this.provider.providerId,
          },
        });

        try {
          const result = await this.provider.generate({
            model: activeModel,
            systemInstruction: request.systemInstruction,
            messages: request.messages,
            ...(request.tools ? { tools: request.tools } : {}),
            maxTokens,
            timeoutMs,
            signal: request.signal,
          });

          const latencyMs = Date.now() - attemptStartMs;
          const costUsd = isMock
            ? null
            : this.pricingRegistry.calculateCost(
                activeModel,
                result.inputTokens,
                result.outputTokens,
              );

          const attemptRecord: ModelGatewayAttemptRecord = {
            attemptNumber: attemptIndex,
            model: activeModel,
            isFallback: true,
            latencyMs,
            outcome: "success",
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            costUsd,
            providerRequestId: result.providerRequestId,
          };
          attempts.push(attemptRecord);

          markSpanSuccess(fallbackSpan);
          fallbackSpan.end();

          this.recordAttemptTelemetry(attemptRecord, request.taskType, isMock);

          successResult = result;
        } catch (err: unknown) {
          const latencyMs = Date.now() - attemptStartMs;
          const fallbackErr = this.normalizeError(
            err,
            activeModel,
            request.taskType,
            request.signal,
          );
          markSpanError(fallbackSpan, fallbackErr);
          fallbackSpan.end();

          const outcome = this.classifyAttemptOutcome(fallbackErr);
          const attemptRecord: ModelGatewayAttemptRecord = {
            attemptNumber: attemptIndex,
            model: activeModel,
            isFallback: true,
            latencyMs,
            outcome,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            errorCategory: fallbackErr.code,
          };
          attempts.push(attemptRecord);

          this.recordAttemptTelemetry(attemptRecord, request.taskType, isMock);

          lastError = ModelGatewayError.retriesExhausted(
            `Primary model (${taskPolicy.primaryModel}) and fallback model (${taskPolicy.fallbackModel}) both failed.`,
            {
              provider: this.provider.providerId,
              model: activeModel,
              taskType: request.taskType,
              attemptCount: attempts.length,
              primaryError,
              cause: fallbackErr,
              attempts,
            },
          );
        }
      }

      // 3. Final Result or Failure Finalization
      if (!successResult) {
        const totalLatencyMs = Date.now() - requestStartMs;
        const finalError = lastError
          ? new ModelGatewayError(lastError.message, {
              code: lastError.code,
              retryable: lastError.retryable,
              provider: lastError.provider ?? this.provider.providerId,
              model: lastError.model ?? activeModel,
              taskType: lastError.taskType ?? request.taskType,
              attemptCount: attempts.length,
              retryAfterMs: lastError.retryAfterMs,
              statusCode: lastError.statusCode,
              primaryError: lastError.primaryError,
              attempts,
              totalLatencyMs,
              cause: lastError.cause ?? lastError,
            })
          : ModelGatewayError.retriesExhausted("All provider attempts failed.", {
              provider: this.provider.providerId,
              model: activeModel,
              taskType: request.taskType,
              attemptCount: attempts.length,
              primaryError,
              attempts,
              totalLatencyMs,
            });

        this.recordRequestFailureTelemetry(
          finalError,
          activeModel,
          request,
          totalLatencyMs,
          attempts.length,
          usedFallback,
          isMock,
        );

        markSpanError(gatewaySpan, finalError);
        throw finalError;
      }

      const totalLatencyMs = Date.now() - requestStartMs;
      const aggregateCostUsd = isMock
        ? null
        : this.pricingRegistry.calculateAggregateCost(attempts);

      const response: ModelGatewayResponse = {
        text: successResult.text,
        ...(successResult.toolUses && successResult.toolUses.length > 0
          ? { toolUses: successResult.toolUses }
          : {}),
        provider: this.provider.providerId,
        model: successResult.model,
        taskType: request.taskType,
        promptVersion: request.promptVersion,
        inputTokens: successResult.inputTokens,
        outputTokens: successResult.outputTokens,
        totalTokens: successResult.totalTokens,
        costUsd: aggregateCostUsd,
        latencyMs: totalLatencyMs,
        attemptCount: attempts.length,
        usedFallback,
        providerRequestId: successResult.providerRequestId,
        stopReason: successResult.stopReason,
        isMock,
        attempts,
      };

      this.recordRequestSuccessTelemetry(
        response,
        totalLatencyMs,
        isMock,
      );

      markSpanSuccess(gatewaySpan);
      return response;
    } finally {
      gatewaySpan.end();
    }
  }

  private computeBackoffMs(attempt: number, retryAfterMs?: number | undefined): number {
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      return Math.min(retryAfterMs, this.maxRetryAfterMs);
    }
    const exponential = this.baseRetryDelayMs * 2 ** (attempt - 1);
    return Math.min(exponential, this.maxRetryDelayMs);
  }

  private normalizeError(
    error: unknown,
    model: string,
    taskType: ModelGatewayRequest["taskType"],
    signal?: AbortSignal | undefined,
  ): ModelGatewayError {
    if (error instanceof ModelGatewayError) {
      return error;
    }

    const baseDetails = {
      provider: this.provider.providerId,
      model,
      taskType,
      cause: error,
    };

    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      return ModelGatewayError.aborted(
        error instanceof Error ? error.message : "Request aborted",
        baseDetails,
      );
    }

    if (error instanceof Error && error.name === "TimeoutError") {
      return ModelGatewayError.timeoutError(error.message, baseDetails);
    }

    // Never convert programming/runtime bugs into retryable provider errors
    if (
      error instanceof TypeError ||
      error instanceof ReferenceError ||
      error instanceof RangeError ||
      error instanceof SyntaxError ||
      error instanceof EvalError ||
      error instanceof URIError
    ) {
      return ModelGatewayError.internalError(
        `Internal ${error.name}: ${error.message}`,
        baseDetails,
      );
    }

    const extractCode = (obj: unknown): string | undefined => {
      if (typeof obj === "object" && obj !== null && "code" in obj) {
        const val = (obj as { code?: unknown }).code;
        return typeof val === "string" ? val : undefined;
      }
      return undefined;
    };

    const transportCode =
      extractCode(error) ??
      (error instanceof Error ? extractCode(error.cause) : undefined);

    if (transportCode === "ETIMEDOUT" || transportCode === "UND_ERR_CONNECT_TIMEOUT") {
      return ModelGatewayError.timeoutError(
        error instanceof Error ? error.message : `Transport timeout (${transportCode})`,
        baseDetails,
      );
    }

    if (
      transportCode !== undefined &&
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "ENOTFOUND",
        "EAI_AGAIN",
        "EPIPE",
        "UND_ERR_SOCKET",
        "EHOSTUNREACH",
        "ENETUNREACH",
      ].includes(transportCode)
    ) {
      return ModelGatewayError.providerUnavailable(
        error instanceof Error ? error.message : `Transport error (${transportCode})`,
        baseDetails,
      );
    }

    const status =
      typeof error === "object" && error !== null
        ? ((error as { statusCode?: unknown; status?: unknown }).statusCode ??
          (error as { status?: unknown }).status)
        : undefined;

    if (typeof status === "number" && Number.isInteger(status)) {
      const msg = error instanceof Error ? error.message : `Provider HTTP ${status}`;
      if (status === 401 || status === 403) {
        return ModelGatewayError.authenticationError(msg, {
          ...baseDetails,
          statusCode: status,
        });
      }
      if (status === 429) {
        return ModelGatewayError.rateLimitError(msg, {
          ...baseDetails,
          statusCode: status,
        });
      }
      if (status >= 500 && status < 600) {
        return ModelGatewayError.providerUnavailable(msg, {
          ...baseDetails,
          statusCode: status,
        });
      }
      if (status >= 400 && status < 500) {
        return ModelGatewayError.invalidResponse(msg, {
          ...baseDetails,
          statusCode: status,
        });
      }
    }

    return ModelGatewayError.internalError(
      error instanceof Error ? error.message : String(error),
      baseDetails,
    );
  }

  private classifyAttemptOutcome(error: ModelGatewayError): AttemptOutcome {
    if (error.code === "ABORTED") {
      return "aborted";
    }
    if (error.code === "TIMEOUT_ERROR") {
      return "timeout";
    }
    if (error.retryable) {
      return "retryable_error";
    }
    return "fatal_error";
  }

  private recordAttemptTelemetry(
    attempt: ModelGatewayAttemptRecord,
    taskType: string,
    isMock: boolean,
  ): void {
    recordAiGatewayAttempt({
      "ai.provider": this.provider.providerId,
      "ai.model": attempt.model,
      "ai.task_type": taskType,
      "ai.attempt_number": attempt.attemptNumber,
      "ai.attempt_outcome": attempt.outcome,
      "ai.is_fallback": String(attempt.isFallback),
      "ai.is_mock": String(isMock),
      ...(attempt.errorCategory ? { "ai.error_category": attempt.errorCategory } : {}),
    });

    recordAiAttemptLatency(attempt.latencyMs, {
      "ai.provider": this.provider.providerId,
      "ai.model": attempt.model,
      "ai.is_fallback": String(attempt.isFallback),
    });
  }

  private recordRequestSuccessTelemetry(
    response: ModelGatewayResponse,
    latencyMs: number,
    isMock: boolean,
  ): void {
    recordAiGatewayRequest({
      "ai.provider": response.provider,
      "ai.model": response.model,
      "ai.task_type": response.taskType,
      "ai.prompt_version": response.promptVersion,
      "ai.outcome": "success",
      "ai.used_fallback": String(response.usedFallback),
      "ai.is_mock": String(isMock),
    });

    recordAiRequestLatency(latencyMs, {
      "ai.provider": response.provider,
      "ai.model": response.model,
      "ai.task_type": response.taskType,
    });

    if (response.inputTokens !== null && response.outputTokens !== null) {
      recordAiTokenUsage(response.inputTokens, response.outputTokens, {
        "ai.provider": response.provider,
        "ai.model": response.model,
      });
    }

    if (response.costUsd !== null) {
      recordAiCost(response.costUsd, {
        "ai.provider": response.provider,
        "ai.model": response.model,
      });
    }

    emitAiGatewayLog("AI model request completed successfully.", "info", {
      "ai.provider": response.provider,
      "ai.model": response.model,
      "ai.task_type": response.taskType,
      "ai.prompt_version": response.promptVersion,
      "ai.used_fallback": String(response.usedFallback),
      "ai.latency_ms": latencyMs,
      "ai.attempt_count": response.attemptCount,
      "ai.is_mock": String(isMock),
    });
  }

  private recordRequestFailureTelemetry(
    error: ModelGatewayError,
    model: string,
    request: ModelGatewayRequest,
    latencyMs: number,
    attemptCount: number,
    usedFallback: boolean,
    isMock: boolean,
  ): void {
    const outcome = error.code === "ABORTED" ? "aborted" : "error";

    recordAiGatewayRequest({
      "ai.provider": this.provider.providerId,
      "ai.model": model,
      "ai.task_type": request.taskType,
      "ai.prompt_version": request.promptVersion,
      "ai.outcome": outcome,
      "ai.error_category": error.code,
      "ai.used_fallback": String(usedFallback),
      "ai.is_mock": String(isMock),
    });

    recordAiRequestLatency(latencyMs, {
      "ai.provider": this.provider.providerId,
      "ai.model": model,
      "ai.task_type": request.taskType,
    });

    emitAiGatewayLog(`AI model request failed with ${error.code}.`, "error", {
      "ai.provider": this.provider.providerId,
      "ai.model": model,
      "ai.task_type": request.taskType,
      "ai.prompt_version": request.promptVersion,
      "ai.error_category": error.code,
      "ai.latency_ms": latencyMs,
      "ai.attempt_count": attemptCount,
      "ai.is_mock": String(isMock),
    });
  }
}
