import assert from "node:assert/strict";
import test from "node:test";

import { loadRootEnvFile } from "../cli/env.ts";
import { closePool, getPool } from "../pool.ts";
import { runMigrations } from "../migrate/runner.ts";
import { createOrganization } from "./organization.ts";
import { createRepository } from "./repository.ts";
import { createRepositorySnapshot } from "./repository-snapshot.ts";
import {
  EvidenceValidationError,
  GraphEdgeValidationError,
  GraphNodeValidationError,
  GraphStorageConflictError,
  batchCreateEvidence,
  batchCreateGraphEdges,
  batchCreateGraphNodes,
  createAnalysisRun,
  createEvidence,
  createGraphEdge,
  createGraphNode,
  getAnalysisRunById,
  getEvidenceById,
  getGraphEdgeById,
  getGraphNodeByCanonicalId,
  getGraphNodeById,
  listAnalysisRuns,
  listEvidenceForAnalysisRun,
  listEvidenceForSubject,
  listGraphEdges,
  listGraphNodes,
} from "./graph.ts";

loadRootEnvFile();

const RLS_TEST_ROLE = "fluxora_rls_test";

const hasDatabase =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;

async function ensureRlsTestRole(pool: ReturnType<typeof getPool>): Promise<void> {
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

  await pool.query(`
    CREATE OR REPLACE FUNCTION fluxora_snapshot_in_current_tenant(p_snapshot_id uuid)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
      SELECT EXISTS (
        SELECT 1
        FROM repository_snapshots AS rs
        JOIN repositories AS r ON r.id = rs.repository_id
        WHERE rs.id = p_snapshot_id
          AND r.organization_id = fluxora_current_org_id()
      );
    $$;

    CREATE OR REPLACE FUNCTION fluxora_analysis_run_in_current_tenant(p_analysis_run_id uuid)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
      SELECT EXISTS (
        SELECT 1
        FROM analysis_runs AS ar
        JOIN repository_snapshots AS rs ON rs.id = ar.snapshot_id
        JOIN repositories AS r ON r.id = rs.repository_id
        WHERE ar.id = p_analysis_run_id
          AND r.organization_id = fluxora_current_org_id()
      );
    $$;

    DROP POLICY IF EXISTS analysis_runs_tenant_select ON analysis_runs;
    CREATE POLICY analysis_runs_tenant_select ON analysis_runs
      FOR SELECT
      USING (fluxora_snapshot_in_current_tenant(snapshot_id));

    DROP POLICY IF EXISTS analysis_runs_tenant_update ON analysis_runs;
    CREATE POLICY analysis_runs_tenant_update ON analysis_runs
      FOR UPDATE
      USING (fluxora_snapshot_in_current_tenant(snapshot_id))
      WITH CHECK (fluxora_snapshot_in_current_tenant(snapshot_id));

    DROP POLICY IF EXISTS analysis_runs_tenant_delete ON analysis_runs;
    CREATE POLICY analysis_runs_tenant_delete ON analysis_runs
      FOR DELETE
      USING (fluxora_snapshot_in_current_tenant(snapshot_id));
  `);

  await pool.query(`GRANT fluxora_rls_test TO CURRENT_USER`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO fluxora_rls_test`);
  await pool.query(`GRANT EXECUTE ON FUNCTION fluxora_current_org_id() TO fluxora_rls_test`);
  await pool.query(`GRANT EXECUTE ON FUNCTION fluxora_repository_in_current_tenant(uuid) TO fluxora_rls_test`);
  await pool.query(`GRANT EXECUTE ON FUNCTION fluxora_snapshot_in_current_tenant(uuid) TO fluxora_rls_test`);
  await pool.query(`GRANT EXECUTE ON FUNCTION fluxora_analysis_run_in_current_tenant(uuid) TO fluxora_rls_test`);
  await pool.query(`GRANT SELECT ON TABLE organizations TO fluxora_rls_test`);
  await pool.query(`
    GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE repositories, repository_snapshots, commits, analysis_runs, graph_nodes, graph_edges, evidence
    TO fluxora_rls_test
  `);

  process.env.FLUXORA_DATABASE_ROLE = RLS_TEST_ROLE;
}

test("Step 27: Graph Storage — GraphNode, GraphEdge, Evidence persistence & RLS", { skip: !hasDatabase }, async (t) => {
  const pool = getPool();
  await runMigrations(pool);
  await ensureRlsTestRole(pool);

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

  const orgA = await createOrganization(pool, {
    name: `fluxora-step27-a-${suffix}`,
  });
  const orgB = await createOrganization(pool, {
    name: `fluxora-step27-b-${suffix}`,
  });

  const repoA = await createRepository(pool, {
    organizationId: orgA.id,
    githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 2000}`,
    name: "fluxora-app-a",
    defaultBranch: "main",
  });

  const snapshotA = await createRepositorySnapshot(pool, {
    organizationId: orgA.id,
    repositoryId: repoA.id,
    commitSha: "a".repeat(40),
    ref: "refs/heads/main",
    storageUri: "s3://snapshots/a",
    sha256: "a".repeat(64),
    fileCount: 10,
    sizeBytes: "1024",
  });

  const repoB = await createRepository(pool, {
    organizationId: orgB.id,
    githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 3000}`,
    name: "fluxora-app-b",
    defaultBranch: "main",
  });

  const snapshotB = await createRepositorySnapshot(pool, {
    organizationId: orgB.id,
    repositoryId: repoB.id,
    commitSha: "b".repeat(40),
    ref: "refs/heads/main",
    storageUri: "s3://snapshots/b",
    sha256: "b".repeat(64),
    fileCount: 15,
    sizeBytes: "2048",
  });

  t.after(async () => {
    delete process.env.FLUXORA_DATABASE_ROLE;
    await pool.query(`DELETE FROM organizations WHERE name LIKE $1`, [`fluxora-step27-%-${suffix}`]);
    await closePool();
  });

  await t.test("1. Tables and indexes exist in database schema metadata", async () => {
    const tablesRes = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const tableNames = new Set(tablesRes.rows.map((r) => r.table_name));

    assert.ok(tableNames.has("analysis_runs"));
    assert.ok(tableNames.has("graph_nodes"));
    assert.ok(tableNames.has("graph_edges"));
    assert.ok(tableNames.has("evidence"));

    const indexesRes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const indexNames = new Set(indexesRes.rows.map((r) => r.indexname));

    assert.ok(indexNames.has("graph_nodes_analysis_run_node_type_idx"));
    assert.ok(indexNames.has("graph_edges_source_edge_type_idx"));
    assert.ok(indexNames.has("graph_edges_target_edge_type_idx"));
    assert.ok(indexNames.has("evidence_subject_idx"));
  });

  await t.test("2. AnalysisRun can be created, updated, and listed within tenant scope", async () => {
    const run = await createAnalysisRun(pool, {
      organizationId: orgA.id,
      snapshotId: snapshotA.id,
      parserVersions: { typescript: "5.0.0" },
    });

    assert.equal(run.snapshotId, snapshotA.id);
    assert.equal(run.status, "pending");

    const read = await getAnalysisRunById(pool, orgA.id, run.id);
    assert.deepEqual(read, run);

    const listed = await listAnalysisRuns(pool, orgA.id, snapshotA.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, run.id);
  });

  await t.test("3. GraphNode can be inserted and read within correct tenant/scope", async () => {
    const [runA] = await listAnalysisRuns(pool, orgA.id, snapshotA.id);
    assert.ok(runA);

    const node1 = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA.id,
      canonicalId: "mod:src/index.ts",
      nodeType: "module",
      name: "src/index.ts",
      path: "src/index.ts",
      confidence: 1.0,
      metadata: { fileSize: 100 },
    });

    assert.equal(node1.canonicalId, "mod:src/index.ts");
    assert.equal(node1.nodeType, "module");
    assert.equal(node1.name, "src/index.ts");

    const readById = await getGraphNodeById(pool, orgA.id, node1.id);
    assert.deepEqual(readById, node1);

    const readByCanonical = await getGraphNodeByCanonicalId(
      pool,
      orgA.id,
      runA.id,
      "mod:src/index.ts",
    );
    assert.deepEqual(readByCanonical, node1);

    const allNodes = await listGraphNodes(pool, orgA.id, runA.id);
    assert.equal(allNodes.length, 1);
    assert.equal(allNodes[0]?.id, node1.id);
  });

  await t.test("4. GraphEdge can be inserted and read connecting nodes within analysis run", async () => {
    const [runA] = await listAnalysisRuns(pool, orgA.id, snapshotA.id);
    assert.ok(runA);

    const node2 = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA.id,
      canonicalId: "mod:src/utils.ts",
      nodeType: "module",
      name: "src/utils.ts",
      path: "src/utils.ts",
    });

    const [node1] = await listGraphNodes(pool, orgA.id, runA.id);
    assert.ok(node1);

    const edge = await createGraphEdge(pool, {
      organizationId: orgA.id,
      analysisRunId: runA.id,
      sourceNodeId: node1.id,
      targetNodeId: node2.id,
      edgeType: "IMPORTS",
      confidence: 0.95,
      provenance: "static-analysis",
    });

    assert.equal(edge.sourceNodeId, node1.id);
    assert.equal(edge.targetNodeId, node2.id);
    assert.equal(edge.edgeType, "IMPORTS");
    assert.equal(edge.confidence, 0.95);

    const readEdge = await getGraphEdgeById(pool, orgA.id, edge.id);
    assert.deepEqual(readEdge, edge);

    const allEdges = await listGraphEdges(pool, orgA.id, runA.id);
    assert.equal(allEdges.length, 1);
    assert.equal(allEdges[0]?.id, edge.id);
  });

  await t.test("5. Evidence can be inserted and read linked to node or edge subject", async () => {
    const [runA] = await listAnalysisRuns(pool, orgA.id, snapshotA.id);
    assert.ok(runA);
    const [edge] = await listGraphEdges(pool, orgA.id, runA.id);
    assert.ok(edge);

    const ev = await createEvidence(pool, {
      organizationId: orgA.id,
      analysisRunId: runA.id,
      subjectType: "graph_edge",
      subjectId: edge.id,
      filePath: "src/index.ts",
      symbolId: "sym:src/index.ts#import",
      lineStart: 10,
      lineEnd: 12,
      relationshipDescription: "src/index.ts imports src/utils.ts",
      confidence: 1.0,
    });

    assert.equal(ev.subjectType, "graph_edge");
    assert.equal(ev.subjectId, edge.id);
    assert.equal(ev.filePath, "src/index.ts");
    assert.equal(ev.lineStart, 10);
    assert.equal(ev.lineEnd, 12);

    const readEv = await getEvidenceById(pool, orgA.id, ev.id);
    assert.deepEqual(readEv, ev);

    const subjectEv = await listEvidenceForSubject(
      pool,
      orgA.id,
      runA.id,
      "graph_edge",
      edge.id,
    );
    assert.equal(subjectEv.length, 1);
    assert.equal(subjectEv[0]?.id, ev.id);

    const runEv = await listEvidenceForAnalysisRun(pool, orgA.id, runA.id);
    assert.equal(runEv.length, 1);
    assert.equal(runEv[0]?.id, ev.id);
  });

  await t.test("6. Uniqueness constraints behave deterministically", async () => {
    const [runA] = await listAnalysisRuns(pool, orgA.id, snapshotA.id);
    assert.ok(runA);

    await assert.rejects(
      () =>
        createGraphNode(pool, {
          organizationId: orgA.id,
          analysisRunId: runA.id,
          canonicalId: "mod:src/index.ts",
          nodeType: "module",
          name: "src/index.ts (duplicate)",
        }),
      GraphStorageConflictError,
    );

    const [node1, node2] = await listGraphNodes(pool, orgA.id, runA.id);
    assert.ok(node1);
    assert.ok(node2);

    await assert.rejects(
      () =>
        createGraphEdge(pool, {
          organizationId: orgA.id,
          analysisRunId: runA.id,
          sourceNodeId: node1.id,
          targetNodeId: node2.id,
          edgeType: "IMPORTS",
        }),
      GraphStorageConflictError,
    );
  });

  await t.test("7. Invalid inputs and references are rejected", async () => {
    const [runA] = await listAnalysisRuns(pool, orgA.id, snapshotA.id);
    assert.ok(runA);

    await assert.rejects(
      () =>
        createGraphNode(pool, {
          organizationId: orgA.id,
          analysisRunId: runA.id,
          canonicalId: "mod:invalid",
          nodeType: "module",
          name: "invalid",
          confidence: 1.5,
        }),
      GraphNodeValidationError,
    );

    await assert.rejects(
      () =>
        createGraphEdge(pool, {
          organizationId: orgA.id,
          analysisRunId: runA.id,
          sourceNodeId: "not-a-uuid",
          targetNodeId: runA.id,
          edgeType: "IMPORTS",
        }),
      GraphEdgeValidationError,
    );

    await assert.rejects(
      () =>
        createEvidence(pool, {
          organizationId: orgA.id,
          analysisRunId: runA.id,
          subjectType: "graph_edge",
          subjectId: runA.id,
          filePath: "src/index.ts",
          lineStart: 15,
          lineEnd: 5,
          relationshipDescription: "invalid line range",
        }),
      EvidenceValidationError,
    );
  });

  await t.test("8. Batch operations insert and update deterministically", async () => {
    const [runA] = await listAnalysisRuns(pool, orgA.id, snapshotA.id);
    assert.ok(runA);

    const batchNodes = await batchCreateGraphNodes(pool, orgA.id, [
      {
        organizationId: orgA.id,
        analysisRunId: runA.id,
        canonicalId: "sym:foo",
        nodeType: "symbol",
        name: "foo",
      },
      {
        organizationId: orgA.id,
        analysisRunId: runA.id,
        canonicalId: "sym:bar",
        nodeType: "symbol",
        name: "bar",
      },
    ]);
    assert.equal(batchNodes.length, 2);

    const [fooNode, barNode] = batchNodes;
    assert.ok(fooNode);
    assert.ok(barNode);

    const batchEdges = await batchCreateGraphEdges(pool, orgA.id, [
      {
        organizationId: orgA.id,
        analysisRunId: runA.id,
        sourceNodeId: fooNode.id,
        targetNodeId: barNode.id,
        edgeType: "CALLS",
      },
    ]);
    assert.equal(batchEdges.length, 1);

    const batchEv = await batchCreateEvidence(pool, orgA.id, [
      {
        organizationId: orgA.id,
        analysisRunId: runA.id,
        subjectType: "graph_edge",
        subjectId: batchEdges[0]!.id,
        filePath: "src/foo.ts",
        relationshipDescription: "foo calls bar",
      },
    ]);
    assert.equal(batchEv.length, 1);
  });

  await t.test("9. Cross-tenant access is rejected and child records cannot bypass parent tenant boundaries", async () => {
    const runB = await createAnalysisRun(pool, {
      organizationId: orgB.id,
      snapshotId: snapshotB.id,
    });

    const [runA] = await listAnalysisRuns(pool, orgA.id, snapshotA.id);
    assert.ok(runA);

    assert.equal(await getAnalysisRunById(pool, orgB.id, runA.id), null);
    assert.deepEqual(await listGraphNodes(pool, orgB.id, runA.id), []);
    assert.deepEqual(await listGraphEdges(pool, orgB.id, runA.id), []);
    assert.deepEqual(await listEvidenceForAnalysisRun(pool, orgB.id, runA.id), []);

    await assert.rejects(async () => {
      await createGraphNode(pool, {
        organizationId: orgB.id,
        analysisRunId: runA.id,
        canonicalId: "mod:unauthorized",
        nodeType: "module",
        name: "unauthorized",
      });
    });

    await assert.rejects(async () => {
      await createGraphNode(pool, {
        organizationId: orgA.id,
        analysisRunId: runB.id,
        canonicalId: "mod:unauthorized-b",
        nodeType: "module",
        name: "unauthorized-b",
      });
    });

    const nodeB1 = await createGraphNode(pool, {
      organizationId: orgB.id,
      analysisRunId: runB.id,
      canonicalId: "mod:b1",
      nodeType: "module",
      name: "b1",
    });

    const [nodeA1] = await listGraphNodes(pool, orgA.id, runA.id);
    assert.ok(nodeA1);

    await assert.rejects(async () => {
      await createGraphEdge(pool, {
        organizationId: orgA.id,
        analysisRunId: runA.id,
        sourceNodeId: nodeA1.id,
        targetNodeId: nodeB1.id,
        edgeType: "IMPORTS",
      });
    });

    await assert.rejects(async () => {
      await createEvidence(pool, {
        organizationId: orgB.id,
        analysisRunId: runA.id,
        subjectType: "graph_node",
        subjectId: nodeA1.id,
        filePath: "src/a.ts",
        relationshipDescription: "cross-tenant evidence injection",
      });
    });
  });
});
