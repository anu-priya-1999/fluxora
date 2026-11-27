/**
 * @file metrics.ts
 * Machine-readable metric aggregation for AI evaluation runs (Phase 9 Step 65).
 *
 * Computes citation provenance, semantic groundedness, hallucination rate,
 * structured-output/retry rates, entity hallucination counts, and latency/cost percentiles.
 * Never fabricates token or cost values when MockModelProvider reports null.
 */

import type { ModelTaskType } from "../types.ts";
import type {
  CaseEvaluationResult,
  CitationProvenanceMetrics,
  EntityHallucinationMetrics,
  LatencyAndCostMetrics,
  SemanticGroundednessMetrics,
  StructuredOutputMetrics,
  TaskTypeEvaluationMetrics,
} from "./types.ts";

function roundRate(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function computePercentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  const clamped = Math.max(0, Math.min(sortedValues.length - 1, index));
  return sortedValues[clamped] ?? 0;
}

export function aggregateCitationProvenance(
  results: readonly CaseEvaluationResult[],
): CitationProvenanceMetrics {
  let totalCitations = 0;
  let citationsInManifest = 0;
  let invalidOrFabricatedCitations = 0;

  for (const r of results) {
    totalCitations += r.citationCount;
    citationsInManifest += r.validManifestCitationCount;
    invalidOrFabricatedCitations += r.invalidCitationCount;
  }

  return {
    totalCitations,
    citationsInManifest,
    invalidOrFabricatedCitations,
    manifestComplianceRate:
      totalCitations === 0 ? 1 : roundRate(citationsInManifest, totalCitations),
  };
}

export function aggregateSemanticGroundedness(
  results: readonly CaseEvaluationResult[],
): SemanticGroundednessMetrics {
  let totalEvaluatedClaims = 0;
  let supportedClaims = 0;
  let unsupportedClaims = 0;
  let contradictedClaims = 0;
  let ambiguousClaims = 0;

  for (const r of results) {
    for (const c of r.claimEvaluations) {
      totalEvaluatedClaims += 1;
      switch (c.label) {
        case "supported":
          supportedClaims += 1;
          break;
        case "unsupported":
          unsupportedClaims += 1;
          break;
        case "contradicted":
          contradictedClaims += 1;
          break;
        case "ambiguous":
          ambiguousClaims += 1;
          break;
      }
    }
  }

  const failingGroundedness = unsupportedClaims + contradictedClaims;
  const conservativeFailing = failingGroundedness + ambiguousClaims;

  return {
    totalEvaluatedClaims,
    supportedClaims,
    unsupportedClaims,
    contradictedClaims,
    ambiguousClaims,
    semanticGroundednessRate:
      totalEvaluatedClaims === 0
        ? 1
        : roundRate(supportedClaims, totalEvaluatedClaims),
    hallucinationRate: roundRate(failingGroundedness, totalEvaluatedClaims),
    conservativeHallucinationRate: roundRate(
      conservativeFailing,
      totalEvaluatedClaims,
    ),
    denominatorNotes:
      "hallucination_rate = (unsupported + contradicted) / total_evaluated_factual_claims; ambiguous claims are tracked separately and included in conservativeHallucinationRate, never silently classified as supported.",
  };
}

export function aggregateStructuredOutput(
  results: readonly CaseEvaluationResult[],
): StructuredOutputMetrics {
  const totalCalls = results.length;
  let firstAttemptValidCount = 0;
  let correctiveRetryCount = 0;
  let finalValidCount = 0;
  let rejectedCount = 0;
  const validationErrorCategories: Record<string, number> = {};

  for (const r of results) {
    const t = r.telemetry;
    if (t.initialSchemaValid) {
      firstAttemptValidCount += 1;
    }
    if (t.requiredCorrectiveRetry) {
      correctiveRetryCount += 1;
    }
    if (t.finalSchemaValid) {
      finalValidCount += 1;
    }
    if (t.rejected) {
      rejectedCount += 1;
    }
    for (const cat of t.validationErrorCategories) {
      validationErrorCategories[cat] = (validationErrorCategories[cat] ?? 0) + 1;
    }
  }

  return {
    totalCalls,
    firstAttemptValidCount,
    correctiveRetryCount,
    finalValidCount,
    rejectedCount,
    firstAttemptValidRate: roundRate(firstAttemptValidCount, totalCalls),
    correctiveRetryRate: roundRate(correctiveRetryCount, totalCalls),
    finalValidRate: roundRate(finalValidCount, totalCalls),
    rejectionRate: roundRate(rejectedCount, totalCalls),
    validationErrorCategories,
  };
}

