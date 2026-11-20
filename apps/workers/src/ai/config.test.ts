/**
 * @file config.test.ts
 * Tests for Model Gateway configuration loading and secret handling.
 */

import type { SecretsClient, SecretValue } from "@fluxora/infrastructure";
import { describe, expect, it } from "vitest";

import { loadModelGatewayConfig } from "./config.ts";
import { ModelGatewayError } from "./errors.ts";
import { CANONICAL_FALLBACK_MODEL, CANONICAL_PRIMARY_MODEL } from "./policy.ts";

describe("loadModelGatewayConfig", () => {
  it("defaults to mock mode without requiring secrets when USE_REAL_LLM is false or unset", async () => {
    const config = await loadModelGatewayConfig({
      environment: {
        USE_REAL_LLM: "false",
      },
    });

    expect(config.useRealLlm).toBe(false);
    expect(config.anthropicApiKey).toBeUndefined();
    expect(config.primaryModel).toBe(CANONICAL_PRIMARY_MODEL);
    expect(config.fallbackModel).toBe(CANONICAL_FALLBACK_MODEL);
  });

  it("fails fast with CONFIGURATION_ERROR when USE_REAL_LLM is true but API key is missing", async () => {
    await expect(
      loadModelGatewayConfig({
        environment: {
          USE_REAL_LLM: "true",
          ANTHROPIC_API_KEY: "",
        },
      }),
    ).rejects.toThrow(ModelGatewayError);

    try {
      await loadModelGatewayConfig({
        environment: {
          USE_REAL_LLM: "true",
        },
      });
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ModelGatewayError);
      const gwErr = err as ModelGatewayError;
      expect(gwErr.code).toBe("CONFIGURATION_ERROR");
      expect(gwErr.retryable).toBe(false);
    }
  });

  it("loads API key from SecretsClient when USE_REAL_LLM is true", async () => {
    const fakeSecretsClient: SecretsClient = {
      async getSecret(name: string): Promise<SecretValue> {
        if (name === "ANTHROPIC_API_KEY") {
          return { value: "sk-ant-test-secret-key" };
        }
        throw new Error(`Secret ${name} not found`);
      },
    };

    const config = await loadModelGatewayConfig({
      environment: {
        USE_REAL_LLM: "true",
      },
      secretsClient: fakeSecretsClient,
    });

    expect(config.useRealLlm).toBe(true);
    expect(config.anthropicApiKey).toBe("sk-ant-test-secret-key");
  });

  it("respects custom model names configured in environment", async () => {
    const config = await loadModelGatewayConfig({
      environment: {
        USE_REAL_LLM: "false",
        ANTHROPIC_PRIMARY_MODEL: "claude-3-opus-20240229",
        ANTHROPIC_FALLBACK_MODEL: "claude-3-haiku-20240307",
      },
    });

    expect(config.primaryModel).toBe("claude-3-opus-20240229");
    expect(config.fallbackModel).toBe("claude-3-haiku-20240307");
  });
});
