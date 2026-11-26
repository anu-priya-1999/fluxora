import assert from "node:assert/strict";
import { describe, it } from "vitest";

import type {
  EvidenceRecord,
  Scenario,
  Simulation,
  SimulationResult,
} from "@fluxora/shared-types";

import { assembleSimulationNarrationContext } from "./assembler.ts";
import {
  SimulationNarrationContextError,
} from "./types.ts";

const SIMULATION_ID = "11111111-1111-4111-8111-111111111111";
const SCENARIO_ID = "22222222-2222-4222-8222-222222222222";
const ANALYSIS_RUN_ID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "44444444-4444-4444-8444-444444444444";

function createValidSimulation(overrides: Partial<Simulation> = {}): Simulation {
  return {
    id: SIMULATION_ID,
    scenarioId: SCENARIO_ID,
    analysisRunId: ANALYSIS_RUN_ID,
    status: "completed",
    createdAt: new Date("2026-11-24T12:00:00Z"),
    ...overrides,
  };
}

function createValidScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: SCENARIO_ID,
    organizationId: ORG_ID,
    repositoryId: "55555555-5555-4555-8555-555555555555",
    name: "Simulate Payment Service Outage",
    targetNodeId: "node_payment_service",
    failureType: "unavailable",
    parameters: { severity: "hard_down" },
    createdBy: "usr_alice",
    createdAt: new Date("2026-11-24T11:00:00Z"),
    ...overrides,
  };
}

function createValidResults(): SimulationResult[] {
  return [
    {
      id: "sr_01",
      simulationId: SIMULATION_ID,
      nodeId: "node_payment_service",
      resultingState: "failed",
      propagationPath: [
        {
          nodeId: "node_payment_service",
          ruleId: "target_failure",
          ruleVersion: "1.0",
          previousState: "healthy",
          resultingState: "failed",
          assumptions: [],
          confidence: 1.0,
        },
      ],
      ruleApplied: "target_failure",
      assumptions: [],
      confidence: 1.0,
      createdAt: new Date("2026-11-24T12:01:00Z"),
    },
    {
      id: "sr_02",
      simulationId: SIMULATION_ID,
      nodeId: "node_checkout_service",
      resultingState: "degraded",
      propagationPath: [
        {
          nodeId: "node_payment_service",
          ruleId: "target_failure",
          ruleVersion: "1.0",
          previousState: "healthy",
          resultingState: "failed",
          assumptions: [],
          confidence: 1.0,
        },
        {
          nodeId: "node_checkout_service",
          edgeId: "edge_checkout_payment",
          ruleId: "payment_dependency_degraded",
          ruleVersion: "1.0",
          previousState: "healthy",
          resultingState: "degraded",
          assumptions: ["checkout fallback circuit breaker open"],
          confidence: 0.95,
        },
      ],
      ruleApplied: "payment_dependency_degraded",
      assumptions: ["checkout fallback circuit breaker open"],
      confidence: 0.95,
      createdAt: new Date("2026-11-24T12:01:01Z"),
    },
  ];
}

function createValidEvidence(): EvidenceRecord[] {
  return [
    {
      id: "ev_sim_01",
      analysisRunId: ANALYSIS_RUN_ID,
      subjectType: "simulation_state",
      subjectId: "sr_01",
      filePath: "src/services/payment.ts",
      symbolId: "PaymentService",
      lineStart: 10,
      lineEnd: 50,
      columnStart: 1,
      columnEnd: 1,
      relationshipDescription: "Simulation state set to failed because node is target of scenario",
      confidence: 1.0,
      metadata: {
        simulationId: SIMULATION_ID,
        nodeId: "node_payment_service",
        resultingState: "failed",
        ruleApplied: "target_failure",
      },
      createdAt: new Date("2026-11-24T12:01:00Z"),
    },
    {
      id: "ev_sim_02",
      analysisRunId: ANALYSIS_RUN_ID,
      subjectType: "simulation_state",
      subjectId: "sr_02",
      filePath: "src/services/checkout.ts",
      symbolId: "CheckoutService",
      lineStart: 25,
      lineEnd: 80,
      columnStart: 1,
      columnEnd: 1,
      relationshipDescription: "Simulation state changed to degraded via payment_dependency_degraded rule",
      confidence: 0.95,
      metadata: {
        simulationId: SIMULATION_ID,
        nodeId: "node_checkout_service",
        resultingState: "degraded",
        ruleApplied: "payment_dependency_degraded",
      },
      createdAt: new Date("2026-11-24T12:01:01Z"),
    },
  ];
}

