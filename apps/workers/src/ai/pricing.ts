/**
 * @file pricing.ts
 * Pricing registry and token cost calculation for AI models.
 *
 * Implements standard pricing formulas keyed by model identifier,
 * supporting attempt-level and aggregate multi-attempt cost tracking.
 */

export interface ModelPricingTier {
  /**
   * Upper bound for input tokens (inclusive) for this pricing tier.
   * If omitted or undefined, applies to all input token counts above preceding tiers.
   */
  readonly maxInputTokens?: number;
  readonly inputRateUsdPerMillion: number;
  readonly outputRateUsdPerMillion: number;
}

export interface ModelPricing {
  readonly inputRateUsdPerMillion: number;
  readonly outputRateUsdPerMillion: number;
  /**
   * Optional tiered pricing definitions based on input token counts.
   * When provided, `calculateCost` and `getPricing(model, inputTokens)` resolve rates against matching tier.
   */
  readonly tiers?: readonly ModelPricingTier[];
}

/**
 * Standard baseline list prices for Anthropic Claude models (USD per 1,000,000 tokens).
 *
 * Current standard Claude API list prices verified against official Anthropic pricing
 * documentation (https://platform.claude.com/docs/en/about-claude/pricing) on November 20, 2026:
 * - claude-sonnet-5-5: $2.00 / MTok input, $10.00 / MTok output.
 * - claude-haiku-5-5:
 *   - input <= 100K tokens: $0.10 / MTok input, $0.50 / MTok output.
 *   - input > 100K tokens:  $0.50 / MTok input, $2.50 / MTok output.
 *
 * Historical records for retired models are preserved for audit / historical telemetry accounting
 * and are excluded from active model routing.
 */
export const DEFAULT_MODEL_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  // Active standard models (verified November 20, 2026)
  "claude-sonnet-5-5": {
    inputRateUsdPerMillion: 2.0,
    outputRateUsdPerMillion: 10.0,
  },
  "claude-haiku-5-5": {
    inputRateUsdPerMillion: 0.1,
    outputRateUsdPerMillion: 0.5,
    tiers: [
      {
        maxInputTokens: 100_000,
        inputRateUsdPerMillion: 0.1,
        outputRateUsdPerMillion: 0.5,
      },
      {
        inputRateUsdPerMillion: 0.5,
        outputRateUsdPerMillion: 2.5,
      },
    ],
  },

  // Historical retired models (preserved for telemetry accounting, excluded from active routing)
  "claude-3-5-sonnet-20241022": {
    inputRateUsdPerMillion: 3.0,
    outputRateUsdPerMillion: 15.0,
  },
  "claude-3-5-haiku-20241022": {
    inputRateUsdPerMillion: 0.8,
    outputRateUsdPerMillion: 4.0,
  },
  "claude-3-haiku-20240307": {
    inputRateUsdPerMillion: 0.25,
    outputRateUsdPerMillion: 1.25,
  },
  "claude-3-opus-20240229": {
    inputRateUsdPerMillion: 15.0,
    outputRateUsdPerMillion: 75.0,
  },
});

export interface TokenUsageAttempt {
  readonly model: string;
  readonly inputTokens: number | null | undefined;
  readonly outputTokens: number | null | undefined;
}

/**
 * Registry interface for retrieving model rates and computing USD costs.
 */
export interface ModelPricingRegistry {
  getPricing(model: string, inputTokens?: number | null): ModelPricing | undefined;
  calculateCost(
    model: string,
    inputTokens: number | null | undefined,
    outputTokens: number | null | undefined,
  ): number | null;
  calculateAggregateCost(attempts: readonly TokenUsageAttempt[]): number | null;
}

/**
 * Standard implementation of ModelPricingRegistry.
 */
export class DefaultModelPricingRegistry implements ModelPricingRegistry {
  private readonly pricingMap: Map<string, ModelPricing>;

  constructor(customPricing?: Record<string, ModelPricing>) {
    this.pricingMap = new Map<string, ModelPricing>();

    for (const [model, pricing] of Object.entries(DEFAULT_MODEL_PRICING)) {
      this.pricingMap.set(model, pricing);
    }

    if (customPricing) {
      for (const [model, pricing] of Object.entries(customPricing)) {
        this.pricingMap.set(model, pricing);
      }
    }
  }

  getPricing(model: string, inputTokens?: number | null): ModelPricing | undefined {
    const basePricing = this.pricingMap.get(model);
    if (!basePricing) {
      return undefined;
    }

    if (
      basePricing.tiers &&
      basePricing.tiers.length > 0 &&
      inputTokens !== null &&
      inputTokens !== undefined &&
      typeof inputTokens === "number" &&
      !Number.isNaN(inputTokens)
    ) {
      for (const tier of basePricing.tiers) {
        if (tier.maxInputTokens === undefined || inputTokens <= tier.maxInputTokens) {
          return {
            inputRateUsdPerMillion: tier.inputRateUsdPerMillion,
            outputRateUsdPerMillion: tier.outputRateUsdPerMillion,
            tiers: basePricing.tiers,
          };
        }
      }
    }

    return basePricing;
  }

  /**
   * Calculates cost for a single attempt.
   * Returns null if pricing is unknown or if token counts are insufficient/null.
   * Never returns 0 when pricing is missing.
   */
  calculateCost(
    model: string,
    inputTokens: number | null | undefined,
    outputTokens: number | null | undefined,
  ): number | null {
    if (
      inputTokens === null ||
      inputTokens === undefined ||
      outputTokens === null ||
      outputTokens === undefined
    ) {
      return null;
    }

    const pricing = this.getPricing(model, inputTokens);
    if (!pricing) {
      return null;
    }

    const inputCost = (inputTokens / 1_000_000) * pricing.inputRateUsdPerMillion;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputRateUsdPerMillion;
    const total = inputCost + outputCost;

    // Round to 6 decimal places (micro-dollars) to avoid IEEE floating point inaccuracies
    return Math.round(total * 1_000_000) / 1_000_000;
  }

  /**
   * Aggregates cost across multiple attempts (e.g. failed primary attempts + successful fallback).
   * Returns null if any attempt with reported tokens cannot be priced, or if no attempt has usage.
   */
  calculateAggregateCost(attempts: readonly TokenUsageAttempt[]): number | null {
    let hasAnyUsage = false;
    let totalUsd = 0;

    for (const attempt of attempts) {
      const hasReportedTokens =
        attempt.inputTokens !== null &&
        attempt.inputTokens !== undefined &&
        attempt.outputTokens !== null &&
        attempt.outputTokens !== undefined;

      if (!hasReportedTokens) {
        continue;
      }

      hasAnyUsage = true;
      const attemptCost = this.calculateCost(
        attempt.model,
        attempt.inputTokens,
        attempt.outputTokens,
      );

      if (attemptCost === null) {
        // Known usage exists on this attempt, but pricing is unknown -> aggregate cost is indeterminate
        return null;
      }

      totalUsd += attemptCost;
    }

    if (!hasAnyUsage) {
      return null;
    }

    return Math.round(totalUsd * 1_000_000) / 1_000_000;
  }
}
