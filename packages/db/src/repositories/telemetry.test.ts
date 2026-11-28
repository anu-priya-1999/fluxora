import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import type pg from "pg";
import type { GraphNode } from "@fluxora/shared-types";

import { loadRootEnvFile } from "../cli/env.ts";
import { runMigrations } from "../migrate/runner.ts";
import { DATABASE_ROLE_ENV, withTenant } from "../tenant.ts";
import { setupIsolatedTestDatabase } from "../testing/test-database.ts";
import { createOrganization } from "./organization.ts";
import { createRepository } from "./repository.ts";
import { createRepositorySnapshot } from "./repository-snapshot.ts";
import { createAnalysisRun, createGraphNode } from "./graph.ts";
import {
  TelemetrySourceNotFoundError,
  TelemetryValidationError,
  appendObservation,
  createTelemetrySource,
  getTelemetrySourceById,
  listTelemetrySources,
  queryObservations,
  updateTelemetrySource,
} from "./telemetry.ts";

loadRootEnvFile();

const RLS_TEST_ROLE = "fluxora_rls_test";

const hasDatabase =
  (typeof process.env.FLUXORA_SCENARIO_TEST_DATABASE_URL === "string" &&
    process.env.FLUXORA_SCENARIO_TEST_DATABASE_URL.length > 0) ||
  (typeof process.env.FLUXORA_CLUSTER_LOCK_DATABASE_URL === "string" &&
    process.env.FLUXORA_CLUSTER_LOCK_DATABASE_URL.length > 0) ||
  (typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0);

async function ensureRlsTestRoleForTelemetry(pool: pg.Pool): Promise<void> {
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
  await pool.query(`GRANT EXECUTE ON FUNCTION public.fluxora_current_org_id() TO fluxora_rls_test`);
  await pool.query(
    `GRANT EXECUTE ON FUNCTION public.fluxora_repository_in_current_tenant(uuid) TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION public.fluxora_set_observation_repository_id() TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION public.fluxora_prevent_observation_lineage_mutation() TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT EXECUTE ON FUNCTION public.fluxora_prevent_telemetry_source_repository_mutation() TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.telemetry_sources TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.observations TO fluxora_rls_test`,
  );
  await pool.query(
    `GRANT SELECT ON TABLE public.repositories, public.graph_nodes TO fluxora_rls_test`,
  );
}

