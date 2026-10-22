import assert from "node:assert/strict";
import http from "node:http";
import { afterAll, beforeAll, describe, it } from "vitest";

import {
  ScenarioNotFoundError,
  SimulationConvergenceError,
  SimulationNotFoundError,
  SimulationPersistenceValidationError,
  UnsupportedScenarioFailureTypeError,
} from "@fluxora/db";
import type {
  EvidenceRecord,
  Scenario,
  ScenarioResponse,
  Simulation,
  SimulationCausalStep,
  SimulationEngineResult,
  SimulationResponse,
  SimulationResult,
  SimulationResultsListResponse,
  User,
} from "@fluxora/shared-types";

import { createApiServer } from "./server.ts";
import {
  defaultResolveAnalysisRunAndRepo,
  defaultResolveTargetNodeAnalysisRun,
  defaultVerifyTargetNodeInAnalysisRun,
  type SimulationHandlerDependencies,
} from "./simulation.ts";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const REPO_A = "66666666-6666-4666-8666-666666666666";
const REPO_B = "77777777-7777-4777-8777-777777777777";

const RUN_A1 = "88888888-8888-4888-8888-888888888881";
const RUN_A2 = "88888888-8888-4888-8888-888888888882";
const RUN_B = "88888888-8888-4888-8888-888888888883";

const NODE_A1 = "99999999-9999-4999-8999-999999999991"; // in RUN_A1, REPO_A
const NODE_A2 = "99999999-9999-4999-8999-999999999992"; // in RUN_A2, REPO_A
const NODE_B = "99999999-9999-4999-8999-999999999993"; // in RUN_B, REPO_B

const SCENARIO_A = "aaaaaaaa-1111-4111-8111-111111111111";
const SCENARIO_B = "bbbbbbbb-2222-4222-8222-222222222222";
const SCENARIO_UNSUPPORTED = "aaaaaaaa-9999-4999-8999-999999999999";

const SIMULATION_A = "cccccccc-3333-4333-8333-333333333333";
const SIMULATION_B = "dddddddd-4444-4444-8444-444444444444";
const SIMULATION_EMPTY = "eeeeeeee-5555-4555-8555-555555555555";

type ErrorResponse = {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
};

type TestResponseBody =
  | ScenarioResponse
  | SimulationResponse
  | SimulationResultsListResponse
  | ErrorResponse
  | { readonly raw: string; readonly [key: string]: unknown };

function expectError(body: TestResponseBody): ErrorResponse {
  if (!("error" in body)) {
    throw new Error(`Expected error response, got ${JSON.stringify(body)}`);
  }
  return body as ErrorResponse;
}

