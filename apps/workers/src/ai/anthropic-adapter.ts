/**
 * @file anthropic-adapter.ts
 * Anthropic Claude provider adapter for the Fluxora AI Model Gateway.
 *
 * Implements communication with Anthropic's Messages API using the official SDK,
 * normalizing response fields, extracting token usage, and mapping errors to typed ModelGatewayError.
 */

import Anthropic from "@anthropic-ai/sdk";

import { ModelGatewayError, sanitizeErrorMessage } from "./errors.ts";
import type {
  ModelMessage,
  ModelProviderAdapter,
  ModelToolUseBlock,
  ProviderGenerateParams,
  ProviderGenerateResult,
} from "./types.ts";

export interface AnthropicMessagesClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal; timeout?: number },
    ): Promise<Anthropic.Message>;
  };
}

export interface AnthropicProviderAdapterOptions {
  readonly apiKey?: string | undefined;
  readonly client?: AnthropicMessagesClient | undefined;
}

export class AnthropicProviderAdapter implements ModelProviderAdapter {
  readonly providerId = "anthropic";
  private readonly client: AnthropicMessagesClient;

  constructor(options: AnthropicProviderAdapterOptions) {
    if (options.client) {
      this.client = options.client;
    } else {
      if (!options.apiKey) {
        throw ModelGatewayError.configurationError(
          "AnthropicProviderAdapter requires an apiKey when client is not injected.",
          { provider: this.providerId },
        );
      }
      this.client = new Anthropic({
        apiKey: options.apiKey,
        maxRetries: 0, // Retries are handled authoritatively by ModelGateway resilience layer
      });
    }
  }

  async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
    if (params.signal?.aborted) {
      throw ModelGatewayError.aborted("Attempt was aborted before invocation", {
        provider: this.providerId,
        model: params.model,
      });
    }

    const abortController = new AbortController();
    let timeoutId: NodeJS.Timeout | undefined;

    // Handle caller cancellation
    const onCallerAbort = (): void => {
      abortController.abort(params.signal?.reason);
    };

