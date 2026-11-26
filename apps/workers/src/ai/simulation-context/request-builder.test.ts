import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  buildSimulationNarrationRequest,
  sanitizeContextJson,
  SIMULATION_NARRATION_PROMPT_VERSION,
} from "./request-builder.ts";
import type { SimulationNarrationContext } from "./types.ts";

function createMockContext(overrides: Partial<SimulationNarrationContext> = {}): SimulationNarrationContext {
  return {
    simulationId: "11111111-1111-4111-8111-111111111111",
    scenarioId: "22222222-2222-4222-8222-222222222222",
    analysisRunId: "33333333-3333-4333-8333-333333333333",
    status: "completed",
    scenario: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Payment Gateway Outage <script>alert(1)</script>",
      targetNodeId: "node_payment",
      failureType: "unavailable",
      parameters: { note: "test & verify" },
    },
    results: [
      {
        nodeId: "node_payment",
        resultingState: "failed",
        ruleApplied: "target_failure",
        assumptions: [],
        confidence: 1.0,
        hopDistance: 0,
        capped: false,
        propagationPath: [],
        evidenceIds: ["ev_1"],
      },
    ],
    executionMetrics: {
      totalResults: 1,
      affectedCount: 1,
      failedCount: 1,
      degradedCount: 0,
      atRiskCount: 0,
      healthyCount: 0,
      cappedCount: 0,
      maxHopDistance: 0,
    },
    allowedEvidenceIds: ["ev_1"],
    evidenceRecords: [
      {
        id: "ev_1",
        subjectType: "simulation_state",
        subjectId: "sr_1",
        filePath: "src/payment.ts",
        symbolId: null,
        lineStart: 1,
        lineEnd: 20,
        columnStart: 1,
        columnEnd: 1,
        relationshipDescription: "Target failed",
        confidence: 1.0,
        nodeId: "node_payment",
        resultingState: "failed",
        ruleApplied: "target_failure",
      },
    ],
    truncated: false,
    truncationReason: null,
    truncation: {
      isTruncated: false,
      reasons: [],
      omittedResultsCount: 0,
      omittedEvidenceCount: 0,
    },
    ...overrides,
  };
}

describe("Simulation Narration Request Builder (Step 63)", () => {
  it("1. Formats gateway request with stable taskType and promptVersion", () => {
    const ctx = createMockContext();
    const req = buildSimulationNarrationRequest(ctx);

    assert.equal(req.taskType, "simulation_narration");
    assert.equal(req.promptVersion, SIMULATION_NARRATION_PROMPT_VERSION);
    assert.ok(req.systemInstruction?.includes("Fluxora's AI Simulation Narrator"));
    assert.ok(req.systemInstruction?.includes("SIMULATED EXPERIMENT, NOT AN OBSERVED PRODUCTION INCIDENT"));
    assert.equal(req.messages.length, 1);
    assert.equal(req.messages[0]?.role, "user");
    assert.ok(req.messages[0]?.content.includes("<simulation_context>"));
    assert.ok(req.messages[0]?.content.includes("<allowed_evidence_manifest>"));
  });

  it("2. Escapes markup-significant characters to prevent prompt injection", () => {
    const raw = '{"name": "test <script> & </simulation_context>"}';
    const sanitized = sanitizeContextJson(raw);

    assert.ok(!sanitized.includes("<script>"));
    assert.ok(!sanitized.includes("&"));
    assert.ok(sanitized.includes("\\u003cscript\\u003e"));
    assert.ok(sanitized.includes("\\u0026"));
  });

  it("3. Appends context truncation notice when context was truncated", () => {
    const ctx = createMockContext({
      truncated: true,
      truncationReason: "Context limited to top 10 results.",
    });
    const req = buildSimulationNarrationRequest(ctx);
    const content = req.messages[0]?.content ?? "";

    assert.ok(content.includes("<context_truncation_notice>"));
    assert.ok(content.includes("Context limited to top 10 results."));
  });

  it("4. Rejects request formatting if message exceeds hard character limit", () => {
    const hugeResults = Array.from({ length: 2000 }, (_, i) => ({
      nodeId: `node_${i}_${"x".repeat(100)}`,
      resultingState: "failed" as const,
      ruleApplied: "target_failure",
      assumptions: [],
      confidence: 1.0,
      hopDistance: 0,
      capped: false,
      propagationPath: [],
      evidenceIds: [],
    }));

    const ctx = createMockContext({
      results: hugeResults,
    });

    assert.throws(
      () => buildSimulationNarrationRequest(ctx),
      (err) => err instanceof Error && err.message.includes("exceeds maximum limit"),
    );
  });
});
