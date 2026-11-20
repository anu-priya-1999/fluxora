/**
 * @file factory.test.ts
 * Tests for createModelGateway factory and provider wiring.
 */

import type { SecretsClient, SecretValue } from "@fluxora/infrastructure";
import { describe, expect, it } from "vitest";

import { createModelGateway } from "./factory.ts";
import { ProductionModelGateway } from "./gateway.ts";
import { MockModelProvider } from "./mock-gateway.ts";

describe("createModelGateway", () => {
  it("creates a MockModelProvider by default for local development", async () => {
    const gateway = await createModelGateway({
      environment: {
        USE_REAL_LLM: "false",
      },
    });

    expect(gateway).toBeInstanceOf(ProductionModelGateway);
    const prodGw = gateway as ProductionModelGateway;
    expect(prodGw.provider.providerId).toBe("mock");

    const response = await gateway.generate({
      taskType: "impact_explanation",
      promptVersion: "v1",
      messages: [{ role: "user", content: "Test prompt" }],
    });

    expect(response.isMock).toBe(true);
    expect(response.provider).toBe("mock");
  });

  it("wires an Anthropic provider when USE_REAL_LLM is true and API key is present", async () => {
    const fakeSecretsClient: SecretsClient = {
      async getSecret(name: string): Promise<SecretValue> {
        if (name === "ANTHROPIC_API_KEY") {
          return { value: "sk-ant-test-key-12345" };
        }
        throw new Error("Secret not found");
      },
    };

    const gateway = await createModelGateway({
      environment: {
        USE_REAL_LLM: "true",
      },
      secretsClient: fakeSecretsClient,
    });

    expect(gateway).toBeInstanceOf(ProductionModelGateway);
    const prodGw = gateway as ProductionModelGateway;
    expect(prodGw.provider.providerId).toBe("anthropic");
  });

  it("respects providerOverride when supplied", async () => {
    const customProvider = new MockModelProvider({
      cannedResponseText: "Custom injected provider response.",
    });

    const gateway = await createModelGateway({
      providerOverride: customProvider,
    });

    const response = await gateway.generate({
      taskType: "impact_explanation",
      promptVersion: "v1",
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(response.text).toBe("Custom injected provider response.");
  });
});
