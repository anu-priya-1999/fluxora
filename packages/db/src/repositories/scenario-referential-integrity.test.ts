import assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import type { GraphNode } from "@fluxora/shared-types";

import { loadRootEnvFile } from "../cli/env.ts";
import { createOrganization } from "./organization.ts";
import { createRepository } from "./repository.ts";
import { createRepositorySnapshot } from "./repository-snapshot.ts";
import { createAnalysisRun, createGraphNode } from "./graph.ts";
import {
  createScenario,
  getScenarioById,
  listScenarios,
  deleteScenario,
  SimulationPersistenceValidationError,
} from "./simulation.ts";
import { withTenant } from "../tenant.ts";
import {
  setupIsolatedTestDatabase,
  waitForLockWait,
} from "../testing/test-database.ts";

loadRootEnvFile();

const hasDatabase =
  (typeof process.env.FLUXORA_SCENARIO_TEST_DATABASE_URL === "string" &&
    process.env.FLUXORA_SCENARIO_TEST_DATABASE_URL.length > 0) ||
  (typeof process.env.FLUXORA_CLUSTER_LOCK_DATABASE_URL === "string" &&
    process.env.FLUXORA_CLUSTER_LOCK_DATABASE_URL.length > 0) ||
  (typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0);

describe.skipIf(!hasDatabase)("Fix 4: Scenario and Repository Referential Integrity (Disposable DB)", () => {
  let pool: pg.Pool;
  let teardownDb: () => Promise<void>;
  const suffix = Math.random().toString(36).substring(2, 8);

  let orgA: { id: string };
  let orgB: { id: string };

  let repoA1: { id: string };
  let repoA2: { id: string };
  let repoB1: { id: string };

  let runA1: { id: string };
  let runA2: { id: string };
  let runB1: { id: string };

  let nodeA1: GraphNode;
  let nodeA2: GraphNode;
  let nodeB1: GraphNode;

  beforeAll(async () => {
    // 1. Setup isolated disposable test database (never touches fluxora_dev or production)
    const dbSetup = await setupIsolatedTestDatabase({ dbName: "fluxora_fix4_test" });
    pool = dbSetup.pool;
    teardownDb = dbSetup.teardown;

    // 2. Setup Tenant Org A with two distinct repositories
    orgA = await createOrganization(pool, { name: `fix4-org-a-${suffix}` });
    repoA1 = await createRepository(pool, {
      organizationId: orgA.id,
      githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 5000}`,
      name: `fix4-repo-a1-${suffix}`,
      defaultBranch: "main",
    });
    repoA2 = await createRepository(pool, {
      organizationId: orgA.id,
      githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 6000}`,
      name: `fix4-repo-a2-${suffix}`,
      defaultBranch: "main",
    });

    const snapshotA1 = await createRepositorySnapshot(pool, {
      organizationId: orgA.id,
      repositoryId: repoA1.id,
      commitSha: "1".repeat(40),
      ref: "refs/heads/main",
      storageUri: "s3://snapshots/fix4-a1",
      sha256: "1".repeat(64),
      fileCount: 10,
      sizeBytes: "4096",
    });
    runA1 = await createAnalysisRun(pool, {
      organizationId: orgA.id,
      snapshotId: snapshotA1.id,
      status: "completed",
    });

    const snapshotA2 = await createRepositorySnapshot(pool, {
      organizationId: orgA.id,
      repositoryId: repoA2.id,
      commitSha: "2".repeat(40),
      ref: "refs/heads/main",
      storageUri: "s3://snapshots/fix4-a2",
      sha256: "2".repeat(64),
      fileCount: 8,
      sizeBytes: "3072",
    });
    runA2 = await createAnalysisRun(pool, {
      organizationId: orgA.id,
      snapshotId: snapshotA2.id,
      status: "completed",
    });

    // 3. Setup Tenant Org B with one repository
    orgB = await createOrganization(pool, { name: `fix4-org-b-${suffix}` });
    repoB1 = await createRepository(pool, {
      organizationId: orgB.id,
      githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 7000}`,
      name: `fix4-repo-b1-${suffix}`,
      defaultBranch: "main",
    });
    const snapshotB1 = await createRepositorySnapshot(pool, {
      organizationId: orgB.id,
      repositoryId: repoB1.id,
      commitSha: "3".repeat(40),
      ref: "refs/heads/main",
      storageUri: "s3://snapshots/fix4-b1",
      sha256: "3".repeat(64),
      fileCount: 6,
      sizeBytes: "2048",
    });
    runB1 = await createAnalysisRun(pool, {
      organizationId: orgB.id,
      snapshotId: snapshotB1.id,
      status: "completed",
    });

    // 4. Create Nodes via standard application insertion path
    nodeA1 = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA1.id,
      canonicalId: "service:auth",
      nodeType: "service",
      name: "AuthService",
      path: "src/services/auth.ts",
    });

    nodeA2 = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA2.id,
      canonicalId: "service:billing",
      nodeType: "service",
      name: "BillingService",
      path: "src/services/billing.ts",
    });

    nodeB1 = await createGraphNode(pool, {
      organizationId: orgB.id,
      analysisRunId: runB1.id,
      canonicalId: "service:search",
      nodeType: "service",
      name: "SearchService",
      path: "src/services/search.ts",
    });
  });

  afterAll(async () => {
    if (teardownDb) {
      await teardownDb();
    }
  });

  // ===========================================================================
  // 1. Valid Scenario Creation Tests (§9.1)
  // ===========================================================================
  describe("9.1 Valid Scenario Creation", () => {
    it("1. successfully creates scenario when target node belongs to specified repository", async () => {
      const scenario = await createScenario(pool, {
        organizationId: orgA.id,
        repositoryId: repoA1.id,
        name: "Auth outage scenario",
        targetNodeId: nodeA1.id,
        failureType: "unavailable",
        parameters: { durationMinutes: 15 },
      });

      assert.ok(scenario.id);
      assert.equal(scenario.organizationId, orgA.id);
      assert.equal(scenario.repositoryId, repoA1.id);
      assert.equal(scenario.targetNodeId, nodeA1.id);
      assert.equal(scenario.failureType, "unavailable");
      assert.deepEqual(scenario.parameters, { durationMinutes: 15 });

      const fetched = await getScenarioById(pool, orgA.id, scenario.id);
      assert.ok(fetched);
      assert.equal(fetched.id, scenario.id);
      assert.equal(fetched.repositoryId, repoA1.id);
      assert.equal(fetched.targetNodeId, nodeA1.id);
    });

    it("2. allows multiple scenarios in same repository targeting the same node", async () => {
      const s1 = await createScenario(pool, {
        organizationId: orgA.id,
        repositoryId: repoA1.id,
        name: "Auth latency test",
        targetNodeId: nodeA1.id,
        failureType: "latency",
        parameters: { latencyMs: 250 },
      });

      const s2 = await createScenario(pool, {
        organizationId: orgA.id,
        repositoryId: repoA1.id,
        name: "Auth capacity test",
        targetNodeId: nodeA1.id,
        failureType: "capacity",
        parameters: { maxConcurrentRequests: 10 },
      });

      assert.notEqual(s1.id, s2.id);
      assert.equal(s1.targetNodeId, nodeA1.id);
      assert.equal(s2.targetNodeId, nodeA1.id);
      assert.equal(s1.repositoryId, repoA1.id);
      assert.equal(s2.repositoryId, repoA1.id);
    });
  });

  // ===========================================================================
  // 2. Cross-Repository Scenario Rejection Tests (§9.2)
  // ===========================================================================
  describe("9.2 Cross-Repository Scenario Rejection", () => {
    it("1. application layer createScenario rejects mismatch with SimulationPersistenceValidationError", async () => {
      await assert.rejects(
        async () => {
          await createScenario(pool, {
            organizationId: orgA.id,
            repositoryId: repoA2.id,
            name: "Invalid cross-repo scenario (app check)",
            targetNodeId: nodeA1.id,
            failureType: "unavailable",
          });
        },
        (err: Error) => {
          assert.equal(err instanceof SimulationPersistenceValidationError, true);
          assert.match(
            err.message,
            /Target node does not exist in the specified repository/,
          );
          return true;
        },
      );
    });

    it("2. direct SQL INSERT bypassing application check is rejected by PostgreSQL composite FK (23503)", async () => {
      await withTenant(pool, orgA.id, async (client) => {
        await assert.rejects(
          async () => {
            await client.query(`
              INSERT INTO scenarios (organization_id, repository_id, name, target_node_id, failure_type)
              VALUES ($1::uuid, $2::uuid, 'Direct SQL bypass test', $3::uuid, 'unavailable')
            `, [orgA.id, repoA2.id, nodeA1.id]);
          },
          (err: Error & { code?: string; constraint?: string }) => {
            assert.equal(err.code, "23503", "PostgreSQL must reject mismatch with 23503");
            assert.equal(
              err.constraint,
              "scenarios_repository_target_node_fkey",
              "Constraint violation must be scenarios_repository_target_node_fkey",
            );
            return true;
          },
        );
      });
    });

    it("3. direct SQL INSERT with non-existent target_node_id fails with 23503", async () => {
      const nonExistentNodeId = "00000000-0000-0000-0000-000000000000";
      await withTenant(pool, orgA.id, async (client) => {
        await assert.rejects(
          async () => {
            await client.query(`
              INSERT INTO scenarios (organization_id, repository_id, name, target_node_id, failure_type)
              VALUES ($1::uuid, $2::uuid, 'Non-existent node test', $3::uuid, 'unavailable')
            `, [orgA.id, repoA1.id, nonExistentNodeId]);
          },
          (err: Error & { code?: string; constraint?: string }) => {
            assert.equal(err.code, "23503", "Must fail with foreign_key_violation (23503)");
            assert.equal(err.constraint, "scenarios_repository_target_node_fkey");
            return true;
          },
        );
      });
    });
  });

  // ===========================================================================
  // 3. Scenario UPDATE Behavior Tests (§9.3)
  // ===========================================================================
  describe("9.3 Scenario UPDATE behavior tests", () => {
    it("1. PostgreSQL rejects updating target_node_id to a node in another repository", async () => {
      const scenario = await createScenario(pool, {
        organizationId: orgA.id,
        repositoryId: repoA1.id,
        name: "Update target mismatch test",
        targetNodeId: nodeA1.id,
        failureType: "unavailable",
      });

      await withTenant(pool, orgA.id, async (client) => {
        await assert.rejects(
          async () => {
            await client.query(`
              UPDATE scenarios
              SET target_node_id = $1::uuid
              WHERE id = $2::uuid
            `, [nodeA2.id, scenario.id]);
          },
          (err: Error & { code?: string; constraint?: string }) => {
            assert.equal(err.code, "23503", "PostgreSQL must reject update with 23503");
            assert.equal(err.constraint, "scenarios_repository_target_node_fkey");
            return true;
          },
        );
      });
    });

    it("2. PostgreSQL rejects updating repository_id away from target node's repository", async () => {
      const scenario = await createScenario(pool, {
        organizationId: orgA.id,
        repositoryId: repoA1.id,
        name: "Update repo mismatch test",
        targetNodeId: nodeA1.id,
        failureType: "unavailable",
      });

      await withTenant(pool, orgA.id, async (client) => {
        await assert.rejects(
          async () => {
            await client.query(`
              UPDATE scenarios
              SET repository_id = $1::uuid
              WHERE id = $2::uuid
            `, [repoA2.id, scenario.id]);
          },
          (err: Error & { code?: string; constraint?: string }) => {
            assert.equal(err.code, "23503", "PostgreSQL must reject update with 23503");
            assert.equal(err.constraint, "scenarios_repository_target_node_fkey");
            return true;
          },
        );
      });
    });

    it("3. PostgreSQL rejects updating both columns to an invalid cross-repository pair", async () => {
      const scenario = await createScenario(pool, {
        organizationId: orgA.id,
        repositoryId: repoA1.id,
        name: "Update both mismatch test",
        targetNodeId: nodeA1.id,
        failureType: "unavailable",
      });

      await withTenant(pool, orgA.id, async (client) => {
        await assert.rejects(
          async () => {
            await client.query(`
              UPDATE scenarios
              SET repository_id = $1::uuid,
                  target_node_id = $2::uuid
              WHERE id = $3::uuid
            `, [repoA2.id, nodeA1.id, scenario.id]);
          },
          (err: Error & { code?: string; constraint?: string }) => {
            assert.equal(err.code, "23503", "PostgreSQL must reject update with 23503");
            assert.equal(err.constraint, "scenarios_repository_target_node_fkey");
            return true;
          },
        );
      });
    });

    it("4. PostgreSQL allows updating both repository_id and target_node_id atomically to a VALID matching pair", async () => {
      const scenario = await createScenario(pool, {
        organizationId: orgA.id,
        repositoryId: repoA1.id,
        name: "Atomic valid update test",
        targetNodeId: nodeA1.id,
        failureType: "unavailable",
      });

      await withTenant(pool, orgA.id, async (client) => {
        const updateRes = await client.query<{ repository_id: string; target_node_id: string }>(`
          UPDATE scenarios
          SET repository_id = $1::uuid,
              target_node_id = $2::uuid
          WHERE id = $3::uuid
          RETURNING repository_id, target_node_id
        `, [repoA2.id, nodeA2.id, scenario.id]);

        assert.equal(updateRes.rows[0]?.repository_id, repoA2.id);
        assert.equal(updateRes.rows[0]?.target_node_id, nodeA2.id);
      });
    });
  });

  // ===========================================================================
  // 4. Deletion Behavior Tests (§9.4)
  // ===========================================================================
  describe("9.4 Deletion behavior tests", () => {
    it("1. deleting a target node cascades and deletes referencing scenarios without affecting others", async () => {
      const disposableNode = await createGraphNode(pool, {
        organizationId: orgA.id,
        analysisRunId: runA1.id,
        canonicalId: "service:disposable-1",
        nodeType: "service",
        name: "DisposableService1",
        path: "src/services/disp1.ts",
      });

      const scenarioToCascade = await createScenario(pool, {
        organizationId: orgA.id,
        repositoryId: repoA1.id,
        name: "Scenario to cascade delete",
        targetNodeId: disposableNode.id,
        failureType: "unavailable",
      });

      const survivingScenario = await createScenario(pool, {
        organizationId: orgA.id,
        repositoryId: repoA1.id,
        name: "Scenario to survive",
        targetNodeId: nodeA1.id,
        failureType: "latency",
      });

      await withTenant(pool, orgA.id, async (client) => {
        await client.query(`DELETE FROM graph_nodes WHERE id = $1::uuid`, [disposableNode.id]);
      });

      const fetchedCascaded = await getScenarioById(pool, orgA.id, scenarioToCascade.id);
      assert.equal(fetchedCascaded, null, "Referencing scenario must be deleted via CASCADE");

      const fetchedSurviving = await getScenarioById(pool, orgA.id, survivingScenario.id);
      assert.ok(fetchedSurviving, "Surviving scenario referencing another node must remain");
      assert.equal(fetchedSurviving.repositoryId, repoA1.id);
    });

    it("2. deleting a scenario does NOT delete the referenced graph node or repository", async () => {
      const scenario = await createScenario(pool, {
        organizationId: orgA.id,
        repositoryId: repoA1.id,
        name: "Scenario to manually delete",
        targetNodeId: nodeA1.id,
        failureType: "unavailable",
      });

      const deleted = await deleteScenario(pool, orgA.id, scenario.id);
      assert.equal(deleted, true);

      await withTenant(pool, orgA.id, async (client) => {
        const nodeRes = await client.query<{ id: string }>(
          `SELECT id FROM graph_nodes WHERE id = $1::uuid`,
          [nodeA1.id],
        );
        assert.equal(nodeRes.rows.length, 1, "Graph node must not be deleted when scenario is deleted");
      });
    });

    it("3. deleting a repository cascades and cleans up all its graph nodes and scenarios", async () => {
      const disposableRepo = await createRepository(pool, {
        organizationId: orgA.id,
        githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 8000}`,
        name: `fix4-disposable-repo-${suffix}`,
        defaultBranch: "main",
      });

      const dispSnapshot = await createRepositorySnapshot(pool, {
        organizationId: orgA.id,
        repositoryId: disposableRepo.id,
        commitSha: "4".repeat(40),
        ref: "refs/heads/main",
        storageUri: "s3://snapshots/fix4-disp",
        sha256: "4".repeat(64),
        fileCount: 2,
        sizeBytes: "1024",
      });

      const dispRun = await createAnalysisRun(pool, {
        organizationId: orgA.id,
        snapshotId: dispSnapshot.id,
        status: "completed",
      });

      const dispNode = await createGraphNode(pool, {
        organizationId: orgA.id,
        analysisRunId: dispRun.id,
        canonicalId: "service:disposable-repo-service",
        nodeType: "service",
        name: "DisposableRepoService",
      });

      const dispScenario = await createScenario(pool, {
        organizationId: orgA.id,
        repositoryId: disposableRepo.id,
        name: "Disposable repo scenario",
        targetNodeId: dispNode.id,
        failureType: "unavailable",
      });

      await withTenant(pool, orgA.id, async (client) => {
        await client.query(`DELETE FROM repositories WHERE id = $1::uuid`, [disposableRepo.id]);
      });

      const fetched = await getScenarioById(pool, orgA.id, dispScenario.id);
      assert.equal(fetched, null, "Scenario must be deleted when its repository is deleted");

      await withTenant(pool, orgA.id, async (client) => {
        const nodeRes = await client.query<{ id: string }>(
          `SELECT id FROM graph_nodes WHERE id = $1::uuid`,
          [dispNode.id],
        );
        assert.equal(nodeRes.rows.length, 0, "Graph node must be deleted when repository is deleted");
      });
    });
  });

  // ===========================================================================
  // 5. Tenant Isolation Tests (§8)
  // ===========================================================================
  describe("8. Tenant Isolation", () => {
    it("1. rejects scenario referencing a target node belonging to another tenant (Org B node into Org A)", async () => {
      await withTenant(pool, orgA.id, async (client) => {
        await assert.rejects(
          async () => {
            await client.query(`
              INSERT INTO scenarios (organization_id, repository_id, name, target_node_id, failure_type)
              VALUES ($1::uuid, $2::uuid, 'Cross-tenant scenario', $3::uuid, 'unavailable')
            `, [orgA.id, repoA1.id, nodeB1.id]);
          },
          (err: Error & { code?: string; constraint?: string }) => {
            assert.equal(err.code, "23503", "Cross-tenant node reference rejected by foreign key");
            assert.equal(err.constraint, "scenarios_repository_target_node_fkey");
            return true;
          },
        );
      });
    });

    it("2. RLS prevents cross-tenant access to scenarios", async () => {
      const scenarioA = await createScenario(pool, {
        organizationId: orgA.id,
        repositoryId: repoA1.id,
        name: "Tenant A private scenario",
        targetNodeId: nodeA1.id,
        failureType: "unavailable",
      });

      const fetchFromB = await getScenarioById(pool, orgB.id, scenarioA.id);
      assert.equal(fetchFromB, null, "Tenant B must not see Tenant A scenarios");

      const listB = await listScenarios(pool, orgB.id);
      const bIds = listB.map((s) => s.id);
      assert.equal(bIds.includes(scenarioA.id), false);
    });
  });

  // ===========================================================================
  // 6. Concurrent Transaction Verification (§10) with Deterministic Lock Wait
  // ===========================================================================
  describe("10. Concurrent Operation Verification (Deterministic Lock Waits)", () => {
    it("1. Scenario INSERT (Tx 1) vs concurrent Node DELETE (Tx 2): serializes via row lock", async () => {
      const raceNode = await createGraphNode(pool, {
        organizationId: orgA.id,
        analysisRunId: runA1.id,
        canonicalId: `service:race-${Math.random()}`,
        nodeType: "service",
        name: "RaceService",
      });

      const client1 = await pool.connect();
      const client2 = await pool.connect();
      const observer = await pool.connect();

      try {
        await client1.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgA.id]);
        await client2.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgA.id]);

        // Get backend PID of client 2
        const pidRes2 = await client2.query<{ pid: number }>("SELECT pg_backend_pid() AS pid;");
        const client2Pid = pidRes2.rows[0]!.pid;

        // Tx 1: Begin transaction and insert scenario
        await client1.query("BEGIN");
        const insertRes = await client1.query<{ id: string }>(`
          INSERT INTO scenarios (organization_id, repository_id, name, target_node_id, failure_type)
          VALUES ($1::uuid, $2::uuid, 'Race scenario Tx1', $3::uuid, 'unavailable')
          RETURNING id
        `, [orgA.id, repoA1.id, raceNode.id]);
        const scenarioId = insertRes.rows[0]!.id;

        // Tx 2: Concurrently attempt to delete the referenced node.
        // In PostgreSQL, Tx 1 holds a FOR KEY SHARE lock on raceNode.
        // Tx 2's DELETE requires an exclusive row lock and will block until Tx 1 commits or aborts.
        let tx2Finished = false;
        let tx2Error: unknown = null;
        const tx2Promise = (async () => {
          try {
            await client2.query("BEGIN");
            await client2.query(`DELETE FROM graph_nodes WHERE id = $1::uuid`, [raceNode.id]);
            await client2.query("COMMIT");
            tx2Finished = true;
          } catch (e) {
            await client2.query("ROLLBACK").catch(() => {});
            tx2Error = e;
          }
        })();

        // Deterministically verify via pg_locks that client 2 is actively waiting on the lock
        const isWaiting = await waitForLockWait(observer, client2Pid, 5000);
        assert.equal(isWaiting, true, "Tx 2 backend PID must be observed actively waiting in pg_locks");
        assert.equal(tx2Finished, false, "Tx 2 must not have completed before Tx 1 commits");

        // Commit Tx 1
        await client1.query("COMMIT");

        // Wait for Tx 2 to complete
        await tx2Promise;
        assert.equal(tx2Finished, true, "Tx 2 must successfully complete once Tx 1 commits");
        assert.equal(tx2Error, null);

        // Verify that raceNode is deleted and CASCADE removed the scenario
        const verifyRes = await pool.query<{ count: string }>(`
          SELECT count(*) FROM scenarios WHERE id = $1::uuid
        `, [scenarioId]);
        assert.equal(verifyRes.rows[0]?.count, "0", "Scenario was cleanly cascaded by Tx 2");
      } finally {
        client1.release();
        client2.release();
        observer.release();
      }
    });

    it("2. Node DELETE (Tx 2 uncommitted) vs Scenario INSERT (Tx 1): rejects scenario insert with 23503", async () => {
      const raceNode2 = await createGraphNode(pool, {
        organizationId: orgA.id,
        analysisRunId: runA1.id,
        canonicalId: `service:race2-${Math.random()}`,
        nodeType: "service",
        name: "RaceService2",
      });

      const client1 = await pool.connect();
      const client2 = await pool.connect();
      const observer = await pool.connect();

      try {
        await client1.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgA.id]);
        await client2.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgA.id]);

        // Get backend PID of client 1
        const pidRes1 = await client1.query<{ pid: number }>("SELECT pg_backend_pid() AS pid;");
        const client1Pid = pidRes1.rows[0]!.pid;

        // Tx 2: Begin and delete the node (uncommitted)
        await client2.query("BEGIN");
        await client2.query(`DELETE FROM graph_nodes WHERE id = $1::uuid`, [raceNode2.id]);

        // Tx 1: Attempt to insert a scenario referencing raceNode2 concurrently
        // Tx 1 will block on Tx 2's exclusive row lock.
        let tx1Finished = false;
        let tx1Error: (Error & { code?: string }) | null = null;
        const tx1Promise = (async () => {
          try {
            await client1.query("BEGIN");
            await client1.query(`
              INSERT INTO scenarios (organization_id, repository_id, name, target_node_id, failure_type)
              VALUES ($1::uuid, $2::uuid, 'Race scenario Tx1', $3::uuid, 'unavailable')
            `, [orgA.id, repoA1.id, raceNode2.id]);
            await client1.query("COMMIT");
            tx1Finished = true;
          } catch (e) {
            await client1.query("ROLLBACK").catch(() => {});
            tx1Error = e as Error & { code?: string };
          }
        })();

        // Deterministically verify via pg_locks that client 1 is actively waiting on the lock
        const isWaiting = await waitForLockWait(observer, client1Pid, 5000);
        assert.equal(isWaiting, true, "Tx 1 backend PID must be observed actively waiting in pg_locks");
        assert.equal(tx1Finished, false, "Tx 1 must not have completed while Tx 2 holds exclusive lock");

        // Now commit Tx 2
        await client2.query("COMMIT");

        // Await Tx 1
        await tx1Promise;

        // Tx 1 must fail with 23503 (foreign_key_violation) because referenced row was deleted
        assert.ok(tx1Error !== null, "Tx 1 must fail after Tx 2 deletes the referenced node");
        const errWithCode = tx1Error as Error & { code?: string };
        assert.equal(errWithCode.code, "23503", "Expected foreign_key_violation (23503)");
      } finally {
        client1.release();
        client2.release();
        observer.release();
      }
    });

    it("3. Concurrent scenario inserts referencing the same valid node both succeed", async () => {
      const client1 = await pool.connect();
      const client2 = await pool.connect();

      try {
        await client1.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgA.id]);
        await client2.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgA.id]);

        await client1.query("BEGIN");
        await client2.query("BEGIN");

        const p1 = client1.query<{ id: string }>(`
          INSERT INTO scenarios (organization_id, repository_id, name, target_node_id, failure_type)
          VALUES ($1::uuid, $2::uuid, 'Concurrent A', $3::uuid, 'unavailable')
          RETURNING id
        `, [orgA.id, repoA1.id, nodeA1.id]);

        const p2 = client2.query<{ id: string }>(`
          INSERT INTO scenarios (organization_id, repository_id, name, target_node_id, failure_type)
          VALUES ($1::uuid, $2::uuid, 'Concurrent B', $3::uuid, 'latency')
          RETURNING id
        `, [orgA.id, repoA1.id, nodeA1.id]);

        const [res1, res2] = await Promise.all([p1, p2]);

        await client1.query("COMMIT");
        await client2.query("COMMIT");

        assert.ok(res1.rows[0]?.id);
        assert.ok(res2.rows[0]?.id);
        assert.notEqual(res1.rows[0]?.id, res2.rows[0]?.id);
      } finally {
        client1.release();
        client2.release();
      }
    });
  });

  // ===========================================================================
  // 7. Confirmed Defect 1 — Explicit Repository Identity Spoofing (§2)
  // ===========================================================================
  describe("Defect 1: Explicit Repository Identity Spoofing Protection", () => {
    it("1. rejects INSERT when caller explicitly supplies Repository B for an analysis run belonging to Repository A", async () => {
      await withTenant(pool, orgA.id, async (client) => {
        await assert.rejects(
          async () => {
            // runA1 belongs to repoA1; caller explicitly supplies repoA2
            await client.query(`
              INSERT INTO graph_nodes (analysis_run_id, repository_id, canonical_id, node_type, name)
              VALUES ($1::uuid, $2::uuid, 'service:spoofed-repo', 'service', 'SpoofedRepoService')
            `, [runA1.id, repoA2.id]);
          },
          (err: Error & { code?: string }) => {
            assert.equal(err.code, "23000", "Must fail with integrity_constraint_violation (23000)");
            assert.match(
              err.message,
              /Explicit repository_id .* does not match authoritative repository_id/,
            );
            return true;
          },
        );
      });
    });

    it("2. verifies no inconsistent graph node was committed after rejected spoofing attempt", async () => {
      await withTenant(pool, orgA.id, async (client) => {
        const check = await client.query<{ count: string }>(`
          SELECT count(*) AS count FROM graph_nodes WHERE canonical_id = 'service:spoofed-repo';
        `);
        assert.equal(check.rows[0]?.count, "0", "Spoofed node must not exist in table");
      });
    });

    it("3. omitted or null repository_id is still automatically derived from analysis run", async () => {
      await withTenant(pool, orgA.id, async (client) => {
        const res = await client.query<{ id: string; repository_id: string }>(`
          INSERT INTO graph_nodes (analysis_run_id, canonical_id, node_type, name)
          VALUES ($1::uuid, 'service:null-repo-test', 'service', 'NullRepoTest')
          RETURNING id, repository_id
        `, [runA1.id]);

        assert.ok(res.rows[0]?.id);
        assert.equal(res.rows[0]?.repository_id, repoA1.id, "Must derive repoA1 authoritative ID");
      });
    });

    it("4. explicitly supplied correct repository_id succeeds", async () => {
      await withTenant(pool, orgA.id, async (client) => {
        const res = await client.query<{ id: string; repository_id: string }>(`
          INSERT INTO graph_nodes (analysis_run_id, repository_id, canonical_id, node_type, name)
          VALUES ($1::uuid, $2::uuid, 'service:correct-explicit-repo', 'service', 'CorrectExplicitRepo')
          RETURNING id, repository_id
        `, [runA1.id, repoA1.id]);

        assert.ok(res.rows[0]?.id);
        assert.equal(res.rows[0]?.repository_id, repoA1.id);
      });
    });

    it("5. unresolved analysis run fails closed with 23503", async () => {
      const nonExistentRunId = "00000000-0000-0000-0000-000000000000";
      await withTenant(pool, orgA.id, async (client) => {
        await assert.rejects(
          async () => {
            await client.query(`
              INSERT INTO graph_nodes (analysis_run_id, canonical_id, node_type, name)
              VALUES ($1::uuid, 'service:ghost-run', 'service', 'GhostRun')
            `, [nonExistentRunId]);
          },
          (err: Error & { code?: string }) => {
            assert.equal(err.code, "23503", "Must fail with foreign_key_violation (23503)");
            assert.match(err.message, /Cannot resolve repository_id for graph_node with analysis_run_id/);
            return true;
          },
        );
      });
    });

    it("6. existing application insertion path createGraphNode continues to work seamlessly", async () => {
      const createdNode = await createGraphNode(pool, {
        organizationId: orgA.id,
        analysisRunId: runA1.id,
        canonicalId: "service:app-path-test",
        nodeType: "service",
        name: "AppPathTest",
        path: "src/services/app-path.ts",
      });

      assert.ok(createdNode.id);
      assert.equal(createdNode.analysisRunId, runA1.id);

      // Verify repository_id populated in DB
      await withTenant(pool, orgA.id, async (client) => {
        const nodeRes = await client.query<{ repository_id: string }>(`
          SELECT repository_id FROM graph_nodes WHERE id = $1::uuid
        `, [createdNode.id]);
        assert.equal(nodeRes.rows[0]?.repository_id, repoA1.id);
      });
    });
  });

  // ===========================================================================
  // 8. Confirmed Defect 2 — Analysis Run Mutation (§3)
  // ===========================================================================
  describe("Defect 2: Analysis Run & Repository Immutability on UPDATE", () => {
    let testNode: GraphNode;

    beforeAll(async () => {
      testNode = await createGraphNode(pool, {
        organizationId: orgA.id,
        analysisRunId: runA1.id,
        canonicalId: "service:immutability-test",
        nodeType: "service",
        name: "ImmutabilityTestService",
      });
    });

    it("1. rejects UPDATE to analysis_run_id pointing to another repository's analysis run (23000)", async () => {
      await withTenant(pool, orgA.id, async (client) => {
        await assert.rejects(
          async () => {
            await client.query(`
              UPDATE graph_nodes
              SET analysis_run_id = $1::uuid
              WHERE id = $2::uuid
            `, [runA2.id, testNode.id]);
          },
          (err: Error & { code?: string }) => {
            assert.equal(err.code, "23000", "Expected integrity_constraint_violation (23000)");
            assert.match(err.message, /graph_nodes\.analysis_run_id is immutable/);
            return true;
          },
        );
      });
    });

    it("2. rejects UPDATE to analysis_run_id pointing to another analysis run in the SAME repository (23000)", async () => {
      // Create a second analysis run in repoA1
      const snapshotA1b = await createRepositorySnapshot(pool, {
        organizationId: orgA.id,
        repositoryId: repoA1.id,
        commitSha: "7".repeat(40),
        ref: "refs/heads/feature",
        storageUri: "s3://snapshots/fix4-a1b",
        sha256: "7".repeat(64),
        fileCount: 10,
        sizeBytes: "4096",
      });
      const runA1b = await createAnalysisRun(pool, {
        organizationId: orgA.id,
        snapshotId: snapshotA1b.id,
        status: "completed",
      });

      await withTenant(pool, orgA.id, async (client) => {
        await assert.rejects(
          async () => {
            await client.query(`
              UPDATE graph_nodes
              SET analysis_run_id = $1::uuid
              WHERE id = $2::uuid
            `, [runA1b.id, testNode.id]);
          },
          (err: Error & { code?: string }) => {
            assert.equal(err.code, "23000", "Must fail with 23000 even within same repository");
            assert.match(err.message, /graph_nodes\.analysis_run_id is immutable/);
            return true;
          },
        );
      });
    });

    it("3. rejects direct mutation of repository_id (23000)", async () => {
      await withTenant(pool, orgA.id, async (client) => {
        await assert.rejects(
          async () => {
            await client.query(`
              UPDATE graph_nodes
              SET repository_id = $1::uuid
              WHERE id = $2::uuid
            `, [repoA2.id, testNode.id]);
          },
          (err: Error & { code?: string }) => {
            assert.equal(err.code, "23000", "Expected integrity_constraint_violation (23000)");
            assert.match(err.message, /graph_nodes\.repository_id is immutable/);
            return true;
          },
        );
      });
    });

    it("4. verifies original analysis_run_id and repository_id remain completely unchanged", async () => {
      await withTenant(pool, orgA.id, async (client) => {
        const res = await client.query<{ analysis_run_id: string; repository_id: string }>(`
          SELECT analysis_run_id, repository_id FROM graph_nodes WHERE id = $1::uuid
        `, [testNode.id]);

        assert.equal(res.rows[0]?.analysis_run_id, runA1.id);
        assert.equal(res.rows[0]?.repository_id, repoA1.id);
      });
    });

    it("5. updating unrelated permitted fields (name, path, metadata, confidence) succeeds", async () => {
      await withTenant(pool, orgA.id, async (client) => {
        const updateRes = await client.query<{
          name: string;
          path: string;
          metadata: Record<string, unknown>;
          confidence: number;
        }>(`
          UPDATE graph_nodes
          SET name = 'RenamedService',
              path = 'src/services/renamed.ts',
              metadata = '{"owner": "team-infra"}'::jsonb,
              confidence = 0.85
          WHERE id = $1::uuid
          RETURNING name, path, metadata, confidence
        `, [testNode.id]);

        assert.equal(updateRes.rows[0]?.name, "RenamedService");
        assert.equal(updateRes.rows[0]?.path, "src/services/renamed.ts");
        assert.deepEqual(updateRes.rows[0]?.metadata, { owner: "team-infra" });
        assert.equal(updateRes.rows[0]?.confidence, 0.85);
      });
    });
  });

  // ===========================================================================
  // 9. RLS & Tenant Context Verification for Trigger Lineage Lookup
  // ===========================================================================
  describe("Trigger Security & RLS Execution Verification", () => {
    it("1. non-superuser test role can perform lineage derivation in valid tenant context", async () => {
      const client = await pool.connect();
      try {
        await client.query(`
          DO $$
          BEGIN
            CREATE ROLE fluxora_rls_test NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN;
          EXCEPTION WHEN duplicate_object THEN NULL;
          END $$;
          GRANT fluxora_rls_test TO CURRENT_USER;
          GRANT USAGE ON SCHEMA public TO fluxora_rls_test;
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE repositories, repository_snapshots, commits, analysis_runs, graph_nodes, graph_edges, evidence, pull_requests, pull_request_files, impact_analyses, scenarios, simulations, simulation_results TO fluxora_rls_test;
          GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO fluxora_rls_test;
        `);

        await client.query("BEGIN;");
        await client.query("SET LOCAL ROLE fluxora_rls_test;");
        await client.query("SELECT set_config('app.current_org_id', $1, true);", [orgA.id]);

        const res = await client.query<{ id: string; repository_id: string }>(`
          INSERT INTO graph_nodes (analysis_run_id, canonical_id, node_type, name)
          VALUES ($1::uuid, 'service:rls-invoker-test', 'service', 'RlsInvokerTest')
          RETURNING id, repository_id
        `, [runA1.id]);

        assert.ok(res.rows[0]?.id);
        assert.equal(res.rows[0]?.repository_id, repoA1.id);
        await client.query("COMMIT;");
      } finally {
        client.release();
      }
    });

    it("2. non-superuser test role in Org B context attempting to reference Org A run fails closed without information disclosure", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN;");
        await client.query("SET LOCAL ROLE fluxora_rls_test;");
        await client.query("SELECT set_config('app.current_org_id', $1, true);", [orgB.id]);

        await assert.rejects(
          async () => {
            await client.query(`
              INSERT INTO graph_nodes (analysis_run_id, canonical_id, node_type, name)
              VALUES ($1::uuid, 'service:cross-tenant-rls', 'service', 'CrossTenantRls')
            `, [runA1.id]);
          },
          (err: Error & { code?: string }) => {
            // Under RLS, runA1 is invisible to Org B, so trigger cannot resolve repo_id -> fails closed with 23503
            assert.equal(err.code, "23503");
            assert.match(err.message, /Cannot resolve repository_id for graph_node with analysis_run_id/);
            // Verify no mention of Org A or repoA1 in the error message
            assert.equal(err.message.includes(orgA.id), false);
            assert.equal(err.message.includes(repoA1.id), false);
            return true;
          },
        );
        await client.query("ROLLBACK;");
      } finally {
        client.release();
      }
    });
  });
});
