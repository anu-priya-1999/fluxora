import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import type {
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
  createGraphNode,
  createGraphEdge,
} from "./graph.ts";
import { EvidenceWriter } from "./evidence-writer.ts";
import { savePullRequestWithFiles } from "./pull-request.ts";
import {
  ImpactAnalysisPersistenceValidationError,
  getImpactAnalysisById,
  getLatestImpactAnalysisForPullRequest,
  listImpactAnalysesForPullRequest,
  listImpactFindingEvidence,
  persistPullRequestImpactAnalysis,
  saveImpactAnalysis,
} from "./impact-analysis.ts";
import { PullRequestNotFoundError } from "./impact-analysis-engine.ts";

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

function makeNode(
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

// ===========================================================================
// Part 1: Unit & In-Memory Validation Tests (Step 44)
// ===========================================================================

describe("Step 44: Impact Analysis Persistence & Evidence - Unit & Validation Tests", () => {
  const dummyOrgId = "00000000-0000-0000-0000-000000000001";
  const dummyRunId = "00000000-0000-0000-0000-000000000002";
  const dummyPrId = "00000000-0000-0000-0000-000000000003";
  const dummyAnalysisId = "00000000-0000-0000-0000-000000000004";
  const dummyNodeId = "00000000-0000-0000-0000-000000000005";

  it("1. EvidenceWriter.createImpactFindingEvidence constructs deterministic evidence input with coordinates and metadata", () => {
    const node = makeNode(
      dummyNodeId,
      "sym:src/payment.ts#charge:10",
      "symbol",
      "charge",
      "src/payment.ts",
      { lineStart: 10, lineEnd: 25 },
      0.9,
    );

    const finding: ImpactFinding = {
      node,
      depth: 1,
      confidence: 0.9,
      path: ["seed-node-id", node.id],
      evidenceIds: ["existing-edge-ev-1"],
    };

    const ev = EvidenceWriter.createImpactFindingEvidence({
      organizationId: dummyOrgId,
      analysisRunId: dummyRunId,
      impactAnalysisId: dummyAnalysisId,
      pullRequestId: dummyPrId,
      finding,
    });

    assert.ok(ev.id, "Evidence ID should be deterministically generated");
    assert.equal(ev.subjectType, "impact_finding");
    assert.equal(ev.subjectId, node.id);
    assert.equal(ev.filePath, "src/payment.ts");
    assert.equal(ev.lineStart, 10);
    assert.equal(ev.lineEnd, 25);
    assert.equal(ev.confidence, 0.9);
    assert.equal(ev.metadata?.impactAnalysisId, dummyAnalysisId);
    assert.equal(ev.metadata?.pullRequestId, dummyPrId);
    assert.equal(ev.metadata?.depth, 1);
    assert.deepEqual(ev.metadata?.supportingEvidenceIds, ["existing-edge-ev-1"]);
  });

  it("2. EvidenceWriter.createImpactFindingEvidence is deterministic across multiple calls", () => {
    const node = makeNode(
      dummyNodeId,
      "sym:src/checkout.ts#process:5",
      "symbol",
      "process",
      "src/checkout.ts",
    );

    const finding: ImpactFinding = {
      node,
      depth: 2,
      confidence: 0.81,
      path: ["seed", "hop1", node.id],
    };

    const ev1 = EvidenceWriter.createImpactFindingEvidence({
      organizationId: dummyOrgId,
      analysisRunId: dummyRunId,
      impactAnalysisId: dummyAnalysisId,
      pullRequestId: dummyPrId,
      finding,
    });

    const ev2 = EvidenceWriter.createImpactFindingEvidence({
      organizationId: dummyOrgId,
      analysisRunId: dummyRunId,
      impactAnalysisId: dummyAnalysisId,
      pullRequestId: dummyPrId,
      finding,
    });

    assert.equal(ev1.id, ev2.id, "Repeated evidence creation must produce identical UUIDs");
  });

  it("3. Validation: saveImpactAnalysisTx rejects invalid UUIDs", async () => {
    await assert.rejects(
      () =>
        saveImpactAnalysis({} as pg.Pool, {
          organizationId: "invalid-uuid",
          pullRequestId: dummyPrId,
          analysisRunId: dummyRunId,
        }),
      ImpactAnalysisPersistenceValidationError,
    );

    await assert.rejects(
      () =>
        saveImpactAnalysis({} as pg.Pool, {
          organizationId: dummyOrgId,
          pullRequestId: "invalid-uuid",
          analysisRunId: dummyRunId,
        }),
      ImpactAnalysisPersistenceValidationError,
    );

    await assert.rejects(
      () =>
        saveImpactAnalysis({} as pg.Pool, {
          organizationId: dummyOrgId,
          pullRequestId: dummyPrId,
          analysisRunId: "invalid-uuid",
        }),
      ImpactAnalysisPersistenceValidationError,
    );

    await assert.rejects(
      () =>
        saveImpactAnalysis({} as pg.Pool, {
          id: "not-a-uuid",
          organizationId: dummyOrgId,
          pullRequestId: dummyPrId,
          analysisRunId: dummyRunId,
        }),
      ImpactAnalysisPersistenceValidationError,
    );
  });

  it("4. Query methods return null or empty array on malformed UUID inputs", async () => {
    const dummyPool = {} as pg.Pool;

    const res1 = await getImpactAnalysisById(dummyPool, dummyOrgId, "bad-id");
    assert.equal(res1, null);

    const res2 = await getLatestImpactAnalysisForPullRequest(dummyPool, dummyOrgId, "bad-id");
    assert.equal(res2, null);

    const res3 = await listImpactAnalysesForPullRequest(dummyPool, dummyOrgId, "bad-id");
    assert.deepEqual(res3, []);

    const res4 = await listImpactFindingEvidence(dummyPool, dummyOrgId, "bad-id");
    assert.deepEqual(res4, []);
  });
});

// ===========================================================================
// Part 2: Database Integration Tests (Step 44 End-to-End)
// ===========================================================================

describe.skipIf(!hasDatabase)("Step 44: Impact Analysis Persistence & Evidence - PostgreSQL Integration", () => {
  let pool: pg.Pool;
  const suffix = Math.random().toString(36).substring(2, 8);

  let orgA: { id: string };
  let orgB: { id: string };
  let repoA: { id: string };
  let runA: { id: string };
  let prA: { id: string };
  let prEmpty: { id: string };

  let nodeModule: GraphNode;
  let nodeSymbol: GraphNode;
  let nodeApi: GraphNode;
  let nodeEvent: GraphNode;
  let nodeService: GraphNode;

  beforeAll(async () => {
    pool = getPool();
    await ensureRlsTestRole(pool);

    // Setup Org A
    orgA = await createOrganization(pool, { name: `impact-persist-org-a-${suffix}` });
    repoA = await createRepository(pool, {
      organizationId: orgA.id,
      githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 2000}`,
      name: `impact-persist-repo-a-${suffix}`,
      defaultBranch: "main",
    });

    const snapshotA = await createRepositorySnapshot(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      commitSha: "b".repeat(40),
      ref: "refs/heads/main",
      storageUri: "s3://snapshots/impact-persist-a",
      sha256: "b".repeat(64),
      fileCount: 5,
      sizeBytes: "2048",
    });

    runA = await createAnalysisRun(pool, {
      organizationId: orgA.id,
      snapshotId: snapshotA.id,
      status: "completed",
    });

    // Setup Org B for tenant isolation testing
    orgB = await createOrganization(pool, { name: `impact-persist-org-b-${suffix}` });

    // Seed Graph Nodes in Run A
    nodeModule = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA.id,
      canonicalId: "mod:src/billing.ts",
      nodeType: "module",
      name: "src/billing.ts",
      path: "src/billing.ts",
    });

    nodeSymbol = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA.id,
      canonicalId: "sym:src/billing.ts#processPayment:15",
      nodeType: "symbol",
      name: "processPayment",
      path: "src/billing.ts",
      metadata: { lineStart: 15, lineEnd: 30 },
    });

    nodeApi = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA.id,
      canonicalId: "route:POST:/api/v1/billing",
      nodeType: "api",
      name: "POST /api/v1/billing",
      path: "src/routes/billing.ts",
      metadata: { routePath: "/api/v1/billing" },
    });

    nodeEvent = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA.id,
      canonicalId: "event:PaymentProcessed",
      nodeType: "event",
      name: "PaymentProcessed",
      path: "src/events.ts",
    });

    nodeService = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA.id,
      canonicalId: "service:ledger-service",
      nodeType: "service",
      name: "ledger-service",
      path: "services/ledger",
    });

    // Seed Graph Edges
    await createGraphEdge(pool, {
      organizationId: orgA.id,
      analysisRunId: runA.id,
      sourceNodeId: nodeModule.id,
      targetNodeId: nodeSymbol.id,
      edgeType: "RESOLVES_TO",
    });

    await createGraphEdge(pool, {
      organizationId: orgA.id,
      analysisRunId: runA.id,
      sourceNodeId: nodeSymbol.id,
      targetNodeId: nodeApi.id,
      edgeType: "CALLS",
    });

    await createGraphEdge(pool, {
      organizationId: orgA.id,
      analysisRunId: runA.id,
      sourceNodeId: nodeApi.id,
      targetNodeId: nodeEvent.id,
      edgeType: "EMITS_EVENT",
    });

    await createGraphEdge(pool, {
      organizationId: orgA.id,
      analysisRunId: runA.id,
      sourceNodeId: nodeEvent.id,
      targetNodeId: nodeService.id,
      edgeType: "CALLS",
    });

    // Seed PR A with changed file src/billing.ts overlapping processPayment
    const patch = `
@@ -15,4 +15,5 @@
 function processPayment() {
+  auditLog();
 }
`;
    const savedPrA = await savePullRequestWithFiles(pool, {
      pr: {
        organizationId: orgA.id,
        repositoryId: repoA.id,
        githubPrId: `${Math.floor(Math.random() * 1_000_000) + 300}`,
        number: 201,
        title: "Add audit logging to billing",
        url: "https://github.com/fluxora/repo/pull/201",
        baseRef: "main",
        baseSha: "3".repeat(40),
        headRef: "feature-billing-audit",
        headSha: "4".repeat(40),
      },
      files: [
        {
          path: "src/billing.ts",
          status: "modified",
          patch,
        },
      ],
    });
    prA = savedPrA.pullRequest;

    // Seed Empty PR (zero changed files)
    const savedPrEmpty = await savePullRequestWithFiles(pool, {
      pr: {
        organizationId: orgA.id,
        repositoryId: repoA.id,
        githubPrId: `${Math.floor(Math.random() * 1_000_000) + 400}`,
        number: 202,
        title: "Empty pull request",
        url: "https://github.com/fluxora/repo/pull/202",
        baseRef: "main",
        baseSha: "5".repeat(40),
        headRef: "empty-pr",
        headSha: "6".repeat(40),
      },
      files: [],
    });
    prEmpty = savedPrEmpty.pullRequest;
  });

  afterAll(async () => {
    if (pool) {
      await closePool();
    }
  });

  it("5. saveImpactAnalysis persists ImpactAnalysis record and commits impact_finding evidence records", async () => {
    const finding1: ImpactFinding = {
      node: nodeApi,
      depth: 1,
      confidence: 0.9,
      path: [nodeSymbol.id, nodeApi.id],
    };

    const finding2: ImpactFinding = {
      node: nodeEvent,
      depth: 2,
      confidence: 0.81,
      path: [nodeSymbol.id, nodeApi.id, nodeEvent.id],
    };

    const saveResult = await saveImpactAnalysis(pool, {
      organizationId: orgA.id,
      pullRequestId: prA.id,
      analysisRunId: runA.id,
      directImpact: [finding1],
      downstreamImpact: [finding2],
      affectedApis: [finding1],
      affectedEvents: [finding2],
      affectedServices: [],
      workflowImpactSummary: ["API route: POST /api/v1/billing", "Event: PaymentProcessed"],
      maxDepthReached: 2,
      metadata: { testTag: "manual-save" },
    });

    const { impactAnalysis, evidenceRecords } = saveResult;

    assert.ok(impactAnalysis.id, "Impact analysis must have a valid ID");
    assert.equal(impactAnalysis.pullRequestId, prA.id);
    assert.equal(impactAnalysis.analysisRunId, runA.id);
    assert.equal(impactAnalysis.status, "completed");
    assert.equal(impactAnalysis.directImpact.length, 1);
    assert.equal(impactAnalysis.downstreamImpact.length, 1);
    assert.equal(impactAnalysis.affectedApis.length, 1);
    assert.equal(impactAnalysis.affectedEvents.length, 1);
    assert.equal(impactAnalysis.maxDepthReached, 2);

    // Verify evidence was written and returned
    assert.equal(evidenceRecords.length, 2, "Must create 2 impact_finding evidence records");
    for (const ev of evidenceRecords) {
      assert.equal(ev.subjectType, "impact_finding");
      assert.equal(ev.analysisRunId, runA.id);
      assert.ok(ev.metadata?.impactAnalysisId === impactAnalysis.id);
      assert.ok(ev.metadata?.pullRequestId === prA.id);
    }

    // Verify findings within stored impactAnalysis have updated evidenceIds
    assert.ok(
      impactAnalysis.directImpact[0]!.evidenceIds &&
        impactAnalysis.directImpact[0]!.evidenceIds.length > 0,
      "directImpact finding must contain linked evidence ID",
    );
    assert.ok(
      impactAnalysis.downstreamImpact[0]!.evidenceIds &&
        impactAnalysis.downstreamImpact[0]!.evidenceIds.length > 0,
      "downstreamImpact finding must contain linked evidence ID",
    );
  });

  it("6. Idempotency: Re-saving an ImpactAnalysis with the same ID updates cleanly without duplicate evidence", async () => {
    const fixedId = crypto.randomUUID();

    const finding: ImpactFinding = {
      node: nodeApi,
      depth: 1,
      confidence: 0.9,
      path: [nodeSymbol.id, nodeApi.id],
    };

    // First save
    const res1 = await saveImpactAnalysis(pool, {
      id: fixedId,
      organizationId: orgA.id,
      pullRequestId: prA.id,
      analysisRunId: runA.id,
      directImpact: [finding],
      downstreamImpact: [],
      metadata: { version: 1 },
    });

    assert.equal(res1.impactAnalysis.id, fixedId);
    assert.equal(res1.impactAnalysis.metadata.version, 1);

    // Second save with updated metadata
    const res2 = await saveImpactAnalysis(pool, {
      id: fixedId,
      organizationId: orgA.id,
      pullRequestId: prA.id,
      analysisRunId: runA.id,
      directImpact: [finding],
      downstreamImpact: [],
      metadata: { version: 2 },
    });

    assert.equal(res2.impactAnalysis.id, fixedId);
    assert.equal(res2.impactAnalysis.metadata.version, 2);

    // Verify evidence records were not duplicated
    const evidenceList = await listImpactFindingEvidence(pool, orgA.id, fixedId);
    assert.equal(evidenceList.length, 1, "Idempotent write must not create duplicate evidence rows");
  });

  it("7. persistPullRequestImpactAnalysis executes Step 43 engine and persists result + evidence end-to-end", async () => {
    const persistResult = await persistPullRequestImpactAnalysis(pool, {
      organizationId: orgA.id,
      pullRequestId: prA.id,
      analysisRunId: runA.id,
      maxDepth: 5,
      metadata: { trigger: "e2e-test" },
    });

    const { impactAnalysis, evidenceRecords } = persistResult;

    assert.ok(impactAnalysis.id);
    assert.equal(impactAnalysis.pullRequestId, prA.id);
    assert.equal(impactAnalysis.analysisRunId, runA.id);
    assert.equal(impactAnalysis.status, "completed");

    // PR changed src/billing.ts -> resolved to processPayment
    // processPayment -> nodeApi (depth 1, direct)
    // nodeApi -> nodeEvent (depth 2, downstream)
    // nodeEvent -> nodeService (depth 3, downstream)
    assert.equal(impactAnalysis.directImpact.length, 1);
    assert.equal(impactAnalysis.directImpact[0]!.node.id, nodeApi.id);

    assert.equal(impactAnalysis.downstreamImpact.length, 2);
    const downstreamIds = impactAnalysis.downstreamImpact.map((f) => f.node.id);
    assert.ok(downstreamIds.includes(nodeEvent.id));
    assert.ok(downstreamIds.includes(nodeService.id));

    // Verify taxonomy groupings
    assert.equal(impactAnalysis.affectedApis.length, 1);
    assert.equal(impactAnalysis.affectedEvents.length, 1);
    assert.equal(impactAnalysis.affectedServices.length, 1);

    // Verify all 3 findings received evidence records
    assert.equal(evidenceRecords.length, 3);
    for (const ev of evidenceRecords) {
      assert.equal(ev.subjectType, "impact_finding");
      assert.equal(ev.metadata?.impactAnalysisId, impactAnalysis.id);
    }
  });

  it("8. getImpactAnalysisById retrieves the exact persisted impact analysis", async () => {
    const latest = await getLatestImpactAnalysisForPullRequest(pool, orgA.id, prA.id);
    assert.ok(latest, "A previous test should have created an impact analysis");

    const fetched = await getImpactAnalysisById(pool, orgA.id, latest.id);
    assert.ok(fetched);
    assert.equal(fetched.id, latest.id);
    assert.equal(fetched.pullRequestId, prA.id);
    assert.equal(fetched.analysisRunId, latest.analysisRunId);
    assert.equal(fetched.directImpact.length, latest.directImpact.length);
    assert.equal(fetched.downstreamImpact.length, latest.downstreamImpact.length);
  });

  it("9. getLatestImpactAnalysisForPullRequest and listImpactAnalysesForPullRequest order correctly", async () => {
    const listBefore = await listImpactAnalysesForPullRequest(pool, orgA.id, prA.id);
    const initialCount = listBefore.length;

    // Save a new impact analysis
    const newer = await saveImpactAnalysis(pool, {
      organizationId: orgA.id,
      pullRequestId: prA.id,
      analysisRunId: runA.id,
      directImpact: [],
      downstreamImpact: [],
      metadata: { tag: "latest-check" },
    });

    const latest = await getLatestImpactAnalysisForPullRequest(pool, orgA.id, prA.id);
    assert.ok(latest);
    assert.equal(latest.id, newer.impactAnalysis.id, "getLatest must return the newest record");

    const listAfter = await listImpactAnalysesForPullRequest(pool, orgA.id, prA.id);
    assert.equal(listAfter.length, initialCount + 1);
    assert.equal(listAfter[0]!.id, newer.impactAnalysis.id, "First item in list must be the newest record");
  });

  it("10. listImpactFindingEvidence retrieves all evidence records associated with an impact analysis", async () => {
    const fixedId = crypto.randomUUID();

    const finding1: ImpactFinding = {
      node: nodeApi,
      depth: 1,
      confidence: 0.9,
      path: [nodeSymbol.id, nodeApi.id],
    };
    const finding2: ImpactFinding = {
      node: nodeService,
      depth: 3,
      confidence: 0.729,
      path: [nodeSymbol.id, nodeApi.id, nodeEvent.id, nodeService.id],
    };

    await saveImpactAnalysis(pool, {
      id: fixedId,
      organizationId: orgA.id,
      pullRequestId: prA.id,
      analysisRunId: runA.id,
      directImpact: [finding1],
      downstreamImpact: [finding2],
    });

    const evidence = await listImpactFindingEvidence(pool, orgA.id, fixedId);
    assert.equal(evidence.length, 2);
    const subjectIds = evidence.map((e) => e.subjectId);
    assert.ok(subjectIds.includes(nodeApi.id));
    assert.ok(subjectIds.includes(nodeService.id));
  });

  it("11. Tenant isolation (RLS): Cross-tenant access is blocked at PostgreSQL engine level", async () => {
    const analysisA = await getLatestImpactAnalysisForPullRequest(pool, orgA.id, prA.id);
    assert.ok(analysisA);

    // Org B attempts to read Org A's impact analysis by ID
    const crossGet = await getImpactAnalysisById(pool, orgB.id, analysisA.id);
    assert.equal(crossGet, null, "Cross-tenant getImpactAnalysisById must return null");

    // Org B attempts to read Org A's latest impact analysis
    const crossLatest = await getLatestImpactAnalysisForPullRequest(pool, orgB.id, prA.id);
    assert.equal(crossLatest, null, "Cross-tenant getLatestImpactAnalysisForPullRequest must return null");

    // Org B attempts to list Org A's impact analyses
    const crossList = await listImpactAnalysesForPullRequest(pool, orgB.id, prA.id);
    assert.deepEqual(crossList, [], "Cross-tenant listImpactAnalysesForPullRequest must return empty array");

    // Org B attempts to list Org A's impact finding evidence
    const crossEvidence = await listImpactFindingEvidence(pool, orgB.id, analysisA.id);
    assert.deepEqual(crossEvidence, [], "Cross-tenant listImpactFindingEvidence must return empty array");
  });

  it("12. Tenant isolation on INSERT: Attempting to save impact analysis under Org B for Org A's PR fails", async () => {
    await assert.rejects(
      () =>
        saveImpactAnalysis(pool, {
          organizationId: orgB.id, // Wrong tenant
          pullRequestId: prA.id, // Org A's PR
          analysisRunId: runA.id,
          directImpact: [],
          downstreamImpact: [],
        }),
      PullRequestNotFoundError,
    );
  });

  it("13. Non-existent pull request throws PullRequestNotFoundError", async () => {
    const nonExistentPrId = "99999999-9999-4999-8999-999999999999";

    await assert.rejects(
      () =>
        saveImpactAnalysis(pool, {
          organizationId: orgA.id,
          pullRequestId: nonExistentPrId,
          analysisRunId: runA.id,
          directImpact: [],
          downstreamImpact: [],
        }),
      PullRequestNotFoundError,
    );
  });

  it("14. Empty pull request persists cleanly with empty arrays and zero evidence records", async () => {
    const result = await persistPullRequestImpactAnalysis(pool, {
      organizationId: orgA.id,
      pullRequestId: prEmpty.id,
      analysisRunId: runA.id,
    });

    assert.ok(result.impactAnalysis.id);
    assert.equal(result.impactAnalysis.directImpact.length, 0);
    assert.equal(result.impactAnalysis.downstreamImpact.length, 0);
    assert.equal(result.evidenceRecords.length, 0);
  });

  it("15. Truncated impact analysis persists truncated: true and truncation_reason accurately", async () => {
    // maxDepth = 1 on prA will hit the API node at depth 1, which has outgoing edges to nodeEvent
    // This triggers truncationDetected = true
    const result = await persistPullRequestImpactAnalysis(pool, {
      organizationId: orgA.id,
      pullRequestId: prA.id,
      analysisRunId: runA.id,
      maxDepth: 1,
    });

    assert.equal(result.impactAnalysis.truncated, true);
    assert.ok(
      result.impactAnalysis.truncationReason &&
        result.impactAnalysis.truncationReason.includes("depth limit of 1 hops"),
      "truncationReason must explain the depth ceiling",
    );
  });
});

