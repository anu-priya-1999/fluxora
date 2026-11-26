/**
 * @file simulation-validator.ts
 * Runtime schema and evidence-manifest grounding validator for the simulation_narration task output.
 *
 * Enforces:
 * - Exact 4-field schema (summary, claims, confidence, caveats) matching simulation-narration-output-v1
 * - Strict type checking and forbidden unknown properties at all levels
 * - Named conservative length and array size constraints
 * - Mandatory evidence citations for every factual claim
 * - Trusted evidence manifest membership validation
 * - Within-claim evidence ID uniqueness
 * - Strict whole-response rejection on invalid or fabricated evidence citations
 * - Bounded corrective retry with at most 2 response attempts (1 initial + 1 corrective retry)
 */

import {
  IMPACT_EXPLANATION_LIMITS,
  MAX_CORRECTIVE_FEEDBACK_ISSUES,
  MAX_VALIDATION_ISSUES,
  SIMULATION_NARRATION_OUTPUT_SCHEMA_VERSION,
  VALIDATION_ERROR_CODES,
} from "./constants.ts";
import { parseStrictJsonObject } from "./parser.ts";
import type {
  SimulationNarrationConfidence,
  SimulationNarrationOutput,
  ValidateWithRetryOptions,
  ValidationIssue,
  ValidationResult,
  ValidationWithRetryResult,
} from "./types.ts";

const ALLOWED_ROOT_KEYS = new Set(["summary", "claims", "confidence", "caveats"]);
const REQUIRED_ROOT_KEYS: readonly (keyof SimulationNarrationOutput)[] = [
  "summary",
  "claims",
  "confidence",
  "caveats",
];
const VALID_CONFIDENCE_LEVELS = new Set<SimulationNarrationConfidence>(["high", "medium", "low"]);
const ALLOWED_CLAIM_KEYS = new Set(["text", "evidence_ids"]);

/**
 * Validates a raw model response against the canonical SimulationNarrationOutput schema
 * and verifies evidence citation grounding against the trusted allowed manifest.
 *
 * @param rawText The raw response text returned by the model.
 * @param allowedEvidenceIds The trusted set or list of allowed evidence IDs assembled for the simulation.
 * @returns A strongly typed ValidationResult containing either the validated payload or bounded issues.
 */
