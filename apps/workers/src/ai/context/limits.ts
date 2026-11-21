/**
 * @file limits.ts
 * Configurable bounds and sanitization helpers for context assembly.
 */

import { DEFAULT_CONTEXT_LIMITS, type ContextLimits } from "./types.ts";

/**
 * Resolves full context limits by combining caller overrides with default thresholds.
 */
export function resolveContextLimits(
  overrides?: Partial<ContextLimits> | undefined,
): ContextLimits {
  if (!overrides) {
    return DEFAULT_CONTEXT_LIMITS;
  }
  return {
    maxTotalCharacters:
      typeof overrides.maxTotalCharacters === "number" &&
      overrides.maxTotalCharacters > 0
        ? overrides.maxTotalCharacters
        : DEFAULT_CONTEXT_LIMITS.maxTotalCharacters,
    maxFindings:
      typeof overrides.maxFindings === "number" && overrides.maxFindings >= 0
        ? overrides.maxFindings
        : DEFAULT_CONTEXT_LIMITS.maxFindings,
    maxEvidenceRecords:
      typeof overrides.maxEvidenceRecords === "number" &&
      overrides.maxEvidenceRecords >= 0
        ? overrides.maxEvidenceRecords
        : DEFAULT_CONTEXT_LIMITS.maxEvidenceRecords,
    maxStringLength:
      typeof overrides.maxStringLength === "number" &&
      overrides.maxStringLength > 0
        ? overrides.maxStringLength
        : DEFAULT_CONTEXT_LIMITS.maxStringLength,
    maxUnresolvedFiles:
      typeof overrides.maxUnresolvedFiles === "number" &&
      overrides.maxUnresolvedFiles >= 0
        ? overrides.maxUnresolvedFiles
        : DEFAULT_CONTEXT_LIMITS.maxUnresolvedFiles,
  };
}

/**
 * Sanitizes untrusted repository-derived strings:
 * - Strips ASCII control characters (preserving standard whitespace: \n, \r, \t)
 * - Clamps string length deterministically to maxLength
 * - Ensures safe string output without mutation
 */
export function sanitizeUntrustedString(
  value: unknown,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    return "";
  }
  let cleaned = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // Filter non-printable ASCII control characters (0-8, 11-12, 14-31, 127), preserving \t (9), \n (10), \r (13)
    if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      continue;
    }
    cleaned += value[i];
  }
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return cleaned.slice(0, maxLength);
}
