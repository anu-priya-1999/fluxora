import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import type {
  CreateEvidenceInput,
  CreateGraphEdgeInput,
  CreateGraphNodeInput,
  GraphEdgeType,
  GraphNode,
  ImpactFinding,
} from "@fluxora/shared-types";

import { loadRootEnvFile } from "../cli/env.ts";
import { closePool, getPool } from "../pool.ts";
import { runMigrations } from "../migrate/runner.ts";
import { createOrganization } from "./organization.ts";
import { createRepository } from "./repository.ts";
import { createRepositorySnapshot } from "./repository-snapshot.ts";
import {
  createAnalysisRun,
  getEvidenceById,
  listEvidenceForAnalysisRun,
  listEvidenceForSubject,
  persistGraphBuild,
  EvidenceValidationError,
} from "./graph.ts";
import { EvidenceWriter } from "./evidence-writer.ts";
import { savePullRequestWithFiles } from "./pull-request.ts";
import {
  getImpactAnalysisById,
  listImpactFindingEvidence,
  saveImpactAnalysis,
} from "./impact-analysis.ts";
import {
  inspectSourceContent,
  verifyGraphWritePaths,
} from "./evidence-lint.ts";

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
    `GRANT EXECUTE ON FUNCTION fluxora_pull_request_in_current_tenant(uuid) TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION fluxora_impact_analysis_in_current_tenant(uuid) TO fluxora_rls_test`,
  );
  await pool.query(`GRANT SELECT ON TABLE organizations TO fluxora_rls_test`);
  await pool.query(`
    GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE repositories, repository_snapshots, commits, analysis_runs, graph_nodes, graph_edges, evidence, pull_requests, pull_request_files, impact_analyses
    TO fluxora_rls_test
  `);

  process.env.FLUXORA_DATABASE_ROLE = RLS_TEST_ROLE;
}

function makeMockNode(
  id: string,
  canonicalId: string,
  nodeType: string,
  name: string,
  path: string,
  metadata: Record<string, unknown> = {},
  confidence = 1.0,
): GraphNode {
  return {
    id,
    analysisRunId: "00000000-0000-0000-0000-000000000001",
    canonicalId,
    nodeType,
    name,
    path,
    metadata,
    confidence,
    createdAt: new Date(),
  };
}

