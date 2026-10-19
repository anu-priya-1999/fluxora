import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it, beforeAll, afterAll } from "vitest";

import {
  closePool,
  createAnalysisRun,
  createOrganization,
  createRepository,
  createRepositorySnapshot,
  getImpactAnalysisById,
  getLatestImpactAnalysisForPullRequest,
  getPool,
  listEvidenceForAnalysisRun,
  listGraphNodes,
  listImpactFindingEvidence,
  loadRootEnvFile,
  persistPullRequestImpactAnalysis,
  PullRequestNotFoundError,
  runMigrations,
  savePullRequestWithFiles,
} from "@fluxora/db";

import {
  PULL_REQUEST_IMPACT_ANALYSIS_JOB_TYPE,
  type Job,
  type PersistImpactAnalysisResult,
} from "@fluxora/shared-types";

import {
  GOLDEN_FIXTURE_ID,
  GOLDEN_FIXTURE_PINNED_SHA,
  GOLDEN_PR_FIXTURE_ID,
  loadGoldenFixtureFileMap,
  loadGoldenFixtureManifest,
  loadGoldenPullRequestManifest,
} from "../fixtures/golden.ts";
import { runPhase3Pipeline } from "./phase3.ts";
import { buildAndPersistGraph } from "../builder/graph-builder.ts";
import {
  createProductionPullRequestImpactDependencies,
  processPullRequestImpactJob,
} from "../pull-request/impact-handler.ts";

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
  await pool.query(`
    DO $$
    BEGIN
      GRANT USAGE ON TYPE repository_connection_status TO fluxora_rls_test;
    EXCEPTION
      WHEN undefined_object THEN NULL;
    END
    $$;
  `);
  await pool.query(`GRANT EXECUTE ON FUNCTION fluxora_current_org_id() TO fluxora_rls_test`);
  await pool.query(`GRANT EXECUTE ON FUNCTION fluxora_repository_in_current_tenant(uuid) TO fluxora_rls_test`);
  await pool.query(`GRANT EXECUTE ON FUNCTION fluxora_snapshot_in_current_tenant(uuid) TO fluxora_rls_test`);
  await pool.query(`GRANT EXECUTE ON FUNCTION fluxora_analysis_run_in_current_tenant(uuid) TO fluxora_rls_test`);
  await pool.query(`GRANT EXECUTE ON FUNCTION fluxora_pull_request_in_current_tenant(uuid) TO fluxora_rls_test`);
  await pool.query(`GRANT EXECUTE ON FUNCTION fluxora_impact_analysis_in_current_tenant(uuid) TO fluxora_rls_test`);
  await pool.query(`GRANT SELECT ON TABLE organizations TO fluxora_rls_test`);
  await pool.query(`
    GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE repositories, repository_snapshots, commits, analysis_runs, graph_nodes, graph_edges, evidence, pull_requests, pull_request_files, impact_analyses
    TO fluxora_rls_test
  `);

  process.env.FLUXORA_DATABASE_ROLE = RLS_TEST_ROLE;
}

