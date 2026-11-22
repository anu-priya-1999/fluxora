/**
 * @file validator.ts
 * Runtime schema and evidence-manifest grounding validator for the impact_explanation task output.
 *
 * Enforces:
 * - Exact 4-field schema (summary, claims, confidence, caveats)
 * - Strict type checking and forbidden unknown properties at all levels
 * - Named conservative length and array size constraints
 * - Mandatory evidence citations for every factual claim
 * - Trusted evidence manifest membership validation
 * - Within-claim evidence ID uniqueness
 * - Strict whole-response rejection on invalid evidence citations
 * - Deterministic, bounded validation error reporting
 */

import {
  IMPACT_EXPLANATION_LIMITS,
  IMPACT_EXPLANATION_OUTPUT_SCHEMA_VERSION,
  VALIDATION_ERROR_CODES,
} from "./constants.ts";
import { parseStrictJsonObject } from "./parser.ts";
import type {
  ImpactExplanationConfidence,
  ImpactExplanationOutput,
  ValidationIssue,
  ValidationResult,
} from "./types.ts";

const ALLOWED_ROOT_KEYS = new Set(["summary", "claims", "confidence", "caveats"]);
const REQUIRED_ROOT_KEYS: readonly (keyof ImpactExplanationOutput)[] = [
  "summary",
  "claims",
  "confidence",
  "caveats",
];
const VALID_CONFIDENCE_LEVELS = new Set<ImpactExplanationConfidence>(["high", "medium", "low"]);
const ALLOWED_CLAIM_KEYS = new Set(["text", "evidence_ids"]);

/**
 * Validates a raw model response against the canonical ImpactExplanationOutput schema
 * and verifies evidence citation grounding against the trusted allowed manifest.
 *
 * @param rawText The raw response text returned by the model.
 * @param allowedEvidenceIds The trusted set or list of allowed evidence IDs assembled in Step 60.
 * @returns A strongly typed ValidationResult containing either the validated payload or bounded issues.
 */
