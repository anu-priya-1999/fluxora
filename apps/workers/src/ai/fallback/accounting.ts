/**
 * @file accounting.ts
 * Gateway failure accounting extraction for deterministic fallback persistence (Phase 9 Step 66).
 *
 * Preserves actual attempt counts, model/provider identities, latency, and any
 * reliably reported token usage or cost without fabricating missing metrics.
 */

import { ModelGatewayError } from "../errors.ts";
import type { ModelGatewayAttemptRecord, ModelGatewayResponse } from "../types.ts";

export interface GatewayFailureAccounting {
  readonly attempts: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly usageUnavailable: boolean;
  readonly costUnavailable: boolean;
  readonly attemptedModel?: string | undefined;
  readonly attemptedProvider?: string | undefined;
  readonly errorCategories: readonly string[];
  readonly attemptSummaries: readonly Pick<
    ModelGatewayAttemptRecord,
    "attemptNumber" | "model" | "isFallback" | "outcome" | "errorCategory" | "latencyMs"
  >[];
}

export function extractGatewayFailureAccounting(
  error: unknown,
): GatewayFailureAccounting {
  if (!(error instanceof ModelGatewayError)) {
    return {
      attempts: 0,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      latencyMs: 0,
      usageUnavailable: true,
      costUnavailable: true,
      errorCategories: [],
      attemptSummaries: [],
    };
  }

  const attemptsList = error.attempts ?? [];
  const attempts =
    attemptsList.length > 0 ? attemptsList.length : (error.attemptCount ?? 0);

  let hasInput = false;
  let sumInput = 0;
  let hasOutput = false;
  let sumOutput = 0;
  let hasCost = false;
  let sumCost = 0;
  let sumAttemptLatency = 0;
  const errorCategories = new Set<string>();

  const attemptSummaries = attemptsList.map((a) => {
    if (a.inputTokens !== null) {
      hasInput = true;
      sumInput += a.inputTokens;
    }
    if (a.outputTokens !== null) {
      hasOutput = true;
      sumOutput += a.outputTokens;
    }
    if (a.costUsd !== null) {
      hasCost = true;
      sumCost += a.costUsd;
    }
    sumAttemptLatency += a.latencyMs;
    if (a.errorCategory) {
      errorCategories.add(a.errorCategory);
    }
    return {
      attemptNumber: a.attemptNumber,
      model: a.model,
      isFallback: a.isFallback,
      outcome: a.outcome,
      errorCategory: a.errorCategory,
      latencyMs: a.latencyMs,
    };
  });

  if (errorCategories.size === 0) {
    errorCategories.add(error.code);
  }

  const inputTokens = hasInput ? sumInput : null;
  const outputTokens = hasOutput ? sumOutput : null;
  const totalTokens =
    inputTokens !== null || outputTokens !== null
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : null;
  const costUsd = hasCost ? sumCost : null;
  const latencyMs = error.totalLatencyMs ?? sumAttemptLatency;
  const lastAttempt = attemptsList.length > 0 ? attemptsList[attemptsList.length - 1] : undefined;

  return {
    attempts,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    latencyMs,
    usageUnavailable: inputTokens === null && outputTokens === null,
    costUnavailable: costUsd === null,
    attemptedModel: error.model ?? lastAttempt?.model,
    attemptedProvider: error.provider,
    errorCategories: Array.from(errorCategories),
    attemptSummaries,
  };
}

export function combineInitialAndRetryFailureAccounting(
  initial: ModelGatewayResponse,
  retryError: unknown,
): {
  readonly attempts: number;
  readonly tokenCount: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly usageUnavailable: boolean;
  readonly costUnavailable: boolean;
  readonly attemptedModel: string;
  readonly attemptedProvider: string;
  readonly errorCategories: readonly string[];
  readonly attemptSummaries: GatewayFailureAccounting["attemptSummaries"];
} {
  const retry = extractGatewayFailureAccounting(retryError);
  const initialAttempts =
    typeof initial.attemptCount === "number" &&
    Number.isInteger(initial.attemptCount) &&
    initial.attemptCount >= 0
      ? initial.attemptCount
      : 1;
  const initialTokens = (initial.inputTokens ?? 0) + (initial.outputTokens ?? 0);
  const initialUsageUnavailable =
    initial.inputTokens === null && initial.outputTokens === null;

  return {
    attempts: initialAttempts + retry.attempts,
    tokenCount: initialTokens + (retry.totalTokens ?? 0),
    costUsd: (initial.costUsd ?? 0) + (retry.costUsd ?? 0),
    latencyMs: initial.latencyMs + retry.latencyMs,
    usageUnavailable: initialUsageUnavailable || retry.usageUnavailable,
    costUnavailable: initial.costUsd === null || retry.costUnavailable,
    attemptedModel: retry.attemptedModel ?? initial.model,
    attemptedProvider: retry.attemptedProvider ?? initial.provider,
    errorCategories: retry.errorCategories,
    attemptSummaries: retry.attemptSummaries,
  };
}