export function validateSimulationNarrationOutput(
  rawText: string,
  allowedEvidenceIds: readonly string[] | ReadonlySet<string>,
): ValidationResult<SimulationNarrationOutput> {
  const parseResult = parseStrictJsonObject(rawText);
  if (!parseResult.ok) {
    return {
      success: false,
      errors: [parseResult.issue],
    };
  }

  const parsed = parseResult.value;
  const issues: ValidationIssue[] = [];
  const allowedSet =
    allowedEvidenceIds instanceof Set ? allowedEvidenceIds : new Set(allowedEvidenceIds);

  // 1. Root-level unknown properties check
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_ROOT_KEYS.has(key)) {
      issues.push({
        category: "schema",
        code: VALIDATION_ERROR_CODES.UNRECOGNIZED_PROPERTY,
        path: key,
        message: `Unrecognized property '${key}' at root level.`,
      });
    }
  }

  // 2. Root-level required properties check
  for (const reqKey of REQUIRED_ROOT_KEYS) {
    if (!(reqKey in parsed)) {
      issues.push({
        category: "schema",
        code: VALIDATION_ERROR_CODES.MISSING_REQUIRED_FIELD,
        path: reqKey,
        message: `Missing required field '${reqKey}'.`,
      });
    }
  }

  // 3. Validate 'summary'
  if ("summary" in parsed) {
    const summary = parsed.summary;
    if (typeof summary !== "string") {
      const actualType = summary === null ? "null" : Array.isArray(summary) ? "array" : typeof summary;
      issues.push({
        category: "schema",
        code: VALIDATION_ERROR_CODES.INVALID_FIELD_TYPE,
        path: "summary",
        message: `Field 'summary' must be a string, received ${actualType}.`,
      });
    } else {
      if (summary.trim().length === 0) {
        issues.push({
          category: "schema",
          code: VALIDATION_ERROR_CODES.EMPTY_STRING,
          path: "summary",
          message: "Field 'summary' must not be empty or whitespace-only.",
        });
      }
      if (summary.length > IMPACT_EXPLANATION_LIMITS.MAX_SUMMARY_LENGTH) {
        issues.push({
          category: "schema",
          code: VALIDATION_ERROR_CODES.STRING_TOO_LONG,
          path: "summary",
          message: `Field 'summary' exceeds maximum length of ${IMPACT_EXPLANATION_LIMITS.MAX_SUMMARY_LENGTH} characters (received ${summary.length}).`,
        });
      }
    }
  }

  // 4. Validate 'confidence'
  if ("confidence" in parsed) {
    const confidence = parsed.confidence;
    if (typeof confidence !== "string") {
      const actualType = confidence === null ? "null" : typeof confidence;
      issues.push({
        category: "schema",
        code: VALIDATION_ERROR_CODES.INVALID_FIELD_TYPE,
        path: "confidence",
        message: `Field 'confidence' must be a string, received ${actualType}.`,
      });
    } else if (!VALID_CONFIDENCE_LEVELS.has(confidence as SimulationNarrationConfidence)) {
      issues.push({
        category: "schema",
        code: VALIDATION_ERROR_CODES.INVALID_ENUM_VALUE,
        path: "confidence",
        message: `Field 'confidence' must be one of 'high', 'medium', 'low'; received '${confidence}'.`,
      });
    }
  }

  // 5. Validate 'caveats'
  if ("caveats" in parsed) {
    const caveats = parsed.caveats;
    if (!Array.isArray(caveats)) {
      const actualType = caveats === null ? "null" : typeof caveats;
      issues.push({
        category: "schema",
        code: VALIDATION_ERROR_CODES.INVALID_FIELD_TYPE,
        path: "caveats",
        message: `Field 'caveats' must be an array, received ${actualType}.`,
      });
    } else {
      if (caveats.length > IMPACT_EXPLANATION_LIMITS.MAX_CAVEATS_COUNT) {
        issues.push({
          category: "schema",
          code: VALIDATION_ERROR_CODES.ARRAY_TOO_LONG,
          path: "caveats",
          message: `Array 'caveats' exceeds maximum length of ${IMPACT_EXPLANATION_LIMITS.MAX_CAVEATS_COUNT} items (received ${caveats.length}).`,
        });
      }
      for (let i = 0; i < caveats.length; i++) {
        const item = caveats[i];
        if (typeof item !== "string") {
          const itemType = item === null ? "null" : typeof item;
          issues.push({
            category: "schema",
            code: VALIDATION_ERROR_CODES.INVALID_FIELD_TYPE,
            path: `caveats[${i}]`,
            message: `Caveat item at index ${i} must be a string, received ${itemType}.`,
          });
        } else {
          if (item.trim().length === 0) {
            issues.push({
              category: "schema",
              code: VALIDATION_ERROR_CODES.EMPTY_STRING,
              path: `caveats[${i}]`,
              message: `Caveat item at index ${i} must not be empty or whitespace-only.`,
            });
          }
          if (item.length > IMPACT_EXPLANATION_LIMITS.MAX_CAVEAT_TEXT_LENGTH) {
            issues.push({
              category: "schema",
              code: VALIDATION_ERROR_CODES.STRING_TOO_LONG,
              path: `caveats[${i}]`,
              message: `Caveat item at index ${i} exceeds maximum length of ${IMPACT_EXPLANATION_LIMITS.MAX_CAVEAT_TEXT_LENGTH} characters.`,
            });
          }
        }
      }
    }
  }

  // 6. Validate 'claims'
  if ("claims" in parsed) {
    const claims = parsed.claims;
    if (!Array.isArray(claims)) {
      const actualType = claims === null ? "null" : typeof claims;
      issues.push({
        category: "schema",
        code: VALIDATION_ERROR_CODES.INVALID_FIELD_TYPE,
        path: "claims",
        message: `Field 'claims' must be an array, received ${actualType}.`,
      });
    } else {
      if (claims.length > IMPACT_EXPLANATION_LIMITS.MAX_CLAIMS_COUNT) {
        issues.push({
          category: "schema",
          code: VALIDATION_ERROR_CODES.ARRAY_TOO_LONG,
          path: "claims",
          message: `Array 'claims' exceeds maximum length of ${IMPACT_EXPLANATION_LIMITS.MAX_CLAIMS_COUNT} items (received ${claims.length}).`,
        });
      }

      for (let i = 0; i < claims.length; i++) {
        const claim = claims[i];
        const claimPath = `claims[${i}]`;

        if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
          const itemType = claim === null ? "null" : Array.isArray(claim) ? "array" : typeof claim;
          issues.push({
            category: "schema",
            code: VALIDATION_ERROR_CODES.INVALID_FIELD_TYPE,
            path: claimPath,
            message: `Claim at index ${i} must be a JSON object, received ${itemType}.`,
          });
          continue;
        }

        // Unknown properties in claim
        for (const claimKey of Object.keys(claim)) {
          if (!ALLOWED_CLAIM_KEYS.has(claimKey)) {
            issues.push({
              category: "schema",
              code: VALIDATION_ERROR_CODES.UNRECOGNIZED_PROPERTY,
              path: `${claimPath}.${claimKey}`,
              message: `Unrecognized property '${claimKey}' on claim at index ${i}.`,
            });
          }
        }

        // Validate claim 'text'
        if (!("text" in claim)) {
          issues.push({
            category: "schema",
            code: VALIDATION_ERROR_CODES.MISSING_REQUIRED_FIELD,
            path: `${claimPath}.text`,
            message: `Claim at index ${i} is missing required field 'text'.`,
          });
        } else if (typeof claim.text !== "string") {
          const textType = claim.text === null ? "null" : typeof claim.text;
          issues.push({
            category: "schema",
            code: VALIDATION_ERROR_CODES.INVALID_FIELD_TYPE,
            path: `${claimPath}.text`,
            message: `Field 'text' on claim at index ${i} must be a string, received ${textType}.`,
          });
        } else {
          if (claim.text.trim().length === 0) {
            issues.push({
              category: "schema",
              code: VALIDATION_ERROR_CODES.EMPTY_STRING,
              path: `${claimPath}.text`,
              message: `Field 'text' on claim at index ${i} must not be empty or whitespace-only.`,
            });
          }
          if (claim.text.length > IMPACT_EXPLANATION_LIMITS.MAX_CLAIM_TEXT_LENGTH) {
            issues.push({
              category: "schema",
              code: VALIDATION_ERROR_CODES.STRING_TOO_LONG,
              path: `${claimPath}.text`,
              message: `Field 'text' on claim at index ${i} exceeds maximum length of ${IMPACT_EXPLANATION_LIMITS.MAX_CLAIM_TEXT_LENGTH} characters.`,
            });
          }
        }

        // Validate claim 'evidence_ids'
        if (!("evidence_ids" in claim)) {
          issues.push({
            category: "schema",
            code: VALIDATION_ERROR_CODES.MISSING_REQUIRED_FIELD,
            path: `${claimPath}.evidence_ids`,
            message: `Claim at index ${i} is missing required field 'evidence_ids'.`,
          });
        } else if (!Array.isArray(claim.evidence_ids)) {
          const evType = claim.evidence_ids === null ? "null" : typeof claim.evidence_ids;
          issues.push({
            category: "schema",
            code: VALIDATION_ERROR_CODES.INVALID_FIELD_TYPE,
            path: `${claimPath}.evidence_ids`,
            message: `Field 'evidence_ids' on claim at index ${i} must be an array, received ${evType}.`,
          });
        } else {
          // Grounding check 1: Mandatory non-empty evidence citations
          if (claim.evidence_ids.length === 0) {
            issues.push({
              category: "grounding",
              code: VALIDATION_ERROR_CODES.EMPTY_EVIDENCE_IDS,
              path: `${claimPath}.evidence_ids`,
              message: `Claim at index ${i} must cite at least one evidence ID.`,
            });
          }

          if (claim.evidence_ids.length > IMPACT_EXPLANATION_LIMITS.MAX_EVIDENCE_IDS_PER_CLAIM) {
            issues.push({
              category: "schema",
              code: VALIDATION_ERROR_CODES.ARRAY_TOO_LONG,
              path: `${claimPath}.evidence_ids`,
              message: `Field 'evidence_ids' on claim at index ${i} exceeds maximum length of ${IMPACT_EXPLANATION_LIMITS.MAX_EVIDENCE_IDS_PER_CLAIM} IDs.`,
            });
          }

          // Grounding check 2: Duplicate citation check within claim
          const seenInClaim = new Set<string>();

          for (let j = 0; j < claim.evidence_ids.length; j++) {
            const evId = claim.evidence_ids[j];
            const evPath = `${claimPath}.evidence_ids[${j}]`;

            if (typeof evId !== "string") {
              const idType = evId === null ? "null" : typeof evId;
              issues.push({
                category: "schema",
                code: VALIDATION_ERROR_CODES.INVALID_FIELD_TYPE,
                path: evPath,
                message: `Evidence ID at index ${j} on claim ${i} must be a string, received ${idType}.`,
              });
              continue;
            }

            if (evId.trim().length === 0) {
              issues.push({
                category: "schema",
                code: VALIDATION_ERROR_CODES.EMPTY_STRING,
                path: evPath,
                message: `Evidence ID at index ${j} on claim ${i} must not be empty.`,
              });
              continue;
            }

            if (evId.length > IMPACT_EXPLANATION_LIMITS.MAX_EVIDENCE_ID_LENGTH) {
              issues.push({
                category: "schema",
                code: VALIDATION_ERROR_CODES.STRING_TOO_LONG,
                path: evPath,
                message: `Evidence ID at index ${j} on claim ${i} exceeds maximum length of ${IMPACT_EXPLANATION_LIMITS.MAX_EVIDENCE_ID_LENGTH} characters.`,
              });
              continue;
            }

            if (seenInClaim.has(evId)) {
              issues.push({
                category: "grounding",
                code: VALIDATION_ERROR_CODES.DUPLICATE_EVIDENCE_ID,
                path: evPath,
                message: `Duplicate evidence ID '${evId}' cited multiple times within claim ${i}.`,
              });
            } else {
              seenInClaim.add(evId);
            }

            // Grounding check 3: Allowlist compliance against trusted manifest
            if (!allowedSet.has(evId)) {
              issues.push({
                category: "grounding",
                code: VALIDATION_ERROR_CODES.UNKNOWN_EVIDENCE_ID,
                path: evPath,
                message: `Evidence ID '${evId}' is not present in the trusted allowed evidence manifest.`,
              });
            }
          }
        }
      }
    }
  }

  if (issues.length > 0) {
    return {
      success: false,
      errors: issues.slice(0, MAX_VALIDATION_ISSUES),
    };
  }

  // Schema and grounding checks passed
  const validatedOutput: SimulationNarrationOutput = {
    summary: (parsed.summary as string).trim(),
    claims: (parsed.claims as Array<{ text: string; evidence_ids: string[] }>).map((c) => ({
      text: c.text.trim(),
      evidence_ids: Object.freeze([...c.evidence_ids]),
    })),
    confidence: parsed.confidence as SimulationNarrationConfidence,
    caveats: (parsed.caveats as string[]).map((cav) => cav.trim()),
  };

  return {
    success: true,
    data: validatedOutput,
    schemaVersion: SIMULATION_NARRATION_OUTPUT_SCHEMA_VERSION,
  };
}

