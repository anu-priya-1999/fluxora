import assert from "node:assert/strict";
import test from "node:test";

import type { CreateEvidenceInput } from "@fluxora/shared-types";
import { loadRootEnvFile } from "../cli/env.ts";
import { runMigrations } from "../migrate/runner.ts";
import { closePool, getPool } from "../pool.ts";
import {
  EvidenceValidationError,
  EvidenceWriter,
  createAnalysisRun,
  createGraphEdge,
  createGraphNode,
  getEvidenceById,
  listEvidenceForAnalysisRun,
  persistGraphBuild,
} from "./graph.ts";
import { createOrganization } from "./organization.ts";
import { createRepository } from "./repository.ts";
import { createRepositorySnapshot } from "./repository-snapshot.ts";
import { inspectSourceContent, verifyGraphWritePaths } from "./evidence-lint.ts";

loadRootEnvFile();

const RLS_TEST_ROLE = "fluxora_rls_test";
const hasDatabase =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;

async function ensureRlsTestRole(pool: ReturnType<typeof getPool>): Promise<void> {
  await pool.query(`
    DO $$
    BEGIN
      CREATE ROLE fluxora_rls_test NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await pool.query(`GRANT fluxora_rls_test TO CURRENT_USER;`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO fluxora_rls_test;`);
  await pool.query(`GRANT EXECUTE ON FUNCTION fluxora_current_org_id() TO fluxora_rls_test;`);
  await pool.query(`GRANT EXECUTE ON FUNCTION fluxora_repository_in_current_tenant(uuid) TO fluxora_rls_test;`);
  await pool.query(`GRANT EXECUTE ON FUNCTION fluxora_snapshot_in_current_tenant(uuid) TO fluxora_rls_test;`);
  await pool.query(`GRANT EXECUTE ON FUNCTION fluxora_analysis_run_in_current_tenant(uuid) TO fluxora_rls_test;`);
  await pool.query(`GRANT SELECT ON TABLE organizations TO fluxora_rls_test;`);
  await pool.query(`
    GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE repositories, repository_snapshots, commits, analysis_runs, graph_nodes, graph_edges, evidence
    TO fluxora_rls_test;
  `);

  process.env.FLUXORA_DATABASE_ROLE = RLS_TEST_ROLE;
}

