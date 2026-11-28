import assert from "node:assert/strict";
import { describe, it } from "vitest";

import type { AIAnalysis, SaveAIAnalysisInput } from "@fluxora/db";
import type { ImpactExplanationContext } from "../context/types.ts";
import { ModelGatewayError } from "../errors.ts";
import { ProductionModelGateway } from "../gateway.ts";
import {
  orchestrateImpactExplanation,
  type AIExplanationOrchestratorDependencies,
} from "../orchestrator.ts";
import type { SimulationNarrationContext } from "../simulation-context/types.ts";
import {
  orchestrateSimulationNarration,
  type SimulationNarrationOrchestratorDependencies,
} from "../simulation-orchestrator.ts";
import type {
  ModelGateway,
  ModelGatewayResponse,
  ModelProviderAdapter,
} from "../types.ts";
import {
  classifyGatewayErrorForFallback,
  combineInitialAndRetryFailureAccounting,
  generateImpactExplanationFallback,
  generateSimulationNarrationFallback,
  IMPACT_FALLBACK_PROMPT_VERSION,
  SIMULATION_FALLBACK_PROMPT_VERSION,
} from "./index.ts";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const IMPACT_ID = "22222222-2222-4222-8222-222222222222";
const SIM_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";

function makeImpactContext(
  overrides?: Partial<ImpactExplanationContext>,
): ImpactExplanationContext {
  return {
    impactAnalysisId: IMPACT_ID,
    pullRequestId: "pr-66",
    analysisRunId: RUN_ID,
    status: "completed",
    directImpact: [
      {
        nodeId: "node-pay",
        name: "PaymentProvider",
        nodeType: "service",
        filePath: "src/payment-provider.ts",
        depth: 0,
        confidence: 0.95,
        path: ["src/payment-provider.ts"],
        evidenceIds: ["ev_1001"],
      },
    ],
    downstreamImpact: [
      {
        nodeId: "node-checkout",
        name: "CheckoutService",
        nodeType: "service",
        filePath: "src/checkout.ts",
        depth: 1,
        confidence: 0.85,
        path: ["src/payment-provider.ts", "src/checkout.ts"],
        evidenceIds: ["ev_1002"],
      },
    ],
    affectedApis: [],
    affectedEvents: [],
    affectedServices: [],
    workflowImpactSummary: [],
    unresolvedFiles: [],
    executionMetrics: {
      totalSeedNodes: 1,
      totalAffectedNodes: 2,
      totalEdgesTraversed: 1,
      durationMs: 12,
      maxDepthReached: 1,
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
        subjectId: "node-pay",
        filePath: "src/payment-provider.ts",
        symbolId: "charge",
        lineStart: 10,
        lineEnd: 20,
        columnStart: 0,
        columnEnd: 1,
        relationshipDescription: "PR modifies PaymentProvider.charge",
        confidence: 0.95,
      },
      {
        id: "ev_1002",
        subjectType: "impact_finding",
        subjectId: "node-checkout",
        filePath: "src/checkout.ts",
        symbolId: "submitOrder",
        lineStart: 30,
        lineEnd: 45,
        columnStart: 0,
        columnEnd: 1,
        relationshipDescription: "CheckoutService imports PaymentProvider",
        confidence: 0.85,
      },
    ],
    allowedEvidenceIds: ["ev_1001", "ev_1002"],
    ...overrides,
  };
}

