/**
 * @file pricing.test.ts
 * Tests for token usage pricing registry and cost calculations.
 */

import { describe, expect, it } from "vitest";

import {
  DefaultModelPricingRegistry,
} from "./pricing.ts";

describe("ModelPricingRegistry", () => {
  it("provides standard pricing for canonical Claude models", () => {
    const registry = new DefaultModelPricingRegistry();

    const sonnet = registry.getPricing("claude-sonnet-5-5");
    expect(sonnet).toBeDefined();
    expect(sonnet?.inputRateUsdPerMillion).toBe(2.0);
    expect(sonnet?.outputRateUsdPerMillion).toBe(10.0);

    const haiku = registry.getPricing("claude-haiku-5-5");
    expect(haiku).toBeDefined();
    expect(haiku?.inputRateUsdPerMillion).toBe(0.1);
    expect(haiku?.outputRateUsdPerMillion).toBe(0.5);
    expect(haiku?.tiers).toBeDefined();
    expect(haiku?.tiers?.length).toBe(2);
  });

  it("calculates cost accurately for Sonnet standard pricing", () => {
    const registry = new DefaultModelPricingRegistry();

    // 1,000,000 input tokens at $2.00/MTok + 1,000,000 output tokens at $10.00/MTok = $12.00
    const cost = registry.calculateCost(
      "claude-sonnet-5-5",
      1_000_000,
      1_000_000,
    );
    expect(cost).toBe(12.0);

    // 10,000 input tokens ($0.02) + 2,000 output tokens ($0.02) = $0.04
    const smallerCost = registry.calculateCost(
      "claude-sonnet-5-5",
      10_000,
      2_000,
    );
    expect(smallerCost).toBe(0.04);
  });

  it("calculates cost for Haiku on both sides of the 100K token threshold", () => {
    const registry = new DefaultModelPricingRegistry();

    // Below 100K threshold (e.g. 50,000 input tokens):
    // Input rate: $0.10 / MTok -> 50,000 / 1M * 0.10 = $0.005
    // Output rate: $0.50 / MTok -> 10,000 / 1M * 0.50 = $0.005
    // Total: $0.010
    const belowThreshold = registry.calculateCost(
      "claude-haiku-5-5",
      50_000,
      10_000,
    );
    expect(belowThreshold).toBe(0.01);

    // Exactly at 100K threshold (100,000 input tokens):
    // Input rate: $0.10 / MTok -> 100,000 / 1M * 0.10 = $0.010
    // Output rate: $0.50 / MTok -> 10,000 / 1M * 0.50 = $0.005
    // Total: $0.015
    const atThreshold = registry.calculateCost(
      "claude-haiku-5-5",
      100_000,
      10_000,
    );
    expect(atThreshold).toBe(0.015);

    // Above 100K threshold (100,001 input tokens):
    // Input rate: $0.50 / MTok -> 100,001 / 1M * 0.50 = $0.0500005
    // Output rate: $2.50 / MTok -> 10,000 / 1M * 2.50 = $0.025
    // Total: 0.0500005 + 0.025 = 0.075001 (rounded to micro-dollars)
    const justAboveThreshold = registry.calculateCost(
      "claude-haiku-5-5",
      100_001,
      10_000,
    );
    expect(justAboveThreshold).toBe(0.075001);

    // Well above 100K threshold (200,000 input tokens):
    // Input rate: $0.50 / MTok -> 200,000 / 1M * 0.50 = $0.10
    // Output rate: $2.50 / MTok -> 20,000 / 1M * 2.50 = $0.05
    // Total: $0.15
    const wellAboveThreshold = registry.calculateCost(
      "claude-haiku-5-5",
      200_000,
      20_000,
    );
    expect(wellAboveThreshold).toBe(0.15);
  });

  it("returns null when model pricing is missing, never fabricating zero cost", () => {
    const registry = new DefaultModelPricingRegistry();

    const cost = registry.calculateCost("unknown-future-model", 1000, 500);
    expect(cost).toBeNull();
  });

  it("returns null when token counts are null or undefined", () => {
    const registry = new DefaultModelPricingRegistry();

    expect(
      registry.calculateCost("claude-sonnet-5-5", null, 500),
    ).toBeNull();
    expect(
      registry.calculateCost("claude-sonnet-5-5", 1000, null),
    ).toBeNull();
    expect(
      registry.calculateCost("claude-sonnet-5-5", undefined, undefined),
    ).toBeNull();
  });

  it("handles custom model pricing overrides with and without tiers", () => {
    const registry = new DefaultModelPricingRegistry({
      "custom-fine-tuned-model": {
        inputRateUsdPerMillion: 5.0,
        outputRateUsdPerMillion: 25.0,
      },
      "custom-tiered-model": {
        inputRateUsdPerMillion: 1.0,
        outputRateUsdPerMillion: 5.0,
        tiers: [
          { maxInputTokens: 50_000, inputRateUsdPerMillion: 1.0, outputRateUsdPerMillion: 5.0 },
          { inputRateUsdPerMillion: 3.0, outputRateUsdPerMillion: 15.0 },
        ],
      },
    });

    const flatCost = registry.calculateCost(
      "custom-fine-tuned-model",
      2_000_000,
      1_000_000,
    );
    // (2 * $5) + (1 * $25) = $35
    expect(flatCost).toBe(35.0);

    const tieredLowCost = registry.calculateCost(
      "custom-tiered-model",
      20_000,
      10_000,
    );
    // 0.02 * 1.0 + 0.01 * 5.0 = 0.02 + 0.05 = 0.07
    expect(tieredLowCost).toBe(0.07);

    const tieredHighCost = registry.calculateCost(
      "custom-tiered-model",
      100_000,
      10_000,
    );
    // 0.1 * 3.0 + 0.01 * 15.0 = 0.3 + 0.15 = 0.45
    expect(tieredHighCost).toBe(0.45);
  });

  it("aggregates cost across primary and fallback attempts with tiered rates", () => {
    const registry = new DefaultModelPricingRegistry();

    const attempts = [
      {
        model: "claude-sonnet-5-5",
        inputTokens: 10_000, // $2.00/MTok -> $0.02
        outputTokens: 1_000, // $10.00/MTok -> $0.01 -> total $0.03
      },
      {
        model: "claude-haiku-5-5",
        inputTokens: 10_000, // <=100K: $0.10/MTok -> $0.001
        outputTokens: 2_000, // $0.50/MTok -> $0.001 -> total $0.002
      },
    ];

    const aggregateCost = registry.calculateAggregateCost(attempts);
    expect(aggregateCost).toBe(0.032);
  });

  it("aggregates cost when fallback exceeds the 100K threshold", () => {
    const registry = new DefaultModelPricingRegistry();

    const attempts = [
      {
        model: "claude-sonnet-5-5",
        inputTokens: 20_000, // $2.00/MTok -> $0.04
        outputTokens: 2_000, // $10.00/MTok -> $0.02 -> total $0.06
      },
      {
        model: "claude-haiku-5-5",
        inputTokens: 150_000, // >100K: $0.50/MTok -> $0.075
        outputTokens: 10_000, // $2.50/MTok -> $0.025 -> total $0.10
      },
    ];

    const aggregateCost = registry.calculateAggregateCost(attempts);
    // 0.06 + 0.10 = 0.16
    expect(aggregateCost).toBe(0.16);
  });

  it("returns null aggregate cost if any attempt with reported usage lacks pricing", () => {
    const registry = new DefaultModelPricingRegistry();

    const attempts = [
      {
        model: "claude-sonnet-5-5",
        inputTokens: 1000,
        outputTokens: 500,
      },
      {
        model: "unregistered-model",
        inputTokens: 1000,
        outputTokens: 500,
      },
    ];

    expect(registry.calculateAggregateCost(attempts)).toBeNull();
  });

  it("ignores attempts with null token usage during aggregate cost computation", () => {
    const registry = new DefaultModelPricingRegistry();

    const attempts = [
      {
        model: "claude-sonnet-5-5",
        inputTokens: null,
        outputTokens: null,
      },
      {
        model: "claude-haiku-5-5",
        inputTokens: 10_000,
        outputTokens: 1_000,
      },
    ];

    // Only second attempt has billable tokens:
    // 10,000 / 1M * 0.10 = 0.001
    // 1,000 / 1M * 0.50 = 0.0005
    // Total = 0.0015
    expect(registry.calculateAggregateCost(attempts)).toBe(0.0015);
  });

  it("returns null when no attempt reported token usage", () => {
    const registry = new DefaultModelPricingRegistry();

    const attempts = [
      {
        model: "claude-sonnet-5-5",
        inputTokens: null,
        outputTokens: null,
      },
    ];

    expect(registry.calculateAggregateCost(attempts)).toBeNull();
  });
});