export function aggregateEntityHallucinations(
  results: readonly CaseEvaluationResult[],
): EntityHallucinationMetrics {
  let totalExtractedEntities = 0;
  let supportedEntitiesCount = 0;
  let unsupportedEntitiesCount = 0;
  let absentRelationshipCount = 0;
  let simulationMismatchCount = 0;

  for (const r of results) {
    totalExtractedEntities += r.entityCheck.extractedEntities.length;
    supportedEntitiesCount += r.entityCheck.supportedEntities.length;
    unsupportedEntitiesCount += r.entityCheck.unsupportedEntities.length;
    absentRelationshipCount += r.entityCheck.absentRelationshipClaims.length;
    simulationMismatchCount += r.entityCheck.simulationMismatches.length;
  }

  return {
    totalExtractedEntities,
    supportedEntitiesCount,
    unsupportedEntitiesCount,
    absentRelationshipCount,
    simulationMismatchCount,
  };
}

export function aggregateLatencyAndCost(
  results: readonly CaseEvaluationResult[],
): LatencyAndCostMetrics {
  const sampleCount = results.length;
  const latencies = results.map((r) => r.telemetry.latencyMs).sort((a, b) => a - b);
  const sumLatency = latencies.reduce((acc, v) => acc + v, 0);

  let hasInputTokens = false;
  let totalInputTokens = 0;
  let hasOutputTokens = false;
  let totalOutputTokens = 0;
  let hasCost = false;
  let totalCostUsd = 0;
  let retryCostUsd = 0;
  let hasRetryCost = false;
  let fallbackCount = 0;
  let successCount = 0;

  for (const r of results) {
    const t = r.telemetry;
    if (t.finalSchemaValid) {
      successCount += 1;
    }
    if (t.usedFallback) {
      fallbackCount += 1;
    }
    if (t.inputTokens !== null) {
      hasInputTokens = true;
      totalInputTokens += t.inputTokens;
    }
    if (t.outputTokens !== null) {
      hasOutputTokens = true;
      totalOutputTokens += t.outputTokens;
    }
    if (t.totalCostUsd !== null) {
      hasCost = true;
      totalCostUsd += t.totalCostUsd;
    }
    if (t.retryCostUsd !== null) {
      hasRetryCost = true;
      retryCostUsd += t.retryCostUsd;
    }
  }

  return {
    sampleCount,
    p50LatencyMs: computePercentile(latencies, 50),
    p95LatencyMs: computePercentile(latencies, 95),
    meanLatencyMs:
      sampleCount === 0 ? 0 : Math.round((sumLatency / sampleCount) * 100) / 100,
    totalInputTokens: hasInputTokens ? totalInputTokens : null,
    totalOutputTokens: hasOutputTokens ? totalOutputTokens : null,
    totalCostUsd: hasCost ? roundUsd(totalCostUsd) : null,
    averageCostPerSuccessUsd:
      hasCost && successCount > 0 ? roundUsd(totalCostUsd / successCount) : null,
    correctiveRetryCostUsd: hasRetryCost ? roundUsd(retryCostUsd) : null,
    fallbackFrequency: roundRate(fallbackCount, sampleCount),
  };
}

export function aggregateMetricsByTaskType(
  results: readonly CaseEvaluationResult[],
): readonly TaskTypeEvaluationMetrics[] {
  const taskTypes: ModelTaskType[] = [
    "impact_explanation",
    "simulation_narration",
    "chat_query",
  ];

  return taskTypes
    .map((taskType) => {
      const subset = results.filter((r) => r.taskType === taskType);
      return {
        taskType,
        sampleCount: subset.length,
        citationProvenance: aggregateCitationProvenance(subset),
        semanticGroundedness: aggregateSemanticGroundedness(subset),
        structuredOutput: aggregateStructuredOutput(subset),
        entityHallucination: aggregateEntityHallucinations(subset),
        latencyAndCost: aggregateLatencyAndCost(subset),
      };
    })
    .filter((m) => m.sampleCount > 0);
}