describe("Simulation Narration Context Assembler (Step 63)", () => {
  it("1. Successfully assembles context from completed simulation and verified evidence", () => {
    const simulation = createValidSimulation();
    const scenario = createValidScenario();
    const results = createValidResults();
    const evidenceRecords = createValidEvidence();

    const ctx = assembleSimulationNarrationContext({
      simulation,
      scenario,
      results,
      evidenceRecords,
    });

    assert.equal(ctx.simulationId, SIMULATION_ID);
    assert.equal(ctx.scenarioId, SCENARIO_ID);
    assert.equal(ctx.status, "completed");
    assert.equal(ctx.scenario.name, "Simulate Payment Service Outage");
    assert.equal(ctx.scenario.failureType, "unavailable");
    assert.equal(ctx.results.length, 2);
    assert.equal(ctx.executionMetrics.totalResults, 2);
    assert.equal(ctx.executionMetrics.failedCount, 1);
    assert.equal(ctx.executionMetrics.degradedCount, 1);
    assert.equal(ctx.executionMetrics.affectedCount, 2);

    // Exact manifest synchronization
    assert.deepEqual(Array.from(ctx.allowedEvidenceIds), ["ev_sim_01", "ev_sim_02"]);
    assert.equal(ctx.evidenceRecords.length, 2);
    assert.equal(ctx.truncated, false);
    assert.equal(ctx.truncationReason, null);
  });

  it("2. Rejects simulation if status is not completed", () => {
    const simulation = createValidSimulation({ status: "pending" });
    const scenario = createValidScenario();

    assert.throws(
      () =>
        assembleSimulationNarrationContext({
          simulation,
          scenario,
          results: [],
          evidenceRecords: [],
        }),
      (err) => err instanceof SimulationNarrationContextError && err.code === "not_completed",
    );
  });

  it("3. Rejects scenario if ID does not match simulation.scenarioId", () => {
    const simulation = createValidSimulation();
    const scenario = createValidScenario({ id: "99999999-9999-4999-8999-999999999999" });

    assert.throws(
      () =>
        assembleSimulationNarrationContext({
          simulation,
          scenario,
          results: [],
          evidenceRecords: [],
        }),
      (err) => err instanceof SimulationNarrationContextError && err.code === "invalid_input",
    );
  });

  it("4. Filters out evidence from other simulations, wrong subjectType, or different analysisRunId", () => {
    const simulation = createValidSimulation();
    const scenario = createValidScenario();
    const results = createValidResults();
    const evidenceRecords: EvidenceRecord[] = [
      ...createValidEvidence(),
      // Evidence with wrong subjectType
      {
        id: "ev_wrong_type",
        analysisRunId: ANALYSIS_RUN_ID,
        subjectType: "graph_edge" as unknown as "simulation_state",
        subjectId: "edge_1",
        filePath: "src/edge.ts",
        symbolId: null,
        lineStart: null,
        lineEnd: null,
        columnStart: null,
        columnEnd: null,
        relationshipDescription: "Calls",
        confidence: 1.0,
        metadata: { simulationId: SIMULATION_ID },
        createdAt: new Date(),
      },
      // Evidence with mismatched analysisRunId
      {
        id: "ev_wrong_run",
        analysisRunId: "00000000-0000-4000-8000-000000000000",
        subjectType: "simulation_state",
        subjectId: "sr_01",
        filePath: "src/wrong.ts",
        symbolId: null,
        lineStart: null,
        lineEnd: null,
        columnStart: null,
        columnEnd: null,
        relationshipDescription: "State",
        confidence: 1.0,
        metadata: { simulationId: SIMULATION_ID },
        createdAt: new Date(),
      },
      // Evidence with different simulationId
      {
        id: "ev_diff_sim",
        analysisRunId: ANALYSIS_RUN_ID,
        subjectType: "simulation_state",
        subjectId: "sr_01",
        filePath: "src/diff.ts",
        symbolId: null,
        lineStart: null,
        lineEnd: null,
        columnStart: null,
        columnEnd: null,
        relationshipDescription: "State",
        confidence: 1.0,
        metadata: { simulationId: "88888888-8888-4888-8888-888888888888" },
        createdAt: new Date(),
      },
    ];

    const ctx = assembleSimulationNarrationContext({
      simulation,
      scenario,
      results,
      evidenceRecords,
    });

    // Only the two valid simulation_state evidence records should be included
    assert.deepEqual(Array.from(ctx.allowedEvidenceIds), ["ev_sim_01", "ev_sim_02"]);
    assert.equal(ctx.evidenceRecords.length, 2);
  });

  it("5. Handles empty evidence records cleanly and preserves empty allowedEvidenceIds manifest", () => {
    const simulation = createValidSimulation();
    const scenario = createValidScenario();
    const results = createValidResults();

    const ctx = assembleSimulationNarrationContext({
      simulation,
      scenario,
      results,
      evidenceRecords: [],
    });

    assert.equal(ctx.allowedEvidenceIds.length, 0);
    assert.equal(ctx.evidenceRecords.length, 0);
    assert.equal(ctx.results.length, 2);
    // Findings have empty evidenceIds
    assert.deepEqual(ctx.results[0]?.evidenceIds, []);
    assert.deepEqual(ctx.results[1]?.evidenceIds, []);
  });

  it("6. Prioritizes results by confidence first, severity second, hop distance third, and stable nodeId fourth", () => {
    const simulation = createValidSimulation();
    const scenario = createValidScenario();
    const results: SimulationResult[] = [
      {
        id: "sr_healthy",
        simulationId: SIMULATION_ID,
        nodeId: "node_z_healthy",
        resultingState: "healthy",
        propagationPath: [],
        ruleApplied: "none",
        assumptions: [],
        confidence: 1.0,
        createdAt: new Date(),
      },
      {
        id: "sr_failed_low_conf",
        simulationId: SIMULATION_ID,
        nodeId: "node_a_failed",
        resultingState: "failed",
        propagationPath: [],
        ruleApplied: "rule",
        assumptions: [],
        confidence: 0.8,
        createdAt: new Date(),
      },
      {
        id: "sr_failed_high_conf",
        simulationId: SIMULATION_ID,
        nodeId: "node_b_failed",
        resultingState: "failed",
        propagationPath: [],
        ruleApplied: "target_failure",
        assumptions: [],
        confidence: 1.0,
        createdAt: new Date(),
      },
      {
        id: "sr_degraded_high_conf",
        simulationId: SIMULATION_ID,
        nodeId: "node_c_degraded",
        resultingState: "degraded",
        propagationPath: [],
        ruleApplied: "rule",
        assumptions: [],
        confidence: 1.0,
        createdAt: new Date(),
      },
    ];

    const ctx = assembleSimulationNarrationContext({
      simulation,
      scenario,
      results,
      evidenceRecords: [],
    });

    // 1.0 conf failed (node_b_failed) > 1.0 conf degraded (node_c_degraded) > 1.0 conf healthy (node_z_healthy) > 0.8 conf failed (node_a_failed)
    assert.equal(ctx.results[0]?.nodeId, "node_b_failed");
    assert.equal(ctx.results[1]?.nodeId, "node_c_degraded");
    assert.equal(ctx.results[2]?.nodeId, "node_z_healthy");
    assert.equal(ctx.results[3]?.nodeId, "node_a_failed");
  });

  it("7. Truncates results and evidence transparently when maxResults limit is exceeded", () => {
    const simulation = createValidSimulation();
    const scenario = createValidScenario();
    const results = createValidResults();
    const evidenceRecords = createValidEvidence();

    const ctx = assembleSimulationNarrationContext({
      simulation,
      scenario,
      results,
      evidenceRecords,
      limits: { maxResults: 1 },
    });

    assert.equal(ctx.results.length, 1);
    assert.equal(ctx.truncated, true);
    assert.ok(ctx.truncationReason?.includes("Context limited to top 1 results"));
    assert.equal(ctx.truncation.omittedResultsCount, 1);
    // Allowed manifest must only retain evidence linked to the 1 retained result
    assert.deepEqual(Array.from(ctx.allowedEvidenceIds), ["ev_sim_01"]);
    assert.equal(ctx.evidenceRecords.length, 1);
  });

  it("8. Sanitizes untrusted scenario string content against prompt bloat", () => {
    const simulation = createValidSimulation();
    const longName = "A".repeat(1000);
    const scenario = createValidScenario({ name: longName });
    const results = createValidResults();

    const ctx = assembleSimulationNarrationContext({
      simulation,
      scenario,
      results,
      evidenceRecords: [],
      limits: { maxStringLength: 100 },
    });

    assert.equal(ctx.scenario.name.length, 100);
  });
});
