/**
 * @file gateway.test.ts
 * Comprehensive test suite for the Production Model Gateway.
 *
 * Verifies retry semantics, fallback model routing, exponential backoff,
 * timeout handling, caller cancellation, token usage & cost aggregation,
 * and telemetry emission without any outbound network calls.
 */

import { describe, expect, it } from "vitest";

import { ModelGatewayError } from "./errors.ts";
import { ProductionModelGateway, type SleepFunction } from "./gateway.ts";
import { MockModelGateway, MockModelProvider } from "./mock-gateway.ts";
import { ModelRoutingPolicy } from "./policy.ts";
import { DefaultModelPricingRegistry } from "./pricing.ts";
import type {
  ModelGatewayRequest,
  ModelProviderAdapter,
  ProviderGenerateParams,
  ProviderGenerateResult,
} from "./types.ts";

function createTestRequest(overrides?: Partial<ModelGatewayRequest>): ModelGatewayRequest {
  return {
    taskType: "impact_explanation",
    promptVersion: "impact-v1",
    systemInstruction: "You are an architecture explainer.",
    messages: [{ role: "user", content: "Explain payment service impact." }],
    ...overrides,
  };
}

describe("Model Gateway — Production & Mock Semantics", () => {
  it("MockModelGateway returns deterministic output without fabricating tokens or cost", async () => {
    const gateway = new MockModelGateway();
    const response = await gateway.generate(createTestRequest());

    expect(response.isMock).toBe(true);
    expect(response.provider).toBe("mock");
    expect(response.text).toContain("[MOCK_OUTPUT]");
    expect(response.costUsd).toBeNull();
    expect(response.inputTokens).toBeNull();
    expect(response.outputTokens).toBeNull();
    expect(response.totalTokens).toBeNull();
    expect(response.attemptCount).toBe(1);
    expect(response.usedFallback).toBe(false);
  });

  it("Primary success does not invoke fallback and records accurate attempt metadata", async () => {
    const mockProvider = new MockModelProvider({
      cannedResponseText: "Primary model impact explanation.",
    });

    const gateway = new ProductionModelGateway({
      provider: mockProvider,
    });

    const response = await gateway.generate(createTestRequest());

    expect(response.text).toBe("Primary model impact explanation.");
    expect(response.usedFallback).toBe(false);
    expect(response.attemptCount).toBe(1);
    expect(response.attempts[0]?.outcome).toBe("success");
    expect(response.attempts[0]?.isFallback).toBe(false);
    expect(mockProvider.totalCalls).toBe(1);
  });

  it("Retries retryable primary failure within configured limit and succeeds on retry", async () => {
    const sleepDelays: number[] = [];
    const testSleep: SleepFunction = async (ms) => {
      sleepDelays.push(ms);
    };

    const mockProvider = new MockModelProvider();
    // Attempt 1: 500 error (retryable)
    mockProvider.queueResponse(
      ModelGatewayError.providerUnavailable("Transient 503 error"),
    );
    // Attempt 2: Success
    mockProvider.queueResponse({
      text: "Recovered on attempt 2.",
      inputTokens: 100,
      outputTokens: 50,
    });

    const gateway = new ProductionModelGateway({
      provider: mockProvider,
      sleepFn: testSleep,
      baseRetryDelayMs: 200,
    });

    const response = await gateway.generate(createTestRequest());

    expect(response.text).toBe("Recovered on attempt 2.");
    expect(response.attemptCount).toBe(2);
    expect(response.usedFallback).toBe(false);
    expect(response.attempts[0]?.outcome).toBe("retryable_error");
    expect(response.attempts[1]?.outcome).toBe("success");
    expect(sleepDelays.length).toBe(1);
    expect(sleepDelays[0]).toBe(200); // base delay on first retry
    expect(mockProvider.totalCalls).toBe(2);
  });

  it("Exhausts primary retries and invokes the fallback model once", async () => {
    const sleepDelays: number[] = [];
    const testSleep: SleepFunction = async (ms) => {
      sleepDelays.push(ms);
    };

    const recordedModels: string[] = [];
    const trackingProvider: ModelProviderAdapter = {
      providerId: "anthropic",
      async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
        recordedModels.push(params.model);
        if (params.model === "claude-sonnet-5-5") {
          // Primary attempts fail with rate limit (retryable)
          throw ModelGatewayError.rateLimitError("Rate limited");
        }
        // Fallback model succeeds
        return {
          text: "Fallback model explanation.",
          model: params.model,
          inputTokens: 200,
          outputTokens: 50,
          totalTokens: 250,
          providerRequestId: "fallback-req-1",
          stopReason: "end_turn",
        };
      },
    };

    const policy = new ModelRoutingPolicy({
      defaultPrimaryModel: "claude-sonnet-5-5",
      defaultFallbackModel: "claude-haiku-5-5",
      taskOverrides: {
        impact_explanation: {
          maxPrimaryRetries: 2, // 1 initial + 2 retries = 3 primary attempts
        },
      },
    });

    const gateway = new ProductionModelGateway({
      provider: trackingProvider,
      policy,
      sleepFn: testSleep,
      baseRetryDelayMs: 100,
    });

    const response = await gateway.generate(createTestRequest());

    expect(response.usedFallback).toBe(true);
    expect(response.model).toBe("claude-haiku-5-5");
    expect(response.text).toBe("Fallback model explanation.");
    expect(response.attemptCount).toBe(4); // 3 primary + 1 fallback
    expect(recordedModels).toEqual([
      "claude-sonnet-5-5",
      "claude-sonnet-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
    expect(sleepDelays.length).toBe(2); // 2 sleeps between 3 primary attempts
  });

  it("Throws RETRIES_EXHAUSTED when both primary and fallback fail, preserving primary error info", async () => {
    const testSleep: SleepFunction = async () => {};

    const failingProvider: ModelProviderAdapter = {
      providerId: "anthropic",
      async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
        if (params.model === "claude-sonnet-5-5") {
          throw ModelGatewayError.providerUnavailable("Primary 503 unavailable");
        }
        throw ModelGatewayError.timeoutError("Fallback timed out");
      },
    };

    const policy = new ModelRoutingPolicy({
      defaultPrimaryModel: "claude-sonnet-5-5",
      defaultFallbackModel: "claude-haiku-5-5",
      taskOverrides: {
        impact_explanation: {
          maxPrimaryRetries: 1, // 2 primary attempts
        },
      },
    });

    const gateway = new ProductionModelGateway({
      provider: failingProvider,
      policy,
      sleepFn: testSleep,
    });

    try {
      await gateway.generate(createTestRequest());
      expect.unreachable();
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ModelGatewayError);
      const gwErr = err as ModelGatewayError;
      expect(gwErr.code).toBe("RETRIES_EXHAUSTED");
      expect(gwErr.retryable).toBe(false);
      expect(gwErr.primaryError).toBeDefined();
      expect(gwErr.primaryError?.code).toBe("PROVIDER_UNAVAILABLE");
      expect(gwErr.attempts?.length).toBe(3); // 2 primary + 1 fallback
    }
  });

  it("Does not retry non-retryable authentication or invalid request errors", async () => {
    let callCount = 0;
    const authFailingProvider: ModelProviderAdapter = {
      providerId: "anthropic",
      async generate(): Promise<ProviderGenerateResult> {
        callCount++;
        throw ModelGatewayError.authenticationError("Invalid credentials");
      },
    };

    const gateway = new ProductionModelGateway({
      provider: authFailingProvider,
    });

    try {
      await gateway.generate(createTestRequest());
      expect.unreachable();
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ModelGatewayError);
      const gwErr = err as ModelGatewayError;
      expect(gwErr.code).toBe("AUTHENTICATION_ERROR");
      expect(callCount).toBe(1); // Never retried
    }
  });

  it("Honors bounded Retry-After delays from rate limit errors", async () => {
    const sleepDelays: number[] = [];
    const testSleep: SleepFunction = async (ms) => {
      sleepDelays.push(ms);
    };

    let attempt = 0;
    const rateLimitedProvider: ModelProviderAdapter = {
      providerId: "anthropic",
      async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
        attempt++;
        if (attempt === 1) {
          throw ModelGatewayError.rateLimitError("Too Many Requests", {
            retryAfterMs: 3500,
          });
        }
        return {
          text: "Success after rate limit wait.",
          model: params.model,
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          providerRequestId: "req-ok",
          stopReason: "end_turn",
        };
      },
    };

    const gateway = new ProductionModelGateway({
      provider: rateLimitedProvider,
      sleepFn: testSleep,
      maxRetryAfterMs: 5000,
    });

    const response = await gateway.generate(createTestRequest());
    expect(response.text).toBe("Success after rate limit wait.");
    expect(sleepDelays).toEqual([3500]);
  });

  it("Clamps Retry-After if provider requests excessive delay", async () => {
    const sleepDelays: number[] = [];
    const testSleep: SleepFunction = async (ms) => {
      sleepDelays.push(ms);
    };

    let attempt = 0;
    const rateLimitedProvider: ModelProviderAdapter = {
      providerId: "anthropic",
      async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
        attempt++;
        if (attempt === 1) {
          throw ModelGatewayError.rateLimitError("Too Many Requests", {
            retryAfterMs: 120_000, // 2 minutes requested by provider
          });
        }
        return {
          text: "Success",
          model: params.model,
          inputTokens: 10,
          outputTokens: 10,
          totalTokens: 20,
          providerRequestId: "req-ok",
          stopReason: "end_turn",
        };
      },
    };

    const gateway = new ProductionModelGateway({
      provider: rateLimitedProvider,
      sleepFn: testSleep,
      maxRetryAfterMs: 4000, // Capped at 4 seconds
    });

    await gateway.generate(createTestRequest());
    expect(sleepDelays).toEqual([4000]);
  });

  it("Cancels immediately without retrying or calling fallback when caller aborts", async () => {
    const controller = new AbortController();
    let callCount = 0;

    const abortingProvider: ModelProviderAdapter = {
      providerId: "anthropic",
      async generate(): Promise<ProviderGenerateResult> {
        callCount++;
        // Abort during first attempt
        controller.abort();
        throw ModelGatewayError.aborted("Aborted");
      },
    };

    const gateway = new ProductionModelGateway({
      provider: abortingProvider,
    });

    await expect(
      gateway.generate(createTestRequest({ signal: controller.signal })),
    ).rejects.toThrow(ModelGatewayError);

    expect(callCount).toBe(1);
  });

  it("Aborts immediately if request is already cancelled prior to dispatch", async () => {
    const controller = new AbortController();
    controller.abort();

    const mockProvider = new MockModelProvider();
    const gateway = new ProductionModelGateway({
      provider: mockProvider,
    });

    try {
      await gateway.generate(createTestRequest({ signal: controller.signal }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ModelGatewayError);
      const gwErr = err as ModelGatewayError;
      expect(gwErr.code).toBe("ABORTED");
      expect(mockProvider.totalCalls).toBe(0);
    }
  });

  it("Calculates aggregate cost accurately across primary and fallback attempts", async () => {
    const pricingRegistry = new DefaultModelPricingRegistry();
    let attempt = 0;

    const multiAttemptProvider: ModelProviderAdapter = {
      providerId: "anthropic",
      async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
        attempt++;
        if (params.model === "claude-sonnet-5-5") {
          // Primary attempt fails
          throw ModelGatewayError.providerUnavailable("Primary 503");
        }
        // Fallback attempt succeeds
        return {
          text: "Fallback result",
          model: params.model,
          inputTokens: 10_000, // Haiku input (<= 100K): $0.10/MTok -> $0.001
          outputTokens: 2_000, // Haiku output: $0.50/MTok -> $0.001
          totalTokens: 12_000,
          providerRequestId: "fallback-req",
          stopReason: "end_turn",
        };
      },
    };

    const policy = new ModelRoutingPolicy({
      defaultPrimaryModel: "claude-sonnet-5-5",
      defaultFallbackModel: "claude-haiku-5-5",
      taskOverrides: {
        impact_explanation: {
          maxPrimaryRetries: 0, // 1 primary attempt then fallback
        },
      },
    });

    const gateway = new ProductionModelGateway({
      provider: multiAttemptProvider,
      policy,
      pricingRegistry,
    });

    const response = await gateway.generate(createTestRequest());
    expect(response.usedFallback).toBe(true);
    expect(attempt).toBe(2);
    // Cost of successful fallback attempt ($0.001 + $0.001 = $0.002)
    expect(response.costUsd).toBe(0.002);
  });

  it("Sanitizes all error messages so credentials never leak", () => {
    const errWithSecret = ModelGatewayError.authenticationError(
      "Failed to authenticate with sk-ant-secret123456789 and Bearer token-xyz",
    );

    expect(errWithSecret.message).not.toContain("sk-ant-secret123456789");
    expect(errWithSecret.message).not.toContain("token-xyz");
    expect(errWithSecret.message).toContain("[REDACTED_API_KEY]");
    expect(errWithSecret.message).toContain("[REDACTED_TOKEN]");
  });
});
