/**
 * @file constants.ts
 * Schema versions, conservative validation limits, and stable error codes for structured outputs.
 */

/**
 * Explicit canonical schema version for the impact_explanation task output.
 * Kept strictly independent from the prompt template version ('impact-explain-v1').
 */
export const IMPACT_EXPLANATION_OUTPUT_SCHEMA_VERSION = "impact-explanation-output-v1";

/**
 * Explicit canonical schema version for the simulation_narration task output.
 * Kept strictly independent from the prompt template version ('simulation-narrate-v1').
 */
export const SIMULATION_NARRATION_OUTPUT_SCHEMA_VERSION = "simulation-narration-output-v1";

/**
 * Conservative validation limits matching the Step 59 cost model and application consumption bounds.
 */
export const IMPACT_EXPLANATION_LIMITS = Object.freeze({
  /** Maximum character length of the summary string. */
  MAX_SUMMARY_LENGTH: 2000,
  /** Maximum number of factual claims in the claims array. */
  MAX_CLAIMS_COUNT: 50,
  /** Maximum character length of an individual claim's text. */
  MAX_CLAIM_TEXT_LENGTH: 1200,
  /** Maximum number of evidence IDs permitted on a single claim. */
  MAX_EVIDENCE_IDS_PER_CLAIM: 20,
  /** Maximum character length of an individual evidence ID string. */
  MAX_EVIDENCE_ID_LENGTH: 128,
  /** Maximum number of caveats in the caveats array. */
  MAX_CAVEATS_COUNT: 20,
  /** Maximum character length of an individual caveat string. */
  MAX_CAVEAT_TEXT_LENGTH: 500,
  /** Maximum number of validation issues returned in a validation failure result. */
  MAX_RETURNED_VALIDATION_ISSUES: 20,
  /** Maximum number of validation issues formatted into corrective retry system instructions. */
  MAX_CORRECTIVE_FEEDBACK_ISSUES: 10,
  /** Maximum total response attempts allowed for validation (initial + 1 corrective retry). */
  MAX_VALIDATION_ATTEMPTS: 2,
});

/**
 * Canonical named constants for validation issue limits.
 *
 * - MAX_VALIDATION_ISSUES (20): Maximum validation issues returned in a ValidationResult
 *   (enforced in validator.ts). Bounds diagnostic reporting to callers, telemetry, and audit logs.
 * - MAX_CORRECTIVE_FEEDBACK_ISSUES (10): Maximum validation issues formatted into the corrective
 *   prompt instruction (enforced in retry.ts). Prevents prompt bloat and cognitive overload for the LLM.
 */
export const MAX_VALIDATION_ISSUES = IMPACT_EXPLANATION_LIMITS.MAX_RETURNED_VALIDATION_ISSUES;
export const MAX_CORRECTIVE_FEEDBACK_ISSUES = IMPACT_EXPLANATION_LIMITS.MAX_CORRECTIVE_FEEDBACK_ISSUES;

/**
 * Stable, machine-readable validation error codes.
 */
export const VALIDATION_ERROR_CODES = Object.freeze({
  // Parse errors
  INVALID_INPUT: "INVALID_INPUT",
  EMPTY_RESPONSE: "EMPTY_RESPONSE",
  MARKDOWN_CODE_FENCE_DETECTED: "MARKDOWN_CODE_FENCE_DETECTED",
  JSON_PARSE_ERROR: "JSON_PARSE_ERROR",
  INVALID_ROOT_TYPE: "INVALID_ROOT_TYPE",

  // Schema errors
  UNRECOGNIZED_PROPERTY: "UNRECOGNIZED_PROPERTY",
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
  INVALID_FIELD_TYPE: "INVALID_FIELD_TYPE",
  EMPTY_STRING: "EMPTY_STRING",
  STRING_TOO_LONG: "STRING_TOO_LONG",
  ARRAY_TOO_LONG: "ARRAY_TOO_LONG",
  INVALID_ENUM_VALUE: "INVALID_ENUM_VALUE",

  // Grounding errors
  EMPTY_EVIDENCE_IDS: "EMPTY_EVIDENCE_IDS",
  DUPLICATE_EVIDENCE_ID: "DUPLICATE_EVIDENCE_ID",
  UNKNOWN_EVIDENCE_ID: "UNKNOWN_EVIDENCE_ID",
});
