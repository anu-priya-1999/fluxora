/**
 * @file validator.ts
 * Strict structured-output and evidence-manifest grounding validator for chat_query (Step 64).
 *
 * Reuses the canonical 4-field schema validator and bounded corrective retry
 * from `../structured-output/` while stamping `chat-query-output-v1`.
 */

import {
  buildValidationCorrectiveInstruction,
  validateImpactExplanationOutput,
  type ImpactExplanationOutput,
  type ValidateWithRetryOptions,
  type ValidationResult,
  type ValidationWithRetryResult,
} from "../structured-output/index.ts";
import { CHAT_QUERY_OUTPUT_SCHEMA_VERSION } from "./types.ts";

export type ChatQueryOutput = ImpactExplanationOutput;

/**
 * Validates raw model output for `chat_query` against the strict 4-field schema
 * and verifies that every cited evidence_id belongs to the accumulated tool manifest.
 */
export function validateChatQueryOutput(
  rawText: string,
  allowedEvidenceIds: readonly string[] | ReadonlySet<string>,
): ValidationResult<ChatQueryOutput> {
  const result = validateImpactExplanationOutput(rawText, allowedEvidenceIds);
  if (result.success) {
    return {
      success: true,
      data: result.data,
      schemaVersion: CHAT_QUERY_OUTPUT_SCHEMA_VERSION,
    };
  }
  return result;
}

/**
 * Validates initial chat response and performs at most one bounded corrective retry
 * if schema or grounding validation fails.
 */
export async function validateChatQueryWithRetry(
  options: ValidateWithRetryOptions,
): Promise<ValidationWithRetryResult<ChatQueryOutput>> {
  const initialResult = validateChatQueryOutput(
    options.initialResponseText,
    options.allowedEvidenceIds,
  );

  if (initialResult.success) {
    return {
      success: true,
      data: initialResult.data,
      schemaVersion: initialResult.schemaVersion,
      attempts: 1,
    };
  }

  const correctiveInstruction = buildValidationCorrectiveInstruction(
    initialResult.errors,
  );

  const retryText = await options.retry({
    attemptNumber: 2,
    correctiveInstruction,
    validationErrors: initialResult.errors,
  });

  const retryResult = validateChatQueryOutput(
    retryText,
    options.allowedEvidenceIds,
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
