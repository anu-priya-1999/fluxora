import assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll } from "vitest";
import {
  GRAPH_UPDATED_EVENT_TYPE,
  graphUpdatedIdempotencyKey,
  parseGraphUpdatedPayload,
  type CreateEvidenceInput,
  type CreateGraphEdgeInput,
  type CreateGraphNodeInput,
  type GraphUpdatedPayload,
} from "@fluxora/shared-types";
import {
  closePool,
  computeGraphDiff,
  createAnalysisRun,
  createOrganization,
  createRepository,
  createRepositorySnapshot,
  diffAnalysisRuns,
  EvidenceWriter,
  getEventById,
  getPool,
  listEvents,
  persistGraphBuild,
  runMigrations,
} from "../index.ts";

const hasDatabase =
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;


describe("Global Step 32: Graph Diff & Graph Updated Events", () => {
  it("1. empty diff: identical before and after states produce zero changes", () => {
    const state = {
      nodes: [
        {
          canonicalId: "mod:src/index.ts",
          nodeType: "module",
          name: "src/index.ts",
          path: "src/index.ts",
          confidence: 1.0,
          metadata: { path: "src/index.ts" },
        },
      ],
      edges: [
        {
          canonicalId: "edge:1",
          sourceCanonicalId: "mod:src/index.ts",
          targetCanonicalId: "mod:src/index.ts",
          edgeType: "IMPORTS",
          confidence: 1.0,
          provenance: "static-analysis",
          metadata: {},
        },
      ],
    };

    const diff = computeGraphDiff(state, state);

    assert.equal(diff.addedNodes.length, 0);
    assert.equal(diff.removedNodes.length, 0);
    assert.equal(diff.changedNodes.length, 0);
    assert.equal(diff.addedEdges.length, 0);
    assert.equal(diff.removedEdges.length, 0);
    assert.equal(diff.changedEdges.length, 0);

    assert.equal(diff.summary.nodesAdded, 0);
    assert.equal(diff.summary.nodesRemoved, 0);
    assert.equal(diff.summary.nodesChanged, 0);
    assert.equal(diff.summary.nodesUnchanged, 1);
    assert.equal(diff.summary.edgesAdded, 0);
    assert.equal(diff.summary.edgesRemoved, 0);
    assert.equal(diff.summary.edgesChanged, 0);
    assert.equal(diff.summary.edgesUnchanged, 1);
    assert.equal(diff.summary.node_delta, 0);
    assert.equal(diff.summary.edge_delta, 0);
    assert.equal(diff.summary.totalNodesBefore, 1);
    assert.equal(diff.summary.totalNodesAfter, 1);
  });

  it("2. added node: nodes in current but not in previous are classified as added", () => {
    const prev = { nodes: [], edges: [] };
    const curr = {
      nodes: [
        {
          canonicalId: "sym:src/app.ts#function:auth",
          nodeType: "symbol",
          name: "auth",
          path: "src/app.ts",
        },
      ],
      edges: [],
    };

    const diff = computeGraphDiff(prev, curr);

    assert.equal(diff.addedNodes.length, 1);
    assert.equal(diff.addedNodes[0]?.canonicalId, "sym:src/app.ts#function:auth");
    assert.equal(diff.addedNodes[0]?.changeType, "added");
    assert.equal(diff.removedNodes.length, 0);
    assert.equal(diff.changedNodes.length, 0);
    assert.equal(diff.summary.nodesAdded, 1);
    assert.equal(diff.summary.node_delta, 1);
    assert.equal(diff.summary.totalNodesBefore, 0);
    assert.equal(diff.summary.totalNodesAfter, 1);
  });

  it("3. removed node: nodes in previous but missing in current are classified as removed", () => {
    const prev = {
      nodes: [
        {
          canonicalId: "mod:src/deprecated.ts",
          nodeType: "module",
          name: "src/deprecated.ts",
        },
      ],
      edges: [],
    };
    const curr = { nodes: [], edges: [] };

    const diff = computeGraphDiff(prev, curr);

    assert.equal(diff.removedNodes.length, 1);
    assert.equal(diff.removedNodes[0]?.canonicalId, "mod:src/deprecated.ts");
    assert.equal(diff.removedNodes[0]?.changeType, "removed");
    assert.equal(diff.addedNodes.length, 0);
    assert.equal(diff.changedNodes.length, 0);
    assert.equal(diff.summary.nodesRemoved, 1);
    assert.equal(diff.summary.node_delta, -1);
  });

  it("4. changed node: mutated name, confidence, or metadata detected with field provenance", () => {
    const prev = {
      nodes: [
        {
          canonicalId: "sym:src/app.ts#function:handler",
          nodeType: "symbol",
          name: "oldHandler",
          confidence: 0.8,
          metadata: { version: 1 },
        },
      ],
      edges: [],
    };
    const curr = {
      nodes: [
        {
          canonicalId: "sym:src/app.ts#function:handler",
          nodeType: "symbol",
          name: "newHandler",
          confidence: 1.0,
          metadata: { version: 2 },
        },
      ],
      edges: [],
    };

    const diff = computeGraphDiff(prev, curr);

    assert.equal(diff.changedNodes.length, 1);
    const changed = diff.changedNodes[0]!;
    assert.equal(changed.canonicalId, "sym:src/app.ts#function:handler");
    assert.equal(changed.changeType, "changed");
    assert.deepEqual(changed.changedFields, ["confidence", "metadata", "name"]);
    assert.equal(diff.summary.nodesChanged, 1);
    assert.equal(diff.summary.nodesUnchanged, 0);
  });

  it("5. added edge: new edges between nodes are classified as added", () => {
    const prev = {
      nodes: [
        { canonicalId: "mod:A", nodeType: "module", name: "A" },
        { canonicalId: "mod:B", nodeType: "module", name: "B" },
      ],
      edges: [],
    };
    const curr = {
      nodes: [
        { canonicalId: "mod:A", nodeType: "module", name: "A" },
        { canonicalId: "mod:B", nodeType: "module", name: "B" },
      ],
      edges: [
        {
          canonicalId: "edge:A->B",
          sourceCanonicalId: "mod:A",
          targetCanonicalId: "mod:B",
          edgeType: "IMPORTS",
        },
      ],
    };

    const diff = computeGraphDiff(prev, curr);

    assert.equal(diff.addedEdges.length, 1);
    assert.equal(diff.addedEdges[0]?.sourceCanonicalId, "mod:A");
    assert.equal(diff.addedEdges[0]?.targetCanonicalId, "mod:B");
    assert.equal(diff.addedEdges[0]?.edgeType, "IMPORTS");
    assert.equal(diff.addedEdges[0]?.changeType, "added");
    assert.equal(diff.summary.edgesAdded, 1);
    assert.equal(diff.summary.edge_delta, 1);
  });

  it("6. removed edge: deleted edge relationships classified as removed", () => {
    const prev = {
      nodes: [
        { canonicalId: "mod:A", nodeType: "module", name: "A" },
        { canonicalId: "mod:B", nodeType: "module", name: "B" },
      ],
      edges: [
        {
          canonicalId: "edge:A->B",
          sourceCanonicalId: "mod:A",
          targetCanonicalId: "mod:B",
          edgeType: "IMPORTS",
        },
      ],
    };
    const curr = {
      nodes: [
        { canonicalId: "mod:A", nodeType: "module", name: "A" },
        { canonicalId: "mod:B", nodeType: "module", name: "B" },
      ],
      edges: [],
    };

    const diff = computeGraphDiff(prev, curr);

    assert.equal(diff.removedEdges.length, 1);
    assert.equal(diff.removedEdges[0]?.sourceCanonicalId, "mod:A");
    assert.equal(diff.removedEdges[0]?.targetCanonicalId, "mod:B");
    assert.equal(diff.removedEdges[0]?.changeType, "removed");
    assert.equal(diff.summary.edgesRemoved, 1);
    assert.equal(diff.summary.edge_delta, -1);
  });

  it("7. changed edge: confidence or metadata changes classified with field list", () => {
    const prev = {
      nodes: [
        { canonicalId: "mod:A", nodeType: "module", name: "A" },
        { canonicalId: "mod:B", nodeType: "module", name: "B" },
      ],
      edges: [
        {
          sourceCanonicalId: "mod:A",
          targetCanonicalId: "mod:B",
          edgeType: "CALLS",
          confidence: 0.5,
          provenance: "inferred",
        },
      ],
    };
    const curr = {
      nodes: [
        { canonicalId: "mod:A", nodeType: "module", name: "A" },
        { canonicalId: "mod:B", nodeType: "module", name: "B" },
      ],
      edges: [
        {
          sourceCanonicalId: "mod:A",
          targetCanonicalId: "mod:B",
          edgeType: "CALLS",
          confidence: 1.0,
          provenance: "static-analysis",
        },
      ],
    };

    const diff = computeGraphDiff(prev, curr);

    assert.equal(diff.changedEdges.length, 1);
    const ce = diff.changedEdges[0]!;
    assert.equal(ce.changeType, "changed");
    assert.deepEqual(ce.changedFields, ["confidence", "provenance"]);
    assert.equal(diff.summary.edgesChanged, 1);
    assert.equal(diff.summary.edgesUnchanged, 0);
  });

  it("8. combined node + edge changes: handles multi-entity mutations accurately", () => {
    const prev = {
      nodes: [
        { canonicalId: "n1", nodeType: "module", name: "mod1" },
        { canonicalId: "n2", nodeType: "symbol", name: "sym1", confidence: 0.9 },
        { canonicalId: "n3", nodeType: "api", name: "route1" },
      ],
      edges: [
        { sourceCanonicalId: "n1", targetCanonicalId: "n2", edgeType: "IMPORTS" },
        { sourceCanonicalId: "n2", targetCanonicalId: "n3", edgeType: "RESOLVES_TO" },
      ],
    };
    const curr = {
      nodes: [
        { canonicalId: "n1", nodeType: "module", name: "mod1" }, // unchanged
        { canonicalId: "n2", nodeType: "symbol", name: "sym1", confidence: 1.0 }, // changed
        { canonicalId: "n4", nodeType: "database", name: "db1" }, // added (n3 removed)
      ],
      edges: [
        { sourceCanonicalId: "n1", targetCanonicalId: "n2", edgeType: "IMPORTS" }, // unchanged
        { sourceCanonicalId: "n1", targetCanonicalId: "n4", edgeType: "QUERIES_DB" }, // added (n2->n3 removed)
      ],
    };

    const diff = computeGraphDiff(prev, curr);

    assert.equal(diff.summary.nodesAdded, 1);
    assert.equal(diff.summary.nodesRemoved, 1);
    assert.equal(diff.summary.nodesChanged, 1);
    assert.equal(diff.summary.nodesUnchanged, 1);

    assert.equal(diff.summary.edgesAdded, 1);
    assert.equal(diff.summary.edgesRemoved, 1);
    assert.equal(diff.summary.edgesChanged, 0);
    assert.equal(diff.summary.edgesUnchanged, 1);

    assert.equal(diff.addedNodes[0]?.canonicalId, "n4");
    assert.equal(diff.removedNodes[0]?.canonicalId, "n3");
    assert.equal(diff.changedNodes[0]?.canonicalId, "n2");

    assert.equal(diff.addedEdges[0]?.edgeType, "QUERIES_DB");
    assert.equal(diff.removedEdges[0]?.edgeType, "RESOLVES_TO");
  });

  it("9. deterministic ordering: output order is independent of input object order", () => {
    const prev = { nodes: [], edges: [] };
    const currA = {
      nodes: [
        { canonicalId: "z_node", nodeType: "module", name: "Z" },
        { canonicalId: "a_node", nodeType: "module", name: "A" },
        { canonicalId: "m_node", nodeType: "module", name: "M" },
      ],
      edges: [
        { sourceCanonicalId: "z_node", targetCanonicalId: "m_node", edgeType: "IMPORTS" },
        { sourceCanonicalId: "a_node", targetCanonicalId: "z_node", edgeType: "IMPORTS" },
      ],
    };
    const currB = {
      nodes: [
        { canonicalId: "a_node", nodeType: "module", name: "A" },
        { canonicalId: "m_node", nodeType: "module", name: "M" },
        { canonicalId: "z_node", nodeType: "module", name: "Z" },
      ],
      edges: [
        { sourceCanonicalId: "a_node", targetCanonicalId: "z_node", edgeType: "IMPORTS" },
        { sourceCanonicalId: "z_node", targetCanonicalId: "m_node", edgeType: "IMPORTS" },
      ],
    };

    const diffA = computeGraphDiff(prev, currA);
    const diffB = computeGraphDiff(prev, currB);

    assert.deepEqual(diffA, diffB);
    assert.equal(diffA.addedNodes[0]?.canonicalId, "a_node");
    assert.equal(diffA.addedNodes[1]?.canonicalId, "m_node");
    assert.equal(diffA.addedNodes[2]?.canonicalId, "z_node");
  });

  it("10. deterministic repeated diff: repeated execution produces identical results", () => {
    const prev = {
      nodes: [{ canonicalId: "n1", nodeType: "module", name: "A" }],
      edges: [],
    };
    const curr = {
      nodes: [
        { canonicalId: "n1", nodeType: "module", name: "A" },
        { canonicalId: "n2", nodeType: "module", name: "B" },
      ],
      edges: [{ sourceCanonicalId: "n1", targetCanonicalId: "n2", edgeType: "IMPORTS" }],
    };

    const run1 = computeGraphDiff(prev, curr);
    const run2 = computeGraphDiff(prev, curr);

    assert.deepEqual(run1, run2);
  });

  it("11. deterministic event payload: parseGraphUpdatedPayload parses valid payload safely", () => {
    const orgId = "11111111-1111-4111-8111-111111111111";
    const runId = "22222222-2222-4222-8222-222222222222";
    const prevRunId = "33333333-3333-4333-8333-333333333333";
    const key = graphUpdatedIdempotencyKey(runId, prevRunId);
    assert.equal(
      key,
      `${GRAPH_UPDATED_EVENT_TYPE}:${runId}:${prevRunId}`,
    );

    const diff = computeGraphDiff(
      { nodes: [], edges: [] },
      {
        nodes: [{ canonicalId: "mod:test", nodeType: "module", name: "test" }],
        edges: [],
      },
    );

    const rawPayload = {
      organizationId: orgId,
      analysisRunId: runId,
      previousAnalysisRunId: prevRunId,
      summary: diff.summary,
      diff,
    };

    const parsed = parseGraphUpdatedPayload(rawPayload);
    assert.ok(parsed !== null);
    assert.equal(parsed.organization_id, orgId);
    assert.equal(parsed.analysis_run_id, runId);
    assert.equal(parsed.previous_analysis_run_id, prevRunId);
    assert.equal(parsed.summary.nodes_added, 1);
    assert.equal(parsed.diff.addedNodes.length, 1);

    // Invalid payload checks
    assert.equal(parseGraphUpdatedPayload(null), null);
    assert.equal(parseGraphUpdatedPayload("not an object"), null);
    assert.equal(parseGraphUpdatedPayload({ organizationId: "not-uuid" }), null);
  });

  it("17. event never exposes raw unrelated DB fields or secret credentials", () => {
    const diff = computeGraphDiff(
      { nodes: [], edges: [] },
      {
        nodes: [{ canonicalId: "mod:secret", nodeType: "module", name: "secret" }],
        edges: [],
      },
    );

    const payload: GraphUpdatedPayload = {
      organizationId: "11111111-1111-4111-8111-111111111111",
      organization_id: "11111111-1111-4111-8111-111111111111",
      analysisRunId: "22222222-2222-4222-8222-222222222222",
      analysis_run_id: "22222222-2222-4222-8222-222222222222",
      summary: diff.summary,
      diff,
    };

    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes("password"));
    assert.ok(!serialized.includes("token"));
    assert.ok(!serialized.includes("secret_key"));
    assert.ok(!serialized.includes("postgres"));
  });

  // Database Integration & RLS Tests
  describe.skipIf(!hasDatabase)("Database Integration & RLS Tests", () => {
    let pool: ReturnType<typeof getPool>;
    let orgA: Awaited<ReturnType<typeof createOrganization>>;
    let orgB: Awaited<ReturnType<typeof createOrganization>>;
    let repoA: Awaited<ReturnType<typeof createRepository>>;
    let snap1: Awaited<ReturnType<typeof createRepositorySnapshot>>;
    let snap2: Awaited<ReturnType<typeof createRepositorySnapshot>>;
    let run1: Awaited<ReturnType<typeof createAnalysisRun>>;
    let run2: Awaited<ReturnType<typeof createAnalysisRun>>;

    beforeAll(async () => {
      pool = getPool();
      await runMigrations(pool);

      orgA = await createOrganization(pool, { name: `org-diff-a-${Date.now()}` });
      orgB = await createOrganization(pool, { name: `org-diff-b-${Date.now()}` });

      repoA = await createRepository(pool, {
        organizationId: orgA.id,
        githubRepoId: String(Math.floor(10000000 + Math.random() * 80000000)),
        name: "diff-repo",
        defaultBranch: "main",
      });

      snap1 = await createRepositorySnapshot(pool, {
        organizationId: orgA.id,
        repositoryId: repoA.id,
        commitSha: "1111111111111111111111111111111111111111",
        ref: "refs/heads/main",
        fileCount: 2,
        sizeBytes: "1000",
        storageUri: "s3://snapshots/1",
        sha256: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      });

      snap2 = await createRepositorySnapshot(pool, {
        organizationId: orgA.id,
        repositoryId: repoA.id,
        commitSha: "2222222222222222222222222222222222222222",
        ref: "refs/heads/main",
        fileCount: 3,
        sizeBytes: "1500",
        storageUri: "s3://snapshots/2",
        sha256: "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
      });

      run1 = await createAnalysisRun(pool, {
        organizationId: orgA.id,
        snapshotId: snap1.id,
        status: "completed",
      });

      run2 = await createAnalysisRun(pool, {
        organizationId: orgA.id,
        snapshotId: snap2.id,
        status: "running",
      });
    });

    afterAll(async () => {
      if (pool) {
        await closePool();
      }
    });

    it("12 & 16. persistGraphBuild computes diff and emits graph.updated event atomically", async () => {
      const seed = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
      // Run 1: initial graph build
      const n1Id = EvidenceWriter.generateDeterministicUuid(`${seed}:node:1`);
      const n2Id = EvidenceWriter.generateDeterministicUuid(`${seed}:node:2`);
      const edgeId1 = EvidenceWriter.generateDeterministicUuid(`${seed}:edge:1`);
      const nodeA1: CreateGraphNodeInput = {
        id: n1Id,
        organizationId: orgA.id,
        analysisRunId: run1.id,
        canonicalId: "mod:src/a.ts",
        nodeType: "module",
        name: "src/a.ts",
      };
      const nodeB1: CreateGraphNodeInput = {
        id: n2Id,
        organizationId: orgA.id,
        analysisRunId: run1.id,
        canonicalId: "mod:src/b.ts",
        nodeType: "module",
        name: "src/b.ts",
      };
      const edgeInput1: CreateGraphEdgeInput = {
        id: edgeId1,
        organizationId: orgA.id,
        analysisRunId: run1.id,
        sourceNodeId: n1Id,
        targetNodeId: n2Id,
        edgeType: "IMPORTS",
        canonicalId: "edge:mod:a->mod:b",
      };
      const evInput1: CreateEvidenceInput = {
        organizationId: orgA.id,
        analysisRunId: run1.id,
        subjectType: "graph_edge",
        subjectId: edgeInput1.id!,
        filePath: "src/a.ts",
        relationshipDescription: "Import statement",
      };

      const build1 = await persistGraphBuild(pool, {
        organizationId: orgA.id,
        analysisRunId: run1.id,
        nodes: [
          { ...nodeA1, id: n1Id },
          { ...nodeB1, id: n2Id },
        ],
        edges: [edgeInput1],
        evidence: [evInput1],
      });

      assert.ok(build1.diff !== undefined);
      assert.equal(build1.diff.summary.nodesAdded, 2);
      assert.equal(build1.diff.summary.edgesAdded, 1);
      assert.ok(build1.event !== undefined);
      assert.equal(build1.event.type, GRAPH_UPDATED_EVENT_TYPE);
      assert.equal(build1.event.payload.summary.nodes_added, 2);

      // Verify event is in outbox table
      const storedEvent = await getEventById(pool, orgA.id, build1.event.id);
      assert.ok(storedEvent !== null);
      assert.equal(storedEvent.type, GRAPH_UPDATED_EVENT_TYPE);

      // Run 2: snapshot 2 build with 1 added node and 1 changed node
      const n3Id = EvidenceWriter.generateDeterministicUuid(`${seed}:node:3`);
      const n4Id = EvidenceWriter.generateDeterministicUuid(`${seed}:node:4`);
      const n5Id = EvidenceWriter.generateDeterministicUuid(`${seed}:node:5`);

      const nodeA2: CreateGraphNodeInput = {
        id: n3Id,
        organizationId: orgA.id,
        analysisRunId: run2.id,
        canonicalId: "mod:src/a.ts",
        nodeType: "module",
        name: "src/a.ts", // unchanged
      };
      const nodeB2: CreateGraphNodeInput = {
        id: n4Id,
        organizationId: orgA.id,
        analysisRunId: run2.id,
        canonicalId: "mod:src/b.ts",
        nodeType: "module",
        name: "src/b_v2.ts", // changed name
      };
      const nodeC2: CreateGraphNodeInput = {
        id: n5Id,
        organizationId: orgA.id,
        analysisRunId: run2.id,
        canonicalId: "mod:src/c.ts",
        nodeType: "module",
        name: "src/c.ts", // added node
      };

      const build2 = await persistGraphBuild(pool, {
        organizationId: orgA.id,
        analysisRunId: run2.id,
        previousAnalysisRunId: run1.id,
        nodes: [nodeA2, nodeB2, nodeC2],
        edges: [],
        evidence: [],
      });

      assert.ok(build2.diff !== undefined);
      assert.equal(build2.diff.summary.nodesAdded, 1); // c.ts
      assert.equal(build2.diff.summary.nodesChanged, 1); // b.ts
      assert.equal(build2.diff.summary.nodesUnchanged, 1); // a.ts
      assert.equal(build2.diff.summary.edgesRemoved, 1); // edge removed
      assert.ok(build2.event !== undefined);
      assert.equal(build2.event.payload.summary.nodes_added, 1);
      assert.equal(build2.event.payload.summary.nodes_changed, 1);
      assert.equal(build2.event.payload.summary.edges_removed, 1);
    });

    it("12. idempotent/repeated update behavior: duplicate persist preserves idempotency", async () => {
      // Re-run persist on run2
      const build2Again = await persistGraphBuild(pool, {
        organizationId: orgA.id,
        analysisRunId: run2.id,
        previousAnalysisRunId: run1.id,
        nodes: [],
        edges: [],
        evidence: [],
      });

      assert.ok(build2Again.event !== undefined);
      // Ensure only 1 event exists with this idempotency key
      const events = await listEvents(pool, orgA.id, { type: GRAPH_UPDATED_EVENT_TYPE });
      const matching = events.filter(
        (e) => e.idempotencyKey === graphUpdatedIdempotencyKey(run2.id, run1.id),
      );
      assert.equal(matching.length, 1);
    });

    it("13. tenant isolation: cross-tenant diff request returns empty previous state", async () => {
      // Org B tries to diff using run1 belonging to Org A
      const runB = await createAnalysisRun(pool, {
        organizationId: orgB.id,
        snapshotId: (await createRepositorySnapshot(pool, {
          organizationId: orgB.id,
          repositoryId: (await createRepository(pool, {
            organizationId: orgB.id,
            githubRepoId: String(Math.floor(90000000 + Math.random() * 80000000)),
            name: "repo-b",
            defaultBranch: "main",
          })).id,
          commitSha: "3333333333333333333333333333333333333333",
          ref: "refs/heads/main",
          fileCount: 1,
          sizeBytes: "100",
          storageUri: "s3://b/1",
          sha256: "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
        })).id,
        status: "completed",
      });

      // When org B queries diff against org A's run1, RLS prevents reading org A's nodes
      const crossDiff = await diffAnalysisRuns(pool, {
        organizationId: orgB.id,
        currentAnalysisRunId: runB.id,
        previousAnalysisRunId: run1.id,
      });

      // Previous state was shielded by RLS => evaluated as empty previous graph
      assert.equal(crossDiff.summary.totalNodesBefore, 0);
      assert.equal(crossDiff.summary.totalEdgesBefore, 0);
    });

    it("14. analysis-run isolation: diffing against specific run isolates data", async () => {
      const diff1to2 = await diffAnalysisRuns(pool, {
        organizationId: orgA.id,
        currentAnalysisRunId: run2.id,
        previousAnalysisRunId: run1.id,
      });

      assert.equal(diff1to2.summary.totalNodesBefore, 2);
      assert.equal(diff1to2.summary.totalNodesAfter, 3);
    });

    it("15. failed graph transaction does not emit a successful update event", async () => {
      const runFailed = await createAnalysisRun(pool, {
        organizationId: orgA.id,
        snapshotId: snap1.id,
        status: "pending",
      });

      const beforeEvents = await listEvents(pool, orgA.id, { type: GRAPH_UPDATED_EVENT_TYPE });

      // Intentionally pass an invalid edge endpoint (violating foreign key constraint)
      await assert.rejects(
        async () => {
          await persistGraphBuild(pool, {
            organizationId: orgA.id,
            analysisRunId: runFailed.id,
            nodes: [
              {
                id: "cccccccc-1111-4111-8111-111111111111",
                organizationId: orgA.id,
                analysisRunId: runFailed.id,
                canonicalId: "mod:valid",
                nodeType: "module",
                name: "valid",
              },
            ],
            edges: [
              {
                id: "cccccccc-2222-4222-8222-222222222222",
                organizationId: orgA.id,
                analysisRunId: runFailed.id,
                sourceNodeId: "cccccccc-1111-4111-8111-111111111111",
                targetNodeId: "00000000-0000-0000-0000-000000000000", // Non-existent target node
                edgeType: "IMPORTS",
              },
            ],
            evidence: [],
          });
        },
        /violates foreign key constraint|GraphStorageConflictError/i,
      );

      // Verify no event was emitted or persisted for runFailed
      const afterEvents = await listEvents(pool, orgA.id, { type: GRAPH_UPDATED_EVENT_TYPE });
      assert.equal(afterEvents.length, beforeEvents.length);
      const failedEvent = afterEvents.find((e) => e.payload.analysis_run_id === runFailed.id);
      assert.equal(failedEvent, undefined);
    });
  });
});

