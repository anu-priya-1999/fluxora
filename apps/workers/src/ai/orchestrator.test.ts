import assert from "node:assert/strict";
import { describe, it } from "vitest";

import type { AIAnalysis } from "@fluxora/shared-types";

import {
  IMPACT_EXPLANATION_PROMPT_VERSION,
  type ImpactExplanationContext,
} from "./context/index.ts";
import {
  orchestrateImpactExplanation,
  type AIExplanationOrchestratorDependencies,
} from "./orchestrator.ts";
import type { ImpactExplanationOutput } from "./structured-output/index.ts";
import type { ModelGateway, ModelGatewayRequest } from "./types.ts";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const IMPACT_ID = "22222222-2222-4222-8222-222222222222";

function createMockContext(): ImpactExplanationContext {
  return {
    impactAnalysisId: IMPACT_ID,
    analysisRunId: "33333333-3333-4333-8333-333333333333",
    pullRequestId: "44444444-4444-4444-8444-444444444444",
    status: "completed",
    directImpact: [
      {
        nodeId: "node_payment",
        name: "PaymentService",
        nodeType: "service",
        filePath: "src/payment.ts",
        depth: 0,
        confidence: 1.0,
        path: ["node_payment"],
        evidenceIds: ["ev_1001"],
      },
    ],
    downstreamImpact: [],
    affectedApis: [],
    affectedEvents: [],
    affectedServices: [],
    workflowImpactSummary: [],
    unresolvedFiles: [],
    executionMetrics: {
      totalSeedNodes: 1,
      totalAffectedNodes: 1,
      totalEdgesTraversed: 0,
      durationMs: 10,
      maxDepthReached: 0,
    },
    truncated: false,
    truncationReason: null,
    truncation: {
      isTruncated: false,
      analysisWasTruncated: false,
      analysisTruncationReason: null,
      contextLimitsExceeded: false,
      reasons: [],
      omittedFindingsCount: 0,
      omittedEvidenceCount: 0,
      omittedUnresolvedFilesCount: 0,
    },
    evidenceRecords: [
      {
        id: "ev_1001",
        subjectType: "impact_finding",
        subjectId: "node_payment",
        filePath: "src/payment.ts",
        symbolId: null,
        lineStart: 10,
        lineEnd: 25,
        columnStart: null,
        columnEnd: null,
        relationshipDescription: "direct change",
        confidence: 1.0,
      },
    ],
    allowedEvidenceIds: ["ev_1001"],
  };
}

