import assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import type { GraphNode } from "@fluxora/shared-types";

import { loadRootEnvFile } from "../cli/env.ts";
import { closePool, getPool } from "../pool.ts";
import { runMigrations } from "../migrate/runner.ts";
import { createOrganization } from "./organization.ts";
import { createRepository } from "./repository.ts";
import { createRepositorySnapshot } from "./repository-snapshot.ts";
import { createAnalysisRun, createGraphNode } from "./graph.ts";
import {
  createScenario,
  getScenarioById,
  listScenarios,
  deleteScenario,
  createSimulation,
  getSimulationById,
  listSimulationsForScenario,
  updateSimulationStatus,
  createSimulationResult,
  saveSimulationResults,
  getSimulationResultById,
  listSimulationResults,
  SimulationPersistenceValidationError,
  ScenarioNotFoundError,
  SimulationNotFoundError,
} from "./simulation.ts";

loadRootEnvFile();

const RLS_TEST_ROLE = "fluxora_rls_test";

const hasDatabase =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;

async function ensureRlsTestRole(pool: ReturnType<typeof getPool>): Promise<void> {
  await runMigrations(pool);

  await pool.query(`
    DO $$
    BEGIN
      CREATE ROLE fluxora_rls_test
        NOSUPERUSER
        NOCREATEDB
        NOCREATEROLE
        NOINHERIT
        NOLOGIN
        NOBYPASSRLS;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END
    $$;
  `);

  await pool.query(`GRANT fluxora_rls_test TO CURRENT_USER`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO fluxora_rls_test`);
  await pool.query(`
    GRANT USAGE ON TYPE repository_connection_status TO fluxora_rls_test
  `);
  await pool.query(
    `GRANT EXECUTE ON FUNCTION fluxora_current_org_id() TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION fluxora_repository_in_current_tenant(uuid) TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION fluxora_snapshot_in_current_tenant(uuid) TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION fluxora_analysis_run_in_current_tenant(uuid) TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION fluxora_scenario_in_current_tenant(uuid) TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION fluxora_simulation_in_current_tenant(uuid) TO fluxora_rls_test`,
  );
  await pool.query(`GRANT SELECT ON TABLE organizations TO fluxora_rls_test`);
  await pool.query(`
    GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE repositories, repository_snapshots, commits, analysis_runs, graph_nodes, graph_edges, evidence, pull_requests, pull_request_files, impact_analyses, scenarios, simulations, simulation_results
    TO fluxora_rls_test
  `);

  process.env.FLUXORA_DATABASE_ROLE = RLS_TEST_ROLE;
}

// ===========================================================================
// Part 1: Unit & In-Memory Validation Tests (Step 52)
// ===========================================================================

describe("Step 52: Simulation Persistence - Unit & In-Memory Input Validation", () => {
  const dummyPool = {} as pg.Pool;
  const dummyOrgId = "00000000-0000-0000-0000-000000000001";
  const dummyRepoId = "00000000-0000-0000-0000-000000000002";
  const dummyNodeId = "00000000-0000-0000-0000-000000000003";

  it("1. createScenario rejects invalid organizationId", async () => {
    await assert.rejects(
      () =>
        createScenario(dummyPool, {
          organizationId: "not-a-uuid",
          repositoryId: dummyRepoId,
          name: "Test Scenario",
          targetNodeId: dummyNodeId,
          failureType: "unavailable",
        }),
      (err: Error) =>
        err instanceof SimulationPersistenceValidationError &&
        err.message.includes("organizationId must be a valid UUID"),
    );
  });

  it("2. createScenario rejects empty scenario name", async () => {
    await assert.rejects(
      () =>
        createScenario(dummyPool, {
          organizationId: dummyOrgId,
          repositoryId: dummyRepoId,
          name: "   ",
          targetNodeId: dummyNodeId,
          failureType: "unavailable",
        }),
      (err: Error) =>
        err instanceof SimulationPersistenceValidationError &&
        err.message.includes("name must be a non-empty string"),
    );
  });

  it("3. createScenario rejects unsupported failure_type", async () => {
    await assert.rejects(
      () =>
        createScenario(dummyPool, {
          organizationId: dummyOrgId,
          repositoryId: dummyRepoId,
          name: "Invalid failure type",
          targetNodeId: dummyNodeId,
          // @ts-expect-error Testing invalid failure type runtime rejection
          failureType: "exploded",
        }),
      (err: Error) =>
        err instanceof SimulationPersistenceValidationError &&
        err.message.includes("failureType must be one of"),
    );
  });

  it("4. createSimulation rejects invalid status", async () => {
    await assert.rejects(
      () =>
        createSimulation(dummyPool, dummyOrgId, {
          scenarioId: "00000000-0000-0000-0000-000000000010",
          analysisRunId: "00000000-0000-0000-0000-000000000020",
          // @ts-expect-error Testing invalid status runtime rejection
          status: "unknown_status",
        }),
      (err: Error) =>
        err instanceof SimulationPersistenceValidationError &&
        err.message.includes("status must be one of"),
    );
  });

  it("5. saveSimulationResults rejects invalid resultingState", async () => {
    await assert.rejects(
      () =>
        saveSimulationResults(dummyPool, dummyOrgId, "00000000-0000-0000-0000-000000000010", [
          {
            nodeId: dummyNodeId,
            // @ts-expect-error Testing invalid resulting state runtime rejection
            resultingState: "partially_dead",
            ruleApplied: "test-rule",
          },
        ]),
      (err: Error) =>
        err instanceof SimulationPersistenceValidationError &&
        err.message.includes("resultingState must be one of"),
    );
  });

  it("6. saveSimulationResults rejects out-of-range confidence (> 1.0 or < 0.0)", async () => {
    await assert.rejects(
      () =>
        saveSimulationResults(dummyPool, dummyOrgId, "00000000-0000-0000-0000-000000000010", [
          {
            nodeId: dummyNodeId,
            resultingState: "degraded",
            ruleApplied: "test-rule",
            confidence: 1.5,
          },
        ]),
      (err: Error) =>
        err instanceof SimulationPersistenceValidationError &&
        err.message.includes("confidence must be a number between 0.0 and 1.0"),
    );

    await assert.rejects(
      () =>
        saveSimulationResults(dummyPool, dummyOrgId, "00000000-0000-0000-0000-000000000010", [
          {
            nodeId: dummyNodeId,
            resultingState: "degraded",
            ruleApplied: "test-rule",
            confidence: -0.1,
          },
        ]),
      (err: Error) =>
        err instanceof SimulationPersistenceValidationError &&
        err.message.includes("confidence must be a number between 0.0 and 1.0"),
    );
  });

  it("7. getScenarioById and getSimulationById return null on invalid UUID inputs", async () => {
    const s = await getScenarioById(dummyPool, dummyOrgId, "not-a-uuid");
    assert.equal(s, null);

    const sim = await getSimulationById(dummyPool, dummyOrgId, "not-a-uuid");
    assert.equal(sim, null);

    const res = await getSimulationResultById(dummyPool, dummyOrgId, "not-a-uuid");
    assert.equal(res, null);

    const list1 = await listScenarios(dummyPool, dummyOrgId, { repositoryId: "bad-id" });
    assert.deepEqual(list1, []);

    const list2 = await listSimulationsForScenario(dummyPool, dummyOrgId, "bad-id");
    assert.deepEqual(list2, []);

    const list3 = await listSimulationResults(dummyPool, dummyOrgId, "bad-id");
    assert.deepEqual(list3, []);
  });
});

// ===========================================================================
// Part 2: Database Integration Tests (Step 52 PostgreSQL Integration)
// ===========================================================================

describe.skipIf(!hasDatabase)("Step 52: Simulation Persistence - PostgreSQL Integration", () => {
  let pool: pg.Pool;
  const suffix = Math.random().toString(36).substring(2, 8);

  let orgA: { id: string };
  let orgB: { id: string };
  let repoA: { id: string };
  let repoB: { id: string };
  let runA1: { id: string };
  let runA2: { id: string };

  let nodeA1: GraphNode;
  let nodeA2: GraphNode;
  let nodeA1_run2: GraphNode;

  beforeAll(async () => {
    pool = getPool();
    await ensureRlsTestRole(pool);

    // Setup Org A
    orgA = await createOrganization(pool, { name: `sim-persist-org-a-${suffix}` });
    repoA = await createRepository(pool, {
      organizationId: orgA.id,
      githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 3000}`,
      name: `sim-persist-repo-a-${suffix}`,
      defaultBranch: "main",
    });

    const snapshotA1 = await createRepositorySnapshot(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      commitSha: "a".repeat(40),
      ref: "refs/heads/main",
      storageUri: "s3://snapshots/sim-persist-a1",
      sha256: "a".repeat(64),
      fileCount: 5,
      sizeBytes: "2048",
    });

    runA1 = await createAnalysisRun(pool, {
      organizationId: orgA.id,
      snapshotId: snapshotA1.id,
      status: "completed",
    });

    const snapshotA2 = await createRepositorySnapshot(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      commitSha: "b".repeat(40),
      ref: "refs/heads/feature",
      storageUri: "s3://snapshots/sim-persist-a2",
      sha256: "b".repeat(64),
      fileCount: 5,
      sizeBytes: "2048",
    });

    runA2 = await createAnalysisRun(pool, {
      organizationId: orgA.id,
      snapshotId: snapshotA2.id,
      status: "completed",
    });

    // Setup Org B for tenant isolation testing
    orgB = await createOrganization(pool, { name: `sim-persist-org-b-${suffix}` });
    repoB = await createRepository(pool, {
      organizationId: orgB.id,
      githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 4000}`,
      name: `sim-persist-repo-b-${suffix}`,
      defaultBranch: "main",
    });

    // Seed Graph Nodes in Run A1
    nodeA1 = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA1.id,
      canonicalId: "service:payments",
      nodeType: "service",
      name: "PaymentService",
      path: "src/services/payment.ts",
    });

    nodeA2 = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA1.id,
      canonicalId: "service:orders",
      nodeType: "service",
      name: "OrderService",
      path: "src/services/order.ts",
    });

    // Seed Graph Node in Run A2
    nodeA1_run2 = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA2.id,
      canonicalId: "service:payments",
      nodeType: "service",
      name: "PaymentService",
      path: "src/services/payment.ts",
    });
  });

  afterAll(async () => {
    delete process.env.FLUXORA_DATABASE_ROLE;
    await closePool();
  });

  it("1. Scenario persistence: creates valid scenarios with all 4 domain failure types", async () => {
    const failureTypes = ["unavailable", "latency", "capacity", "removal"] as const;

    for (const fType of failureTypes) {
      const scenario = await createScenario(pool, {
        organizationId: orgA.id,
        repositoryId: repoA.id,
        name: `Scenario for ${fType}`,
        targetNodeId: nodeA1.id,
        failureType: fType,
        parameters: { testParam: 123, type: fType },
      });

      assert.ok(scenario.id, "Scenario should receive a UUID");
      assert.equal(scenario.organizationId, orgA.id);
      assert.equal(scenario.repositoryId, repoA.id);
      assert.equal(scenario.name, `Scenario for ${fType}`);
      assert.equal(scenario.targetNodeId, nodeA1.id);
      assert.equal(scenario.failureType, fType);
      assert.deepEqual(scenario.parameters, { testParam: 123, type: fType });
      assert.equal(scenario.createdBy, null);
      assert.ok(scenario.createdAt instanceof Date);

      const fetched = await getScenarioById(pool, orgA.id, scenario.id);
      assert.ok(fetched);
      assert.equal(fetched.id, scenario.id);
      assert.equal(fetched.failureType, fType);
    }
  });

  it("2. Scenario persistence: rejects target node belonging to another repository or non-existent", async () => {
    await assert.rejects(
      () =>
        createScenario(pool, {
          organizationId: orgA.id,
          repositoryId: repoA.id,
          name: "Invalid target node",
          targetNodeId: "00000000-0000-0000-0000-000000000999",
          failureType: "unavailable",
        }),
      (err: Error) =>
        err instanceof SimulationPersistenceValidationError &&
        err.message.includes("Target node does not exist in the specified repository"),
    );
  });

  it("3. Simulation persistence: creates simulation referencing scenario and analysis run", async () => {
    const scenario = await createScenario(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      name: "Payment Outage Simulation",
      targetNodeId: nodeA1.id,
      failureType: "unavailable",
    });

    const simulation = await createSimulation(pool, orgA.id, {
      scenarioId: scenario.id,
      analysisRunId: runA1.id,
      status: "pending",
    });

    assert.ok(simulation.id);
    assert.equal(simulation.scenarioId, scenario.id);
    assert.equal(simulation.analysisRunId, runA1.id);
    assert.equal(simulation.status, "pending");
    assert.ok(simulation.createdAt instanceof Date);

    const fetched = await getSimulationById(pool, orgA.id, simulation.id);
    assert.ok(fetched);
    assert.equal(fetched.id, simulation.id);
    assert.equal(fetched.status, "pending");
  });

  it("4. Snapshot boundary enforcement: rejects simulation when target node belongs to a different analysis run", async () => {
    // nodeA1 belongs to runA1. If we attempt to create a simulation pointing to runA2, it must fail.
    const scenarioInRun1 = await createScenario(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      name: "Run 1 scenario",
      targetNodeId: nodeA1.id,
      failureType: "latency",
    });

    await assert.rejects(
      () =>
        createSimulation(pool, orgA.id, {
          scenarioId: scenarioInRun1.id,
          analysisRunId: runA2.id, // Mismatched snapshot
        }),
      (err: Error) =>
        err instanceof SimulationPersistenceValidationError &&
        err.message.includes("Scenario target node does not belong to the specified analysis run"),
    );
  });

  it("5. Simulation status updates: transitions simulation lifecycle status cleanly", async () => {
    const scenario = await createScenario(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      name: "Lifecycle Test Scenario",
      targetNodeId: nodeA1.id,
      failureType: "unavailable",
    });

    const sim = await createSimulation(pool, orgA.id, {
      scenarioId: scenario.id,
      analysisRunId: runA1.id,
      status: "pending",
    });

    const running = await updateSimulationStatus(pool, orgA.id, sim.id, "running");
    assert.equal(running.status, "running");

    const completed = await updateSimulationStatus(pool, orgA.id, sim.id, "completed");
    assert.equal(completed.status, "completed");

    const fetched = await getSimulationById(pool, orgA.id, sim.id);
    assert.equal(fetched?.status, "completed");
  });

  it("6. SimulationResult persistence: saves and retrieves node results with states, path, assumptions, and confidence", async () => {
    const scenario = await createScenario(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      name: "Results Test Scenario",
      targetNodeId: nodeA1.id,
      failureType: "unavailable",
    });

    const sim = await createSimulation(pool, orgA.id, {
      scenarioId: scenario.id,
      analysisRunId: runA1.id,
      status: "running",
    });

    const results = await saveSimulationResults(pool, orgA.id, sim.id, [
      {
        nodeId: nodeA1.id,
        resultingState: "failed",
        propagationPath: [nodeA1.id],
        ruleApplied: "target_failure",
        assumptions: ["Initial injected failure"],
        confidence: 1.0,
      },
      {
        nodeId: nodeA2.id,
        resultingState: "degraded",
        propagationPath: [nodeA1.id, nodeA2.id],
        ruleApplied: "CALLS+sync+no_fallback",
        assumptions: ["No circuit breaker detected on OrderService->PaymentService call"],
        confidence: 0.9,
      },
    ]);

    assert.equal(results.length, 2);
    assert.equal(results[0]?.resultingState, "failed");
    assert.equal(results[0]?.ruleApplied, "target_failure");
    assert.deepEqual(results[0]?.propagationPath, [nodeA1.id]);
    assert.equal(results[1]?.resultingState, "degraded");
    assert.equal(results[1]?.confidence, 0.9);

    const list = await listSimulationResults(pool, orgA.id, sim.id);
    assert.equal(list.length, 2);

    const single = await getSimulationResultById(pool, orgA.id, results[0]!.id);
    assert.ok(single);
    assert.equal(single.id, results[0]!.id);
    assert.equal(single.resultingState, "failed");
  });

  it("7. SimulationResult idempotency: re-saving a result updates in place without duplicate rows", async () => {
    const scenario = await createScenario(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      name: "Idempotent Results Scenario",
      targetNodeId: nodeA1.id,
      failureType: "latency",
    });

    const sim = await createSimulation(pool, orgA.id, {
      scenarioId: scenario.id,
      analysisRunId: runA1.id,
    });

    await saveSimulationResults(pool, orgA.id, sim.id, [
      {
        nodeId: nodeA1.id,
        resultingState: "degraded",
        ruleApplied: "target_latency",
        confidence: 0.8,
      },
    ]);

    // Upsert with updated resulting state and confidence
    const updated = await saveSimulationResults(pool, orgA.id, sim.id, [
      {
        nodeId: nodeA1.id,
        resultingState: "failed",
        ruleApplied: "target_latency_timeout",
        confidence: 0.95,
      },
    ]);

    assert.equal(updated.length, 1);
    assert.equal(updated[0]?.resultingState, "failed");
    assert.equal(updated[0]?.confidence, 0.95);

    const all = await listSimulationResults(pool, orgA.id, sim.id);
    assert.equal(all.length, 1, "There should remain exactly 1 row for this node");
  });

  it("8. Result snapshot boundary: rejects result for node belonging to a different analysis run", async () => {
    const scenario = await createScenario(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      name: "Boundary Result Scenario",
      targetNodeId: nodeA1.id,
      failureType: "unavailable",
    });

    const sim = await createSimulation(pool, orgA.id, {
      scenarioId: scenario.id,
      analysisRunId: runA1.id,
    });

    // nodeA1_run2 is in runA2, not runA1!
    await assert.rejects(
      () =>
        saveSimulationResults(pool, orgA.id, sim.id, [
          {
            nodeId: nodeA1_run2.id,
            resultingState: "at_risk",
            ruleApplied: "cross_run_attempt",
          },
        ]),
      (err: Error) =>
        err instanceof SimulationPersistenceValidationError &&
        err.message.includes("does not belong to the simulation's analysis run"),
    );
  });

  it("9. Tenant Isolation: Org B cannot read Org A's scenarios, simulations, or results", async () => {
    const scenarioA = await createScenario(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      name: "Org A Confidential Scenario",
      targetNodeId: nodeA1.id,
      failureType: "unavailable",
    });

    const simA = await createSimulation(pool, orgA.id, {
      scenarioId: scenarioA.id,
      analysisRunId: runA1.id,
    });

    await saveSimulationResults(pool, orgA.id, simA.id, [
      {
        nodeId: nodeA1.id,
        resultingState: "failed",
        ruleApplied: "test",
      },
    ]);

    // Org B attempts to read scenarioA
    const readScenario = await getScenarioById(pool, orgB.id, scenarioA.id);
    assert.equal(readScenario, null, "Org B must not read Org A scenario");

    // Org B attempts to list scenarios
    const orgBScenarios = await listScenarios(pool, orgB.id);
    assert.ok(
      !orgBScenarios.some((s) => s.id === scenarioA.id),
      "Org A scenario must not appear in Org B list",
    );

    // Org B attempts to read simA
    const readSim = await getSimulationById(pool, orgB.id, simA.id);
    assert.equal(readSim, null, "Org B must not read Org A simulation");

    // Org B attempts to list simulations for scenarioA
    const simList = await listSimulationsForScenario(pool, orgB.id, scenarioA.id);
    assert.deepEqual(simList, [], "Org B must not list simulations for Org A scenario");

    // Org B attempts to list results for simA
    const results = await listSimulationResults(pool, orgB.id, simA.id);
    assert.deepEqual(results, [], "Org B must not list results for Org A simulation");
  });

  it("10. Tenant Isolation: Org B cannot insert simulations or results against Org A's records", async () => {
    // Org B attempts to create a scenario in repoB pointing to Org A's node
    await assert.rejects(
      () =>
        createScenario(pool, {
          organizationId: orgB.id,
          repositoryId: repoB.id,
          name: "Cross-repo node injection",
          targetNodeId: nodeA1.id,
          failureType: "unavailable",
        }),
      (err: Error) =>
        err instanceof SimulationPersistenceValidationError &&
        err.message.includes("Target node does not exist in the specified repository"),
    );

    const scenarioA = await createScenario(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      name: "Org A Target Scenario",
      targetNodeId: nodeA1.id,
      failureType: "unavailable",
    });

    // Org B attempts to create a simulation for Org A's scenario
    await assert.rejects(
      () =>
        createSimulation(pool, orgB.id, {
          scenarioId: scenarioA.id,
          analysisRunId: runA1.id,
        }),
      (err: Error) => err instanceof ScenarioNotFoundError,
    );

    const simA = await createSimulation(pool, orgA.id, {
      scenarioId: scenarioA.id,
      analysisRunId: runA1.id,
    });

    // Test createSimulationResult helper
    const singleResult = await createSimulationResult(pool, orgA.id, {
      simulationId: simA.id,
      nodeId: nodeA1.id,
      resultingState: "failed",
      ruleApplied: "single_node_failure",
      confidence: 1.0,
    });
    assert.equal(singleResult.resultingState, "failed");

    // Org B attempts to write results into Org A's simulation
    await assert.rejects(
      () =>
        saveSimulationResults(pool, orgB.id, simA.id, [
          {
            nodeId: nodeA1.id,
            resultingState: "failed",
            ruleApplied: "hack_attempt",
          },
        ]),
      (err: Error) => err instanceof SimulationNotFoundError,
    );
  });

  it("11. Deterministic ordering: listScenarios and listSimulationsForScenario sort by created_at DESC, id DESC", async () => {
    const s1 = await createScenario(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      name: "Order Test S1",
      targetNodeId: nodeA1.id,
      failureType: "unavailable",
    });
    const s2 = await createScenario(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      name: "Order Test S2",
      targetNodeId: nodeA1.id,
      failureType: "latency",
    });

    const scenarios = await listScenarios(pool, orgA.id, { repositoryId: repoA.id, limit: 10 });
    const idx1 = scenarios.findIndex((s) => s.id === s1.id);
    const idx2 = scenarios.findIndex((s) => s.id === s2.id);

    assert.ok(idx2 < idx1, "S2 was created later and should precede S1 in descending list");

    const sim1 = await createSimulation(pool, orgA.id, {
      scenarioId: s1.id,
      analysisRunId: runA1.id,
    });
    const sim2 = await createSimulation(pool, orgA.id, {
      scenarioId: s1.id,
      analysisRunId: runA1.id,
    });

    const sims = await listSimulationsForScenario(pool, orgA.id, s1.id);
    const simIdx1 = sims.findIndex((sim) => sim.id === sim1.id);
    const simIdx2 = sims.findIndex((sim) => sim.id === sim2.id);

    assert.ok(simIdx2 < simIdx1, "Sim2 was created later and should precede Sim1 in descending list");
  });

  it("12. Deletion: deleteScenario deletes scenario and cascades cleanly", async () => {
    const scenario = await createScenario(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      name: "To be deleted",
      targetNodeId: nodeA1.id,
      failureType: "removal",
    });

    const sim = await createSimulation(pool, orgA.id, {
      scenarioId: scenario.id,
      analysisRunId: runA1.id,
    });

    await saveSimulationResults(pool, orgA.id, sim.id, [
      {
        nodeId: nodeA1.id,
        resultingState: "failed",
        ruleApplied: "node_removal",
      },
    ]);

    const deleted = await deleteScenario(pool, orgA.id, scenario.id);
    assert.equal(deleted, true);

    const fetchedScenario = await getScenarioById(pool, orgA.id, scenario.id);
    assert.equal(fetchedScenario, null);

    const fetchedSim = await getSimulationById(pool, orgA.id, sim.id);
    assert.equal(fetchedSim, null, "Simulation must cascade delete");

    const fetchedResults = await listSimulationResults(pool, orgA.id, sim.id);
    assert.deepEqual(fetchedResults, [], "Simulation results must cascade delete");
  });
});

