/**
 * @file config.ts
 * Environment and secrets configuration loader for the Model Gateway.
 *
 * Implements strict secret acquisition via SecretsClient and validates required
 * configurations when real LLM mode is enabled.
 */

import type { SecretsClient } from "@fluxora/infrastructure";
import { EnvSecretsProvider } from "@fluxora/infrastructure";

import { ModelGatewayError } from "./errors.ts";
import { CANONICAL_FALLBACK_MODEL, CANONICAL_PRIMARY_MODEL } from "./policy.ts";

export interface ModelGatewayConfig {
  readonly useRealLlm: boolean;
  readonly anthropicApiKey?: string | undefined;
  readonly primaryModel: string;
  readonly fallbackModel: string;
}

export interface LoadModelGatewayConfigOptions {
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly secretsClient?: SecretsClient | undefined;
}

/**
 * Resolves the Model Gateway configuration from environment and secrets.
 * Fails fast with a sanitized configuration error if real LLM mode is enabled without an API key.
 */
export async function loadModelGatewayConfig(
  options: LoadModelGatewayConfigOptions = {},
): Promise<ModelGatewayConfig> {
  const env = options.environment ?? process.env;
  const useRealLlm = env.USE_REAL_LLM === "true";

  const primaryModel =
    env.ANTHROPIC_PRIMARY_MODEL?.trim() || CANONICAL_PRIMARY_MODEL;
  const fallbackModel =
    env.ANTHROPIC_FALLBACK_MODEL?.trim() || CANONICAL_FALLBACK_MODEL;

  if (!useRealLlm) {
    return {
      useRealLlm: false,
      primaryModel,
      fallbackModel,
    };
  }

  // Real LLM mode: API key must be present in secrets or env
  const secretsClient =
    options.secretsClient ?? new EnvSecretsProvider(env);

  let apiKey: string | undefined;

  try {
    const secret = await secretsClient.getSecret("ANTHROPIC_API_KEY");
    apiKey = secret.value?.trim();
  } catch {
    // Secret provider failed or secret is not present
    apiKey = env.ANTHROPIC_API_KEY?.trim();
  }

  if (!apiKey || apiKey.length === 0) {
    throw ModelGatewayError.configurationError(
      "Real LLM mode is enabled (USE_REAL_LLM=true) but ANTHROPIC_API_KEY is not configured.",
      {
        provider: "anthropic",
        model: primaryModel,
      },
    );
  }

  return {
    useRealLlm: true,
    anthropicApiKey: apiKey,
    primaryModel,
    fallbackModel,
  };
}