function makeSimulationContext(
  overrides?: Partial<SimulationNarrationContext>,
): SimulationNarrationContext {
  return {
    simulationId: SIM_ID,
    scenarioId: "scen-1",
    analysisRunId: RUN_ID,
    status: "completed",
    scenario: {
      id: "scen-1",
      name: "Redis outage simulation",
      targetNodeId: "node-redis",
      failureType: "unavailable",
      parameters: {},
    },
    results: [
      {
        nodeId: "node-redis",
        resultingState: "failed",
        ruleApplied: "direct_target_unavailable",
        assumptions: ["Target unavailable"],
        confidence: 1.0,
        hopDistance: 0,
        capped: false,
        propagationPath: [],
        evidenceIds: ["ev_sim_1"],
      },
      {
        nodeId: "node-session",
        resultingState: "degraded",
        ruleApplied: "cache_dependency_degraded",
        assumptions: ["Falls back to DB"],
        confidence: 0.85,
        hopDistance: 1,
        capped: false,
        propagationPath: [],
        evidenceIds: ["ev_sim_2"],
      },
    ],
    executionMetrics: {
      totalResults: 2,
      affectedCount: 2,
      failedCount: 1,
      degradedCount: 1,
      atRiskCount: 0,
      healthyCount: 0,
      cappedCount: 0,
      maxHopDistance: 1,
    },
    allowedEvidenceIds: ["ev_sim_1", "ev_sim_2"],
    evidenceRecords: [
      {
        id: "ev_sim_1",
        subjectType: "simulation_state",
        subjectId: "node-redis",
        filePath: "src/redis.ts",
        symbolId: "redisClient",
        lineStart: 1,
        lineEnd: 10,
        columnStart: 0,
        columnEnd: 1,
        relationshipDescription: "Target node-redis unavailable",
        confidence: 1.0,
        nodeId: "node-redis",
        resultingState: "failed",
        ruleApplied: "direct_target_unavailable",
      },
      {
        id: "ev_sim_2",
        subjectType: "simulation_state",
        subjectId: "node-session",
        filePath: "src/session.ts",
        symbolId: "getSession",
        lineStart: 12,
        lineEnd: 24,
        columnStart: 0,
        columnEnd: 1,
        relationshipDescription: "node-session depends on node-redis",
        confidence: 0.85,
        nodeId: "node-session",
        resultingState: "degraded",
        ruleApplied: "cache_dependency_degraded",
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

function makeInMemorySave(records: SaveAIAnalysisInput[]) {
  return async (_pool: unknown, input: SaveAIAnalysisInput): Promise<AIAnalysis> => {
    records.push(input);
    return {
      id: input.id ?? "ai-record-step66",
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
      createdAt: new Date("2026-11-27T00:00:00Z"),
      updatedAt: new Date("2026-11-27T00:00:00Z"),
    };
  };
}

function makeMockGatewayResponse(text: string): ModelGatewayResponse {
  return {
    text,
    provider: "mock",
    model: "mock-sonnet",
    taskType: "impact_explanation",
    promptVersion: "impact-explain-v1",
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    costUsd: 0.001,
    latencyMs: 120,
    attemptCount: 1,
    usedFallback: false,
    providerRequestId: "req-step66",
    stopReason: "end_turn",
    isMock: true,
    attempts: [],
  };
}

describe("Phase 9 Step 66: Deterministic Fallback Explanation", () => {
  it("1. Successful AI generation does not invoke fallback", async () => {
    const saves: SaveAIAnalysisInput[] = [];
    const validText = JSON.stringify({
      summary: "PaymentProvider directly affects CheckoutService.",
      claims: [{ text: "PaymentProvider is impacted.", evidence_ids: ["ev_1001"] }],
      confidence: "high",
      caveats: [],
    });

    const gateway: ModelGateway = {
      async generate() {
        return makeMockGatewayResponse(validText);
      },
    };

    const result = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      {
        pool: {} as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
        gateway,
        loadContext: async () => makeImpactContext(),
        saveAIAnalysis: makeInMemorySave(saves) as unknown as NonNullable<
          AIExplanationOrchestratorDependencies["saveAIAnalysis"]
        >,
        getAIAnalysisBySubject: async () => null,
      },
    );

    assert.equal(result.status, "completed");
    assert.equal(result.aiAnalysis.validationStatus, "passed");
    assert.equal(result.aiAnalysis.modelUsed, "mock-sonnet");
    assert.equal(result.aiAnalysis.metadata?.deterministicFallback, undefined);
  });

  it("2. Provider unavailability invokes fallback when sufficient deterministic context exists", async () => {
    const saves: SaveAIAnalysisInput[] = [];
    const gateway: ModelGateway = {
      async generate() {
        throw ModelGatewayError.providerUnavailable("Anthropic 503 Service Unavailable", {
          provider: "anthropic",
          taskType: "impact_explanation",
        });
      },
    };

    const result = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      {
        pool: {} as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
        gateway,
        loadContext: async () => makeImpactContext(),
        saveAIAnalysis: makeInMemorySave(saves) as unknown as NonNullable<
          AIExplanationOrchestratorDependencies["saveAIAnalysis"]
        >,
        getAIAnalysisBySubject: async () => null,
      },
    );

    assert.equal(result.status, "completed");
    assert.equal(result.aiAnalysis.validationStatus, "fallback");
    assert.equal(result.aiAnalysis.modelUsed, null);
    assert.equal(result.aiAnalysis.promptVersion, IMPACT_FALLBACK_PROMPT_VERSION);
    assert.equal(result.aiAnalysis.metadata?.deterministicFallback, true);
    assert.equal(result.aiAnalysis.metadata?.fallbackReason, "provider_unavailable");
    assert.ok(result.aiAnalysis.outputStructured);
    assert.equal(result.aiAnalysis.outputStructured.claims.length, 2);
  });

  it("3. Provider timeout invokes fallback at the terminal failure boundary", async () => {
    const saves: SaveAIAnalysisInput[] = [];
    const gateway: ModelGateway = {
      async generate() {
        throw ModelGatewayError.timeoutError("Gateway timed out after 20000ms", {
          provider: "anthropic",
          taskType: "impact_explanation",
        });
      },
    };

    const result = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      {
        pool: {} as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
        gateway,
        loadContext: async () => makeImpactContext(),
        saveAIAnalysis: makeInMemorySave(saves) as unknown as NonNullable<
          AIExplanationOrchestratorDependencies["saveAIAnalysis"]
        >,
        getAIAnalysisBySubject: async () => null,
      },
    );

    assert.equal(result.status, "completed");
    assert.equal(result.aiAnalysis.validationStatus, "fallback");
    assert.equal(result.aiAnalysis.metadata?.fallbackReason, "provider_timeout");
  });

  it("4. Corrective validation is attempted according to existing retry policy before fallback", async () => {
    let gatewayCalls = 0;
    const saves: SaveAIAnalysisInput[] = [];
    const invalidJson = JSON.stringify({
      summary: "Ungrounded claim",
      claims: [{ text: "Bad claim", evidence_ids: ["ev_fabricated"] }],
      confidence: "high",
      caveats: [],
    });

    const gateway: ModelGateway = {
      async generate() {
        gatewayCalls += 1;
        return makeMockGatewayResponse(invalidJson);
      },
    };

    const result = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      {
        pool: {} as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
        gateway,
        loadContext: async () => makeImpactContext(),
        saveAIAnalysis: makeInMemorySave(saves) as unknown as NonNullable<
          AIExplanationOrchestratorDependencies["saveAIAnalysis"]
        >,
        getAIAnalysisBySubject: async () => null,
      },
    );

    assert.equal(gatewayCalls, 2, "Must attempt 1 initial + 1 corrective retry before fallback");
    assert.equal(result.status, "completed");
    assert.equal(result.aiAnalysis.validationStatus, "fallback");
    assert.equal(result.aiAnalysis.metadata?.attempts, 2);
    assert.equal(
      result.aiAnalysis.metadata?.fallbackReason,
      "validation_failed_after_retries",
    );
    assert.equal(result.aiAnalysis.modelUsed, null);
    assert.equal(result.aiAnalysis.metadata?.attemptedModel, "mock-sonnet");
  });

  it("5. Timeout during corrective retry invokes fallback while preserving initial attempt usage", async () => {
    let gatewayCalls = 0;
    const saves: SaveAIAnalysisInput[] = [];
    const invalidJson = JSON.stringify({
      summary: "Bad",
      claims: [{ text: "Bad", evidence_ids: ["ev_missing"] }],
      confidence: "high",
      caveats: [],
    });

    const gateway: ModelGateway = {
      async generate() {
        gatewayCalls += 1;
        if (gatewayCalls === 1) {
          return makeMockGatewayResponse(invalidJson);
        }
        throw ModelGatewayError.timeoutError("Retry timed out");
      },
    };

    const result = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      {
        pool: {} as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
        gateway,
        loadContext: async () => makeImpactContext(),
        saveAIAnalysis: makeInMemorySave(saves) as unknown as NonNullable<
          AIExplanationOrchestratorDependencies["saveAIAnalysis"]
        >,
        getAIAnalysisBySubject: async () => null,
      },
    );

    assert.equal(gatewayCalls, 2);
    assert.equal(result.status, "completed");
    assert.equal(result.aiAnalysis.validationStatus, "fallback");
    assert.equal(result.aiAnalysis.metadata?.fallbackReason, "provider_timeout");
    assert.equal(result.aiAnalysis.tokenCount, 150);
  });

  it("6. Equivalent deterministic inputs produce identical fallback output", () => {
    const ctx1 = makeImpactContext();
    const ctx2 = makeImpactContext();
    const res1 = generateImpactExplanationFallback(ctx1);
    const res2 = generateImpactExplanationFallback(ctx2);

    assert.deepEqual(res1, res2);

    const sim1 = generateSimulationNarrationFallback(makeSimulationContext());
    const sim2 = generateSimulationNarrationFallback(makeSimulationContext());
    assert.deepEqual(sim1, sim2);
  });

  it("7. Evidence citations are strictly restricted to supplied trusted evidence", () => {
    const ctx = makeImpactContext({
      directImpact: [
        {
          nodeId: "node-pay",
          name: "PaymentProvider",
          nodeType: "service",
          filePath: "src/payment-provider.ts",
          depth: 0,
          confidence: 0.95,
          path: [],
          evidenceIds: ["ev_1001", "ev_untrusted_999"],
        },
      ],
      downstreamImpact: [],
      allowedEvidenceIds: ["ev_1001"],
    });

    const res = generateImpactExplanationFallback(ctx);
    assert.equal(res.abstained, false);
    assert.equal(res.output.claims.length, 1);
    assert.deepEqual(res.output.claims[0]?.evidence_ids, ["ev_1001"]);
  });

  it("8. Missing evidence results in explicit abstention rather than invented claims", () => {
    const ctx = makeImpactContext({
      allowedEvidenceIds: [],
      evidenceRecords: [],
    });

    const res = generateImpactExplanationFallback(ctx);
    assert.equal(res.abstained, true);
    assert.deepEqual(res.output.claims, []);
    assert.equal(res.output.confidence, "low");
    assert.match(res.output.summary, /no verified evidence records/i);
    assert.ok(res.output.caveats.some((c) => /abstained/i.test(c)));

    const simRes = generateSimulationNarrationFallback(
      makeSimulationContext({ allowedEvidenceIds: [], evidenceRecords: [] }),
    );
    assert.equal(simRes.abstained, true);
    assert.deepEqual(simRes.output.claims, []);
    assert.equal(simRes.output.confidence, "low");
  });

  it("9. Truncated impact context preserves its truncation caveat", () => {
    const ctx = makeImpactContext({
      truncated: true,
      truncationReason: "max_depth=3 reached",
      truncation: {
        isTruncated: true,
        analysisWasTruncated: true,
        analysisTruncationReason: "max_depth=3 reached",
        contextLimitsExceeded: false,
        reasons: ["max_depth=3 reached"],
        omittedFindingsCount: 4,
        omittedEvidenceCount: 2,
        omittedUnresolvedFilesCount: 0,
      },
    });

    const res = generateImpactExplanationFallback(ctx);
    assert.match(res.output.summary, /truncated/i);
    assert.ok(
      res.output.caveats.some(
        (c) => c.includes("max_depth=3 reached") && c.includes("omitted findings: 4"),
      ),
    );
  });

  it("10. Unresolved files remain explicitly unresolved", () => {
    const ctx = makeImpactContext({
      unresolvedFiles: [
        { path: "scripts/custom.py", reason: "unsupported_language" },
      ],
    });

    const res = generateImpactExplanationFallback(ctx);
    assert.match(res.output.summary, /1 changed file\(s\) remain unresolved/i);
    assert.ok(
      res.output.caveats.some(
        (c) =>
          c.includes("scripts/custom.py") && c.includes("unsupported_language"),
      ),
    );
  });

  it("11. Simulation fallback preserves exact deterministic states and clearly identifies synthetic scenarios", async () => {
    const saves: SaveAIAnalysisInput[] = [];
    const gateway: ModelGateway = {
      async generate() {
        throw ModelGatewayError.providerUnavailable("Anthropic 503");
      },
    };

    const result = await orchestrateSimulationNarration(
      { organizationId: ORG_ID, simulationId: SIM_ID },
      {
        pool: {} as NonNullable<SimulationNarrationOrchestratorDependencies["pool"]>,
        gateway,
        loadContext: async () => makeSimulationContext(),
        saveAIAnalysis: makeInMemorySave(saves) as unknown as NonNullable<
          SimulationNarrationOrchestratorDependencies["saveAIAnalysis"]
        >,
        getAIAnalysisBySubject: async () => null,
      },
    );

    assert.equal(result.status, "completed");
    assert.equal(result.aiAnalysis.validationStatus, "fallback");
    assert.equal(result.aiAnalysis.promptVersion, SIMULATION_FALLBACK_PROMPT_VERSION);
    assert.equal(result.aiAnalysis.modelUsed, null);
    const structured = result.aiAnalysis.outputStructured;
    assert.ok(structured);
    assert.match(structured.summary, /synthetic/i);
    assert.ok(structured.caveats.some((c) => /synthetic scenario simulation/i.test(c)));
    assert.ok(structured.claims.some((c) => c.text.includes("resultingState='failed'")));
    assert.ok(structured.claims.some((c) => c.text.includes("resultingState='degraded'")));
  });

  it("12. Tenant authorization / ownership failures never invoke fallback", async () => {
    const saves: SaveAIAnalysisInput[] = [];
    let gatewayCalled = false;

    const result = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      {
        pool: {} as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
        gateway: {
          async generate() {
            gatewayCalled = true;
            return makeMockGatewayResponse("{}");
          },
        },
        loadContext: async () => {
          throw new Error("Impact analysis not found or inaccessible.");
        },
        saveAIAnalysis: makeInMemorySave(saves) as unknown as NonNullable<
          AIExplanationOrchestratorDependencies["saveAIAnalysis"]
        >,
        getAIAnalysisBySubject: async () => null,
      },
    );

    assert.equal(gatewayCalled, false);
    assert.equal(result.status, "failed");
    assert.ok(saves.every((s) => s.validationStatus !== "fallback"));
  });

  it("13. Policy, auth, configuration, and abort rejections never invoke fallback", async () => {
    assert.equal(
      classifyGatewayErrorForFallback(
        ModelGatewayError.authenticationError("Invalid API key"),
      ).eligible,
      false,
    );
    assert.equal(
      classifyGatewayErrorForFallback(
        ModelGatewayError.configurationError("Missing config"),
      ).eligible,
      false,
    );
    assert.equal(
      classifyGatewayErrorForFallback(ModelGatewayError.aborted("Caller aborted"))
        .eligible,
      false,
    );
    assert.equal(
      classifyGatewayErrorForFallback(new TypeError("Programming bug")).eligible,
      false,
    );

    const saves: SaveAIAnalysisInput[] = [];
    const result = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      {
        pool: {} as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
        gateway: {
          async generate() {
            throw ModelGatewayError.authenticationError("Invalid API key");
          },
        },
        loadContext: async () => makeImpactContext(),
        saveAIAnalysis: makeInMemorySave(saves) as unknown as NonNullable<
          AIExplanationOrchestratorDependencies["saveAIAnalysis"]
        >,
        getAIAnalysisBySubject: async () => null,
      },
    );

    assert.equal(result.status, "failed");
    assert.equal(result.aiAnalysis?.validationStatus, null);
  });

  it("14 & 15. Fallback provenance is persisted and repeated execution is idempotent", async () => {
    let storedRecord: AIAnalysis | null = null;
    let gatewayCalls = 0;

    const deps: AIExplanationOrchestratorDependencies = {
      pool: {} as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
      gateway: {
        async generate() {
          gatewayCalls += 1;
          throw ModelGatewayError.providerUnavailable("503");
        },
      },
      loadContext: async () => makeImpactContext(),
      getAIAnalysisBySubject: async () => storedRecord,
      saveAIAnalysis: async (_pool, input) => {
        storedRecord = {
          id: input.id ?? "ai-fallback-idempotent-1",
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
          createdAt: new Date("2026-11-27T00:00:00Z"),
          updatedAt: new Date("2026-11-27T00:00:00Z"),
        };
        return storedRecord;
      },
    };

    const first = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      deps,
    );
    assert.equal(first.status, "completed");
    assert.equal(first.aiAnalysis.validationStatus, "fallback");
    assert.equal(gatewayCalls, 1);

    const second = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      deps,
    );
    assert.equal(second.status, "already_completed");
    assert.equal(second.aiAnalysis.validationStatus, "fallback");
    assert.equal(gatewayCalls, 1, "Idempotent replay must not re-invoke gateway");
  });
});

