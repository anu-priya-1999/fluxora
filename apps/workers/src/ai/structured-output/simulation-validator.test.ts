import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  SIMULATION_NARRATION_OUTPUT_SCHEMA_VERSION,
  VALIDATION_ERROR_CODES,
} from "./constants.ts";
import {
  validateSimulationNarrationOutput,
  validateSimulationNarrationWithRetry,
} from "./simulation-validator.ts";
import type {
  SimulationNarrationOutput,
  ValidationRetryContext,
} from "./types.ts";

const ALLOWED_EVIDENCE_IDS = ["ev_101", "ev_102", "ev_103"];

function createValidNarrationJson(overrides: Partial<SimulationNarrationOutput> = {}): string {
  const payload: SimulationNarrationOutput = {
    summary: "Simulated unavailability of PaymentService propagated failure to CheckoutService.",
    claims: [
      {
        text: "PaymentService is the primary failure target of the scenario.",
        evidence_ids: ["ev_101"],
      },
      {
        text: "CheckoutService degraded because payment dependency circuit breaker tripped.",
        evidence_ids: ["ev_102", "ev_103"],
      },
    ],
    confidence: "high",
    caveats: [
      "Simulated scenario based on static dependency graph, not observed production telemetry.",
    ],
    ...overrides,
  };
  return JSON.stringify(payload);
}

