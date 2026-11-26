import assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll } from "vitest";

import {
  closePool,
  createAnalysisRun,
  createGraphEdge,
  createGraphNode,
  createOrganization,
  createRepository,
  createRepositorySnapshot,
  createScenario,
  createSimulation,
  executeSimulation,
  getPool,
  EvidenceWriter,
} from "@fluxora/db";
import { loadRootEnv } from "../../env.ts";
import {
  loadSimulationNarrationContext,
  type SimulationNarrationRepository,
} from "./loader.ts";
import type { DatabasePool } from "../context/index.ts";
import { SimulationNarrationContextError } from "./types.ts";

loadRootEnv();
const hasDatabase =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const SIM_ID = "22222222-2222-4222-8222-222222222222";
const SCENARIO_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";

function createMockRepo(overrides: Partial<SimulationNarrationRepository> = {}): SimulationNarrationRepository {
  return {
    async getSimulationById() {
      return {
        id: SIM_ID,
        scenarioId: SCENARIO_ID,
        analysisRunId: RUN_ID,
        status: "completed",
        createdAt: new Date(),
      };
    },
    async getScenarioById() {
      return {
        id: SCENARIO_ID,
        organizationId: ORG_ID,
        repositoryId: "55555555-5555-4555-8555-555555555555",
        name: "Test Scenario",
        targetNodeId: "node_1",
        failureType: "unavailable",
        parameters: {},
        createdBy: "usr_1",
        createdAt: new Date(),
      };
    },
    async listSimulationResults() {
      return [
        {
          id: "sr_1",
          simulationId: SIM_ID,
          nodeId: "node_1",
          resultingState: "failed",
          propagationPath: [],
          ruleApplied: "target_failure",
          assumptions: [],
          confidence: 1.0,
          createdAt: new Date(),
        },
      ];
    },
    async listSimulationEvidence() {
      return [
        {
          id: "ev_1",
          analysisRunId: RUN_ID,
          subjectType: "simulation_state",
          subjectId: "sr_1",
          filePath: "src/node1.ts",
          symbolId: null,
          lineStart: 1,
          lineEnd: 10,
          columnStart: 1,
          columnEnd: 1,
          relationshipDescription: "Target failed",
          confidence: 1.0,
          metadata: { simulationId: SIM_ID, nodeId: "node_1" },
          createdAt: new Date(),
        },
      ];
    },
    ...overrides,
  };
}

describe("Simulation Narration Context Loader (Step 63)", () => {
  const dummyPool = {} as DatabasePool;

  it("1. Loads and assembles context when simulation is completed and accessible", async () => {
    const repo = createMockRepo();
    const ctx = await loadSimulationNarrationContext({
      pool: dummyPool,
      organizationId: ORG_ID,
      simulationId: SIM_ID,
      repository: repo,
    });

    assert.equal(ctx.simulationId, SIM_ID);
    assert.equal(ctx.status, "completed");
    assert.equal(ctx.results.length, 1);
    assert.deepEqual(Array.from(ctx.allowedEvidenceIds), ["ev_1"]);
  });

  it("2. Fails safely with not_found when simulation does not exist or belongs to another tenant", async () => {
    const repo = createMockRepo({
      async getSimulationById() {
        return null;
      },
    });

    await assert.rejects(
      loadSimulationNarrationContext({
        pool: dummyPool,
        organizationId: ORG_ID,
        simulationId: SIM_ID,
        repository: repo,
      }),
      (err) => err instanceof SimulationNarrationContextError && err.code === "not_found",
    );
  });

  it("3. Fails with not_completed when simulation is still pending or running", async () => {
    const repo = createMockRepo({
      async getSimulationById() {
        return {
          id: SIM_ID,
          scenarioId: SCENARIO_ID,
          analysisRunId: RUN_ID,
          status: "running",
          createdAt: new Date(),
        };
      },
    });

    await assert.rejects(
      loadSimulationNarrationContext({
        pool: dummyPool,
        organizationId: ORG_ID,
        simulationId: SIM_ID,
        repository: repo,
      }),
      (err) => err instanceof SimulationNarrationContextError && err.code === "not_completed",
    );
  });

  it("4. Fails with not_found when scenario is missing or inaccessible", async () => {
    const repo = createMockRepo({
      async getScenarioById() {
        return null;
      },
    });

    await assert.rejects(
      loadSimulationNarrationContext({
        pool: dummyPool,
        organizationId: ORG_ID,
        simulationId: SIM_ID,
        repository: repo,
      }),
      (err) => err instanceof SimulationNarrationContextError && err.code === "not_found",
    );
  });

  it("5. Validates UUID format for organizationId and simulationId", async () => {
    const repo = createMockRepo();

    await assert.rejects(
      loadSimulationNarrationContext({
        pool: dummyPool,
        organizationId: "not-a-uuid",
        simulationId: SIM_ID,
        repository: repo,
      }),
      (err) => err instanceof SimulationNarrationContextError && err.code === "invalid_input",
    );

    await assert.rejects(
      loadSimulationNarrationContext({
        pool: dummyPool,
        organizationId: ORG_ID,
        simulationId: "not-a-uuid",
        repository: repo,
      }),
      (err) => err instanceof SimulationNarrationContextError && err.code === "invalid_input",
    );
  });
});