describe("Phase 9 Step 66 Hardening: Real ModelGateway Classification, Normalization & Accounting", () => {
  const noSleep = async () => {};

  it("16. Direct eligible errors (PROVIDER_UNAVAILABLE, TIMEOUT_ERROR, RATE_LIMIT_ERROR) are eligible", () => {
    assert.deepEqual(
      classifyGatewayErrorForFallback(ModelGatewayError.providerUnavailable("503")),
      { eligible: true, reason: "provider_unavailable" },
    );
    assert.deepEqual(
      classifyGatewayErrorForFallback(ModelGatewayError.timeoutError("20s")),
      { eligible: true, reason: "provider_timeout" },
    );
    assert.deepEqual(
      classifyGatewayErrorForFallback(ModelGatewayError.rateLimitError("429")),
      { eligible: true, reason: "rate_limit_exhausted" },
    );
  });

  it("17. Real ProductionModelGateway exhausting transient retries + fallback model produces eligible RETRIES_EXHAUSTED", async () => {
    let calls = 0;
    const provider: ModelProviderAdapter = {
      providerId: "anthropic",
      async generate() {
        calls += 1;
        if (calls === 1) {
          throw ModelGatewayError.timeoutError("Primary timeout");
        }
        if (calls === 2) {
          throw ModelGatewayError.rateLimitError("Primary 429");
        }
        if (calls === 3) {
          throw ModelGatewayError.providerUnavailable("Primary 503");
        }
        throw ModelGatewayError.providerUnavailable("Fallback 503");
      },
    };

    const gateway = new ProductionModelGateway({
      provider,
      sleepFn: noSleep,
    });

    let caught: unknown;
    try {
      await gateway.generate({
        taskType: "impact_explanation",
        promptVersion: "impact-explain-v1",
        messages: [{ role: "user", content: "explain" }],
      });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof ModelGatewayError);
    assert.equal(caught.code, "RETRIES_EXHAUSTED");
    assert.equal(caught.attempts?.length, 4);
    assert.deepEqual(classifyGatewayErrorForFallback(caught), {
      eligible: true,
      reason: "retries_exhausted",
    });
  });

  it("18. Real ProductionModelGateway mixed history (transient primary -> AUTHENTICATION_ERROR fallback) is INELIGIBLE", async () => {
    let calls = 0;
    const provider: ModelProviderAdapter = {
      providerId: "anthropic",
      async generate(params) {
        calls += 1;
        if (params.model === "claude-sonnet-5-5") {
          throw ModelGatewayError.providerUnavailable("Primary 503");
        }
        throw ModelGatewayError.authenticationError("Invalid fallback key");
      },
    };

    const gateway = new ProductionModelGateway({
      provider,
      sleepFn: noSleep,
    });

    let caught: unknown;
    try {
      await gateway.generate({
        taskType: "impact_explanation",
        promptVersion: "impact-explain-v1",
        messages: [{ role: "user", content: "explain" }],
      });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof ModelGatewayError);
    assert.equal(caught.code, "RETRIES_EXHAUSTED");
    assert.equal(calls, 4);
    assert.deepEqual(classifyGatewayErrorForFallback(caught), {
      eligible: false,
    });
  });

  it("19. Rejects wrapped auth, config, abort, policy/security, incomplete provenance, cyclic and deep causes", () => {
    const authWrapped = ModelGatewayError.retriesExhausted("Exhausted", {
      primaryError: ModelGatewayError.authenticationError("Bad key"),
    });
    assert.equal(classifyGatewayErrorForFallback(authWrapped).eligible, false);

    const configWrapped = ModelGatewayError.retriesExhausted("Exhausted", {
      primaryError: ModelGatewayError.timeoutError("Timeout"),
      cause: ModelGatewayError.configurationError("Missing config"),
    });
    assert.equal(classifyGatewayErrorForFallback(configWrapped).eligible, false);

    const abortWrapped = ModelGatewayError.retriesExhausted("Exhausted", {
      primaryError: ModelGatewayError.timeoutError("Timeout"),
      attempts: [
        {
          attemptNumber: 1,
          model: "claude-sonnet-5-5",
          isFallback: false,
          latencyMs: 10,
          outcome: "aborted",
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          errorCategory: "ABORTED",
        },
      ],
    });
    assert.equal(classifyGatewayErrorForFallback(abortWrapped).eligible, false);

    const policyWrapped = ModelGatewayError.providerUnavailable("Wrapped policy", {
      cause: Object.assign(new Error("Policy rejected"), { code: "POLICY_REJECTED" }),
    });
    assert.equal(classifyGatewayErrorForFallback(policyWrapped).eligible, false);

    const incompleteExhausted = ModelGatewayError.retriesExhausted("No provenance", {});
    assert.equal(classifyGatewayErrorForFallback(incompleteExhausted).eligible, false);

    // Cyclic cause chain must terminate safely
    const cyclicA: { cause?: unknown } = {};
    const cyclicB: { cause?: unknown } = { cause: cyclicA };
    cyclicA.cause = cyclicB;
    const cyclicErr = ModelGatewayError.providerUnavailable("Cyclic", { cause: cyclicA });
    assert.equal(classifyGatewayErrorForFallback(cyclicErr).eligible, true);

    // Excessively deep cause chain (> 10) must be treated conservatively as ineligible
    let deep: ModelGatewayError = ModelGatewayError.timeoutError("Leaf");
    for (let i = 0; i < 12; i += 1) {
      deep = ModelGatewayError.retriesExhausted(`Wrap ${i}`, {
        primaryError: deep,
      });
    }
    assert.equal(classifyGatewayErrorForFallback(deep).eligible, false);
  });

  it("20. Gateway normalizeError preserves transport failures and rejects TypeError/ReferenceError/unknown errors", async () => {
    const runWithThrown = async (thrown: unknown): Promise<ModelGatewayError> => {
      const gateway = new ProductionModelGateway({
        provider: {
          providerId: "anthropic",
          async generate() {
            throw thrown;
          },
        },
        sleepFn: noSleep,
      });
      try {
        await gateway.generate({
          taskType: "impact_explanation",
          promptVersion: "impact-explain-v1",
          messages: [{ role: "user", content: "explain" }],
        });
      } catch (err) {
        return err as ModelGatewayError;
      }
      throw new Error("Expected gateway to throw");
    };

    const econnreset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const netErr = await runWithThrown(econnreset);
    assert.equal(netErr.code, "RETRIES_EXHAUSTED");
    assert.equal(classifyGatewayErrorForFallback(netErr).eligible, true);

    const typeErr = await runWithThrown(new TypeError("Cannot read properties of undefined"));
    assert.equal(typeErr.code, "INTERNAL_ERROR");
    assert.equal(typeErr.retryable, false);
    assert.equal(classifyGatewayErrorForFallback(typeErr).eligible, false);

    const refErr = await runWithThrown(new ReferenceError("x is not defined"));
    assert.equal(refErr.code, "INTERNAL_ERROR");
    assert.equal(classifyGatewayErrorForFallback(refErr).eligible, false);

    const unknownErr = await runWithThrown(new Error("Unexpected internal bug"));
    assert.equal(unknownErr.code, "INTERNAL_ERROR");
    assert.equal(classifyGatewayErrorForFallback(unknownErr).eligible, false);
  });

  it("21. Impact & Simulation orchestrators preserve gateway attempt counts, latency, and unavailable usage/cost flags", async () => {
    const provider: ModelProviderAdapter = {
      providerId: "anthropic",
      async generate() {
        throw Object.assign(new Error("Connection reset"), { code: "ECONNRESET" });
      },
    };
    const gateway = new ProductionModelGateway({ provider, sleepFn: noSleep });

    const impactSaves: SaveAIAnalysisInput[] = [];
    const impactResult = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      {
        pool: {} as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
        gateway,
        loadContext: async () => makeImpactContext(),
        saveAIAnalysis: makeInMemorySave(impactSaves) as unknown as NonNullable<
          AIExplanationOrchestratorDependencies["saveAIAnalysis"]
        >,
        getAIAnalysisBySubject: async () => null,
      },
    );

    assert.equal(impactResult.status, "completed");
    assert.equal(impactResult.aiAnalysis.validationStatus, "fallback");
    assert.equal(impactResult.aiAnalysis.metadata?.attempts, 4);
    assert.equal(impactResult.aiAnalysis.metadata?.usageUnavailable, true);
    assert.equal(impactResult.aiAnalysis.metadata?.costUnavailable, true);
    assert.equal(impactResult.aiAnalysis.tokenCount, 0);
    assert.equal(impactResult.aiAnalysis.costUsd, 0);
    assert.ok(Array.isArray(impactResult.aiAnalysis.metadata?.gatewayAttempts));

    const simSaves: SaveAIAnalysisInput[] = [];
    const simResult = await orchestrateSimulationNarration(
      { organizationId: ORG_ID, simulationId: SIM_ID },
      {
        pool: {} as NonNullable<SimulationNarrationOrchestratorDependencies["pool"]>,
        gateway,
        loadContext: async () => makeSimulationContext(),
        saveAIAnalysis: makeInMemorySave(simSaves) as unknown as NonNullable<
          SimulationNarrationOrchestratorDependencies["saveAIAnalysis"]
        >,
        getAIAnalysisBySubject: async () => null,
      },
    );

    assert.equal(simResult.status, "completed");
    assert.equal(simResult.aiAnalysis.validationStatus, "fallback");
    assert.equal(simResult.aiAnalysis.metadata?.attempts, 4);
    assert.equal(simResult.aiAnalysis.metadata?.usageUnavailable, true);
    assert.equal(simResult.aiAnalysis.metadata?.costUnavailable, true);
  });

  it("22. Simulation orchestrator rejects TypeError via real gateway without invoking fallback, and preserves initial usage on retry failure", async () => {
    const bugGateway = new ProductionModelGateway({
      provider: {
        providerId: "anthropic",
        async generate() {
          throw new TypeError("Null pointer in adapter");
        },
      },
      sleepFn: noSleep,
    });

    const bugSaves: SaveAIAnalysisInput[] = [];
    const bugResult = await orchestrateSimulationNarration(
      { organizationId: ORG_ID, simulationId: SIM_ID },
      {
        pool: {} as NonNullable<SimulationNarrationOrchestratorDependencies["pool"]>,
        gateway: bugGateway,
        loadContext: async () => makeSimulationContext(),
        saveAIAnalysis: makeInMemorySave(bugSaves) as unknown as NonNullable<
          SimulationNarrationOrchestratorDependencies["saveAIAnalysis"]
        >,
        getAIAnalysisBySubject: async () => null,
      },
    );
    assert.equal(bugResult.status, "failed");
    assert.ok(bugSaves.every((s) => s.validationStatus !== "fallback"));

    // Initial invalid response (with tokens) -> corrective retry fails with ETIMEDOUT
    let callCount = 0;
    const retryTimeoutGateway = new ProductionModelGateway({
      provider: {
        providerId: "anthropic",
        async generate() {
          callCount += 1;
          if (callCount === 1) {
            return {
              text: JSON.stringify({
                summary: "Invalid",
                claims: [{ text: "Bad", evidence_ids: ["ev_missing"] }],
                confidence: "high",
                caveats: [],
              }),
              model: "claude-sonnet-5-5",
              inputTokens: 120,
              outputTokens: 60,
              totalTokens: 180,
              providerRequestId: "req-1",
              stopReason: "end_turn",
            };
          }
          throw Object.assign(new Error("Retry socket timeout"), { code: "ETIMEDOUT" });
        },
      },
      sleepFn: noSleep,
    });

    const retrySaves: SaveAIAnalysisInput[] = [];
    const retryResult = await orchestrateSimulationNarration(
      { organizationId: ORG_ID, simulationId: SIM_ID },
      {
        pool: {} as NonNullable<SimulationNarrationOrchestratorDependencies["pool"]>,
        gateway: retryTimeoutGateway,
        loadContext: async () => makeSimulationContext(),
        saveAIAnalysis: makeInMemorySave(retrySaves) as unknown as NonNullable<
          SimulationNarrationOrchestratorDependencies["saveAIAnalysis"]
        >,
        getAIAnalysisBySubject: async () => null,
      },
    );

    assert.equal(retryResult.status, "completed");
    assert.equal(retryResult.aiAnalysis.validationStatus, "fallback");
    assert.equal(retryResult.aiAnalysis.tokenCount, 180);
    assert.equal(retryResult.aiAnalysis.metadata?.attempts, 5); // 1 initial + 4 retry gateway attempts
    assert.equal(retryResult.aiAnalysis.metadata?.fallbackReason, "retries_exhausted");
  });

  it("23. combineInitialAndRetryFailureAccounting uses authoritative initial.attemptCount across impact and simulation orchestrators", async () => {
    const makeRetryError = () =>
      ModelGatewayError.retriesExhausted("Retry exhausted", {
        provider: "anthropic",
        model: "claude-haiku-5-5",
        taskType: "impact_explanation",
        attemptCount: 2,
        totalLatencyMs: 250,
        primaryError: ModelGatewayError.timeoutError("Attempt 1 timeout"),
        attempts: [
          {
            attemptNumber: 1,
            model: "claude-sonnet-5-5",
            isFallback: false,
            latencyMs: 120,
            outcome: "timeout",
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            errorCategory: "TIMEOUT_ERROR",
          },
          {
            attemptNumber: 2,
            model: "claude-haiku-5-5",
            isFallback: true,
            latencyMs: 130,
            outcome: "retryable_error",
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            errorCategory: "PROVIDER_UNAVAILABLE",
          },
        ],
      });

    // 1. Initial attemptCount: 1 + 2 retry attempts = 3
    const init1: ModelGatewayResponse = {
      ...makeMockGatewayResponse("invalid"),
      attemptCount: 1,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      costUsd: 0.001,
      latencyMs: 120,
    };
    const combined1 = combineInitialAndRetryFailureAccounting(init1, makeRetryError());
    assert.equal(combined1.attempts, 3);
    assert.equal(combined1.tokenCount, 150);
    assert.equal(combined1.costUsd, 0.001);
    assert.equal(combined1.latencyMs, 370);
    assert.equal(combined1.usageUnavailable, true);
    assert.equal(combined1.costUnavailable, true);

    // 2 & 3. Initial attemptCount: 3 (even if attempts: [] is empty) + 2 retry attempts = 5
    const init3: ModelGatewayResponse = {
      ...init1,
      attemptCount: 3,
      attempts: [],
    };
    const combined3 = combineInitialAndRetryFailureAccounting(init3, makeRetryError());
    assert.equal(combined3.attempts, 5);
    assert.equal(combined3.tokenCount, 150);
    assert.equal(combined3.costUsd, 0.001);
    assert.equal(combined3.latencyMs, 370);

    // 4. Both impact and simulation orchestrators preserve 3 + 2 = 5
    const makeSequencedGateway = (): ModelGateway => {
      let call = 0;
      return {
        async generate() {
          call += 1;
          if (call === 1) {
            return init3;
          }
          throw makeRetryError();
        },
      };
    };

    const impactSaves: SaveAIAnalysisInput[] = [];
    const impactRes = await orchestrateImpactExplanation(
      { organizationId: ORG_ID, impactAnalysisId: IMPACT_ID },
      {
        pool: {} as NonNullable<AIExplanationOrchestratorDependencies["pool"]>,
        gateway: makeSequencedGateway(),
        loadContext: async () => makeImpactContext(),
        saveAIAnalysis: makeInMemorySave(impactSaves) as unknown as NonNullable<
          AIExplanationOrchestratorDependencies["saveAIAnalysis"]
        >,
        getAIAnalysisBySubject: async () => null,
      },
    );
    assert.equal(impactRes.status, "completed");
    assert.equal(impactRes.aiAnalysis.validationStatus, "fallback");
    assert.equal(impactRes.aiAnalysis.metadata?.attempts, 5);
    assert.equal(impactRes.aiAnalysis.tokenCount, 150);
    assert.equal(impactRes.aiAnalysis.costUsd, 0.001);
    assert.equal(impactRes.aiAnalysis.latencyMs, 370);

    const simSaves: SaveAIAnalysisInput[] = [];
    const simRes = await orchestrateSimulationNarration(
      { organizationId: ORG_ID, simulationId: SIM_ID },
      {
        pool: {} as NonNullable<SimulationNarrationOrchestratorDependencies["pool"]>,
        gateway: makeSequencedGateway(),
        loadContext: async () => makeSimulationContext(),
        saveAIAnalysis: makeInMemorySave(simSaves) as unknown as NonNullable<
          SimulationNarrationOrchestratorDependencies["saveAIAnalysis"]
        >,
        getAIAnalysisBySubject: async () => null,
      },
    );
    assert.equal(simRes.status, "completed");
    assert.equal(simRes.aiAnalysis.validationStatus, "fallback");
    assert.equal(simRes.aiAnalysis.metadata?.attempts, 5);
    assert.equal(simRes.aiAnalysis.tokenCount, 150);
    assert.equal(simRes.aiAnalysis.costUsd, 0.001);
    assert.equal(simRes.aiAnalysis.latencyMs, 370);
  });
});
