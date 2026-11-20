/**
 * @file policy.test.ts
 * Tests for task-aware model selection, timeouts, and fallback routing policies.
 */

import { describe, expect, it } from "vitest";

import {
  CANONICAL_FALLBACK_MODEL,
  CANONICAL_PRIMARY_MODEL,
  DEFAULT_TASK_POLICIES,
  ModelRoutingPolicy,
} from "./policy.ts";

describe("ModelRoutingPolicy", () => {
  it("resolves default task policies according to architectural specifications", () => {
    const policy = new ModelRoutingPolicy();

    const impact = policy.getPolicy("impact_explanation");
    expect(impact.timeoutMs).toBe(20_000); // 20s architectural guidance
    expect(impact.maxTokens).toBe(1024);
    expect(impact.primaryModel).toBe(CANONICAL_PRIMARY_MODEL);
    expect(impact.fallbackModel).toBe(CANONICAL_FALLBACK_MODEL);
    expect(impact.maxPrimaryRetries).toBe(2);

    const simulation = policy.getPolicy("simulation_narration");
    expect(simulation.timeoutMs).toBe(30_000); // 30s bounded default
    expect(simulation.maxTokens).toBe(2048);

    const chat = policy.getPolicy("chat_query");
    expect(chat.timeoutMs).toBe(45_000); // 45s architectural guidance
    expect(chat.maxTokens).toBe(4096);
  });

  it("clamps requested timeout overrides within safety limits", () => {
    const policy = new ModelRoutingPolicy({
      minAllowedTimeoutMs: 1_000,
      maxAllowedTimeoutMs: 60_000,
    });

    // Valid within range
    expect(policy.resolveTimeoutMs("impact_explanation", 25_000)).toBe(25_000);

    // Below minimum clamp to 1,000ms
    expect(policy.resolveTimeoutMs("impact_explanation", 200)).toBe(1_000);

    // Above maximum clamp to 60,000ms
    expect(policy.resolveTimeoutMs("impact_explanation", 120_000)).toBe(60_000);

    // Undefined fallback to task default (20,000ms)
    expect(policy.resolveTimeoutMs("impact_explanation", undefined)).toBe(20_000);
  });

  it("resolves max tokens with fallback to task defaults", () => {
    const policy = new ModelRoutingPolicy();

    expect(policy.resolveMaxTokens("impact_explanation", 512)).toBe(512);
    expect(policy.resolveMaxTokens("impact_explanation", undefined)).toBe(1024);
    expect(policy.resolveMaxTokens("impact_explanation", -10)).toBe(1024);
  });

  it("allows custom model and task overrides", () => {
    const policy = new ModelRoutingPolicy({
      defaultPrimaryModel: "custom-primary-model",
      defaultFallbackModel: "custom-fallback-model",
      taskOverrides: {
        simulation_narration: {
          timeoutMs: 40_000,
          maxTokens: 8192,
        },
      },
    });

    const simulation = policy.getPolicy("simulation_narration");
    expect(simulation.primaryModel).toBe("custom-primary-model");
    expect(simulation.fallbackModel).toBe("custom-fallback-model");
    expect(simulation.timeoutMs).toBe(40_000);
    expect(simulation.maxTokens).toBe(8192);

    const impact = policy.getPolicy("impact_explanation");
    expect(impact.primaryModel).toBe("custom-primary-model");
    expect(impact.timeoutMs).toBe(DEFAULT_TASK_POLICIES.impact_explanation.timeoutMs);
  });
});
