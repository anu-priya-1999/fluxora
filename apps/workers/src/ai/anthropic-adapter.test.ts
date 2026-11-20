/**
 * @file anthropic-adapter.test.ts
 * Tests for the Anthropic Claude provider adapter using an injected SDK boundary.
 */

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import {
  AnthropicProviderAdapter,
  type AnthropicMessagesClient,
} from "./anthropic-adapter.ts";
import { ModelGatewayError } from "./errors.ts";

function createFakeMessage(options: {
  text?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  id?: string;
  stopReason?: string;
  emptyContent?: boolean;
}): Anthropic.Message {
  return {
    id: options.id ?? "msg_123456",
    type: "message",
    role: "assistant",
    content: options.emptyContent
      ? []
      : [
          {
            type: "text",
            text: options.text ?? "Verified explanation response.",
            citations: null,
          },
        ],
    model: options.model ?? "claude-sonnet-5-5",
    stop_reason: (options.stopReason ?? "end_turn") as Anthropic.Message["stop_reason"],
    stop_sequence: null,
    usage: {
      input_tokens: options.inputTokens ?? 120,
      output_tokens: options.outputTokens ?? 45,
    },
  } as Anthropic.Message;
}

describe("AnthropicProviderAdapter", () => {
  it("normalizes provider text and usage correctly from fake SDK client", async () => {
    let capturedParams: Anthropic.MessageCreateParamsNonStreaming | undefined;

    const fakeClient: AnthropicMessagesClient = {
      messages: {
        async create(params) {
          capturedParams = params;
          return createFakeMessage({
            text: "Impact: Payment service degraded.",
            inputTokens: 500,
            outputTokens: 150,
            id: "msg_test_001",
            stopReason: "end_turn",
          });
        },
      },
    };

    const adapter = new AnthropicProviderAdapter({ client: fakeClient });

    const result = await adapter.generate({
      model: "claude-sonnet-5-5",
      systemInstruction: "You are an architecture explainer.",
      messages: [{ role: "user", content: "Explain impact." }],
      maxTokens: 1024,
      timeoutMs: 5000,
    });

    expect(result.text).toBe("Impact: Payment service degraded.");
    expect(result.inputTokens).toBe(500);
    expect(result.outputTokens).toBe(150);
    expect(result.totalTokens).toBe(650);
    expect(result.providerRequestId).toBe("msg_test_001");
    expect(result.stopReason).toBe("end_turn");
    expect(result.model).toBe("claude-sonnet-5-5");

    expect(capturedParams?.system).toBe("You are an architecture explainer.");
    expect(capturedParams?.max_tokens).toBe(1024);
    expect(capturedParams?.messages).toEqual([
      { role: "user", content: "Explain impact." },
    ]);
  });

  it("throws INVALID_RESPONSE when provider returns empty content blocks", async () => {
    const fakeClient: AnthropicMessagesClient = {
      messages: {
        async create() {
          return createFakeMessage({ emptyContent: true });
        },
      },
    };

    const adapter = new AnthropicProviderAdapter({ client: fakeClient });

    await expect(
      adapter.generate({
        model: "claude-sonnet-5-5",
        messages: [{ role: "user", content: "Test" }],
        maxTokens: 100,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(ModelGatewayError);

    try {
      await adapter.generate({
        model: "claude-sonnet-5-5",
        messages: [{ role: "user", content: "Test" }],
        maxTokens: 100,
        timeoutMs: 1000,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ModelGatewayError);
      const gwErr = err as ModelGatewayError;
      expect(gwErr.code).toBe("INVALID_RESPONSE");
      expect(gwErr.retryable).toBe(false);
    }
  });

  it("maps AuthenticationError to non-retryable AUTHENTICATION_ERROR and sanitizes message", async () => {
    const fakeClient: AnthropicMessagesClient = {
      messages: {
        async create() {
          throw new Anthropic.AuthenticationError(
            401,
            { message: "Invalid API key: sk-ant-secret123456789" },
            "Invalid key",
            new Headers(),
          );
        },
      },
    };

    const adapter = new AnthropicProviderAdapter({ client: fakeClient });

    try {
      await adapter.generate({
        model: "claude-sonnet-5-5",
        messages: [{ role: "user", content: "Test" }],
        maxTokens: 100,
        timeoutMs: 1000,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ModelGatewayError);
      const gwErr = err as ModelGatewayError;
      expect(gwErr.code).toBe("AUTHENTICATION_ERROR");
      expect(gwErr.retryable).toBe(false);
      // Ensure API key is sanitized
      expect(gwErr.message).not.toContain("sk-ant-secret123456789");
      expect(gwErr.message).toContain("[REDACTED_API_KEY]");
    }
  });

  it("maps RateLimitError to retryable RATE_LIMIT_ERROR and parses Retry-After header", async () => {
    const headers = new Headers();
    headers.set("retry-after", "2.5");

    const fakeClient: AnthropicMessagesClient = {
      messages: {
        async create() {
          throw new Anthropic.RateLimitError(
            429,
            { message: "Rate limit exceeded" },
            "Rate limit",
            headers,
          );
        },
      },
    };

    const adapter = new AnthropicProviderAdapter({ client: fakeClient });

    try {
      await adapter.generate({
        model: "claude-sonnet-5-5",
        messages: [{ role: "user", content: "Test" }],
        maxTokens: 100,
        timeoutMs: 1000,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ModelGatewayError);
      const gwErr = err as ModelGatewayError;
      expect(gwErr.code).toBe("RATE_LIMIT_ERROR");
      expect(gwErr.retryable).toBe(true);
      expect(gwErr.statusCode).toBe(429);
      expect(gwErr.retryAfterMs).toBe(2500);
    }
  });

  it("maps 500 server error to retryable PROVIDER_UNAVAILABLE", async () => {
    const fakeClient: AnthropicMessagesClient = {
      messages: {
        async create() {
          throw new Anthropic.InternalServerError(
            500,
            { message: "Internal server error" },
            "Server error",
            new Headers(),
          );
        },
      },
    };

    const adapter = new AnthropicProviderAdapter({ client: fakeClient });

    try {
      await adapter.generate({
        model: "claude-sonnet-5-5",
        messages: [{ role: "user", content: "Test" }],
        maxTokens: 100,
        timeoutMs: 1000,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ModelGatewayError);
      const gwErr = err as ModelGatewayError;
      expect(gwErr.code).toBe("PROVIDER_UNAVAILABLE");
      expect(gwErr.retryable).toBe(true);
      expect(gwErr.statusCode).toBe(500);
    }
  });

  it("handles caller cancellation cleanly with ABORTED error", async () => {
    const controller = new AbortController();
    const fakeClient: AnthropicMessagesClient = {
      messages: {
        async create() {
          // Never completes until aborted
          return new Promise((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          });
        },
      },
    };

    const adapter = new AnthropicProviderAdapter({ client: fakeClient });

    const promise = adapter.generate({
      model: "claude-sonnet-5-5",
      messages: [{ role: "user", content: "Test" }],
      maxTokens: 100,
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    controller.abort();

    await expect(promise).rejects.toThrow(ModelGatewayError);
    try {
      await promise;
    } catch (err) {
      const gwErr = err as ModelGatewayError;
      expect(gwErr.code).toBe("ABORTED");
      expect(gwErr.retryable).toBe(false);
    }
  });

  it("handles attempt timeout with TIMEOUT_ERROR", async () => {
    const fakeClient: AnthropicMessagesClient = {
      messages: {
        async create(_params, options) {
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(new Error("timeout abort"));
            });
          });
        },
      },
    };

    const adapter = new AnthropicProviderAdapter({ client: fakeClient });

    try {
      await adapter.generate({
        model: "claude-sonnet-5-5",
        messages: [{ role: "user", content: "Test" }],
        maxTokens: 100,
        timeoutMs: 20, // 20ms timeout
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ModelGatewayError);
      const gwErr = err as ModelGatewayError;
      expect(gwErr.code).toBe("TIMEOUT_ERROR");
      expect(gwErr.retryable).toBe(true);
    }
  });
});