    if (params.signal) {
      params.signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    // Set bounded attempt timeout
    if (params.timeoutMs > 0 && params.timeoutMs < Number.POSITIVE_INFINITY) {
      timeoutId = setTimeout(() => {
        abortController.abort(new Error(`Attempt timed out after ${params.timeoutMs}ms`));
      }, params.timeoutMs);
    }

    try {
      const messages: Anthropic.MessageParam[] = params.messages.map((msg) =>
        this.toAnthropicMessage(msg),
      );

      const requestPayload: Anthropic.MessageCreateParamsNonStreaming = {
        model: params.model,
        max_tokens: params.maxTokens,
        messages,
      };

      if (params.systemInstruction) {
        requestPayload.system = params.systemInstruction;
      }

      if (params.tools && params.tools.length > 0) {
        requestPayload.tools = params.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: {
            type: "object" as const,
            properties: tool.inputSchema.properties,
            ...(tool.inputSchema.required
              ? { required: [...tool.inputSchema.required] }
              : {}),
          },
        }));
      }

      const response = await this.client.messages.create(requestPayload, {
        signal: abortController.signal,
        timeout: params.timeoutMs,
      });

      // Extract text content and tool_use blocks safely
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === "text",
      );
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );

      if (textBlocks.length === 0 && toolUseBlocks.length === 0) {
        throw ModelGatewayError.invalidResponse(
          "Anthropic provider returned empty or non-text content blocks.",
          {
            provider: this.providerId,
            model: params.model,
          },
        );
      }

      const fullText = textBlocks.map((b) => b.text).join("");
      const toolUses: ModelToolUseBlock[] = toolUseBlocks.map((block) => ({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input:
          typeof block.input === "object" &&
          block.input !== null &&
          !Array.isArray(block.input)
            ? (block.input as Record<string, unknown>)
            : {},
      }));

      // Extract reported usage
      const inputTokens =
        typeof response.usage?.input_tokens === "number"
          ? response.usage.input_tokens
          : null;
      const outputTokens =
        typeof response.usage?.output_tokens === "number"
          ? response.usage.output_tokens
          : null;
      const totalTokens =
        inputTokens !== null && outputTokens !== null
          ? inputTokens + outputTokens
          : null;

      const providerRequestId =
        typeof response.id === "string" && response.id.length > 0
          ? response.id
          : null;

      const stopReason =
        typeof response.stop_reason === "string"
          ? response.stop_reason
          : null;

      return {
        text: fullText,
        ...(toolUses.length > 0 ? { toolUses } : {}),
        model: response.model || params.model,
        inputTokens,
        outputTokens,
        totalTokens,
        providerRequestId,
        stopReason,
      };
    } catch (error: unknown) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }

      // If already a ModelGatewayError, rethrow
      if (error instanceof ModelGatewayError) {
        throw error;
      }

      // Check if aborted by caller or timeout
      if (params.signal?.aborted) {
        throw ModelGatewayError.aborted("Request was aborted by caller", {
          provider: this.providerId,
          model: params.model,
          cause: error,
        });
      }

      if (abortController.signal.aborted) {
        throw ModelGatewayError.timeoutError(
          `Request attempt timed out after ${params.timeoutMs}ms`,
          {
            provider: this.providerId,
            model: params.model,
            cause: error,
          },
        );
      }

      throw this.mapAnthropicError(error, params.model);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (params.signal) {
        params.signal.removeEventListener("abort", onCallerAbort);
      }
    }
  }

  private toAnthropicMessage(msg: ModelMessage): Anthropic.MessageParam {
    if (!msg.blocks || msg.blocks.length === 0) {
      return {
        role: msg.role,
        content: msg.content,
      };
    }

    const blocks: Array<
      | Anthropic.TextBlockParam
      | Anthropic.ToolUseBlockParam
      | Anthropic.ToolResultBlockParam
    > = msg.blocks.map((block) => {
      if (block.type === "text") {
        return {
          type: "text",
          text: block.text,
        };
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        };
      }
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError !== undefined ? { is_error: block.isError } : {}),
      };
    });

    return {
      role: msg.role,
      content: blocks,
    };
  }

  private mapAnthropicError(error: unknown, model: string): ModelGatewayError {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const sanitized = sanitizeErrorMessage(rawMessage);

    if (error instanceof Anthropic.AuthenticationError) {
      return ModelGatewayError.authenticationError(
        `Anthropic authentication failed: ${sanitized}`,
        {
          provider: this.providerId,
          model,
          statusCode: error.status,
          cause: error,
        },
      );
    }

    if (error instanceof Anthropic.PermissionDeniedError) {
      return ModelGatewayError.authenticationError(
        `Anthropic permission denied: ${sanitized}`,
        {
          provider: this.providerId,
          model,
          statusCode: error.status,
          cause: error,
        },
      );
    }

    if (error instanceof Anthropic.RateLimitError) {
      const retryAfterMs = this.parseRetryAfter(error);
      return ModelGatewayError.rateLimitError(
        `Anthropic rate limit exceeded: ${sanitized}`,
        {
          provider: this.providerId,
          model,
          statusCode: error.status ?? 429,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          cause: error,
        },
      );
    }

    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      return ModelGatewayError.timeoutError(
        `Anthropic connection timed out: ${sanitized}`,
        {
          provider: this.providerId,
          model,
          cause: error,
        },
      );
    }

    if (error instanceof Anthropic.InternalServerError) {
      return ModelGatewayError.providerUnavailable(
        `Anthropic internal server error: ${sanitized}`,
        {
          provider: this.providerId,
          model,
          statusCode: error.status ?? 500,
          cause: error,
        },
      );
    }

    if (error instanceof Anthropic.APIConnectionError) {
      return ModelGatewayError.providerUnavailable(
        `Anthropic network connection failed: ${sanitized}`,
        {
          provider: this.providerId,
          model,
          cause: error,
        },
      );
    }

    if (error instanceof Anthropic.APIError) {
      const status = error.status ?? 500;
      if (status >= 500) {
        return ModelGatewayError.providerUnavailable(
          `Anthropic server error (${status}): ${sanitized}`,
          {
            provider: this.providerId,
            model,
            statusCode: status,
            cause: error,
          },
        );
      }

      return ModelGatewayError.invalidResponse(
        `Anthropic API request failed (${status}): ${sanitized}`,
        {
          provider: this.providerId,
          model,
          statusCode: status,
          cause: error,
        },
      );
    }

    if (
      error instanceof TypeError ||
      error instanceof ReferenceError ||
      error instanceof RangeError ||
      error instanceof SyntaxError ||
      error instanceof EvalError ||
      error instanceof URIError
    ) {
      return ModelGatewayError.internalError(
        `Internal error in Anthropic adapter (${error.name}): ${sanitized}`,
        {
          provider: this.providerId,
          model,
          cause: error,
        },
      );
    }

    const errCode =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (errCode === "ETIMEDOUT" || errCode === "UND_ERR_CONNECT_TIMEOUT") {
      return ModelGatewayError.timeoutError(
        `Anthropic transport timed out (${String(errCode)}): ${sanitized}`,
        {
          provider: this.providerId,
          model,
          cause: error,
        },
      );
    }
    if (
      typeof errCode === "string" &&
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "ENOTFOUND",
        "EAI_AGAIN",
        "EPIPE",
        "UND_ERR_SOCKET",
        "EHOSTUNREACH",
        "ENETUNREACH",
      ].includes(errCode)
    ) {
      return ModelGatewayError.providerUnavailable(
        `Anthropic transport error (${errCode}): ${sanitized}`,
        {
          provider: this.providerId,
          model,
          cause: error,
        },
      );
    }

    return ModelGatewayError.internalError(
      `Unclassified adapter error: ${sanitized}`,
      {
        provider: this.providerId,
        model,
        cause: error,
      },
    );
  }

  private parseRetryAfter(error: unknown): number | undefined {
    try {
      if (typeof error === "object" && error !== null && "headers" in error) {
        const headers = (error as { headers?: unknown }).headers;
        if (!headers) {
          return undefined;
        }

        let rawHeader: string | null | undefined;
        if (typeof (headers as { get?: (name: string) => string | null }).get === "function") {
          rawHeader = (headers as { get: (name: string) => string | null }).get("retry-after");
        } else if (typeof headers === "object") {
          const obj = headers as Record<string, string | string[] | undefined>;
          const val = obj["retry-after"] ?? obj["Retry-After"];
          rawHeader = Array.isArray(val) ? val[0] : val;
        }

        if (typeof rawHeader === "string") {
          const seconds = Number.parseFloat(rawHeader);
          if (!Number.isNaN(seconds) && seconds > 0) {
            return Math.round(seconds * 1000);
          }
        }
      }
    } catch {
      // Ignore header parsing issues
    }
    return undefined;
  }
}