describe.skipIf(!hasDatabase)("Step 67: Runtime Telemetry Data Foundation", () => {
  let pool: pg.Pool;
  let teardownDb: () => Promise<void>;
  let originalRoleEnv: string | undefined;
  const suffix = Math.random().toString(36).substring(2, 8);

  let orgA: { id: string };
  let orgB: { id: string };
  let repoA1: { id: string };
  let repoA2: { id: string };
  let repoB1: { id: string };
  let nodeA1: GraphNode;
  let nodeA2: GraphNode;
  let nodeB1: GraphNode;

  const validEnvelope = "enc:v1:test-kms-key:opaque-ciphertext-payload";

  beforeAll(async () => {
    originalRoleEnv = process.env[DATABASE_ROLE_ENV];
    const dbSetup = await setupIsolatedTestDatabase({ dbName: "fluxora_test_telemetry" });
    pool = dbSetup.pool;
    teardownDb = dbSetup.teardown;

    await ensureRlsTestRoleForTelemetry(pool);

    orgA = await createOrganization(pool, { name: `telemetry-org-a-${suffix}` });
    orgB = await createOrganization(pool, { name: `telemetry-org-b-${suffix}` });

    repoA1 = await createRepository(pool, {
      organizationId: orgA.id,
      githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 10000}`,
      name: `telemetry-repo-a1-${suffix}`,
      defaultBranch: "main",
    });
    repoA2 = await createRepository(pool, {
      organizationId: orgA.id,
      githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 20000}`,
      name: `telemetry-repo-a2-${suffix}`,
      defaultBranch: "main",
    });
    repoB1 = await createRepository(pool, {
      organizationId: orgB.id,
      githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 30000}`,
      name: `telemetry-repo-b1-${suffix}`,
      defaultBranch: "main",
    });

    const snapA1 = await createRepositorySnapshot(pool, {
      organizationId: orgA.id,
      repositoryId: repoA1.id,
      commitSha: "a".repeat(40),
      ref: "refs/heads/main",
      storageUri: "s3://snapshots/tel-a1",
      sha256: "a".repeat(64),
      fileCount: 5,
      sizeBytes: "1024",
    });
    const runA1 = await createAnalysisRun(pool, {
      organizationId: orgA.id,
      snapshotId: snapA1.id,
      status: "completed",
    });
    nodeA1 = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA1.id,
      canonicalId: "service:payments-a1",
      nodeType: "service",
      name: "payments-a1",
    });

    const snapA2 = await createRepositorySnapshot(pool, {
      organizationId: orgA.id,
      repositoryId: repoA2.id,
      commitSha: "b".repeat(40),
      ref: "refs/heads/main",
      storageUri: "s3://snapshots/tel-a2",
      sha256: "b".repeat(64),
      fileCount: 5,
      sizeBytes: "1024",
    });
    const runA2 = await createAnalysisRun(pool, {
      organizationId: orgA.id,
      snapshotId: snapA2.id,
      status: "completed",
    });
    nodeA2 = await createGraphNode(pool, {
      organizationId: orgA.id,
      analysisRunId: runA2.id,
      canonicalId: "service:billing-a2",
      nodeType: "service",
      name: "billing-a2",
    });

    const snapB1 = await createRepositorySnapshot(pool, {
      organizationId: orgB.id,
      repositoryId: repoB1.id,
      commitSha: "c".repeat(40),
      ref: "refs/heads/main",
      storageUri: "s3://snapshots/tel-b1",
      sha256: "c".repeat(64),
      fileCount: 5,
      sizeBytes: "1024",
    });
    const runB1 = await createAnalysisRun(pool, {
      organizationId: orgB.id,
      snapshotId: snapB1.id,
      status: "completed",
    });
    nodeB1 = await createGraphNode(pool, {
      organizationId: orgB.id,
      analysisRunId: runB1.id,
      canonicalId: "service:orders-b1",
      nodeType: "service",
      name: "orders-b1",
    });
  });

  afterAll(async () => {
    if (originalRoleEnv === undefined) {
      delete process.env[DATABASE_ROLE_ENV];
    } else {
      process.env[DATABASE_ROLE_ENV] = originalRoleEnv;
    }
    await teardownDb();
  });

  describe("Migration verification", () => {
    it("records 0029_runtime_telemetry_storage.sql and is idempotent on re-run", async () => {
      const rerun = await runMigrations(pool);
      assert.deepEqual(rerun.applied, []);
      assert.ok(rerun.skipped >= 29);

      const migrationRow = await pool.query<{ name: string }>(
        `SELECT name FROM schema_migrations WHERE name = '0029_runtime_telemetry_storage.sql'`,
      );
      assert.equal(migrationRow.rows.length, 1);
    });

    it("creates required tables, indexes, constraints, and RLS policies", async () => {
      const tables = await pool.query<{ tablename: string; rowsecurity: boolean }>(
        `SELECT tablename, rowsecurity
         FROM pg_tables
         WHERE schemaname = 'public'
           AND tablename IN ('telemetry_sources', 'observations')
         ORDER BY tablename`,
      );
      assert.equal(tables.rows.length, 2);
      assert.equal(tables.rows[0]?.rowsecurity, true);
      assert.equal(tables.rows[1]?.rowsecurity, true);

      const indexes = await pool.query<{ indexname: string }>(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename IN ('telemetry_sources', 'observations')`,
      );
      const indexNames = new Set(indexes.rows.map((r) => r.indexname));
      assert.ok(indexNames.has("telemetry_sources_repository_id_idx"));
      assert.ok(indexNames.has("telemetry_sources_repository_provider_idx"));
      assert.ok(indexNames.has("telemetry_sources_repository_status_idx"));
      assert.ok(indexNames.has("observations_source_observed_at_idx"));
      assert.ok(indexNames.has("observations_source_metric_observed_at_idx"));
      assert.ok(indexNames.has("observations_node_observed_at_idx"));
      assert.ok(indexNames.has("observations_repository_node_idx"));

      const policies = await pool.query<{ tablename: string; policyname: string }>(
        `SELECT tablename, policyname
         FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename IN ('telemetry_sources', 'observations')`,
      );
      assert.equal(policies.rows.length, 8);
    });
  });

  describe("TelemetrySource persistence & RLS", () => {
    it("creates telemetry sources for all supported providers and defaults status to pending", async () => {
      for (const provider of ["datadog", "otel", "newrelic"] as const) {
        const created = await createTelemetrySource(pool, {
          organizationId: orgA.id,
          repositoryId: repoA1.id,
          provider,
          connectionConfig: validEnvelope,
        });
        assert.equal(created.repositoryId, repoA1.id);
        assert.equal(created.provider, provider);
        assert.equal(created.status, "pending");
        assert.equal(created.connectionConfig, validEnvelope);
      }

      const listed = await listTelemetrySources(pool, orgA.id, { repositoryId: repoA1.id });
      assert.ok(listed.length >= 3);
    });

    it("rejects unsupported providers and invalid statuses at repository and DB boundaries", async () => {
      await assert.rejects(
        () =>
          createTelemetrySource(pool, {
            organizationId: orgA.id,
            repositoryId: repoA1.id,
            // @ts-expect-error testing invalid provider
            provider: "prometheus",
            connectionConfig: validEnvelope,
          }),
        TelemetryValidationError,
      );

      await assert.rejects(
        () =>
          createTelemetrySource(pool, {
            organizationId: orgA.id,
            repositoryId: repoA1.id,
            provider: "otel",
            connectionConfig: validEnvelope,
            // @ts-expect-error testing invalid status
            status: "connected",
          }),
        TelemetryValidationError,
      );

      await assert.rejects(
        () =>
          withTenant(pool, orgA.id, async (client) => {
            await client.query(
              `INSERT INTO public.telemetry_sources (repository_id, provider, connection_config, status)
               VALUES ($1::uuid, 'invalid_provider', $2, 'pending')`,
              [repoA1.id, validEnvelope],
            );
          }),
        /telemetry_sources_provider_check/,
      );
    });

    it("rejects plaintext JSON or raw secret strings in connection_config", async () => {
      await assert.rejects(
        () =>
          createTelemetrySource(pool, {
            organizationId: orgA.id,
            repositoryId: repoA1.id,
            provider: "datadog",
            connectionConfig: '{"apiKey":"plaintext-secret"}',
          }),
        TelemetryValidationError,
      );

      await assert.rejects(
        () =>
          withTenant(pool, orgA.id, async (client) => {
            await client.query(
              `INSERT INTO public.telemetry_sources (repository_id, provider, connection_config)
               VALUES ($1::uuid, 'datadog', 'dd_api_plaintext_key')`,
              [repoA1.id],
            );
          }),
        /telemetry_sources_connection_config_encrypted_envelope/,
      );
    });

    it("enforces valid status transitions and rejects immutable repository_id mutation", async () => {
      const source = await createTelemetrySource(pool, {
        organizationId: orgA.id,
        repositoryId: repoA1.id,
        provider: "otel",
        connectionConfig: validEnvelope,
      });

      const activated = await updateTelemetrySource(pool, orgA.id, source.id, {
        status: "active",
      });
      assert.equal(activated?.status, "active");

      const disabled = await updateTelemetrySource(pool, orgA.id, source.id, {
        status: "disabled",
      });
      assert.equal(disabled?.status, "disabled");

      // disabled -> error is disallowed by state transition table
      await assert.rejects(
        () =>
          updateTelemetrySource(pool, orgA.id, source.id, {
            status: "error",
          }),
        TelemetryValidationError,
      );

      await assert.rejects(
        () =>
          withTenant(pool, orgA.id, async (client) => {
            await client.query(
              `UPDATE public.telemetry_sources SET repository_id = $1::uuid WHERE id = $2::uuid`,
              [repoA2.id, source.id],
            );
          }),
        /telemetry_sources\.repository_id is immutable/,
      );
    });

    it("enforces strict tenant RLS isolation on reads, updates, and deletes under non-superuser role", async () => {
      const sourceA = await createTelemetrySource(pool, {
        organizationId: orgA.id,
        repositoryId: repoA1.id,
        provider: "newrelic",
        connectionConfig: validEnvelope,
      });

      process.env[DATABASE_ROLE_ENV] = RLS_TEST_ROLE;
      try {
        const crossRead = await getTelemetrySourceById(pool, orgB.id, sourceA.id);
        assert.equal(crossRead, null);

        const crossList = await listTelemetrySources(pool, orgB.id);
        assert.equal(crossList.some((s) => s.id === sourceA.id), false);

        const crossUpdate = await updateTelemetrySource(pool, orgB.id, sourceA.id, {
          status: "disabled",
        });
        assert.equal(crossUpdate, null);

        const crossDeleteCount = await withTenant(pool, orgB.id, async (client) => {
          const res = await client.query(
            `DELETE FROM public.telemetry_sources WHERE id = $1::uuid`,
            [sourceA.id],
          );
          return res.rowCount;
        });
        assert.equal(crossDeleteCount, 0);

        // Cross-tenant INSERT for Org A's repository under Org B context fails RLS WITH CHECK
        await assert.rejects(
          () =>
            createTelemetrySource(pool, {
              organizationId: orgB.id,
              repositoryId: repoA1.id,
              provider: "otel",
              connectionConfig: validEnvelope,
            }),
          /row-level security policy/,
        );
      } finally {
        delete process.env[DATABASE_ROLE_ENV];
      }
    });
  });

  describe("Observation persistence, referential integrity & RLS", () => {
    it("inserts mapped and unmapped observations, preserves NUMERIC precision and UTC observed_at, and orders queries", async () => {
      const source = await createTelemetrySource(pool, {
        organizationId: orgA.id,
        repositoryId: repoA1.id,
        provider: "otel",
        connectionConfig: validEnvelope,
      });

      const t1 = new Date("2026-10-01T10:00:00.123Z");
      const t2 = new Date("2026-10-01T10:05:00.456Z");

      const unmapped = await appendObservation(pool, {
        organizationId: orgA.id,
        telemetrySourceId: source.id,
        nodeId: null,
        metricName: "http.server.duration_ms",
        value: "123456.789012345",
        observedAt: t1,
      });
      assert.equal(unmapped.nodeId, null);
      assert.equal(unmapped.repositoryId, repoA1.id);
      assert.equal(unmapped.value, "123456.789012345");
      assert.equal(unmapped.observedAt.toISOString(), t1.toISOString());

      const mapped = await appendObservation(pool, {
        organizationId: orgA.id,
        telemetrySourceId: source.id,
        nodeId: nodeA1.id,
        metricName: "http.server.duration_ms",
        value: "42.0050",
        observedAt: t2,
      });
      assert.equal(mapped.nodeId, nodeA1.id);
      assert.equal(mapped.value, "42.0050");

      const results = await queryObservations(pool, {
        organizationId: orgA.id,
        telemetrySourceId: source.id,
        startTime: new Date("2026-10-01T09:59:00.000Z"),
        endTime: new Date("2026-10-01T10:10:00.000Z"),
      });
      assert.equal(results.length, 2);
      assert.equal(results[0]?.id, mapped.id);
      assert.equal(results[1]?.id, unmapped.id);

      const nodeFiltered = await queryObservations(pool, {
        organizationId: orgA.id,
        telemetrySourceId: source.id,
        nodeId: nodeA1.id,
      });
      assert.equal(nodeFiltered.length, 1);
      assert.equal(nodeFiltered[0]?.id, mapped.id);
    });

    it("rejects invalid metric names", async () => {
      const source = await createTelemetrySource(pool, {
        organizationId: orgA.id,
        repositoryId: repoA1.id,
        provider: "datadog",
        connectionConfig: validEnvelope,
      });

      for (const badMetric of ["", "   ", " leading-space", "x".repeat(256)]) {
        await assert.rejects(
          () =>
            appendObservation(pool, {
              organizationId: orgA.id,
              telemetrySourceId: source.id,
              metricName: badMetric,
              value: 1,
              observedAt: new Date(),
            }),
          TelemetryValidationError,
        );
      }
    });

    it("prevents linking an observation to a GraphNode from another repository or another tenant", async () => {
      const sourceA1 = await createTelemetrySource(pool, {
        organizationId: orgA.id,
        repositoryId: repoA1.id,
        provider: "otel",
        connectionConfig: validEnvelope,
      });

      // Same tenant (Org A), different repository (nodeA2 belongs to repoA2)
      await assert.rejects(
        () =>
          appendObservation(pool, {
            organizationId: orgA.id,
            telemetrySourceId: sourceA1.id,
            nodeId: nodeA2.id,
            metricName: "cpu.usage",
            value: 0.5,
            observedAt: new Date(),
          }),
        /observations_repository_node_fkey/,
      );

      // Different tenant (nodeB1 belongs to orgB/repoB1)
      await assert.rejects(
        () =>
          appendObservation(pool, {
            organizationId: orgA.id,
            telemetrySourceId: sourceA1.id,
            nodeId: nodeB1.id,
            metricName: "cpu.usage",
            value: 0.5,
            observedAt: new Date(),
          }),
        /observations_repository_node_fkey/,
      );
    });

    it("enforces tenant RLS on observations and rejects cross-tenant source references", async () => {
      const sourceA1 = await createTelemetrySource(pool, {
        organizationId: orgA.id,
        repositoryId: repoA1.id,
        provider: "otel",
        connectionConfig: validEnvelope,
      });

      await appendObservation(pool, {
        organizationId: orgA.id,
        telemetrySourceId: sourceA1.id,
        nodeId: nodeA1.id,
        metricName: "error.rate",
        value: "0.0125",
        observedAt: new Date("2026-10-02T00:00:00.000Z"),
      });

      process.env[DATABASE_ROLE_ENV] = RLS_TEST_ROLE;
      try {
        const crossObs = await queryObservations(pool, {
          organizationId: orgB.id,
          telemetrySourceId: sourceA1.id,
        });
        assert.equal(crossObs.length, 0);

        await assert.rejects(
          () =>
            appendObservation(pool, {
              organizationId: orgB.id,
              telemetrySourceId: sourceA1.id,
              metricName: "error.rate",
              value: "0.01",
              observedAt: new Date(),
            }),
          TelemetrySourceNotFoundError,
        );
      } finally {
        delete process.env[DATABASE_ROLE_ENV];
      }
    });

    it("unmaps observation (SET NULL on node_id) when GraphNode is deleted, and cascades on TelemetrySource/Repository delete", async () => {
      const repoTemp = await createRepository(pool, {
        organizationId: orgA.id,
        githubRepoId: `${Math.floor(Math.random() * 1_000_000) + 40000}`,
        name: `telemetry-repo-temp-${suffix}`,
        defaultBranch: "main",
      });
      const snapTemp = await createRepositorySnapshot(pool, {
        organizationId: orgA.id,
        repositoryId: repoTemp.id,
        commitSha: "d".repeat(40),
        ref: "refs/heads/main",
        storageUri: "s3://snapshots/tel-temp",
        sha256: "d".repeat(64),
        fileCount: 1,
        sizeBytes: "512",
      });
      const runTemp = await createAnalysisRun(pool, {
        organizationId: orgA.id,
        snapshotId: snapTemp.id,
        status: "completed",
      });
      const nodeTemp = await createGraphNode(pool, {
        organizationId: orgA.id,
        analysisRunId: runTemp.id,
        canonicalId: "service:temp",
        nodeType: "service",
        name: "temp",
      });

      const sourceTemp = await createTelemetrySource(pool, {
        organizationId: orgA.id,
        repositoryId: repoTemp.id,
        provider: "datadog",
        connectionConfig: validEnvelope,
      });
      const obs = await appendObservation(pool, {
        organizationId: orgA.id,
        telemetrySourceId: sourceTemp.id,
        nodeId: nodeTemp.id,
        metricName: "latency.p95",
        value: "120.5",
        observedAt: new Date("2026-10-03T12:00:00.000Z"),
      });

      // Delete GraphNode -> observation remains with node_id = NULL
      await withTenant(pool, orgA.id, async (client) => {
        await client.query(`DELETE FROM public.graph_nodes WHERE id = $1::uuid`, [nodeTemp.id]);
      });

      const afterNodeDelete = await queryObservations(pool, {
        organizationId: orgA.id,
        telemetrySourceId: sourceTemp.id,
      });
      assert.equal(afterNodeDelete.length, 1);
      assert.equal(afterNodeDelete[0]?.id, obs.id);
      assert.equal(afterNodeDelete[0]?.nodeId, null);

      // Delete Repository -> cascades to telemetry_sources and observations
      await withTenant(pool, orgA.id, async (client) => {
        await client.query(`DELETE FROM public.repositories WHERE id = $1::uuid`, [repoTemp.id]);
      });

      const afterRepoDelete = await getTelemetrySourceById(pool, orgA.id, sourceTemp.id);
      assert.equal(afterRepoDelete, null);
    });
  });
});
