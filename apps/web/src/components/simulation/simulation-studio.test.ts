import assert from "node:assert/strict";
import { test } from "vitest";
import {
  GRAPH_QUERY_PATH,
  SCENARIOS_PATH,
  SIMULATIONS_PATH,
  type CreateScenarioRequest,
  type GraphQueryResponse,
  type RunScenarioRequest,
  type ScenarioResponse,
  type SimulationCausalStep,
  type SimulationResponse,
  type SimulationResultResponse,
  type SimulationResultsListResponse,
} from "@fluxora/shared-types";
import {
  createScenarioApi,
  fetchAnalysisGraph,
  getSimulationApi,
  getSimulationResultsApi,
  runScenarioApi,
} from "./simulation-api.ts";
import {
  calculateSimulationImpact,
  extractCausalSteps,
  filterAndSortSimulationResults,
  formatConfidence,
  getStateBadgeColors,
  validateScenarioInput,
} from "./simulation-helpers.ts";
import { DEFAULT_STUDIO_FILTERS } from "./simulation-types.ts";

const REPO_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const SEED_NODE_ID = "33333333-3333-4333-8333-333333333333";
const DOWNSTREAM_NODE_ID = "44444444-4444-4444-8444-444444444444";
const THIRD_NODE_ID = "55555555-5555-4555-8555-555555555555";
const EDGE_1_ID = "66666666-6666-4666-8666-666666666661";
const EDGE_2_ID = "66666666-6666-4666-8666-666666666662";
const SCENARIO_ID = "77777777-7777-4777-8777-777777777777";
const SIMULATION_ID = "88888888-8888-4888-8888-888888888888";

// ---------------------------------------------------------------------------
// 1. Form Validation Tests
// ---------------------------------------------------------------------------

test("validateScenarioInput validates required fields correctly", () => {
  const invalid = validateScenarioInput({
    name: "",
    targetNodeId: "",
    failureType: "unavailable",
  });

  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.name);
  assert.ok(invalid.errors.targetNodeId);
  assert.equal(invalid.errors.failureType, undefined);
});

test("validateScenarioInput accepts supported failure types: unavailable and latency", () => {
  const validUnavailable = validateScenarioInput({
    name: "Payment Gateway Down",
    targetNodeId: SEED_NODE_ID,
    failureType: "unavailable",
    repositoryId: REPO_ID,
    analysisRunId: RUN_ID,
  });
  assert.equal(validUnavailable.valid, true);

  const validLatency = validateScenarioInput({
    name: "Payment Gateway Latency",
    targetNodeId: SEED_NODE_ID,
    failureType: "latency",
    repositoryId: REPO_ID,
    analysisRunId: RUN_ID,
  });
  assert.equal(validLatency.valid, true);
});

test("validateScenarioInput rejects unsupported failure types", () => {
  const unsupported = validateScenarioInput({
    name: "Capacity Issue",
    targetNodeId: SEED_NODE_ID,
    failureType: "capacity",
  });
  assert.equal(unsupported.valid, false);
  assert.match(unsupported.errors.failureType ?? "", /must be one of: unavailable, latency/);

  const removal = validateScenarioInput({
    name: "Removal Issue",
    targetNodeId: SEED_NODE_ID,
    failureType: "removal",
  });
  assert.equal(removal.valid, false);
});

test("validateScenarioInput validates UUID format for repository and analysis run", () => {
  const invalidUuids = validateScenarioInput({
    name: "Test Scenario",
    targetNodeId: SEED_NODE_ID,
    failureType: "unavailable",
    repositoryId: "not-a-uuid",
    analysisRunId: "invalid-uuid",
  });
  assert.equal(invalidUuids.valid, false);
  assert.ok(invalidUuids.errors.repositoryId);
  assert.ok(invalidUuids.errors.analysisRunId);
});

// ---------------------------------------------------------------------------
// 2. Scenario Creation API Tests (POST /api/v1/scenarios) — Step 55 Contract
// ---------------------------------------------------------------------------

