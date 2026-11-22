/**
 * @file validator.test.ts
 * Comprehensive unit tests for runtime schema and evidence grounding validation.
 */

import { describe, expect, it } from "vitest";

import {
  IMPACT_EXPLANATION_LIMITS,
  IMPACT_EXPLANATION_OUTPUT_SCHEMA_VERSION,
  VALIDATION_ERROR_CODES,
} from "./constants.ts";
import { validateImpactExplanationOutput } from "./validator.ts";

function createValidOutputJson(overrides: Record<string, unknown> = {}): string {
  const base = {
    summary: "The pull request modifies billing service routes affecting downstream checkout handlers.",
    claims: [
      {
        text: "The payment processing route at /api/pay is directly modified.",
        evidence_ids: ["ev-payment-1"],
      },
      {
        text: "The checkout controller is indirectly affected via 1 hop dependency.",
        evidence_ids: ["ev-checkout-2"],
      },
    ],
    confidence: "high",
    caveats: [
      "Dynamic handler invocations could not be traced statically.",
    ],
    ...overrides,
  };
  return JSON.stringify(base);
}

describe("Impact Explanation Validator — Schema & Grounding", () => {
  const trustedManifest = ["ev-payment-1", "ev-checkout-2", "ev-auth-3"];

  describe("Valid Outputs", () => {
    it("successfully validates a complete conforming output", () => {
      const json = createValidOutputJson();
      const result = validateImpactExplanationOutput(json, trustedManifest);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.schemaVersion).toBe(IMPACT_EXPLANATION_OUTPUT_SCHEMA_VERSION);
        expect(result.data.summary).toContain("billing service");
        expect(result.data.claims).toHaveLength(2);
        expect(result.data.confidence).toBe("high");
        expect(result.data.caveats).toHaveLength(1);
      }
    });

    it("successfully validates output with empty claims array", () => {
      const json = createValidOutputJson({ claims: [] });
      const result = validateImpactExplanationOutput(json, trustedManifest);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.claims).toEqual([]);
      }
    });

    it("successfully validates output with empty caveats array", () => {
      const json = createValidOutputJson({ caveats: [] });
      const result = validateImpactExplanationOutput(json, trustedManifest);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.caveats).toEqual([]);
      }
    });

    it("accepts all three valid confidence levels", () => {
      for (const level of ["high", "medium", "low"] as const) {
        const json = createValidOutputJson({ confidence: level });
        const result = validateImpactExplanationOutput(json, trustedManifest);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.confidence).toBe(level);
        }
      }
    });

    it("accepts multiple claims referencing the same valid evidence ID", () => {
      const json = createValidOutputJson({
        claims: [
          { text: "Claim A", evidence_ids: ["ev-payment-1"] },
          { text: "Claim B", evidence_ids: ["ev-payment-1"] },
        ],
      });
      const result = validateImpactExplanationOutput(json, trustedManifest);
      expect(result.success).toBe(true);
    });

    it("accepts an empty manifest when claims array is empty", () => {
      const json = createValidOutputJson({ claims: [] });
      const result = validateImpactExplanationOutput(json, []);
      expect(result.success).toBe(true);
    });
  });

  describe("Schema Validation Failures", () => {
    it("rejects missing top-level required fields", () => {
      const missingSummary = JSON.stringify({
        claims: [],
        confidence: "medium",
        caveats: [],
      });
      const res1 = validateImpactExplanationOutput(missingSummary, trustedManifest);
      expect(res1.success).toBe(false);
      if (!res1.success) {
        expect(res1.errors.some((e) => e.code === VALIDATION_ERROR_CODES.MISSING_REQUIRED_FIELD && e.path === "summary")).toBe(true);
      }

      const missingClaims = JSON.stringify({
        summary: "Summary",
        confidence: "medium",
        caveats: [],
      });
      const res2 = validateImpactExplanationOutput(missingClaims, trustedManifest);
      expect(res2.success).toBe(false);
      if (!res2.success) {
        expect(res2.errors.some((e) => e.code === VALIDATION_ERROR_CODES.MISSING_REQUIRED_FIELD && e.path === "claims")).toBe(true);
      }
    });

    it("rejects unknown properties at root level", () => {
      const json = createValidOutputJson({
        suggestions: ["Do not deploy on Friday"],
        model_manifest: ["ev-fake"],
      });
      const res = validateImpactExplanationOutput(json, trustedManifest);
      expect(res.success).toBe(false);
      if (!res.success) {
        const codes = res.errors.map((e) => e.code);
        expect(codes).toContain(VALIDATION_ERROR_CODES.UNRECOGNIZED_PROPERTY);
        expect(res.errors.some((e) => e.path === "suggestions")).toBe(true);
        expect(res.errors.some((e) => e.path === "model_manifest")).toBe(true);
      }
    });

    it("rejects unknown properties inside claim objects", () => {
      const json = createValidOutputJson({
        claims: [
          {
            text: "Valid text",
            evidence_ids: ["ev-payment-1"],
            severity: "critical", // forbidden extra field
          },
        ],
      });
      const res = validateImpactExplanationOutput(json, trustedManifest);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.errors.some((e) => e.code === VALIDATION_ERROR_CODES.UNRECOGNIZED_PROPERTY && e.path === "claims[0].severity")).toBe(true);
      }
    });

    it("rejects invalid confidence values", () => {
      const invalidValues = ["uncertain", "very-high", "none", "", 10];
      for (const invalid of invalidValues) {
        const json = createValidOutputJson({ confidence: invalid });
        const res = validateImpactExplanationOutput(json, trustedManifest);
        expect(res.success).toBe(false);
        if (!res.success) {
          expect(res.errors.some((e) => e.path === "confidence")).toBe(true);
        }
      }
    });

    it("rejects null values where primitives or objects are required", () => {
      const cases = [
        { summary: null, path: "summary" },
        { confidence: null, path: "confidence" },
        { caveats: null, path: "caveats" },
        { claims: null, path: "claims" },
        { caveats: [null], path: "caveats[0]" },
        { claims: [null], path: "claims[0]" },
      ];

      for (const c of cases) {
        const json = createValidOutputJson(c);
        const res = validateImpactExplanationOutput(json, trustedManifest);
        expect(res.success).toBe(false);
        if (!res.success) {
          expect(res.errors.some((e) => e.path === c.path && e.code === VALIDATION_ERROR_CODES.INVALID_FIELD_TYPE)).toBe(true);
        }
      }
    });

    it("rejects empty and whitespace-only strings", () => {
      const emptySummary = createValidOutputJson({ summary: "   \t\n  " });
      const res1 = validateImpactExplanationOutput(emptySummary, trustedManifest);
      expect(res1.success).toBe(false);
      if (!res1.success) {
        expect(res1.errors.some((e) => e.path === "summary" && e.code === VALIDATION_ERROR_CODES.EMPTY_STRING)).toBe(true);
      }

      const emptyClaimText = createValidOutputJson({
        claims: [{ text: "  ", evidence_ids: ["ev-payment-1"] }],
      });
      const res2 = validateImpactExplanationOutput(emptyClaimText, trustedManifest);
      expect(res2.success).toBe(false);
      if (!res2.success) {
        expect(res2.errors.some((e) => e.path === "claims[0].text" && e.code === VALIDATION_ERROR_CODES.EMPTY_STRING)).toBe(true);
      }

      const emptyCaveat = createValidOutputJson({ caveats: [""] });
      const res3 = validateImpactExplanationOutput(emptyCaveat, trustedManifest);
      expect(res3.success).toBe(false);
      if (!res3.success) {
        expect(res3.errors.some((e) => e.path === "caveats[0]" && e.code === VALIDATION_ERROR_CODES.EMPTY_STRING)).toBe(true);
      }
    });

    it("enforces maximum string length boundaries", () => {
      // Summary exceeds 2000 chars
      const longSummary = "x".repeat(IMPACT_EXPLANATION_LIMITS.MAX_SUMMARY_LENGTH + 1);
      const res1 = validateImpactExplanationOutput(
        createValidOutputJson({ summary: longSummary }),
        trustedManifest
      );
      expect(res1.success).toBe(false);
      if (!res1.success) {
        expect(res1.errors.some((e) => e.path === "summary" && e.code === VALIDATION_ERROR_CODES.STRING_TOO_LONG)).toBe(true);
      }

      // Claim text exceeds 1200 chars
      const longClaimText = "y".repeat(IMPACT_EXPLANATION_LIMITS.MAX_CLAIM_TEXT_LENGTH + 1);
      const res2 = validateImpactExplanationOutput(
        createValidOutputJson({
          claims: [{ text: longClaimText, evidence_ids: ["ev-payment-1"] }],
        }),
        trustedManifest
      );
      expect(res2.success).toBe(false);
      if (!res2.success) {
        expect(res2.errors.some((e) => e.path === "claims[0].text" && e.code === VALIDATION_ERROR_CODES.STRING_TOO_LONG)).toBe(true);
      }

      // Caveat exceeds 500 chars
      const longCaveat = "z".repeat(IMPACT_EXPLANATION_LIMITS.MAX_CAVEAT_TEXT_LENGTH + 1);
      const res3 = validateImpactExplanationOutput(
        createValidOutputJson({ caveats: [longCaveat] }),
        trustedManifest
      );
      expect(res3.success).toBe(false);
      if (!res3.success) {
        expect(res3.errors.some((e) => e.path === "caveats[0]" && e.code === VALIDATION_ERROR_CODES.STRING_TOO_LONG)).toBe(true);
      }

      // Evidence ID exceeds 128 chars
      const longEvidenceId = "e".repeat(IMPACT_EXPLANATION_LIMITS.MAX_EVIDENCE_ID_LENGTH + 1);
      const res4 = validateImpactExplanationOutput(
        createValidOutputJson({
          claims: [{ text: "Valid claim", evidence_ids: [longEvidenceId] }],
        }),
        [longEvidenceId]
      );
      expect(res4.success).toBe(false);
      if (!res4.success) {
        expect(res4.errors.some((e) => e.path === "claims[0].evidence_ids[0]" && e.code === VALIDATION_ERROR_CODES.STRING_TOO_LONG)).toBe(true);
      }
    });

    it("enforces maximum array size boundaries", () => {
      // Claims > 50
      const tooManyClaims = Array.from({ length: IMPACT_EXPLANATION_LIMITS.MAX_CLAIMS_COUNT + 1 }, (_, i) => ({
        text: `Claim ${i}`,
        evidence_ids: ["ev-payment-1"],
      }));
      const res1 = validateImpactExplanationOutput(
        createValidOutputJson({ claims: tooManyClaims }),
        trustedManifest
      );
      expect(res1.success).toBe(false);
      if (!res1.success) {
        expect(res1.errors.some((e) => e.path === "claims" && e.code === VALIDATION_ERROR_CODES.ARRAY_TOO_LONG)).toBe(true);
      }

      // Caveats > 20
      const tooManyCaveats = Array.from({ length: IMPACT_EXPLANATION_LIMITS.MAX_CAVEATS_COUNT + 1 }, (_, i) => `Caveat ${i}`);
      const res2 = validateImpactExplanationOutput(
        createValidOutputJson({ caveats: tooManyCaveats }),
        trustedManifest
      );
      expect(res2.success).toBe(false);
      if (!res2.success) {
        expect(res2.errors.some((e) => e.path === "caveats" && e.code === VALIDATION_ERROR_CODES.ARRAY_TOO_LONG)).toBe(true);
      }

      // Evidence IDs > 20
      const tooManyIds = Array.from({ length: IMPACT_EXPLANATION_LIMITS.MAX_EVIDENCE_IDS_PER_CLAIM + 1 }, (_, i) => `ev-id-${i}`);
      const res3 = validateImpactExplanationOutput(
        createValidOutputJson({
          claims: [{ text: "Claim with too many IDs", evidence_ids: tooManyIds }],
        }),
        tooManyIds
      );
      expect(res3.success).toBe(false);
      if (!res3.success) {
        expect(res3.errors.some((e) => e.path === "claims[0].evidence_ids" && e.code === VALIDATION_ERROR_CODES.ARRAY_TOO_LONG)).toBe(true);
      }
    });

    it("bounds returned validation issues to MAX_RETURNED_VALIDATION_ISSUES", () => {
      // Construct an output with > 25 issues
      const manyInvalidCaveats = Array.from({ length: 30 }, () => 12345); // wrong type
      const json = createValidOutputJson({ caveats: manyInvalidCaveats });
      const res = validateImpactExplanationOutput(json, trustedManifest);

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.errors.length).toBeLessThanOrEqual(
          IMPACT_EXPLANATION_LIMITS.MAX_RETURNED_VALIDATION_ISSUES
        );
      }
    });
  });

  describe("Evidence Grounding Manifest Validation", () => {
    it("rejects unknown evidence ID outside the trusted manifest", () => {
      const json = createValidOutputJson({
        claims: [
          { text: "Claim with fabricated evidence", evidence_ids: ["ev-untrusted-fabricated-999"] },
        ],
      });
      const res = validateImpactExplanationOutput(json, trustedManifest);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.errors.some((e) => e.code === VALIDATION_ERROR_CODES.UNKNOWN_EVIDENCE_ID && e.path === "claims[0].evidence_ids[0]")).toBe(true);
      }
    });

    it("rejects citation from a different manifest", () => {
      const otherManifest = ["ev-other-1", "ev-other-2"];
      const json = createValidOutputJson(); // cites ev-payment-1, ev-checkout-2
      const res = validateImpactExplanationOutput(json, otherManifest);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.errors.some((e) => e.code === VALIDATION_ERROR_CODES.UNKNOWN_EVIDENCE_ID)).toBe(true);
      }
    });

    it("rejects empty evidence_ids array for a factual claim", () => {
      const json = createValidOutputJson({
        claims: [
          { text: "Factual claim with no citations", evidence_ids: [] },
        ],
      });
      const res = validateImpactExplanationOutput(json, trustedManifest);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.errors.some((e) => e.code === VALIDATION_ERROR_CODES.EMPTY_EVIDENCE_IDS && e.path === "claims[0].evidence_ids")).toBe(true);
      }
    });

    it("rejects duplicate evidence IDs within the same claim", () => {
      const json = createValidOutputJson({
        claims: [
          { text: "Claim with duplicate citations", evidence_ids: ["ev-payment-1", "ev-payment-1"] },
        ],
      });
      const res = validateImpactExplanationOutput(json, trustedManifest);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.errors.some((e) => e.code === VALIDATION_ERROR_CODES.DUPLICATE_EVIDENCE_ID && e.path === "claims[0].evidence_ids[1]")).toBe(true);
      }
    });

    it("rejects factual claims when the trusted manifest is empty", () => {
      const json = createValidOutputJson({
        claims: [
          { text: "Factual claim when no evidence exists", evidence_ids: ["ev-payment-1"] },
        ],
      });
      const res = validateImpactExplanationOutput(json, []);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.errors.some((e) => e.code === VALIDATION_ERROR_CODES.UNKNOWN_EVIDENCE_ID)).toBe(true);
      }
    });

    it("rejects whole response if even one claim cites an invalid evidence ID", () => {
      const json = createValidOutputJson({
        claims: [
          { text: "Valid claim", evidence_ids: ["ev-payment-1"] },
          { text: "Invalid claim", evidence_ids: ["ev-fake-id"] },
        ],
      });
      const res = validateImpactExplanationOutput(json, trustedManifest);
      expect(res.success).toBe(false);
      if (!res.success) {
        // Whole response must be rejected, not partially accepted
        expect(res.errors.some((e) => e.code === VALIDATION_ERROR_CODES.UNKNOWN_EVIDENCE_ID)).toBe(true);
      }
    });
  });

  describe("Contract, Invariants & Determinism", () => {
    it("is strictly deterministic across repeated invocations", () => {
      const json = createValidOutputJson();
      const res1 = validateImpactExplanationOutput(json, trustedManifest);
      const res2 = validateImpactExplanationOutput(json, trustedManifest);

      expect(res1).toEqual(res2);
    });

    it("never coerces invalid types or silently strips fields", () => {
      const json = createValidOutputJson({
        confidence: "HIGH", // uppercase is invalid
        extra: "field",
      });
      const res = validateImpactExplanationOutput(json, trustedManifest);
      expect(res.success).toBe(false);
      if (!res.success) {
        // Did not lowercase or strip
        expect(res.errors.some((e) => e.code === VALIDATION_ERROR_CODES.INVALID_ENUM_VALUE)).toBe(true);
        expect(res.errors.some((e) => e.code === VALIDATION_ERROR_CODES.UNRECOGNIZED_PROPERTY)).toBe(true);
      }
    });
  });
});