export function validateImpactExplanationOutput(
  rawText: string,
  allowedEvidenceIds: readonly string[] | ReadonlySet<string>
): ValidationResult<ImpactExplanationOutput> {
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
    } else if (!VALID_CONFIDENCE_LEVELS.has(confidence as ImpactExplanationConfidence)) {
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
          message: `Field 'caveats' exceeds maximum count of ${IMPACT_EXPLANATION_LIMITS.MAX_CAVEATS_COUNT} items (received ${caveats.length}).`,
        });
      }

      for (let i = 0; i < caveats.length; i++) {
        const item = caveats[i];
        const path = `caveats[${i}]`;
        if (typeof item !== "string") {
          const actualType = item === null ? "null" : typeof item;
          issues.push({
            category: "schema",
            code: VALIDATION_ERROR_CODES.INVALID_FIELD_TYPE,
            path,
            message: `Caveat at index ${i} must be a string, received ${actualType}.`,
          });
        } else {
          if (item.trim().length === 0) {
            issues.push({
              category: "schema",
              code: VALIDATION_ERROR_CODES.EMPTY_STRING,
              path,
              message: `Caveat at index ${i} must not be empty or whitespace-only.`,
            });
          }
          if (item.length > IMPACT_EXPLANATION_LIMITS.MAX_CAVEAT_TEXT_LENGTH) {
            issues.push({
              category: "schema",
              code: VALIDATION_ERROR_CODES.STRING_TOO_LONG,
              path,
              message: `Caveat at index ${i} exceeds maximum length of ${IMPACT_EXPLANATION_LIMITS.MAX_CAVEAT_TEXT_LENGTH} characters (received ${item.length}).`,
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
          message: `Field 'claims' exceeds maximum count of ${IMPACT_EXPLANATION_LIMITS.MAX_CLAIMS_COUNT} items (received ${claims.length}).`,
        });
      }

      for (let i = 0; i < claims.length; i++) {
        const claim = claims[i];
        const claimPath = `claims[${i}]`;

        if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
          const actualType = claim === null ? "null" : Array.isArray(claim) ? "array" : typeof claim;
          issues.push({
            category: "schema",
            code: VALIDATION_ERROR_CODES.INVALID_FIELD_TYPE,
            path: claimPath,
            message: `Claim at index ${i} must be an object, received ${actualType}.`,
          });
          continue;
        }

        // Unrecognized properties in claim object
        for (const claimKey of Object.keys(claim)) {
          if (!ALLOWED_CLAIM_KEYS.has(claimKey)) {
            issues.push({
              category: "schema",
              code: VALIDATION_ERROR_CODES.UNRECOGNIZED_PROPERTY,
              path: `${claimPath}.${claimKey}`,
              message: `Unrecognized property '${claimKey}' in claim at index ${i}.`,
            });
          }
        }

        // Required claim properties
        if (!("text" in claim)) {
          issues.push({
            category: "schema",
            code: VALIDATION_ERROR_CODES.MISSING_REQUIRED_FIELD,
            path: `${claimPath}.text`,
            message: `Missing required field 'text' in claim at index ${i}.`,
          });
        }
        if (!("evidence_ids" in claim)) {
          issues.push({
            category: "schema",
            code: VALIDATION_ERROR_CODES.MISSING_REQUIRED_FIELD,
            path: `${claimPath}.evidence_ids`,
            message: `Missing required field 'evidence_ids' in claim at index ${i}.`,
          });
        }

        // Validate claim 'text'
        if ("text" in claim) {
          const text = (claim as Record<string, unknown>).text;
          const textPath = `${claimPath}.text`;
          if (typeof text !== "string") {
            const actualType = text === null ? "null" : typeof text;
            issues.push({
              category: "schema",
              code: VALIDATION_ERROR_CODES.INVALID_FIELD_TYPE,
              path: textPath,
              message: `Field 'text' in claim at index ${i} must be a string, received ${actualType}.`,
            });
          } else {
            if (text.trim().length === 0) {
              issues.push({
                category: "schema",
                code: VALIDATION_ERROR_CODES.EMPTY_STRING,
                path: textPath,
                message: `Field 'text' in claim at index ${i} must not be empty or whitespace-only.`,
              });
            }
            if (text.length > IMPACT_EXPLANATION_LIMITS.MAX_CLAIM_TEXT_LENGTH) {
              issues.push({
                category: "schema",
                code: VALIDATION_ERROR_CODES.STRING_TOO_LONG,
                path: textPath,
                message: `Field 'text' in claim at index ${i} exceeds maximum length of ${IMPACT_EXPLANATION_LIMITS.MAX_CLAIM_TEXT_LENGTH} characters (received ${text.length}).`,
              });
            }
          }
        }

        // Validate claim 'evidence_ids'
        if ("evidence_ids" in claim) {
          const evidenceIds = (claim as Record<string, unknown>).evidence_ids;
          const evidenceIdsPath = `${claimPath}.evidence_ids`;

          if (!Array.isArray(evidenceIds)) {
            const actualType = evidenceIds === null ? "null" : typeof evidenceIds;
            issues.push({
              category: "schema",
              code: VALIDATION_ERROR_CODES.INVALID_FIELD_TYPE,
              path: evidenceIdsPath,
              message: `Field 'evidence_ids' in claim at index ${i} must be an array, received ${actualType}.`,
            });
          } else {
            if (evidenceIds.length === 0) {
              issues.push({
                category: "grounding",
                code: VALIDATION_ERROR_CODES.EMPTY_EVIDENCE_IDS,
                path: evidenceIdsPath,
                message: `Claim at index ${i} has empty 'evidence_ids'. Every factual claim must cite at least one evidence ID.`,
              });
            } else if (evidenceIds.length > IMPACT_EXPLANATION_LIMITS.MAX_EVIDENCE_IDS_PER_CLAIM) {
              issues.push({
                category: "schema",
                code: VALIDATION_ERROR_CODES.ARRAY_TOO_LONG,
                path: evidenceIdsPath,
                message: `Field 'evidence_ids' in claim at index ${i} exceeds maximum count of ${IMPACT_EXPLANATION_LIMITS.MAX_EVIDENCE_IDS_PER_CLAIM} items (received ${evidenceIds.length}).`,
              });
            }

            const seenIdsInClaim = new Set<string>();

            for (let j = 0; j < evidenceIds.length; j++) {
              const evidenceId = evidenceIds[j];
              const idPath = `${evidenceIdsPath}[${j}]`;

              if (typeof evidenceId !== "string") {
                const actualType = evidenceId === null ? "null" : typeof evidenceId;
                issues.push({
                  category: "schema",
                  code: VALIDATION_ERROR_CODES.INVALID_FIELD_TYPE,
                  path: idPath,
                  message: `Evidence ID at index ${j} in claim ${i} must be a string, received ${actualType}.`,
                });
              } else {
                if (evidenceId.trim().length === 0) {
                  issues.push({
                    category: "schema",
                    code: VALIDATION_ERROR_CODES.EMPTY_STRING,
                    path: idPath,
                    message: `Evidence ID at index ${j} in claim ${i} must not be empty or whitespace-only.`,
                  });
                }
                if (evidenceId.length > IMPACT_EXPLANATION_LIMITS.MAX_EVIDENCE_ID_LENGTH) {
                  issues.push({
                    category: "schema",
                    code: VALIDATION_ERROR_CODES.STRING_TOO_LONG,
                    path: idPath,
                    message: `Evidence ID at index ${j} in claim ${i} exceeds maximum length of ${IMPACT_EXPLANATION_LIMITS.MAX_EVIDENCE_ID_LENGTH} characters.`,
                  });
                }

                // Check duplicate within the single claim
                if (seenIdsInClaim.has(evidenceId)) {
                  issues.push({
                    category: "grounding",
                    code: VALIDATION_ERROR_CODES.DUPLICATE_EVIDENCE_ID,
                    path: idPath,
                    message: `Duplicate evidence ID '${evidenceId}' cited within claim at index ${i}.`,
                  });
                } else {
                  seenIdsInClaim.add(evidenceId);
                }

                // Check grounding against trusted manifest
                if (!allowedSet.has(evidenceId)) {
                  issues.push({
                    category: "grounding",
                    code: VALIDATION_ERROR_CODES.UNKNOWN_EVIDENCE_ID,
                    path: idPath,
                    message: `Evidence ID '${evidenceId}' cited in claim at index ${i} does not exist in the allowed evidence manifest.`,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  if (issues.length > 0) {
    return {
      success: false,
      errors: issues.slice(0, IMPACT_EXPLANATION_LIMITS.MAX_RETURNED_VALIDATION_ISSUES),
    };
  }

  return {
    success: true,
    data: parsed as unknown as ImpactExplanationOutput,
    schemaVersion: IMPACT_EXPLANATION_OUTPUT_SCHEMA_VERSION,
  };
}