describe("AI Explanation Orchestrator (Step 62)", () => {
  it("executes successful generation and validation on initial attempt without retries", async () => {
    let capturedRequest: ModelGatewayRequest | null = null;
    let savedRecord: Record<string, unknown> | null = null;

    const validOutput: ImpactExplanationOutput = {
      summary: "Direct change to PaymentService.",
      claims: [
        {
          text: "PaymentService was directly modified.",
          evidence_ids: ["ev_1001"],
        },
      ],
      confidence: "high",
      caveats: [],
    };

    const mockGateway: ModelGateway = {
      async generate(request) {
        capturedRequest = request;
        return {
          text: JSON.stringify(validOutput),
          provider: "mock",
          model: "mock-sonnet",
          taskType: "impact_explanation",
          promptVersion: IMPACT_EXPLANATION_PROMPT_VERSION,
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          costUsd: 0.001,
          latencyMs: 300,
          attemptCount: 1,
          usedFallback: false,
          providerRequestId: "req-1",
          stopReason: "end_turn",
          isMock: true,
          attempts: [],
        };
      },
    };

    const deps: AIExplanationOrchestratorDependencies = {
      pool: {} as unknown as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
      gateway: mockGateway,
      loadContext: async () => createMockContext(),
      saveAIAnalysis: async (_pool, input) => {
        savedRecord = input as unknown as Record<string, unknown>;
        return {
          id: "ai-record-1",
          organizationId: input.organizationId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          status: input.status ?? "completed",
          modelUsed: input.modelUsed ?? "mock-sonnet",
          promptVersion: input.promptVersion ?? IMPACT_EXPLANATION_PROMPT_VERSION,
          inputEvidenceIds: input.inputEvidenceIds ?? [],
          outputText: input.outputText ?? null,
          outputStructured: input.outputStructured ?? null,
          validationStatus: input.validationStatus ?? null,
          tokenCount: input.tokenCount ?? 0,
          costUsd: input.costUsd ?? 0,
          latencyMs: input.latencyMs ?? 0,
          metadata: input.metadata,
          errorMessage: input.errorMessage ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
      getAIAnalysisBySubject: async () => null,
    };

    const result = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      deps,
    );

    assert.equal(result.status, "completed");
    const req = capturedRequest as ModelGatewayRequest | null;
    assert.ok(req);
    assert.equal(req.taskType, "impact_explanation");
    assert.equal(req.promptVersion, "impact-explain-v1");
    const rec = savedRecord as Record<string, unknown> | null;
    assert.ok(rec);
    assert.equal(rec["status"], "completed");
    assert.equal(rec["validationStatus"], "passed");
    assert.equal(rec["outputText"], validOutput.summary);
    assert.deepEqual(rec["outputStructured"], validOutput);
    assert.equal(rec["tokenCount"], 150);
    assert.equal(rec["latencyMs"], 300);
  });

  it("triggers bounded corrective retry when initial response fails validation, and succeeds on retry", async () => {
    let callCount = 0;
    const requestsReceived: ModelGatewayRequest[] = [];

    const validOutput: ImpactExplanationOutput = {
      summary: "Direct change to PaymentService after retry.",
      claims: [
        {
          text: "PaymentService was directly modified.",
          evidence_ids: ["ev_1001"],
        },
      ],
      confidence: "high",
      caveats: ["Corrected citation on attempt 2."],
    };

    const mockGateway: ModelGateway = {
      async generate(request) {
        callCount++;
        requestsReceived.push(request);
        if (callCount === 1) {
          // Initial response is ungrounded (cites unknown ID)
          return {
            text: JSON.stringify({
              summary: "Direct change to PaymentService.",
              claims: [
                {
                  text: "PaymentService was directly modified.",
                  evidence_ids: ["ev_fabricated_999"],
                },
              ],
              confidence: "high",
              caveats: [],
            }),
            provider: "mock",
            model: "mock-sonnet",
            taskType: "impact_explanation",
            promptVersion: IMPACT_EXPLANATION_PROMPT_VERSION,
            inputTokens: 100,
            outputTokens: 40,
            totalTokens: 140,
            costUsd: 0.001,
            latencyMs: 250,
            attemptCount: 1,
            usedFallback: false,
            providerRequestId: "req-1",
            stopReason: "end_turn",
            isMock: true,
            attempts: [],
          };
        }
        // Corrective response succeeds
        return {
          text: JSON.stringify(validOutput),
          provider: "mock",
          model: "mock-sonnet",
          taskType: "impact_explanation",
          promptVersion: IMPACT_EXPLANATION_PROMPT_VERSION,
          inputTokens: 180,
          outputTokens: 60,
          totalTokens: 240,
          costUsd: 0.002,
          latencyMs: 350,
          attemptCount: 1,
          usedFallback: false,
          providerRequestId: "req-2",
          stopReason: "end_turn",
          isMock: true,
          attempts: [],
        };
      },
    };

    let finalSaved: Record<string, unknown> | null = null;
    const deps: AIExplanationOrchestratorDependencies = {
      pool: {} as unknown as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
      gateway: mockGateway,
      loadContext: async () => createMockContext(),
      saveAIAnalysis: async (_pool, input) => {
        finalSaved = input as unknown as Record<string, unknown>;
        return {
          id: "ai-record-2",
          organizationId: input.organizationId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          status: input.status ?? "completed",
          modelUsed: input.modelUsed ?? "mock-sonnet",
          promptVersion: input.promptVersion ?? IMPACT_EXPLANATION_PROMPT_VERSION,
          inputEvidenceIds: input.inputEvidenceIds ?? [],
          outputText: input.outputText ?? null,
          outputStructured: input.outputStructured ?? null,
          validationStatus: input.validationStatus ?? null,
          tokenCount: input.tokenCount ?? 0,
          costUsd: input.costUsd ?? 0,
          latencyMs: input.latencyMs ?? 0,
          metadata: input.metadata,
          errorMessage: input.errorMessage ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
      getAIAnalysisBySubject: async () => null,
    };

    const result = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      deps,
    );

    assert.equal(result.status, "completed");
    assert.equal(callCount, 2, "Must call gateway exactly twice (initial + 1 retry)");
    assert.ok(
      requestsReceived[1]!.systemInstruction?.includes("Your previous response failed"),
      "Retry request must contain corrective instructions appended",
    );
    // Aggregate tokens & cost across both calls: (140 + 240) = 380 total tokens, 600ms latency
    const rec = finalSaved as Record<string, unknown> | null;
    assert.ok(rec);
    assert.equal(rec["tokenCount"], 380);
    assert.equal(rec["latencyMs"], 600);
    assert.equal(rec["status"], "completed");
    assert.equal(rec["validationStatus"], "passed");
  });

  it("records validation rejection without raw model text when corrective retry also fails", async () => {
    const invalidText = JSON.stringify({
      summary: "Still ungrounded",
      claims: [{ text: "Bad claim", evidence_ids: ["ev_unknown"] }],
      confidence: "high",
      caveats: [],
    });

    const mockGateway: ModelGateway = {
      async generate() {
        return {
          text: invalidText,
          provider: "mock",
          model: "mock-sonnet",
          taskType: "impact_explanation",
          promptVersion: IMPACT_EXPLANATION_PROMPT_VERSION,
          inputTokens: 100,
          outputTokens: 40,
          totalTokens: 140,
          costUsd: 0.001,
          latencyMs: 200,
          attemptCount: 1,
          usedFallback: false,
          providerRequestId: "req-err",
          stopReason: "end_turn",
          isMock: true,
          attempts: [],
        };
      },
    };

    let rejectedSave: Record<string, unknown> | null = null;
    const deps: AIExplanationOrchestratorDependencies = {
      pool: {} as unknown as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
      gateway: mockGateway,
      loadContext: async () => createMockContext(),
      saveAIAnalysis: async (_pool, input) => {
        rejectedSave = input as unknown as Record<string, unknown>;
        return {
          id: "ai-record-3",
          organizationId: input.organizationId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          status: input.status ?? "rejected",
          modelUsed: input.modelUsed ?? "mock-sonnet",
          promptVersion: input.promptVersion ?? IMPACT_EXPLANATION_PROMPT_VERSION,
          inputEvidenceIds: input.inputEvidenceIds ?? [],
          outputText: input.outputText ?? null,
          outputStructured: input.outputStructured ?? null,
          validationStatus: input.validationStatus ?? null,
          tokenCount: input.tokenCount ?? 0,
          costUsd: input.costUsd ?? 0,
          latencyMs: input.latencyMs ?? 0,
          metadata: input.metadata,
          errorMessage: input.errorMessage ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
      getAIAnalysisBySubject: async () => null,
    };

    const result = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      deps,
    );

    assert.equal(result.status, "rejected");
    assert.ok(result.errors.length > 0);
    const rec = rejectedSave as Record<string, unknown> | null;
    assert.ok(rec);
    assert.equal(rec["status"], "rejected");
    assert.equal(rec["validationStatus"], "rejected");
    assert.equal(rec["outputText"], null, "Raw text must not be persisted on rejection");
    assert.equal(rec["outputStructured"], null, "Structured output must not be persisted on rejection");
    assert.ok(rec["metadata"]);
  });

  it("records failure when model gateway throws an exception without failing caller", async () => {
    const mockGateway: ModelGateway = {
      async generate() {
        throw new Error("Provider rate limit exceeded (HTTP 429) sk-secret12345678901234567890");
      },
    };

    let failedSave: Record<string, unknown> | null = null;
    const deps: AIExplanationOrchestratorDependencies = {
      pool: {} as unknown as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
      gateway: mockGateway,
      loadContext: async () => createMockContext(),
      saveAIAnalysis: async (_pool, input) => {
        failedSave = input as unknown as Record<string, unknown>;
        return {
          id: "ai-record-4",
          organizationId: input.organizationId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          status: input.status ?? "failed",
          modelUsed: input.modelUsed ?? null,
          promptVersion: input.promptVersion ?? IMPACT_EXPLANATION_PROMPT_VERSION,
          inputEvidenceIds: input.inputEvidenceIds ?? [],
          outputText: null,
          outputStructured: null,
          validationStatus: null,
          tokenCount: 0,
          costUsd: 0,
          latencyMs: 0,
          errorMessage: input.errorMessage ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
      getAIAnalysisBySubject: async () => null,
    };

    const result = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      deps,
    );

    assert.equal(result.status, "failed");
    assert.ok(result.error);
    assert.ok(!result.error.includes("sk-secret"), "Secrets must be redacted from error messages");
    const rec = failedSave as Record<string, unknown> | null;
    assert.ok(rec);
    assert.equal(rec["status"], "failed");
    assert.equal(rec["outputText"], null);
    assert.equal(rec["outputStructured"], null);
  });

  it("handles idempotency: returns existing record without generating when already completed", async () => {
    let gatewayCalled = false;
    const existingRecord: AIAnalysis = {
      id: "ai-existing-1",
      organizationId: ORG_ID,
      subjectType: "impact_analysis",
      subjectId: IMPACT_ID,
      status: "completed",
      modelUsed: "mock-sonnet",
      promptVersion: "impact-explain-v1",
      inputEvidenceIds: ["ev_1001"],
      outputText: "Cached summary",
      outputStructured: {
        summary: "Cached summary",
        claims: [{ text: "Claim 1", evidence_ids: ["ev_1001"] }],
        confidence: "high",
        caveats: [],
      },
      validationStatus: "passed",
      tokenCount: 150,
      costUsd: 0.001,
      latencyMs: 300,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const deps: AIExplanationOrchestratorDependencies = {
      pool: {} as unknown as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
      gateway: {
        async generate() {
          gatewayCalled = true;
          throw new Error("Should not be called");
        },
      },
      getAIAnalysisBySubject: async () => existingRecord,
    };

    const result = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      deps,
    );

    assert.equal(result.status, "already_completed");
    assert.equal(result.aiAnalysis.id, "ai-existing-1");
    assert.equal(gatewayCalled, false, "Model Gateway must NOT be called for completed records");
  });

  it("handles idempotency: returns existing rejected record without regenerating unless forceRetry is set", async () => {
    let gatewayCalled = false;
    const existingRejected: AIAnalysis = {
      id: "ai-rejected-1",
      organizationId: ORG_ID,
      subjectType: "impact_analysis",
      subjectId: IMPACT_ID,
      status: "rejected",
      modelUsed: "mock-sonnet",
      promptVersion: "impact-explain-v1",
      inputEvidenceIds: ["ev_1001"],
      outputText: null,
      outputStructured: null,
      validationStatus: "rejected",
      tokenCount: 200,
      costUsd: 0.001,
      latencyMs: 400,
      metadata: {
        validationErrors: [{ code: "UNKNOWN_EVIDENCE_ID", path: "claims[0].evidence_ids[0]" }],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const deps: AIExplanationOrchestratorDependencies = {
      pool: {} as unknown as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
      gateway: {
        async generate() {
          gatewayCalled = true;
          throw new Error("Should not be called");
        },
      },
      getAIAnalysisBySubject: async () => existingRejected,
    };

    const result = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      deps,
    );

    assert.equal(result.status, "rejected");
    assert.equal(result.aiAnalysis?.id, "ai-rejected-1");
    assert.equal(gatewayCalled, false, "Gateway must not be called when rejected record exists and forceRetry is false");

    // When forceRetry is true, gateway is invoked
    let forceGatewayCalled = false;
    const forceDeps: AIExplanationOrchestratorDependencies = {
      pool: {} as unknown as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
      gateway: {
        async generate() {
          forceGatewayCalled = true;
          return {
            text: JSON.stringify({
              summary: "Forced retry summary",
              claims: [{ text: "Valid claim", evidence_ids: ["ev_1001"] }],
              confidence: "high",
              caveats: [],
            }),
            provider: "mock",
            model: "mock-sonnet",
            taskType: "impact_explanation",
            promptVersion: IMPACT_EXPLANATION_PROMPT_VERSION,
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            costUsd: 0.001,
            latencyMs: 300,
            attemptCount: 1,
            usedFallback: false,
            providerRequestId: "req-force",
            stopReason: "end_turn",
            isMock: true,
            attempts: [],
          };
        },
      },
      loadContext: async () => createMockContext(),
      saveAIAnalysis: async (_pool, input) => ({
        id: "ai-rejected-1",
        organizationId: input.organizationId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        status: input.status ?? "completed",
        modelUsed: input.modelUsed ?? "mock-sonnet",
        promptVersion: input.promptVersion ?? IMPACT_EXPLANATION_PROMPT_VERSION,
        inputEvidenceIds: input.inputEvidenceIds ?? [],
        outputText: input.outputText ?? null,
        outputStructured: input.outputStructured ?? null,
        validationStatus: input.validationStatus ?? null,
        tokenCount: input.tokenCount ?? 0,
        costUsd: input.costUsd ?? 0,
        latencyMs: input.latencyMs ?? 0,
        metadata: input.metadata,
        errorMessage: input.errorMessage ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      getAIAnalysisBySubject: async () => existingRejected,
    };

    const forceResult = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID, forceRetry: true },
      forceDeps,
    );
    assert.equal(forceResult.status, "completed");
    assert.equal(forceGatewayCalled, true, "Gateway must be called when forceRetry is true");
  });

  it("safely handles database persistence failure without throwing to caller", async () => {
    const deps: AIExplanationOrchestratorDependencies = {
      pool: {} as unknown as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
      gateway: {
        async generate() {
          return {
            text: JSON.stringify({
              summary: "Valid summary",
              claims: [{ text: "Valid claim", evidence_ids: ["ev_1001"] }],
              confidence: "high",
              caveats: [],
            }),
            provider: "mock",
            model: "mock-sonnet",
            taskType: "impact_explanation",
            promptVersion: IMPACT_EXPLANATION_PROMPT_VERSION,
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            costUsd: 0.001,
            latencyMs: 300,
            attemptCount: 1,
            usedFallback: false,
            providerRequestId: "req-db-err",
            stopReason: "end_turn",
            isMock: true,
            attempts: [],
          };
        },
      },
      loadContext: async () => createMockContext(),
      saveAIAnalysis: async () => {
        throw new Error("PostgreSQL connection terminated unexpectedly (57P01)");
      },
      getAIAnalysisBySubject: async () => null,
    };

    // Must NOT throw; must return typed failed result safely
    const result = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      deps,
    );

    assert.equal(result.status, "failed");
    assert.ok(result.error.includes("PostgreSQL connection terminated"));
  });

  it("safely reuses existing pending record without emitting redundant database writes", async () => {
    let saveCount = 0;
    const existingPending: AIAnalysis = {
      id: "ai-pending-1",
      organizationId: ORG_ID,
      subjectType: "impact_analysis",
      subjectId: IMPACT_ID,
      status: "pending",
      modelUsed: null,
      promptVersion: "impact-explain-v1",
      inputEvidenceIds: [],
      outputText: null,
      outputStructured: null,
      validationStatus: null,
      tokenCount: 0,
      costUsd: 0,
      latencyMs: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const deps: AIExplanationOrchestratorDependencies = {
      pool: {} as unknown as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
      gateway: {
        async generate() {
          return {
            text: JSON.stringify({
              summary: "Valid summary",
              claims: [{ text: "Valid claim", evidence_ids: ["ev_1001"] }],
              confidence: "high",
              caveats: [],
            }),
            provider: "mock",
            model: "mock-sonnet",
            taskType: "impact_explanation",
            promptVersion: IMPACT_EXPLANATION_PROMPT_VERSION,
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            costUsd: 0.001,
            latencyMs: 300,
            attemptCount: 1,
            usedFallback: false,
            providerRequestId: "req-pending-reuse",
            stopReason: "end_turn",
            isMock: true,
            attempts: [],
          };
        },
      },
      loadContext: async () => createMockContext(),
      saveAIAnalysis: async (_pool, input) => {
        saveCount++;
        return {
          id: "ai-pending-1",
          organizationId: input.organizationId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          status: input.status ?? "completed",
          modelUsed: input.modelUsed ?? "mock-sonnet",
          promptVersion: input.promptVersion ?? IMPACT_EXPLANATION_PROMPT_VERSION,
          inputEvidenceIds: input.inputEvidenceIds ?? [],
          outputText: input.outputText ?? null,
          outputStructured: input.outputStructured ?? null,
          validationStatus: input.validationStatus ?? null,
          tokenCount: input.tokenCount ?? 0,
          costUsd: input.costUsd ?? 0,
          latencyMs: input.latencyMs ?? 0,
          metadata: input.metadata,
          errorMessage: input.errorMessage ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
      getAIAnalysisBySubject: async () => existingPending,
    };

    const result = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      deps,
    );

    assert.equal(result.status, "completed");
    // saveCount must be exactly 1 (final completed save), because pending was reused!
    assert.equal(saveCount, 1, "Must reuse existing pending record rather than performing redundant pending save");
  });

  it("handles concurrent worker execution: competing simultaneous workers invoke gateway and preserve completed result", async () => {
    let gatewayInvocationCount = 0;
    let storedRecord: AIAnalysis | null = null;

    // Simulate in-memory database with the real ON CONFLICT CASE preservation logic from Migration 0028
    const mockSave: NonNullable<AIExplanationOrchestratorDependencies["saveAIAnalysis"]> = async (
      _pool,
      input,
    ) => {
      if (
        storedRecord &&
        storedRecord.status === "completed" &&
        (input.status === "pending" || input.status === "failed")
      ) {
        // Migration 0028 rule: completed cannot be overwritten by pending or failed
        return storedRecord;
      }
      const record: AIAnalysis = {
        id: storedRecord?.id ?? "ai-record-concurrent",
        organizationId: input.organizationId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        status: input.status ?? "pending",
        modelUsed: input.modelUsed ?? "mock-sonnet",
        promptVersion: input.promptVersion ?? IMPACT_EXPLANATION_PROMPT_VERSION,
        inputEvidenceIds: input.inputEvidenceIds ? [...input.inputEvidenceIds] : [],
        outputText: input.outputText ?? null,
        outputStructured: input.outputStructured ?? null,
        validationStatus: input.validationStatus ?? null,
        tokenCount: input.tokenCount ?? 0,
        costUsd: input.costUsd ?? 0,
        latencyMs: input.latencyMs ?? 0,
        metadata: input.metadata,
        errorMessage: input.errorMessage ?? null,
        createdAt: storedRecord?.createdAt ?? new Date(),
        updatedAt: new Date(),
      };
      storedRecord = record;
      return record;
    };

    const mockGetSubject: NonNullable<AIExplanationOrchestratorDependencies["getAIAnalysisBySubject"]> = async () => {
      return storedRecord;
    };

    // Worker 1: successful generation
    const depsWorker1: AIExplanationOrchestratorDependencies = {
      pool: {} as unknown as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
      gateway: {
        async generate() {
          gatewayInvocationCount += 1;
          return {
            text: JSON.stringify({
              summary: "Worker 1 verified explanation",
              claims: [{ text: "Service modified", evidence_ids: ["ev_1001"] }],
              confidence: "high",
              caveats: [],
            }),
            provider: "mock",
            model: "mock-sonnet",
            taskType: "impact_explanation",
            promptVersion: IMPACT_EXPLANATION_PROMPT_VERSION,
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            costUsd: 0.001,
            latencyMs: 100,
            attemptCount: 1,
            usedFallback: false,
            providerRequestId: "req-w1",
            stopReason: "end_turn",
            isMock: true,
            attempts: [],
          };
        },
      },
      loadContext: async () => createMockContext(),
      saveAIAnalysis: mockSave,
      getAIAnalysisBySubject: mockGetSubject,
    };

    // Worker 2: experiences a provider failure
    const depsWorker2: AIExplanationOrchestratorDependencies = {
      pool: {} as unknown as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
      gateway: {
        async generate() {
          gatewayInvocationCount += 1;
          throw new Error("Provider rate limit 429");
        },
      },
      loadContext: async () => createMockContext(),
      saveAIAnalysis: mockSave,
      getAIAnalysisBySubject: mockGetSubject,
    };

    // Launch both workers simultaneously before either has completed
    const [result1, result2] = await Promise.all([
      orchestrateImpactExplanation(
        { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
        depsWorker1,
      ),
      orchestrateImpactExplanation(
        { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
        depsWorker2,
      ),
    ]);

    // Both workers attempted execution and called gateway concurrently
    assert.equal(
      gatewayInvocationCount,
      2,
      "Both simultaneous initial workers invoke gateway without locking",
    );
    assert.equal(result1.status, "completed");
    assert.equal(result2.status, "failed");

    // Persisted state MUST be the completed record (Worker 2 failed write did not erase Worker 1 completed state)
    assert.ok(storedRecord);
    assert.equal((storedRecord as AIAnalysis).status, "completed");
    assert.equal(
      (storedRecord as AIAnalysis).outputText,
      "Worker 1 verified explanation",
    );
    assert.equal((storedRecord as AIAnalysis).validationStatus, "passed");

    // Worker 3 arrives later after completed state exists: MUST short-circuit with 0 gateway calls
    let worker3GatewayCalls = 0;
    const depsWorker3: AIExplanationOrchestratorDependencies = {
      ...depsWorker1,
      gateway: {
        async generate() {
          worker3GatewayCalls += 1;
          throw new Error("Should never be called");
        },
      },
    };
    const result3 = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      depsWorker3,
    );
    assert.equal(result3.status, "already_completed");
    assert.equal(
      worker3GatewayCalls,
      0,
      "Subsequent worker must short-circuit without calling model gateway",
    );
  });

  it("enforces Step 61 validation retry ceiling: cannot exceed 2 response attempts even if maxRetries option is configured high", async () => {
    let gatewayCalls = 0;
    const deps: AIExplanationOrchestratorDependencies = {
      pool: {} as unknown as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
      gateway: {
        async generate() {
          gatewayCalls += 1;
          // Returns invalid JSON every time
          return {
            text: "This is not valid JSON and has no schema structure.",
            provider: "mock",
            model: "mock-sonnet",
            taskType: "impact_explanation",
            promptVersion: IMPACT_EXPLANATION_PROMPT_VERSION,
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            costUsd: 0.001,
            latencyMs: 150,
            attemptCount: 1,
            usedFallback: false,
            providerRequestId: `req-${gatewayCalls}`,
            stopReason: "end_turn",
            isMock: true,
            attempts: [],
          };
        },
      },
      loadContext: async () => createMockContext(),
      saveAIAnalysis: async (_pool, input) => ({
        id: "ai-retry-bound-test",
        organizationId: input.organizationId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        status: input.status ?? "rejected",
        modelUsed: input.modelUsed ?? "mock-sonnet",
        promptVersion: input.promptVersion ?? IMPACT_EXPLANATION_PROMPT_VERSION,
        inputEvidenceIds: input.inputEvidenceIds ? [...input.inputEvidenceIds] : [],
        outputText: input.outputText ?? null,
        outputStructured: input.outputStructured ?? null,
        validationStatus: input.validationStatus ?? "rejected",
        tokenCount: input.tokenCount ?? 0,
        costUsd: input.costUsd ?? 0,
        latencyMs: input.latencyMs ?? 0,
        metadata: input.metadata,
        errorMessage: input.errorMessage ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      getAIAnalysisBySubject: async () => null,
    };

    // Pass maxRetries: 100 — must NOT increase Step 61 validation retry ceiling!
    const result = await orchestrateImpactExplanation(
      {
        organizationId: ORG_ID,
        impactAnalysisId: IMPACT_ID,
        maxRetries: 100,
      },
      deps,
    );

    assert.equal(result.status, "rejected");
    assert.equal(
      gatewayCalls,
      2,
      "Step 61 mandatory invariant: strictly at most 2 response attempts (1 initial + 1 corrective retry)",
    );
    assert.equal(result.aiAnalysis?.metadata?.attempts, 2);
    // Usage aggregation must count each gateway response exactly once (100+100 input, 50+50 output)
    assert.equal(result.aiAnalysis?.tokenCount, 300);
    assert.equal(result.aiAnalysis?.costUsd, 0.002);
  });

  it("concurrency: late validation rejection preserves concurrently completed result and returns already_completed", async () => {
    const invalidText = JSON.stringify({
      summary: "Direct change to PaymentService with ungrounded claim.",
      claims: [
        {
          text: "Ungrounded claim citing non-existent evidence.",
          evidence_ids: ["ev_nonexistent_9999"],
        },
      ],
      confidence: "high",
      caveats: [],
    });

    const mockGateway: ModelGateway = {
      async generate() {
        return {
          text: invalidText,
          provider: "mock",
          model: "mock-sonnet",
          taskType: "impact_explanation",
          promptVersion: IMPACT_EXPLANATION_PROMPT_VERSION,
          inputTokens: 100,
          outputTokens: 40,
          totalTokens: 140,
          costUsd: 0.001,
          latencyMs: 200,
          attemptCount: 1,
          usedFallback: false,
          providerRequestId: "req-invalid",
          stopReason: "end_turn",
          isMock: true,
          attempts: [],
        };
      },
    };

    // Simulate Worker A completing while Worker B was running:
    // When Worker B attempts to persist rejected, the repository preserves Worker A's completed row
    const completedRecordFromWorkerA: AIAnalysis = {
      id: "ai-completed-worker-a",
      organizationId: ORG_ID,
      subjectType: "impact_analysis",
      subjectId: IMPACT_ID,
      status: "completed",
      modelUsed: "mock-sonnet",
      promptVersion: IMPACT_EXPLANATION_PROMPT_VERSION,
      inputEvidenceIds: ["ev_1001"],
      outputText: "Authoritative completed summary from Worker A",
      outputStructured: {
        summary: "Authoritative completed summary from Worker A",
        claims: [{ text: "Valid claim", evidence_ids: ["ev_1001"] }],
        confidence: "high",
        caveats: [],
      },
      validationStatus: "passed",
      tokenCount: 200,
      costUsd: 0.002,
      latencyMs: 400,
      metadata: { author: "Worker A" },
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const saveCallInputs: Record<string, unknown>[] = [];
    const deps: AIExplanationOrchestratorDependencies = {
      pool: {} as unknown as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
      gateway: mockGateway,
      loadContext: async () => createMockContext(),
      saveAIAnalysis: async (_pool, input) => {
        saveCallInputs.push(input as unknown as Record<string, unknown>);
        if (input.status === "pending") {
          return {
            ...completedRecordFromWorkerA,
            status: "pending",
          };
        }
        // When Worker B attempts to save rejected, DB preserves Worker A's completed row
        return completedRecordFromWorkerA;
      },
      getAIAnalysisBySubject: async () => null, // Worker B started when record wasn't completed yet
    };

    const result = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      deps,
    );

    assert.equal(
      result.status,
      "already_completed",
      "Worker B must return already_completed when completed record was preserved",
    );
    assert.equal(result.aiAnalysis.id, "ai-completed-worker-a");
    assert.equal(result.aiAnalysis.status, "completed");
    assert.equal(result.aiAnalysis.outputText, "Authoritative completed summary from Worker A");
    assert.equal(result.aiAnalysis.validationStatus, "passed");
  });
});