/**
 * Builds a bounded, deterministic corrective system instruction
 * for simulation narration retry without echoing raw prior model output.
 */
export function buildSimulationValidationCorrectiveInstruction(
  errors: readonly ValidationIssue[],
): string {
  const boundedErrors = errors.slice(0, MAX_CORRECTIVE_FEEDBACK_ISSUES);
  const errorBulletList = boundedErrors
    .map((err) => `- [${err.code}] at '${err.path}': ${err.message}`)
    .join("\n");

  return [
    "Your previous simulation narration response failed structured output validation and evidence grounding checks.",
    "You must correct the output and return ONLY a valid, single JSON object conforming strictly to schema 'simulation-narration-output-v1'.",
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
 * Validates an initial model response for simulation narration and performs at most one corrective retry
 * if validation fails.
 *
 * Strict ceiling: at most 2 response attempts (1 initial response + at most 1 corrective retry).
 * Provider or gateway exceptions propagate directly without being classified as validation issues.
 */
export async function validateSimulationNarrationWithRetry(
  options: ValidateWithRetryOptions,
): Promise<ValidationWithRetryResult<SimulationNarrationOutput>> {
  // Attempt 1: Validate initial response
  const initialResult = validateSimulationNarrationOutput(
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

  // Attempt 2: Bounded corrective retry
  const correctiveInstruction = buildSimulationValidationCorrectiveInstruction(initialResult.errors);

  const retryResponseText = await options.retry({
    attemptNumber: 2,
    correctiveInstruction,
    validationErrors: initialResult.errors,
  });

  // Re-validate retry response against the exact same trusted allowed manifest
  const retryResult = validateSimulationNarrationOutput(
    retryResponseText,
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
