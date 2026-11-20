/**
 * @file factory.ts
 * Production factory for creating the Model Gateway.
 *
 * Honors the USE_REAL_LLM flag, delegating to the deterministic MockModelProvider
 * by default for local development, and instantiating AnthropicProviderAdapter
 * when explicitly opted-in with verified credentials.
 */

import type { SecretsClient } from "@fluxora/infrastructure";

import { AnthropicProviderAdapter, type AnthropicMessagesClient } from "./anthropic-adapter.ts";
import { loadModelGatewayConfig } from "./config.ts";
import { ProductionModelGateway, type SleepFunction } from "./gateway.ts";
import { MockModelProvider } from "./mock-gateway.ts";
import { ModelRoutingPolicy, type ModelRoutingPolicyOptions } from "./policy.ts";
import { DefaultModelPricingRegistry, type ModelPricingRegistry } from "./pricing.ts";
import type { ModelGateway, ModelProviderAdapter } from "./types.ts";

export interface ModelGatewayFactoryOptions {
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly secretsClient?: SecretsClient | undefined;
  readonly providerOverride?: ModelProviderAdapter | undefined;
  readonly anthropicClient?: AnthropicMessagesClient | undefined;
  readonly policyOptions?: ModelRoutingPolicyOptions | undefined;
  readonly pricingRegistry?: ModelPricingRegistry | undefined;
  readonly sleepFn?: SleepFunction | undefined;
  readonly baseRetryDelayMs?: number | undefined;
  readonly maxRetryDelayMs?: number | undefined;
}

/**
 * Creates and configures a ModelGateway instance.
 * Defaults to MockModelGateway unless USE_REAL_LLM=true is explicitly set.
 */
export async function createModelGateway(
  options: ModelGatewayFactoryOptions = {},
): Promise<ModelGateway> {
  const config = await loadModelGatewayConfig({
    ...(options.environment !== undefined ? { environment: options.environment } : {}),
    ...(options.secretsClient !== undefined ? { secretsClient: options.secretsClient } : {}),
  });

  const policy = new ModelRoutingPolicy({
    defaultPrimaryModel: config.primaryModel,
    defaultFallbackModel: config.fallbackModel,
    ...options.policyOptions,
  });

  const pricingRegistry =
    options.pricingRegistry ?? new DefaultModelPricingRegistry();

  let provider: ModelProviderAdapter;

  if (options.providerOverride) {
    provider = options.providerOverride;
  } else if (config.useRealLlm) {
    provider = new AnthropicProviderAdapter({
      apiKey: config.anthropicApiKey,
      ...(options.anthropicClient !== undefined ? { client: options.anthropicClient } : {}),
    });
  } else {
    provider = new MockModelProvider();
  }

  return new ProductionModelGateway({
    provider,
    policy,
    pricingRegistry,
    ...(options.sleepFn !== undefined ? { sleepFn: options.sleepFn } : {}),
    ...(options.baseRetryDelayMs !== undefined ? { baseRetryDelayMs: options.baseRetryDelayMs } : {}),
    ...(options.maxRetryDelayMs !== undefined ? { maxRetryDelayMs: options.maxRetryDelayMs } : {}),
  });
}
