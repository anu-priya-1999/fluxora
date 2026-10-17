import assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import type {
  GraphEdge,
  GraphEdgeType,
  GraphNode,
  GraphNodeType,
  PullRequestFile,
  PullRequestFileStatus,
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
import { savePullRequestWithFiles } from "./pull-request.ts";
import {
  AnalysisSnapshotUnavailableError,
  ImpactAnalysisValidationError,
  PullRequestNotFoundError,
  analyzePullRequestImpact,
  computeImpactAnalysis,
  parsePatchModifiedLines,
  resolveFilesToSeeds,
} from "./impact-analysis-engine.ts";

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
  await pool.query(`GRANT SELECT ON TABLE organizations TO fluxora_rls_test`);
  await pool.query(`
    GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE repositories, repository_snapshots, commits, analysis_runs, graph_nodes, graph_edges, evidence, pull_requests, pull_request_files
    TO fluxora_rls_test
  `);

  process.env.FLUXORA_DATABASE_ROLE = RLS_TEST_ROLE;
}

// Helper factory to create in-memory GraphNode
function makeNode(
  id: string,
  canonicalId: string,
  nodeType: GraphNodeType,
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
    createdAt: new Date("2026-10-16T12:00:00Z"),
  };
}

// Helper factory to create in-memory GraphEdge
function makeEdge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  edgeType: GraphEdgeType = "CALLS",
  canonicalId = `edge:${sourceNodeId}->${targetNodeId}`,
  confidence = 1.0,
): GraphEdge {
  return {
    id,
    analysisRunId: "00000000-0000-0000-0000-000000000001",
    sourceNodeId,
    targetNodeId,
    edgeType,
    canonicalId,
    metadata: {},
    confidence,
    provenance: "static-analysis",
    createdAt: new Date("2026-10-16T12:00:00Z"),
  };
}

// Helper factory to create in-memory PullRequestFile
function makePrFile(
  path: string,
  patch: string | null = null,
  status: PullRequestFileStatus = "modified",
): PullRequestFile {
  return {
    id: `file-${path}`,
    pullRequestId: "00000000-0000-0000-0000-000000000010",
    path,
    previousPath: null,
    status,
    additions: 10,
    deletions: 2,
    changes: 12,
    patch,
    patchTruncated: false,
    baseSha: "1".repeat(40),
    headSha: "2".repeat(40),
    createdAt: new Date("2026-10-16T12:00:00Z"),
  };
}

// ===========================================================================
// Part 1: In-Memory Pure Algorithmic Engine Unit Tests
// ===========================================================================