describe("Simulation Evidence Provenance Integration (Step 63)", () => {
  let pool: ReturnType<typeof getPool>;

  beforeAll(async () => {
    if (hasDatabase) {
      pool = getPool();
    }
  });

  afterAll(async () => {
    if (hasDatabase) {
      await closePool();
    }
  });

  it("loads only evidence belonging to the target simulation, excluding cross-simulation and cross-tenant evidence", async () => {
    if (!hasDatabase) return;
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const orgA = await createOrganization(pool, { name: `org-a-sim-${suffix}` });
    const orgB = await createOrganization(pool, { name: `org-b-sim-${suffix}` });
    const repoA = await createRepository(pool, {
      organizationId: orgA.id,
      githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 3000}`,
      name: `repo-sim-${suffix}`,
      defaultBranch: "main",
    });
    const snapshotA = await createRepositorySnapshot(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      commitSha: "a".repeat(40),
      ref: "refs/heads/main",
      storageUri: `s3://snapshots/sim-loader-${suffix}`,
      sha256: "a".repeat(64),
      fileCount: 5,
      sizeBytes: "2048",
    });
    const runA = await createAnalysisRun(pool, {
      organizationId: orgA.id,
      snapshotId: snapshotA.id,
      status: "completed",
    });

    const nodeTarget = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA.id,
      nodeType: "service",
      name: "PaymentService",
      canonicalId: `node:payment-${suffix}`,
      path: "src/payment.ts",
    });

    const nodeClient = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA.id,
      nodeType: "service",
      name: "OrderService",
      canonicalId: `node:order-${suffix}`,
      path: "src/order.ts",
    });

    await createGraphEdge(pool, {
      organizationId: orgA.id,
      analysisRunId: runA.id,
      sourceNodeId: nodeClient.id,
      targetNodeId: nodeTarget.id,
      edgeType: "CALLS",
      canonicalId: `edge:order-payment-${suffix}`,
      metadata: { sync: true },
      confidence: 1.0,
      provenance: "static-analysis",
      evidence: EvidenceWriter.createEvidenceInput({
        organizationId: orgA.id,
        analysisRunId: runA.id,
        subjectType: "graph_edge",
        subjectId: EvidenceWriter.generateDeterministicUuid(`${runA.id}:edge:order-payment`),
        filePath: "src/order.ts",
        relationshipDescription: "OrderService calls PaymentService synchronously",
      }),
    });

    // Create two distinct scenarios in Org A
    const scenario1 = await createScenario(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      name: `Scenario 1 ${suffix}`,
      targetNodeId: nodeTarget.id,
      failureType: "unavailable",
    });

    const scenario2 = await createScenario(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      name: `Scenario 2 ${suffix}`,
      targetNodeId: nodeClient.id,
      failureType: "latency",
    });

    const sim1 = await createSimulation(pool, orgA.id, {
      scenarioId: scenario1.id,
      analysisRunId: runA.id,
    });

    const sim2 = await createSimulation(pool, orgA.id, {
      scenarioId: scenario2.id,
      analysisRunId: runA.id,
    });

    // Execute both simulations so that each writes its own simulation_state evidence via EvidenceWriter
    const exec1 = await executeSimulation(pool, orgA.id, sim1.id);
    const exec2 = await executeSimulation(pool, orgA.id, sim2.id);

    assert.equal(exec1.simulation.status, "completed");
    assert.equal(exec2.simulation.status, "completed");
    assert.ok(exec1.evidence.length > 0);
    assert.ok(exec2.evidence.length > 0);

    const sim1EvidenceIds = new Set(exec1.evidence.map((e) => e.id));
    const sim2EvidenceIds = new Set(exec2.evidence.map((e) => e.id));

    // Load context for Simulation 1
    const ctx1 = await loadSimulationNarrationContext({
      pool,
      organizationId: orgA.id,
      simulationId: sim1.id,
    });

    assert.equal(ctx1.simulationId, sim1.id);
    assert.equal(ctx1.status, "completed");
    assert.ok(ctx1.allowedEvidenceIds.length > 0);

    // PROVE: Evidence belongs strictly to Simulation 1
    for (const evId of ctx1.allowedEvidenceIds) {
      assert.ok(sim1EvidenceIds.has(evId), `Evidence ID ${evId} must belong to sim1`);
      assert.equal(sim2EvidenceIds.has(evId), false, `Evidence ID ${evId} from sim2 must NOT leak into sim1`);
    }

    // PROVE: Evidence manifest exactly matches retained evidenceRecords
    assert.deepEqual(
      Array.from(ctx1.allowedEvidenceIds),
      ctx1.evidenceRecords.map((e) => e.id).sort(),
    );

    // PROVE: Cross-tenant isolation - Org B cannot load Org A's simulation context
    await assert.rejects(
      loadSimulationNarrationContext({
        pool,
        organizationId: orgB.id,
        simulationId: sim1.id,
      }),
      (err) => err instanceof SimulationNarrationContextError && err.code === "not_found",
    );
  });
});
