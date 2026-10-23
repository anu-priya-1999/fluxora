import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  parseCreateScenarioBody,
  parseRunScenarioBody,
  SimulationRequestValidationError,
} from "./simulation-request.ts";
import {
  formatScenarioResponse,
  formatSimulationResponse,
  formatSimulationResultsResponse,
} from "./simulation-response.ts";

describe("Step 55 / Step 56 Web API Contract Alignment", () => {
  const REPO_ID = "11111111-1111-4111-8111-111111111111";
  const RUN_ID = "22222222-2222-4222-8222-222222222222";
  const NODE_ID = "33333333-3333-4333-8333-333333333333";
  const SCENARIO_ID = "44444444-4444-4444-8444-444444444444";
  const SIMULATION_ID = "55555555-5555-4555-8555-555555555555";

  it("successfully parses the exact create scenario payload sent by SimulationStudio", () => {
    // The exact payload constructed by SimulationStudio handleCreateScenario
    const frontendPayload = {
      name: "Payment Gateway Outage",
      target_node_id: NODE_ID,
      failure_type: "unavailable",
      repository_id: REPO_ID,
      analysis_run_id: RUN_ID,
    };

    const parsed = parseCreateScenarioBody(frontendPayload);

    assert.equal(parsed.name, "Payment Gateway Outage");
    assert.equal(parsed.targetNodeId, NODE_ID);
    assert.equal(parsed.failureType, "unavailable");
    assert.equal(parsed.repositoryId, REPO_ID);
    assert.equal(parsed.analysisRunId, RUN_ID);
  });

  it("successfully parses scenario creation with latency failure type", () => {
    const frontendPayload = {
      name: "Slow Database Latency Injection",
      target_node_id: NODE_ID,
      failure_type: "latency",
      analysis_run_id: RUN_ID,
    };

    const parsed = parseCreateScenarioBody(frontendPayload);

    assert.equal(parsed.name, "Slow Database Latency Injection");
    assert.equal(parsed.targetNodeId, NODE_ID);
    assert.equal(parsed.failureType, "latency");
    assert.equal(parsed.analysisRunId, RUN_ID);
  });

  it("explicitly rejects a seed_failures property in parseCreateScenarioBody with SimulationRequestValidationError and invalid_request", () => {
    const payloadWithSeedFailures = {
      name: "Scenario With Seed Failures",
      target_node_id: NODE_ID,
      failure_type: "unavailable",
      seed_failures: [{ node_id: NODE_ID, failure_type: "unavailable" }],
      analysis_run_id: RUN_ID,
    };

    assert.throws(
      () => parseCreateScenarioBody(payloadWithSeedFailures),
      (err) => {
        assert.ok(err instanceof SimulationRequestValidationError);
        assert.equal(err.code, "invalid_request");
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /seed_failures is not supported/i);
        return true;
      },
    );

    const camelCasePayload = {
      name: "Scenario With CamelCase Seed Failures",
      target_node_id: NODE_ID,
      failure_type: "unavailable",
      seedFailures: [{ nodeId: NODE_ID, failureType: "unavailable" }],
      analysis_run_id: RUN_ID,
    };

    assert.throws(
      () => parseCreateScenarioBody(camelCasePayload),
      (err) => {
        assert.ok(err instanceof SimulationRequestValidationError);
        assert.equal(err.code, "invalid_request");
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /seed_failures is not supported/i);
        return true;
      },
    );
  });

  it("rejects client-supplied organization_id strictly", () => {
    const insecurePayload = {
      name: "Tampered Scenario",
      target_node_id: NODE_ID,
      failure_type: "unavailable",
      analysis_run_id: RUN_ID,
      organization_id: "tampered-org-id",
    };

    assert.throws(
      () => parseCreateScenarioBody(insecurePayload),
      (err) => {
        assert.ok(err instanceof SimulationRequestValidationError);
        assert.match(err.message, /Tenant organization cannot be specified/);
        return true;
      },
    );
  });

  it("successfully parses run scenario payload sent by SimulationStudio", () => {
    const frontendRunPayload = {
      analysis_run_id: RUN_ID,
    };

    const parsed = parseRunScenarioBody(frontendRunPayload);
    assert.equal(parsed.analysisRunId, RUN_ID);

    // Empty body also allowed
    const emptyParsed = parseRunScenarioBody({});
    assert.equal(emptyParsed.analysisRunId, undefined);
  });

  it("verifies formatScenarioResponse returns exact fields consumed by ScenarioResponse", () => {
    const formatted = formatScenarioResponse({
      id: SCENARIO_ID,
      organizationId: "org-1",
      repositoryId: REPO_ID,
      name: "Test Scenario",
      targetNodeId: NODE_ID,
      failureType: "unavailable",
      parameters: { analysis_run_id: RUN_ID },
      createdBy: "user-1",
      createdAt: new Date("2026-02-01T12:00:00Z"),
    });

    assert.equal(formatted.id, SCENARIO_ID);
    assert.equal(formatted.organization_id, "org-1");
    assert.equal(formatted.repository_id, REPO_ID);
    assert.equal(formatted.name, "Test Scenario");
    assert.equal(formatted.target_node_id, NODE_ID);
    assert.equal(formatted.failure_type, "unavailable");
    assert.equal(formatted.created_at, "2026-02-01T12:00:00.000Z");
  });

  it("verifies formatSimulationResultsResponse returns total instead of total_affected", () => {
    const formatted = formatSimulationResultsResponse(SIMULATION_ID, [
      {
        id: "res-1",
        simulationId: SIMULATION_ID,
        nodeId: NODE_ID,
        resultingState: "failed",
        propagationPath: [
          {
            nodeId: NODE_ID,
            edgeId: null,
            ruleId: "target_failure",
            ruleVersion: "1.0.0",
            previousState: "healthy",
            resultingState: "failed",
            assumptions: [],
            confidence: 1.0,
          },
        ],
        ruleApplied: "target_failure",
        assumptions: [],
        confidence: 1.0,
        createdAt: new Date("2026-02-01T12:00:00Z"),
      },
    ]);

    assert.equal(formatted.simulation_id, SIMULATION_ID);
    assert.equal(formatted.total, 1);
    assert.equal("total_affected" in formatted, false);
    assert.equal(formatted.results.length, 1);
    assert.equal(formatted.results[0]?.resulting_state, "failed");
    assert.equal(formatted.results[0]?.state, "failed");
    assert.equal("causal_steps" in (formatted.results[0] as unknown as Record<string, unknown>), false);
    assert.ok(Array.isArray(formatted.results[0]?.propagation_path));
  });

  it("verifies formatSimulationResponse handles presence and absence of convergence metadata", () => {
    const baseSimulation = {
      id: SIMULATION_ID,
      scenarioId: SCENARIO_ID,
      analysisRunId: RUN_ID,
      status: "completed" as const,
      createdAt: new Date("2026-02-01T12:00:00Z"),
    };

    // Case 1: GET /simulations/:id (no convergence metadata passed)
    const getSimulationRes = formatSimulationResponse(baseSimulation, []);
    assert.equal(getSimulationRes.id, SIMULATION_ID);
    assert.equal(getSimulationRes.status, "completed");
    assert.equal("converged" in getSimulationRes, false);
    assert.equal("iterations" in getSimulationRes, false);
    assert.equal(getSimulationRes.total_results, 0);

    // Case 2: POST /scenarios/:id/run (convergence metadata passed)
    const runSimulationRes = formatSimulationResponse(baseSimulation, [], {
      converged: true,
      iterations: 3,
    });
    assert.equal(runSimulationRes.converged, true);
    assert.equal(runSimulationRes.iterations, 3);
    assert.equal(runSimulationRes.total_results, 0);
  });
});
