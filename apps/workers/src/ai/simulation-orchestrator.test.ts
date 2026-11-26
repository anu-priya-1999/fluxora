import assert from "node:assert/strict";
import { describe, it } from "vitest";

import type { SaveAIAnalysisInput } from "@fluxora/db";
import type { AIAnalysis } from "@fluxora/shared-types";

import type { DatabasePool } from "./context/index.ts";
import {
  SIMULATION_NARRATION_PROMPT_VERSION,
  type SimulationNarrationContext,
} from "./simulation-context/index.ts";
import {
  orchestrateSimulationNarration,
  type SimulationNarrationOrchestratorDependencies,
} from "./simulation-orchestrator.ts";
import type { SimulationNarrationOutput } from "./structured-output/index.ts";
import type { ModelGateway, ModelGatewayRequest } from "./types.ts";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const SIM_ID = "22222222-2222-4222-8222-222222222222";

function createMockContext(): SimulationNarrationContext {
  return {
    simulationId: SIM_ID,
    scenarioId: "33333333-3333-4333-8333-333333333333",
    analysisRunId: "44444444-4444-4444-8444-444444444444",
    status: "completed",
    scenario: {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Simulate Redis Outage",
      targetNodeId: "node_redis",
      failureType: "unavailable",
      parameters: {},
    },
    results: [
      {
        nodeId: "node_redis",
        resultingState: "failed",
        ruleApplied: "target_failure",
        assumptions: [],
        confidence: 1.0,
        hopDistance: 0,
        capped: false,
        propagationPath: [],
        evidenceIds: ["ev_sim_1001"],
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
    allowedEvidenceIds: ["ev_sim_1001"],
    evidenceRecords: [
      {
        id: "ev_sim_1001",
        subjectType: "simulation_state",
        subjectId: "sr_01",
        filePath: "src/redis.ts",
        symbolId: null,
        lineStart: 1,
        lineEnd: 20,
        columnStart: 1,
        columnEnd: 1,
        relationshipDescription: "Redis node target failure",
        confidence: 1.0,
        nodeId: "node_redis",
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
  };
}

function createValidNarrationJson(): string {
  const payload: SimulationNarrationOutput = {
    summary: "Simulated unavailable Redis node caused cache lookup failure.",
    claims: [
      {
        text: "Redis is the direct target node of the simulation scenario.",
        evidence_ids: ["ev_sim_1001"],
      },
    ],
    confidence: "high",
    caveats: [
      "Simulated scenario based on static analysis, not live production telemetry.",
    ],
  };
  return JSON.stringify(payload);
}

function createMockGateway(responseTexts: string[]): ModelGateway & { readonly calls: ModelGatewayRequest[] } {
  const calls: ModelGatewayRequest[] = [];
  const queue = [...responseTexts];

  return {
    calls,
    async generate(req: ModelGatewayRequest) {
      calls.push(req);
      const text = queue.shift() ?? createValidNarrationJson();
      return {
        text,
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        taskType: req.taskType,
        promptVersion: req.promptVersion,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        costUsd: 0.001,
        latencyMs: 120,
        attemptCount: 1,
        usedFallback: false,
        providerRequestId: "req_123",
        stopReason: "end_turn",
        isMock: true,
        attempts: [],
      };
    },
  };
}

describe("Simulation Narration Orchestrator Service (Step 63)", () => {
  it("1. Successfully generates, validates, and persists grounded simulation narration", async () => {
    let savedInput: SaveAIAnalysisInput | null = null;
    const store = new Map<string, AIAnalysis>();

    const gateway = createMockGateway([createValidNarrationJson()]);

    const deps: SimulationNarrationOrchestratorDependencies = {
      pool: {} as unknown as DatabasePool,
      gateway,
      async loadContext() {
        return createMockContext();
      },
      async getAIAnalysisBySubject() {
        return null;
      },
      async saveAIAnalysis(_pool, input) {
        savedInput = input;
        const record: AIAnalysis = {
          id: input.id ?? "ai_sim_123",
          organizationId: input.organizationId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          status: input.status ?? "pending",
          modelUsed: input.modelUsed ?? null,
          promptVersion: input.promptVersion ?? null,
          inputEvidenceIds: input.inputEvidenceIds ?? [],
          outputText: input.outputText ?? null,
          outputStructured: input.outputStructured ?? null,
          validationStatus: input.validationStatus ?? null,
          tokenCount: input.tokenCount ?? 0,
          costUsd: input.costUsd ?? 0,
          latencyMs: input.latencyMs ?? 0,
          metadata: input.metadata ?? {},
          errorMessage: input.errorMessage ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        store.set(record.id, record);
        return record;
      },
    };

    const result = await orchestrateSimulationNarration(
      { organizationId: ORG_ID, simulationId: SIM_ID },
      deps,
    );

    assert.equal(result.status, "completed");
    assert.equal(result.aiAnalysis.status, "completed");
    assert.equal(result.aiAnalysis.validationStatus, "passed");
    assert.ok(result.aiAnalysis.outputText?.includes("Redis"));
    assert.equal(result.aiAnalysis.outputStructured?.claims.length, 1);
    assert.ok(savedInput);
    const saved = savedInput as SaveAIAnalysisInput;
    assert.equal(saved.tokenCount, 150);
    assert.equal(gateway.calls.length, 1);
  });

  it("2. Executes corrective retry when initial response fails validation, aggregating usage", async () => {
    const invalidInitial = '{"summary": "Invalid", "claims": [{"text": "ungrounded", "evidence_ids": ["ev_bad"]}]}';
    const validRetry = createValidNarrationJson();
    const gateway = createMockGateway([invalidInitial, validRetry]);

    const deps: SimulationNarrationOrchestratorDependencies = {
      pool: {} as unknown as DatabasePool,
      gateway,
      async loadContext() {
        return createMockContext();
      },
      async getAIAnalysisBySubject() {
        return null;
      },
      async saveAIAnalysis(_pool, input) {
        return {
          id: input.id ?? "ai_sim_123",
          organizationId: input.organizationId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          status: input.status ?? "pending",
          modelUsed: input.modelUsed ?? null,
          promptVersion: input.promptVersion ?? null,
          inputEvidenceIds: input.inputEvidenceIds ?? [],
          outputText: input.outputText ?? null,
          outputStructured: input.outputStructured ?? null,
          validationStatus: input.validationStatus ?? null,
          tokenCount: input.tokenCount ?? 0,
          costUsd: input.costUsd ?? 0,
          latencyMs: input.latencyMs ?? 0,
          metadata: input.metadata ?? {},
          errorMessage: input.errorMessage ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    };

    const result = await orchestrateSimulationNarration(
      { organizationId: ORG_ID, simulationId: SIM_ID },
      deps,
    );

    assert.equal(result.status, "completed");
    assert.equal(gateway.calls.length, 2);
    // Usage aggregated across both calls (150 tokens * 2 = 300)
    assert.equal(result.aiAnalysis.tokenCount, 300);
  });

  it("3. Persists rejected state without raw output when retry also fails validation", async () => {
    let finalSaveInput: SaveAIAnalysisInput | null = null;
    const invalid = '{"summary": "Invalid", "claims": [{"text": "ungrounded", "evidence_ids": ["ev_bad"]}]}';
    const gateway = createMockGateway([invalid, invalid]);

    const deps: SimulationNarrationOrchestratorDependencies = {
      pool: {} as unknown as DatabasePool,
      gateway,
      async loadContext() {
        return createMockContext();
      },
      async getAIAnalysisBySubject() {
        return null;
      },
      async saveAIAnalysis(_pool, input) {
        finalSaveInput = input;
        return {
          id: input.id ?? "ai_sim_123",
          organizationId: input.organizationId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          status: input.status ?? "pending",
          modelUsed: input.modelUsed ?? null,
          promptVersion: input.promptVersion ?? null,
          inputEvidenceIds: input.inputEvidenceIds ?? [],
          outputText: input.outputText ?? null,
          outputStructured: input.outputStructured ?? null,
          validationStatus: input.validationStatus ?? null,
          tokenCount: input.tokenCount ?? 0,
          costUsd: input.costUsd ?? 0,
          latencyMs: input.latencyMs ?? 0,
          metadata: input.metadata ?? {},
          errorMessage: input.errorMessage ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    };

    const result = await orchestrateSimulationNarration(
      { organizationId: ORG_ID, simulationId: SIM_ID },
      deps,
    );

    assert.equal(result.status, "rejected");
    assert.ok(finalSaveInput);
    const rejectedSave = finalSaveInput as SaveAIAnalysisInput;
    assert.equal(rejectedSave.status, "rejected");
    assert.equal(rejectedSave.validationStatus, "rejected");
    assert.equal(rejectedSave.outputText, null);
    assert.equal(rejectedSave.outputStructured, null);
    assert.ok(rejectedSave.errorMessage?.includes("Structured output validation failed"));
  });

  it("4. Persists failed state without leaking provider error credentials when gateway fails", async () => {
    let finalSaveInput: SaveAIAnalysisInput | null = null;
    const failingGateway: ModelGateway = {
      async generate() {
        throw new Error("Anthropic API error with key sk-ant-api03-secret12345678901234567890");
      },
    };

    const deps: SimulationNarrationOrchestratorDependencies = {
      pool: {} as unknown as DatabasePool,
      gateway: failingGateway,
      async loadContext() {
        return createMockContext();
      },
      async getAIAnalysisBySubject() {
        return null;
      },
      async saveAIAnalysis(_pool, input) {
        finalSaveInput = input;
        return {
          id: input.id ?? "ai_sim_123",
          organizationId: input.organizationId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          status: input.status ?? "pending",
          modelUsed: input.modelUsed ?? null,
          promptVersion: input.promptVersion ?? null,
          inputEvidenceIds: input.inputEvidenceIds ?? [],
          outputText: input.outputText ?? null,
          outputStructured: input.outputStructured ?? null,
          validationStatus: input.validationStatus ?? null,
          tokenCount: input.tokenCount ?? 0,
          costUsd: input.costUsd ?? 0,
          latencyMs: input.latencyMs ?? 0,
          metadata: input.metadata ?? {},
          errorMessage: input.errorMessage ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    };

    const result = await orchestrateSimulationNarration(
      { organizationId: ORG_ID, simulationId: SIM_ID },
      deps,
    );

    assert.equal(result.status, "failed");
    assert.ok(finalSaveInput);
    const failedSave = finalSaveInput as SaveAIAnalysisInput;
    assert.equal(failedSave.status, "failed");
    assert.ok(!failedSave.errorMessage?.includes("sk-ant-api03"));
    assert.ok(failedSave.errorMessage?.includes("[REDACTED_API_KEY]"));
  });

  it("5. Idempotency: reuses existing completed record without making gateway calls", async () => {
    const existingCompleted: AIAnalysis = {
      id: "ai_sim_existing",
      organizationId: ORG_ID,
      subjectType: "simulation",
      subjectId: SIM_ID,
      status: "completed",
      modelUsed: "claude-sonnet-5-5",
      promptVersion: SIMULATION_NARRATION_PROMPT_VERSION,
      inputEvidenceIds: ["ev_sim_1001"],
      outputText: "Existing completed summary",
      outputStructured: null,
      validationStatus: "passed",
      tokenCount: 150,
      costUsd: 0.001,
      latencyMs: 100,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let gatewayCalled = false;
    const gateway: ModelGateway = {
      async generate() {
        gatewayCalled = true;
        throw new Error("Should not be called");
      },
    };

    const deps: SimulationNarrationOrchestratorDependencies = {
      pool: {} as unknown as DatabasePool,
      gateway,
      async getAIAnalysisBySubject() {
        return existingCompleted;
      },
    };

    const result = await orchestrateSimulationNarration(
      { organizationId: ORG_ID, simulationId: SIM_ID },
      deps,
    );

    assert.equal(result.status, "already_completed");
    assert.equal(result.aiAnalysis.id, "ai_sim_existing");
    assert.equal(gatewayCalled, false);
  });

  it("6. Reuses existing rejected record unless forceRetry is true", async () => {
    const existingRejected: AIAnalysis = {
      id: "ai_sim_rejected",
      organizationId: ORG_ID,
      subjectType: "simulation",
      subjectId: SIM_ID,
      status: "rejected",
      modelUsed: "claude-sonnet-5-5",
      promptVersion: SIMULATION_NARRATION_PROMPT_VERSION,
      inputEvidenceIds: [],
      outputText: null,
      outputStructured: null,
      validationStatus: "rejected",
      tokenCount: 150,
      costUsd: 0.001,
      latencyMs: 100,
      metadata: { validationErrors: [] },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let gatewayCalled = false;
    const gateway: ModelGateway = {
      async generate() {
        gatewayCalled = true;
        return {
          text: createValidNarrationJson(),
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          taskType: "simulation_narration",
          promptVersion: SIMULATION_NARRATION_PROMPT_VERSION,
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          costUsd: 0.001,
          latencyMs: 100,
          attemptCount: 1,
          usedFallback: false,
          providerRequestId: null,
          stopReason: "end_turn",
          isMock: true,
          attempts: [],
        };
      },
    };

    const deps: SimulationNarrationOrchestratorDependencies = {
      pool: {} as unknown as DatabasePool,
      gateway,
      async getAIAnalysisBySubject() {
        return existingRejected;
      },
      async loadContext() {
        return createMockContext();
      },
      async saveAIAnalysis(_pool, input) {
        return {
          ...existingRejected,
          status: input.status ?? "completed",
        };
      },
    };

    // Without forceRetry
    const res1 = await orchestrateSimulationNarration(
      { organizationId: ORG_ID, simulationId: SIM_ID },
      deps,
    );
    assert.equal(res1.status, "rejected");
    assert.equal(gatewayCalled, false);

    // With forceRetry
    const res2 = await orchestrateSimulationNarration(
      { organizationId: ORG_ID, simulationId: SIM_ID, forceRetry: true },
      deps,
    );
    assert.equal(res2.status, "completed");
    assert.equal(gatewayCalled, true);
  });

  it("7. Concurrency protection: preserves completed status if won by another worker", async () => {
    const gateway = createMockGateway([createValidNarrationJson()]);

    const deps: SimulationNarrationOrchestratorDependencies = {
      pool: {} as unknown as DatabasePool,
      gateway,
      async loadContext() {
        throw new Error("Context load failed");
      },
      async getAIAnalysisBySubject() {
        return null;
      },
      async saveAIAnalysis() {
        // Another worker completed the record in the meantime!
        return {
          id: "ai_sim_won",
          organizationId: ORG_ID,
          subjectType: "simulation",
          subjectId: SIM_ID,
          status: "completed",
          modelUsed: "claude-sonnet-5-5",
          promptVersion: SIMULATION_NARRATION_PROMPT_VERSION,
          inputEvidenceIds: [],
          outputText: "Won by other worker",
          outputStructured: null,
          validationStatus: "passed",
          tokenCount: 100,
          costUsd: 0.001,
          latencyMs: 50,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    };

    const result = await orchestrateSimulationNarration(
      { organizationId: ORG_ID, simulationId: SIM_ID },
      deps,
    );

    assert.equal(result.status, "already_completed");
    assert.equal(result.aiAnalysis.id, "ai_sim_won");
  });
});
