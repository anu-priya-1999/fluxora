/**
 * @file retry.ts
 * Bounded corrective retry helper for structured output validation.
 *
 * Implements:
 * - Exactly two total attempts policy (initial + 1 corrective retry)
 * - Deterministic, bounded corrective system instruction generation
 * - Protection against echoing raw untrusted model output
 * - Exception propagation for provider errors without misclassifying them as validation issues
 * - Re-validation against the exact trusted evidence manifest
 */

import {
  MAX_CORRECTIVE_FEEDBACK_ISSUES,
} from "./constants.ts";
import type {
  ImpactExplanationOutput,
  ValidateWithRetryOptions,
  ValidationIssue,
  ValidationWithRetryResult,
} from "./types.ts";
import { validateImpactExplanationOutput } from "./validator.ts";

/**
 * Constructs a bounded, deterministic corrective system instruction
 * detailing validation failures without echoing raw prior model output.
 *
 * Slices errors to at most MAX_CORRECTIVE_FEEDBACK_ISSUES (10) items to prevent
 * prompt bloat and keep corrective instructions focused for the model.
 */
export function buildValidationCorrectiveInstruction(
  errors: readonly ValidationIssue[]
): string {
  const boundedErrors = errors.slice(0, MAX_CORRECTIVE_FEEDBACK_ISSUES);
  const errorBulletList = boundedErrors
    .map((err) => `- [${err.code}] at '${err.path}': ${err.message}`)
    .join("\n");

  return [
    "Your previous response failed structured output validation and evidence grounding checks.",
    "You must correct the output and return ONLY a valid, single JSON object conforming strictly to the schema.",
    "",
    "VALIDATION ERRORS ENCOUNTERED:",
    errorBulletList,
    "",
    "MANDATORY CORRECTION INSTRUCTIONS:",
    "1. Return ONLY a single raw JSON object. Do not include markdown code fences (```json ... ```), leading prose, or trailing commentary.",
    "2. Conform strictly to the four required fields: 'summary' (string, max 2000 chars), 'claims' (array, max 50 items), 'confidence' ('high' | 'medium' | 'low'), and 'caveats' (array of strings, max 20 items).",
    "3. Reject any additional properties not in the schema.",
    "4. Every factual claim must have 'text' (max 1200 chars) and non-empty 'evidence_ids' (1-20 IDs).",
    "5. Every cited evidence ID MUST belong strictly to the allowed evidence-ID manifest provided in the original context. NEVER invent or fabricate evidence IDs.",
    "6. Do not include duplicate evidence IDs within the same claim.",
    "7. If no verified evidence is available to support a factual claim, do not manufacture the claim. An empty claims array is valid if no findings can be cited.",
  ].join("\n");
}

/**
 * Validates an initial model response and performs at most one corrective retry
 * if validation fails.
 *
 * Total attempts are strictly capped at 2 (1 initial + 1 corrective retry).
 * Provider or gateway exceptions thrown by the injected retry callback are NOT caught
 * or converted to validation errors; they propagate directly to calling orchestration.
 */
export async function validateImpactExplanationWithRetry(
  options: ValidateWithRetryOptions
): Promise<ValidationWithRetryResult<ImpactExplanationOutput>> {
  // Attempt 1: Validate initial response
  const initialResult = validateImpactExplanationOutput(
    options.initialResponseText,
    options.allowedEvidenceIds
  );

  if (initialResult.success) {
    return {
      success: true,
      data: initialResult.data,
      schemaVersion: initialResult.schemaVersion,
      attempts: 1,
    };
  }

  // Attempt 2: Bounded corrective retry
  const correctiveInstruction = buildValidationCorrectiveInstruction(initialResult.errors);

  // Invoke injected callback. Any provider exception propagates naturally.
  const retryResponseText = await options.retry({
    attemptNumber: 2,
    correctiveInstruction,
    validationErrors: initialResult.errors,
  });

  // Re-validate retry response against the exact same trusted allowed manifest
  const retryResult = validateImpactExplanationOutput(
    retryResponseText,
    options.allowedEvidenceIds
  );

  if (retryResult.success) {
    return {
      success: true,
      data: retryResult.data,
      schemaVersion: retryResult.schemaVersion,
      attempts: 2,
    };
  }

  return {
    success: false,
    errors: retryResult.errors,
    attempts: 2,
  };
}
