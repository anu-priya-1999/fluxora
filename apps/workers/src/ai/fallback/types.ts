/**
 * @file types.ts
 * Contracts and constants for Deterministic Fallback Explanations (Phase 9 Step 66).
 */

import type { AIExplanationOutputDto } from "@fluxora/shared-types";

export const IMPACT_FALLBACK_PROMPT_VERSION = "impact-explain-fallback-v1" as const;
export const SIMULATION_FALLBACK_PROMPT_VERSION = "simulation-narrate-fallback-v1" as const;

export type FallbackTriggerReason =
  | "provider_unavailable"
  | "provider_timeout"
  | "rate_limit_exhausted"
  | "retries_exhausted"
  | "invalid_provider_response"
  | "validation_failed_after_retries";

export type FallbackEligibility =
  | { readonly eligible: true; readonly reason: FallbackTriggerReason }
  | { readonly eligible: false };

export interface FallbackGenerationResult {
  readonly output: AIExplanationOutputDto;
  readonly schemaVersion: string;
  readonly promptVersion: string;
  readonly abstained: boolean;
  readonly usedEvidenceIds: readonly string[];
  readonly omittedWithoutEvidenceCount: number;
}
