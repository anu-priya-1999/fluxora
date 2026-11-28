/**
 * @file orchestrator.ts
 * AI Explanation Orchestrator Service (Phase 9 Step 62).
 *
 * Coordinates the complete end-to-end AI impact-explanation pipeline:
 * Deterministic impact analysis -> Context Assembly (Step 60) -> Model Gateway (Step 59)
 * -> Structured Output & Grounding Validation (Step 61) -> Durable AIAnalysis persistence.
 *
 * Core invariants:
 * - Deterministic blast-radius core remains the sole authority.
 * - AI failure or validation rejection NEVER invalidates or fails deterministic impact results.
 * - Strict whole-response rejection on ungrounded citations (ADR-014).
 * - No raw invalid model output or provider secrets persisted on failure or rejection.
 * - Exact same trusted allowedEvidenceIds manifest used on initial and corrective attempts.
 * - Accurate aggregation of token counts, cost, and latency across attempts.
 * - Idempotency: repeated execution for same analysis does not duplicate records or model calls.
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

import {
  buildImpactExplanationRequest,
  IMPACT_EXPLANATION_PROMPT_VERSION,
  loadImpactExplanationContext,
} from "./context/index.ts";
import { createModelGateway } from "./factory.ts";
import {
  classifyGatewayErrorForFallback,
  combineInitialAndRetryFailureAccounting,
  extractGatewayFailureAccounting,
  generateImpactExplanationFallback,
  type FallbackTriggerReason,
  type GatewayFailureAccounting,
} from "./fallback/index.ts";
import {
  validateImpactExplanationWithRetry,
  type ValidationIssue,
} from "./structured-output/index.ts";
import type { ModelGateway, ModelGatewayResponse } from "./types.ts";

const tracer = getTracer("@fluxora/workers");

export interface OrchestrateImpactExplanationOptions {
  readonly organizationId: string;
  readonly impactAnalysisId: string;
  /** Force regeneration even if an existing completed, rejected, or failed record exists. */
  readonly forceRetry?: boolean | undefined;
  /**
   * Maximum cumulative background worker-level failed attempts across job redeliveries
   * before short-circuiting on an existing failed record (defaults to 2).
   *
   * DISTINCT FROM STEP 61 VALIDATION RETRIES:
   * This option controls job redelivery tolerance for previously failed records.
   * It does NOT and CANNOT alter the Step 61 structured output validation ceiling,
   * which is strictly invariant at at most 2 response attempts (1 initial response +
   * at most 1 corrective retry).
   */
  readonly maxRetries?: number | undefined;
  /**
   * Enable deterministic fallback explanation when AI generation is unavailable or
   * fails structured-output validation after permitted retries (Step 66, defaults to true).
   */
  readonly enableFallback?: boolean | undefined;
}

export type AIExplanationOrchestrationResult =
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

export interface AIExplanationOrchestratorDependencies {
  pool?: Parameters<typeof saveAIAnalysis>[0] | undefined;
  gateway?: ModelGateway | undefined;
  loadContext?: typeof loadImpactExplanationContext | undefined;
  buildRequest?: typeof buildImpactExplanationRequest | undefined;
  validateWithRetry?: typeof validateImpactExplanationWithRetry | undefined;
  saveAIAnalysis?: typeof saveAIAnalysis | undefined;
  getAIAnalysisBySubject?: typeof getAIAnalysisBySubject | undefined;
}

function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Redact potential bearer tokens or keys from error message strings
    return error.message
      .replace(/sk-[a-zA-Z0-9_-]{20,}/g, "[REDACTED_API_KEY]")
      .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [REDACTED_TOKEN]");
  }
  return String(error);
}

/**
 * Orchestrates tenant-scoped generation, validation, and persistence of an
 * evidence-grounded AI impact explanation for an already-computed ImpactAnalysis.
 */