describe("Step 43: Impact Analysis Engine - Algorithmic & Unit Tests", () => {
  const dummyContext = {
    pullRequestId: "00000000-0000-0000-0000-000000000010",
    analysisRunId: "00000000-0000-0000-0000-000000000001",
    repositoryId: "00000000-0000-0000-0000-000000000002",
    organizationId: "00000000-0000-0000-0000-000000000003",
  };

  it("1. Single changed symbol with direct downstream impact (depth = 1)", () => {
    const sym1 = makeNode("n1", "sym:src/auth.ts#fn:login:10", "symbol", "login", "src/auth.ts", { lineStart: 10, lineEnd: 25 });
    const sym2 = makeNode("n2", "sym:src/router.ts#fn:handleAuth:5", "symbol", "handleAuth", "src/router.ts");
    const edge = makeEdge("e1", "n1", "n2", "CALLS");

    const result = computeImpactAnalysis({
      ...dummyContext,
      changedFiles: [makePrFile("src/auth.ts")],
      graphNodes: [sym1, sym2],
      graphEdges: [edge],
      maxDepth: 5,
    });

    assert.equal(result.seedNodes.length, 1);
    assert.equal(result.seedNodes[0]!.id, "n1");
    assert.equal(result.directImpacts.length, 1);
    assert.equal(result.directImpacts[0]!.node.id, "n2");
    assert.equal(result.directImpacts[0]!.depth, 1);
    assert.equal(result.directImpacts[0]!.confidence, 0.9);
    assert.equal(result.downstreamImpacts.length, 0);
    assert.equal(result.truncated, false);
    assert.equal(result.maxDepthReached, 1);
  });

  it("2. Multi-hop downstream propagation with depth tracking and confidence decay", () => {
    // S1 -> N1 (depth 1) -> N2 (depth 2) -> N3 (depth 3)
    const s1 = makeNode("s1", "sym:src/db.ts#fn:query:1", "symbol", "query", "src/db.ts");
    const n1 = makeNode("n1", "sym:src/repo.ts#fn:getUser:1", "symbol", "getUser", "src/repo.ts");
    const n2 = makeNode("n2", "sym:src/service.ts#fn:auth:1", "symbol", "auth", "src/service.ts");
    const n3 = makeNode("n3", "sym:src/controller.ts#fn:login:1", "symbol", "login", "src/controller.ts");

    const edges = [
      makeEdge("e1", "s1", "n1"),
      makeEdge("e2", "n1", "n2"),
      makeEdge("e3", "n2", "n3"),
    ];

    const result = computeImpactAnalysis({
      ...dummyContext,
      changedFiles: [makePrFile("src/db.ts")],
      graphNodes: [s1, n1, n2, n3],
      graphEdges: edges,
      maxDepth: 5,
      decayFactor: 0.9,
    });

    assert.equal(result.seedNodes.length, 1);
    assert.equal(result.seedNodes[0]!.id, "s1");
    assert.equal(result.directImpacts.length, 1);
    assert.equal(result.directImpacts[0]!.node.id, "n1");
    assert.equal(result.directImpacts[0]!.depth, 1);
    assert.equal(result.directImpacts[0]!.confidence, 0.9);

    assert.equal(result.downstreamImpacts.length, 2);
    assert.equal(result.downstreamImpacts[0]!.node.id, "n2");
    assert.equal(result.downstreamImpacts[0]!.depth, 2);
    assert.equal(result.downstreamImpacts[0]!.confidence, 0.81);

    assert.equal(result.downstreamImpacts[1]!.node.id, "n3");
    assert.equal(result.downstreamImpacts[1]!.depth, 3);
    assert.equal(result.downstreamImpacts[1]!.confidence, 0.729);

    assert.equal(result.maxDepthReached, 3);
    assert.equal(result.truncated, false);
  });

  it("3. Multiple changed files with independent propagation chains", () => {
    // File 1: S1 -> A1 (depth 1) -> A2 (depth 2)
    // File 2: S2 -> B1 (depth 1)
    const s1 = makeNode("s1", "sym:src/a.ts#s1", "symbol", "s1", "src/a.ts");
    const a1 = makeNode("a1", "sym:src/a1.ts#a1", "symbol", "a1", "src/a1.ts");
    const a2 = makeNode("a2", "sym:src/a2.ts#a2", "symbol", "a2", "src/a2.ts");

    const s2 = makeNode("s2", "sym:src/b.ts#s2", "symbol", "s2", "src/b.ts");
    const b1 = makeNode("b1", "sym:src/b1.ts#b1", "symbol", "b1", "src/b1.ts");

    const edges = [
      makeEdge("e1", "s1", "a1"),
      makeEdge("e2", "a1", "a2"),
      makeEdge("e3", "s2", "b1"),
    ];

    const result = computeImpactAnalysis({
      ...dummyContext,
      changedFiles: [makePrFile("src/a.ts"), makePrFile("src/b.ts")],
      graphNodes: [s1, a1, a2, s2, b1],
      graphEdges: edges,
    });

    assert.equal(result.seedNodes.length, 2);
    assert.deepEqual(
      result.seedNodes.map((n) => n.id).sort(),
      ["s1", "s2"],
    );

    assert.equal(result.directImpacts.length, 2);
    const directIds = result.directImpacts.map((d) => d.node.id).sort();
    assert.deepEqual(directIds, ["a1", "b1"]);

    assert.equal(result.downstreamImpacts.length, 1);
    assert.equal(result.downstreamImpacts[0]!.node.id, "a2");
    assert.equal(result.downstreamImpacts[0]!.depth, 2);
  });

  it("4. Multiple changed symbols resolving to the same downstream node (deduplication & minimum depth)", () => {
    // S1 reaches Target at depth 2 (S1 -> Mid -> Target)
    // S2 reaches Target at depth 1 (S2 -> Target)
    const s1 = makeNode("s1", "sym:src/one.ts#s1", "symbol", "s1", "src/one.ts");
    const mid = makeNode("mid", "sym:src/mid.ts#mid", "symbol", "mid", "src/mid.ts");
    const s2 = makeNode("s2", "sym:src/two.ts#s2", "symbol", "s2", "src/two.ts");
    const target = makeNode("tgt", "sym:src/target.ts#target", "symbol", "target", "src/target.ts");

    const edges = [
      makeEdge("e1", "s1", "mid"),
      makeEdge("e2", "mid", "tgt"),
      makeEdge("e3", "s2", "tgt"),
    ];

    const result = computeImpactAnalysis({
      ...dummyContext,
      changedFiles: [makePrFile("src/one.ts"), makePrFile("src/two.ts")],
      graphNodes: [s1, mid, s2, target],
      graphEdges: edges,
    });

    // Target should only appear once in directImpacts because the shallower path (from S2, depth 1) wins!
    const targetFindings = [...result.directImpacts, ...result.downstreamImpacts].filter(
      (f) => f.node.id === "tgt",
    );
    assert.equal(targetFindings.length, 1);
    assert.equal(targetFindings[0]!.depth, 1);
    assert.equal(targetFindings[0]!.confidence, 0.9);
  });

  it("5. Cyclic graph traversal terminates correctly without infinite loop", () => {
    // S -> C1 -> C2 -> C3 -> C1 (cycle)
    const s = makeNode("s", "sym:src/s.ts#s", "symbol", "s", "src/s.ts");
    const c1 = makeNode("c1", "sym:src/c1.ts#c1", "symbol", "c1", "src/c1.ts");
    const c2 = makeNode("c2", "sym:src/c2.ts#c2", "symbol", "c2", "src/c2.ts");
    const c3 = makeNode("c3", "sym:src/c3.ts#c3", "symbol", "c3", "src/c3.ts");

    const edges = [
      makeEdge("e1", "s", "c1"),
      makeEdge("e2", "c1", "c2"),
      makeEdge("e3", "c2", "c3"),
      makeEdge("e4", "c3", "c1"), // cycle back to c1
    ];

    const result = computeImpactAnalysis({
      ...dummyContext,
      changedFiles: [makePrFile("src/s.ts")],
      graphNodes: [s, c1, c2, c3],
      graphEdges: edges,
      maxDepth: 10,
    });

    const affectedIds = [...result.directImpacts, ...result.downstreamImpacts].map(
      (f) => f.node.id,
    );
    assert.deepEqual(affectedIds.sort(), ["c1", "c2", "c3"]);
    assert.equal(result.maxDepthReached, 3);
    assert.equal(result.truncated, false);
  });

  it("6. Maximum depth is enforced strictly", () => {
    // Chain: S -> N1 -> N2 -> N3 -> N4 -> N5
    const s = makeNode("s", "sym:0", "symbol", "s", "src/s.ts");
    const n1 = makeNode("n1", "sym:1", "symbol", "n1", "src/1.ts");
    const n2 = makeNode("n2", "sym:2", "symbol", "n2", "src/2.ts");
    const n3 = makeNode("n3", "sym:3", "symbol", "n3", "src/3.ts");
    const n4 = makeNode("n4", "sym:4", "symbol", "n4", "src/4.ts");
    const n5 = makeNode("n5", "sym:5", "symbol", "n5", "src/5.ts");

    const edges = [
      makeEdge("e1", "s", "n1"),
      makeEdge("e2", "n1", "n2"),
      makeEdge("e3", "n2", "n3"),
      makeEdge("e4", "n3", "n4"),
      makeEdge("e5", "n4", "n5"),
    ];

    const result = computeImpactAnalysis({
      ...dummyContext,
      changedFiles: [makePrFile("src/s.ts")],
      graphNodes: [s, n1, n2, n3, n4, n5],
      graphEdges: edges,
      maxDepth: 3,
    });

    const affectedIds = [...result.directImpacts, ...result.downstreamImpacts].map(
      (f) => f.node.id,
    );
    assert.deepEqual(affectedIds, ["n1", "n2", "n3"]);
    assert.ok(!affectedIds.includes("n4"));
    assert.ok(!affectedIds.includes("n5"));
    assert.equal(result.maxDepthReached, 3);
  });

  it("7. Truncation is explicitly reported when downstream nodes exist beyond maxDepth", () => {
    const s = makeNode("s", "sym:0", "symbol", "s", "src/s.ts");
    const n1 = makeNode("n1", "sym:1", "symbol", "n1", "src/1.ts");
    const n2 = makeNode("n2", "sym:2", "symbol", "n2", "src/2.ts");
    const n3 = makeNode("n3", "sym:3", "symbol", "n3", "src/3.ts");

    const edges = [
      makeEdge("e1", "s", "n1"),
      makeEdge("e2", "n1", "n2"),
      makeEdge("e3", "n2", "n3"),
    ];

    const result = computeImpactAnalysis({
      ...dummyContext,
      changedFiles: [makePrFile("src/s.ts")],
      graphNodes: [s, n1, n2, n3],
      graphEdges: edges,
      maxDepth: 2,
    });

    assert.equal(result.truncated, true);
    assert.ok(result.truncationReason?.includes("maximum depth limit of 2"));
  });

  it("8. Truncation is false when all downstream paths terminate within maxDepth", () => {
    const s = makeNode("s", "sym:0", "symbol", "s", "src/s.ts");
    const n1 = makeNode("n1", "sym:1", "symbol", "n1", "src/1.ts");

    const edges = [makeEdge("e1", "s", "n1")];

    const result = computeImpactAnalysis({
      ...dummyContext,
      changedFiles: [makePrFile("src/s.ts")],
      graphNodes: [s, n1],
      graphEdges: edges,
      maxDepth: 5,
    });

    assert.equal(result.truncated, false);
    assert.equal(result.truncationReason, null);
  });

  it("9. API classification (nodeType = 'api')", () => {
    const s = makeNode("s", "sym:src/s.ts#s", "symbol", "s", "src/s.ts");
    const apiRoute = makeNode(
      "api-1",
      "route:POST:/api/checkout",
      "api",
      "POST /api/checkout",
      "src/routes/checkout.ts",
      { routePath: "/api/checkout", httpMethods: ["POST"] },
    );

    const edges = [makeEdge("e1", "s", "api-1", "EXPOSES_ROUTE")];

    const result = computeImpactAnalysis({
      ...dummyContext,
      changedFiles: [makePrFile("src/s.ts")],
      graphNodes: [s, apiRoute],
      graphEdges: edges,
    });

    assert.equal(result.affectedApis.length, 1);
    assert.equal(result.affectedApis[0]!.node.id, "api-1");
    assert.ok(result.workflowImpactSummary.some((w) => w.includes("/api/checkout")));
  });

  it("10. Event classification (nodeType = 'event')", () => {
    const s = makeNode("s", "sym:src/s.ts#s", "symbol", "s", "src/s.ts");
    const eventNode = makeNode(
      "ev-1",
      "event:producer:kafka:OrderPlaced",
      "event",
      "OrderPlaced",
      "src/events.ts",
      { eventName: "OrderPlaced", family: "kafka" },
    );

    const edges = [makeEdge("e1", "s", "ev-1", "EMITS_EVENT")];

    const result = computeImpactAnalysis({
      ...dummyContext,
      changedFiles: [makePrFile("src/s.ts")],
      graphNodes: [s, eventNode],
      graphEdges: edges,
    });

    assert.equal(result.affectedEvents.length, 1);
    assert.equal(result.affectedEvents[0]!.node.id, "ev-1");
    assert.ok(result.workflowImpactSummary.some((w) => w.includes("OrderPlaced")));
  });

  it("11. Service/workflow classification (nodeType = 'service' or 'application')", () => {
    const s = makeNode("s", "sym:src/s.ts#s", "symbol", "s", "src/s.ts");
    const svcNode = makeNode("svc-1", "service:payment-service", "service", "payment-service", "services/payment");

    const edges = [makeEdge("e1", "s", "svc-1", "CALLS")];

    const result = computeImpactAnalysis({
      ...dummyContext,
      changedFiles: [makePrFile("src/s.ts")],
      graphNodes: [s, svcNode],
      graphEdges: edges,
    });

    assert.equal(result.affectedServices.length, 1);
    assert.equal(result.affectedServices[0]!.node.id, "svc-1");
    assert.ok(result.workflowImpactSummary.some((w) => w.includes("payment-service")));
  });

  it("12. Deterministic ordering: result ordering is stable regardless of input order", () => {
    const s = makeNode("s", "sym:src/s.ts#s", "symbol", "s", "src/s.ts");
    const b = makeNode("b", "sym:src/b.ts#b", "symbol", "b", "src/b.ts");
    const a = makeNode("a", "sym:src/a.ts#a", "symbol", "a", "src/a.ts");
    const c = makeNode("c", "sym:src/c.ts#c", "symbol", "c", "src/c.ts");

    const edges = [
      makeEdge("e1", "s", "b"),
      makeEdge("e2", "s", "a"),
      makeEdge("e3", "s", "c"),
    ];

    // Run 1: Original order
    const r1 = computeImpactAnalysis({
      ...dummyContext,
      changedFiles: [makePrFile("src/s.ts")],
      graphNodes: [s, b, a, c],
      graphEdges: edges,
    });

    // Run 2: Shuffled nodes and edges
    const r2 = computeImpactAnalysis({
      ...dummyContext,
      changedFiles: [makePrFile("src/s.ts")],
      graphNodes: [c, a, s, b],
      graphEdges: [edges[2]!, edges[0]!, edges[1]!],
    });

    assert.deepEqual(
      r1.directImpacts.map((d) => d.node.id),
      r2.directImpacts.map((d) => d.node.id),
    );
    // Should be sorted alphabetically by canonicalId
    assert.deepEqual(
      r1.directImpacts.map((d) => d.node.canonicalId),
      ["sym:src/a.ts#a", "sym:src/b.ts#b", "sym:src/c.ts#c"],
    );
  });

  it("13. Deterministic confidence decay (deeper paths never increase confidence)", () => {
    const s = makeNode("s", "sym:0", "symbol", "s", "src/s.ts");
    const n1 = makeNode("n1", "sym:1", "symbol", "n1", "src/1.ts", {}, 1.0);
    const n2 = makeNode("n2", "sym:2", "symbol", "n2", "src/2.ts", {}, 1.0);
    const n3 = makeNode("n3", "sym:3", "symbol", "n3", "src/3.ts", {}, 1.0);

    const edges = [
      makeEdge("e1", "s", "n1"),
      makeEdge("e2", "n1", "n2"),
      makeEdge("e3", "n2", "n3"),
    ];

    const result = computeImpactAnalysis({
      ...dummyContext,
      changedFiles: [makePrFile("src/s.ts")],
      graphNodes: [s, n1, n2, n3],
      graphEdges: edges,
      decayFactor: 0.8,
    });

    const c1 = result.directImpacts.find((f) => f.node.id === "n1")!.confidence;
    const c2 = result.downstreamImpacts.find((f) => f.node.id === "n2")!.confidence;
    const c3 = result.downstreamImpacts.find((f) => f.node.id === "n3")!.confidence;

    assert.equal(c1, 0.8);
    assert.equal(c2, 0.64);
    assert.equal(c3, 0.512);
    assert.ok(c1 > c2 && c2 > c3, "Confidence strictly decreases with depth");
  });

  it("14. Unresolved changed file handling", () => {
    const s = makeNode("s", "sym:src/index.ts#main", "symbol", "main", "src/index.ts");
    const result = computeImpactAnalysis({
      ...dummyContext,
      changedFiles: [
        makePrFile("src/index.ts"),
        makePrFile("README.md"),
        makePrFile("docs/architecture.png"),
      ],
      graphNodes: [s],
      graphEdges: [],
    });

    assert.equal(result.seedNodes.length, 1);
    assert.equal(result.seedNodes[0]!.id, "s");
    assert.equal(result.unresolvedFiles.length, 2);
    assert.deepEqual(
      result.unresolvedFiles.map((u) => u.path),
      ["docs/architecture.png", "README.md"],
    );
  });

  it("15. Empty changed-file input returns clean empty result without errors", () => {
    const s = makeNode("s", "sym:src/s.ts#s", "symbol", "s", "src/s.ts");
    const result = computeImpactAnalysis({
      ...dummyContext,
      changedFiles: [],
      graphNodes: [s],
      graphEdges: [],
    });

    assert.equal(result.seedNodes.length, 0);
    assert.equal(result.directImpacts.length, 0);
    assert.equal(result.downstreamImpacts.length, 0);
    assert.equal(result.unresolvedFiles.length, 0);
    assert.equal(result.truncated, false);
    assert.equal(result.maxDepthReached, 0);
    assert.equal(result.executionMetrics.totalAffectedNodes, 0);
  });

  it("16. Patch modified line parsing & selective symbol matching", () => {
    const patch = `
@@ -10,4 +10,6 @@
 function login() {
-  return false;
+  const token = generate();
+  return token;
 }
`;
    const { oldLines, newLines } = parsePatchModifiedLines(patch);
    assert.deepEqual(oldLines, [11]);
    assert.deepEqual(newLines, [11, 12]);

    const symLogin = makeNode("login", "sym:src/auth.ts#fn:login:10", "symbol", "login", "src/auth.ts", { lineStart: 10, lineEnd: 20 });
    const symLogout = makeNode("logout", "sym:src/auth.ts#fn:logout:40", "symbol", "logout", "src/auth.ts", { lineStart: 40, lineEnd: 50 });

    const file = makePrFile("src/auth.ts", patch);
    const { seedNodes } = resolveFilesToSeeds([file], [symLogin, symLogout]);

    assert.equal(seedNodes.length, 1);
    assert.equal(seedNodes[0]!.id, "login");
  });

  it("17. Input validation: invalid maxDepth and decayFactor throw ImpactAnalysisValidationError", () => {
    assert.throws(
      () =>
        computeImpactAnalysis({
          ...dummyContext,
          changedFiles: [],
          graphNodes: [],
          graphEdges: [],
          maxDepth: 25, // > HARD_MAX_IMPACT_DEPTH (20)
        }),
      ImpactAnalysisValidationError,
    );

    assert.throws(
      () =>
        computeImpactAnalysis({
          ...dummyContext,
          changedFiles: [],
          graphNodes: [],
          graphEdges: [],
          decayFactor: 1.5, // > 1
        }),
      ImpactAnalysisValidationError,
    );
  });
});

