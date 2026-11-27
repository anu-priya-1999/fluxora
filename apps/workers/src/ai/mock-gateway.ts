/**
 * @file mock-gateway.ts
 * Deterministic Mock Model Provider and Gateway for offline local development and CI testing.
 *
 * Produces deterministic canned responses without external network requests or API keys,
 * without fabricating real provider usage or cost.
 */

import { ModelGatewayError } from "./errors.ts";
import type {
  ModelGateway,
  ModelGatewayRequest,
  ModelGatewayResponse,
  ModelProviderAdapter,
  ProviderGenerateParams,
  ProviderGenerateResult,
} from "./types.ts";

export interface MockModelProviderOptions {
  /**
   * Queue of custom results or errors to emit on successive generate calls.
   * If an item is an Error, generate throws it. If undefined or null, default canned response is used.
   */
  readonly responseQueue?: ReadonlyArray<Partial<ProviderGenerateResult> | Error> | undefined;
  /**
   * Static canned response text override.
   */
  readonly cannedResponseText?: string | undefined;
}

export class MockModelProvider implements ModelProviderAdapter {
  readonly providerId = "mock";
  private responseQueue: Array<Partial<ProviderGenerateResult> | Error>;
  private callCount = 0;
  private readonly cannedResponseText?: string | undefined;

  constructor(options: MockModelProviderOptions = {}) {
    this.responseQueue = options.responseQueue ? [...options.responseQueue] : [];
    this.cannedResponseText = options.cannedResponseText;
  }

  get totalCalls(): number {
    return this.callCount;
  }

  queueResponse(item: Partial<ProviderGenerateResult> | Error): void {
    this.responseQueue.push(item);
  }

  async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
    if (params.signal?.aborted) {
      throw ModelGatewayError.aborted("Mock provider call was aborted by caller signal", {
        provider: this.providerId,
        model: params.model,
      });
    }

    this.callCount++;

    if (this.responseQueue.length > 0) {
      const next = this.responseQueue.shift();
      if (next instanceof Error) {
        throw next;
      }
      if (next) {
        return {
          text: next.text ?? (next.toolUses && next.toolUses.length > 0 ? "" : this.buildDefaultText(params)),
          ...(next.toolUses && next.toolUses.length > 0 ? { toolUses: next.toolUses } : {}),
          model: next.model ?? params.model,
          inputTokens: next.inputTokens ?? null,
          outputTokens: next.outputTokens ?? null,
          totalTokens: next.totalTokens ?? null,
          providerRequestId: next.providerRequestId ?? `mock-req-${this.callCount}`,
          stopReason: next.stopReason ?? (next.toolUses && next.toolUses.length > 0 ? "tool_use" : "end_turn"),
        };
      }
    }

    return {
      text: this.cannedResponseText ?? this.buildDefaultText(params),
      model: params.model,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      providerRequestId: `mock-req-${this.callCount}`,
      stopReason: "end_turn",
    };
  }

  private buildDefaultText(params: ProviderGenerateParams): string {
    const lastUserMessage = [...params.messages]
      .reverse()
      .find((m) => m.role === "user");

    let rawExcerpt = "no content";
    if (lastUserMessage) {
      if (lastUserMessage.content.length > 0) {
        rawExcerpt = lastUserMessage.content;
      } else if (lastUserMessage.blocks && lastUserMessage.blocks.length > 0) {
        const textBlock = lastUserMessage.blocks.find((b) => b.type === "text");
        const toolResultBlock = lastUserMessage.blocks.find((b) => b.type === "tool_result");
        rawExcerpt = textBlock?.text ?? toolResultBlock?.content ?? "content blocks";
      }
    }

    const excerpt = rawExcerpt.slice(0, 32).trim();

    return `[MOCK_OUTPUT] Model: ${params.model}. Processed prompt excerpt: "${excerpt}".`;
  }
}

/**
 * Direct standalone MockModelGateway implementation.
 */
export class MockModelGateway implements ModelGateway {
  private readonly provider: MockModelProvider;

  constructor(provider = new MockModelProvider()) {
    this.provider = provider;
  }

  get mockProvider(): MockModelProvider {
    return this.provider;
  }

  async generate(request: ModelGatewayRequest): Promise<ModelGatewayResponse> {
    const startTime = Date.now();
    const result = await this.provider.generate({
      model: "mock-model",
      systemInstruction: request.systemInstruction,
      messages: request.messages,
      ...(request.tools ? { tools: request.tools } : {}),
      maxTokens: request.maxTokens ?? 1024,
      timeoutMs: request.timeoutMs ?? 1000,
      signal: request.signal,
    });
    const latencyMs = Date.now() - startTime;

    return {
      text: result.text,
      ...(result.toolUses && result.toolUses.length > 0 ? { toolUses: result.toolUses } : {}),
      provider: "mock",
      model: result.model,
      taskType: request.taskType,
      promptVersion: request.promptVersion,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.totalTokens,
      costUsd: null,
      latencyMs,
      attemptCount: 1,
      usedFallback: false,
      providerRequestId: result.providerRequestId,
      stopReason: result.stopReason,
      isMock: true,
      attempts: [
        {
          attemptNumber: 1,
          model: result.model,
          isFallback: false,
          latencyMs,
          outcome: "success",
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: null,
          providerRequestId: result.providerRequestId,
        },
      ],
    };
  }
}