describe.skipIf(!hasDatabase)(
  "Step 47: Golden Fixture PR Impact Validation — End-to-End Deterministic Verification",
  { timeout: 180_000 },
  () => {
    let pool: ReturnType<typeof getPool>;
    let orgA: Awaited<ReturnType<typeof createOrganization>>;
    let repoA: Awaited<ReturnType<typeof createRepository>>;
    let snapshotA: Awaited<ReturnType<typeof createRepositorySnapshot>>;
    let runA1: Awaited<ReturnType<typeof createAnalysisRun>>;
    let runA2: Awaited<ReturnType<typeof createAnalysisRun>>;
    let orgB: Awaited<ReturnType<typeof createOrganization>>;
    let repoB: Awaited<ReturnType<typeof createRepository>>;
    let snapshotB: Awaited<ReturnType<typeof createRepositorySnapshot>>;
    let runB: Awaited<ReturnType<typeof createAnalysisRun>>;

    let prA: Awaited<ReturnType<typeof savePullRequestWithFiles>>["pullRequest"];
    let manifest: ReturnType<typeof loadGoldenPullRequestManifest>;
    let persistedImpact: PersistImpactAnalysisResult;
    let secondImpact: PersistImpactAnalysisResult;

    beforeAll(async () => {
      pool = getPool();
      await runMigrations(pool);
      await ensureRlsTestRole(pool);

      // 1. Load and verify golden fixture manifests
      const goldenManifest = loadGoldenFixtureManifest();
      assert.equal(goldenManifest.fixtureId, GOLDEN_FIXTURE_ID);
      assert.equal(goldenManifest.pinnedCommitSha, GOLDEN_FIXTURE_PINNED_SHA);

      manifest = loadGoldenPullRequestManifest();
      assert.equal(manifest.fixtureId, GOLDEN_PR_FIXTURE_ID);
      assert.equal(manifest.analysisRunCommitSha, GOLDEN_FIXTURE_PINNED_SHA);

      // 2. Load golden files and execute Phase 3 extraction pipeline
      const fileMap = loadGoldenFixtureFileMap();
      assert.ok(fileMap.size > 100, "Golden fixture must have >100 files");

      const pipelineResult = await runPhase3Pipeline({ files: fileMap });
      const normalized = pipelineResult.normalized;
      assert.ok(normalized.symbols.length > 0);
      assert.ok(normalized.moduleEdges.length > 0);
      assert.ok(normalized.routes.length > 0);

      // 3. Setup multi-tenant DB fixture isolation
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
      const baseId = Math.floor(Math.random() * 800_000_000) + 100_000_000;

      orgA = await createOrganization(pool, {
        name: `Step 47 Org A - Primary (${suffix})`,
      });
      repoA = await createRepository(pool, {
        organizationId: orgA.id,
        githubRepoId: String(baseId),
        name: manifest.prFixture.repositoryName,
        defaultBranch: "main",
      });
      snapshotA = await createRepositorySnapshot(pool, {
        organizationId: orgA.id,
        repositoryId: repoA.id,
        commitSha: GOLDEN_FIXTURE_PINNED_SHA,
        ref: "main",
        storageUri: "s3://fluxora-fixtures/taxonomy.tar.gz",
        sha256: "0".repeat(64),
        fileCount: fileMap.size,
        sizeBytes: "1500000",
      });
      runA1 = await createAnalysisRun(pool, {
        organizationId: orgA.id,
        snapshotId: snapshotA.id,
        status: "completed",
      });

      // Secondary run under Org A for analysis run isolation verification
      runA2 = await createAnalysisRun(pool, {
        organizationId: orgA.id,
        snapshotId: snapshotA.id,
        status: "completed",
      });

      // Secondary organization for cross-tenant RLS negative verification
      orgB = await createOrganization(pool, {
        name: `Step 47 Org B - Adversary (${suffix})`,
      });
      repoB = await createRepository(pool, {
        organizationId: orgB.id,
        githubRepoId: String(baseId + 1),
        name: "isolated-repo",
        defaultBranch: "main",
      });
      snapshotB = await createRepositorySnapshot(pool, {
        organizationId: orgB.id,
        repositoryId: repoB.id,
        commitSha: "b".repeat(40),
        ref: "main",
        storageUri: "s3://fluxora-fixtures/isolated.tar.gz",
        sha256: "1".repeat(64),
        fileCount: 1,
        sizeBytes: "100",
      });
      runB = await createAnalysisRun(pool, {
        organizationId: orgB.id,
        snapshotId: snapshotB.id,
        status: "completed",
      });
      assert.ok(runB.id);

      // 4. Project and persist golden fixture graph into PostgreSQL
      const persistedGraph = await buildAndPersistGraph(pool, {
        organizationId: orgA.id,
        analysisRunId: runA1.id,
        normalizedResult: normalized,
        emitEvent: false,
      });

      assert.equal(persistedGraph.nodes.length, 490, "Golden fixture must project exactly 490 canonical nodes");
      assert.equal(persistedGraph.edges.length, 888, "Golden fixture must project exactly 888 canonical edges");

      // 5. Seed the golden PullRequest and PullRequestFile records
      const savedPr = await savePullRequestWithFiles(pool, {
        pr: {
          organizationId: orgA.id,
          repositoryId: repoA.id,
          githubPrId: String(manifest.pullRequestNumber),
          number: manifest.pullRequestNumber,
          title: manifest.prFixture.title,
          url: `https://github.com/${manifest.prFixture.repositoryFullName}/pull/${manifest.pullRequestNumber}`,
          baseRef: manifest.prFixture.baseRef,
          baseSha: manifest.prFixture.baseSha,
          headRef: manifest.prFixture.headRef,
          headSha: manifest.prFixture.headSha,
        },
        files: manifest.prFixture.changedFiles.map((f) => ({
          path: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          patch: f.patch ?? null,
        })),
      });

      prA = savedPr.pullRequest;
      assert.equal(savedPr.files.length, 2, "Golden PR must have exactly 2 changed files");

      // 6. Execute full Step 44 persistence pipeline against golden PR
      persistedImpact = await persistPullRequestImpactAnalysis(pool, {
        organizationId: orgA.id,
        pullRequestId: prA.id,
        analysisRunId: runA1.id,
        maxDepth: manifest.maxDepth,
        direction: manifest.traversalDirection,
        decayFactor: manifest.decayFactor,
      });
    }, 180_000);

    afterAll(async () => {
      await closePool();
    });

    // =========================================================================
    // Layer A: Fixture Contract & Ground Truth Setup
    // =========================================================================
    it("A1. PR manifest loads correctly and validates against golden repository metadata", () => {
      assert.equal(manifest.fixtureId, GOLDEN_PR_FIXTURE_ID);
      assert.equal(manifest.pullRequestNumber, 42);
      assert.equal(manifest.analysisRunCommitSha, GOLDEN_FIXTURE_PINNED_SHA);
      assert.equal(manifest.traversalDirection, "both");
      assert.equal(manifest.maxDepth, 2);
      assert.equal(manifest.decayFactor, 0.9);
      assert.equal(manifest.prFixture.repositoryFullName, "shadcn-ui/taxonomy");
      assert.equal(manifest.prFixture.baseSha, GOLDEN_FIXTURE_PINNED_SHA);
    });

    it("A2. Changed files and patch hunks match golden expectation exactly", () => {
      const changedFilePaths = manifest.prFixture.changedFiles.map((f) => f.path);
      assert.deepEqual([...changedFilePaths].sort(), [...manifest.expectedChangedFiles].sort());

      const subFile = manifest.prFixture.changedFiles.find((f) => f.path === "lib/subscription.ts");
      assert.ok(subFile);
      assert.equal(subFile.status, "modified");
      assert.ok(subFile.patch?.includes("getUserSubscriptionPlan"));

      const docFile = manifest.prFixture.changedFiles.find((f) => f.path === "content/docs/billing.mdx");
      assert.ok(docFile);
      assert.equal(docFile.status, "added");
    });

    it("A3. Expected seed canonical IDs exist in PostgreSQL golden graph for Run A1", async () => {
      const dbNodes = await listGraphNodes(pool, orgA.id, runA1.id);
      const dbCanonicalMap = new Map(dbNodes.map((n) => [n.canonicalId, n]));

      for (const seedId of manifest.expectedSeedCanonicalIds) {
        assert.ok(
          dbCanonicalMap.has(seedId),
          `Expected seed node ${seedId} must exist in golden graph`,
        );
        const seedNode = dbCanonicalMap.get(seedId)!;
        assert.equal(seedNode.nodeType, "symbol");
        assert.equal(seedNode.path, "lib/subscription.ts");
      }
    });

    it("A4. Unresolved files do not become phantom nodes in PostgreSQL graph", async () => {
      const dbNodes = await listGraphNodes(pool, orgA.id, runA1.id);
      for (const unresolvedPath of manifest.expectedUnresolvedFiles) {
        const matchingNodes = dbNodes.filter((n) => n.path === unresolvedPath);
        assert.equal(
          matchingNodes.length,
          0,
          `Unresolved documentation file ${unresolvedPath} must not exist as graph node`,
        );
      }
    });

    // =========================================================================
    // Layer B: Impact Analysis Integration & Hand-Verified Exact Assertions
    // =========================================================================
    it("B1. Execution status, depth metrics, and snapshot relationship are exact", () => {
      const { impactAnalysis } = persistedImpact;
      assert.equal(impactAnalysis.status, "completed");
      assert.equal(impactAnalysis.pullRequestId, prA.id);
      assert.equal(impactAnalysis.analysisRunId, runA1.id);
      assert.equal(impactAnalysis.truncated, manifest.expectedTruncated);
      assert.equal(impactAnalysis.maxDepthReached, manifest.expectedMaxDepthReached);
      assert.ok(
        impactAnalysis.truncationReason &&
          impactAnalysis.truncationReason.includes("depth limit of 2 hops"),
      );
    });

    it("B2. DIRECT IMPACT (Depth 1): Exact set match of hand-verified canonical IDs", () => {
      const { impactAnalysis } = persistedImpact;
      const actualDirectIds = impactAnalysis.directImpact
        .map((f) => f.node.canonicalId)
        .sort();
      const expectedDirectIds = [...manifest.expectedDirectImpactCanonicalIds].sort();

      assert.equal(
        actualDirectIds.length,
        expectedDirectIds.length,
        `Direct impact count must be exactly ${expectedDirectIds.length}`,
      );
      assert.deepEqual(actualDirectIds, expectedDirectIds);

      // Verify all direct impacts have depth 1 and confidence 0.9 (1.0 * 0.9^1)
      for (const finding of impactAnalysis.directImpact) {
        assert.equal(finding.depth, 1, `Direct finding ${finding.node.canonicalId} must have depth 1`);
        assert.ok(
          Math.abs(finding.confidence - 0.9) < 1e-6,
          `Direct finding ${finding.node.canonicalId} must have confidence 0.9`,
        );
        assert.equal(finding.node.nodeType, "module");
      }
    });

    it("B3. ONE-HOP DOWNSTREAM IMPACT (Depth 2): Exact set match of hand-verified canonical IDs", () => {
      const { impactAnalysis } = persistedImpact;
      const actualDownstreamIds = impactAnalysis.downstreamImpact
        .map((f) => f.node.canonicalId)
        .sort();
      const expectedDownstreamIds = [...manifest.expectedOneHopDownstreamCanonicalIds].sort();

      assert.equal(
        actualDownstreamIds.length,
        expectedDownstreamIds.length,
        `One-hop downstream count must be exactly ${expectedDownstreamIds.length}`,
      );
      assert.deepEqual(actualDownstreamIds, expectedDownstreamIds);

      // Verify all downstream impacts have depth 2 and confidence 0.81 (1.0 * 0.9^2)
      for (const finding of impactAnalysis.downstreamImpact) {
        assert.equal(finding.depth, 2, `Downstream finding ${finding.node.canonicalId} must have depth 2`);
        assert.ok(
          Math.abs(finding.confidence - 0.81) < 1e-6,
          `Downstream finding ${finding.node.canonicalId} must have confidence 0.81`,
        );
      }
    });

    it("B4. Affected APIs and Unresolved Files match manifest expectations exactly", () => {
      const { impactAnalysis } = persistedImpact;

      const actualAffectedApis = impactAnalysis.affectedApis
        .map((f) => f.node.name)
        .sort();
      const expectedAffectedApis = [...manifest.expectedAffectedApiNames].sort();
      assert.deepEqual(actualAffectedApis, expectedAffectedApis);

      const actualUnresolvedFiles = impactAnalysis.unresolvedFiles
        .map((u) => u.path)
        .sort();
      const expectedUnresolvedFiles = [...manifest.expectedUnresolvedFiles].sort();
      assert.deepEqual(actualUnresolvedFiles, expectedUnresolvedFiles);

      for (const u of impactAnalysis.unresolvedFiles) {
        assert.ok(u.path && u.path.length > 0);
        assert.ok(u.reason && u.reason.length > 0);
      }

      assert.deepEqual(
        impactAnalysis.affectedEvents.map((f) => f.node.name),
        manifest.expectedAffectedEventNames,
      );
    });

    it("B5. NEGATIVE CONTROLS: Unaffected nodes and irrelevant components are strictly absent", () => {
      const { impactAnalysis } = persistedImpact;
      const allImpactCanonicalIds = new Set([
        ...impactAnalysis.directImpact.map((f) => f.node.canonicalId),
        ...impactAnalysis.downstreamImpact.map((f) => f.node.canonicalId),
      ]);

      for (const unaffectedId of manifest.expectedUnaffectedCanonicalIds) {
        assert.ok(
          !allImpactCanonicalIds.has(unaffectedId),
          `Unaffected node ${unaffectedId} must NEVER appear in direct or downstream impact`,
        );
      }
    });

    // =========================================================================
    // Layer C: Evidence Provenance & Audit Trail Assertions
    // =========================================================================
    it("C1. Every impact finding is linked to a persisted evidence record with valid provenance", async () => {
      const { impactAnalysis, evidenceRecords } = persistedImpact;

      const totalExpectedFindings =
        manifest.expectedDirectImpactCanonicalIds.length +
        manifest.expectedOneHopDownstreamCanonicalIds.length;

      assert.equal(evidenceRecords.length, totalExpectedFindings);

      const dbEvidenceList = await listImpactFindingEvidence(pool, orgA.id, impactAnalysis.id);
      assert.equal(dbEvidenceList.length, totalExpectedFindings);

      for (const ev of dbEvidenceList) {
        assert.equal(ev.subjectType, "impact_finding");
        assert.equal(ev.analysisRunId, runA1.id);
        assert.ok(ev.filePath && ev.filePath.length > 0, "filePath must be populated");
        assert.ok(
          ev.filePath.endsWith(".ts") ||
            ev.filePath.endsWith(".tsx") ||
            ev.filePath.endsWith(".d.ts"),
          `filePath ${ev.filePath} must point to a real source file in taxonomy fixture`,
        );

        // Verify metadata linkages
        assert.equal(ev.metadata?.impactAnalysisId, impactAnalysis.id);
        assert.equal(ev.metadata?.pullRequestId, prA.id);
        assert.ok(
          ev.metadata?.depth === 1 || ev.metadata?.depth === 2,
          `depth metadata must be 1 or 2, got ${ev.metadata?.depth}`,
        );

        // Verify confidence alignment
        if (ev.metadata?.depth === 1) {
          assert.ok(Math.abs(ev.confidence - 0.9) < 1e-6);
        } else {
          assert.ok(Math.abs(ev.confidence - 0.81) < 1e-6);
        }
      }
    });

    it("C2. Evidence IDs on ImpactFinding objects correspond to persisted evidence rows", async () => {
      const { impactAnalysis } = persistedImpact;
      const dbFindingEvidenceList = await listImpactFindingEvidence(pool, orgA.id, impactAnalysis.id);
      const dbFindingEvidenceIdSet = new Set(dbFindingEvidenceList.map((e) => e.id));

      const allDbEvidence = await listEvidenceForAnalysisRun(pool, orgA.id, runA1.id);
      const allDbEvidenceIdSet = new Set(allDbEvidence.map((e) => e.id));

      const allFindings = [
        ...impactAnalysis.directImpact,
        ...impactAnalysis.downstreamImpact,
      ];

      for (const finding of allFindings) {
        assert.ok(finding.evidenceIds && finding.evidenceIds.length > 0);
        const hasFindingEvidence = finding.evidenceIds.some((evId) => dbFindingEvidenceIdSet.has(evId));
        assert.ok(
          hasFindingEvidence,
          `Finding ${finding.node.canonicalId} must link to a persisted impact_finding evidence record`,
        );
        for (const evId of finding.evidenceIds) {
          assert.ok(
            allDbEvidenceIdSet.has(evId),
            `Evidence ID ${evId} on finding ${finding.node.canonicalId} must exist in database`,
          );
        }
      }
    });

    // =========================================================================
    // Layer D: Determinism & Idempotency Assertions
    // =========================================================================
    it("D1. Re-running the pipeline produces identical logical findings and canonical sets", async () => {
      secondImpact = await persistPullRequestImpactAnalysis(pool, {
        organizationId: orgA.id,
        pullRequestId: prA.id,
        analysisRunId: runA1.id,
        maxDepth: manifest.maxDepth,
        direction: manifest.traversalDirection,
        decayFactor: manifest.decayFactor,
      });

      const actualDirect1 = persistedImpact.impactAnalysis.directImpact.map((f) => f.node.canonicalId).sort();
      const actualDirect2 = secondImpact.impactAnalysis.directImpact.map((f) => f.node.canonicalId).sort();
      assert.deepEqual(actualDirect2, actualDirect1);

      const actualDownstream1 = persistedImpact.impactAnalysis.downstreamImpact.map((f) => f.node.canonicalId).sort();
      const actualDownstream2 = secondImpact.impactAnalysis.downstreamImpact.map((f) => f.node.canonicalId).sort();
      assert.deepEqual(actualDownstream2, actualDownstream1);

      assert.deepEqual(secondImpact.impactAnalysis.affectedApis, persistedImpact.impactAnalysis.affectedApis);
      assert.deepEqual(secondImpact.impactAnalysis.unresolvedFiles, persistedImpact.impactAnalysis.unresolvedFiles);
    });

    it("D2. Re-running with a stable ID is idempotent and creates 0 duplicate evidence records", async () => {
      const existingId = secondImpact.impactAnalysis.id;
      const initialEvidenceCount = (await listImpactFindingEvidence(pool, orgA.id, existingId)).length;
      assert.equal(initialEvidenceCount, 49);

      // Count total evidence rows for runA1 before re-run
      const allEvidenceBefore = await listEvidenceForAnalysisRun(pool, orgA.id, runA1.id);

      // Re-run with the same ID
      const reRun = await persistPullRequestImpactAnalysis(pool, {
        id: existingId,
        organizationId: orgA.id,
        pullRequestId: prA.id,
        analysisRunId: runA1.id,
        maxDepth: manifest.maxDepth,
        direction: manifest.traversalDirection,
        decayFactor: manifest.decayFactor,
      });

      assert.equal(reRun.impactAnalysis.id, existingId);
      const evidenceCountAfter = (await listImpactFindingEvidence(pool, orgA.id, existingId)).length;
      assert.equal(
        evidenceCountAfter,
        49,
        "Re-running analysis with same ID must not create duplicate finding evidence records",
      );

      // Total evidence rows for runA1 must remain completely unchanged
      const allEvidenceAfter = await listEvidenceForAnalysisRun(pool, orgA.id, runA1.id);
      assert.equal(
        allEvidenceAfter.length,
        allEvidenceBefore.length,
        "Total evidence count must not increase on idempotent re-run",
      );
    });

    // =========================================================================
    // Layer E: Multi-Tenant & Run Isolation Assertions
    // =========================================================================
    it("E1. RLS Tenant Isolation: Org B cannot access Org A's impact analysis or evidence", async () => {
      const { impactAnalysis } = persistedImpact;

      const crossGet = await getImpactAnalysisById(pool, orgB.id, impactAnalysis.id);
      assert.equal(crossGet, null, "Cross-tenant getImpactAnalysisById must return null");

      const crossLatest = await getLatestImpactAnalysisForPullRequest(pool, orgB.id, prA.id);
      assert.equal(crossLatest, null, "Cross-tenant getLatestImpactAnalysisForPullRequest must return null");

      const crossEvidence = await listImpactFindingEvidence(pool, orgB.id, impactAnalysis.id);
      assert.deepEqual(crossEvidence, [], "Cross-tenant listImpactFindingEvidence must return empty array");
    });

    it("E2. RLS Tenant Isolation: Org B cannot trigger analysis against Org A's PR", async () => {
      await assert.rejects(
        () =>
          persistPullRequestImpactAnalysis(pool, {
            organizationId: orgB.id,
            pullRequestId: prA.id,
            analysisRunId: runA1.id,
          }),
        PullRequestNotFoundError,
      );
    });

    it("E3. Analysis Run Isolation: Empty or alternate run produces independent results", async () => {
      // Run A2 has no graph nodes projected
      const resultA2 = await persistPullRequestImpactAnalysis(pool, {
        organizationId: orgA.id,
        pullRequestId: prA.id,
        analysisRunId: runA2.id,
        maxDepth: manifest.maxDepth,
        direction: manifest.traversalDirection,
      });

      assert.equal(resultA2.impactAnalysis.analysisRunId, runA2.id);
      assert.equal(resultA2.impactAnalysis.directImpact.length, 0);
      assert.equal(resultA2.impactAnalysis.downstreamImpact.length, 0);
      assert.equal(resultA2.evidenceRecords.length, 0);

      // Verify Run A1's original analysis remains unaffected
      const fetchedA1 = await getImpactAnalysisById(pool, orgA.id, persistedImpact.impactAnalysis.id);
      assert.ok(fetchedA1);
      assert.equal(fetchedA1.analysisRunId, runA1.id);
      assert.equal(fetchedA1.directImpact.length, 4);
      assert.equal(fetchedA1.downstreamImpact.length, 45);
    });

    // =========================================================================
    // Layer F: Worker Job Handler Integration & Readback Contract
    // =========================================================================
    it("F1. Worker job handler processes golden PR payload successfully", async () => {
      const fixedJobAnalysisId = crypto.randomUUID();
      const deps = createProductionPullRequestImpactDependencies();

      const job: Job = {
        id: crypto.randomUUID(),
        organizationId: orgA.id,
        type: PULL_REQUEST_IMPACT_ANALYSIS_JOB_TYPE,
        status: "running",
        idempotencyKey: `golden-pr-job-${Date.now()}`,
        attemptCount: 1,
        maxAttempts: 3,
        availableAt: new Date(),
        lockedAt: new Date(),
        lockedBy: "worker-test",
        leaseExpiresAt: new Date(Date.now() + 60000),
        lastError: null,
        startedAt: new Date(),
        completedAt: null,
        failedAt: null,
        payload: {
          organizationId: orgA.id,
          pullRequestId: prA.id,
          analysisRunId: runA1.id,
          impactAnalysisId: fixedJobAnalysisId,
          maxDepth: manifest.maxDepth,
          direction: manifest.traversalDirection,
          decayFactor: manifest.decayFactor,
        },
        createdAt: new Date(),
      };

      const jobResult = await processPullRequestImpactJob(job, deps);
      assert.ok(jobResult);
      assert.equal(jobResult.impactAnalysis.id, fixedJobAnalysisId);
      assert.equal(jobResult.impactAnalysis.directImpact.length, 4);
      assert.equal(jobResult.impactAnalysis.downstreamImpact.length, 45);
      assert.equal(jobResult.evidenceRecords.length, 49);
    });

    it("F2. Step 45 Repository Readback APIs return fully hydrated golden impact results", async () => {
      const latest = await getLatestImpactAnalysisForPullRequest(pool, orgA.id, prA.id);
      assert.ok(latest);
      assert.equal(latest.pullRequestId, prA.id);
      assert.equal(latest.analysisRunId, runA1.id);
      assert.equal(latest.status, "completed");

      const byId = await getImpactAnalysisById(pool, orgA.id, latest.id);
      assert.ok(byId);
      assert.equal(byId.id, latest.id);
      assert.equal(byId.directImpact.length, 4);
      assert.equal(byId.downstreamImpact.length, 45);
      assert.deepEqual(
        byId.affectedApis.map((f) => f.node.name).sort(),
        ["GET /api/posts", "GET /api/users/stripe", "POST /api/posts"],
      );
      assert.deepEqual(
        byId.unresolvedFiles.map((u) => u.path).sort(),
        ["content/docs/billing.mdx"],
      );
    });
  },
);