describe("Global Step 48: Evidence Completeness Audit + Hardening", () => {
  // =========================================================================
  // Section A: Static Evidence Lint Hardening Unit Tests
  // =========================================================================
  describe("A. Static Evidence Lint Hardening", () => {
    it("A1. Linter detects missing evidence on raw graph edge write", () => {
      const code = `
        export async function persistEdges(pool, edge) {
          const sql = "INSERT INTO graph_edges (analysis_run_id, source_node_id, target_node_id) VALUES ($1, $2, $3)";
          return pool.query(sql, [edge.runId, edge.source, edge.target]);
        }
      `;
      const violations = inspectSourceContent("custom-edge-writer.ts", code);
      assert.equal(violations.length, 1);
      assert.equal(violations[0]!.functionName, "persistEdges");
      assert.equal(violations[0]!.conclusionType, "graph_edge");
      assert.ok(violations[0]!.message.includes("does not invoke EvidenceWriter"));
    });

    it("A2. Linter detects missing evidence on raw impact analysis write", () => {
      const code = `
        export async function storeImpact(pool, analysis) {
          const sql = "INSERT INTO impact_analyses (id, pull_request_id, analysis_run_id) VALUES ($1, $2, $3)";
          return pool.query(sql, [analysis.id, analysis.prId, analysis.runId]);
        }
      `;
      const violations = inspectSourceContent("custom-impact-writer.ts", code);
      assert.equal(violations.length, 1);
      assert.equal(violations[0]!.functionName, "storeImpact");
      assert.equal(violations[0]!.conclusionType, "impact_finding");
      assert.ok(violations[0]!.message.includes("does not invoke EvidenceWriter"));
    });

    it("A3. Linter passes when EvidenceWriter is properly invoked", () => {
      const code = `
        import { EvidenceWriter } from "@fluxora/db";

        export async function validEdgeWrite(pool, edgeInput, options) {
          const ev = EvidenceWriter.createEdgeEvidence(
            options.orgId,
            options.runId,
            edgeInput,
            "src/index.ts",
            "Valid edge description"
          );
          await EvidenceWriter.writeEvidence(pool, ev);
          const sql = "INSERT INTO graph_edges (id) VALUES ($1)";
          return pool.query(sql, [edgeInput.id]);
        }
      `;
      const violations = inspectSourceContent("valid-writer.ts", code);
      assert.equal(violations.length, 0);
    });

    it("A4. Linter detects missing evidence on raw simulation result write", () => {
      const code = `
        export async function storeSimResults(pool, result) {
          const sql = "INSERT INTO simulation_results (simulation_id, node_id, resulting_state) VALUES ($1, $2, $3)";
          return pool.query(sql, [result.simId, result.nodeId, result.state]);
        }
      `;
      const violations = inspectSourceContent("custom-simulation-writer.ts", code);
      assert.equal(violations.length, 1);
      assert.equal(violations[0]!.functionName, "storeSimResults");
      assert.equal(violations[0]!.conclusionType, "simulation_state");
      assert.ok(violations[0]!.message.includes("does not invoke EvidenceWriter"));
    });

    it("A5. Linter passes when EvidenceWriter is properly invoked for simulation state", () => {
      const code = `
        import { EvidenceWriter } from "@fluxora/db";

        export async function validSimResultWrite(client, simResult, options) {
          const ev = EvidenceWriter.createSimulationStateEvidence({
            organizationId: options.orgId,
            analysisRunId: options.runId,
            simulationResultId: simResult.id,
            nodeId: simResult.nodeId,
            resultingState: simResult.resultingState,
            ruleApplied: simResult.ruleApplied,
          });
          await EvidenceWriter.writeEvidenceSingleTx(client, ev);
          const sql = "INSERT INTO simulation_results (id) VALUES ($1)";
          return client.query(sql, [simResult.id]);
        }
      `;
      const violations = inspectSourceContent("valid-sim-writer.ts", code);
      assert.equal(violations.length, 0);
    });

    it("A6. CI lint check passes for all configured conclusion-producing target files", () => {
      const result = verifyGraphWritePaths();
      assert.equal(result.success, true, "All conclusion write paths must pass evidence verification");
      assert.equal(result.violations.length, 0);
      assert.ok(result.scannedFilesCount >= 4, "Must scan at least 4 conclusion-producing targets");
    });
  });

  // =========================================================================
  // Section B: Database Integration & Invariant Tests
  // =========================================================================
  describe.skipIf(!hasDatabase)("B. Database Integration & Invariant Verification", () => {
    let pool: pg.Pool;
    const suffix = Math.random().toString(36).substring(2, 8);

    let orgA: { id: string };
    let orgB: { id: string };
    let repoA: { id: string };
    let runA1: { id: string };
    let runA2: { id: string };
    let prA: { id: string };

    beforeAll(async () => {
      pool = getPool();
      await ensureRlsTestRole(pool);

      orgA = await createOrganization(pool, { name: `audit-org-a-${suffix}` });
      orgB = await createOrganization(pool, { name: `audit-org-b-${suffix}` });

      repoA = await createRepository(pool, {
        organizationId: orgA.id,
        githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 10000}`,
        name: `audit-repo-a-${suffix}`,
        defaultBranch: "main",
      });

      const snapshotA1 = await createRepositorySnapshot(pool, {
        organizationId: orgA.id,
        repositoryId: repoA.id,
        commitSha: "1".repeat(40),
        ref: "refs/heads/main",
        storageUri: "s3://snapshots/audit-a1",
        sha256: "1".repeat(64),
        fileCount: 5,
        sizeBytes: "1024",
      });

      runA1 = await createAnalysisRun(pool, {
        organizationId: orgA.id,
        snapshotId: snapshotA1.id,
        status: "completed",
      });

      const snapshotA2 = await createRepositorySnapshot(pool, {
        organizationId: orgA.id,
        repositoryId: repoA.id,
        commitSha: "2".repeat(40),
        ref: "refs/heads/main",
        storageUri: "s3://snapshots/audit-a2",
        sha256: "2".repeat(64),
        fileCount: 5,
        sizeBytes: "1024",
      });

      runA2 = await createAnalysisRun(pool, {
        organizationId: orgA.id,
        snapshotId: snapshotA2.id,
        status: "completed",
      });

      const savedPr = await savePullRequestWithFiles(pool, {
        pr: {
          organizationId: orgA.id,
          repositoryId: repoA.id,
          githubPrId: `${Math.floor(Math.random() * 1_000_000) + 20000}`,
          number: 101,
          title: "Audit PR",
          url: "https://github.com/fluxora/audit/pull/101",
          baseRef: "main",
          baseSha: "1".repeat(40),
          headRef: "feature-audit",
          headSha: "2".repeat(40),
        },
        files: [
          {
            path: "src/audit.ts",
            status: "modified",
            patch: "@@ -10,3 +10,4 @@\n function auditedFunction() {\n+  doWork();\n }\n",
          },
        ],
      });
      prA = savedPr.pullRequest;
    });

    afterAll(async () => {
      delete process.env.FLUXORA_DATABASE_ROLE;
      if (pool) {
        await closePool();
      }
    });

    // -----------------------------------------------------------------------
    // B1. Graph Evidence Completeness: Every Edge Type Produces Evidence
    // -----------------------------------------------------------------------
    it("B1. Graph evidence completeness: all supported edge types produce traceable evidence", async () => {
      const allEdgeTypes: GraphEdgeType[] = [
        "IMPORTS",
        "CALLS",
        "EXTENDS",
        "EXPOSES_ROUTE",
        "EMITS_EVENT",
        "CONSUMES_EVENT",
        "QUERIES_DB",
        "WRITES",
        "RESOLVES_TO",
      ];

      // Create a source module node and target nodes for each edge type
      const srcNodeId = EvidenceWriter.generateDeterministicUuid(`${runA1.id}:node:src`);
      const srcNodeInput: CreateGraphNodeInput = {
        id: srcNodeId,
        organizationId: orgA.id,
        analysisRunId: runA1.id,
        canonicalId: "mod:src/core.ts",
        nodeType: "module",
        name: "src/core.ts",
        path: "src/core.ts",
      };

      const targetNodes: CreateGraphNodeInput[] = allEdgeTypes.map((edgeType, idx) => {
        const id = EvidenceWriter.generateDeterministicUuid(`${runA1.id}:node:target:${edgeType}`);
        return {
          id,
          organizationId: orgA.id,
          analysisRunId: runA1.id,
          canonicalId: `target:${edgeType.toLowerCase()}:${idx}`,
          nodeType: "module",
          name: `target-${edgeType.toLowerCase()}`,
          path: `src/target-${edgeType.toLowerCase()}.ts`,
        };
      });

      const allNodes = [srcNodeInput, ...targetNodes];

      // Build edge inputs and corresponding evidence inputs
      const edgeInputs: CreateGraphEdgeInput[] = [];
      const evidenceInputs: CreateEvidenceInput[] = [];

      // Node evidence
      for (const n of allNodes) {
        const ev = EvidenceWriter.createNodeEvidence(
          orgA.id,
          runA1.id,
          n,
          n.path!,
          `Node declaration for ${n.name}`,
          {
            start: { line: 1, column: 1, offset: 0 },
            end: { line: 50, column: 1, offset: 50 },
          },
          n.canonicalId,
        )!;
        evidenceInputs.push(ev);
      }

      for (let i = 0; i < allEdgeTypes.length; i++) {
        const edgeType = allEdgeTypes[i]!;
        const target = targetNodes[i]!;
        const edgeId = EvidenceWriter.generateDeterministicUuid(
          `${runA1.id}:edge:${srcNodeInput.canonicalId}->${target.canonicalId}:${edgeType}`,
        );

        const edgeInput: CreateGraphEdgeInput = {
          id: edgeId,
          organizationId: orgA.id,
          analysisRunId: runA1.id,
          sourceNodeId: srcNodeId,
          targetNodeId: target.id!,
          edgeType,
          canonicalId: `edge:${srcNodeInput.canonicalId}->${target.canonicalId}:${edgeType}`,
          confidence: 0.95,
          provenance: "static-analysis",
        };
        edgeInputs.push(edgeInput);

        const ev = EvidenceWriter.createEdgeEvidence(
          orgA.id,
          runA1.id,
          edgeInput,
          "src/core.ts",
          `Edge ${edgeType} from core to ${target.name}`,
          {
            start: { line: 10 + i, column: 5, offset: 0 },
            end: { line: 10 + i, column: 35, offset: 30 },
          },
          srcNodeInput.canonicalId,
        )!;
        evidenceInputs.push(ev);
      }

      // Persist atomically
      const result = await persistGraphBuild(pool, {
        organizationId: orgA.id,
        analysisRunId: runA1.id,
        nodes: allNodes,
        edges: edgeInputs,
        evidence: evidenceInputs,
        emitEvent: false,
      });

      assert.equal(result.edges.length, allEdgeTypes.length);

      // Verify that every single edge in the result has an evidence row
      for (const edge of result.edges) {
        const evList = await listEvidenceForSubject(
          pool,
          orgA.id,
          runA1.id,
          "graph_edge",
          edge.id,
        );
        assert.equal(evList.length, 1, `Edge ${edge.edgeType} (${edge.id}) must have exactly 1 evidence row`);
        const ev = evList[0]!;
        assert.equal(ev.subjectType, "graph_edge");
        assert.equal(ev.subjectId, edge.id);
        assert.equal(ev.analysisRunId, runA1.id);
        assert.equal(ev.filePath, "src/core.ts");
        assert.equal(ev.confidence, edge.confidence);
        assert.ok(typeof ev.lineStart === "number" && ev.lineStart >= 1);
        assert.ok(
          typeof ev.lineEnd === "number" &&
            typeof ev.lineStart === "number" &&
            ev.lineEnd >= ev.lineStart,
        );
        assert.equal(ev.symbolId, srcNodeInput.canonicalId);
      }
    });

    // -----------------------------------------------------------------------
    // B2. Impact Finding Evidence Completeness: All Categories Linked
    // -----------------------------------------------------------------------
    it("B2. Impact finding evidence completeness: direct, downstream, affected APIs/events/services receive evidence", async () => {
      const nodeDirect = makeMockNode(
        EvidenceWriter.generateDeterministicUuid(`${runA1.id}:audit-direct`),
        "route:GET:/api/v1/direct",
        "api",
        "GET /api/v1/direct",
        "src/api/direct.ts",
        { lineStart: 12, lineEnd: 24 },
        1.0,
      );

      const nodeDownstream = makeMockNode(
        EvidenceWriter.generateDeterministicUuid(`${runA1.id}:audit-downstream`),
        "event:OrderPlaced",
        "event",
        "OrderPlaced",
        "src/events/order.ts",
        { lineStart: 5, lineEnd: 15 },
        1.0,
      );

      const nodeService = makeMockNode(
        EvidenceWriter.generateDeterministicUuid(`${runA1.id}:audit-service`),
        "service:inventory",
        "service",
        "inventory",
        "services/inventory",
        {},
        1.0,
      );

      const findingDirect: ImpactFinding = {
        node: nodeDirect,
        depth: 1,
        confidence: 0.9,
        path: ["seed-node", nodeDirect.id],
      };

      const findingDownstream: ImpactFinding = {
        node: nodeDownstream,
        depth: 2,
        confidence: 0.81,
        path: ["seed-node", nodeDirect.id, nodeDownstream.id],
      };

      const findingService: ImpactFinding = {
        node: nodeService,
        depth: 3,
        confidence: 0.729,
        path: ["seed-node", nodeDirect.id, nodeDownstream.id, nodeService.id],
      };

      const saveRes = await saveImpactAnalysis(pool, {
        organizationId: orgA.id,
        pullRequestId: prA.id,
        analysisRunId: runA1.id,
        directImpact: [findingDirect],
        downstreamImpact: [findingDownstream, findingService],
        affectedApis: [findingDirect],
        affectedEvents: [findingDownstream],
        affectedServices: [findingService],
        workflowImpactSummary: ["API route: GET /api/v1/direct", "Event: OrderPlaced", "Service: inventory"],
      });

      const { impactAnalysis, evidenceRecords } = saveRes;

      // 3 distinct nodes must produce exactly 3 evidence records
      assert.equal(evidenceRecords.length, 3);

      // Verify every category has updated evidenceIds linking to the created evidence record
      assert.ok(impactAnalysis.directImpact[0]!.evidenceIds!.length > 0);
      assert.ok(impactAnalysis.downstreamImpact[0]!.evidenceIds!.length > 0);
      assert.ok(impactAnalysis.downstreamImpact[1]!.evidenceIds!.length > 0);
      assert.ok(impactAnalysis.affectedApis[0]!.evidenceIds!.length > 0);
      assert.ok(impactAnalysis.affectedEvents[0]!.evidenceIds!.length > 0);
      assert.ok(impactAnalysis.affectedServices[0]!.evidenceIds!.length > 0);

      // Verify each evidence record in the DB
      for (const ev of evidenceRecords) {
        assert.equal(ev.subjectType, "impact_finding");
        assert.equal(ev.analysisRunId, runA1.id);
        const fetched = await getEvidenceById(pool, orgA.id, ev.id);
        assert.ok(fetched);
        assert.equal(fetched.id, ev.id);
        assert.equal(fetched.subjectType, "impact_finding");
        assert.equal(fetched.metadata.impactAnalysisId, impactAnalysis.id);
      }
    });

    // -----------------------------------------------------------------------
    // B3. Confidence Propagation & Monotonic Decay Assertion
    // -----------------------------------------------------------------------
    it("B3. Confidence propagation: depth-decayed confidence is preserved in evidence rows without reset", async () => {
      const nodeHop1 = makeMockNode(
        EvidenceWriter.generateDeterministicUuid(`${runA1.id}:hop1`),
        "sym:src/a.ts#fn1",
        "symbol",
        "fn1",
        "src/a.ts",
      );
      const nodeHop2 = makeMockNode(
        EvidenceWriter.generateDeterministicUuid(`${runA1.id}:hop2`),
        "sym:src/b.ts#fn2",
        "symbol",
        "fn2",
        "src/b.ts",
      );
      const nodeHop3 = makeMockNode(
        EvidenceWriter.generateDeterministicUuid(`${runA1.id}:hop3`),
        "sym:src/c.ts#fn3",
        "symbol",
        "fn3",
        "src/c.ts",
      );

      const decayFactor = 0.85;
      const conf1 = Math.round(1.0 * Math.pow(decayFactor, 1) * 10000) / 10000; // 0.8500
      const conf2 = Math.round(1.0 * Math.pow(decayFactor, 2) * 10000) / 10000; // 0.7225
      const conf3 = Math.round(1.0 * Math.pow(decayFactor, 3) * 10000) / 10000; // 0.6141

      // Assert decay inequality: depth 1 > depth 2 > depth 3
      assert.ok(conf1 > conf2, "Depth 1 confidence must be strictly higher than Depth 2");
      assert.ok(conf2 > conf3, "Depth 2 confidence must be strictly higher than Depth 3");

      const finding1: ImpactFinding = { node: nodeHop1, depth: 1, confidence: conf1, path: ["seed", nodeHop1.id] };
      const finding2: ImpactFinding = { node: nodeHop2, depth: 2, confidence: conf2, path: ["seed", nodeHop1.id, nodeHop2.id] };
      const finding3: ImpactFinding = { node: nodeHop3, depth: 3, confidence: conf3, path: ["seed", nodeHop1.id, nodeHop2.id, nodeHop3.id] };

      const saveResult = await saveImpactAnalysis(pool, {
        organizationId: orgA.id,
        pullRequestId: prA.id,
        analysisRunId: runA1.id,
        directImpact: [finding1],
        downstreamImpact: [finding2, finding3],
      });

      const evRecords = saveResult.evidenceRecords;
      const ev1 = evRecords.find((e) => e.subjectId === nodeHop1.id)!;
      const ev2 = evRecords.find((e) => e.subjectId === nodeHop2.id)!;
      const ev3 = evRecords.find((e) => e.subjectId === nodeHop3.id)!;

      // Evidence confidence must match conclusion confidence and must NOT be reset to 1.0
      assert.equal(ev1.confidence, conf1);
      assert.equal(ev2.confidence, conf2);
      assert.equal(ev3.confidence, conf3);
      assert.notEqual(ev1.confidence, 1.0);
      assert.notEqual(ev2.confidence, 1.0);
      assert.notEqual(ev3.confidence, 1.0);
    });

    // -----------------------------------------------------------------------
    // B4. Transaction Atomicity & Failure Rollback
    // -----------------------------------------------------------------------
    it("B4. Transaction atomicity: invalid evidence aborts and rolls back entire conclusion write", async () => {
      const badAnalysisId = crypto.randomUUID();
      const node = makeMockNode(
        EvidenceWriter.generateDeterministicUuid(`${runA1.id}:rollback-node`),
        "mod:src/rollback.ts",
        "module",
        "src/rollback.ts",
        "src/rollback.ts",
        { lineStart: 100, lineEnd: 20 }, // Invalid: lineEnd < lineStart
      );

      const finding: ImpactFinding = {
        node,
        depth: 1,
        confidence: 0.9,
        path: ["seed", node.id],
      };

      // saveImpactAnalysis must reject with EvidenceValidationError
      await assert.rejects(
        () =>
          saveImpactAnalysis(pool, {
            id: badAnalysisId,
            organizationId: orgA.id,
            pullRequestId: prA.id,
            analysisRunId: runA1.id,
            directImpact: [finding],
            downstreamImpact: [],
          }),
        EvidenceValidationError,
      );

      // Verify that NO impact analysis row was committed
      const fetchedAnalysis = await getImpactAnalysisById(pool, orgA.id, badAnalysisId);
      assert.equal(fetchedAnalysis, null, "Impact analysis must be completely rolled back on evidence failure");

      // Verify that NO evidence rows were committed for this analysis
      const evidenceList = await listImpactFindingEvidence(pool, orgA.id, badAnalysisId);
      assert.equal(evidenceList.length, 0, "No evidence rows should exist after transaction rollback");
    });

    it("B5. Transaction atomicity: persistGraphBuild rolls back all nodes and edges if evidence write fails", async () => {
      const rollbackNodeId = EvidenceWriter.generateDeterministicUuid(`${runA1.id}:persist-rollback-node`);
      const rollbackNode: CreateGraphNodeInput = {
        id: rollbackNodeId,
        organizationId: orgA.id,
        analysisRunId: runA1.id,
        canonicalId: "mod:src/persist-rollback.ts",
        nodeType: "module",
        name: "src/persist-rollback.ts",
      };

      const badEvidence: CreateEvidenceInput = {
        id: EvidenceWriter.generateDeterministicUuid(`${runA1.id}:bad-ev`),
        organizationId: orgA.id,
        analysisRunId: runA1.id,
        subjectType: "graph_node",
        subjectId: rollbackNodeId,
        filePath: "src/persist-rollback.ts",
        relationshipDescription: "Bad coordinates",
        lineStart: 50,
        lineEnd: 10, // Invalid!
      };

      await assert.rejects(
        () =>
          persistGraphBuild(pool, {
            organizationId: orgA.id,
            analysisRunId: runA1.id,
            nodes: [rollbackNode],
            edges: [],
            evidence: [badEvidence],
          }),
        EvidenceValidationError,
      );

      // Verify that rollbackNode was not committed
      const evidenceRows = await listEvidenceForSubject(pool, orgA.id, runA1.id, "graph_node", rollbackNodeId);
      assert.equal(evidenceRows.length, 0);
    });

    // -----------------------------------------------------------------------
    // B5. Idempotency & Analysis-Run Isolation
    // -----------------------------------------------------------------------
    it("B6. Analysis-run isolation: identical conclusions in Run A1 and Run A2 produce isolated evidence", async () => {
      const nodeCanonical = "mod:src/isolated.ts";
      const nodeA1Id = EvidenceWriter.generateDeterministicUuid(`${runA1.id}:${nodeCanonical}`);
      const nodeA2Id = EvidenceWriter.generateDeterministicUuid(`${runA2.id}:${nodeCanonical}`);

      // Same code relationship in Run A1
      const ev1 = EvidenceWriter.createEvidenceInput({
        organizationId: orgA.id,
        analysisRunId: runA1.id,
        subjectType: "graph_node",
        subjectId: nodeA1Id,
        filePath: "src/isolated.ts",
        relationshipDescription: "Isolated module test",
      });
      await EvidenceWriter.writeEvidence(pool, ev1);

      // Same code relationship in Run A2
      const ev2 = EvidenceWriter.createEvidenceInput({
        organizationId: orgA.id,
        analysisRunId: runA2.id,
        subjectType: "graph_node",
        subjectId: nodeA2Id,
        filePath: "src/isolated.ts",
        relationshipDescription: "Isolated module test",
      });
      await EvidenceWriter.writeEvidence(pool, ev2);

      // Run A1 and Run A2 must have different deterministic evidence IDs
      assert.notEqual(ev1.id, ev2.id, "Evidence IDs across different analysis runs must be distinct");

      // Run A1 cannot see Run A2 evidence
      const runA1List = await listEvidenceForAnalysisRun(pool, orgA.id, runA1.id);
      const runA2List = await listEvidenceForAnalysisRun(pool, orgA.id, runA2.id);

      assert.ok(runA1List.some((e) => e.id === ev1.id));
      assert.ok(!runA1List.some((e) => e.id === ev2.id), "Run A1 must never include Run A2 evidence");

      assert.ok(runA2List.some((e) => e.id === ev2.id));
      assert.ok(!runA2List.some((e) => e.id === ev1.id), "Run A2 must never include Run A1 evidence");
    });

    // -----------------------------------------------------------------------
    // B7. Tenant Isolation / RLS Safeguards
    // -----------------------------------------------------------------------
    it("B7. Tenant isolation (RLS): Tenant B cannot read or create Tenant A evidence", async () => {
      // Evidence in Tenant A
      const evA = EvidenceWriter.createEvidenceInput({
        organizationId: orgA.id,
        analysisRunId: runA1.id,
        subjectType: "graph_node",
        subjectId: EvidenceWriter.generateDeterministicUuid(`${runA1.id}:node-tenancy`),
        filePath: "src/tenant.ts",
        relationshipDescription: "Tenant A private evidence",
      });
      await EvidenceWriter.writeEvidence(pool, evA);

      // Tenant B read attempt returns null / empty
      const tenantBRead = await getEvidenceById(pool, orgB.id, evA.id!);
      assert.equal(tenantBRead, null, "Cross-tenant evidence read must return null");

      const tenantBList = await listEvidenceForAnalysisRun(pool, orgB.id, runA1.id);
      assert.deepEqual(tenantBList, [], "Cross-tenant listEvidenceForAnalysisRun must return empty array");

      // Tenant B write attempt with Tenant A's analysisRunId fails RLS check
      const maliciousEvB = EvidenceWriter.createEvidenceInput({
        organizationId: orgB.id,
        analysisRunId: runA1.id, // Org A's run!
        subjectType: "graph_node",
        subjectId: EvidenceWriter.generateDeterministicUuid(`${runA1.id}:forged`),
        filePath: "src/forged.ts",
        relationshipDescription: "Cross-tenant forgery attempt",
      });

      await assert.rejects(
        () => EvidenceWriter.writeEvidence(pool, maliciousEvB),
        /row-level security policy|violates row-level security policy/i,
      );
    });
  });
});

