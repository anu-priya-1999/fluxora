import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  SIMULATION_NARRATION_JOB_TYPE,
  type AIAnalysis,
  type Job,
} from "@fluxora/shared-types";

import { createDefaultJobHandlers } from "../handlers.ts";
import {
  createSimulationNarrationHandler,
  processSimulationNarrationJob,
  type SimulationNarrationDependencies,
} from "./narration-handler.ts";
import { IngestionError } from "../ingest/errors.ts";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const SIM_ID = "22222222-2222-4222-8222-222222222222";

function createMockJob(
  payload: Record<string, unknown>,
  type: string = SIMULATION_NARRATION_JOB_TYPE,
): Job {
  return {
    id: "job-sim-1",
    organizationId: ORG_ID,
    type: type as Job["type"],
    payload,
    status: "pending",
    idempotencyKey: `simulation.narration:${SIM_ID}`,
    attemptCount: 0,
    maxAttempts: 3,
    configuredMaxAttempts: 3,
    availableAt: new Date(),
    lockedAt: null,
    lockedBy: null,
    leaseExpiresAt: null,
    lastError: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    failedAt: null,
  };
}

function createMockAIAnalysis(overrides: Partial<AIAnalysis> = {}): AIAnalysis {
  return {
    id: "ai-sim-1",
    organizationId: ORG_ID,
    subjectType: "simulation",
    subjectId: SIM_ID,
    status: "completed",
    modelUsed: "claude-sonnet-5-5",
    promptVersion: "simulation-narrate-v1",
    inputEvidenceIds: ["ev-1", "ev-2"],
    outputText: "Simulated database failure caused downstream degradation.",
    outputStructured: {
      summary: "Simulated database failure caused downstream degradation.",
      claims: [{ text: "Target failed.", evidence_ids: ["ev-1"] }],
      confidence: "high",
      caveats: ["Synthetic scenario."],
    },
    validationStatus: "passed",
    tokenCount: 450,
    costUsd: 0.0035,
    latencyMs: 1200,
    errorMessage: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("Simulation Narration Worker Handler (Step 63)", () => {
  it("1. Successfully processes valid simulation narration job with tenant scope", async () => {
    let capturedOptions: { organizationId: string; simulationId: string } | null = null;

    const mockDeps: SimulationNarrationDependencies = {
      async orchestrateNarration(options) {
        capturedOptions = options;
        return {
          status: "completed",
          aiAnalysis: createMockAIAnalysis(),
        };
      },
    };

    const job = createMockJob({ simulationId: SIM_ID });
    const result = await processSimulationNarrationJob(job, mockDeps);

    assert.ok(result);
    assert.equal(result.status, "completed");
    assert.equal(capturedOptions!.organizationId, ORG_ID);
    assert.equal(capturedOptions!.simulationId, SIM_ID);
  });

  it("2. Returns null safely for empty payload without throwing", async () => {
    let invoked = false;
    const mockDeps: SimulationNarrationDependencies = {
      async orchestrateNarration() {
        invoked = true;
        return { status: "completed", aiAnalysis: createMockAIAnalysis() };
      },
    };

    const job = createMockJob({});
    const result = await processSimulationNarrationJob(job, mockDeps);

    assert.equal(result, null);
    assert.equal(invoked, false);
  });

  it("3. Rejects malformed payload with permanent IngestionError", async () => {
    const mockDeps: SimulationNarrationDependencies = {
      async orchestrateNarration() {
        return { status: "completed", aiAnalysis: createMockAIAnalysis() };
      },
    };

    const job = createMockJob({ simulationId: "not-a-valid-uuid" });
    await assert.rejects(
      processSimulationNarrationJob(job, mockDeps),
      (err) => err instanceof IngestionError && err.code === "invalid_payload",
    );
  });

  it("4. Failure isolation: AI provider failure is isolated and does not fail worker job", async () => {
    const mockDeps: SimulationNarrationDependencies = {
      async orchestrateNarration() {
        return {
          status: "failed",
          error: "Model provider rate limit 429",
          aiAnalysis: createMockAIAnalysis({ status: "failed", outputText: null, outputStructured: null }),
        };
      },
    };

    const job = createMockJob({ simulationId: SIM_ID });
    const result = await processSimulationNarrationJob(job, mockDeps);

    assert.ok(result);
    assert.equal(result.status, "failed");
    assert.equal(result.error, "Model provider rate limit 429");
  });

  it("5. Failure isolation: validation rejection is isolated and does not fail worker job", async () => {
    const mockDeps: SimulationNarrationDependencies = {
      async orchestrateNarration() {
        return {
          status: "rejected",
          errors: [
            {
              category: "grounding",
              code: "ungrounded_evidence_id",
              path: "claims[0].evidence_ids[0]",
              message: "Evidence ID ev-fabricated is not present in allowedEvidenceIds manifest",
            },
          ],
          aiAnalysis: createMockAIAnalysis({ status: "rejected", outputText: null, outputStructured: null }),
        };
      },
    };

    const job = createMockJob({ simulationId: SIM_ID });
    const result = await processSimulationNarrationJob(job, mockDeps);

    assert.ok(result);
    assert.equal(result.status, "rejected");
  });

  it("6. Failure isolation: unexpected thrown exception inside orchestrator is swallowed safely", async () => {
    const mockDeps: SimulationNarrationDependencies = {
      async orchestrateNarration() {
        throw new Error("Unexpected database connection drop");
      },
    };

    const job = createMockJob({ simulationId: SIM_ID });
    const result = await processSimulationNarrationJob(job, mockDeps);

    // Job handler isolates error so that deterministic simulation remains valid
    assert.equal(result, null);
  });

  it("7. Idempotency: repeated delivery of same simulation completion returns already_completed without regenerating", async () => {
    let callCount = 0;
    const existingAnalysis = createMockAIAnalysis();

    const mockDeps: SimulationNarrationDependencies = {
      async orchestrateNarration() {
        callCount++;
        return {
          status: "already_completed",
          aiAnalysis: existingAnalysis,
        };
      },
    };

    const job1 = createMockJob({ simulationId: SIM_ID });
    const result1 = await processSimulationNarrationJob(job1, mockDeps);
    assert.ok(result1);
    assert.equal(result1.status, "already_completed");

    const job2 = createMockJob({ simulationId: SIM_ID });
    const result2 = await processSimulationNarrationJob(job2, mockDeps);
    assert.ok(result2);
    assert.equal(result2.status, "already_completed");
    assert.equal(callCount, 2);
  });

  it("8. Handler rejects unexpected job type with permanent IngestionError", async () => {
    const mockDeps: SimulationNarrationDependencies = {
      async orchestrateNarration() {
        return { status: "completed", aiAnalysis: createMockAIAnalysis() };
      },
    };

    const handler = createSimulationNarrationHandler(mockDeps);
    const badJob = createMockJob({ simulationId: SIM_ID }, "unknown.type");

    await assert.rejects(
      handler(badJob),
      (err) => err instanceof IngestionError && err.code === "invalid_payload",
    );
  });

  it("9. Registry wiring: createDefaultJobHandlers registers simulation.narration", async () => {
    let handlerInvoked = false;
    const customHandler = async () => {
      handlerInvoked = true;
    };

    const handlers = createDefaultJobHandlers({
      ingestHandler: async () => {},
      simulationNarrationHandler: customHandler,
    });

    assert.ok(handlers[SIMULATION_NARRATION_JOB_TYPE]);
    await handlers[SIMULATION_NARRATION_JOB_TYPE]!(createMockJob({ simulationId: SIM_ID }));
    assert.equal(handlerInvoked, true);
  });
});
