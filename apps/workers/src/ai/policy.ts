/**
 * @file policy.ts
 * Task-aware model selection, timeout budgets, and fallback policies.
 *
 * Implements deterministic routing policies according to Fluxora architecture
 * specifications for impact explanation, simulation narration, and chat queries.
 */

import type { ModelTaskType } from "./types.ts";

export interface TaskPolicy {
  readonly primaryModel: string;
  readonly fallbackModel: string;
  readonly timeoutMs: number;
  readonly maxTokens: number;
  readonly maxPrimaryRetries: number;
}

export interface ModelRoutingPolicyOptions {
  readonly defaultPrimaryModel?: string;
  readonly defaultFallbackModel?: string;
  readonly taskOverrides?: Partial<Record<ModelTaskType, Partial<TaskPolicy>>>;
  readonly minAllowedTimeoutMs?: number;
  readonly maxAllowedTimeoutMs?: number;
}

export const CANONICAL_PRIMARY_MODEL = "claude-sonnet-5-5";
export const CANONICAL_FALLBACK_MODEL = "claude-haiku-5-5";

export const DEFAULT_TASK_POLICIES: Readonly<Record<ModelTaskType, Omit<TaskPolicy, "primaryModel" | "fallbackModel">>> = Object.freeze({
  impact_explanation: {
    timeoutMs: 20_000, // 20s per architectural guidance
    maxTokens: 1024,
    maxPrimaryRetries: 2,
  },
  simulation_narration: {
    timeoutMs: 30_000, // 30s sensible bounded default
    maxTokens: 2048,
    maxPrimaryRetries: 2,
  },
  chat_query: {
    timeoutMs: 45_000, // 45s per architectural guidance
    maxTokens: 4096,
    maxPrimaryRetries: 2,
  },
});

export class ModelRoutingPolicy {
  private readonly defaultPrimaryModel: string;
  private readonly defaultFallbackModel: string;
  private readonly taskPolicies: Map<ModelTaskType, TaskPolicy>;
  readonly minAllowedTimeoutMs: number;
  readonly maxAllowedTimeoutMs: number;

  constructor(options: ModelRoutingPolicyOptions = {}) {
    this.defaultPrimaryModel = options.defaultPrimaryModel ?? CANONICAL_PRIMARY_MODEL;
    this.defaultFallbackModel = options.defaultFallbackModel ?? CANONICAL_FALLBACK_MODEL;
    this.minAllowedTimeoutMs = options.minAllowedTimeoutMs ?? 1_000;
    this.maxAllowedTimeoutMs = options.maxAllowedTimeoutMs ?? 60_000;

    this.taskPolicies = new Map<ModelTaskType, TaskPolicy>();

    for (const [task, defaults] of Object.entries(DEFAULT_TASK_POLICIES) as [ModelTaskType, (typeof DEFAULT_TASK_POLICIES)[ModelTaskType]][]) {
      const override = options.taskOverrides?.[task];
      this.taskPolicies.set(task, {
        primaryModel: override?.primaryModel ?? this.defaultPrimaryModel,
        fallbackModel: override?.fallbackModel ?? this.defaultFallbackModel,
        timeoutMs: override?.timeoutMs ?? defaults.timeoutMs,
        maxTokens: override?.maxTokens ?? defaults.maxTokens,
        maxPrimaryRetries: override?.maxPrimaryRetries ?? defaults.maxPrimaryRetries,
      });
    }
  }

  getPolicy(taskType: ModelTaskType): TaskPolicy {
    const policy = this.taskPolicies.get(taskType);
    if (!policy) {
      // Deterministic fallback policy if unknown task type is supplied
      return {
        primaryModel: this.defaultPrimaryModel,
        fallbackModel: this.defaultFallbackModel,
        timeoutMs: 20_000,
        maxTokens: 1024,
        maxPrimaryRetries: 2,
      };
    }
    return policy;
  }

  /**
   * Resolves the request timeout in milliseconds, enforcing safety bounds.
   */
  resolveTimeoutMs(taskType: ModelTaskType, requestedTimeoutMs?: number): number {
    const policy = this.getPolicy(taskType);
    if (requestedTimeoutMs === undefined || Number.isNaN(requestedTimeoutMs)) {
      return policy.timeoutMs;
    }
    // Clamp within safety boundaries
    return Math.max(
      this.minAllowedTimeoutMs,
      Math.min(this.maxAllowedTimeoutMs, requestedTimeoutMs),
    );
  }

  /**
   * Resolves the maximum output tokens for a request.
   */
  resolveMaxTokens(taskType: ModelTaskType, requestedMaxTokens?: number): number {
    const policy = this.getPolicy(taskType);
    if (
      requestedMaxTokens === undefined ||
      Number.isNaN(requestedMaxTokens) ||
      requestedMaxTokens <= 0
    ) {
      return policy.maxTokens;
    }
    return requestedMaxTokens;
  }
}
