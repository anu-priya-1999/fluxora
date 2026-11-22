/**
 * @file schema.ts
 * Provider-independent JSON Schema specification for the impact_explanation task output.
 */

import {
  IMPACT_EXPLANATION_LIMITS,
  IMPACT_EXPLANATION_OUTPUT_SCHEMA_VERSION,
} from "./constants.ts";

/**
 * Canonical JSON Schema (Draft-07) definition for the impact_explanation task output.
 * Can be serialized or provided to model providers that support structured JSON schema constraints.
 */
export const IMPACT_EXPLANATION_OUTPUT_SCHEMA = Object.freeze({
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "ImpactExplanationOutput",
  version: IMPACT_EXPLANATION_OUTPUT_SCHEMA_VERSION,
  type: "object",
  additionalProperties: false,
  required: ["summary", "claims", "confidence", "caveats"],
  properties: {
    summary: {
      type: "string",
      maxLength: IMPACT_EXPLANATION_LIMITS.MAX_SUMMARY_LENGTH,
      description: "A concise explanation synthesizing the deterministic impact findings and verified evidence.",
    },
    claims: {
      type: "array",
      maxItems: IMPACT_EXPLANATION_LIMITS.MAX_CLAIMS_COUNT,
      description: "Factual statements about affected components, each citing one or more verified evidence IDs.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "evidence_ids"],
        properties: {
          text: {
            type: "string",
            maxLength: IMPACT_EXPLANATION_LIMITS.MAX_CLAIM_TEXT_LENGTH,
            description: "A factual statement about an affected component or dependency.",
          },
          evidence_ids: {
            type: "array",
            minItems: 1,
            maxItems: IMPACT_EXPLANATION_LIMITS.MAX_EVIDENCE_IDS_PER_CLAIM,
            uniqueItems: true,
            description: "Evidence IDs from the trusted manifest supporting this factual claim.",
            items: {
              type: "string",
              maxLength: IMPACT_EXPLANATION_LIMITS.MAX_EVIDENCE_ID_LENGTH,
            },
          },
        },
      },
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "Model-assessed confidence level in the natural-language explanation narrative.",
    },
    caveats: {
      type: "array",
      maxItems: IMPACT_EXPLANATION_LIMITS.MAX_CAVEATS_COUNT,
      description: "Array of limitations, uncertainties, and relevant qualifications.",
      items: {
        type: "string",
        maxLength: IMPACT_EXPLANATION_LIMITS.MAX_CAVEAT_TEXT_LENGTH,
      },
    },
  },
});