describe("Simulation Narration Structured Output Validator (Step 63)", () => {
  it("1. Validates valid JSON conforming strictly to simulation-narration-output-v1", () => {
    const raw = createValidNarrationJson();
    const result = validateSimulationNarrationOutput(raw, ALLOWED_EVIDENCE_IDS);

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.schemaVersion, SIMULATION_NARRATION_OUTPUT_SCHEMA_VERSION);
      assert.ok(result.data.summary.includes("PaymentService"));
      assert.equal(result.data.claims.length, 2);
      assert.equal(result.data.confidence, "high");
      assert.equal(result.data.caveats.length, 1);
    }
  });

  it("2. Permits an empty claims array when no findings are cited", () => {
    const raw = createValidNarrationJson({ claims: [] });
    const result = validateSimulationNarrationOutput(raw, ALLOWED_EVIDENCE_IDS);

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.claims.length, 0);
    }
  });

  it("3. Rejects markdown code fences without permissive extraction", () => {
    const raw = `\`\`\`json\n${createValidNarrationJson()}\n\`\`\``;
    const result = validateSimulationNarrationOutput(raw, ALLOWED_EVIDENCE_IDS);

    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.errors[0]?.code, VALIDATION_ERROR_CODES.MARKDOWN_CODE_FENCE_DETECTED);
    }
  });

  it("4. Rejects unrecognized properties at root level", () => {
    const rawObj = JSON.parse(createValidNarrationJson());
    rawObj.hallucinated_field = "extra";
    const result = validateSimulationNarrationOutput(JSON.stringify(rawObj), ALLOWED_EVIDENCE_IDS);

    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.errors.some((e) => e.code === VALIDATION_ERROR_CODES.UNRECOGNIZED_PROPERTY));
    }
  });

  it("5. Rejects unrecognized properties inside claims", () => {
    const rawObj = JSON.parse(createValidNarrationJson());
    rawObj.claims[0].extra_claim_prop = 123;
    const result = validateSimulationNarrationOutput(JSON.stringify(rawObj), ALLOWED_EVIDENCE_IDS);

    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.errors.some((e) => e.code === VALIDATION_ERROR_CODES.UNRECOGNIZED_PROPERTY));
    }
  });

  it("6. Rejects empty evidence_ids array on a claim", () => {
    const raw = createValidNarrationJson({
      claims: [
        {
          text: "Unbacked claim without citations.",
          evidence_ids: [],
        },
      ],
    });
    const result = validateSimulationNarrationOutput(raw, ALLOWED_EVIDENCE_IDS);

    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.errors.some((e) => e.code === VALIDATION_ERROR_CODES.EMPTY_EVIDENCE_IDS));
    }
  });

  it("7. Rejects duplicate evidence IDs within the same claim", () => {
    const raw = createValidNarrationJson({
      claims: [
        {
          text: "Claim with duplicate citations.",
          evidence_ids: ["ev_101", "ev_101"],
        },
      ],
    });
    const result = validateSimulationNarrationOutput(raw, ALLOWED_EVIDENCE_IDS);

    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.errors.some((e) => e.code === VALIDATION_ERROR_CODES.DUPLICATE_EVIDENCE_ID));
    }
  });

  it("8. Rejects citations outside the trusted allowed evidence manifest", () => {
    const raw = createValidNarrationJson({
      claims: [
        {
          text: "Claim with fabricated evidence ID.",
          evidence_ids: ["ev_fabricated_999"],
        },
      ],
    });
    const result = validateSimulationNarrationOutput(raw, ALLOWED_EVIDENCE_IDS);

    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.errors.some((e) => e.code === VALIDATION_ERROR_CODES.UNKNOWN_EVIDENCE_ID));
    }
  });

  it("9. Enforces whole-response rejection if even one citation is ungrounded", () => {
    const raw = createValidNarrationJson({
      claims: [
        {
          text: "Valid grounded claim.",
          evidence_ids: ["ev_101"],
        },
        {
          text: "Ungrounded claim.",
          evidence_ids: ["ev_fabricated_999"],
        },
      ],
    });
    const result = validateSimulationNarrationOutput(raw, ALLOWED_EVIDENCE_IDS);

    assert.equal(result.success, false);
    if (!result.success) {
      // Entire response rejected, not partially accepted
      assert.ok(result.errors.some((e) => e.code === VALIDATION_ERROR_CODES.UNKNOWN_EVIDENCE_ID));
    }
  });

  it("10. validateSimulationNarrationWithRetry succeeds in 1 attempt when initial response is valid", async () => {
    let retryCalled = false;
    const result = await validateSimulationNarrationWithRetry({
      initialResponseText: createValidNarrationJson(),
      allowedEvidenceIds: ALLOWED_EVIDENCE_IDS,
      retry: async () => {
        retryCalled = true;
        return "";
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.attempts, 1);
    assert.equal(retryCalled, false);
  });

  it("11. validateSimulationNarrationWithRetry performs corrective retry when initial response fails", async () => {
    let retryContext: ValidationRetryContext | null = null;
    const invalidInitial = createValidNarrationJson({
      claims: [
        {
          text: "Ungrounded claim.",
          evidence_ids: ["ev_fabricated_999"],
        },
      ],
    });
    const validRetry = createValidNarrationJson();

    const result = await validateSimulationNarrationWithRetry({
      initialResponseText: invalidInitial,
      allowedEvidenceIds: ALLOWED_EVIDENCE_IDS,
      retry: async (ctx) => {
        retryContext = ctx;
        return validRetry;
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.attempts, 2);
    assert.ok(retryContext !== null);
    const captured = retryContext as unknown as ValidationRetryContext;
    assert.equal(captured.attemptNumber, 2);
    assert.ok(captured.correctiveInstruction.includes("UNKNOWN_EVIDENCE_ID"));
  });

  it("12. validateSimulationNarrationWithRetry strictly halts at 2 attempts on persistent validation failure", async () => {
    let retryCalls = 0;
    const invalidResponse = "not valid json";

    const result = await validateSimulationNarrationWithRetry({
      initialResponseText: invalidResponse,
      allowedEvidenceIds: ALLOWED_EVIDENCE_IDS,
      retry: async () => {
        retryCalls++;
        return invalidResponse;
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.attempts, 2);
    assert.equal(retryCalls, 1);
  });

  it("13. Provider exceptions thrown in retry propagate directly without being caught as validation errors", async () => {
    const invalidInitial = "invalid json";

    await assert.rejects(
      validateSimulationNarrationWithRetry({
        initialResponseText: invalidInitial,
        allowedEvidenceIds: ALLOWED_EVIDENCE_IDS,
        retry: async () => {
          throw new Error("Provider rate limit 429");
        },
      }),
      (err) => err instanceof Error && err.message.includes("Provider rate limit 429"),
    );
  });
});
