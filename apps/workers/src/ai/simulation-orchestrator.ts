/**
 * @file simulation-orchestrator.ts
 * AI Simulation Narration Orchestrator Service (Phase 9 Step 63).
 *
 * Coordinates the complete end-to-end AI simulation-narration pipeline:
 * Deterministic simulation execution -> Context Assembly (Step 63) -> Model Gateway (Step 59)
 * -> Structured Output & Grounding Validation (Step 63) -> Durable AIAnalysis persistence.
 *
 * Core invariants:
 * - Deterministic failure simulation engine remains the sole authority.
 * - AI failure or validation rejection NEVER invalidates or fails deterministic simulation results.
 * - Strict whole-response rejection on ungrounded or fabricated citations (ADR-014).
 * - No raw invalid model output or provider secrets persisted on failure or rejection.
 * - Exact same trusted allowedEvidenceIds manifest used on initial and corrective attempts.
 * - Accurate aggregation of token counts, cost, and latency across attempts.
 * - Idempotency: repeated execution for same simulation does not duplicate records or model calls.
 */

import {
  getAIAnalysisBySubject,
  getPool,
  saveAIAnalysis,
} from "@fluxora/db";
import {
  getTracer,
  markSpanError,
  markSpanSuccess,
  recordAiFallbackExecution,
} from "@fluxora/observability";
import type {
  AIAnalysis,
  AIExplanationOutputDto,
} from "@fluxora/shared-types";

import { createModelGateway } from "./factory.ts";
import {
  classifyGatewayErrorForFallback,
  combineInitialAndRetryFailureAccounting,
  extractGatewayFailureAccounting,
  generateSimulationNarrationFallback,
  type FallbackTriggerReason,
  type GatewayFailureAccounting,
} from "./fallback/index.ts";
import {
  buildSimulationNarrationRequest,
  loadSimulationNarrationContext,
  SIMULATION_NARRATION_PROMPT_VERSION,
} from "./simulation-context/index.ts";
import {
  validateSimulationNarrationWithRetry,
  type ValidationIssue,
} from "./structured-output/index.ts";
import type { ModelGateway, ModelGatewayResponse } from "./types.ts";

const tracer = getTracer("@fluxora/workers");

export interface OrchestrateSimulationNarrationOptions {
  readonly organizationId: string;
  readonly simulationId: string;
  /** Force regeneration even if an existing completed, rejected, or failed record exists. */
  readonly forceRetry?: boolean | undefined;
  /**
   * Maximum cumulative background worker-level failed attempts across job redeliveries
   * before short-circuiting on an existing failed record (defaults to 2).
   */
  readonly maxRetries?: number | undefined;
  /**
   * Enable deterministic fallback narration when AI generation is unavailable or
   * fails structured-output validation after permitted retries (Step 66, defaults to true).
   */
  readonly enableFallback?: boolean | undefined;
}

export type SimulationNarrationOrchestrationResult =
  | {
      readonly status: "completed";
      readonly aiAnalysis: AIAnalysis;
    }
  | {
      readonly status: "already_completed";
      readonly aiAnalysis: AIAnalysis;
    }
  | {
      readonly status: "rejected";
      readonly aiAnalysis?: AIAnalysis | undefined;
      readonly errors: readonly ValidationIssue[];
    }
  | {
      readonly status: "failed";
      readonly aiAnalysis?: AIAnalysis | undefined;
      readonly error: string;
    };

export interface SimulationNarrationOrchestratorDependencies {
  pool?: Parameters<typeof saveAIAnalysis>[0] | undefined;
  gateway?: ModelGateway | undefined;
  loadContext?: typeof loadSimulationNarrationContext | undefined;
  buildRequest?: typeof buildSimulationNarrationRequest | undefined;
  validateWithRetry?: typeof validateSimulationNarrationWithRetry | undefined;
  saveAIAnalysis?: typeof saveAIAnalysis | undefined;
  getAIAnalysisBySubject?: typeof getAIAnalysisBySubject | undefined;
}

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
      .replace(/sk-[a-zA-Z0-9_-]{20,}/g, "[REDACTED_API_KEY]")
      .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [REDACTED_TOKEN]");
  }
  return String(error);
}

/**
 * Orchestrates tenant-scoped generation, validation, and persistence of an
 * evidence-grounded AI narration for an already-computed and persisted Simulation.
 */
