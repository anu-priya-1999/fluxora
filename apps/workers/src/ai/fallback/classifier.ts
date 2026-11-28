/**
 * @file classifier.ts
 * Failure classification for deterministic fallback eligibility (Phase 9 Step 66).
 *
 * Ensures fallback is invoked ONLY at terminal, eligible transient provider/validation
 * failure boundaries and NEVER masks tenant authorization, ownership, invalid input,
 * authentication, configuration, policy/security rejections, caller cancellations,
 * mixed failure histories, or programming errors.
 */

import { ModelGatewayError, type ModelGatewayErrorCode } from "../errors.ts";
import type { FallbackEligibility, FallbackTriggerReason } from "./types.ts";

const MAX_ERROR_TRAVERSAL_DEPTH = 10;

const ELIGIBLE_DIRECT_CODES: ReadonlyMap<ModelGatewayErrorCode, FallbackTriggerReason> =
  new Map([
    ["PROVIDER_UNAVAILABLE", "provider_unavailable"],
    ["TIMEOUT_ERROR", "provider_timeout"],
    ["RATE_LIMIT_ERROR", "rate_limit_exhausted"],
    ["INVALID_RESPONSE", "invalid_provider_response"],
  ]);

const EXCLUDED_DIRECT_CODES: ReadonlySet<ModelGatewayErrorCode> = new Set([
  "AUTHENTICATION_ERROR",
  "CONFIGURATION_ERROR",
  "ABORTED",
  "INTERNAL_ERROR",
]);

function isProgrammingError(value: unknown): boolean {
  return (
    value instanceof TypeError ||
    value instanceof ReferenceError ||
    value instanceof RangeError ||
    value instanceof SyntaxError ||
    value instanceof EvalError ||
    value instanceof URIError
  );
}

function hasExcludedPolicyOrSecurityMarker(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const code = "code" in value ? (value as { code?: unknown }).code : undefined;
  if (typeof code !== "string") {
    return false;
  }
  const normalized = code.toUpperCase();
  return (
    normalized.includes("POLICY") ||
    normalized.includes("SECURITY") ||
    normalized.includes("UNAUTHORIZED") ||
    normalized.includes("FORBIDDEN") ||
    normalized === "NOT_FOUND"
  );
}

function areAttemptRecordsEligible(
  attempts: ModelGatewayError["attempts"],
): boolean {
  if (!attempts || attempts.length === 0) {
    return true;
  }

  for (const attempt of attempts) {
    if (attempt.outcome === "aborted") {
      return false;
    }
    if (!attempt.errorCategory) {
      return false;
    }
    if (!ELIGIBLE_DIRECT_CODES.has(attempt.errorCategory as ModelGatewayErrorCode)) {
      return false;
    }
  }

  return true;
}

function hasDisallowedNestedCause(
  value: unknown,
  visited: Set<unknown>,
  depth: number,
): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (depth > MAX_ERROR_TRAVERSAL_DEPTH) {
    return true;
  }

  if (value instanceof ModelGatewayError) {
    const res = classifyInternal(value, visited, depth);
    return !res.eligible;
  }

  if (typeof value === "object") {
    if (visited.has(value)) {
      return false;
    }
    visited.add(value);
  }

  if (isProgrammingError(value) || hasExcludedPolicyOrSecurityMarker(value)) {
    return true;
  }

  if (value instanceof Error && "cause" in value && value.cause !== undefined) {
    return hasDisallowedNestedCause(value.cause, visited, depth + 1);
  }

  return false;
}

function classifyInternal(
  error: unknown,
  visited: Set<unknown>,
  depth: number,
): FallbackEligibility {
  if (depth > MAX_ERROR_TRAVERSAL_DEPTH) {
    return { eligible: false };
  }

  if (!(error instanceof ModelGatewayError)) {
    return { eligible: false };
  }

  if (visited.has(error)) {
    return { eligible: true, reason: "retries_exhausted" };
  }
  visited.add(error);

  if (EXCLUDED_DIRECT_CODES.has(error.code)) {
    return { eligible: false };
  }

  if (!areAttemptRecordsEligible(error.attempts)) {
    return { eligible: false };
  }

  if (error.code === "RETRIES_EXHAUSTED") {
    const hasAttempts = Array.isArray(error.attempts) && error.attempts.length > 0;
    const hasPrimary = error.primaryError !== undefined;
    const hasGatewayCause = error.cause instanceof ModelGatewayError;

    // Conservative completeness rule: RETRIES_EXHAUSTED without provenance is ineligible
    if (!hasAttempts && !hasPrimary && !hasGatewayCause) {
      return { eligible: false };
    }

    if (error.primaryError !== undefined) {
      const primaryRes = classifyInternal(error.primaryError, visited, depth + 1);
      if (!primaryRes.eligible) {
        return { eligible: false };
      }
    }

    if (error.cause !== undefined) {
      if (hasDisallowedNestedCause(error.cause, visited, depth + 1)) {
        return { eligible: false };
      }
    }

    return { eligible: true, reason: "retries_exhausted" };
  }

  const directReason = ELIGIBLE_DIRECT_CODES.get(error.code);
  if (!directReason) {
    return { eligible: false };
  }

  if (
    error.primaryError !== undefined &&
    !classifyInternal(error.primaryError, visited, depth + 1).eligible
  ) {
    return { eligible: false };
  }

  if (
    error.cause !== undefined &&
    hasDisallowedNestedCause(error.cause, visited, depth + 1)
  ) {
    return { eligible: false };
  }

  return { eligible: true, reason: directReason };
}

/**
 * Classifies an error thrown by the ModelGateway to determine whether
 * deterministic fallback generation is permitted.
 */
export function classifyGatewayErrorForFallback(error: unknown): FallbackEligibility {
  return classifyInternal(error, new Set<unknown>(), 0);
}
