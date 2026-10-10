import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAndPersistGraph,
  buildGraphProjection,
} from "./graph-builder.ts";
import type {
  RepositoryNormalizedResult,
  SourceLocation,
} from "@fluxora/shared-types";
import {
  closePool,
  createAnalysisRun,
  createOrganization,
  createRepository,
  createRepositorySnapshot,
  getPool,
  listGraphEdges,
  listGraphNodes,
  runMigrations,
} from "@fluxora/db";

const hasDatabase =
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const RLS_TEST_ROLE = "fluxora_rls_test";

const dummyLocation: SourceLocation = {
  start: { line: 10, column: 1, offset: 100 },
  end: { line: 20, column: 5, offset: 200 },
};

function createEmptyNormalizedResult(
  overrides: Partial<RepositoryNormalizedResult> = {},
): RepositoryNormalizedResult {
  return {
    symbols: [],
    exportResolutions: [],
    moduleEdges: [],
    routes: [],
    events: [],
    databaseReferences: [],
    unresolved: [],
    diagnostics: [],
    statistics: {
      totalSymbolsInput: 0,
      totalNormalizedSymbols: 0,
      totalReExportsResolved: 0,
      totalModuleEdgesNormalized: 0,
      totalRoutesNormalized: 0,
      totalEventsNormalized: 0,
      totalDatabaseReferencesNormalized: 0,
      totalUnresolved: 0,
      totalDiagnostics: 0,
      cycleCount: 0,
    },
    ...overrides,
  };
}