export async function orchestrateSimulationNarration(
  options: OrchestrateSimulationNarrationOptions,
  deps?: SimulationNarrationOrchestratorDependencies,
): Promise<SimulationNarrationOrchestrationResult> {
  const { organizationId, simulationId } = options;
  const enableFallback = options.enableFallback ?? true;

  const pool = deps?.pool ?? getPool();
  const getSubject = deps?.getAIAnalysisBySubject ?? getAIAnalysisBySubject;
  const save = deps?.saveAIAnalysis ?? saveAIAnalysis;
  const loadCtx = deps?.loadContext ?? loadSimulationNarrationContext;
  const buildReq = deps?.buildRequest ?? buildSimulationNarrationRequest;
  const validate = deps?.validateWithRetry ?? validateSimulationNarrationWithRetry;
  const gateway = deps?.gateway ?? (await createModelGateway());

  const span = tracer.startSpan("fluxora.ai.orchestrate_simulation_narration", {
    attributes: {
      "fluxora.organization_id": organizationId,
      "fluxora.simulation_id": simulationId,
      "fluxora.task_type": "simulation_narration",
    },
  });

  let currentRecord: AIAnalysis | undefined;

  try {
    // 1. Idempotency Check: if completed/terminal record already exists, reuse it without regenerating
    let existing: AIAnalysis | null = null;
    try {
      existing = await getSubject(
        pool,
        organizationId,
        "simulation",
        simulationId,
      );
      if (existing && existing.status === "completed") {
        span.setAttribute("fluxora.ai.idempotent_hit", true);
        markSpanSuccess(span);
        return {
          status: "already_completed",
          aiAnalysis: existing,
        };
      }
      if (existing && existing.status === "rejected" && !options.forceRetry) {
        span.setAttribute("fluxora.ai.idempotent_hit", true);
        markSpanSuccess(span);
        return {
          status: "rejected",
          aiAnalysis: existing,
          errors: (existing.metadata?.validationErrors as ValidationIssue[] | undefined) ?? [],
        };
      }
      if (
        existing &&
        existing.status === "failed" &&
        !options.forceRetry &&
        typeof existing.metadata?.attempts === "number" &&
        existing.metadata.attempts >= (options.maxRetries ?? 2)
      ) {
        span.setAttribute("fluxora.ai.idempotent_hit", true);
        markSpanSuccess(span);
        return {
          status: "failed",
          aiAnalysis: existing,
          error: existing.errorMessage ?? "Maximum generation attempts reached.",
        };
      }
    } catch {
      // Non-fatal: proceed to ensure placeholder
    }

    // 2. Ensure durable pending placeholder so API and UI discover status immediately
    if (existing && existing.status === "pending") {
      currentRecord = existing;
    } else {
      try {
        currentRecord = await save(pool, {
          id: existing?.id,
          organizationId,
          subjectType: "simulation",
          subjectId: simulationId,
          status: "pending",
          promptVersion: SIMULATION_NARRATION_PROMPT_VERSION,
        });
      } catch (saveError) {
        console.error(
          `[simulation-orchestrator] failed to record initial pending status: ${sanitizeErrorMessage(saveError)}`,
        );
      }
    }

    // 3. Load tenant-scoped context and manifest (Step 63)
    let context: Awaited<ReturnType<typeof loadSimulationNarrationContext>>;
    try {
      context = await loadCtx({
        pool,
        organizationId,
        simulationId,
      });
    } catch (contextError) {
      const sanitized = sanitizeErrorMessage(contextError);
      try {
        currentRecord = await save(pool, {
          id: currentRecord?.id,
          organizationId,
          subjectType: "simulation",
          subjectId: simulationId,
          status: "failed",
          promptVersion: SIMULATION_NARRATION_PROMPT_VERSION,
          outputText: null,
          outputStructured: null,
          errorMessage: sanitized,
        });
        if (currentRecord?.status === "completed") {
          span.setAttribute("fluxora.ai.concurrency_completed_preserved", true);
          markSpanSuccess(span);
          return {
            status: "already_completed",
            aiAnalysis: currentRecord,
          };
        }
      } catch {
        // Safe swallow to protect deterministic result
      }
      markSpanError(span, sanitized);
      return {
        status: "failed",
        aiAnalysis: currentRecord,
        error: sanitized,
      };
    }

    // 4. Build provider-independent gateway request
    const request = buildReq(context);

    const persistDeterministicFallback = async (params: {
      triggerReason: FallbackTriggerReason;
      attempts: number;
      tokenCount: number;
      costUsd: number;
      latencyMs: number;
      usageUnavailable?: boolean | undefined;
      costUnavailable?: boolean | undefined;
      attemptedModel?: string | undefined;
      attemptedProvider?: string | undefined;
      errorCategories?: readonly string[] | undefined;
      attemptSummaries?: GatewayFailureAccounting["attemptSummaries"] | undefined;
      validationErrors?: readonly ValidationIssue[] | undefined;
      providerErrorMessage?: string | undefined;
    }): Promise<SimulationNarrationOrchestrationResult> => {
      const fallbackResult = generateSimulationNarrationFallback(context);

      span.setAttribute("fluxora.ai.deterministic_fallback", true);
      span.setAttribute("fluxora.ai.fallback_reason", params.triggerReason);
      span.setAttribute("fluxora.ai.fallback_abstained", fallbackResult.abstained);

      recordAiFallbackExecution({
        "ai.task_type": "simulation_narration",
        "ai.fallback_reason": params.triggerReason,
        "ai.fallback_abstained": fallbackResult.abstained,
      });

      const savedFallback = await save(pool, {
        id: currentRecord?.id,
        organizationId,
        subjectType: "simulation",
        subjectId: simulationId,
        status: "completed",
        modelUsed: null,
        promptVersion: fallbackResult.promptVersion,
        inputEvidenceIds: Array.from(context.allowedEvidenceIds),
        outputText: fallbackResult.output.summary,
        outputStructured: fallbackResult.output,
        validationStatus: "fallback",
        tokenCount: params.tokenCount,
        costUsd: params.costUsd,
        latencyMs: params.latencyMs,
        metadata: {
          schemaVersion: fallbackResult.schemaVersion,
          attempts: params.attempts,
          usedFallback: true,
          deterministicFallback: true,
          fallbackReason: params.triggerReason,
          fallbackAbstained: fallbackResult.abstained,
          omittedWithoutEvidenceCount: fallbackResult.omittedWithoutEvidenceCount,
          ...(params.usageUnavailable !== undefined
            ? { usageUnavailable: params.usageUnavailable }
            : {}),
          ...(params.costUnavailable !== undefined
            ? { costUnavailable: params.costUnavailable }
            : {}),
          ...(params.attemptedModel ? { attemptedModel: params.attemptedModel } : {}),
          ...(params.attemptedProvider ? { attemptedProvider: params.attemptedProvider } : {}),
          ...(params.errorCategories && params.errorCategories.length > 0
            ? { errorCategories: params.errorCategories }
            : {}),
          ...(params.attemptSummaries && params.attemptSummaries.length > 0
            ? { gatewayAttempts: params.attemptSummaries }
            : {}),
          ...(params.validationErrors
            ? {
                validationErrors: params.validationErrors.slice(0, 20).map((e) => ({
                  category: e.category,
                  code: e.code,
                  path: e.path,
                  message: e.message,
                })),
              }
            : {}),
          ...(params.providerErrorMessage
            ? { providerError: params.providerErrorMessage }
            : {}),
        },
      });

      if (
        savedFallback.status === "completed" &&
        savedFallback.validationStatus === "passed"
      ) {
        span.setAttribute("fluxora.ai.concurrency_completed_preserved", true);
        markSpanSuccess(span);
        return {
          status: "already_completed",
          aiAnalysis: savedFallback,
        };
      }

      markSpanSuccess(span);
      return {
        status: "completed",
        aiAnalysis: savedFallback,
      };
    };

    // 5. Invoke Model Gateway for initial response
    let initialResponse: ModelGatewayResponse;
    let retryResponse: ModelGatewayResponse | null = null;

    try {
      initialResponse = await gateway.generate(request);
    } catch (providerError) {
      const sanitized = sanitizeErrorMessage(providerError);
      const fallbackEligibility = enableFallback
        ? classifyGatewayErrorForFallback(providerError)
        : { eligible: false as const };

      if (fallbackEligibility.eligible) {
        const accounting = extractGatewayFailureAccounting(providerError);
        return await persistDeterministicFallback({
          triggerReason: fallbackEligibility.reason,
          attempts: accounting.attempts,
          tokenCount: accounting.totalTokens ?? 0,
          costUsd: accounting.costUsd ?? 0,
          latencyMs: accounting.latencyMs,
          usageUnavailable: accounting.usageUnavailable,
          costUnavailable: accounting.costUnavailable,
          attemptedModel: accounting.attemptedModel,
          attemptedProvider: accounting.attemptedProvider,
          errorCategories: accounting.errorCategories,
          attemptSummaries: accounting.attemptSummaries,
          providerErrorMessage: sanitized,
        });
      }

      try {
        currentRecord = await save(pool, {
          id: currentRecord?.id,
          organizationId,
          subjectType: "simulation",
          subjectId: simulationId,
          status: "failed",
          promptVersion: SIMULATION_NARRATION_PROMPT_VERSION,
          inputEvidenceIds: Array.from(context.allowedEvidenceIds),
          outputText: null,
          outputStructured: null,
          errorMessage: sanitized,
        });
        if (currentRecord?.status === "completed") {
          span.setAttribute("fluxora.ai.concurrency_completed_preserved", true);
          markSpanSuccess(span);
          return {
            status: "already_completed",
            aiAnalysis: currentRecord,
          };
        }
      } catch {
        // Safe swallow
      }
      markSpanError(span, sanitized);
      return {
        status: "failed",
        aiAnalysis: currentRecord,
        error: sanitized,
      };
    }

    // 6. Validate with bounded corrective retry (Step 63)
    let validationResult: Awaited<ReturnType<typeof validate>>;
    try {
      validationResult = await validate({
        initialResponseText: initialResponse.text,
        allowedEvidenceIds: context.allowedEvidenceIds,
        retry: async (params) => {
          const res = await gateway.generate({
            ...request,
            systemInstruction: `${request.systemInstruction ?? ""}\n\n${params.correctiveInstruction}`,
          });
          retryResponse = res;
          return res.text;
        },
      });
    } catch (retryProviderError) {
      const sanitized = sanitizeErrorMessage(retryProviderError);
      const fallbackEligibility = enableFallback
        ? classifyGatewayErrorForFallback(retryProviderError)
        : { eligible: false as const };

      if (fallbackEligibility.eligible) {
        const combined = combineInitialAndRetryFailureAccounting(
          initialResponse,
          retryProviderError,
        );
        return await persistDeterministicFallback({
          triggerReason: fallbackEligibility.reason,
          attempts: combined.attempts,
          tokenCount: combined.tokenCount,
          costUsd: combined.costUsd,
          latencyMs: combined.latencyMs,
          usageUnavailable: combined.usageUnavailable,
          costUnavailable: combined.costUnavailable,
          attemptedModel: combined.attemptedModel,
          attemptedProvider: combined.attemptedProvider,
          errorCategories: combined.errorCategories,
          attemptSummaries: combined.attemptSummaries,
          providerErrorMessage: sanitized,
        });
      }

      throw retryProviderError;
    }

    // 7. Aggregate usage, latency, and model metrics across all attempts
    const finalRetryResponse = retryResponse as ModelGatewayResponse | null;
    const inputTokens =
      (initialResponse.inputTokens ?? 0) + (finalRetryResponse?.inputTokens ?? 0);
    const outputTokens =
      (initialResponse.outputTokens ?? 0) + (finalRetryResponse?.outputTokens ?? 0);
    const totalTokens = inputTokens + outputTokens;
    const totalCostUsd =
      (initialResponse.costUsd ?? 0) + (finalRetryResponse?.costUsd ?? 0);
    const totalLatencyMs =
      initialResponse.latencyMs + (finalRetryResponse ? finalRetryResponse.latencyMs : 0);
    const modelUsed = finalRetryResponse ? finalRetryResponse.model : initialResponse.model;
    const usedFallback =
      initialResponse.usedFallback || (finalRetryResponse?.usedFallback ?? false);
    const totalAttempts = finalRetryResponse ? 2 : 1;

    // 8. Handle Validation Success
    if (validationResult.success) {
      const validatedData = validationResult.data;
      const structuredOutput: AIExplanationOutputDto = {
        summary: validatedData.summary,
        claims: validatedData.claims.map((c) => ({
          text: c.text,
          evidence_ids: [...c.evidence_ids],
        })),
        confidence: validatedData.confidence,
        caveats: [...validatedData.caveats],
      };

      const saved = await save(pool, {
        id: currentRecord?.id,
        organizationId,
        subjectType: "simulation",
        subjectId: simulationId,
        status: "completed",
        modelUsed,
        promptVersion: SIMULATION_NARRATION_PROMPT_VERSION,
        inputEvidenceIds: Array.from(context.allowedEvidenceIds),
        outputText: validatedData.summary,
        outputStructured: structuredOutput,
        validationStatus: "passed",
        tokenCount: totalTokens,
        costUsd: totalCostUsd,
        latencyMs: totalLatencyMs,
        metadata: {
          schemaVersion: validationResult.schemaVersion,
          attempts: totalAttempts,
          usedFallback,
          provider: finalRetryResponse ? finalRetryResponse.provider : initialResponse.provider,
          usageBreakdown: {
            initial: {
              inputTokens: initialResponse.inputTokens ?? 0,
              outputTokens: initialResponse.outputTokens ?? 0,
              costUsd: initialResponse.costUsd ?? 0,
              latencyMs: initialResponse.latencyMs,
            },
            ...(finalRetryResponse
              ? {
                  retry: {
                    inputTokens: finalRetryResponse.inputTokens ?? 0,
                    outputTokens: finalRetryResponse.outputTokens ?? 0,
                    costUsd: finalRetryResponse.costUsd ?? 0,
                    latencyMs: finalRetryResponse.latencyMs,
                  },
                }
              : {}),
          },
        },
      });

      markSpanSuccess(span);
      return {
        status: "completed",
        aiAnalysis: saved,
      };
    }

    // 9. Handle Validation Rejection (after retry exhausted) -> Deterministic Fallback (Step 66 / ADR-010)
    if (enableFallback) {
      return await persistDeterministicFallback({
        triggerReason: "validation_failed_after_retries",
        attempts: totalAttempts,
        tokenCount: totalTokens,
        costUsd: totalCostUsd,
        latencyMs: totalLatencyMs,
        attemptedModel: modelUsed,
        attemptedProvider: finalRetryResponse
          ? finalRetryResponse.provider
          : initialResponse.provider,
        validationErrors: validationResult.errors,
      });
    }

    const sanitizedErrors = validationResult.errors.map((e) => ({
      category: e.category,
      code: e.code,
      path: e.path,
      message: e.message,
    }));

    const savedRejected = await save(pool, {
      id: currentRecord?.id,
      organizationId,
      subjectType: "simulation",
      subjectId: simulationId,
      status: "rejected",
      modelUsed,
      promptVersion: SIMULATION_NARRATION_PROMPT_VERSION,
      inputEvidenceIds: Array.from(context.allowedEvidenceIds),
      outputText: null, // Never persist raw ungrounded/invalid model output
      outputStructured: null,
      validationStatus: "rejected",
      tokenCount: totalTokens,
      costUsd: totalCostUsd,
      latencyMs: totalLatencyMs,
      metadata: {
        validationErrors: sanitizedErrors,
        attempts: totalAttempts,
        usedFallback,
        provider: finalRetryResponse ? finalRetryResponse.provider : initialResponse.provider,
      },
      errorMessage: `Structured output validation failed: ${sanitizedErrors.map((e) => `[${e.code}] ${e.message}`).join("; ")}`,
    });

    if (savedRejected.status === "completed") {
      span.setAttribute("fluxora.ai.concurrency_completed_preserved", true);
      markSpanSuccess(span);
      return {
        status: "already_completed",
        aiAnalysis: savedRejected,
      };
    }

    markSpanSuccess(span);
    return {
      status: "rejected",
      aiAnalysis: savedRejected,
      errors: validationResult.errors,
    };
  } catch (unexpectedError) {
    const sanitized = sanitizeErrorMessage(unexpectedError);
    try {
      currentRecord = await save(pool, {
        id: currentRecord?.id,
        organizationId,
        subjectType: "simulation",
        subjectId: simulationId,
        status: "failed",
        promptVersion: SIMULATION_NARRATION_PROMPT_VERSION,
        outputText: null,
        outputStructured: null,
        errorMessage: sanitized,
      });
      if (currentRecord?.status === "completed") {
        span.setAttribute("fluxora.ai.concurrency_completed_preserved", true);
        markSpanSuccess(span);
        return {
          status: "already_completed",
          aiAnalysis: currentRecord,
        };
      }
    } catch {
      // Non-fatal
    }
    markSpanError(span, sanitized);
    return {
      status: "failed",
      aiAnalysis: currentRecord,
      error: sanitized,
    };
  } finally {
    span.end();
  }
}