test("createScenarioApi targets POST /api/v1/scenarios with established Step 55 request fields", async () => {
  const requestsMade: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];

  // Step 55 formatScenarioResponse exact output
  const mockScenario: ScenarioResponse = {
    id: SCENARIO_ID,
    organization_id: "org-1",
    repository_id: REPO_ID,
    name: "Payment Provider Outage",
    target_node_id: SEED_NODE_ID,
    failure_type: "unavailable",
    parameters: { analysis_run_id: RUN_ID },
    created_by: "user-1",
    created_at: "2026-02-01T12:00:00.000Z",
  };

  const reqBody: CreateScenarioRequest = {
    name: "Payment Provider Outage",
    target_node_id: SEED_NODE_ID,
    failure_type: "unavailable",
    repository_id: REPO_ID,
    analysis_run_id: RUN_ID,
  };

  const result = await createScenarioApi({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "session-bearer-jwt",
    request: reqBody,
    fetchImpl: async (url, init) => {
      requestsMade.push({
        url,
        init,
        body: JSON.parse(init.body as string),
      });
      return new Response(JSON.stringify(mockScenario), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(requestsMade.length, 1);
  const firstReq = requestsMade[0]!;
  assert.equal(firstReq.url, `http://127.0.0.1:4000${SCENARIOS_PATH}`);
  assert.equal(firstReq.init.method, "POST");

  const headers = firstReq.init.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer session-bearer-jwt");
  assert.equal(headers["content-type"], "application/json");

  // Invariant 1: client sends established Step 55 fields
  assert.equal(firstReq.body["name"], "Payment Provider Outage");
  assert.equal(firstReq.body["target_node_id"], SEED_NODE_ID);
  assert.equal(firstReq.body["failure_type"], "unavailable");
  assert.equal(firstReq.body["repository_id"], REPO_ID);
  assert.equal(firstReq.body["analysis_run_id"], RUN_ID);

  // Invariant 2: client NEVER sends seed_failures or organization_id
  assert.equal("seed_failures" in firstReq.body, false);
  assert.equal("organization_id" in firstReq.body, false);
  assert.equal("organizationId" in firstReq.body, false);

  // Verify consumed response matches ScenarioResponse
  if (result.ok) {
    assert.equal(result.data.id, SCENARIO_ID);
    assert.equal(result.data.target_node_id, SEED_NODE_ID);
    assert.equal(result.data.failure_type, "unavailable");
    assert.equal(result.data.repository_id, REPO_ID);
  }
});

test("createScenarioApi handles unauthenticated session cleanly", async () => {
  const result = await createScenarioApi({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => null,
    request: {
      name: "Test",
      target_node_id: SEED_NODE_ID,
      failure_type: "unavailable",
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "not_authenticated");
    assert.match(result.message, /authentication required/i);
  }
});

test("createScenarioApi handles 400 validation error response from server", async () => {
  const result = await createScenarioApi({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "token",
    request: {
      name: "Test",
      target_node_id: SEED_NODE_ID,
      failure_type: "unavailable",
    },
    fetchImpl: async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: "invalid_request",
            message: "Target node does not exist in repository.",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "invalid_request");
    assert.equal(result.message, "Target node does not exist in repository.");
  }
});

// ---------------------------------------------------------------------------
// 3. Scenario Execution API Tests (POST /api/v1/scenarios/:id/run)
// ---------------------------------------------------------------------------

test("runScenarioApi targets POST /api/v1/scenarios/:id/run consuming Step 55 formatSimulationResponse", async () => {
  const requestsMade: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];

  // Step 55 formatSimulationResponse exact output (with convergence metadata)
  const mockSimulationResponse: SimulationResponse = {
    id: SIMULATION_ID,
    scenario_id: SCENARIO_ID,
    analysis_run_id: RUN_ID,
    status: "completed",
    created_at: "2026-02-01T12:00:00.000Z",
    simulation: {
      id: SIMULATION_ID,
      scenario_id: SCENARIO_ID,
      analysis_run_id: RUN_ID,
      status: "completed",
      created_at: "2026-02-01T12:00:00.000Z",
    },
    results: [
      {
        id: "res-1",
        simulation_id: SIMULATION_ID,
        node_id: SEED_NODE_ID,
        resulting_state: "failed",
        state: "failed",
        propagation_path: [
          {
            nodeId: SEED_NODE_ID,
            edgeId: null,
            ruleId: "target_failure",
            ruleVersion: "1.0.0",
            previousState: "healthy",
            resultingState: "failed",
            assumptions: ["Scenario target node directly seeded as failed (unavailable)"],
            confidence: 1.0,
            capped: false,
          },
        ],
        rule_applied: "target_failure",
        assumptions: ["Scenario target node directly seeded as failed (unavailable)"],
        confidence: 1.0,
        created_at: "2026-02-01T12:00:00.000Z",
      },
    ],
    assumptions: ["Scenario target node directly seeded as failed (unavailable)"],
    total_results: 1,
    converged: true,
    iterations: 1,
  };

  const reqBody: RunScenarioRequest = {
    analysis_run_id: RUN_ID,
  };

  const result = await runScenarioApi({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "session-bearer-jwt",
    scenarioId: SCENARIO_ID,
    request: reqBody,
    fetchImpl: async (url, init) => {
      requestsMade.push({
        url,
        init,
        body: JSON.parse(init.body as string),
      });
      return new Response(JSON.stringify(mockSimulationResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(requestsMade.length, 1);
  const req = requestsMade[0]!;
  assert.equal(req.url, `http://127.0.0.1:4000${SCENARIOS_PATH}/${SCENARIO_ID}/run`);
  assert.equal(req.init.method, "POST");
  assert.equal(req.body["analysis_run_id"], RUN_ID);

  if (result.ok) {
    assert.equal(result.data.id, SIMULATION_ID);
    assert.equal(result.data.status, "completed");
    assert.equal(result.data.converged, true);
    assert.equal(result.data.iterations, 1);
    assert.equal(result.data.total_results, 1);
    assert.equal(result.data.results?.length, 1);
  }
});

test("runScenarioApi validates scenarioId format before network call", async () => {
  const result = await runScenarioApi({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "token",
    scenarioId: "not-a-valid-uuid",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "invalid_request");
    assert.match(result.message, /must be a uuid/i);
  }
});

test("runScenarioApi handles 422 convergence failure cleanly without showing empty success", async () => {
  const result = await runScenarioApi({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "token",
    scenarioId: SCENARIO_ID,
    fetchImpl: async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: "simulation_convergence_failure",
            message: "Simulation propagation exceeded maximum iterations without converging.",
          },
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "convergence_failure");
    assert.match(result.message, /exceeded maximum iterations/i);
  }
});

// ---------------------------------------------------------------------------
// 4. Graph Query API Tests (POST /api/v1/graph/query)
// ---------------------------------------------------------------------------

test("fetchAnalysisGraph targets POST /api/v1/graph/query with start node and run ID", async () => {
  const mockGraph: GraphQueryResponse = {
    nodes: [
      {
        id: SEED_NODE_ID,
        type: "service",
        name: "payment-service",
        canonical_id: "svc:payment",
        depth: 0,
        confidence: 1.0,
      },
      {
        id: DOWNSTREAM_NODE_ID,
        type: "service",
        name: "checkout-service",
        canonical_id: "svc:checkout",
        depth: 1,
        confidence: 0.95,
      },
    ],
    edges: [
      {
        id: EDGE_1_ID,
        source: DOWNSTREAM_NODE_ID,
        target: SEED_NODE_ID,
        type: "CALLS",
        confidence: 0.95,
        provenance: "static-analysis",
      },
    ],
    max_depth_reached: 1,
    truncated: false,
  };

  const result = await fetchAnalysisGraph({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "token",
    analysisRunId: RUN_ID,
    startNodeId: SEED_NODE_ID,
    fetchImpl: async (url, init) => {
      assert.equal(url, `http://127.0.0.1:4000${GRAPH_QUERY_PATH}`);
      assert.equal(init.method, "POST");
      return new Response(JSON.stringify(mockGraph), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.nodes.length, 2);
    assert.equal(result.data.edges.length, 1);
  }
});

// ---------------------------------------------------------------------------
// 5. Simulation Results Retrieval Tests (Step 55 formatSimulationResultsResponse)
// ---------------------------------------------------------------------------

test("getSimulationResultsApi retrieves persisted results list with total field and propagation_path", async () => {
  // Step 55 formatSimulationResultsResponse exact output
  const mockList: SimulationResultsListResponse = {
    simulation_id: SIMULATION_ID,
    results: [
      {
        id: "res-1",
        simulation_id: SIMULATION_ID,
        node_id: SEED_NODE_ID,
        resulting_state: "failed",
        state: "failed",
        propagation_path: [
          {
            nodeId: SEED_NODE_ID,
            edgeId: null,
            ruleId: "target_failure",
            ruleVersion: "1.0.0",
            previousState: "healthy",
            resultingState: "failed",
            assumptions: ["Scenario target node directly seeded as failed"],
            confidence: 1.0,
            capped: false,
          },
        ],
        rule_applied: "target_failure",
        assumptions: ["Scenario target node directly seeded as failed"],
        confidence: 1.0,
        created_at: "2026-02-01T12:00:00.000Z",
      },
      {
        id: "res-2",
        simulation_id: SIMULATION_ID,
        node_id: DOWNSTREAM_NODE_ID,
        resulting_state: "degraded",
        state: "degraded",
        propagation_path: [
          {
            nodeId: SEED_NODE_ID,
            edgeId: null,
            ruleId: "target_failure",
            ruleVersion: "1.0.0",
            previousState: "healthy",
            resultingState: "failed",
            assumptions: [],
            confidence: 1.0,
          },
          {
            nodeId: DOWNSTREAM_NODE_ID,
            edgeId: EDGE_1_ID,
            ruleId: "CALLS_SYNC_NO_FALLBACK",
            ruleVersion: "1.0.0",
            previousState: "healthy",
            resultingState: "degraded",
            assumptions: ["No fallback handler detected"],
            confidence: 0.9,
            capped: false,
          },
        ],
        rule_applied: "CALLS_SYNC_NO_FALLBACK",
        assumptions: ["No fallback handler detected"],
        confidence: 0.9,
        created_at: "2026-02-01T12:00:00.000Z",
      },
    ],
    total: 2,
  };

  const result = await getSimulationResultsApi({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "token",
    simulationId: SIMULATION_ID,
    fetchImpl: async (url) => {
      assert.equal(url, `http://127.0.0.1:4000${SIMULATIONS_PATH}/${SIMULATION_ID}/results`);
      return new Response(JSON.stringify(mockList), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.simulation_id, SIMULATION_ID);
    assert.equal(result.data.total, 2);
    assert.equal(result.data.results.length, 2);
    assert.equal(result.data.results[0]!.resulting_state, "failed");
    assert.equal(result.data.results[1]!.resulting_state, "degraded");
  }
});

test("getSimulationApi handles GET /simulations/:id response without convergence metadata", async () => {
  // Step 55 handleGetSimulation output (does NOT pass convergence metadata)
  const mockGetSimulation: SimulationResponse = {
    id: SIMULATION_ID,
    scenario_id: SCENARIO_ID,
    analysis_run_id: RUN_ID,
    status: "completed",
    created_at: "2026-02-01T12:00:00.000Z",
    simulation: {
      id: SIMULATION_ID,
      scenario_id: SCENARIO_ID,
      analysis_run_id: RUN_ID,
      status: "completed",
      created_at: "2026-02-01T12:00:00.000Z",
    },
    results: [],
    assumptions: [],
    total_results: 0,
  };

  const result = await getSimulationApi({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "token",
    simulationId: SIMULATION_ID,
    fetchImpl: async (url) => {
      assert.equal(url, `http://127.0.0.1:4000${SIMULATIONS_PATH}/${SIMULATION_ID}`);
      return new Response(JSON.stringify(mockGetSimulation), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.id, SIMULATION_ID);
    assert.equal(result.data.status, "completed");
    assert.equal(result.data.converged, undefined);
    assert.equal(result.data.iterations, undefined);
  }
});

test("getSimulationApi handles 404 simulation not found", async () => {
  const result = await getSimulationApi({
    apiUrl: "http://127.0.0.1:4000",
    getToken: async () => "token",
    simulationId: SIMULATION_ID,
    fetchImpl: async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: "not_found",
            message: "Simulation not found.",
          },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "not_found");
    assert.match(result.message, /not found/i);
  }
});

// ---------------------------------------------------------------------------
// 6. Impact Summary Computation Tests across Canonical States
// ---------------------------------------------------------------------------

test("calculateSimulationImpact accurately aggregates counts across all 4 canonical states", () => {
  const results: SimulationResultResponse[] = [
    {
      id: "res-1",
      simulation_id: SIMULATION_ID,
      node_id: SEED_NODE_ID,
      resulting_state: "failed",
      state: "failed",
      propagation_path: [
        {
          nodeId: SEED_NODE_ID,
          edgeId: null,
          ruleId: "target_failure",
          ruleVersion: "1.0.0",
          previousState: "healthy",
          resultingState: "failed",
          assumptions: [],
          confidence: 1.0,
          capped: false,
        },
      ],
      rule_applied: "target_failure",
      assumptions: [],
      confidence: 1.0,
      created_at: new Date().toISOString(),
    },
    {
      id: "res-2",
      simulation_id: SIMULATION_ID,
      node_id: DOWNSTREAM_NODE_ID,
      resulting_state: "degraded",
      state: "degraded",
      propagation_path: [
        {
          nodeId: DOWNSTREAM_NODE_ID,
          edgeId: EDGE_1_ID,
          ruleId: "CALLS_SYNC_NO_FALLBACK",
          ruleVersion: "1.0.0",
          previousState: "healthy",
          resultingState: "degraded",
          assumptions: ["No circuit breaker detected on call"],
          confidence: 0.9,
          capped: false,
        },
      ],
      rule_applied: "CALLS_SYNC_NO_FALLBACK",
      assumptions: ["No circuit breaker detected on call"],
      confidence: 0.9,
      created_at: new Date().toISOString(),
    },
    {
      id: "res-3",
      simulation_id: SIMULATION_ID,
      node_id: THIRD_NODE_ID,
      resulting_state: "at_risk",
      state: "at_risk",
      propagation_path: [
        {
          nodeId: THIRD_NODE_ID,
          edgeId: EDGE_2_ID,
          ruleId: "CALLS_CIRCUIT_BREAKER",
          ruleVersion: "1.0.0",
          previousState: "healthy",
          resultingState: "at_risk",
          assumptions: ["Circuit breaker confirmed"],
          confidence: 1.0,
          capped: true,
        },
      ],
      rule_applied: "CALLS_CIRCUIT_BREAKER",
      assumptions: ["Circuit breaker confirmed"],
      confidence: 1.0,
      created_at: new Date().toISOString(),
    },
    {
      id: "res-4",
      simulation_id: SIMULATION_ID,
      node_id: "node-healthy-4",
      resulting_state: "healthy",
      state: "healthy",
      propagation_path: [],
      rule_applied: "none",
      assumptions: [],
      confidence: 1.0,
      created_at: new Date().toISOString(),
    },
  ];

  const summary = calculateSimulationImpact(
    results,
    {
      id: SIMULATION_ID,
      scenario_id: SCENARIO_ID,
      analysis_run_id: RUN_ID,
      status: "completed",
      created_at: new Date().toISOString(),
      converged: true,
      iterations: 2,
    },
    4,
  );

  assert.equal(summary.totalAffected, 4);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.degradedCount, 1);
  assert.equal(summary.atRiskCount, 1);
  assert.equal(summary.healthyCount, 1);
  assert.equal(summary.cappedCount, 1);
  assert.equal(summary.converged, true);
  assert.equal(summary.iterations, 2);
  assert.equal(summary.ruleTableVersion, "1.0.0");
});

test("calculateSimulationImpact derives ruleTableVersion from causal step without assuming server returned it", () => {
  const resultsWithVersion: SimulationResultResponse[] = [
    {
      id: "res-1",
      simulation_id: SIMULATION_ID,
      node_id: SEED_NODE_ID,
      resulting_state: "failed",
      state: "failed",
      propagation_path: [
        {
          nodeId: SEED_NODE_ID,
          edgeId: null,
          ruleId: "target_failure",
          ruleVersion: "2.1.0",
          previousState: "healthy",
          resultingState: "failed",
          assumptions: [],
          confidence: 1.0,
        },
      ],
      rule_applied: "target_failure",
      assumptions: [],
      confidence: 1.0,
      created_at: new Date().toISOString(),
    },
  ];

  const summary = calculateSimulationImpact(resultsWithVersion);
  assert.equal(summary.ruleTableVersion, "2.1.0");
  assert.equal(summary.converged, undefined);
  assert.equal(summary.iterations, undefined);
});

// ---------------------------------------------------------------------------
// 7. Multi-Hop Causal Path Extraction & Formatting Tests
// ---------------------------------------------------------------------------

test("extractCausalSteps parses multi-hop causal chain matching Step 54 engine output", () => {
  const seedStep: SimulationCausalStep = {
    nodeId: SEED_NODE_ID,
    edgeId: null,
    ruleId: "target_failure",
    ruleVersion: "1.0.0",
    previousState: "healthy",
    resultingState: "failed",
    assumptions: ["Scenario target node directly seeded as failed (unavailable)"],
    confidence: 1.0,
    capped: false,
  };

  const downstreamStep: SimulationCausalStep = {
    nodeId: DOWNSTREAM_NODE_ID,
    edgeId: EDGE_1_ID,
    ruleId: "CALLS_SYNC_NO_FALLBACK",
    ruleVersion: "1.0.0",
    previousState: "healthy",
    resultingState: "degraded",
    assumptions: ["No fallback handler detected on sync call"],
    confidence: 0.9,
    capped: false,
  };

  const thirdStep: SimulationCausalStep = {
    nodeId: THIRD_NODE_ID,
    edgeId: EDGE_2_ID,
    ruleId: "CALLS_CIRCUIT_BREAKER",
    ruleVersion: "1.0.0",
    previousState: "healthy",
    resultingState: "at_risk",
    assumptions: ["Circuit breaker tripped"],
    confidence: 0.95,
    capped: true,
  };

  const result: SimulationResultResponse = {
    id: "res-3",
    simulation_id: SIMULATION_ID,
    node_id: THIRD_NODE_ID,
    resulting_state: "at_risk",
    state: "at_risk",
    propagation_path: [seedStep, downstreamStep, thirdStep],
    rule_applied: "CALLS_CIRCUIT_BREAKER",
    assumptions: [
      "Scenario target node directly seeded as failed (unavailable)",
      "No fallback handler detected on sync call",
      "Circuit breaker tripped",
    ],
    confidence: 0.95,
    created_at: new Date().toISOString(),
  };

  const steps = extractCausalSteps(result);
  assert.equal(steps.length, 3);

  // Step 0: Seed failure
  const s0 = steps[0]!;
  assert.equal(s0.nodeId, SEED_NODE_ID);
  assert.equal(s0.edgeId, null);
  assert.equal(s0.ruleId, "target_failure");
  assert.equal(s0.previousState, "healthy");
  assert.equal(s0.resultingState, "failed");
  assert.equal(s0.capped, false);

  // Step 1: Intermediate call
  const s1 = steps[1]!;
  assert.equal(s1.nodeId, DOWNSTREAM_NODE_ID);
  assert.equal(s1.edgeId, EDGE_1_ID);
  assert.equal(s1.ruleId, "CALLS_SYNC_NO_FALLBACK");
  assert.equal(s1.previousState, "healthy");
  assert.equal(s1.resultingState, "degraded");

  // Step 2: Capped circuit breaker call
  const s2 = steps[2]!;
  assert.equal(s2.nodeId, THIRD_NODE_ID);
  assert.equal(s2.edgeId, EDGE_2_ID);
  assert.equal(s2.ruleId, "CALLS_CIRCUIT_BREAKER");
  assert.equal(s2.resultingState, "at_risk");
  assert.equal(s2.capped, true);
});

test("formatConfidence formats decimal scores as percentages without fabricating probabilities", () => {
  assert.equal(formatConfidence(1.0), "100%");
  assert.equal(formatConfidence(0.9), "90%");
  assert.equal(formatConfidence(0.81), "81%");
  assert.equal(formatConfidence(0.0), "0%");
});

// ---------------------------------------------------------------------------
// 8. Sorting and Filtering Tests across Canonical States
// ---------------------------------------------------------------------------

test("filterAndSortSimulationResults filters by state and search query", () => {
  const results: SimulationResultResponse[] = [
    {
      id: "res-1",
      simulation_id: SIMULATION_ID,
      node_id: SEED_NODE_ID,
      resulting_state: "failed",
      state: "failed",
      propagation_path: [],
      rule_applied: "target_failure",
      assumptions: [],
      confidence: 1.0,
      created_at: new Date().toISOString(),
    },
    {
      id: "res-2",
      simulation_id: SIMULATION_ID,
      node_id: DOWNSTREAM_NODE_ID,
      resulting_state: "degraded",
      state: "degraded",
      propagation_path: [],
      rule_applied: "CALLS_SYNC_NO_FALLBACK",
      assumptions: [],
      confidence: 0.9,
      created_at: new Date().toISOString(),
    },
  ];

  const nodeNameMap = new Map<string, string>([
    [SEED_NODE_ID, "PaymentService"],
    [DOWNSTREAM_NODE_ID, "CheckoutService"],
  ]);

  // Filter by state "failed"
  const failedOnly = filterAndSortSimulationResults(
    results,
    { ...DEFAULT_STUDIO_FILTERS, stateFilter: "failed" },
    nodeNameMap,
  );
  assert.equal(failedOnly.length, 1);
  assert.equal(failedOnly[0]!.node_id, SEED_NODE_ID);

  // Filter by text search "checkout"
  const checkoutSearch = filterAndSortSimulationResults(
    results,
    { ...DEFAULT_STUDIO_FILTERS, searchQuery: "checkout" },
    nodeNameMap,
  );
  assert.equal(checkoutSearch.length, 1);
  assert.equal(checkoutSearch[0]!.node_id, DOWNSTREAM_NODE_ID);
});

test("filterAndSortSimulationResults sorts by canonical severity descending", () => {
  const results: SimulationResultResponse[] = [
    {
      id: "res-healthy",
      simulation_id: SIMULATION_ID,
      node_id: "node-h",
      resulting_state: "healthy",
      state: "healthy",
      propagation_path: [],
      rule_applied: "none",
      assumptions: [],
      confidence: 1.0,
      created_at: new Date().toISOString(),
    },
    {
      id: "res-failed",
      simulation_id: SIMULATION_ID,
      node_id: "node-f",
      resulting_state: "failed",
      state: "failed",
      propagation_path: [],
      rule_applied: "target_failure",
      assumptions: [],
      confidence: 1.0,
      created_at: new Date().toISOString(),
    },
    {
      id: "res-at-risk",
      simulation_id: SIMULATION_ID,
      node_id: "node-ar",
      resulting_state: "at_risk",
      state: "at_risk",
      propagation_path: [],
      rule_applied: "CALLS_CIRCUIT_BREAKER",
      assumptions: [],
      confidence: 0.95,
      created_at: new Date().toISOString(),
    },
    {
      id: "res-degraded",
      simulation_id: SIMULATION_ID,
      node_id: "node-d",
      resulting_state: "degraded",
      state: "degraded",
      propagation_path: [],
      rule_applied: "CALLS_SYNC",
      assumptions: [],
      confidence: 0.9,
      created_at: new Date().toISOString(),
    },
  ];

  const sortedDesc = filterAndSortSimulationResults(results, {
    stateFilter: "all",
    searchQuery: "",
    sortBy: "state",
    sortDirection: "desc",
  });

  // Severity order: failed (4) -> degraded (3) -> at_risk (2) -> healthy (1)
  assert.equal(sortedDesc[0]!.resulting_state, "failed");
  assert.equal(sortedDesc[1]!.resulting_state, "degraded");
  assert.equal(sortedDesc[2]!.resulting_state, "at_risk");
  assert.equal(sortedDesc[3]!.resulting_state, "healthy");
});

test("getStateBadgeColors returns correct styling properties for all 4 canonical result states", () => {
  const failed = getStateBadgeColors("failed");
  assert.equal(failed.label, "Failed");
  assert.match(failed.text, /text-red/);

  const degraded = getStateBadgeColors("degraded");
  assert.equal(degraded.label, "Degraded");
  assert.match(degraded.text, /text-amber/);

  const atRisk = getStateBadgeColors("at_risk");
  assert.equal(atRisk.label, "At Risk");
  assert.match(atRisk.text, /text-yellow/);

  const healthy = getStateBadgeColors("healthy");
  assert.equal(healthy.label, "Healthy");
  assert.match(healthy.text, /text-emerald/);
});