test("Global Step 29: Evidence Writer & CI Evidence Lint", async (t) => {
  const dummyOrgId = "11111111-1111-4111-8111-111111111111";
  const dummyRunId = "22222222-2222-4222-8222-222222222222";
  const dummyNodeId = "33333333-3333-4333-8333-333333333333";
  const dummyEdgeId = "44444444-4444-4444-8444-444444444444";

  await t.test("1. Evidence Writer creates valid evidence input", () => {
    const ev = EvidenceWriter.createEvidenceInput({
      organizationId: dummyOrgId,
      analysisRunId: dummyRunId,
      subjectType: "graph_node",
      subjectId: dummyNodeId,
      filePath: "src/auth.ts",
      relationshipDescription: "Declared function login",
      lineStart: 10,
      lineEnd: 25,
      columnStart: 1,
      columnEnd: 40,
    });

    assert.ok(ev.id);
    assert.equal(ev.organizationId, dummyOrgId);
    assert.equal(ev.analysisRunId, dummyRunId);
    assert.equal(ev.subjectType, "graph_node");
    assert.equal(ev.subjectId, dummyNodeId);
    assert.equal(ev.filePath, "src/auth.ts");
    assert.equal(ev.relationshipDescription, "Declared function login");
    assert.equal(ev.lineStart, 10);
    assert.equal(ev.lineEnd, 25);
  });

  await t.test("2. Evidence identity is deterministic across calls", () => {
    const id1 = EvidenceWriter.generateEvidenceId({
      analysisRunId: dummyRunId,
      subjectType: "graph_node",
      subjectId: dummyNodeId,
      filePath: "src/auth.ts",
      relationshipDescription: "Declared function login",
    });

    const id2 = EvidenceWriter.generateEvidenceId({
      analysisRunId: dummyRunId,
      subjectType: "graph_node",
      subjectId: dummyNodeId,
      filePath: "src/auth.ts",
      relationshipDescription: "Declared function login",
    });

    assert.equal(id1, id2);
  });

  await t.test("4. Evidence provenance is preserved exactly", () => {
    const input = EvidenceWriter.createEvidenceInput({
      organizationId: dummyOrgId,
      analysisRunId: dummyRunId,
      subjectType: "graph_edge",
      subjectId: dummyEdgeId,
      filePath: "src/api/users.ts",
      symbolId: "sym:src/api/users.ts#route:getUsers",
      lineStart: 42,
      lineEnd: 55,
      columnStart: 5,
      columnEnd: 30,
      relationshipDescription: "API route handler GET /api/users",
      confidence: 0.95,
      metadata: { framework: "nextjs" },
    });

    assert.equal(input.symbolId, "sym:src/api/users.ts#route:getUsers");
    assert.equal(input.lineStart, 42);
    assert.equal(input.lineEnd, 55);
    assert.equal(input.columnStart, 5);
    assert.equal(input.columnEnd, 30);
    assert.equal(input.confidence, 0.95);
    assert.deepEqual(input.metadata, { framework: "nextjs" });
  });

  await t.test("10. Invalid evidence input is rejected safely", () => {
    assert.throws(() => {
      EvidenceWriter.createEvidenceInput({
        organizationId: "invalid-uuid",
        analysisRunId: dummyRunId,
        subjectType: "graph_node",
        subjectId: dummyNodeId,
        filePath: "src/auth.ts",
        relationshipDescription: "desc",
      });
    }, EvidenceValidationError);

    assert.throws(() => {
      EvidenceWriter.createEvidenceInput({
        organizationId: dummyOrgId,
        analysisRunId: dummyRunId,
        subjectType: "graph_node",
        subjectId: dummyNodeId,
        filePath: "src/auth.ts",
        relationshipDescription: "desc",
        lineStart: 10,
        lineEnd: 5, // lineEnd < lineStart is invalid
      });
    }, EvidenceValidationError);

    assert.throws(() => {
      EvidenceWriter.createEvidenceInput({
        organizationId: dummyOrgId,
        analysisRunId: dummyRunId,
        subjectType: "graph_node",
        subjectId: dummyNodeId,
        filePath: "src/auth.ts",
        relationshipDescription: "desc",
        confidence: 1.5, // confidence > 1.0 is invalid
      });
    }, EvidenceValidationError);
  });

  await t.test("11. Missing/invalid provenance is not fabricated", () => {
    const input = EvidenceWriter.createEvidenceInput({
      organizationId: dummyOrgId,
      analysisRunId: dummyRunId,
      subjectType: "graph_node",
      subjectId: dummyNodeId,
      filePath: "src/unresolved.ts",
      relationshipDescription: "Unresolved relationship",
    });

    assert.equal(input.symbolId, null);
    assert.equal(input.lineStart, null);
    assert.equal(input.lineEnd, null);
    assert.equal(input.columnStart, null);
    assert.equal(input.columnEnd, null);
  });

  await t.test("12. CI evidence-lint passes for valid graph-write paths", () => {
    const validCode = `
      import { EvidenceWriter } from "@fluxora/db";

      export async function customGraphWrite(options) {
        const node = { id: "node-1" };
        const evidence = EvidenceWriter.createNodeEvidence(
          options.orgId,
          options.runId,
          node,
          "src/auth.ts",
          "Test description"
        );
        return EvidenceWriter.writeEvidence(options.pool, evidence);
      }
    `;

    const violations = inspectSourceContent("custom-write.ts", validCode);
    assert.equal(violations.length, 0);

    const repoCheck = verifyGraphWritePaths();
    assert.equal(repoCheck.success, true);
    assert.equal(repoCheck.violations.length, 0);
  });

  await t.test("13. CI evidence-lint fails when a graph-write path bypasses Evidence Writer", () => {
    const invalidCode = `
      export async function bypassWrite(pool, node) {
        const query = "INSERT INTO graph_nodes (analysis_run_id, canonical_id) VALUES ($1, $2)";
        return pool.query(query, [node.runId, node.canonicalId]);
      }
    `;

    const violations = inspectSourceContent("bypass.ts", invalidCode);
    assert.equal(violations.length, 1);
    const firstViol = violations[0];
    assert.ok(firstViol);
    assert.equal(firstViol.functionName, "bypassWrite");
    assert.ok(firstViol.message.includes("does not invoke EvidenceWriter"));
  });

  // -------------------------------------------------------------------------
  // Database & RLS Integration Tests (skipped if DATABASE_URL is not set)
  // -------------------------------------------------------------------------
  await t.test("Database Integration & RLS Tests", { skip: !hasDatabase }, async (dbT) => {
    const pool = getPool();
    await runMigrations(pool);
    await ensureRlsTestRole(pool);

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

    const orgA = await createOrganization(pool, { name: `step29-org-a-${suffix}` });
    const orgB = await createOrganization(pool, { name: `step29-org-b-${suffix}` });

    const repoA = await createRepository(pool, {
      organizationId: orgA.id,
      githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 5000}`,
      name: "step29-app-a",
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

    const runA = await createAnalysisRun(pool, {
      organizationId: orgA.id,
      snapshotId: snapshotA.id,
      status: "running",
    });

    const repoB = await createRepository(pool, {
      organizationId: orgB.id,
      githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 6000}`,
      name: "step29-app-b",
      defaultBranch: "main",
    });

    const snapshotB = await createRepositorySnapshot(pool, {
      organizationId: orgB.id,
      repositoryId: repoB.id,
      commitSha: "b".repeat(40),
      ref: "refs/heads/main",
      storageUri: "s3://snapshots/b",
      sha256: "b".repeat(64),
      fileCount: 5,
      sizeBytes: "512",
    });

    const runB = await createAnalysisRun(pool, {
      organizationId: orgB.id,
      snapshotId: snapshotB.id,
      status: "running",
    });

    dbT.after(async () => {
      delete process.env.FLUXORA_DATABASE_ROLE;
      await pool.query(`DELETE FROM organizations WHERE name LIKE $1`, [`step29-org-%-${suffix}`]);
      await closePool();
    });

    await dbT.test("3. Repeating the same evidence write is idempotent", async () => {
      const input = EvidenceWriter.createEvidenceInput({
        organizationId: orgA.id,
        analysisRunId: runA.id,
        subjectType: "graph_node",
        subjectId: EvidenceWriter.generateDeterministicUuid(`${runA.id}:dummy-node`),
        filePath: "src/idempotency.ts",
        relationshipDescription: "Idempotency test evidence",
      });

      const write1 = await EvidenceWriter.writeEvidence(pool, input);
      const write2 = await EvidenceWriter.writeEvidence(pool, input);

      assert.equal(write1.id, write2.id);
      assert.equal(write1.relationshipDescription, write2.relationshipDescription);

      const all = await listEvidenceForAnalysisRun(pool, orgA.id, runA.id);
      const matching = all.filter((ev) => ev.id === input.id);
      assert.equal(matching.length, 1);
    });

    await dbT.test("5. Batch evidence writing is deterministic and idempotent", async () => {
      const nodeAId = EvidenceWriter.generateDeterministicUuid(`${runA.id}:node-batch-a`);
      const nodeBId = EvidenceWriter.generateDeterministicUuid(`${runA.id}:node-batch-b`);

      const batchInputs: CreateEvidenceInput[] = [
        EvidenceWriter.createEvidenceInput({
          organizationId: orgA.id,
          analysisRunId: runA.id,
          subjectType: "graph_node",
          subjectId: nodeAId,
          filePath: "src/batch-a.ts",
          relationshipDescription: "Batch evidence item A",
        }),
        EvidenceWriter.createEvidenceInput({
          organizationId: orgA.id,
          analysisRunId: runA.id,
          subjectType: "graph_node",
          subjectId: nodeBId,
          filePath: "src/batch-b.ts",
          relationshipDescription: "Batch evidence item B",
        }),
      ];

      const batchResult1 = await EvidenceWriter.writeEvidenceBatch(pool, orgA.id, batchInputs);
      const batchResult2 = await EvidenceWriter.writeEvidenceBatch(pool, orgA.id, batchInputs);

      assert.equal(batchResult1.length, 2);
      assert.equal(batchResult2.length, 2);
      assert.ok(batchResult1[0] && batchResult1[1] && batchResult2[0] && batchResult2[1]);
      assert.equal(batchResult1[0].id, batchResult2[0].id);
      assert.equal(batchResult1[1].id, batchResult2[1].id);
    });

    await dbT.test("6 & 7. Graph node and edge writes receive evidence via EvidenceWriter", async () => {
      const node1Id = EvidenceWriter.generateDeterministicUuid(`${runA.id}:node-ev-1`);
      const node2Id = EvidenceWriter.generateDeterministicUuid(`${runA.id}:node-ev-2`);
      const edgeId = EvidenceWriter.generateDeterministicUuid(`${runA.id}:edge-ev-12`);

      const node1Ev = EvidenceWriter.createEvidenceInput({
        organizationId: orgA.id,
        analysisRunId: runA.id,
        subjectType: "graph_node",
        subjectId: node1Id,
        filePath: "src/node1.ts",
        relationshipDescription: "Node 1 declaration",
      });

      const node1 = await createGraphNode(pool, {
        id: node1Id,
        organizationId: orgA.id,
        analysisRunId: runA.id,
        canonicalId: "mod:src/node1.ts",
        nodeType: "module",
        name: "src/node1.ts",
        evidence: node1Ev,
      });

      const node2 = await createGraphNode(pool, {
        id: node2Id,
        organizationId: orgA.id,
        analysisRunId: runA.id,
        canonicalId: "mod:src/node2.ts",
        nodeType: "module",
        name: "src/node2.ts",
      });

      const edgeEv = EvidenceWriter.createEvidenceInput({
        organizationId: orgA.id,
        analysisRunId: runA.id,
        subjectType: "graph_edge",
        subjectId: edgeId,
        filePath: "src/node1.ts",
        relationshipDescription: "Import node 2",
      });

      await createGraphEdge(pool, {
        id: edgeId,
        organizationId: orgA.id,
        analysisRunId: runA.id,
        sourceNodeId: node1.id,
        targetNodeId: node2.id,
        edgeType: "IMPORTS",
        evidence: edgeEv,
      });

      const fetchedNodeEv = await getEvidenceById(pool, orgA.id, node1Ev.id!);
      assert.ok(fetchedNodeEv);
      assert.equal(fetchedNodeEv.subjectId, node1.id);

      const fetchedEdgeEv = await getEvidenceById(pool, orgA.id, edgeEv.id!);
      assert.ok(fetchedEdgeEv);
      assert.equal(fetchedEdgeEv.subjectId, edgeId);
    });

    await dbT.test("8. Evidence and graph records remain atomic in one transaction", async () => {
      const node1Id = EvidenceWriter.generateDeterministicUuid(`${runA.id}:atomic-node-1`);
      const node2Id = EvidenceWriter.generateDeterministicUuid(`${runA.id}:atomic-node-2`);
      const edgeId = EvidenceWriter.generateDeterministicUuid(`${runA.id}:atomic-edge-1`);

      const validNode1 = {
        id: node1Id,
        organizationId: orgA.id,
        analysisRunId: runA.id,
        canonicalId: "mod:src/atomic1.ts",
        nodeType: "module",
        name: "src/atomic1.ts",
      };

      const validNode2 = {
        id: node2Id,
        organizationId: orgA.id,
        analysisRunId: runA.id,
        canonicalId: "mod:src/atomic2.ts",
        nodeType: "module",
        name: "src/atomic2.ts",
      };

      const validEdge = {
        id: edgeId,
        organizationId: orgA.id,
        analysisRunId: runA.id,
        sourceNodeId: node1Id,
        targetNodeId: node2Id,
        edgeType: "IMPORTS",
      };

      // Invalid evidence (lineEnd < lineStart) causes transaction rollback
      const invalidEvidence = {
        id: EvidenceWriter.generateDeterministicUuid(`${runA.id}:invalid-ev`),
        organizationId: orgA.id,
        analysisRunId: runA.id,
        subjectType: "graph_node" as const,
        subjectId: node1Id,
        filePath: "src/atomic1.ts",
        relationshipDescription: "Invalid coordinates",
        lineStart: 50,
        lineEnd: 10,
      };

      await assert.rejects(async () => {
        await persistGraphBuild(pool, {
          organizationId: orgA.id,
          analysisRunId: runA.id,
          nodes: [validNode1, validNode2],
          edges: [validEdge],
          evidence: [invalidEvidence as unknown as CreateEvidenceInput],
        });
      }, EvidenceValidationError);

      const runEvidence = await listEvidenceForAnalysisRun(pool, orgA.id, runA.id);
      const invalidFound = runEvidence.filter((e) => e.id === invalidEvidence.id);
      assert.equal(invalidFound.length, 0);
    });

    await dbT.test("9. Cross-tenant / RLS protections remain intact for Evidence Writer", async () => {
      const inputB = EvidenceWriter.createEvidenceInput({
        organizationId: orgB.id,
        analysisRunId: runB.id,
        subjectType: "graph_node",
        subjectId: EvidenceWriter.generateDeterministicUuid(`${runB.id}:node-org-b`),
        filePath: "src/tenant-b.ts",
        relationshipDescription: "Tenant B evidence",
      });

      await EvidenceWriter.writeEvidence(pool, inputB);

      // Attempt reading Org B evidence using Org A credentials
      const crossTenantResult = await getEvidenceById(pool, orgA.id, inputB.id!);
      assert.equal(crossTenantResult, null);

      // Attempt reading Org B analysis run evidence list using Org A credentials
      const crossTenantList = await listEvidenceForAnalysisRun(pool, orgA.id, runB.id);
      assert.equal(crossTenantList.length, 0);
    });
  });
});