function setupTestEnvironment() {
  const userA: User = {
    id: USER_A,
    organizationId: ORG_A,
    role: "owner",
    githubUserId: 1001,
    email: "userA@example.com",
    createdAt: new Date(),
  };

  const userB: User = {
    id: USER_B,
    organizationId: ORG_B,
    role: "owner",
    githubUserId: 1002,
    email: "userB@example.com",
    createdAt: new Date(),
  };

  const scenariosStore = new Map<string, Scenario>([
    [
      `${ORG_A}:${SCENARIO_A}`,
      {
        id: SCENARIO_A,
        organizationId: ORG_A,
        repositoryId: REPO_A,
        name: "Payment provider unavailable",
        targetNodeId: NODE_A1,
        failureType: "unavailable",
        parameters: { analysis_run_id: RUN_A1 },
        createdBy: USER_A,
        createdAt: new Date("2026-02-01T10:00:00Z"),
      },
    ],
    [
      `${ORG_B}:${SCENARIO_B}`,
      {
        id: SCENARIO_B,
        organizationId: ORG_B,
        repositoryId: REPO_B,
        name: "Org B Scenario",
        targetNodeId: NODE_B,
        failureType: "unavailable",
        parameters: { analysis_run_id: RUN_B },
        createdBy: USER_B,
        createdAt: new Date("2026-02-01T11:00:00Z"),
      },
    ],
    [
      `${ORG_A}:${SCENARIO_UNSUPPORTED}`,
      {
        id: SCENARIO_UNSUPPORTED,
        organizationId: ORG_A,
        repositoryId: REPO_A,
        name: "Legacy Capacity Scenario",
        targetNodeId: NODE_A1,
        failureType: "capacity" as Scenario["failureType"],
        parameters: { analysis_run_id: RUN_A1 },
        createdBy: USER_A,
        createdAt: new Date("2026-02-01T10:00:00Z"),
      },
    ],
  ]);

  const simulationsStore = new Map<string, Simulation>([
    [
      `${ORG_A}:${SIMULATION_A}`,
      {
        id: SIMULATION_A,
        scenarioId: SCENARIO_A,
        analysisRunId: RUN_A1,
        status: "completed",
        createdAt: new Date("2026-02-01T12:00:00Z"),
      },
    ],
    [
      `${ORG_B}:${SIMULATION_B}`,
      {
        id: SIMULATION_B,
        scenarioId: SCENARIO_B,
        analysisRunId: RUN_B,
        status: "completed",
        createdAt: new Date("2026-02-01T12:00:00Z"),
      },
    ],
    [
      `${ORG_A}:${SIMULATION_EMPTY}`,
      {
        id: SIMULATION_EMPTY,
        scenarioId: SCENARIO_A,
        analysisRunId: RUN_A1,
        status: "pending",
        createdAt: new Date("2026-02-01T13:00:00Z"),
      },
    ],
  ]);

  const causalStep1: SimulationCausalStep = {
    nodeId: NODE_A1,
    edgeId: null,
    ruleId: "target_failure",
    ruleVersion: "1.0.0",
    previousState: "healthy",
    resultingState: "failed",
    assumptions: [],
    confidence: 1.0,
  };

  const causalStep2: SimulationCausalStep = {
    nodeId: NODE_A2,
    edgeId: "edge-1234",
    ruleId: "CALLS+sync+no_fallback",
    ruleVersion: "1.0.0",
    previousState: "healthy",
    resultingState: "degraded",
    assumptions: ["No circuit breaker detected on call"],
    confidence: 0.9,
  };

  const resultsStore = new Map<string, SimulationResult[]>([
    [
      `${ORG_A}:${SIMULATION_A}`,
      [
        {
          id: "result-1",
          simulationId: SIMULATION_A,
          nodeId: NODE_A1,
          resultingState: "failed",
          propagationPath: [causalStep1],
          ruleApplied: "target_failure",
          assumptions: [],
          confidence: 1.0,
          createdAt: new Date("2026-02-01T12:01:00Z"),
        },
        {
          id: "result-2",
          simulationId: SIMULATION_A,
          nodeId: NODE_A2,
          resultingState: "degraded",
          propagationPath: [causalStep1, causalStep2],
          ruleApplied: "CALLS+sync+no_fallback",
          assumptions: ["No circuit breaker detected on call"],
          confidence: 0.9,
          createdAt: new Date("2026-02-01T12:02:00Z"),
        },
      ],
    ],
    [`${ORG_B}:${SIMULATION_B}`, []],
    [`${ORG_A}:${SIMULATION_EMPTY}`, []],
  ]);

  let executeSimulationInvocations = 0;
  let lastExecutedSimulationId: string | null = null;
  let executeSimulationError: Error | null = null;
  let listSimulationResultsError: Error | null = null;

  const deps: SimulationHandlerDependencies = {
    async authenticateClerkToken(authHeader: string | undefined): Promise<string> {
      if (!authHeader?.startsWith("Bearer ")) {
        throw new Error("Missing bearer token.");
      }
      const token = authHeader.slice("Bearer ".length).trim();
      if (token === "token-org-a") return "clerk-user-a";
      if (token === "token-org-b") return "clerk-user-b";
      if (token === "token-no-github") return "clerk-user-no-github";
      throw new Error("Invalid token.");
    },

    async getClerkGithubIdentity(clerkUserId: string) {
      if (clerkUserId === "clerk-user-a") {
        return {
          ok: true as const,
          githubUserId: "1001",
          email: "userA@example.com",
          organizationName: "Org A",
        };
      }
      if (clerkUserId === "clerk-user-b") {
        return {
          ok: true as const,
          githubUserId: "1002",
          email: "userB@example.com",
          organizationName: "Org B",
        };
      }
      return {
        ok: false as const,
        code: "github_account_required" as const,
        message: "No github account.",
      };
    },

    async provisionGithubUser(_pool, input) {
      if (input.githubUserId === 1001) return userA;
      return userB;
    },

    async getUserById(_pool, orgId, userId) {
      if (orgId === ORG_A && userId === USER_A) return userA;
      if (orgId === ORG_B && userId === USER_B) return userB;
      throw new Error("User not found");
    },

    async resolveAnalysisRunAndRepo(_pool, organizationId, analysisRunId) {
      if (organizationId === ORG_A) {
        if (analysisRunId === RUN_A1 || analysisRunId === RUN_A2) {
          return { repositoryId: REPO_A };
        }
      }
      if (organizationId === ORG_B && analysisRunId === RUN_B) {
        return { repositoryId: REPO_B };
      }
      return null;
    },

    async verifyTargetNodeInAnalysisRun(_pool, organizationId, analysisRunId, targetNodeId) {
      if (organizationId === ORG_A) {
        if (analysisRunId === RUN_A1 && targetNodeId === NODE_A1) return true;
        if (analysisRunId === RUN_A2 && targetNodeId === NODE_A2) return true;
      }
      if (organizationId === ORG_B && analysisRunId === RUN_B && targetNodeId === NODE_B) {
        return true;
      }
      return false;
    },

    async resolveTargetNodeAnalysisRun(_pool, organizationId, repositoryId, targetNodeId) {
      if (organizationId === ORG_A && repositoryId === REPO_A) {
        if (targetNodeId === NODE_A1) return { analysisRunId: RUN_A1 };
        if (targetNodeId === NODE_A2) return { analysisRunId: RUN_A2 };
      }
      if (organizationId === ORG_B && repositoryId === REPO_B && targetNodeId === NODE_B) {
        return { analysisRunId: RUN_B };
      }
      return null;
    },

    async createScenario(_pool, input) {
      const id = "created-scenario-" + Math.random().toString(36).slice(2, 9);
      const scenario: Scenario = {
        id,
        organizationId: input.organizationId,
        repositoryId: input.repositoryId,
        name: input.name,
        targetNodeId: input.targetNodeId,
        failureType: input.failureType,
        parameters: input.parameters ?? {},
        createdBy: input.createdBy ?? null,
        createdAt: new Date(),
      };
      scenariosStore.set(`${input.organizationId}:${id}`, scenario);
      return scenario;
    },

    async getScenarioById(_pool, organizationId, scenarioId) {
      return scenariosStore.get(`${organizationId}:${scenarioId}`) ?? null;
    },

    async createSimulation(_pool, organizationId, input) {
      const scenario = scenariosStore.get(`${organizationId}:${input.scenarioId}`);
      if (!scenario) {
        throw new ScenarioNotFoundError("Scenario not found or inaccessible for this organization.");
      }
      if (input.analysisRunId !== RUN_A1 && input.analysisRunId !== RUN_A2 && input.analysisRunId !== RUN_B) {
        throw new SimulationPersistenceValidationError(
          "Analysis run does not belong to the scenario's repository.",
        );
      }
      const id = "sim-" + Math.random().toString(36).slice(2, 9);
      const sim: Simulation = {
        id,
        scenarioId: input.scenarioId,
        analysisRunId: input.analysisRunId,
        status: input.status ?? "pending",
        createdAt: new Date(),
      };
      simulationsStore.set(`${organizationId}:${id}`, sim);
      return sim;
    },

    async getSimulationById(_pool, organizationId, simulationId) {
      return simulationsStore.get(`${organizationId}:${simulationId}`) ?? null;
    },

    async listSimulationResults(_pool, organizationId, simulationId) {
      if (listSimulationResultsError) {
        throw listSimulationResultsError;
      }
      const sim = simulationsStore.get(`${organizationId}:${simulationId}`);
      if (!sim) {
        return [];
      }
      return resultsStore.get(`${organizationId}:${simulationId}`) ?? [];
    },

    async executeSimulation(_pool, organizationId, simulationId) {
      executeSimulationInvocations += 1;
      lastExecutedSimulationId = simulationId;

      const sim = simulationsStore.get(`${organizationId}:${simulationId}`);
      if (!sim) {
        throw new SimulationNotFoundError("Simulation not found.");
      }

      if (executeSimulationError) {
        simulationsStore.set(`${organizationId}:${simulationId}`, {
          ...sim,
          status: "failed",
        });
        throw executeSimulationError;
      }

      const scenario = scenariosStore.get(`${organizationId}:${sim.scenarioId}`);
      if (!scenario) {
        throw new ScenarioNotFoundError("Scenario not found.");
      }

      if (scenario.failureType !== "unavailable" && scenario.failureType !== "latency") {
        simulationsStore.set(`${organizationId}:${simulationId}`, {
          ...sim,
          status: "failed",
        });
        throw new UnsupportedScenarioFailureTypeError(scenario.failureType);
      }

      const updatedSim: Simulation = {
        ...sim,
        status: "completed",
      };
      simulationsStore.set(`${organizationId}:${simulationId}`, updatedSim);

      const savedResults: SimulationResult[] = [
        {
          id: `res-${simulationId}-1`,
          simulationId,
          nodeId: scenario.targetNodeId,
          resultingState: scenario.failureType === "unavailable" ? "failed" : "degraded",
          propagationPath: [causalStep1],
          ruleApplied: "target_failure",
          assumptions: [],
          confidence: 1.0,
          createdAt: new Date(),
        },
      ];
      resultsStore.set(`${organizationId}:${simulationId}`, savedResults);

      const engineResult: SimulationEngineResult = {
        converged: true,
        iterations: 1,
        ruleTableVersion: "1.0.0",
        results: [],
        nodeStates: new Map(),
      };

      const evidence: EvidenceRecord[] = [
        {
          id: `ev-${simulationId}-1`,
          analysisRunId: sim.analysisRunId,
          subjectType: "simulation_state",
          subjectId: savedResults[0]!.id,
          filePath: "src/PaymentProvider.ts",
          symbolId: null,
          lineStart: 1,
          lineEnd: 20,
          columnStart: 1,
          columnEnd: 10,
          relationshipDescription: "Simulation state set to failed because node is target failure",
          confidence: 1.0,
          metadata: {},
          createdAt: new Date(),
        },
      ];

      return {
        simulation: updatedSim,
        engineResult,
        savedResults,
        evidence,
      };
    },

    pool: {} as unknown as import("pg").Pool,
  };

  return {
    deps,
    scenariosStore,
    simulationsStore,
    resultsStore,
    getExecuteCount: () => executeSimulationInvocations,
    getLastExecutedSimId: () => lastExecutedSimulationId,
    setExecuteSimulationError: (err: Error | null) => {
      executeSimulationError = err;
    },
    setListSimulationResultsError: (err: Error | null) => {
      listSimulationResultsError = err;
    },
  };
}

