/**
 * @file retry.test.ts
 * Comprehensive unit tests for bounded corrective retries.
 */

import { describe, expect, it, vi } from "vitest";

import {
  MAX_CORRECTIVE_FEEDBACK_ISSUES,
} from "./constants.ts";
import {
  buildValidationCorrectiveInstruction,
  validateImpactExplanationWithRetry,
} from "./retry.ts";
import type { ValidationIssue } from "./types.ts";

describe("Validation Retry Helper", () => {
  const allowedManifest = ["ev-valid-1", "ev-valid-2"];

  const validResponseJson = JSON.stringify({
    summary: "Deterministic impact explanation.",
    claims: [{ text: "Payment service affected.", evidence_ids: ["ev-valid-1"] }],
    confidence: "high",
    caveats: [],
  });

  const invalidResponseJson = JSON.stringify({
    summary: "Impact explanation.",
    claims: [{ text: "Fabricated claim.", evidence_ids: ["ev-fabricated-999"] }],
    confidence: "high",
    caveats: [],
  });

  describe("buildValidationCorrectiveInstruction", () => {
    it("builds a bounded deterministic instruction containing error codes and paths", () => {
      const sampleErrors: ValidationIssue[] = [
        {
          category: "grounding",
          code: "UNKNOWN_EVIDENCE_ID",
          path: "claims[0].evidence_ids[0]",
          message: "Evidence ID does not exist in the allowed evidence manifest.",
        },
        {
          category: "schema",
          code: "UNRECOGNIZED_PROPERTY",
          path: "suggestions",
          message: "Unrecognized property 'suggestions' at root level.",
        },
      ];

      const instruction = buildValidationCorrectiveInstruction(sampleErrors);

      expect(instruction).toContain("UNKNOWN_EVIDENCE_ID");
      expect(instruction).toContain("claims[0].evidence_ids[0]");
      expect(instruction).toContain("UNRECOGNIZED_PROPERTY");
      expect(instruction).toContain("suggestions");
      expect(instruction).toContain("Return ONLY a single raw JSON object");
      expect(instruction).toContain("NEVER invent or fabricate evidence IDs");
    });

    it("never includes the raw model response in the corrective instruction", () => {
      const sampleErrors: ValidationIssue[] = [
        {
          category: "schema",
          code: "STRING_TOO_LONG",
          path: "summary",
          message: "Field 'summary' exceeds maximum length.",
        },
      ];

      const instruction = buildValidationCorrectiveInstruction(sampleErrors);
      expect(instruction).not.toContain("raw untrusted model content");
      expect(instruction).not.toContain(invalidResponseJson);
    });

    it("bounds the reported error list to MAX_CORRECTIVE_FEEDBACK_ISSUES (10) items", () => {
      const manyErrors: ValidationIssue[] = Array.from({ length: 25 }, (_, i) => ({
        category: "schema",
        code: `ERROR_${i}`,
        path: `field_${i}`,
        message: `Message ${i}`,
      }));

      const instruction = buildValidationCorrectiveInstruction(manyErrors);
      expect(instruction).toContain("ERROR_0");
      expect(instruction).toContain(`ERROR_${MAX_CORRECTIVE_FEEDBACK_ISSUES - 1}`);
      expect(instruction).not.toContain(`ERROR_${MAX_CORRECTIVE_FEEDBACK_ISSUES}`);
    });
  });

  describe("validateImpactExplanationWithRetry", () => {
    it("returns immediately on first attempt when initial response is valid (0 retries)", async () => {
      const retryCallback = vi.fn().mockResolvedValue(validResponseJson);

      const result = await validateImpactExplanationWithRetry({
        initialResponseText: validResponseJson,
        allowedEvidenceIds: allowedManifest,
        retry: retryCallback,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.attempts).toBe(1);
        expect(result.data.summary).toBe("Deterministic impact explanation.");
      }
      expect(retryCallback).not.toHaveBeenCalled();
    });

    it("performs exactly one retry when initial response is invalid and retry succeeds (2 attempts total)", async () => {
      const retryCallback = vi.fn().mockResolvedValue(validResponseJson);

      const result = await validateImpactExplanationWithRetry({
        initialResponseText: invalidResponseJson,
        allowedEvidenceIds: allowedManifest,
        retry: retryCallback,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.attempts).toBe(2);
      }
      expect(retryCallback).toHaveBeenCalledTimes(1);
      const firstCall = retryCallback.mock.calls[0];
      expect(firstCall).toBeDefined();
      const callArg = firstCall![0];
      expect(callArg.attemptNumber).toBe(2);
      expect(callArg.correctiveInstruction).toContain("UNKNOWN_EVIDENCE_ID");
      expect(callArg.validationErrors.length).toBeGreaterThan(0);
    });

    it("returns explicit failure when both initial and retry responses are invalid (2 attempts total)", async () => {
      const stillInvalidJson = JSON.stringify({
        summary: "Still invalid",
        claims: [{ text: "Still fake", evidence_ids: ["ev-still-fake"] }],
        confidence: "medium",
        caveats: [],
      });
      const retryCallback = vi.fn().mockResolvedValue(stillInvalidJson);

      const result = await validateImpactExplanationWithRetry({
        initialResponseText: invalidResponseJson,
        allowedEvidenceIds: allowedManifest,
        retry: retryCallback,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.attempts).toBe(2);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.some((e) => e.code === "UNKNOWN_EVIDENCE_ID")).toBe(true);
      }
      expect(retryCallback).toHaveBeenCalledTimes(1);
    });

    it("propagates provider exceptions without converting them to validation errors", async () => {
      const providerError = new Error("Anthropic API rate limit exceeded (429)");
      const retryCallback = vi.fn().mockRejectedValue(providerError);

      await expect(
        validateImpactExplanationWithRetry({
          initialResponseText: invalidResponseJson,
          allowedEvidenceIds: allowedManifest,
          retry: retryCallback,
        })
      ).rejects.toThrow("Anthropic API rate limit exceeded (429)");

      expect(retryCallback).toHaveBeenCalledTimes(1);
    });

    it("re-uses the exact original trusted evidence manifest on retry", async () => {
      const retryCallback = vi.fn().mockResolvedValue(validResponseJson);

      await validateImpactExplanationWithRetry({
        initialResponseText: invalidResponseJson,
        allowedEvidenceIds: allowedManifest,
        retry: retryCallback,
      });

      expect(retryCallback).toHaveBeenCalledTimes(1);
    });
  });
});