export async function orchestrateImpactExplanation(
  options: OrchestrateImpactExplanationOptions,
  deps?: AIExplanationOrchestratorDependencies,
): Promise<AIExplanationOrchestrationResult> {
  const { organizationId, impactAnalysisId } = options;
  const enableFallback = options.enableFallback ?? true;

  const pool = deps?.pool ?? getPool();
  const getSubject = deps?.getAIAnalysisBySubject ?? getAIAnalysisBySubject;
  const save = deps?.saveAIAnalysis ?? saveAIAnalysis;
  const loadCtx = deps?.loadContext ?? loadImpactExplanationContext;
  const buildReq = deps?.buildRequest ?? buildImpactExplanationRequest;
  const validate = deps?.validateWithRetry ?? validateImpactExplanationWithRetry;
  const gateway = deps?.gateway ?? (await createModelGateway());

  const span = tracer.startSpan("fluxora.ai.orchestrate_impact_explanation", {
    attributes: {
      "fluxora.organization_id": organizationId,
      "fluxora.impact_analysis_id": impactAnalysisId,
      "fluxora.task_type": "impact_explanation",
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
        "impact_analysis",
        impactAnalysisId,
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
          subjectType: "impact_analysis",
          subjectId: impactAnalysisId,
          status: "pending",
          promptVersion: IMPACT_EXPLANATION_PROMPT_VERSION,
        });
      } catch (saveError) {
        // If saving pending fails, continue generation attempt or log
        console.error(
          `[orchestrator] failed to record initial pending status: ${sanitizeErrorMessage(saveError)}`,
        );
      }
    }

    // 3. Load tenant-scoped context and manifest (Step 60)
    let context: Awaited<ReturnType<typeof loadImpactExplanationContext>>;
    try {
      context = await loadCtx({
        pool,
        organizationId,
        impactAnalysisId,
      });
    } catch (contextError) {
      const sanitized = sanitizeErrorMessage(contextError);
      try {
        currentRecord = await save(pool, {
          id: currentRecord?.id,
          organizationId,
          subjectType: "impact_analysis",
          subjectId: impactAnalysisId,
          status: "failed",
          promptVersion: IMPACT_EXPLANATION_PROMPT_VERSION,
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

    // 4. Build provider-independent gateway request (Step 60)
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
    }): Promise<AIExplanationOrchestrationResult> => {
      const fallbackResult = generateImpactExplanationFallback(context);

      span.setAttribute("fluxora.ai.deterministic_fallback", true);
      span.setAttribute("fluxora.ai.fallback_reason", params.triggerReason);
      span.setAttribute("fluxora.ai.fallback_abstained", fallbackResult.abstained);

      recordAiFallbackExecution({
        "ai.task_type": "impact_explanation",
        "ai.fallback_reason": params.triggerReason,
        "ai.fallback_abstained": fallbackResult.abstained,
      });

      const savedFallback = await save(pool, {
        id: currentRecord?.id,
        organizationId,
        subjectType: "impact_analysis",
        subjectId: impactAnalysisId,
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
            ? { validationErrors: params.validationErrors.slice(0, 20) }
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

    // 5. Invoke Model Gateway (Step 59) for initial response
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
          subjectType: "impact_analysis",
          subjectId: impactAnalysisId,
          status: "failed",
          promptVersion: IMPACT_EXPLANATION_PROMPT_VERSION,
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

    // 6. Validate with bounded corrective retry (Step 61)
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
        subjectType: "impact_analysis",
        subjectId: impactAnalysisId,
        status: "completed",
        modelUsed,
        promptVersion: IMPACT_EXPLANATION_PROMPT_VERSION,
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

    // 9. Handle Validation Rejection (ADR-014) -> Deterministic Fallback (Step 66 / ADR-010)
    // Never persist raw invalid model completion.
    if (enableFallback) {
      return await persistDeterministicFallback({
        triggerReason: "validation_failed_after_retries",
        attempts: validationResult.attempts,
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

    const rejectedRecord = await save(pool, {
      id: currentRecord?.id,
      organizationId,
      subjectType: "impact_analysis",
      subjectId: impactAnalysisId,
      status: "rejected",
      modelUsed,
      promptVersion: IMPACT_EXPLANATION_PROMPT_VERSION,
      inputEvidenceIds: Array.from(context.allowedEvidenceIds),
      outputText: null,
      outputStructured: null,
      validationStatus: "rejected",
      tokenCount: totalTokens,
      costUsd: totalCostUsd,
      latencyMs: totalLatencyMs,
      metadata: {
        schemaVersion: "impact-explanation-output-v1",
        attempts: validationResult.attempts,
        validationErrors: validationResult.errors.slice(0, 20),
        usedFallback,
      },
    });

    if (rejectedRecord.status === "completed") {
      span.setAttribute("fluxora.ai.concurrency_completed_preserved", true);
      markSpanSuccess(span);
      return {
        status: "already_completed",
        aiAnalysis: rejectedRecord,
      };
    }

    markSpanSuccess(span);
    return {
      status: "rejected",
      aiAnalysis: rejectedRecord,
      errors: validationResult.errors,
    };
  } catch (unexpectedError) {
    // 10. CRITICAL FAILURE ISOLATION BOUNDARY
    // Unexpected error during orchestration must never invalidate deterministic impact findings.
    const sanitized = sanitizeErrorMessage(unexpectedError);
    try {
      const failedRecord = await save(pool, {
        id: currentRecord?.id,
        organizationId,
        subjectType: "impact_analysis",
        subjectId: impactAnalysisId,
        status: "failed",
        promptVersion: IMPACT_EXPLANATION_PROMPT_VERSION,
        errorMessage: sanitized,
      });
      if (failedRecord?.status === "completed") {
        span.setAttribute("fluxora.ai.concurrency_completed_preserved", true);
        markSpanSuccess(span);
        return {
          status: "already_completed",
          aiAnalysis: failedRecord,
        };
      }
    } catch {
      // Safe swallow
    }

    markSpanError(span, sanitized);
    return {
      status: "failed",
      error: sanitized,
    };
  } finally {
    span.end();
  }
}