async function request(
  server: http.Server,
  options: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  },
): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: TestResponseBody;
}> {
  const address = server.address() as { port: number };
  const port = address.port;

  return new Promise((resolve, reject) => {
    let payload: string | undefined;
    if (options.rawBody !== undefined) {
      payload = options.rawBody;
    } else if (options.body !== undefined) {
      payload = JSON.stringify(options.body);
    }

    const headers: Record<string, string> = {
      ...(payload !== undefined
        ? {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload).toString(),
          }
        : {}),
      ...options.headers,
    };

    const req = http.request(
      `http://127.0.0.1:${port}${options.path}`,
      {
        method: options.method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let body: TestResponseBody;
          try {
            body = raw.length > 0 ? (JSON.parse(raw) as TestResponseBody) : ({ raw } as TestResponseBody);
          } catch {
            body = { raw };
          }
          resolve({
            statusCode: res.statusCode ?? 500,
            headers: res.headers,
            body,
          });
        });
      },
    );

    req.on("error", reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

describe("Simulation HTTP APIs (Step 55)", () => {
  let server: http.Server;
  let testEnv: ReturnType<typeof setupTestEnvironment>;

  beforeAll(async () => {
    testEnv = setupTestEnvironment();
    server = createApiServer({
      wsOptions: { autoStartListener: false },
      simulationDeps: testEnv.deps,
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  // =========================================================================
  // Endpoint A — POST /scenarios
  // =========================================================================

  describe("Endpoint A — Create a Scenario (POST /scenarios)", () => {
    it("1. Authenticated request creates a valid scenario with 201 Created", async () => {
      const res = await request(server, {
        method: "POST",
        path: "/scenarios",
        headers: { Authorization: "Bearer token-org-a" },
        body: {
          name: "Payment Gateway Outage",
          target_node_id: NODE_A1,
          failure_type: "unavailable",
          repository_id: REPO_A,
          parameters: { environment: "production" },
        },
      });

      assert.equal(res.statusCode, 201);
      const data = res.body as ScenarioResponse;
      assert.ok(data.id);
      assert.equal(data.name, "Payment Gateway Outage");
      assert.equal(data.organization_id, ORG_A);
      assert.equal(data.repository_id, REPO_A);
      assert.equal(data.target_node_id, NODE_A1);
      assert.equal(data.failure_type, "unavailable");
      assert.deepEqual(data.parameters, {
        environment: "production",
      });
      assert.equal(data.created_by, USER_A);
      assert.ok(data.created_at);
      // Flat ScenarioResponse contract without redundant nested wrapper
      assert.equal((res.body as Record<string, unknown>).scenario, undefined);
    });

    it("1b. Accepts /api/v1/scenarios prefix identically", async () => {
      const res = await request(server, {
        method: "POST",
        path: "/api/v1/scenarios",
        headers: { Authorization: "Bearer token-org-a" },
        body: {
          name: "Slow Cache",
          target_node_id: NODE_A2,
          failure_type: "latency",
          analysis_run_id: RUN_A2,
        },
      });

      assert.equal(res.statusCode, 201);
      const data = res.body as ScenarioResponse;
      assert.equal(data.name, "Slow Cache");
      assert.equal(data.failure_type, "latency");
      assert.equal((res.body as Record<string, unknown>).scenario, undefined);
      assert.equal(data.repository_id, REPO_A);
    });

    it("2. Missing required fields are rejected with 400 invalid_request", async () => {
      const res = await request(server, {
        method: "POST",
        path: "/scenarios",
        headers: { Authorization: "Bearer token-org-a" },
        body: {
          target_node_id: NODE_A1,
          failure_type: "unavailable",
          repository_id: REPO_A,
        },
      });

      assert.equal(res.statusCode, 400);
      const err = expectError(res.body);
      assert.equal(err.error.code, "invalid_request");
      assert.ok(err.error.message.includes("name is required"));
    });

    it("3. Malformed JSON returns 400 invalid_json", async () => {
      const res = await request(server, {
        method: "POST",
        path: "/scenarios",
        headers: { Authorization: "Bearer token-org-a" },
        rawBody: "{ invalid json ...",
      });

      assert.equal(res.statusCode, 400);
      const err = expectError(res.body);
      assert.equal(err.error.code, "invalid_json");
    });

    it("4. Unsupported failure types are rejected explicitly with 400 unsupported_failure_type", async () => {
      const res1 = await request(server, {
        method: "POST",
        path: "/scenarios",
        headers: { Authorization: "Bearer token-org-a" },
        body: {
          name: "Capacity Test",
          target_node_id: NODE_A1,
          failure_type: "capacity",
          repository_id: REPO_A,
        },
      });

      assert.equal(res1.statusCode, 400);
      const err1 = expectError(res1.body);
      assert.equal(err1.error.code, "unsupported_failure_type");
      assert.ok(err1.error.message.includes("capacity"));

      const res2 = await request(server, {
        method: "POST",
        path: "/scenarios",
        headers: { Authorization: "Bearer token-org-a" },
        body: {
          name: "Removal Test",
          target_node_id: NODE_A1,
          failure_type: "removal",
          repository_id: REPO_A,
        },
      });

      assert.equal(res2.statusCode, 400);
      const err2 = expectError(res2.body);
      assert.equal(err2.error.code, "unsupported_failure_type");
      assert.ok(err2.error.message.includes("removal"));
    });

    it("5. Nonexistent target nodes are rejected with 400 invalid_request", async () => {
      const res = await request(server, {
        method: "POST",
        path: "/scenarios",
        headers: { Authorization: "Bearer token-org-a" },
        body: {
          name: "Nonexistent node test",
          target_node_id: "00000000-0000-4000-8000-000000000000",
          failure_type: "unavailable",
          repository_id: REPO_A,
        },
      });

      assert.equal(res.statusCode, 400);
      const err = expectError(res.body);
      assert.equal(err.error.code, "invalid_request");
      assert.ok(err.error.message.includes("Target node does not exist"));
    });

    it("6. Target nodes and analysis runs from incompatible runs are rejected", async () => {
      // NODE_A1 is in RUN_A1, not RUN_A2
      const res = await request(server, {
        method: "POST",
        path: "/scenarios",
        headers: { Authorization: "Bearer token-org-a" },
        body: {
          name: "Incompatible run test",
          target_node_id: NODE_A1,
          failure_type: "unavailable",
          analysis_run_id: RUN_A2,
        },
      });

      assert.equal(res.statusCode, 400);
      const err = expectError(res.body);
      assert.equal(err.error.code, "invalid_request");
      assert.ok(err.error.message.includes("does not belong to the specified analysis run"));
    });

    it("7. Caller cannot create a scenario in another tenant's scope", async () => {
      // Org A caller targeting Org B's repo/node
      const res = await request(server, {
        method: "POST",
        path: "/scenarios",
        headers: { Authorization: "Bearer token-org-a" },
        body: {
          name: "Cross tenant attempt",
          target_node_id: NODE_B,
          failure_type: "unavailable",
          analysis_run_id: RUN_B,
        },
      });

      assert.equal(res.statusCode, 404);
      const err = expectError(res.body);
      assert.equal(err.error.code, "analysis_snapshot_unavailable");
    });

    it("8. Valid optional fields and parameters are preserved according to schema", async () => {
      const res = await request(server, {
        method: "POST",
        path: "/scenarios",
        headers: { Authorization: "Bearer token-org-a" },
        body: {
          name: "Custom Parameters Scenario",
          target_node_id: NODE_A1,
          failure_type: "latency",
          analysis_run_id: RUN_A1,
          parameters: {
            injected_latency_ms: 1200,
            chaos_ratio: 0.5,
          },
        },
      });

      assert.equal(res.statusCode, 201);
      const data = res.body as ScenarioResponse;
      assert.equal(data.parameters.injected_latency_ms, 1200);
      assert.equal(data.parameters.chaos_ratio, 0.5);
      assert.equal(data.parameters.analysis_run_id, RUN_A1);
    });
  });

  // =========================================================================
  // Endpoint B — POST /scenarios/:id/run
  // =========================================================================

  describe("Endpoint B — Run a Scenario (POST /scenarios/:id/run)", () => {
    it("9. Authorized scenario execution invokes executeSimulation", async () => {
      const initialCount = testEnv.getExecuteCount();

      const res = await request(server, {
        method: "POST",
        path: `/scenarios/${SCENARIO_A}/run`,
        headers: { Authorization: "Bearer token-org-a" },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(testEnv.getExecuteCount(), initialCount + 1);
    });

    it("10. Successful execution returns actual persisted outcome (200 OK)", async () => {
      const res = await request(server, {
        method: "POST",
        path: `/api/v1/scenarios/${SCENARIO_A}/run`,
        headers: { Authorization: "Bearer token-org-a" },
      });

      assert.equal(res.statusCode, 200);
      const data = res.body as SimulationResponse;
      assert.ok(data.id);
      assert.equal(data.scenario_id, SCENARIO_A);
      assert.equal(data.status, "completed");
      assert.ok(Array.isArray(data.results));
      assert.equal(data.results.length, 1);
      assert.equal(data.results[0]?.node_id, NODE_A1);
      assert.equal(data.results[0]?.resulting_state, "failed");
      assert.equal(data.results[0]?.rule_applied, "target_failure");
      assert.equal(data.converged, true);
    });

    it("11. Unsupported failure type validation rejects unsupported scenarios before execution (400 unsupported_failure_type)", async () => {
      const res = await request(server, {
        method: "POST",
        path: `/scenarios/${SCENARIO_UNSUPPORTED}/run`,
        headers: { Authorization: "Bearer token-org-a" },
      });

      assert.equal(res.statusCode, 400);
      const err = expectError(res.body);
      assert.equal(err.error.code, "unsupported_failure_type");
      assert.ok(err.error.message.includes("capacity"));
    });

    it("12. Missing or inaccessible scenarios return 404 not_found and do not execute", async () => {
      const initialCount = testEnv.getExecuteCount();

      // Nonexistent scenario
      const res1 = await request(server, {
        method: "POST",
        path: `/scenarios/00000000-0000-4000-8000-000000000000/run`,
        headers: { Authorization: "Bearer token-org-a" },
      });
      assert.equal(res1.statusCode, 404);

      // Org B scenario accessed by Org A
      const res2 = await request(server, {
        method: "POST",
        path: `/scenarios/${SCENARIO_B}/run`,
        headers: { Authorization: "Bearer token-org-a" },
      });
      assert.equal(res2.statusCode, 404);
      assert.equal(testEnv.getExecuteCount(), initialCount);
    });

    it("13. Repeated run requests create distinct simulation records with scoped results", async () => {
      const res1 = await request(server, {
        method: "POST",
        path: `/scenarios/${SCENARIO_A}/run`,
        headers: { Authorization: "Bearer token-org-a" },
      });
      assert.equal(res1.statusCode, 200);
      const data1 = res1.body as SimulationResponse;

      const res2 = await request(server, {
        method: "POST",
        path: `/scenarios/${SCENARIO_A}/run`,
        headers: { Authorization: "Bearer token-org-a" },
      });
      assert.equal(res2.statusCode, 200);
      const data2 = res2.body as SimulationResponse;

      // Two accepted run requests create distinct simulation IDs (request-level behavior)
      assert.ok(data1.id);
      assert.ok(data2.id);
      assert.notEqual(data1.id, data2.id);

      // Results returned for each run belong strictly to that simulation
      assert.equal(data1.results?.length, 1);
      assert.equal(data1.results?.[0]?.simulation_id, data1.id);
      assert.equal(data2.results?.length, 1);
      assert.equal(data2.results?.[0]?.simulation_id, data2.id);
    });

    it("14. Simulation execution failure produces documented error response and marks simulation failed", async () => {
      // 14a. Convergence guard failure during execution -> 422 simulation_convergence_failure
      testEnv.setExecuteSimulationError(
        new SimulationConvergenceError("Simulation cycle limit reached in propagation graph."),
      );

      const resConv = await request(server, {
        method: "POST",
        path: `/scenarios/${SCENARIO_A}/run`,
        headers: { Authorization: "Bearer token-org-a" },
      });

      assert.equal(resConv.statusCode, 422);
      const errConv = expectError(resConv.body);
      assert.equal(errConv.error.code, "simulation_convergence_failure");
      assert.ok(errConv.error.message.includes("cycle limit"));

      const failedSimId1 = testEnv.getLastExecutedSimId();
      assert.ok(failedSimId1);
      const simRow1 = testEnv.simulationsStore.get(`${ORG_A}:${failedSimId1}`);
      assert.equal(simRow1?.status, "failed");

      // 14b. Unexpected engine/DB failure during execution -> 500 internal_error (redacting internal details)
      testEnv.setExecuteSimulationError(
        new Error("canceling statement due to statement timeout"),
      );

      const resFatal = await request(server, {
        method: "POST",
        path: `/scenarios/${SCENARIO_A}/run`,
        headers: { Authorization: "Bearer token-org-a" },
      });

      assert.equal(resFatal.statusCode, 500);
      const errFatal = expectError(resFatal.body);
      assert.equal(errFatal.error.code, "internal_error");
      assert.equal(errFatal.error.message, "Internal server error.");
      assert.equal((errFatal.error as Record<string, unknown>).details, undefined);
      assert.equal(JSON.stringify(resFatal.body).includes("statement timeout"), false);

      const failedSimId2 = testEnv.getLastExecutedSimId();
      assert.ok(failedSimId2);
      const simRow2 = testEnv.simulationsStore.get(`${ORG_A}:${failedSimId2}`);
      assert.equal(simRow2?.status, "failed");

      // Reset execution error
      testEnv.setExecuteSimulationError(null);
    });

    it("15. Simulation-result evidence remains governed by the Step 54 transactional invariant", async () => {
      const res = await request(server, {
        method: "POST",
        path: `/scenarios/${SCENARIO_A}/run`,
        headers: { Authorization: "Bearer token-org-a" },
      });

      assert.equal(res.statusCode, 200);
      const simId = testEnv.getLastExecutedSimId();
      assert.ok(simId);
      const results = testEnv.resultsStore.get(`${ORG_A}:${simId}`);
      assert.ok(results);
      assert.equal(results.length, 1);
    });
  });

  // =========================================================================
  // Endpoint C — GET /simulations/:id
  // =========================================================================

  describe("Endpoint C — Retrieve a Simulation (GET /simulations/:id)", () => {
    it("16. A tenant can retrieve its own simulation with 200 OK", async () => {
      const res = await request(server, {
        method: "GET",
        path: `/simulations/${SIMULATION_A}`,
        headers: { Authorization: "Bearer token-org-a" },
      });

      assert.equal(res.statusCode, 200);
      const data = res.body as SimulationResponse;
      assert.equal(data.id, SIMULATION_A);
      assert.equal(data.scenario_id, SCENARIO_A);
      assert.equal(data.analysis_run_id, RUN_A1);
      assert.equal(data.status, "completed");
    });

    it("17. A nonexistent simulation returns standard 404 not_found", async () => {
      const res = await request(server, {
        method: "GET",
        path: `/simulations/00000000-0000-4000-8000-000000000000`,
        headers: { Authorization: "Bearer token-org-a" },
      });

      assert.equal(res.statusCode, 404);
      const err = expectError(res.body);
      assert.equal(err.error.code, "not_found");
    });

    it("18. A tenant cannot retrieve another tenant's simulation (404 not_found)", async () => {
      const res = await request(server, {
        method: "GET",
        path: `/simulations/${SIMULATION_B}`,
        headers: { Authorization: "Bearer token-org-a" },
      });

      assert.equal(res.statusCode, 404);
      const err = expectError(res.body);
      assert.equal(err.error.code, "not_found");
    });

    it("19. Persisted status, timestamps, and metadata are returned accurately", async () => {
      const res = await request(server, {
        method: "GET",
        path: `/api/v1/simulations/${SIMULATION_A}`,
        headers: { Authorization: "Bearer token-org-a" },
      });

      assert.equal(res.statusCode, 200);
      const data = res.body as SimulationResponse;
      assert.equal(data.id, SIMULATION_A);
      assert.equal(data.status, "completed");
      assert.equal(data.created_at, "2026-02-01T12:00:00.000Z");
      assert.deepEqual(data.assumptions, ["No circuit breaker detected on call"]);
    });

    it("19b. Unexpected database failure when listing simulation results returns 500 internal_error without leaking details", async () => {
      testEnv.setListSimulationResultsError(
        new Error("canceling statement due to statement timeout"),
      );

      const res = await request(server, {
        method: "GET",
        path: `/simulations/${SIMULATION_A}`,
        headers: { Authorization: "Bearer token-org-a" },
      });

      assert.equal(res.statusCode, 500);
      const err = expectError(res.body);
      assert.equal(err.error.code, "internal_error");
      assert.equal(err.error.message, "Internal server error.");
      assert.equal((err.error as Record<string, unknown>).details, undefined);
      assert.equal(JSON.stringify(res.body).includes("statement timeout"), false);

      // Reset list error
      testEnv.setListSimulationResultsError(null);
    });

    it("19c. Simulation retrieval with zero results successfully returns 200 OK with empty results array", async () => {
      const res = await request(server, {
        method: "GET",
        path: `/simulations/${SIMULATION_EMPTY}`,
        headers: { Authorization: "Bearer token-org-a" },
      });

      assert.equal(res.statusCode, 200);
      const data = res.body as SimulationResponse;
      assert.equal(data.id, SIMULATION_EMPTY);
      assert.deepEqual(data.results, []);
      assert.equal(data.total_results, 0);
      assert.deepEqual(data.assumptions, []);
    });
  });

  // =========================================================================
  // Endpoint D — GET /simulations/:id/results
  // =========================================================================

  describe("Endpoint D — Retrieve Simulation Results (GET /simulations/:id/results)", () => {
    it("20. Results belong only to the requested simulation", async () => {
      const res = await request(server, {
        method: "GET",
        path: `/simulations/${SIMULATION_A}/results`,
        headers: { Authorization: "Bearer token-org-a" },
      });

      assert.equal(res.statusCode, 200);
      const data = res.body as SimulationResultsListResponse;
      assert.equal(data.simulation_id, SIMULATION_A);
      assert.equal(data.total, 2);
      assert.equal(data.results[0]?.node_id, NODE_A1);
      assert.equal(data.results[1]?.node_id, NODE_A2);
    });

    it("21. Results cannot be retrieved across tenant boundaries (404 not_found)", async () => {
      const res = await request(server, {
        method: "GET",
        path: `/simulations/${SIMULATION_B}/results`,
        headers: { Authorization: "Bearer token-org-a" },
      });

      assert.equal(res.statusCode, 404);
      const err = expectError(res.body);
      assert.equal(err.error.code, "not_found");
    });

    it("22. The response preserves causal paths, rule IDs, assumptions, and confidence", async () => {
      const res = await request(server, {
        method: "GET",
        path: `/api/v1/simulations/${SIMULATION_A}/results`,
        headers: { Authorization: "Bearer token-org-a" },
      });

      assert.equal(res.statusCode, 200);
      const data = res.body as SimulationResultsListResponse;
      const r2 = data.results[1]!;

      assert.equal(r2.node_id, NODE_A2);
      assert.equal(r2.resulting_state, "degraded");
      assert.equal(r2.rule_applied, "CALLS+sync+no_fallback");
      assert.equal(r2.confidence, 0.9);
      assert.deepEqual(r2.assumptions, ["No circuit breaker detected on call"]);

      // Causal path structure preserved without truncation
      assert.equal(r2.propagation_path.length, 2);
      const step1 = r2.propagation_path[0] as SimulationCausalStep;
      assert.equal(step1.nodeId, NODE_A1);
      assert.equal(step1.ruleId, "target_failure");

      const step2 = r2.propagation_path[1] as SimulationCausalStep;
      assert.equal(step2.nodeId, NODE_A2);
      assert.equal(step2.ruleId, "CALLS+sync+no_fallback");
      assert.equal(step2.edgeId, "edge-1234");
    });

    it("23. Results are returned in deterministic order", async () => {
      const res = await request(server, {
        method: "GET",
        path: `/simulations/${SIMULATION_A}/results`,
        headers: { Authorization: "Bearer token-org-a" },
      });

      assert.equal(res.statusCode, 200);
      const data = res.body as SimulationResultsListResponse;
      assert.equal(data.results[0]?.id, "result-1");
      assert.equal(data.results[1]?.id, "result-2");
    });

    it("24. An authorized simulation with no persisted results returns empty array with 200 OK", async () => {
      const res = await request(server, {
        method: "GET",
        path: `/simulations/${SIMULATION_EMPTY}/results`,
        headers: { Authorization: "Bearer token-org-a" },
      });

      assert.equal(res.statusCode, 200);
      const data = res.body as SimulationResultsListResponse;
      assert.equal(data.simulation_id, SIMULATION_EMPTY);
      assert.deepEqual(data.results, []);
      assert.equal(data.total, 0);
    });
  });

  // =========================================================================
  // Auth, Validation, CORS, and HTTP Methods
  // =========================================================================

  describe("Security, Validation & Cross-Cutting Behavior", () => {
    it("25. Missing authentication header returns 401 invalid_session", async () => {
      const res = await request(server, {
        method: "POST",
        path: "/scenarios",
        body: { name: "test" },
      });

      assert.equal(res.statusCode, 401);
      const err = expectError(res.body);
      assert.equal(err.error.code, "invalid_session");
      assert.equal(res.headers["www-authenticate"], "Bearer");
    });

    it("26. Requests missing connected GitHub account return 403 github_account_required", async () => {
      const res = await request(server, {
        method: "POST",
        path: "/scenarios",
        headers: { Authorization: "Bearer token-no-github" },
        body: { name: "test" },
      });

      assert.equal(res.statusCode, 403);
      const err = expectError(res.body);
      assert.equal(err.error.code, "github_account_required");
    });

    it("27. Method Not Allowed (405) on known simulation paths with unsupported methods", async () => {
      const res1 = await request(server, {
        method: "DELETE",
        path: "/scenarios",
      });
      assert.equal(res1.statusCode, 405);

      const res2 = await request(server, {
        method: "GET",
        path: `/scenarios/${SCENARIO_A}/run`,
      });
      assert.equal(res2.statusCode, 405);

      const res3 = await request(server, {
        method: "POST",
        path: `/simulations/${SIMULATION_A}`,
      });
      assert.equal(res3.statusCode, 405);

      const res4 = await request(server, {
        method: "POST",
        path: `/simulations/${SIMULATION_A}/results`,
      });
      assert.equal(res4.statusCode, 405);
    });

    it("28. Invalid Content-Type returns 415 unsupported_media_type", async () => {
      const res = await request(server, {
        method: "POST",
        path: "/scenarios",
        headers: {
          Authorization: "Bearer token-org-a",
          "content-type": "text/plain",
        },
        rawBody: "raw text",
      });

      assert.equal(res.statusCode, 415);
      const err = expectError(res.body);
      assert.equal(err.error.code, "unsupported_media_type");
    });

    it("29. Oversized request body returns 413 payload_too_large", async () => {
      const largePadding = "x".repeat(20000);
      const res = await request(server, {
        method: "POST",
        path: "/scenarios",
        headers: {
          Authorization: "Bearer token-org-a",
          "content-type": "application/json",
        },
        rawBody: JSON.stringify({ padding: largePadding }),
      });

      assert.equal(res.statusCode, 413);
      const err = expectError(res.body);
      assert.equal(err.error.code, "payload_too_large");
    });

    it("30. Explicit tenant specification in request body is rejected", async () => {
      const res = await request(server, {
        method: "POST",
        path: "/scenarios",
        headers: { Authorization: "Bearer token-org-a" },
        body: {
          organization_id: ORG_B,
          name: "Test",
          target_node_id: NODE_A1,
          failure_type: "unavailable",
          repository_id: REPO_A,
        },
      });

      assert.equal(res.statusCode, 400);
      const err = expectError(res.body);
      assert.equal(err.error.code, "invalid_request");
      assert.ok(err.error.message.includes("Tenant organization cannot be specified"));
    });

    it("31. CORS preflight OPTIONS returns 204", async () => {
      const res = await request(server, {
        method: "OPTIONS",
        path: "/scenarios",
        headers: { Origin: "http://localhost:3000" },
      });

      assert.equal(res.statusCode, 204);
      assert.ok(res.headers["access-control-allow-origin"]);
    });
  });

  // =========================================================================
  // Default Resource Resolvers with Tenant Context (Fix 1)
  // =========================================================================

  describe("Default Resource Resolvers with Tenant Context", () => {
    function createMockTenantPool(options?: {
      onQuery?: (query: string, params: unknown[]) => { rows: Record<string, unknown>[] };
    }) {
      const queryLog: { sql: string; params: unknown[] }[] = [];
      let clientReleased = false;

      const mockClient = {
        query: async (
          queryOrConfig: string | { text: string; values?: unknown[] },
          params?: unknown[],
        ) => {
          const sql =
            typeof queryOrConfig === "string" ? queryOrConfig : queryOrConfig.text;
          const values =
            typeof queryOrConfig === "string"
              ? (params ?? [])
              : (queryOrConfig.values ?? []);
          queryLog.push({ sql, params: values });

          if (options?.onQuery) {
            return options.onQuery(sql, values);
          }
          return { rows: [] };
        },
        release: () => {
          clientReleased = true;
        },
      };

      const mockPool = {
        connect: async () => mockClient,
      } as unknown as import("pg").Pool;

      return {
        mockPool,
        queryLog,
        isReleased: () => clientReleased,
      };
    }

    it("defaultResolveAnalysisRunAndRepo runs within withTenant context and returns repositoryId", async () => {
      const { mockPool, queryLog, isReleased } = createMockTenantPool({
        onQuery: (sql) => {
          if (sql.includes("FROM analysis_runs ar")) {
            return { rows: [{ repository_id: REPO_A }] };
          }
          return { rows: [] };
        },
      });

      const result = await defaultResolveAnalysisRunAndRepo(
        mockPool,
        ORG_A,
        RUN_A1,
      );
      assert.deepEqual(result, { repositoryId: REPO_A });

      // Verifies tenant context was established via set_config
      const tenantQuery = queryLog.find((q) => q.sql.includes("set_config"));
      assert.ok(tenantQuery, "set_config must be called by withTenant");
      assert.equal(tenantQuery.params[1], ORG_A);

      // Verifies the query ran on the client with both analysisRunId and organizationId
      const resolveQuery = queryLog.find((q) =>
        q.sql.includes("FROM analysis_runs ar"),
      );
      assert.ok(resolveQuery, "analysis_runs query must be executed on transaction client");
      assert.deepEqual(resolveQuery.params, [RUN_A1, ORG_A]);

      // Verifies transaction lifecycle and client release
      assert.ok(queryLog.some((q) => q.sql === "BEGIN"));
      assert.ok(queryLog.some((q) => q.sql === "COMMIT"));
      assert.equal(isReleased(), true);
    });

    it("defaultResolveAnalysisRunAndRepo returns null when resource not found or belongs to another tenant", async () => {
      const { mockPool, isReleased } = createMockTenantPool({
        onQuery: () => ({ rows: [] }),
      });

      const result = await defaultResolveAnalysisRunAndRepo(
        mockPool,
        ORG_A,
        RUN_B,
      );
      assert.equal(result, null);
      assert.equal(isReleased(), true);
    });

    it("defaultVerifyTargetNodeInAnalysisRun runs within withTenant and verifies target node membership", async () => {
      const { mockPool, queryLog, isReleased } = createMockTenantPool({
        onQuery: (sql) => {
          if (sql.includes("FROM graph_nodes gn")) {
            return { rows: [{ id: NODE_A1 }] };
          }
          return { rows: [] };
        },
      });

      const matched = await defaultVerifyTargetNodeInAnalysisRun(
        mockPool,
        ORG_A,
        RUN_A1,
        NODE_A1,
      );
      assert.equal(matched, true);

      // Verifies tenant context was established
      const tenantQuery = queryLog.find((q) => q.sql.includes("set_config"));
      assert.ok(tenantQuery);
      assert.equal(tenantQuery.params[1], ORG_A);

      const verifyQuery = queryLog.find((q) =>
        q.sql.includes("FROM graph_nodes gn"),
      );
      assert.ok(verifyQuery);
      assert.deepEqual(verifyQuery.params, [NODE_A1, RUN_A1, ORG_A]);
      assert.equal(isReleased(), true);
    });

    it("defaultVerifyTargetNodeInAnalysisRun returns false when node does not belong to analysis run or tenant", async () => {
      const { mockPool, isReleased } = createMockTenantPool({
        onQuery: () => ({ rows: [] }),
      });

      const mismatched = await defaultVerifyTargetNodeInAnalysisRun(
        mockPool,
        ORG_A,
        RUN_A2,
        NODE_A1,
      );
      assert.equal(mismatched, false);
      assert.equal(isReleased(), true);
    });

    it("defaultResolveTargetNodeAnalysisRun runs within withTenant and resolves latest analysis run", async () => {
      const { mockPool, queryLog, isReleased } = createMockTenantPool({
        onQuery: (sql) => {
          if (sql.includes("FROM graph_nodes gn")) {
            return { rows: [{ analysis_run_id: RUN_A1 }] };
          }
          return { rows: [] };
        },
      });

      const resolved = await defaultResolveTargetNodeAnalysisRun(
        mockPool,
        ORG_A,
        REPO_A,
        NODE_A1,
      );
      assert.deepEqual(resolved, { analysisRunId: RUN_A1 });

      const targetQuery = queryLog.find((q) =>
        q.sql.includes("FROM graph_nodes gn"),
      );
      assert.ok(targetQuery);
      assert.deepEqual(targetQuery.params, [NODE_A1, REPO_A, ORG_A]);
      assert.equal(isReleased(), true);
    });

    it("defaultResolveTargetNodeAnalysisRun returns null when target node not in repository", async () => {
      const { mockPool, isReleased } = createMockTenantPool({
        onQuery: () => ({ rows: [] }),
      });

      const resolved = await defaultResolveTargetNodeAnalysisRun(
        mockPool,
        ORG_A,
        REPO_B,
        NODE_A1,
      );
      assert.equal(resolved, null);
      assert.equal(isReleased(), true);
    });
  });
});