test("Step 28: Graph Builder — Unit & Projection Tests (In-Memory)", async (t) => {
  const orgId = "00000000-0000-4000-8000-000000000001";
  const runId = "00000000-0000-4000-8000-000000000002";

  await t.test("1. Normalized symbols become GraphNodes", () => {
    const normalized = createEmptyNormalizedResult({
      symbols: [
        {
          canonicalId: "sym:src/auth.ts#function:login:100",
          name: "login",
          kind: "function",
          relativePath: "src/auth.ts",
          location: dummyLocation,
          exported: { isExported: true, isDefaultExport: false, exportName: "login" },
          aliases: [],
          provenance: [
            {
              detector: "ts-morph",
              sourceId: "src/auth.ts",
              sourceFile: "src/auth.ts",
            },
          ],
        },
      ],
    });

    const projection = buildGraphProjection({
      organizationId: orgId,
      analysisRunId: runId,
      normalizedResult: normalized,
    });

    const symNode = projection.nodes.find(
      (n) => n.canonicalId === "sym:src/auth.ts#function:login:100",
    );
    assert.ok(symNode, "Symbol node should exist");
    assert.equal(symNode.nodeType, "symbol");
    assert.equal(symNode.name, "login");
    assert.equal(symNode.path, "src/auth.ts");
    assert.equal(symNode.organizationId, orgId);
    assert.equal(symNode.analysisRunId, runId);
  });

  await t.test(
    "2. Normalized module relationships become directed GraphEdges",
    () => {
      const normalized = createEmptyNormalizedResult({
        moduleEdges: [
          {
            canonicalId: "edge:src/index.ts->src/utils.ts#import:100",
            sourceFile: "src/index.ts",
            targetFile: "src/utils.ts",
            edgeKind: "import",
            importKind: "named_import",
            specifier: "./utils",
            names: [
              {
                name: "formatDate",
                alias: "formatDate",
                isTypeOnly: false,
              },
            ],
            location: dummyLocation,
            resolutionStatus: "internal",
          },
        ],
      });

      const projection = buildGraphProjection({
        organizationId: orgId,
        analysisRunId: runId,
        normalizedResult: normalized,
      });

      const srcMod = projection.nodes.find(
        (n) => n.canonicalId === "mod:src/index.ts",
      );
      const tgtMod = projection.nodes.find(
        (n) => n.canonicalId === "mod:src/utils.ts",
      );

      assert.ok(srcMod, "Source module node should exist");
      assert.ok(tgtMod, "Target module node should exist");

      const edge = projection.edges.find(
        (e) =>
          e.sourceNodeId === srcMod.id &&
          e.targetNodeId === tgtMod.id &&
          e.edgeType === "IMPORTS",
      );
      assert.ok(edge, "Directed IMPORTS edge should exist");
      assert.equal(
        edge.canonicalId,
        "edge:src/index.ts->src/utils.ts#import:100",
      );
    },
  );

  await t.test("3. Canonical symbol IDs are preserved", () => {
    const canonicalId =
      "sym:src/services/user.ts#class:UserService:200";
    const normalized = createEmptyNormalizedResult({
      symbols: [
        {
          canonicalId,
          name: "UserService",
          kind: "class",
          relativePath: "src/services/user.ts",
          location: dummyLocation,
          exported: { isExported: true, isDefaultExport: false, exportName: "UserService" },
          aliases: [],
          provenance: [],
        },
      ],
    });

    const projection = buildGraphProjection({
      organizationId: orgId,
      analysisRunId: runId,
      normalizedResult: normalized,
    });

    const node = projection.nodes.find((n) => n.canonicalId === canonicalId);
    assert.ok(node);
    assert.equal(node.canonicalId, canonicalId);
  });

  await t.test(
    "4. Multiple aliases to the same canonical symbol do not create duplicate GraphNodes",
    () => {
      const canonicalId = "sym:src/lib.ts#function:helper:50";
      const normalized = createEmptyNormalizedResult({
        symbols: [
          {
            canonicalId,
            name: "helper",
            kind: "function",
            relativePath: "src/lib.ts",
            location: dummyLocation,
            exported: { isExported: true, isDefaultExport: false, exportName: "helper" },
            aliases: [
              { exportName: "h1", exportingFile: "src/index.ts" },
              { exportName: "h2", exportingFile: "src/barrel.ts" },
            ],
            provenance: [],
          },
        ],
        exportResolutions: [
          {
            exportingFile: "src/index.ts",
            exportName: "h1",
            canonicalSymbolId: canonicalId,
            isReExport: true,
            status: "resolved",
            resolutionChain: ["src/index.ts", "src/lib.ts"],
          },
        ],
      });

      const projection = buildGraphProjection({
        organizationId: orgId,
        analysisRunId: runId,
        normalizedResult: normalized,
      });

      const symNodes = projection.nodes.filter(
        (n) => n.canonicalId === canonicalId,
      );
      assert.equal(
        symNodes.length,
        1,
        "Should produce exactly 1 GraphNode for canonicalId",
      );
    },
  );

  await t.test("5. Same symbol name in different files remains distinct", () => {
    const symA = "sym:src/a.ts#function:login:10";
    const symB = "sym:src/b.ts#function:login:10";

    const normalized = createEmptyNormalizedResult({
      symbols: [
        {
          canonicalId: symA,
          name: "login",
          kind: "function",
          relativePath: "src/a.ts",
          location: dummyLocation,
          exported: { isExported: true, isDefaultExport: false, exportName: "login" },
          aliases: [],
          provenance: [],
        },
        {
          canonicalId: symB,
          name: "login",
          kind: "function",
          relativePath: "src/b.ts",
          location: dummyLocation,
          exported: { isExported: true, isDefaultExport: false, exportName: "login" },
          aliases: [],
          provenance: [],
        },
      ],
    });

    const projection = buildGraphProjection({
      organizationId: orgId,
      analysisRunId: runId,
      normalizedResult: normalized,
    });

    const nodeA = projection.nodes.find((n) => n.canonicalId === symA);
    const nodeB = projection.nodes.find((n) => n.canonicalId === symB);

    assert.ok(nodeA);
    assert.ok(nodeB);
    assert.notEqual(nodeA.id, nodeB.id);
  });

  await t.test(
    "6. Route relationships are represented correctly when present",
    () => {
      const handlerSymId = "sym:app/api/posts/route.ts#function:GET:15";
      const routeId =
        "route:app/api/posts/route.ts#app-router-handler:GET:/api/posts:10";

      const normalized = createEmptyNormalizedResult({
        symbols: [
          {
            canonicalId: handlerSymId,
            name: "GET",
            kind: "function",
            relativePath: "app/api/posts/route.ts",
            location: dummyLocation,
            exported: { isExported: true, isDefaultExport: false, exportName: "GET" },
            aliases: [],
            provenance: [],
          },
        ],
        routes: [
          {
            canonicalId: routeId,
            framework: "Next.js",
            routeType: "app-router-handler",
            filePath: "app/api/posts/route.ts",
            routePath: "/api/posts",
            httpMethods: ["GET"],
            symbolName: "GET",
            canonicalSymbolId: handlerSymId,
            sourceLocation: dummyLocation,
            evidence: "export async function GET()",
          },
        ],
      });

      const projection = buildGraphProjection({
        organizationId: orgId,
        analysisRunId: runId,
        normalizedResult: normalized,
      });

      const routeNode = projection.nodes.find(
        (n) => n.canonicalId === routeId,
      );
      assert.ok(routeNode, "Route node should exist");
      assert.equal(routeNode.nodeType, "api");

      const routeEdge = projection.edges.find(
        (e) =>
          e.targetNodeId === routeNode.id && e.edgeType === "EXPOSES_ROUTE",
      );
      assert.ok(routeEdge, "Module -> Route EXPOSES_ROUTE edge should exist");

      const handlerEdge = projection.edges.find(
        (e) =>
          e.sourceNodeId === routeNode.id && e.edgeType === "RESOLVES_TO",
      );
      assert.ok(
        handlerEdge,
        "Route -> Symbol RESOLVES_TO handler edge should exist",
      );
    },
  );

  await t.test(
    "7. Event relationships are represented correctly when present",
    () => {
      const eventId =
        "event:src/events.ts#producer:node_event_emitter:emit:50";

      const normalized = createEmptyNormalizedResult({
        events: [
          {
            canonicalId: eventId,
            role: "producer",
            family: "node_event_emitter",
            methodShape: "emit",
            filePath: "src/events.ts",
            details: { eventName: "user.created", status: "resolved" },
            sourceLocation: dummyLocation,
            evidence: "emitter.emit('user.created')",
          },
        ],
      });

      const projection = buildGraphProjection({
        organizationId: orgId,
        analysisRunId: runId,
        normalizedResult: normalized,
      });

      const eventNode = projection.nodes.find(
        (n) => n.canonicalId === eventId,
      );
      assert.ok(eventNode, "Event node should exist");
      assert.equal(eventNode.nodeType, "event");

      const emitEdge = projection.edges.find(
        (e) =>
          e.targetNodeId === eventNode.id && e.edgeType === "EMITS_EVENT",
      );
      assert.ok(emitEdge, "EMITS_EVENT edge should exist");
    },
  );

  await t.test(
    "8. Database-reference relationships are represented correctly when present",
    () => {
      const dbId = "db:src/db.ts#prisma:read:findMany:80";

      const normalized = createEmptyNormalizedResult({
        databaseReferences: [
          {
            canonicalId: dbId,
            family: "prisma",
            operation: "read",
            methodShape: "prisma.user.findMany",
            filePath: "src/db.ts",
            details: { resourceName: "user", status: "resolved" },
            sourceLocation: dummyLocation,
            evidence: "prisma.user.findMany()",
          },
        ],
      });

      const projection = buildGraphProjection({
        organizationId: orgId,
        analysisRunId: runId,
        normalizedResult: normalized,
      });

      const dbNode = projection.nodes.find((n) => n.canonicalId === dbId);
      assert.ok(dbNode, "Database reference node should exist");
      assert.equal(dbNode.nodeType, "database");

      const dbEdge = projection.edges.find(
        (e) =>
          e.targetNodeId === dbNode.id && e.edgeType === "QUERIES_DB",
      );
      assert.ok(dbEdge, "QUERIES_DB edge should exist");
    },
  );

  await t.test("9. Evidence preserves source provenance", () => {
    const symCanonicalId = "sym:src/auth.ts#function:login:100";
    const normalized = createEmptyNormalizedResult({
      symbols: [
        {
          canonicalId: symCanonicalId,
          name: "login",
          kind: "function",
          relativePath: "src/auth.ts",
          location: dummyLocation,
          exported: { isExported: true, isDefaultExport: false, exportName: "login" },
          aliases: [],
          provenance: [],
        },
      ],
    });

    const projection = buildGraphProjection({
      organizationId: orgId,
      analysisRunId: runId,
      normalizedResult: normalized,
    });

    const symEv = projection.evidence.find(
      (ev) => ev.symbolId === symCanonicalId,
    );
    assert.ok(symEv, "Evidence for symbol should exist");
    assert.equal(symEv.filePath, "src/auth.ts");
    assert.equal(symEv.lineStart, dummyLocation.start.line);
    assert.equal(symEv.lineEnd, dummyLocation.end.line);
    assert.equal(symEv.columnStart, dummyLocation.start.column);
    assert.equal(symEv.columnEnd, dummyLocation.end.column);
    assert.ok(
      symEv.relationshipDescription.includes("Declared symbol"),
    );
  });

  await t.test(
    "10. Deterministic input produces deterministic graph output",
    () => {
      const normalized = createEmptyNormalizedResult({
        symbols: [
          {
            canonicalId: "sym:src/z.ts#function:zebra:10",
            name: "zebra",
            kind: "function",
            relativePath: "src/z.ts",
            location: dummyLocation,
            exported: { isExported: true, isDefaultExport: false, exportName: "zebra" },
            aliases: [],
            provenance: [],
          },
          {
            canonicalId: "sym:src/a.ts#function:apple:10",
            name: "apple",
            kind: "function",
            relativePath: "src/a.ts",
            location: dummyLocation,
            exported: { isExported: true, isDefaultExport: false, exportName: "apple" },
            aliases: [],
            provenance: [],
          },
        ],
        moduleEdges: [
          {
            canonicalId: "edge:src/z.ts->src/a.ts#import:5",
            sourceFile: "src/z.ts",
            targetFile: "src/a.ts",
            edgeKind: "import",
            importKind: "named_import",
            specifier: "./a",
            names: [],
            location: dummyLocation,
            resolutionStatus: "internal",
          },
        ],
      });

      const p1 = buildGraphProjection({
        organizationId: orgId,
        analysisRunId: runId,
        normalizedResult: normalized,
      });

      const p2 = buildGraphProjection({
        organizationId: orgId,
        analysisRunId: runId,
        normalizedResult: normalized,
      });

      assert.deepStrictEqual(
        p1.nodes.map((n) => n.canonicalId),
        p2.nodes.map((n) => n.canonicalId),
      );
      assert.deepStrictEqual(
        p1.edges.map((e) => e.canonicalId),
        p2.edges.map((e) => e.canonicalId),
      );
      assert.deepStrictEqual(
        p1.evidence.map((ev) => ev.id),
        p2.evidence.map((ev) => ev.id),
      );
    },
  );

  await t.test(
    "12. Invalid/missing edge endpoints are rejected safely",
    () => {
      const normalized = createEmptyNormalizedResult({
        moduleEdges: [
          {
            canonicalId: "edge:src/index.ts->src/missing.ts#import:100",
            sourceFile: "src/index.ts",
            targetFile: undefined,
            edgeKind: "import",
            importKind: "named_import",
            specifier: "./missing",
            names: [],
            location: dummyLocation,
            resolutionStatus: "unresolved",
            resolvedSymbolIds: ["sym:src/missing.ts#function:deletedFunc:999"],
          },
        ],
      });

      const projection = buildGraphProjection({
        organizationId: orgId,
        analysisRunId: runId,
        normalizedResult: normalized,
      });

      const danglingEdge = projection.edges.find(
        (e) =>
          e.canonicalId ===
          "edge:sym:edge:src/index.ts->src/missing.ts#import:100->sym:src/missing.ts#function:deletedFunc:999",
      );
      assert.equal(
        danglingEdge,
        undefined,
        "Dangling edge to non-existent node should be rejected",
      );
      assert.ok(
        projection.statistics.rejectedEdgesCount >= 1,
        "Rejected edge count incremented",
      );
    },
  );

  await t.test(
    "13. Unresolved relationships are not fabricated into false nodes",
    () => {
      const normalized = createEmptyNormalizedResult({
        unresolved: [
          {
            canonicalId: "unresolved:src/index.ts:module:unknown-lib:10",
            sourceFile: "src/index.ts",
            category: "module",
            targetSpecifierOrName: "unknown-lib",
            reason: "Could not resolve module specifier",
          },
        ],
      });

      const projection = buildGraphProjection({
        organizationId: orgId,
        analysisRunId: runId,
        normalizedResult: normalized,
      });

      const fakeNode = projection.nodes.find((n) =>
        n.canonicalId.includes("unresolved"),
      );
      assert.equal(
        fakeNode,
        undefined,
        "No fake node should be fabricated for unresolved reference",
      );
    },
  );
});

