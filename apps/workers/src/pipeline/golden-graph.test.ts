import assert from "node:assert/strict";
import test from "node:test";

import {
  closePool,
  createAnalysisRun,
  createOrganization,
  createRepository,
  createRepositorySnapshot,
  getEvidenceById,
  getGraphEdgeById,
  getGraphNodeByCanonicalId,
  getGraphNodeById,
  getPool,
  listEvidenceForAnalysisRun,
  listEvidenceForSubject,
  listGraphEdges,
  listGraphNodes,
  loadRootEnvFile,
  runMigrations,
  traverseGraph,
} from "@fluxora/db";

import {
  GOLDEN_FIXTURE_ID,
  GOLDEN_FIXTURE_PINNED_SHA,
  loadGoldenFixtureFileMap,
  loadGoldenFixtureManifest,
} from "../fixtures/golden.ts";
import { runPhase3Pipeline } from "./phase3.ts";
import {
  buildAndPersistGraph,
  buildGraphProjection,
} from "../builder/graph-builder.ts";

loadRootEnvFile();

const hasDatabase =
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const RLS_TEST_ROLE = "fluxora_rls_test";

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
}

test(
  "Step 33: Golden Fixture Graph Verification — End-to-End Contract Validation",
  { skip: !hasDatabase },
  async (t) => {
    const pool = getPool();
    await runMigrations(pool);
    await ensureRlsTestRole(pool);

    t.after(async () => {
      await closePool();
    });

    // 1. Load golden fixture source snapshot files
    const manifest = loadGoldenFixtureManifest();
    assert.equal(manifest.fixtureId, GOLDEN_FIXTURE_ID);
    assert.equal(manifest.pinnedCommitSha, GOLDEN_FIXTURE_PINNED_SHA);

    const fileMap = loadGoldenFixtureFileMap();
    assert.ok(fileMap.size > 100, "Golden fixture snapshot must have >100 files");

    // 2. Execute full Phase 3 extraction/normalization pipeline
    const pipelineResult = await runPhase3Pipeline({ files: fileMap });
    const normalized = pipelineResult.normalized;
    assert.ok(normalized.symbols.length > 0);
    assert.ok(normalized.moduleEdges.length > 0);
    assert.ok(normalized.routes.length > 0);

    // Setup multi-tenant DB fixture isolation
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const baseId = Math.floor(Math.random() * 800_000_000) + 100_000_000;

    const orgA = await createOrganization(pool, {
      name: `Step 33 Org A - Primary (${suffix})`,
    });
    const repoA = await createRepository(pool, {
      organizationId: orgA.id,
      githubRepoId: String(baseId),
      name: "shadcn-taxonomy",
      defaultBranch: "main",
    });
    const snapshotA = await createRepositorySnapshot(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      commitSha: GOLDEN_FIXTURE_PINNED_SHA,
      ref: "main",
      storageUri: "s3://fluxora-fixtures/taxonomy.tar.gz",
      sha256: "0".repeat(64),
      fileCount: fileMap.size,
      sizeBytes: "1500000",
    });
    const runA1 = await createAnalysisRun(pool, {
      organizationId: orgA.id,
      snapshotId: snapshotA.id,
    });

    // Secondary organization for cross-tenant RLS negative verification
    const orgB = await createOrganization(pool, {
      name: `Step 33 Org B - Adversary (${suffix})`,
    });
    const repoB = await createRepository(pool, {
      organizationId: orgB.id,
      githubRepoId: String(baseId + 1),
      name: "isolated-repo",
      defaultBranch: "main",
    });
    const snapshotB = await createRepositorySnapshot(pool, {
      organizationId: orgB.id,
      repositoryId: repoB.id,
      commitSha: "b".repeat(40),
      ref: "main",
      storageUri: "s3://fluxora-fixtures/isolated.tar.gz",
      sha256: "1".repeat(64),
      fileCount: 1,
      sizeBytes: "100",
    });
    const runB = await createAnalysisRun(pool, {
      organizationId: orgB.id,
      snapshotId: snapshotB.id,
    });

    // Secondary run under Org A for analysis run isolation verification
    const runA2 = await createAnalysisRun(pool, {
      organizationId: orgA.id,
      snapshotId: snapshotA.id,
    });

    // 3. Project and persist golden fixture graph into PostgreSQL
    const persisted = await buildAndPersistGraph(pool, {
      organizationId: orgA.id,
      analysisRunId: runA1.id,
      normalizedResult: normalized,
      emitEvent: false, // Pure graph storage verification
    });

    assert.ok(persisted.nodes.length > 0, "Persisted nodes must be non-empty");
    assert.ok(persisted.edges.length > 0, "Persisted edges must be non-empty");
    assert.ok(persisted.evidence.length > 0, "Persisted evidence must be non-empty");

    // 4. Read back persisted graph directly from PostgreSQL using repository read APIs
    const dbNodes = await listGraphNodes(pool, orgA.id, runA1.id);
    const dbEdges = await listGraphEdges(pool, orgA.id, runA1.id);
    const dbEvidence = await listEvidenceForAnalysisRun(pool, orgA.id, runA1.id);

    // =========================================================================
    // Contract 1: GraphNodes Validation (Counts, Types, IDs, Canonicalization)
    // =========================================================================
    await t.test(
      "1. Canonical GraphNodes contract: counts, types, stable IDs, and no duplicates",
      async () => {
        assert.equal(dbNodes.length, persisted.nodes.length);
        assert.equal(dbNodes.length, 490, "Golden fixture must project exactly 490 canonical nodes");

        // Verify node type breakdown
        const symbolNodes = dbNodes.filter((n) => n.nodeType === "symbol");
        const moduleNodes = dbNodes.filter((n) => n.nodeType === "module");
        const routeNodes = dbNodes.filter((n) => n.nodeType === "api");
        const eventNodes = dbNodes.filter((n) => n.nodeType === "event");
        const databaseNodes = dbNodes.filter((n) => n.nodeType === "database");

        assert.equal(symbolNodes.length, 367, "Expected 367 symbol nodes");
        assert.equal(moduleNodes.length, 118, "Expected 118 module nodes");
        assert.equal(routeNodes.length, 5, "Expected 5 API route nodes");
        assert.equal(eventNodes.length, 0, "Taxonomy has zero event nodes");
        assert.equal(databaseNodes.length, 0, "Taxonomy has zero direct database nodes");

        // Uniqueness & ID integrity: no duplicate canonical IDs or UUIDs
        const canonicalIdSet = new Set<string>();
        const uuidSet = new Set<string>();

        for (const node of dbNodes) {
          assert.equal(node.analysisRunId, runA1.id);
          assert.ok(node.id.length === 36, "Node ID must be a valid UUID");
          assert.ok(node.canonicalId.length > 0, "Canonical ID must not be empty");
          assert.ok(node.name.length > 0, "Node name must not be empty");

          assert.ok(
            !canonicalIdSet.has(node.canonicalId),
            `Duplicate canonical ID detected: ${node.canonicalId}`,
          );
          canonicalIdSet.add(node.canonicalId);

          assert.ok(!uuidSet.has(node.id), `Duplicate node UUID detected: ${node.id}`);
          uuidSet.add(node.id);
        }

        // Hand-verified representative nodes from golden fixture source files
        // Symbol: db in lib/db.ts
        const dbNode = dbNodes.find(
          (n) => n.path === "lib/db.ts" && n.name === "db" && n.nodeType === "symbol",
        );
        assert.ok(dbNode, "Canonical node for symbol 'db' in lib/db.ts must exist");
        assert.match(dbNode.canonicalId, /^sym:lib\/db\.ts#constant:db:/);

        // Fetch via getGraphNodeById
        const fetchedById = await getGraphNodeById(pool, orgA.id, dbNode.id);
        assert.ok(fetchedById);
        assert.equal(fetchedById.canonicalId, dbNode.canonicalId);

        // Fetch via getGraphNodeByCanonicalId
        const fetchedByCanonical = await getGraphNodeByCanonicalId(
          pool,
          orgA.id,
          runA1.id,
          dbNode.canonicalId,
        );
        assert.ok(fetchedByCanonical);
        assert.equal(fetchedByCanonical.id, dbNode.id);

        // Symbol: siteConfig in config/site.ts
        const siteConfigNode = dbNodes.find(
          (n) =>
            n.path === "config/site.ts" &&
            n.name === "siteConfig" &&
            n.nodeType === "symbol",
        );
        assert.ok(siteConfigNode, "Canonical node for 'siteConfig' in config/site.ts must exist");

        // Symbol: GET handler in app/api/posts/route.ts
        const getHandlerNode = dbNodes.find(
          (n) =>
            n.path === "app/api/posts/route.ts" &&
            n.name === "GET" &&
            n.nodeType === "symbol",
        );
        assert.ok(getHandlerNode, "Canonical node for 'GET' handler in app/api/posts/route.ts must exist");

        // Module: mod:lib/db.ts
        const dbModuleNode = dbNodes.find(
          (n) => n.canonicalId === "mod:lib/db.ts" && n.nodeType === "module",
        );
        assert.ok(dbModuleNode, "Canonical module node for lib/db.ts must exist");
        assert.equal(dbModuleNode.name, "lib/db.ts");

        // API Route: route:app/api/posts/route.ts#app-router-handler:GET:/api/posts:...
        const postsRouteNode = dbNodes.find(
          (n) =>
            n.nodeType === "api" &&
            n.path === "app/api/posts/route.ts" &&
            n.name === "GET /api/posts",
        );
        assert.ok(postsRouteNode, "Canonical API route node for GET /api/posts must exist");
        assert.equal((postsRouteNode.metadata as Record<string, unknown>).framework, "Next.js");
      },
    );

    // =========================================================================
    // Contract 2: GraphEdges Validation (Counts, Types, Direction, Integrity)
    // =========================================================================
    await t.test(
      "2. Canonical GraphEdges contract: counts, types, directionality, and endpoint integrity",
      async () => {
        assert.equal(dbEdges.length, persisted.edges.length);
        assert.equal(dbEdges.length, 888, "Golden fixture must produce exactly 888 canonical edges");

        const importEdges = dbEdges.filter((e) => e.edgeType === "IMPORTS");
        const routeEdges = dbEdges.filter((e) => e.edgeType === "EXPOSES_ROUTE");
        const resolveEdges = dbEdges.filter((e) => e.edgeType === "RESOLVES_TO");
        const eventEdges = dbEdges.filter(
          (e) => e.edgeType === "PRODUCES_EVENT" || e.edgeType === "CONSUMES_EVENT",
        );
        const dbRefEdges = dbEdges.filter((e) => e.edgeType === "QUERIES_DB");

        assert.equal(importEdges.length, 511, "Expected 511 IMPORTS edges");
        assert.equal(routeEdges.length, 5, "Expected 5 EXPOSES_ROUTE edges");
        assert.equal(resolveEdges.length, 372, "Expected 372 RESOLVES_TO edges");
        assert.equal(eventEdges.length, 0);
        assert.equal(dbRefEdges.length, 0);

        // Referential integrity & endpoint validation
        const nodeMapById = new Map(dbNodes.map((n) => [n.id, n]));
        const edgeKeySet = new Set<string>();

        for (const edge of dbEdges) {
          assert.equal(edge.analysisRunId, runA1.id);
          assert.ok(edge.id.length === 36, "Edge ID must be a valid UUID");

          // Both source and target must resolve to valid nodes in this analysis run
          const sourceNode = nodeMapById.get(edge.sourceNodeId);
          const targetNode = nodeMapById.get(edge.targetNodeId);

          assert.ok(
            sourceNode,
            `Edge ${edge.id} source node ${edge.sourceNodeId} must exist in graph_nodes`,
          );
          assert.ok(
            targetNode,
            `Edge ${edge.id} target node ${edge.targetNodeId} must exist in graph_nodes`,
          );

          // Duplicate edge prevention
          const edgeKey = `${edge.sourceNodeId}:${edge.targetNodeId}:${edge.edgeType}`;
          assert.ok(!edgeKeySet.has(edgeKey), `Duplicate edge detected: ${edgeKey}`);
          edgeKeySet.add(edgeKey);
        }

        // Hand-verified Relationship 1: app/api/posts/route.ts IMPORTS lib/db.ts
        const postsMod = dbNodes.find((n) => n.canonicalId === "mod:app/api/posts/route.ts");
        const dbMod = dbNodes.find((n) => n.canonicalId === "mod:lib/db.ts");
        assert.ok(postsMod && dbMod);

        const postsImportsDbEdge = dbEdges.find(
          (e) =>
            e.sourceNodeId === postsMod.id &&
            e.targetNodeId === dbMod.id &&
            e.edgeType === "IMPORTS",
        );
        assert.ok(
          postsImportsDbEdge,
          "app/api/posts/route.ts must have IMPORTS edge directed to lib/db.ts",
        );

        // Verify getGraphEdgeById
        const fetchedEdge = await getGraphEdgeById(pool, orgA.id, postsImportsDbEdge.id);
        assert.ok(fetchedEdge);
        assert.equal(fetchedEdge.id, postsImportsDbEdge.id);

        // Hand-verified Relationship 2: app/layout.tsx IMPORTS config/site.ts
        const layoutMod = dbNodes.find((n) => n.canonicalId === "mod:app/layout.tsx");
        const siteMod = dbNodes.find((n) => n.canonicalId === "mod:config/site.ts");
        assert.ok(layoutMod && siteMod);

        const layoutImportsSiteEdge = dbEdges.find(
          (e) =>
            e.sourceNodeId === layoutMod.id &&
            e.targetNodeId === siteMod.id &&
            e.edgeType === "IMPORTS",
        );
        assert.ok(
          layoutImportsSiteEdge,
          "app/layout.tsx must have IMPORTS edge directed to config/site.ts",
        );

        // Hand-verified Relationship 3: Module mod:app/api/posts/route.ts EXPOSES_ROUTE GET
        const postsRoute = dbNodes.find(
          (n) => n.nodeType === "api" && n.name === "GET /api/posts",
        );
        assert.ok(postsRoute);

        const moduleExposesRouteEdge = dbEdges.find(
          (e) =>
            e.sourceNodeId === postsMod.id &&
            e.targetNodeId === postsRoute.id &&
            e.edgeType === "EXPOSES_ROUTE",
        );
        assert.ok(
          moduleExposesRouteEdge,
          "Module app/api/posts/route.ts must have EXPOSES_ROUTE edge to route node",
        );

        // Hand-verified Relationship 4: Module mod:lib/db.ts RESOLVES_TO symbol db
        const dbSymbol = dbNodes.find(
          (n) => n.path === "lib/db.ts" && n.name === "db" && n.nodeType === "symbol",
        );
        assert.ok(dbSymbol);

        const modResolvesToDbEdge = dbEdges.find(
          (e) =>
            e.sourceNodeId === dbMod.id &&
            e.targetNodeId === dbSymbol.id &&
            e.edgeType === "RESOLVES_TO",
        );
        assert.ok(
          modResolvesToDbEdge,
          "Module mod:lib/db.ts must have RESOLVES_TO edge to symbol 'db'",
        );
      },
    );

    // =========================================================================
    // Contract 3: Evidence Provenance Contract (Step 29 Evidence Linking)
    // =========================================================================
    await t.test(
      "3. Evidence provenance contract: exact attachment, file paths, and coordinates",
      async () => {
        assert.equal(dbEvidence.length, persisted.evidence.length);
        assert.equal(
          dbEvidence.length,
          1378,
          "Golden fixture must persist exactly 1378 evidence records",
        );

        const nodeEvidence = dbEvidence.filter((ev) => ev.subjectType === "graph_node");
        const edgeEvidence = dbEvidence.filter((ev) => ev.subjectType === "graph_edge");

        assert.equal(nodeEvidence.length, 490, "Each GraphNode must have 1 evidence record");
        assert.equal(edgeEvidence.length, 888, "Each GraphEdge must have 1 evidence record");

        // Verify evidence for db symbol node
        const dbSymbol = dbNodes.find(
          (n) => n.path === "lib/db.ts" && n.name === "db" && n.nodeType === "symbol",
        );
        assert.ok(dbSymbol);

        const dbEvList = await listEvidenceForSubject(
          pool,
          orgA.id,
          runA1.id,
          "graph_node",
          dbSymbol.id,
        );
        assert.ok(dbEvList.length >= 1, "Evidence must be present for db symbol node");
        const dbEv = dbEvList[0];
        assert.ok(dbEv);
        assert.equal(dbEv.filePath, "lib/db.ts");
        assert.ok(dbEv.relationshipDescription.length > 0);
        assert.equal(dbEv.confidence, 1.0);
        assert.ok(
          typeof dbEv.lineStart === "number" && dbEv.lineStart >= 1,
          "db symbol must track valid 1-based start line",
        );

        // Fetch evidence via getEvidenceById
        const fetchedEv = await getEvidenceById(pool, orgA.id, dbEv.id);
        assert.ok(fetchedEv);
        assert.equal(fetchedEv.id, dbEv.id);
        assert.equal(fetchedEv.filePath, "lib/db.ts");

        // Verify evidence for module import edge
        const postsMod = dbNodes.find((n) => n.canonicalId === "mod:app/api/posts/route.ts");
        const dbMod = dbNodes.find((n) => n.canonicalId === "mod:lib/db.ts");
        const postsImportsDbEdge = dbEdges.find(
          (e) =>
            e.sourceNodeId === postsMod?.id &&
            e.targetNodeId === dbMod?.id &&
            e.edgeType === "IMPORTS",
        );
        assert.ok(postsImportsDbEdge);

        const edgeEvList = await listEvidenceForSubject(
          pool,
          orgA.id,
          runA1.id,
          "graph_edge",
          postsImportsDbEdge.id,
        );
        assert.ok(edgeEvList.length >= 1, "Evidence must be present for import edge");
        const edgeEv = edgeEvList[0];
        assert.ok(edgeEv);
        assert.equal(edgeEv.filePath, "app/api/posts/route.ts");
        assert.ok(
          edgeEv.relationshipDescription.includes("app/api/posts/route.ts"),
          "Edge evidence description must reflect import source",
        );
      },
    );

    // =========================================================================
    // Contract 4: Determinism & Repeated Persistence Idempotency
    // =========================================================================
    await t.test(
      "4. Determinism & Idempotency: repeated execution produces identical graph and zero duplicates",
      async () => {
        // Run projection a second time in memory
        const proj2 = buildGraphProjection({
          organizationId: orgA.id,
          analysisRunId: runA1.id,
          normalizedResult: normalized,
        });

        assert.deepEqual(
          proj2.nodes.map((n) => n.canonicalId),
          dbNodes.map((n) => n.canonicalId).sort((a, b) => a.localeCompare(b)),
          "In-memory canonical node ordering must be 100% deterministic",
        );

        // Re-persist the same golden fixture against runA1 in PostgreSQL
        const persistedAgain = await buildAndPersistGraph(pool, {
          organizationId: orgA.id,
          analysisRunId: runA1.id,
          normalizedResult: normalized,
          emitEvent: false,
        });

        assert.equal(persistedAgain.nodes.length, 490);
        assert.equal(persistedAgain.edges.length, 888);
        assert.equal(persistedAgain.evidence.length, 1378);

        // Verify database counts have NOT multiplied
        const postRunNodes = await listGraphNodes(pool, orgA.id, runA1.id);
        const postRunEdges = await listGraphEdges(pool, orgA.id, runA1.id);
        const postRunEvidence = await listEvidenceForAnalysisRun(pool, orgA.id, runA1.id);

        assert.equal(
          postRunNodes.length,
          490,
          "Re-persisting must NOT create duplicate GraphNodes in PostgreSQL",
        );
        assert.equal(
          postRunEdges.length,
          888,
          "Re-persisting must NOT create duplicate GraphEdges in PostgreSQL",
        );
        assert.equal(
          postRunEvidence.length,
          1378,
          "Re-persisting must NOT create duplicate Evidence records in PostgreSQL",
        );
      },
    );

    // =========================================================================
    // Contract 5: Tenant & Analysis-Run Isolation (RLS Verification)
    // =========================================================================
    await t.test(
      "5. Tenant and Analysis-Run Isolation: complete boundary enforcement",
      async () => {
        const originalRole = process.env.FLUXORA_DATABASE_ROLE;
        try {
          process.env.FLUXORA_DATABASE_ROLE = RLS_TEST_ROLE;

          // Adversary tenant Org B attempts to read Org A's graph under RLS test role
          const crossTenantNodes = await listGraphNodes(pool, orgB.id, runA1.id);
          assert.equal(
            crossTenantNodes.length,
            0,
            "Org B must not read Org A's GraphNodes via listGraphNodes",
          );

          const crossTenantEdges = await listGraphEdges(pool, orgB.id, runA1.id);
          assert.equal(
            crossTenantEdges.length,
            0,
            "Org B must not read Org A's GraphEdges via listGraphEdges",
          );

          const crossTenantEvidence = await listEvidenceForAnalysisRun(
            pool,
            orgB.id,
            runA1.id,
          );
          assert.equal(
            crossTenantEvidence.length,
            0,
            "Org B must not read Org A's Evidence via listEvidenceForAnalysisRun",
          );

          // Direct cross-tenant lookup by ID returns null
          const sampleNode = dbNodes[0];
          assert.ok(sampleNode);
          const crossTenantNodeGet = await getGraphNodeById(pool, orgB.id, sampleNode.id);
          assert.equal(
            crossTenantNodeGet,
            null,
            "Org B must receive null when querying Org A's GraphNode by ID",
          );

          const sampleEdge = dbEdges[0];
          assert.ok(sampleEdge);
          const crossTenantEdgeGet = await getGraphEdgeById(pool, orgB.id, sampleEdge.id);
          assert.equal(
            crossTenantEdgeGet,
            null,
            "Org B must receive null when querying Org A's GraphEdge by ID",
          );
        } finally {
          if (originalRole !== undefined) {
            process.env.FLUXORA_DATABASE_ROLE = originalRole;
          } else {
            delete process.env.FLUXORA_DATABASE_ROLE;
          }
        }

        // Analysis Run Isolation: runA2 in Org A has not ingested a graph yet
        const runA2Nodes = await listGraphNodes(pool, orgA.id, runA2.id);
        assert.equal(
          runA2Nodes.length,
          0,
          "Run A2 must have zero nodes and not inherit Run A1's graph records",
        );

        const runA2Edges = await listGraphEdges(pool, orgA.id, runA2.id);
        assert.equal(runA2Edges.length, 0, "Run A2 must have zero edges");

        const runBNodes = await listGraphNodes(pool, orgB.id, runB.id);
        assert.equal(runBNodes.length, 0, "Run B in Org B must have zero nodes");
      },
    );

    // =========================================================================
    // Contract 6: Meaningful Negative Assertions
    // =========================================================================
    await t.test(
      "6. Meaningful Negative Assertions: unexpected nodes, edges, routes, and evidence are absent",
      async () => {
        // Negative Node 1: Non-existent canonical symbol
        const fakeNode = await getGraphNodeByCanonicalId(
          pool,
          orgA.id,
          runA1.id,
          "sym:lib/db.ts#function:nonExistentFunction:9999",
        );
        assert.equal(fakeNode, null, "Non-existent symbol must return null");

        // Negative Node 2: Non-existent file
        const fakeFileNode = await getGraphNodeByCanonicalId(
          pool,
          orgA.id,
          runA1.id,
          "mod:fake/unreal-file.ts",
        );
        assert.equal(fakeFileNode, null, "Non-existent module must return null");

        // Negative Node 3: Next.js pages/layouts are NOT API route nodes
        const pageLayoutRoute = await getGraphNodeByCanonicalId(
          pool,
          orgA.id,
          runA1.id,
          "route:app/layout.tsx#app-router-handler:GET:/:1",
        );
        assert.equal(pageLayoutRoute, null, "Page layout must not be created as API route");

        // Negative Node 4: Unresolved external package is not fabricated as internal module node
        const externalReactNode = await getGraphNodeByCanonicalId(
          pool,
          orgA.id,
          runA1.id,
          "mod:react",
        );
        assert.equal(externalReactNode, null, "External package 'react' must not be a mod node");

        // Negative Edge: Query non-existent random UUID
        const fakeEdge = await getGraphEdgeById(
          pool,
          orgA.id,
          "00000000-0000-4000-8000-000000000999",
        );
        assert.equal(fakeEdge, null, "Non-existent edge must return null");

        // Negative Evidence: Query evidence for random subject ID
        const fakeEvidence = await listEvidenceForSubject(
          pool,
          orgA.id,
          runA1.id,
          "graph_node",
          "00000000-0000-4000-8000-000000000999",
        );
        assert.deepEqual(fakeEvidence, [], "Random subject ID must return empty evidence array");
      },
    );

    // =========================================================================
    // Contract 7: Recursive-CTE Traversal Smoke Check over Golden Graph
    // =========================================================================
    await t.test(
      "7. Step 30 CTE Traversal over Golden Graph: module -> route / import chains",
      async () => {
        const postsMod = dbNodes.find(
          (n) => n.canonicalId === "mod:app/api/posts/route.ts",
        );
        assert.ok(postsMod);

        // Traverse 2 hops from the posts module node
        const traversal = await traverseGraph(pool, {
          organizationId: orgA.id,
          analysisRunId: runA1.id,
          startNodeId: postsMod.id,
          maxDepth: 2,
        });

        assert.ok(traversal.startNode);
        assert.equal(traversal.startNode.id, postsMod.id);
        assert.ok(traversal.nodes.length >= 2, "Traversal should discover downstream nodes");
        assert.ok(traversal.edges.length >= 1, "Traversal should discover connecting edges");

        // Traversed nodes should include lib/db module or routes exposed
        const traversedPaths = traversal.nodes.map((n) => n.node.path);
        assert.ok(
          traversedPaths.includes("lib/db.ts") ||
            traversedPaths.includes("app/api/posts/route.ts"),
          "Traversal must reach adjacent graph dependencies",
        );
      },
    );
  },
);