// ===========================================================================
// Part 2: Database-Backed Integration Tests (Step 43 End-to-End)
// ===========================================================================

describe.skipIf(!hasDatabase)("Step 43: Impact Analysis Engine - PostgreSQL Database Integration", () => {
  let pool: pg.Pool;
  const suffix = Math.random().toString(36).substring(2, 8);

  let orgA: { id: string };
  let orgB: { id: string };
  let repoA: { id: string };
  let runA1: { id: string };
  let runA2: { id: string };
  let pr1: { id: string };
  let pr2: { id: string };

  let nodeService: GraphNode;
  let nodeModule: GraphNode;
  let nodeSymbol: GraphNode;
  let nodeApi: GraphNode;
  let nodeEvent: GraphNode;

  beforeAll(async () => {
    pool = getPool();
    await ensureRlsTestRole(pool);

    // Setup Org A
    orgA = await createOrganization(pool, { name: `impact-test-org-a-${suffix}` });
    repoA = await createRepository(pool, {
      organizationId: orgA.id,
      githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 1000}`,
      name: `impact-repo-a-${suffix}`,
      defaultBranch: "main",
    });

    const snapshotA = await createRepositorySnapshot(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      commitSha: "a".repeat(40),
      ref: "refs/heads/main",
      storageUri: "s3://snapshots/impact-a",
      sha256: "a".repeat(64),
      fileCount: 5,
      sizeBytes: "1024",
    });

    runA1 = await createAnalysisRun(pool, {
      organizationId: orgA.id,
      snapshotId: snapshotA.id,
      status: "completed",
    });

    runA2 = await createAnalysisRun(pool, {
      organizationId: orgA.id,
      snapshotId: snapshotA.id,
      status: "completed",
    });

    // Setup Org B for tenant isolation test
    orgB = await createOrganization(pool, { name: `impact-test-org-b-${suffix}` });

    // Seed Graph Nodes in Run A1
    // Chain: nodeModule (changed file) -> nodeSymbol -> nodeApi -> nodeEvent -> nodeService
    nodeModule = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA1.id,
      canonicalId: "mod:src/payment.ts",
      nodeType: "module",
      name: "src/payment.ts",
      path: "src/payment.ts",
    });

    nodeSymbol = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA1.id,
      canonicalId: "sym:src/payment.ts#fn:charge:10",
      nodeType: "symbol",
      name: "charge",
      path: "src/payment.ts",
      metadata: { lineStart: 10, lineEnd: 25 },
    });

    nodeApi = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA1.id,
      canonicalId: "route:POST:/api/checkout",
      nodeType: "api",
      name: "POST /api/checkout",
      path: "src/routes/checkout.ts",
      metadata: { routePath: "/api/checkout" },
    });

    nodeEvent = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA1.id,
      canonicalId: "event:OrderPaid",
      nodeType: "event",
      name: "OrderPaid",
      path: "src/events.ts",
    });

    nodeService = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA1.id,
      canonicalId: "service:accounting-service",
      nodeType: "service",
      name: "accounting-service",
      path: "services/accounting",
    });

    // Seed Edges in Run A1
    await createGraphEdge(pool, {
      organizationId: orgA.id,
      analysisRunId: runA1.id,
      sourceNodeId: nodeModule.id,
      targetNodeId: nodeSymbol.id,
      edgeType: "RESOLVES_TO",
    });

    await createGraphEdge(pool, {
      organizationId: orgA.id,
      analysisRunId: runA1.id,
      sourceNodeId: nodeSymbol.id,
      targetNodeId: nodeApi.id,
      edgeType: "CALLS",
    });

    await createGraphEdge(pool, {
      organizationId: orgA.id,
      analysisRunId: runA1.id,
      sourceNodeId: nodeApi.id,
      targetNodeId: nodeEvent.id,
      edgeType: "EMITS_EVENT",
    });

    await createGraphEdge(pool, {
      organizationId: orgA.id,
      analysisRunId: runA1.id,
      sourceNodeId: nodeEvent.id,
      targetNodeId: nodeService.id,
      edgeType: "CALLS",
    });

    // Seed PR 1 with changed file src/payment.ts
    const patch = `
@@ -10,3 +10,4 @@
 function charge() {
+  validateCreditCard();
 }
`;
    const savedPr1 = await savePullRequestWithFiles(pool, {
      pr: {
        organizationId: orgA.id,
        repositoryId: repoA.id,
        githubPrId: `${Math.floor(Math.random() * 1_000_000) + 100}`,
        number: 101,
        title: "Update payment charge logic",
        url: "https://github.com/fluxora/repo/pull/101",
        baseRef: "main",
        baseSha: "1".repeat(40),
        headRef: "feature-charge",
        headSha: "2".repeat(40),
      },
      files: [
        {
          path: "src/payment.ts",
          status: "modified",
          patch,
        },
      ],
    });
    pr1 = savedPr1.pullRequest;

    // Seed PR 2 with empty changed files
    const savedPr2 = await savePullRequestWithFiles(pool, {
      pr: {
        organizationId: orgA.id,
        repositoryId: repoA.id,
        githubPrId: `${Math.floor(Math.random() * 1_000_000) + 200}`,
        number: 102,
        title: "Empty change PR",
        url: "https://github.com/fluxora/repo/pull/102",
        baseRef: "main",
        baseSha: "1".repeat(40),
        headRef: "feature-empty",
        headSha: "3".repeat(40),
      },
      files: [],
    });
    pr2 = savedPr2.pullRequest;
  });

  afterAll(async () => {
    delete process.env.FLUXORA_DATABASE_ROLE;
    if (pool) {
      await pool.query(`DELETE FROM organizations WHERE name LIKE $1`, [`impact-test-org-%-${suffix}`]);
      await closePool();
    }
  });

  it("18. End-to-end database impact analysis: PR changed file resolves to symbol and propagates downstream", async () => {
    const result = await analyzePullRequestImpact(pool, {
      organizationId: orgA.id,
      pullRequestId: pr1.id,
      analysisRunId: runA1.id,
      maxDepth: 5,
    });

    assert.equal(result.pullRequestId, pr1.id);
    assert.equal(result.analysisRunId, runA1.id);
    assert.equal(result.repositoryId, repoA.id);

    // Seed node should be charge symbol
    assert.equal(result.seedNodes.length, 1);
    assert.equal(result.seedNodes[0]!.id, nodeSymbol.id);

    // Direct impact (depth = 1): nodeApi
    assert.equal(result.directImpacts.length, 1);
    assert.equal(result.directImpacts[0]!.node.id, nodeApi.id);
    assert.equal(result.directImpacts[0]!.depth, 1);

    // Downstream impacts (depth >= 2): nodeEvent (2), nodeService (3)
    assert.equal(result.downstreamImpacts.length, 2);
    assert.equal(result.downstreamImpacts[0]!.node.id, nodeEvent.id);
    assert.equal(result.downstreamImpacts[0]!.depth, 2);
    assert.equal(result.downstreamImpacts[1]!.node.id, nodeService.id);
    assert.equal(result.downstreamImpacts[1]!.depth, 3);

    // Classification lists
    assert.equal(result.affectedApis.length, 1);
    assert.equal(result.affectedApis[0]!.node.id, nodeApi.id);

    assert.equal(result.affectedEvents.length, 1);
    assert.equal(result.affectedEvents[0]!.node.id, nodeEvent.id);

    assert.equal(result.affectedServices.length, 1);
    assert.equal(result.affectedServices[0]!.node.id, nodeService.id);

    assert.equal(result.truncated, false);
    assert.equal(result.maxDepthReached, 3);
  });

  it("19. Pull request not found throws PullRequestNotFoundError", async () => {
    await assert.rejects(
      () =>
        analyzePullRequestImpact(pool, {
          organizationId: orgA.id,
          pullRequestId: "00000000-0000-0000-0000-999999999999",
        }),
      PullRequestNotFoundError,
    );
  });

  it("20. Analysis snapshot unavailable throws AnalysisSnapshotUnavailableError", async () => {
    await assert.rejects(
      () =>
        analyzePullRequestImpact(pool, {
          organizationId: orgA.id,
          pullRequestId: pr1.id,
          analysisRunId: "00000000-0000-0000-0000-888888888888",
        }),
      AnalysisSnapshotUnavailableError,
    );
  });

  it("21. Tenant isolation: Org B cannot analyze Org A's pull request", async () => {
    await assert.rejects(
      () =>
        analyzePullRequestImpact(pool, {
          organizationId: orgB.id,
          pullRequestId: pr1.id,
        }),
      PullRequestNotFoundError,
    );
  });

  it("22. Analysis-run isolation: empty run A2 returns 0 seeds and 0 impacts", async () => {
    const result = await analyzePullRequestImpact(pool, {
      organizationId: orgA.id,
      pullRequestId: pr1.id,
      analysisRunId: runA2.id, // runA2 has no nodes seeded
    });

    assert.equal(result.seedNodes.length, 0);
    assert.equal(result.directImpacts.length, 0);
    assert.equal(result.downstreamImpacts.length, 0);
    assert.equal(result.unresolvedFiles.length, 1);
    assert.equal(result.unresolvedFiles[0]!.path, "src/payment.ts");
  });

  it("23. Empty pull request files returns clean empty result", async () => {
    const result = await analyzePullRequestImpact(pool, {
      organizationId: orgA.id,
      pullRequestId: pr2.id,
      analysisRunId: runA1.id,
    });

    assert.equal(result.seedNodes.length, 0);
    assert.equal(result.directImpacts.length, 0);
    assert.equal(result.downstreamImpacts.length, 0);
    assert.equal(result.executionMetrics.totalAffectedNodes, 0);
  });
});