// Database Integration Tests (Atomic Transactions, Idempotency, RLS)
test(
  "Step 28: Graph Builder — Database Persistence & RLS Integration",
  { skip: !hasDatabase },
  async (t) => {
    const pool = getPool();
    await runMigrations(pool);

    async function ensureRlsTestRole(): Promise<void> {
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
      await pool.query(`GRANT SELECT ON TABLE organizations TO fluxora_rls_test`);
      await pool.query(`
        GRANT SELECT, INSERT, UPDATE, DELETE
        ON TABLE repositories, repository_snapshots, commits, analysis_runs, graph_nodes, graph_edges, evidence
        TO fluxora_rls_test
      `);
    }

    await ensureRlsTestRole();

    const orgA = await createOrganization(pool, { name: "Org A (Builder Test)" });
    const repoA = await createRepository(pool, {
      organizationId: orgA.id,
      githubRepoId: "9001",
      name: "repo-a",
      defaultBranch: "main",
    });
    const snapA = await createRepositorySnapshot(pool, {
      organizationId: orgA.id,
      repositoryId: repoA.id,
      commitSha: "a".repeat(40),
      ref: "main",
      storageUri: "s3://bucket/a.tar.gz",
      sha256: "0".repeat(64),
      fileCount: 1,
      sizeBytes: "100",
    });
    const runA = await createAnalysisRun(pool, {
      organizationId: orgA.id,
      snapshotId: snapA.id,
    });

    const orgB = await createOrganization(pool, { name: "Org B (Builder Test)" });
    const repoB = await createRepository(pool, {
      organizationId: orgB.id,
      githubRepoId: "9002",
      name: "repo-b",
      defaultBranch: "main",
    });
    const snapB = await createRepositorySnapshot(pool, {
      organizationId: orgB.id,
      repositoryId: repoB.id,
      commitSha: "b".repeat(40),
      ref: "main",
      storageUri: "s3://bucket/b.tar.gz",
      sha256: "1".repeat(64),
      fileCount: 1,
      sizeBytes: "100",
    });
    await createAnalysisRun(pool, {
      organizationId: orgB.id,
      snapshotId: snapB.id,
    });

    await t.test(
      "11. Running the same graph build twice is idempotent",
      async () => {
        const normalized = createEmptyNormalizedResult({
          symbols: [
            {
              canonicalId: "sym:src/index.ts#function:main:10",
              name: "main",
              kind: "function",
              relativePath: "src/index.ts",
              location: dummyLocation,
              exported: { isExported: true, isDefaultExport: false, exportName: "main" },
              aliases: [],
              provenance: [],
            },
          ],
        });

        const res1 = await buildAndPersistGraph(pool, {
          organizationId: orgA.id,
          analysisRunId: runA.id,
          normalizedResult: normalized,
        });

        assert.ok(res1.nodes.length >= 1);

        // Second identical run
        const res2 = await buildAndPersistGraph(pool, {
          organizationId: orgA.id,
          analysisRunId: runA.id,
          normalizedResult: normalized,
        });

        assert.equal(
          res1.nodes.length,
          res2.nodes.length,
          "Second run should return same count",
        );

        const dbNodes = await listGraphNodes(pool, orgA.id, runA.id);
        assert.equal(
          dbNodes.length,
          res1.nodes.length,
          "No duplicate nodes created in DB",
        );
      },
    );

    await t.test(
      "14. Graph records retain correct organization/scope",
      async () => {
        const dbNodes = await listGraphNodes(pool, orgA.id, runA.id);
        for (const n of dbNodes) {
          assert.equal(n.analysisRunId, runA.id);
        }

        const dbEdges = await listGraphEdges(pool, orgA.id, runA.id);
        for (const e of dbEdges) {
          assert.equal(e.analysisRunId, runA.id);
        }
      },
    );

    await t.test(
      "15. Cross-tenant/cross-scope writes are rejected according to existing RLS behavior",
      async () => {
        const normalized = createEmptyNormalizedResult({
          symbols: [
            {
              canonicalId: "sym:src/unauthorized.ts#function:hack:10",
              name: "hack",
              kind: "function",
              relativePath: "src/unauthorized.ts",
              location: dummyLocation,
              exported: { isExported: true, isDefaultExport: false, exportName: "hack" },
              aliases: [],
              provenance: [],
            },
          ],
        });

        // Attempting to persist for runA using orgB credentials
        await assert.rejects(
          async () => {
            await processWithRls(async () => {
              await buildAndPersistGraph(pool, {
                organizationId: orgB.id, // Org B trying to write into runA
                analysisRunId: runA.id,
                normalizedResult: normalized,
              });
            });
          },
          /row-level security policy|violates row-level security policy/i,
        );
      },
    );

    await t.test(
      "16. Transaction failure does not leave an invalid partial graph when existing architecture expects atomicity",
      async () => {
        const runFail = await createAnalysisRun(pool, {
          organizationId: orgA.id,
          snapshotId: snapA.id,
        });

        await assert.rejects(async () => {
          await buildAndPersistGraph(pool, {
            organizationId: orgA.id,
            analysisRunId: runFail.id,
            normalizedResult: createEmptyNormalizedResult({
              symbols: [
                {
                  canonicalId: "sym:src/valid.ts#function:ok:10",
                  name: "ok",
                  kind: "function",
                  relativePath: "src/valid.ts",
                  location: dummyLocation,
                  exported: { isExported: true, isDefaultExport: false, exportName: "ok" },
                  aliases: [],
                  provenance: [],
                },
                {
                  canonicalId: "sym:src/corrupt.ts#function:bad:20",
                  name: "   ", // invalid empty name (triggers constraint check)
                  kind: "function",
                  relativePath: "src/corrupt.ts",
                  location: dummyLocation,
                  exported: { isExported: true, isDefaultExport: false, exportName: "bad" },
                  aliases: [],
                  provenance: [],
                },
              ],
            }),
          });
        });

        // Assert nothing was written to runFail
        const nodesInFailRun = await listGraphNodes(
          pool,
          orgA.id,
          runFail.id,
        );
        assert.equal(
          nodesInFailRun.length,
          0,
          "Transaction rollback must leave 0 partial nodes",
        );
      },
    );

    t.after(async () => {
      await closePool();
    });
  },
);

async function processWithRls<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const originalRole = process.env.FLUXORA_DATABASE_ROLE;
  try {
    process.env.FLUXORA_DATABASE_ROLE = RLS_TEST_ROLE;
    return await fn();
  } finally {
    if (originalRole !== undefined) {
      process.env.FLUXORA_DATABASE_ROLE = originalRole;
    } else {
      delete process.env.FLUXORA_DATABASE_ROLE;
    }
  }
}

